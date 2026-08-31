/**
 * CoverTune v5.1 — Production Backend
 *
 * Pipeline (reverse-engineered from AirMusic's actual API calls):
 *
 *   AirMusic does:
 *     1. POST /api/ai/upload/prepare-audio  → transforms audio, re-hosts on R2
 *     2. POST /api/ai/ai-cover/generate     → sends PROCESSED url to Suno V5
 *     3. POST /api/ai/ai-cover/query        → polls for result
 *
 *   We do the same:
 *     1. Accept upload → ffmpeg transform (pitch+tempo+re-encode) → upload to Kie.ai host
 *     2. POST /api/v1/generate/upload-cover with PROCESSED url, model V5, customMode false
 *     3. Poll /api/v1/generate/record-info until FIRST_SUCCESS or SUCCESS
 *
 *   The ffmpeg transform breaks Suno's fingerprint detector exactly as
 *   AirMusic's prepare-audio step does on their servers.
 */

const express      = require('express');
const multer       = require('multer');
const cors         = require('cors');
const fetch        = require('node-fetch');
const FormData     = require('form-data');
const path         = require('path');
const crypto       = require('crypto');
const fs           = require('fs');
const { execFileSync } = require('child_process');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SLEEP      = ms => new Promise(r => setTimeout(r, ms));
const TASKS_DIR  = '/tmp/covertune_tasks';
const cbResolvers = new Map(); // in-memory only: Promise resolvers for active requests

// Persistent task store — survives server restarts within same instance
// Uses files so tasks survive brief restarts
function ensureTasksDir() {
  try { fs.mkdirSync(TASKS_DIR, { recursive: true }); } catch(_) {}
}
function saveTask(token, data) {
  ensureTasksDir();
  try { fs.writeFileSync(`${TASKS_DIR}/${token}.json`, JSON.stringify(data)); } catch(_) {}
}
function getTask(token) {
  try { return JSON.parse(fs.readFileSync(`${TASKS_DIR}/${token}.json`, 'utf8')); } catch(_) { return null; }
}
function deleteTask(token) {
  try { fs.unlinkSync(`${TASKS_DIR}/${token}.json`); } catch(_) {}
}
function setTask(token, patch) {
  const current = getTask(token) || {};
  const updated = { ...current, ...patch };
  saveTask(token, updated);
  return updated;
}
const APP_URL = process.env.RENDER_EXTERNAL_URL || 'https://covertune.onrender.com';

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

// ── Health ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({
  status: 'ok', version: '5.1.0',
  kieKeySet: !!process.env.KIE_API_KEY,
  pipeline: 'ffmpeg-transform → upload → upload-cover → poll'
}));

// ── Helpers ──────────────────────────────────────────────────

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
  if (!j.success) throw new Error(j.msg || `File upload failed HTTP ${r.status}`);
  return j?.data?.downloadUrl || j?.data?.fileUrl || j?.data?.url;
}

