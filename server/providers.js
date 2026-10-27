// Provider clients for image-to-3D generation.
// Each provider exposes:
//   createTask(cfg, payload) -> { provider, taskId, raw }
//   getTask(cfg, taskId) -> { status, progress, models: {format: url}, previewUrl, creditsUsed, error, raw }
// status is normalized to: QUEUED | IN_PROGRESS | SUCCEEDED | FAILED

const MESHY_BASE = 'https://api.meshy.ai/openapi/v1';
const TRIPO_BASE = 'https://openapi.tripo3d.ai/v3';

function requireKey(provider, key) {
  if (!key) {
    const err = new Error(`${provider} API key is not configured. Set ${provider.toUpperCase()}_API_KEY in .env`);
    err.code = 'MISSING_KEY';
    throw err;
  }
  return key;
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.detail)) || `HTTP ${res.status}`;
    const err = new Error(`${url} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.detail)) || `HTTP ${res.status}`;
    const err = new Error(`${url} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Normalize common status strings across providers.
function normStatus(s) {
  const v = String(s || '').toUpperCase();
  if (['SUCCEEDED', 'SUCCESS', 'COMPLETED'].includes(v)) return 'SUCCEEDED';
  if (['FAILED', 'CANCELED', 'CANCELLED'].includes(v)) return 'FAILED';
  if (['IN_PROGRESS', 'PROCESSING', 'RUNNING'].includes(v)) return 'IN_PROGRESS';
  return 'QUEUED';
}

// ---------------- Meshy ----------------
const meshy = {
  id: 'meshy',
  name: 'Meshy',
  formats: ['glb', 'stl', '3mf'],
  enabled: (cfg) => !!cfg.MESHY_API_KEY,

  async createTask(cfg, { imageDataUri, options = {} }) {
    const key = requireKey('meshy', cfg.MESHY_API_KEY);
    if (!imageDataUri) throw new Error('Meshy needs an image (base64 data URI).');
    const body = {
      image_url: imageDataUri,
      should_texture: options.texture !== false,
      target_formats: ['glb', 'stl', '3mf'],
      pose_mode: options.pose_mode || '',
    };
    // image_enhancement is only valid on meshy-6 / 7.1 / latest; 6-lite and smart-topology reject it.
    if (options.aiModel !== 'meshy-6-lite') body.image_enhancement = options.imageEnhancement !== false;
    if (options.aiModel) body.ai_model = options.aiModel;
    if (options.geometryResolution) body.geometry_resolution = options.geometryResolution;
    if (options.targetPolycount) body.target_polycount = options.targetPolycount;
    const json = await postJson(`${MESHY_BASE}/image-to-3d`, { Authorization: `Bearer ${key}` }, body);
    return { provider: 'meshy', taskId: json.result, raw: json };
  },

  // Cheap look-only iteration: re-tint / re-text an already-generated model (keeps geometry).
  async retexture(cfg, { inputTaskId, texturePrompt, textureImageDataUri, options = {} }) {
    const key = requireKey('meshy', cfg.MESHY_API_KEY);
    if (!inputTaskId) throw new Error('Retexture needs a previous successful task to reuse.');
    const body = {
      input_task_id: inputTaskId,
      enable_pbr: !!options.pbr,
    };
    if (texturePrompt) body.text_style_prompt = texturePrompt;
    else if (textureImageDataUri) body.image_style_url = textureImageDataUri;
    else throw new Error('Retexture needs a style prompt or a style image.');
    if (options.aiModel) body.ai_model = options.aiModel;
    if (options.textureResolution) body.texture_resolution = options.textureResolution;
    const json = await postJson(`${MESHY_BASE}/retexture`, { Authorization: `Bearer ${key}` }, body);
    return { provider: 'meshy', taskId: json.result, raw: json };
  },

  async getTask(cfg, taskId, kind = 'image-to-3d') {
    const key = requireKey('meshy', cfg.MESHY_API_KEY);
    const json = await getJson(`${MESHY_BASE}/${kind}/${taskId}`, { Authorization: `Bearer ${key}` });
    const urls = json.model_urls || {};
    const models = {};
    for (const fmt of ['glb', 'obj', 'stl', '3mf', 'fbx', 'usdz']) {
      if (urls[fmt]) models[fmt] = urls[fmt];
    }
    return {
      status: normStatus(json.status),
      progress: json.progress ?? 0,
      models,
      previewUrl: json.thumbnail_url || null,
      creditsUsed: json.consumed_credits ?? null,
      error: json.task_error && json.task_error.message ? json.task_error.message : null,
      raw: json,
    };
  },
};

// ---------------- Tripo ----------------
const tripo = {
  id: 'tripo',
  name: 'Tripo',
  formats: ['glb'],
  enabled: (cfg) => !!cfg.TRIPO_API_KEY,

  // Tripo takes a file_token or a public URL, not a base64 body. Upload the image first.
  async uploadImage(cfg, { imageBuffer, imageMime }) {
    const key = requireKey('tripo', cfg.TRIPO_API_KEY);
    if (!imageBuffer) throw new Error('Tripo needs an image file to upload.');
    const ext = (imageMime || 'image/png').split('/')[1] || 'png';
    const form = new FormData();
    const blob = new Blob([imageBuffer], { type: imageMime || 'image/png' });
    form.append('file', blob, 'input.' + ext);
    const res = await fetch(`${TRIPO_BASE}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = (json && (json.message || json.msg)) || `HTTP ${res.status}`;
      const err = new Error(`Tripo upload -> ${res.status}: ${msg}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    const token = json?.data?.file_token || json?.data?.token || json?.data?.image_token;
    if (!token) throw new Error('Tripo upload returned no file_token: ' + text.slice(0, 200));
    return token;
  },

  async createTask(cfg, { imageBuffer, imageMime, imageUrl, options = {} }) {
    const key = requireKey('tripo', cfg.TRIPO_API_KEY);
    const input = imageUrl || (await this.uploadImage(cfg, { imageBuffer, imageMime }));
    const body = {
      input,
      texture: options.texture !== false,
      model: options.model || 'v3.1-20260211',
    };
    if (options.faceLimit) body.face_limit = options.faceLimit;
    const json = await postJson(`${TRIPO_BASE}/generation/image-to-model`, { Authorization: `Bearer ${key}` }, body);
    return { provider: 'tripo', taskId: json.data.task_id, raw: json };
  },

  async getTask(cfg, taskId) {
    const key = requireKey('tripo', cfg.TRIPO_API_KEY);
    const json = await getJson(`${TRIPO_BASE}/tasks/${taskId}`, { Authorization: `Bearer ${key}` });
    const data = json.data || {};
    const out = data.output || {};
    const models = {};
    const modelUrl = out.model_url || (out.model_urls && (out.model_urls.glb || Object.values(out.model_urls)[0]));
    if (modelUrl) models.glb = modelUrl;
    return {
      status: normStatus(data.status),
      progress: data.progress ?? 0,
      models,
      previewUrl: out.rendered_image_url || (out.rendered_image_urls && out.rendered_image_urls.front) || null,
      creditsUsed: null,
      error: data.error || null,
      raw: json,
    };
  },
};

export const providers = { meshy, tripo };
export function getProvider(id) {
  const p = providers[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
