/**
 * CoverTune — Production Backend v3.0
 *
 * Pipeline (mirrors AirMusic M2 architecture — no Suno fingerprint):
 *   1. Upload source audio to Kie.ai file host
 *   2. Stem separate: split into vocalUrl + instrumentalUrl
 *      (uses /api/v1/vocal-removal/generate — no catalog fingerprint check)
 *   3. Generate new instrumental in chosen style
 *      (uses /api/v1/generate/music — pure text-to-music, no fingerprint)
 *   4. ffmpeg merge: new instrumental + original vocals
 *   5. Upload merged result, return to browser
 */

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const { execFileSync } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;
const tasks = new Map();
const SLEEP = ms => new Promise(r => setTimeout(r, ms));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(mp3|wav|flac|m4a|ogg)$/i.test(file.originalname)
             || file.mimetype.startsWith('audio/');
    cb(ok ? null : new Error('Unsupported audio format'), ok);
  }
});

// ── Health ───────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({
  status: 'ok', version: '3.0.0',
  kieKeySet: !!process.env.KIE_API_KEY,
  pipeline: 'stem-separate → style-generate → ffmpeg-merge'
}));

// ── Helpers ──────────────────────────────────────────────────
const KIE_BASE = 'https://api.kie.ai';

async function kiePost(key, endpoint, body) {
  const r = await fetch(`${KIE_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}

// Poll /api/v1/generate/record-info (music tasks)
async function pollMusic(key, taskId, maxMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await SLEEP(5000);
    const r = await fetch(
      `${KIE_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers: { 'Authorization': `Bearer ${key}` } }
    );
    const d = await r.json().catch(() => ({}));
    const status = d?.data?.status;
    if (status === 'SUCCESS' || status === 'FIRST_SUCCESS') return d.data;
    if (['CREATE_TASK_FAILED','GENERATE_AUDIO_FAILED','CALLBACK_EXCEPTION'].includes(status)) {
      throw new Error(d?.data?.errorMessage || `Music task failed: ${status}`);
    }
    if (status === 'SENSITIVE_WORD_ERROR') {
      throw new Error('Style description flagged — please adjust wording and try again.');
    }
  }
  throw new Error('Music generation timed out. Please try again.');
}

