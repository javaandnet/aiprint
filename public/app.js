const el = (id) => document.getElementById(id);
let providers = [];
let selectedFile = null;
let pollTimer = null;
let currentMode = 'final';
// last successful generation, used by 换皮(Retexture)
let lastSuccess = null; // { jobId, provider }

const PROVIDER_HINT = {
  meshy: '约 30 credits/个，原生输出 STL + 3MF',
  tripo: '约 $0.30/个，输出 GLB（Bambu Studio 可直接导入）',
};

const MODE_HINT = {
  draft: '先试形状，无贴图最便宜：Meshy ~5c / Tripo ~$0.2。不满意就反复改这一档。',
  final: '完整带贴图终稿：Meshy ~30c / Tripo ~$0.3。形状在草稿档调好后再跑这里。',
  retexture: '只换配色/贴皮，不重造形状（仅 Meshy，~10c）。需先成功生成过一次。',
};

async function loadProviders() {
  const res = await fetch('/api/providers');
  const { data } = await res.json();
  providers = data.providers || [];
  const sel = el('provider');
  sel.innerHTML = '';
  if (!providers.length) {
    sel.innerHTML = '<option value="">（未配置引擎，请设置 .env 密钥）</option>';
    el('go').disabled = true;
    el('providerHint').textContent = '请先在 .env 配置 MESHY_API_KEY 或 TRIPO_API_KEY';
    return;
  }
  for (const p of providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  updateHints();
}

function currentProvider() { return el('provider').value; }

function updateHints() {
  el('providerHint').textContent = PROVIDER_HINT[currentProvider()] || '';
  let hint = MODE_HINT[currentMode] || '';
  if (currentMode === 'retexture' && currentProvider() !== 'meshy') {
    hint = '换皮目前仅 Meshy 支持，请切到 Meshy 或改用其他模式。';
  } else if (currentMode === 'retexture' && !lastSuccess) {
    hint = '还没有可换皮的模型：请先用「草稿」或「终稿」成功生成一次。';
  }
  el('modeHint').textContent = hint;
}

// ---- mode segmented control ----
document.querySelectorAll('#mode .seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#mode .seg').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    el('retextureRow').hidden = currentMode !== 'retexture';
    // geometry / polycount only matter for the final pass
    const opts = el('geometry');
    if (opts) opts.disabled = currentMode !== 'final';
    updateHints();
  });
});

// ---- file picker / drag-drop ----
const drop = el('drop');
drop.addEventListener('click', () => el('file').click());
el('file').addEventListener('change', (e) => setFile(e.target.files[0]));
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

function setFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  selectedFile = file;
  const url = URL.createObjectURL(file);
  const t = el('thumb');
  t.src = url;
  t.hidden = false;
  drop.querySelector('p').textContent = file.name;
}

// ---- generate ----
el('provider').addEventListener('change', updateHints);
el('go').addEventListener('click', async () => {
  const isRetexture = currentMode === 'retexture';

  if (isRetexture) {
    const prompt = el('texturePrompt').value.trim();
    if (!selectedFile && !prompt) { showError('换皮请填风格描述，或选一张风格参考图。'); return; }
    if (currentProvider() !== 'meshy') { showError('换皮目前仅支持 Meshy。'); return; }
    if (!lastSuccess) { showError('还没有可换皮的模型，请先生成一次。'); return; }
  } else if (!selectedFile) {
    showError('请先选择一张漫画图片。'); return;
  }

  reset();
  el('go').disabled = true;
  el('status').hidden = false;
  setStatus(isRetexture ? '提交换皮…' : '提交任务…', 3);

  try {
    const fd = new FormData();
    fd.append('provider', currentProvider());
    fd.append('mode', currentMode);
    if (selectedFile) fd.append('image', selectedFile);
    if (isRetexture) {
      fd.append('source_job_id', lastSuccess.jobId);
      fd.append('texture_prompt', el('texturePrompt').value.trim());
    } else if (currentMode === 'final') {
      const geo = el('geometry').value;
      if (geo) fd.append('geometry_resolution', geo);
      const poly = el('polycount').value;
      if (poly) fd.append('target_polycount', poly);
    }

    const res = await fetch('/api/generate', { method: 'POST', body: fd });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '创建任务失败');
    startPolling(json.data.jobId, json.data.mode);
  } catch (err) {
    showError(err.message);
    el('go').disabled = false;
    el('status').hidden = true;
  }
});

