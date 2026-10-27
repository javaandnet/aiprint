import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getProvider, providers } from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

const PORT = Number(process.env.PORT || 3600);

// Bambu Lab P2S reference (used for on-screen print tips)
const PRINTER_PROFILES = {
  P2S: { name: 'Bambu Lab P2S', volumeMM: [256, 256, 256], note: 'CoreXY, enclosed, supports AMS multi-color.' },
};

// In-memory job store: id -> { provider, taskId, options, createdAt }
const jobs = new Map();
const JOB_TTL_MS = 1000 * 60 * 60 * 24; // 24h

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}
setInterval(sweepJobs, 1000 * 60 * 30).unref();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB, matches provider limits
});

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(publicDir));

// Which providers are configured / available
app.get('/api/providers', (req, res) => {
  const list = Object.values(providers)
    .filter((p) => p.enabled(process.env))
    .map((p) => ({ id: p.id, name: p.name, formats: p.formats }));
  res.json({ success: true, data: { providers: list, printers: PRINTER_PROFILES } });
});

// Create a generation job from an uploaded image
app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    const providerId = (req.body.provider || 'meshy').toLowerCase();
    const provider = getProvider(providerId);
    if (!provider.enabled(process.env)) {
      return res.status(400).json({ success: false, error: `Provider "${provider.name}" is not configured.` });
    }

    const file = req.file;
    const imageUrl = req.body.image_url;
    if (!file && !imageUrl) {
      return res.status(400).json({ success: false, error: 'Provide an image file or image_url.' });
    }

    const options = {
      texture: req.body.texture !== 'false',
      pose_mode: req.body.pose_mode || '',
      aiModel: req.body.ai_model || undefined,
      geometryResolution: req.body.geometry_resolution || undefined,
      targetPolycount: req.body.target_polycount ? Number(req.body.target_polycount) : undefined,
      model: req.body.model || undefined,
      faceLimit: req.body.face_limit ? Number(req.body.face_limit) : undefined,
    };

    let payload;
    if (file) {
      const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      payload = { imageDataUri: dataUri, imageBuffer: file.buffer, imageMime: file.mimetype, options };
    } else {
      payload = { imageUrl, options };
    }

    const created = await provider.createTask(process.env, payload);
    const id = newId();
    jobs.set(id, { id, provider: providerId, taskId: created.taskId, options, createdAt: Date.now() });
    console.log(`[aiprint] job ${id} created -> ${providerId}:${created.taskId}`);
    res.json({ success: true, data: { jobId: id, provider: providerId, taskId: created.taskId } });
  } catch (err) {
    console.error('[aiprint] generate failed:', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Poll job status (server proxies the provider so the client never touches signed URLs)
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found or expired.' });
    const provider = getProvider(job.provider);
    const state = await provider.getTask(process.env, job.taskId);
    res.json({
      success: true,
      data: {
        jobId: job.id,
        provider: job.provider,
        taskId: job.taskId,
        ...state,
        raw: undefined,
      },
    });
  } catch (err) {
    console.error('[aiprint] poll failed:', err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Download a generated model, proxied + streamed so browser CORS / URL expiry are not an issue
app.get('/api/jobs/:id/download', async (req, res) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found or expired.' });
    const provider = getProvider(job.provider);
    const state = await provider.getTask(process.env, job.taskId);
    if (state.status !== 'SUCCEEDED') {
      return res.status(409).json({ success: false, error: `Model not ready (status: ${state.status}).` });
    }
    const fmt = (req.query.format || 'stl').toLowerCase();
    const url = state.models[fmt] || state.models.glb;
    if (!url) return res.status(404).json({ success: false, error: `Format "${fmt}" not available.` });
    const actualFmt = state.models[fmt] ? fmt : 'glb';

    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ success: false, error: `Upstream download failed: HTTP ${upstream.status}` });
    }
    const filename = `aiprint-${job.id}.${actualFmt}`;
    const inline = req.query.inline === '1';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
    res.setHeader('Content-Type', actualFmt === 'glb' ? 'model/gltf-binary' : 'application/octet-stream');
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[aiprint] download failed:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  const enabled = Object.values(providers).filter((p) => p.enabled(process.env)).map((p) => p.id);
  console.log(`[aiprint] server on http://localhost:${PORT}`);
  console.log(`[aiprint] enabled providers: ${enabled.length ? enabled.join(', ') : '(none - set API keys in .env)'}`);
});