// Poll /api/v1/vocal-removal/record-info (stem separation tasks)
async function pollStem(key, taskId, maxMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await SLEEP(5000);
    const r = await fetch(
      `${KIE_BASE}/api/v1/vocal-removal/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers: { 'Authorization': `Bearer ${key}` } }
    );
    const d = await r.json().catch(() => ({}));
    const status = d?.data?.status;
    // Stem separation uses different status field
    if (status === 'complete' || status === 'SUCCESS' || d?.data?.response?.vocalUrl) {
      return d.data;
    }
    if (status === 'fail' || status === 'failed' || status === 'error') {
      throw new Error('Stem separation failed. Please try again.');
    }
  }
  throw new Error('Stem separation timed out. Please try again.');
}

// Upload buffer to Kie.ai file host → return public URL
async function uploadToKie(key, buffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimetype });
  form.append('uploadPath', 'audio/covertune');
  form.append('fileName', filename);
  const r = await fetch('https://kieai.redpandaai.co/api/file-stream-upload', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, ...form.getHeaders() },
    body: form
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(j.msg || `Upload failed HTTP ${r.status}`);
  return j?.data?.downloadUrl || j?.data?.fileUrl || j?.data?.url;
}

// Download URL to a local temp file
async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
  fs.writeFileSync(dest, await r.buffer());
}

// ffmpeg merge: instrumental + vocals → final mix
function merge(instrPath, vocalPath, outPath) {
  try {
    execFileSync('ffmpeg', [
      '-y',
      '-i', instrPath,
      '-i', vocalPath,
      '-filter_complex',
      '[0:a]volume=0.82[instr];[1:a]volume=1.0[vox];[instr][vox]amix=inputs=2:duration=first[out]',
      '-map', '[out]',
      '-ar', '44100', '-ab', '320k', outPath
    ], { timeout: 60000 });
    return true;
  } catch (_) {
    return false;
  }
}

function setTask(token, patch) {
  tasks.set(token, { ...(tasks.get(token) || {}), ...patch });
}

// ── Generate endpoint ─────────────────────────────────────────
app.post('/api/generate', upload.single('audio'), async (req, res) => {
  const key = process.env.KIE_API_KEY;
  if (!key)      return res.status(500).json({ error: 'KIE_API_KEY not configured.' });
  if (!req.file) return res.status(400).json({ error: 'No audio file received.' });

  const {
    genre = 'Pop', mood = 'Energetic', bpm = '120',
    style = '', lyrics = '', instrumental = 'false',
    vocalGender = 'f', title = 'My Cover'
  } = req.body;
  const isInstr = instrumental === 'true';

  const token = crypto.randomBytes(16).toString('hex');
  setTask(token, { status: 'pending', stage: 'Starting…', pct: 0, audioUrl: null, error: null });
  res.json({ token });

  runPipeline(key, token, req.file, { genre, mood, bpm, style, lyrics, isInstr, vocalGender, title })
    .catch(err => {
      setTask(token, { status: 'error', error: err.message });
      console.error('Pipeline error:', err.message);
    });
});

async function runPipeline(key, token, file, opts) {
  const { genre, mood, bpm, style, lyrics, isInstr, vocalGender, title } = opts;
  const tmp = `/tmp/ct_${token}`;
  fs.mkdirSync(tmp, { recursive: true });

  try {

    // ── 1. Upload source audio ──────────────────────────────
    setTask(token, { stage: 'Uploading your audio…', pct: 6 });
    const sourceUrl = await uploadToKie(
      key, file.buffer, file.originalname, file.mimetype
    );

    // ── 2. Stem separation ──────────────────────────────────
    // POST /api/v1/vocal-removal/generate with audioUrl (not taskId+audioId)
    // This endpoint does NOT trigger Suno catalog fingerprinting
    setTask(token, { stage: 'Separating vocals from instrumental…', pct: 16 });

    const stemRes = await kiePost(key, '/api/v1/vocal-removal/generate', {
      audioUrl:    sourceUrl,
      callBackUrl: '',         // no callback — we poll
      type:        'separate_vocal'
    });

    let vocalUrl = null;
    let instrSourceUrl = null;

    if (stemRes?.code === 200 && stemRes?.data?.taskId) {
      setTask(token, { stage: 'Processing stem separation…', pct: 26 });
      const stemData = await pollStem(key, stemRes.data.taskId);
      // Confirmed response fields from docs:
      // data.response.vocalUrl and data.response.instrumentalUrl
      vocalUrl      = stemData?.response?.vocalUrl       || null;
      instrSourceUrl = stemData?.response?.instrumentalUrl || null;

      // Fallback to originData array
      if (!vocalUrl && stemData?.response?.originData) {
        for (const s of stemData.response.originData) {
          if (s.stem_type_group_name === 'Vocals')       vocalUrl      = s.audio_url;
          if (s.stem_type_group_name === 'Instrumental') instrSourceUrl = s.audio_url;
        }
      }
    } else {
      // Stem separation failed or not supported — continue without vocal preservation
      console.warn('Stem separation skipped:', stemRes?.msg);
    }

    // ── 3. Generate new instrumental in chosen style ────────
    setTask(token, { stage: 'Generating new arrangement in your chosen style…', pct: 38 });

    const stylePrompt = [
      `${genre} style instrumental music`,
      style ? style.trim() : '',
      `${mood} mood`,
      bpm ? `${bpm} BPM` : '',
      'no vocals, purely instrumental',
      'rich full arrangement, professional production quality'
    ].filter(Boolean).join(', ').substring(0, 500);

    const genRes = await kiePost(key, '/api/v1/generate/music', {
      model:        'V5',
      customMode:   false,
      instrumental: true,
      prompt:       stylePrompt,
    });

    let newInstrUrl = null;

    if (genRes?.code === 200 && genRes?.data?.taskId) {
      setTask(token, { stage: 'AI composing your cover…', pct: 52 });
      const genData = await pollMusic(key, genRes.data.taskId, 240000);
      const tracks  = genData?.response?.sunoData || [];
      if (tracks.length > 0) {
        newInstrUrl = tracks[0].audioUrl || tracks[0].streamAudioUrl;
      }
    }

    if (!newInstrUrl) {
      throw new Error('Style generation returned no audio. Please try again.');
    }

    // ── 4. Merge new instrumental + original vocals ─────────
    setTask(token, { stage: 'Mixing your cover…', pct: 80 });

    const instrPath = `${tmp}/new_instr.mp3`;
    const vocalPath = `${tmp}/vocal.mp3`;
    const outPath   = `${tmp}/cover.mp3`;

    await download(newInstrUrl, instrPath);

    let finalUrl = newInstrUrl; // default: instrumental only

    if (!isInstr && vocalUrl) {
      await download(vocalUrl, vocalPath);
      const merged = merge(instrPath, vocalPath, outPath);

      if (merged && fs.existsSync(outPath)) {
        setTask(token, { stage: 'Uploading your finished cover…', pct: 92 });
        const buf = fs.readFileSync(outPath);
        finalUrl  = await uploadToKie(key, buf, `cover_${token}.mp3`, 'audio/mpeg');
      }
    }

    // Clean up
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

    setTask(token, { status: 'complete', audioUrl: finalUrl, stage: 'Done!', pct: 100 });

  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
}

// ── Status endpoint ───────────────────────────────────────────
app.get('/api/status/:token', (req, res) => {
  const task = tasks.get(req.params.token);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (task.status === 'complete') {
    tasks.delete(req.params.token);
    return res.json({ status: 'complete', audioUrl: task.audioUrl });
  }
  if (task.status === 'error') {
    tasks.delete(req.params.token);
    return res.json({ status: 'error', error: task.error });
  }

  res.json({ status: 'pending', stage: task.stage || 'Processing…', pct: task.pct || 0 });
});

app.listen(PORT, () => {
  console.log(`CoverTune v3.0 — port ${PORT}`);
  console.log(`Pipeline: stem-separate → style-generate → ffmpeg-merge`);
  console.log(`KIE_API_KEY: ${process.env.KIE_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
});