function setStatus(text, pct) {
  el('statusText').textContent = text;
  el('bar').style.width = (pct || 0) + '%';
}
function showError(msg) {
  el('error').hidden = false;
  el('error').textContent = '⚠ ' + msg;
}
function reset() {
  el('error').hidden = true;
  el('result').hidden = true;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function startPolling(jobId, mode) {
  const tick = async () => {
    try {
      const res = await fetch('/api/jobs/' + jobId);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      const d = json.data;
      if (d.status === 'SUCCEEDED') {
        setStatus('完成', 100);
        el('status').hidden = true;
        el('go').disabled = false;
        renderResult(d, mode);
        return;
      }
      if (d.status === 'FAILED') throw new Error(d.error || '生成失败');
      setStatus(d.status === 'IN_PROGRESS' ? `生成中… ${d.progress || 0}%` : '排队中…', Math.max(5, (d.progress || 0) * 0.9));
      pollTimer = setTimeout(tick, 2500);
    } catch (err) {
      showError(err.message);
      el('go').disabled = false;
      el('status').hidden = true;
    }
  };
  pollTimer = setTimeout(tick, 1500);
}

const FMT_LABEL = { '3mf': '3MF（推荐·含模型）', stl: 'STL', glb: 'GLB（可预览）', obj: 'OBJ' };

function renderResult(d, mode) {
  el('result').hidden = false;

  // remember the successful model so 换皮 can reuse it (retexture output is itself reusable too)
  lastSuccess = { jobId: d.jobId, provider: d.provider };
  el('slicePanel').hidden = false;
  el('sliceOut').innerHTML = '';

  const preview = el('preview');
  preview.innerHTML = '';
  if (d.previewUrl) {
    const img = document.createElement('img');
    img.src = d.previewUrl;
    img.alt = '3D 预览';
    preview.appendChild(img);
  } else {
    preview.appendChild(Object.assign(document.createElement('span'), { className: 'hint', textContent: '无预览图（草稿档不产贴图），下载 STL 后在切片软件查看。' }));
  }

  const dl = el('downloads');
  dl.innerHTML = '';
  const order = ['3mf', 'stl', 'glb', 'obj'].filter((f) => d.models && d.models[f]);
  for (const fmt of order) {
    const a = document.createElement('a');
    a.href = `/api/jobs/${d.jobId}/download?format=${fmt}`;
    a.textContent = '下载 ' + (FMT_LABEL[fmt] || fmt.toUpperCase());
    if (fmt === '3mf' || (fmt === 'glb' && !d.models['3mf'] && !d.models.stl)) a.className = 'rec';
    dl.appendChild(a);
  }

  const cost = el('cost');
  const modeTag = mode ? `（${mode === 'draft' ? '草稿' : mode === 'retexture' ? '换皮' : '终稿'}）` : '';
  cost.textContent = d.creditsUsed ? `本次消耗 ${d.creditsUsed} credits ${modeTag}` : `已生成 ${modeTag}`;
  updateHints();
  el('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

loadProviders();

// ---- slicing (OrcaSlicer) ----
let lastSliceId = null;

async function checkSlicer() {
  try {
    const res = await fetch('/api/slicer');
    const { data } = await res.json();
    if (!data.available) {
      el('slicerHint').textContent = '未检测到本机 OrcaSlicer：安装后刷新页面即可自动切片（brew install --cask orcaslicer）。';
      ['sliceGcode', 'slice3mf', 'slicePush'].forEach((id) => (el(id).disabled = true));
    } else {
      el('slicerHint').textContent = '已检测到 ' + data.printer + ' 切片环境，可直接出 G-code / 3MF 或局域网推送。';
    }
  } catch { /* ignore */ }
}

function setSlicing(on, text) {
  el('sliceStatus').hidden = !on;
  el('sliceStatusText').textContent = on ? text : '';
  el('sliceBar').style.width = on ? '60%' : '0';
  ['sliceGcode', 'slice3mf', 'slicePush'].forEach((id) => (el(id).disabled = on));
}

async function doSlice(format) {
  if (!lastSuccess) { el('sliceOut').textContent = '请先生成一个模型。'; return; }
  setSlicing(true, format === '3mf' ? '切片为 3MF 中（OrcaSlicer，十几秒到几分钟）…' : '切片为 G-code 中（OrcaSlicer，十几秒到几分钟）…');
  el('sliceOut').innerHTML = '';
  try {
    const res = await fetch('/api/slice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: lastSuccess.jobId,
        format,
        targetMM: Number(el('sizeMM').value) || 60,
        nozzle: el('nozzle').value,
        quality: el('quality').value,
        material: el('material').value,
      }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    lastSliceId = json.data.sliceId;
    const s = json.data.slice;
    el('sliceOut').innerHTML = '';
    const a = document.createElement('a');
    a.href = `/api/slice/${lastSliceId}/download`;
    a.textContent = '下载 ' + json.data.filename;
    a.setAttribute('download', '');
    el('sliceOut').appendChild(a);
    if (!json.data.scaled) el('sliceOut').append('（非 STL 来源，未自动缩放）');
    return json.data;
  } catch (err) {
    showError('切片失败：' + err.message);
  } finally {
    setSlicing(false);
  }
}

el('sliceGcode').addEventListener('click', () => doSlice('gcode'));
el('slice3mf').addEventListener('click', () => doSlice('3mf'));

el('slicePush').addEventListener('click', async () => {
  // First click reveals the LAN form; if already shown, run push.
  if (el('lanForm').hidden) { el('lanForm').hidden = false; el('slicePush').textContent = '确认推送到 P2S'; return; }
  const ip = el('lanIp').value.trim();
  const accessCode = el('lanCode').value.trim();
  const serial = el('lanSerial').value.trim();
  if (!ip || !accessCode || !serial) { showError('请填写打印机 IP、Access Code、序列号。'); return; }
  // Ensure we have a gcode slice first.
  let sliceId = lastSliceId;
  const needFresh = !sliceId;
  if (needFresh) { const d = await doSlice('gcode'); if (!d) return; sliceId = d.sliceId; }
  setSlicing(true, '上传并推送到打印机中…');
  try {
    const res = await fetch(`/api/slice/${sliceId}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, accessCode, serial, autoStart: true }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    el('sliceOut').innerHTML = '';
    const div = document.createElement('div');
    div.className = 'pushlog';
    div.textContent = (json.data.logs || []).join('\n');
    el('sliceOut').appendChild(div);
  } catch (err) {
    showError('推送失败：' + err.message);
  } finally {
    setSlicing(false);
  }
});

checkSlicer();
