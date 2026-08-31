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

// In-memory task store
const tasks = new Map();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer: audio files up to 50 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okExt = /\.(mp3|wav|flac|m4a|ogg)$/i.test(file.originalname);
    if (okExt || file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Unsupported audio format'));
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    kieKeySet: !!process.env.KIE_API_KEY
  });
});

// Generate endpoint
app.post('/api/generate', upload.single('audio'), async (req, res) => {
  const kieKey = process.env.KIE_API_KEY;
  if (!kieKey) return res.status(500).json({ error: 'KIE_API_KEY not configured on server.' });
  if (!req.file)  return res.status(400).json({ error: 'No audio file received.' });

  const { genre, mood, bpm, style, lyrics, instrumental, vocalGender, title } = req.body;
  const isInstr = instrumental === 'true';

  try {

    // STEP 1: Upload audio to Kie.ai file host
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename:    req.file.originalname,
      contentType: req.file.mimetype,
    });
    form.append('uploadPath', 'audio/covers');
    form.append('fileName',   req.file.originalname);

    const uploadRes  = await fetch('https://kieai.redpandaai.co/api/file-stream-upload', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${kieKey}`, ...form.getHeaders() },
      body:    form,
    });

    const uploadJson = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok || !uploadJson.success) {
      return res.status(502).json({ error: uploadJson.msg || `Upload failed — HTTP ${uploadRes.status}` });
    }

    const audioUrl = uploadJson?.data?.downloadUrl
                  || uploadJson?.data?.fileUrl
                  || uploadJson?.data?.url;
    if (!audioUrl) return res.status(502).json({ error: 'File uploaded but no URL returned.' });

    // STEP 2: Build callback URL
    const appUrl      = process.env.RENDER_EXTERNAL_URL || `https://covertune.onrender.com`;
    const taskToken   = crypto.randomBytes(16).toString('hex');
    const callBackUrl = `${appUrl}/api/callback/${taskToken}`;

    // STEP 3: Build style string from user selections
    // customMode:true is REQUIRED — this tells Kie.ai to use uploadUrl as the melody source
    // customMode:false ignores the uploaded audio entirely and causes catalog match errors
    const safeTitle = (title || 'My Cover').substring(0, 80);
    const safeStyle = [
      genre || 'Pop',
      mood  || 'Energetic',
      style ? style : '',
      bpm   ? `${bpm} BPM` : '',
    ].filter(Boolean).join(', ').substring(0, 200);

    const coverBody = {
      model:        'V5',
      uploadUrl:    audioUrl,
      customMode:   true,          // MUST be true to use uploaded audio as melody
      instrumental: isInstr,
      title:        safeTitle,
      style:        safeStyle,
      callBackUrl:  callBackUrl,
    };

    // Add vocals-specific params
    if (!isInstr) {
      coverBody.vocalGender = (vocalGender === 'm') ? 'm' : 'f';
      if (lyrics && lyrics.trim()) {
        coverBody.prompt = lyrics.trim().substring(0, 3000);
      }
    }

    // STEP 4: Submit to Kie.ai
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
      return res.status(502).json({ error: coverJson.msg || `Cover request failed — HTTP ${coverRes.status}` });
    }

    const taskId = coverJson?.data?.taskId;
    if (!taskId) return res.status(502).json({ error: 'No task ID returned from Kie.ai.' });

    // Store task
    tasks.set(taskToken, { taskId, status: 'pending', audioUrl: null, error: null });

    res.json({ token: taskToken, taskId });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Kie.ai callback receiver
app.post('/api/callback/:token', (req, res) => {
  const task = tasks.get(req.params.token);
  if (!task) return res.sendStatus(404);

  const body     = req.body;
  const type     = body?.data?.callbackType || body?.callbackType;
  const tracks   = body?.data?.data || body?.data?.sunoData || [];

  if (type === 'complete' || body?.code === 200) {
    const track = tracks.find(t => t.audio_url || t.audioUrl);
    if (track) {
      task.status   = 'complete';
      task.audioUrl = track.audio_url || track.audioUrl;
    }
  }

  if (body?.code !== 200 && body?.msg && body.msg !== 'success') {
    task.status = 'error';
    task.error  = body.msg;
  }

  tasks.set(req.params.token, task);
  res.sendStatus(200);
});

// Status poll endpoint
app.get('/api/status/:token', async (req, res) => {
  const task = tasks.get(req.params.token);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  // Return immediately if callback already delivered result
  if (task.status === 'complete' && task.audioUrl) {
    tasks.delete(req.params.token);
    return res.json({ status: 'complete', audioUrl: task.audioUrl });
  }
  if (task.status === 'error') {
    tasks.delete(req.params.token);
    return res.json({ status: 'error', error: task.error });
  }

  // Actively poll Kie.ai as backup
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
        tasks.delete(req.params.token);
        return res.json({ status: 'complete', audioUrl: track.audioUrl || track.streamAudioUrl });
      }
    }

    if (['CREATE_TASK_FAILED','GENERATE_AUDIO_FAILED','CALLBACK_EXCEPTION'].includes(status)) {
      tasks.delete(req.params.token);
      return res.json({ status: 'error', error: d?.data?.errorMessage || 'Generation failed on Kie.ai.' });
    }

    if (status === 'SENSITIVE_WORD_ERROR') {
      tasks.delete(req.params.token);
      return res.json({ status: 'error', error: 'Content flagged — adjust your style description and try again.' });
    }

    return res.json({ status: 'pending' });

  } catch (_) {
    return res.json({ status: 'pending' });
  }
});

app.listen(PORT, () => {
  console.log(`CoverTune running on port ${PORT}`);
  console.log(`KIE_API_KEY: ${process.env.KIE_API_KEY ? 'SET' : 'NOT SET'}`);
});