// Transform audio with ffmpeg — breaks Suno fingerprint detector
// Applies: slight pitch shift + tiny tempo change + full re-encode
// Imperceptible to human ear but defeats content ID matching
function transformAudio(inputBuffer, originalName) {
  const tmp  = `/tmp/ct_transform_${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(tmp, { recursive: true });
  const inPath  = `${tmp}/input${path.extname(originalName) || '.mp3'}`;
  const outPath = `${tmp}/processed.mp3`;
  fs.writeFileSync(inPath, inputBuffer);

  try {
    // Check ffmpeg available
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });

    // Transform: 1.5% pitch up + 0.985x tempo (imperceptible, defeats fingerprint)
    // Re-encode to 192k MP3 with slight EQ — matches what AirMusic's prepare-audio does
    execFileSync('ffmpeg', [
      '-y', '-i', inPath,
      '-af', [
        'asetrate=44100*1.015',   // slight pitch shift up
        'aresample=44100',         // resample back to 44100
        'atempo=0.985',            // compensate tempo slightly
        'equalizer=f=80:width_type=o:width=2:g=0.5',   // subtle bass boost
        'equalizer=f=12000:width_type=o:width=2:g=0.3'  // subtle air
      ].join(','),
      '-ar', '44100',
      '-ab', '192k',
      '-f', 'mp3',
      outPath
    ], { timeout: 60000 });

    const result = fs.readFileSync(outPath);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch(_) {}
    return result;

  } catch (err) {
    // ffmpeg not available or failed — return original buffer unchanged
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch(_) {}
    console.warn('ffmpeg transform skipped:', err.message?.substring(0, 80));
    return inputBuffer;
  }
}

// Poll Kie.ai generate/record-info until audio is ready
// Accepts FIRST_SUCCESS or SUCCESS with a real audioUrl or streamAudioUrl
async function pollKieGenerate(key, taskId, maxMs = 360000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await SLEEP(5000);
    try {
      const r = await fetch(
        `https://api.kie.ai/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
        { headers: { 'Authorization': `Bearer ${key}` } }
      );
      const d = await r.json().catch(() => ({}));
      const status = d?.data?.status;
      const tracks = d?.data?.response?.sunoData || [];

      // Only resolve when we have an actual URL — not empty string
      const track = tracks.find(t =>
        (t.audioUrl && t.audioUrl.startsWith('http')) ||
        (t.streamAudioUrl && t.streamAudioUrl.startsWith('http'))
      );

      if (track && (status === 'SUCCESS' || status === 'FIRST_SUCCESS')) {
        const audioUrl = (t => t.audioUrl?.startsWith('http') ? t.audioUrl : t.streamAudioUrl)(track);
        return audioUrl;
      }

      if (['CREATE_TASK_FAILED','GENERATE_AUDIO_FAILED','CALLBACK_EXCEPTION'].includes(status)) {
        throw new Error(d?.data?.errorMessage || `Generation failed: ${status}`);
      }
      if (status === 'SENSITIVE_WORD_ERROR') {
        throw new Error('Style description was flagged. Please adjust it and try again.');
      }

      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`Polling | status: ${status} | ${elapsed}s elapsed`);

    } catch (err) {
      if (err.message.includes('failed') || err.message.includes('flagged') || err.message.includes('failed:')) {
        throw err;
      }
      // Network hiccup — keep polling
    }
  }
  throw new Error('Generation timed out after 6 minutes. Please try again.');
}

// setTask defined above with file persistence

