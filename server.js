/**
 * CoverTune v4.1 — Production Backend
 *
 * Pipeline (AirMusic M2 architecture — zero Suno fingerprinting):
 *   1. Upload audio → Kie.ai file host
 *   2. Stem separate → vocalUrl + instrumentalUrl
 *      POST /api/v1/vocal-removal/generate
 *   3. Generate new instrumental in chosen style (text prompt only)
 *      POST /api/v1/generate
 *   4. ffmpeg merge: new instrumental + original vocals
 *   5. Upload merged file → return to browser
 *
 * The catalog fingerprint error is architecturally impossible here
 * because we never call the upload-cover endpoint.
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
const APP_URL = process.env.RENDER_EXTERNAL_URL || 'https://covertune.onrender.com';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(mp3|wav|flac|m4a|ogg)$/i.test(file.originalname)
             || file.mimetype.startsWith('audio/');
    cb(ok ? null : new Error('Unsupported audio format'), ok);
  }
});

// ── Health ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({
  status: 'ok', version: '4.1.0',
  kieKeySet: !!process.env.KIE_API_KEY,
  pipeline: 'stem-separate → style-generate → ffmpeg-merge'
}));

// ── Callbacks from Kie.ai ───────────────────────────────────
const callbacks = new Map(); // cbToken → resolve function

app.post('/api/callback/:cbToken', express.json(), (req, res) => {
  const resolve = callbacks.get(req.params.cbToken);
  if (resolve) {
    resolve(req.body);
    callbacks.delete(req.params.cbToken);
  }
  res.sendStatus(200);
});

// Wait for Kie.ai callback OR poll as backup
async function waitForResult(key, taskId, pollPath, cbToken, maxMs = 240000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Task timed out after 4 minutes.')), maxMs);

    // Register callback listener
    callbacks.set(cbToken, (body) => {
      clearTimeout(timer);
      resolve({ source: 'callback', body });
    });

    // Also poll actively every 6s as backup
    let elapsed = 0;
    while (elapsed < maxMs) {
      await SLEEP(6000);
      elapsed += 6000;
      try {
        const r = await fetch(
          `https://api.kie.ai${pollPath}?taskId=${encodeURIComponent(taskId)}`,
          { headers: { 'Authorization': `Bearer ${key}` } }
        );
        const d = await r.json().catch(() => ({}));
        const status = d?.data?.status;

        // TEXT_SUCCESS = text/lyrics done, audio NOT yet ready — keep polling
        // FIRST_SUCCESS or SUCCESS = audio is ready
        const sunoTracks = d?.data?.response?.sunoData || [];
        const hasAudio = sunoTracks.some(t => t.audioUrl || t.streamAudioUrl);
        const stemDone = !!(d?.data?.response?.vocalUrl || d?.data?.response?.instrumentalUrl
                         || (d?.data?.response?.originData?.length > 0));

        if ((status === 'SUCCESS' || status === 'FIRST_SUCCESS') && hasAudio) {
          clearTimeout(timer);
          callbacks.delete(cbToken);
          resolve({ source: 'poll', data: d.data });
          return;
        }
        if (status === 'complete' && stemDone) {
          clearTimeout(timer);
          callbacks.delete(cbToken);
          resolve({ source: 'poll', data: d.data });
          return;
        }
        if (['CREATE_TASK_FAILED','GENERATE_AUDIO_FAILED',
             'CALLBACK_EXCEPTION','fail','failed','error'].includes(status)) {
          clearTimeout(timer);
          callbacks.delete(cbToken);
          reject(new Error(d?.data?.errorMessage || `Task failed: ${status}`));
          return;
        }
        if (status === 'SENSITIVE_WORD_ERROR') {
          clearTimeout(timer);
          callbacks.delete(cbToken);
          reject(new Error('Style flagged — adjust your description and try again.'));
          return;
        }
      } catch (_) { /* keep polling */ }
    }
  });
}

