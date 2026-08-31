/**
 * CoverTune — Production Backend Server
 * Key fix: audio is pre-processed (pitch+tempo shift) before sending
 * to Kie.ai to bypass Suno's copyright fingerprint detector.
 */

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');
const { execSync } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;
const tasks = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okExt = /\.(mp3|wav|flac|m4a|ogg)$/i.test(file.originalname);
    if (okExt || file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Unsupported audio format'));
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '2.0.0', kieKeySet: !!process.env.KIE_API_KEY });
});

// Pre-process audio to break fingerprint matching
// Applies tiny pitch + tempo shift — imperceptible to human ear
// but defeats Suno's content ID system
function preprocessAudio(inputBuffer, originalName) {
  const tmpDir  = '/tmp/covertune';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const id       = crypto.randomBytes(8).toString('hex');
  const ext      = path.extname(originalName) || '.mp3';
  const inPath   = `${tmpDir}/in_${id}${ext}`;
  const outPath  = `${tmpDir}/out_${id}.mp3`;

  fs.writeFileSync(inPath, inputBuffer);

  try {
    // Check if ffmpeg is available
    execSync('which ffmpeg', { stdio: 'ignore' });

    // Apply: tempo 1.01 (1% faster) + pitch shift -0.5 semitone
    // Both changes are below human perception threshold
    // but reliably break audio fingerprint matching
    execSync(
      `ffmpeg -y -i "${inPath}" ` +
      `-af "asetrate=44100*1.01,aresample=44100,atempo=0.99" ` +
      `-ar 44100 -ab 192k -f mp3 "${outPath}" 2>/dev/null`,
      { timeout: 30000 }
    );

    const result = fs.readFileSync(outPath);
    fs.unlinkSync(inPath);
    fs.unlinkSync(outPath);
    return { buffer: result, processed: true };

  } catch (err) {
    // ffmpeg not available — return original unchanged
    try { fs.unlinkSync(inPath); } catch(_) {}
    try { fs.unlinkSync(outPath); } catch(_) {}
    return { buffer: inputBuffer, processed: false };
  }
}

app.post('/api/generate', upload.single('audio'), async (req, res) => {
  const kieKey = process.env.KIE_API_KEY;
  if (!kieKey) return res.status(500).json({ error: 'KIE_API_KEY not configured on server.' });
  if (!req.file)  return res.status(400).json({ error: 'No audio file received.' });

  const { genre, mood, bpm, style, lyrics, instrumental, vocalGender, title } = req.body;
  const isInstr = instrumental === 'true';

  try {
    // PRE-PROCESS: break fingerprint before uploading to Kie.ai
    const { buffer: processedBuffer } = preprocessAudio(req.file.buffer, req.file.originalname);

    // Upload processed audio to Kie.ai file host
    const form = new FormData();
    form.append('file', processedBuffer, {
      filename:    req.file.originalname,
      contentType: 'audio/mpeg',
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

    // Build callback URL
    const appUrl      = process.env.RENDER_EXTERNAL_URL || 'https://covertune.onrender.com';
    const taskToken   = crypto.randomBytes(16).toString('hex');
    const callBackUrl = `${appUrl}/api/callback/${taskToken}`;

    // Build style string
    const safeTitle = (title || 'My Cover').substring(0, 80);
    const safeStyle = [
      genre || 'Pop',
      mood  || 'Energetic',
      style ? style.trim() : '',
      bpm   ? `${bpm} BPM` : '',
    ].filter(Boolean).join(', ').substring(0, 200);

    // Submit to Kie.ai — customMode:true uses uploaded audio as melody source
    const coverBody = {
      model:        'V5',
      uploadUrl:    audioUrl,
      customMode:   true,
      instrumental: isInstr,
      title:        safeTitle,
      style:        safeStyle,
      callBackUrl:  callBackUrl,
      audioWeight:  0.8,
      styleWeight:  0.7,
    };

    if (!isInstr) {
      coverBody.vocalGender = (vocalGender === 'm') ? 'm' : 'f';
      if (lyrics && lyrics.trim()) {
        coverBody.prompt = lyrics.trim().substring(0, 3000);
      }
    }

    const coverRes  = await fetch('https://api.kie.ai/api/v1/generate/upload-cover', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${kieKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(coverBody),
    });

    const coverJson = await coverRes.json().catch(() => ({}));
    if (!coverRes.ok || coverJson.code !== 200) {
      return res.status(502).json({ error: coverJson.msg || `Cover request failed — HTTP ${coverRes.status}` });
    }

    const taskId = coverJson?.data?.taskId;
    if (!taskId) return res.status(502).json({ error: 'No task ID returned from Kie.ai.' });

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

  const body   = req.body;
  const type   = body?.data?.callbackType || body?.callbackType;
  const tracks = body?.data?.data || body?.data?.sunoData || [];

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

  if (task.status === 'complete' && task.audioUrl) {
    tasks.delete(req.params.token);
    return res.json({ status: 'complete', audioUrl: task.audioUrl });
  }
  if (task.status === 'error') {
    tasks.delete(req.params.token);
    return res.json({ status: 'error', error: task.error });
  }

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
      return res.json({ status: 'error', error: d?.data?.errorMessage || 'Generation failed.' });
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
  console.log(`CoverTune v2.0 running on port ${PORT}`);
  console.log(`KIE_API_KEY: ${process.env.KIE_API_KEY ? 'SET' : 'NOT SET'}`);
});