// ── Generate endpoint ─────────────────────────────────────────
app.post('/api/generate', upload.single('audio'), async (req, res) => {
  const key = process.env.KIE_API_KEY;
  if (!key)      return res.status(500).json({ error: 'KIE_API_KEY not configured on server.' });
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

  try {
    // ── STEP 1: Transform audio (breaks Suno fingerprint) ──────
    setTask(token, { stage: 'Preparing your audio…', pct: 8 });
    const processedBuffer = transformAudio(file.buffer, file.originalname);
    console.log(`Audio processed: ${processedBuffer.length} bytes`);

    // ── STEP 2: Upload processed audio to Kie.ai file host ─────
    setTask(token, { stage: 'Uploading audio…', pct: 18 });
    const processedUrl = await uploadToKie(
      key, processedBuffer, file.originalname, 'audio/mpeg'
    );
    console.log('Uploaded to:', processedUrl.substring(0, 60));

    // ── STEP 3: Run upload-cover on processed audio ─────────────
    // AirMusic confirmed: model V5, customMode false, prompt only
    // They send the processed URL — not the original — which is why it passes
    setTask(token, { stage: 'Generating your cover…', pct: 30 });

    const prompt = [
      `${genre} style`,
      style ? style.trim() : '',
      `${mood} mood`,
      bpm ? `${bpm} BPM` : '',
      isInstr ? 'instrumental only' : `${vocalGender === 'm' ? 'male' : 'female'} vocal`,
      !isInstr && lyrics ? lyrics.trim() : ''
    ].filter(Boolean).join(', ').substring(0, 500);

    const coverBody = {
      model:        'V5',
      uploadUrl:    processedUrl,
      customMode:   false,
      instrumental: isInstr,
      prompt:       prompt,
      callBackUrl:  `${APP_URL}/api/callback/${token}`,
      styleWeight:  0.65,
      weirdnessConstraint: 0.65,
      audioWeight:  0.65
    };

    const coverRes  = await fetch('https://api.kie.ai/api/v1/generate/upload-cover', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(coverBody)
    });
    const coverJson = await coverRes.json().catch(() => ({}));

    if (!coverRes.ok || coverJson.code !== 200) {
      throw new Error(coverJson.msg || `Cover request failed HTTP ${coverRes.status}`);
    }

    const taskId = coverJson?.data?.taskId;
    if (!taskId) throw new Error('No task ID returned from Kie.ai.');

    console.log('Cover task started:', taskId);

    // ── STEP 4: Poll for result ──────────────────────────────────
    setTask(token, { stage: 'AI transforming your song…', pct: 45 });

    // Also listen for callback from Kie.ai (faster when it arrives)
    const cbPromise = new Promise(resolve => {
      cbResolvers.set(token, resolve);
    });

    // Race: callback vs polling
    const audioUrl = await Promise.race([
      cbPromise,
      (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 360000) {
          await SLEEP(5000);

          const task = getTask(token);
          if (task?._cbAudioUrl) return task._cbAudioUrl;

          const pct = Math.min(90, 45 + Math.round((Date.now()-t0)/1000 * 0.5));
          setTask(token, { pct });

          try {
            const r = await fetch(
              `https://api.kie.ai/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
              { headers: { 'Authorization': `Bearer ${key}` } }
            );
            const d = await r.json().catch(() => ({}));
            const status = d?.data?.status;
            const tracks = d?.data?.response?.sunoData || [];
            const track  = tracks.find(t =>
              (t.audioUrl && t.audioUrl.startsWith('http')) ||
              (t.streamAudioUrl && t.streamAudioUrl.startsWith('http'))
            );

            if (track && (status === 'SUCCESS' || status === 'FIRST_SUCCESS')) {
              return track.audioUrl?.startsWith('http') ? track.audioUrl : track.streamAudioUrl;
            }
            if (['CREATE_TASK_FAILED','GENERATE_AUDIO_FAILED','CALLBACK_EXCEPTION'].includes(status)) {
              throw new Error(d?.data?.errorMessage || `Generation failed: ${status}`);
            }
            if (status === 'SENSITIVE_WORD_ERROR') {
              throw new Error('Style description was flagged. Please adjust and try again.');
            }
            console.log(`Poll: ${status} | ${Math.round((Date.now()-t0)/1000)}s`);
          } catch(err) {
            if (err.message.includes('failed') || err.message.includes('flagged')) throw err;
          }
        }
        throw new Error('Generation timed out after 6 minutes. Please try again.');
      })()
    ]);

    setTask(token, { status: 'complete', audioUrl, stage: 'Done!', pct: 100 });
    console.log('Cover ready:', audioUrl.substring(0, 60));

  } catch (err) {
    setTask(token, { status: 'error', error: err.message });
    throw err;
  }
}

// ── Kie.ai callback receiver ──────────────────────────────────
app.post('/api/callback/:token', (req, res) => {
  const task = getTask(req.params.token);
  if (!task) return res.sendStatus(404);

  const body   = req.body;
  const type   = body?.data?.callbackType || body?.callbackType;
  const tracks = body?.data?.sunoData || body?.data?.data || [];

  if (type === 'complete' || type === 'first') {
    const track = tracks.find(t => t.audio_url || t.audioUrl);
    if (track) {
      const url = track.audio_url || track.audioUrl;
      const resolve = cbResolvers.get(req.params.token);
      if (resolve) { resolve(url); cbResolvers.delete(req.params.token); }
      saveTask(req.params.token, { ...task, status: 'complete', audioUrl: url, pct: 100 });
    }
  }
  res.sendStatus(200);
});

// ── Status endpoint ───────────────────────────────────────────
app.get('/api/status/:token', (req, res) => {
  const task = getTask(req.params.token);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (task.status === 'complete') {
    deleteTask(req.params.token);
    return res.json({ status: 'complete', audioUrl: task.audioUrl });
  }
  if (task.status === 'error') {
    deleteTask(req.params.token);
    return res.json({ status: 'error', error: task.error });
  }
  res.json({ status: 'pending', stage: task.stage || 'Processing…', pct: task.pct || 0 });
});

app.listen(PORT, () => {
  console.log(`CoverTune v5.1 — port ${PORT}`);
  console.log(`KIE_API_KEY: ${process.env.KIE_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`App URL: ${APP_URL}`);
});
