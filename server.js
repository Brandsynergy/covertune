/**
 * CoverTune — Production Backend Server
 * Deploy to Render.com — set environment variables in Render dashboard
 *
 * Environment variables required in Render:
 *   KIE_API_KEY   — your Kie.ai API key (never sent to browser)
 *   PORT          — set automatically by Render
 */

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const path     = require('path');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── In-memory task store ─────────────────────────────────────
// Holds taskId → { status, audioUrl, error } while job runs
// For production scale use Redis instead
const tasks = new Map();

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer: accept audio files up to 50 MB in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/mpeg','audio/wav','audio/flac','audio/mp4',
                     'audio/ogg','audio/x-wav','audio/x-m4a'];
    const okExt   = /\.(mp3|wav|flac|m4a|ogg)$/i.test(file.originalname);
    if (allowed.includes(file.mimetype) || okExt) cb(null, true);
    else cb(new Error('Unsupported audio format'));
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ── STEP 1 + 2: Upload audio and create cover task ───────────
app.post('/api/generate', upload.single('audio'), async (req, res) => {
  const kieKey = process.env.KIE_API_KEY;
  if (!kieKey) {
    return res.status(500).json({ error: 'KIE_API_KEY not configured on server.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received.' });
  }

  const { genre, mood, bpm, style, lyrics, instrumental, vocalGender, title } = req.body;
  const isInstr = instrumental === 'true';

  try {

    // ── Upload audio to Kie.ai file host ─────────────────────
    const form = new FormData();
    form.append('file',       req.file.buffer, {
      filename:    req.file.originalname,
      contentType: req.file.mimetype,
    });
    form.append('uploadPath', 'audio/covers');
    form.append('fileName',   req.file.originalname);

    const uploadRes = await fetch('https://kieai.redpandaai.co/api/file-stream-upload', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${kieKey}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    const uploadJson = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok || !uploadJson.success) {
      const msg = uploadJson.msg || uploadJson.message || `Upload failed — HTTP ${uploadRes.status}`;
      return res.status(502).json({ error: msg });
    }

    const audioUrl = uploadJson?.data?.downloadUrl
                  || uploadJson?.data?.fileUrl
                  || uploadJson?.data?.url;
    if (!audioUrl) return res.status(502).json({ error: 'File uploaded but no URL returned.' });

    // ── Build callback URL so Kie.ai pushes results to us ────
    // Render gives us a stable public HTTPS URL
    const appUrl    = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const taskToken = crypto.randomBytes(16).toString('hex');
    const callBackUrl = `${appUrl}/api/callback/${taskToken}`;

    // ── Build prompt from user selections ────────────────────
    const parts = [
      `${genre || 'Pop'} style cover`,
      style || '',
      `${mood || 'Energetic'} mood`,
      bpm ? `${bpm} BPM` : '',
      isInstr ? 'instrumental only, no vocals' : `${vocalGender === 'm' ? 'male' : 'female'} vocal`,
      (!isInstr && lyrics) ? lyrics : '',
    ].filter(Boolean);
    const prompt = parts.join(', ').substring(0, 500);

    // ── Submit cover task to Kie.ai ──────────────────────────
    const coverBody = {
      model:        'V5',
      uploadUrl:    audioUrl,
      customMode:   false,
      instrumental: isInstr,
      prompt:       prompt,
      callBackUrl:  callBackUrl,
    };

    const coverRes  = await fetch('https://api.kie.ai/api/v1/generate/upload-cover', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${kieKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(coverBody),
    });

    const coverJson = await coverRes.json().catch(() => ({}));
    if (!coverRes.ok || coverJson.code !== 200) {
      const msg = coverJson.msg || coverJson.message || `Cover request failed — HTTP ${coverRes.status}`;
      return res.status(502).json({ error: msg });
    }

    const taskId = coverJson?.data?.taskId;
    if (!taskId) return res.status(502).json({ error: 'No task ID returned from Kie.ai.' });

    // Store task in memory while we wait for callback
    tasks.set(taskToken, { taskId, status: 'pending', audioUrl: null, error: null });

    // Return the token to the browser — browser polls /api/status/:token
    res.json({ token: taskToken, taskId });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Kie.ai callback receiver ─────────────────────────────────
app.post('/api/callback/:token', (req, res) => {
  const { token } = req.params;
  const task = tasks.get(token);
  if (!task) return res.sendStatus(404);

  const body         = req.body;
  const callbackType = body?.data?.callbackType || body?.callbackType;
  const sunoData     = body?.data?.data || body?.data?.sunoData || [];
  const code         = body?.code;

  if (callbackType === 'complete' || code === 200) {
    const track = sunoData.find(t => t.audio_url || t.audioUrl);
    if (track) {
      task.status   = 'complete';
      task.audioUrl = track.audio_url || track.audioUrl;
    }
  }

  // Also handle error callbacks
  if (body?.msg && body.msg !== 'success' && body.code !== 200) {
    task.status = 'error';
    task.error  = body.msg || 'Generation failed';
  }

  tasks.set(token, task);
  res.sendStatus(200);
});

// ── Browser polls this until complete ───────────────────────
app.get('/api/status/:token', async (req, res) => {
  const { token } = req.params;
  const task = tasks.get(token);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // If callback already delivered the result, return it
  if (task.status === 'complete' && task.audioUrl) {
    tasks.delete(token); // clean up
    return res.json({ status: 'complete', audioUrl: task.audioUrl });
  }
  if (task.status === 'error') {
    tasks.delete(token);
    return res.json({ status: 'error', error: task.error });
  }

  // Otherwise actively poll Kie.ai as backup
  try {
    const kieKey = process.env.KIE_API_KEY;
    const r = await fetch(
      `https://api.kie.ai/api/v1/generate/record-info?taskId=${encodeURIComponent(task.taskId)}`,
      { headers: { 'Authorization': `Bearer ${kieKey}` } }
    );
    const d = await r.json().catch(() => ({}));
    const status   = d?.data?.status;
    const sunoData = d?.data?.response?.sunoData || [];

    if (status === 'SUCCESS' || status === 'FIRST_SUCCESS') {
      const track = sunoData.find(t => t.audioUrl || t.streamAudioUrl);
      if (track) {
        const audioUrl = track.audioUrl || track.streamAudioUrl;
        tasks.delete(token);
        return res.json({ status: 'complete', audioUrl });
      }
    }

    if (['CREATE_TASK_FAILED','GENERATE_AUDIO_FAILED','CALLBACK_EXCEPTION'].includes(status)) {
      tasks.delete(token);
      return res.json({ status: 'error', error: d?.data?.errorMessage || 'Generation failed' });
    }

    if (status === 'SENSITIVE_WORD_ERROR') {
      tasks.delete(token);
      return res.json({ status: 'error', error: 'Content flagged — change your title or style and try again.' });
    }

    // Still running
    return res.json({ status: 'pending' });

  } catch (err) {
    return res.json({ status: 'pending' }); // network hiccup, keep polling
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎵 CoverTune server running on port ${PORT}`);
  console.log(`   KIE_API_KEY: ${process.env.KIE_API_KEY ? 'SET ✓' : 'NOT SET ✗'}`);
});
