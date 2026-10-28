import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getProvider, providers } from './providers.js';
import { slice, detectOrca, listSliceOptions } from './slicer.js';
import { pushToPrinter, testPrinterConnection } from './push.js';
import { readStl, normalize, writeBinaryStl } from './stl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

const PORT = Number(process.env.PORT || 3600);

// Load API keys from the local key/ directory (kept out of Git via .gitignore).
// Priority: env var > key/<provider>.key > generic key/3d.key (assigned by KEY_PROVIDER, default tripo).
function loadKeyFiles() {
  const keyDir = path.join(rootDir, 'key');
  const envFor = { tripo: 'TRIPO_API_KEY', meshy: 'MESHY_API_KEY' };
  const readKey = (f) => {
    try { return fs.readFileSync(f, 'utf8').trim().split('\n')[0].trim(); } catch { return ''; }
  };
  for (const [p, envName] of Object.entries(envFor)) {
    if (!process.env[envName]) {
      const v = readKey(path.join(keyDir, `${p}.key`));
      if (v) process.env[envName] = v;
    }
  }
  const generic = path.join(keyDir, '3d.key');
  if (fs.existsSync(generic)) {
    const target = (process.env.KEY_PROVIDER || 'tripo').toLowerCase();
    const envName = envFor[target] || 'TRIPO_API_KEY';
    if (!process.env[envName]) {
      const v = readKey(generic);
      if (v) process.env[envName] = v;
    }
  }
}
loadKeyFiles();

// Bambu Lab P2S reference (used for on-screen print tips)
const PRINTER_PROFILES = {
  P2S: { name: 'Bambu Lab P2S', volumeMM: [256, 256, 256], note: 'CoreXY, enclosed, supports AMS multi-color.' },
};

// In-memory job store: id -> { provider, taskId, options, createdAt }
const jobs = new Map();
const JOB_TTL_MS = 1000 * 60 * 60 * 24; // 24h

// Sliced artifacts: id -> { path, filename, format, jobId, createdAt }
const slices = new Map();
const outputDir = path.join(rootDir, 'output');
fs.mkdirSync(outputDir, { recursive: true });

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
    const dataUri = file ? `data:${file.mimetype};base64,${file.buffer.toString('base64')}` : null;

    // Cost tiers: draft (cheap, mesh-only) | final (full textured) | retexture (meshy: re-skin an existing model)
    const mode = (req.body.mode || 'final').toLowerCase();

    const options = {
      texture: req.body.texture !== 'false',
      pose_mode: req.body.pose_mode || '',
      aiModel: req.body.ai_model || undefined,
      geometryResolution: req.body.geometry_resolution || undefined,
      targetPolycount: req.body.target_polycount ? Number(req.body.target_polycount) : undefined,
      model: req.body.model || undefined,
      faceLimit: req.body.face_limit ? Number(req.body.face_limit) : undefined,
    };

    // ---- Retexture (Meshy only): reuse geometry, only redo the texture. ~10 credits. ----
    if (mode === 'retexture') {
      if (providerId !== 'meshy') {
        return res.status(400).json({ success: false, error: '换皮（Retexture）目前仅 Meshy 支持。' });
      }
      const srcJob = jobs.get(req.body.source_job_id);
      if (!srcJob || srcJob.provider !== 'meshy') {
        return res.status(400).json({ success: false, error: '找不到可换皮的上一个 Meshy 任务，请先生成一个终稿。' });
      }
      const created = await provider.retexture(process.env, {
        inputTaskId: srcJob.taskId,
        texturePrompt: req.body.texture_prompt || undefined,
        textureImageDataUri: dataUri || undefined,
        options: { pbr: req.body.pbr === 'true', textureResolution: req.body.texture_resolution || undefined },
      });
      const id = newId();
      jobs.set(id, { id, provider: providerId, taskId: created.taskId, kind: 'retexture', options, createdAt: Date.now() });
      console.log(`[aiprint] retexture job ${id} -> meshy:${created.taskId} (from ${srcJob.taskId})`);
      return res.json({ success: true, data: { jobId: id, provider: providerId, taskId: created.taskId, mode } });
    }

    // ---- Apply draft/final presets ----
    if (mode === 'draft') {
      options.texture = false; // mesh-only, no texture -> cheapest
      if (providerId === 'meshy') { options.aiModel = 'meshy-6-lite'; options.geometryResolution = undefined; }
    } else if (providerId === 'meshy' && !options.aiModel) {
      options.aiModel = 'latest'; // final pass defaults to Meshy 7.1
    }

    if (!file && !imageUrl) {
      return res.status(400).json({ success: false, error: 'Provide an image file or image_url.' });
    }

    const payload = file
      ? { imageDataUri: dataUri, imageBuffer: file.buffer, imageMime: file.mimetype, options }
      : { imageUrl, options };

    const created = await provider.createTask(process.env, payload);
    const id = newId();
    jobs.set(id, { id, provider: providerId, taskId: created.taskId, kind: 'image-to-3d', options, createdAt: Date.now() });
    console.log(`[aiprint] job ${id} (${mode}) created -> ${providerId}:${created.taskId}`);
    res.json({ success: true, data: { jobId: id, provider: providerId, taskId: created.taskId, mode } });
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
    const state = await provider.getTask(process.env, job.taskId, job.kind || 'image-to-3d');
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
    const state = await provider.getTask(process.env, job.taskId, job.kind || 'image-to-3d');
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