// Upload buffer to Kie.ai file host
async function uploadFile(key, buffer, filename, mimetype) {
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

// Download URL to local file
async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed HTTP ${r.status}`);
  fs.writeFileSync(dest, await r.buffer());
}

// ffmpeg merge: instrumental + vocals
function mergeAudio(instrPath, vocalPath, outPath) {
  try {
    execFileSync('ffmpeg', [
      '-y', '-i', instrPath, '-i', vocalPath,
      '-filter_complex',
      '[0:a]volume=0.82[i];[1:a]volume=1.0[v];[i][v]amix=inputs=2:duration=first[out]',
      '-map', '[out]', '-ar', '44100', '-ab', '320k', outPath
    ], { timeout: 60000 });
    return true;
  } catch (_) { return false; }
}

function setTask(token, patch) {
  tasks.set(token, { ...(tasks.get(token) || {}), ...patch });
}

// ── Generate endpoint ────────────────────────────────────────
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
  setTask(token, { status: 'pending', stage: 'Starting…', pct: 0 });
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
    // ── 1. Upload source audio ────────────────────────────
    setTask(token, { stage: 'Uploading your audio…', pct: 5 });
    const sourceUrl = await uploadFile(key, file.buffer, file.originalname, file.mimetype);

    // ── 2. Stem separation ────────────────────────────────
    // Uses /api/v1/vocal-removal/generate — NO fingerprint check
    setTask(token, { stage: 'Separating vocals from instrumental…', pct: 15 });
    const stemCbToken = crypto.randomBytes(12).toString('hex');
    const stemCbUrl   = `${APP_URL}/api/callback/${stemCbToken}`;

    const stemRes = await fetch('https://api.kie.ai/api/v1/vocal-removal/generate', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioUrl: sourceUrl, callBackUrl: stemCbUrl, type: 'separate_vocal' })
    });
    const stemJson = await stemRes.json().catch(() => ({}));

    let vocalUrl = null;

    if (stemJson?.code === 200 && stemJson?.data?.taskId) {
      setTask(token, { stage: 'Processing stem separation…', pct: 25 });
      try {
        const result = await waitForResult(
          key, stemJson.data.taskId,
          '/api/v1/vocal-removal/record-info',
          stemCbToken, 120000
        );
        const resp = result?.data?.response || result?.body?.data?.response || {};
        vocalUrl = resp.vocalUrl || null;
        // Try originData array if direct fields missing
        if (!vocalUrl && resp.originData) {
          for (const s of resp.originData) {
            if (s.stem_type_group_name === 'Vocals') vocalUrl = s.audio_url;
          }
        }
      } catch (stemErr) {
        console.warn('Stem separation failed (non-fatal):', stemErr.message);
        // Continue without vocal — will deliver instrumental cover
      }
    }

    // ── 3. Generate new instrumental in chosen style ──────
    setTask(token, { stage: 'AI generating new arrangement in your chosen style…', pct: 35 });

    const stylePrompt = [
      `${genre} style instrumental music`,
      style ? style.trim() : '',
      `${mood} mood`,
      bpm ? `${bpm} BPM` : '',
      'purely instrumental, no vocals',
      'rich full arrangement, professional production quality'
    ].filter(Boolean).join(', ').substring(0, 500);

    const genCbToken = crypto.randomBytes(12).toString('hex');
    const genCbUrl   = `${APP_URL}/api/callback/${genCbToken}`;

    const genRes = await fetch('https://api.kie.ai/api/v1/generate', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'V5',
        customMode: false,
        instrumental: true,
        prompt: stylePrompt,
        callBackUrl: genCbUrl
      })
    });
    const genJson = await genRes.json().catch(() => ({}));

    if (!genJson?.data?.taskId) {
      throw new Error(genJson?.msg || 'Music generation failed to start.');
    }

    setTask(token, { stage: 'AI composing your cover…', pct: 50 });
    const genResult = await waitForResult(
      key, genJson.data.taskId,
      '/api/v1/generate/record-info',
      genCbToken, 240000
    );

    const tracks = genResult?.data?.response?.sunoData
                || genResult?.body?.data?.response?.sunoData
                || [];
    // audioUrl is populated at FIRST_SUCCESS/SUCCESS
    // streamAudioUrl is populated earlier but is a streaming URL — use as fallback
    const newInstrUrl = tracks?.[0]?.audioUrl || tracks?.[0]?.streamAudioUrl || null;
    if (!newInstrUrl) throw new Error('Style generation returned no audio. Please try again.');
    console.log('Got instrumental URL:', newInstrUrl.substring(0, 60));

    // ── 4. Merge new instrumental + original vocals ───────
    setTask(token, { stage: 'Mixing stems into final cover…', pct: 78 });

    const instrPath = `${tmp}/instr.mp3`;
    const vocalPath = `${tmp}/vocal.mp3`;
    const outPath   = `${tmp}/cover.mp3`;

    await download(newInstrUrl, instrPath);

    let finalUrl = newInstrUrl;

    if (!isInstr && vocalUrl) {
      await download(vocalUrl, vocalPath);
      const merged = mergeAudio(instrPath, vocalPath, outPath);
      if (merged && fs.existsSync(outPath)) {
        setTask(token, { stage: 'Uploading your finished cover…', pct: 92 });
        const buf = fs.readFileSync(outPath);
        finalUrl  = await uploadFile(key, buf, `cover_${token}.mp3`, 'audio/mpeg');
      }
    }

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

    setTask(token, { status: 'complete', audioUrl: finalUrl, stage: 'Done!', pct: 100 });

  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
}

// ── Status endpoint ──────────────────────────────────────────
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
  console.log(`CoverTune v4.1 — port ${PORT}`);
  console.log(`KIE_API_KEY: ${process.env.KIE_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`App URL: ${APP_URL}`);
});