// ---- Slicing (OrcaSlicer headless for Bambu P2S) ----
async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载模型失败: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Expose whether a slicer is available so the UI can enable/disable slice buttons.
app.get('/api/slicer', (req, res) => {
  const available = !!detectOrca();
  res.json({ success: true, data: { available, printer: 'Bambu Lab P2S', options: available ? listSliceOptions() : null } });
});

// Last successful printer connection is cached to printer.json (gitignored; holds the LAN access code).
const printerConfigPath = path.join(rootDir, 'printer.json');
function readPrinterConfig() {
  try { return JSON.parse(fs.readFileSync(printerConfigPath, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') console.debug('[aiprint] printer.json unreadable, using defaults:', err.message); return {}; }
}
function writePrinterConfig(cfg) {
  const clean = { ip: String(cfg.ip || '').trim(), accessCode: String(cfg.accessCode || '').trim(), serial: String(cfg.serial || '').trim(), nozzle: cfg.nozzle ? String(cfg.nozzle) : undefined, savedAt: new Date().toISOString() };
  fs.writeFileSync(printerConfigPath, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

// Return the saved printer profile so the UI can pre-fill the LAN form.
app.get('/api/printer/config', (req, res) => {
  res.json({ success: true, data: readPrinterConfig() });
});

// Persist a printer profile.
app.post('/api/printer/config', express.json(), (req, res) => {
  try {
    const { ip, accessCode, serial, nozzle } = req.body || {};
    if (!ip || !accessCode || !serial) return res.status(400).json({ success: false, error: '保存需要 IP、Access Code、序列号。' });
    res.json({ success: true, data: writePrinterConfig({ ip, accessCode, serial, nozzle }) });
  } catch (err) {
    console.error('[aiprint] save printer config failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Slice a finished generation into G-code or a 3MF project. Auto-scales to targetMM.
app.post('/api/slice', express.json(), async (req, res) => {
  try {
    const { jobId, format = 'gcode', targetMM = 60, nozzle = '0.4', quality = '0.20mm Standard', material = 'Bambu PLA Basic' } = req.body || {};
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found or expired.' });
    if (!detectOrca()) return res.status(503).json({ success: false, error: '未找到 OrcaSlicer，无法切片。' });

    const provider = getProvider(job.provider);
    const state = await provider.getTask(process.env, job.taskId, job.kind || 'image-to-3d');
    if (state.status !== 'SUCCEEDED') return res.status(409).json({ success: false, error: `模型未就绪（${state.status}）。` });

    // Prefer STL (scalable + universally importable), then OBJ, then GLB.
    const fmtKey = ['stl', 'obj', 'glb'].find((f) => state.models[f]);
    if (!fmtKey) return res.status(422).json({ success: false, error: '该引擎未返回可切片模型文件。' });

    const dir = path.join(outputDir, jobId);
    fs.mkdirSync(dir, { recursive: true });
    const buf = await downloadToBuffer(state.models[fmtKey]);
    const rawPath = path.join(dir, `model.${fmtKey}`);
    fs.writeFileSync(rawPath, buf);

    let modelPath = rawPath;
    if (fmtKey === 'stl') {
      const scaled = normalize(readStl(buf), { targetMM: Number(targetMM) || 60, axis: 2 });
      modelPath = path.join(dir, 'model_scaled.stl');
      fs.writeFileSync(modelPath, writeBinaryStl(scaled.tris));
    }

    const out = await slice(modelPath, dir, { format, nozzle, quality, material });
    const ext = format === '3mf' ? '3mf' : 'gcode';
    const filename = `aiprint-${jobId}.${ext}`;
    const finalPath = path.join(dir, filename);
    if (out.output !== finalPath) fs.renameSync(out.output, finalPath);

    const id = newId();
    slices.set(id, { id, path: finalPath, filename, format: ext, jobId, slice: out.slice, createdAt: Date.now() });
    console.log(`[aiprint] sliced ${jobId} (${fmtKey}, ${targetMM}mm) -> ${filename}`);
    res.json({ success: true, data: { sliceId: id, format: ext, filename, slice: out.slice, scaled: fmtKey === 'stl' } });
  } catch (err) {
    console.error('[aiprint] slice failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Slice an uploaded STL/OBJ directly (no AI job needed) — lets the slice+push chain be tested offline.
app.post('/api/slice-upload', upload.single('model'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, error: '未收到模型文件。' });
    if (!detectOrca()) return res.status(503).json({ success: false, error: '未找到 OrcaSlicer，无法切片。' });
    const b = req.body || {};
    const format = b.format || 'gcode';
    const targetMM = Number(b.targetMM) || 60;
    const nozzle = b.nozzle || '0.4';
    const quality = b.quality || '0.20mm Standard';
    const material = b.material || 'Bambu PLA Basic';
    const orig = String(req.file.originalname || 'model').toLowerCase();
    const isStl = orig.endsWith('.stl');
    const jobId = newId();
    const dir = path.join(outputDir, jobId);
    fs.mkdirSync(dir, { recursive: true });

    let modelPath;
    if (isStl) {
      const scaled = normalize(readStl(req.file.buffer), { targetMM, axis: 2 });
      modelPath = path.join(dir, 'model_scaled.stl');
      fs.writeFileSync(modelPath, writeBinaryStl(scaled.tris));
    } else {
      modelPath = path.join(dir, orig.endsWith('.obj') ? 'model.obj' : 'model.stl');
      fs.writeFileSync(modelPath, req.file.buffer);
    }

    const out = await slice(modelPath, dir, { format, nozzle, quality, material });
    const ext = format === '3mf' ? '3mf' : 'gcode';
    const filename = `aiprint-${jobId}.${ext}`;
    const finalPath = path.join(dir, filename);
    if (out.output !== finalPath) fs.renameSync(out.output, finalPath);
    const id = newId();
    slices.set(id, { id, path: finalPath, filename, format: ext, jobId, slice: out.slice, createdAt: Date.now() });
    console.log(`[aiprint] uploaded slice ${jobId} (${orig}, ${targetMM}mm) -> ${filename}`);
    res.json({ success: true, data: { sliceId: id, format: ext, filename, slice: out.slice, scaled: isStl } });
  } catch (err) {
    console.error('[aiprint] upload slice failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download a sliced artifact.
app.get('/api/slice/:id/download', (req, res) => {
  const s = slices.get(req.params.id);
  if (!s) return res.status(404).json({ success: false, error: 'Sliced file not found.' });
  res.setHeader('Content-Disposition', `attachment; filename="${s.filename}"`);
  res.setHeader('Content-Type', s.format === '3mf' ? 'model/3mf' : 'text/plain');
  fs.createReadStream(s.path).pipe(res);
});

// Test the LAN connection to the printer: validate access code + read back model and installed nozzle(s).
app.post('/api/printer/test', express.json(), async (req, res) => {
  try {
    const { ip, accessCode, serial } = req.body || {};
    const logs = [];
    const result = await testPrinterConnection({ ip, accessCode, serial, onLog: (m) => logs.push(m) });
    try { writePrinterConfig({ ip, accessCode, serial, nozzle: result.printer?.nozzle_diameters?.[0] }); } catch (err) { console.debug('[aiprint] auto-save printer config failed:', err.message); }
    res.json({ success: true, data: { ...result, logs } });
  } catch (err) {
    console.error('[aiprint] printer test failed:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Push a sliced G-code directly to the P2S over the LAN (experimental).
app.post('/api/slice/:id/push', express.json(), async (req, res) => {
  try {
    const s = slices.get(req.params.id);
    if (!s) return res.status(404).json({ success: false, error: 'Sliced file not found.' });
    if (s.format !== 'gcode') return res.status(422).json({ success: false, error: 'LAN 推送目前只支持 G-code 产物。' });
    const { ip, accessCode, serial, autoStart = true } = req.body || {};
    const logs = [];
    const result = await pushToPrinter({ ip, accessCode, serial, gcodePath: s.path, filename: s.filename, autoStart, onLog: (m) => logs.push(m) });
    res.json({ success: true, data: { ...result, logs } });
  } catch (err) {
    console.error('[aiprint] push failed:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  const enabled = Object.values(providers).filter((p) => p.enabled(process.env)).map((p) => p.id);
  console.log(`[aiprint] server on http://localhost:${PORT}`);
  console.log(`[aiprint] enabled providers: ${enabled.length ? enabled.join(', ') : '(none - set API keys in .env)'}`);
});
