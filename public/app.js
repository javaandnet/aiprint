const el = (id) => document.getElementById(id);
let providers = [];
let selectedFile = null;
let pollTimer = null;

const PROVIDER_HINT = {
  meshy: '约 30 credits/个，原生输出 STL + 3MF',
  tripo: '约 $0.30/个，输出 GLB（Bambu Studio 可直接导入）',
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
  updateHint();
}

function updateHint() {
  el('providerHint').textContent = PROVIDER_HINT[el('provider').value] || '';
}

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
el('provider').addEventListener('change', updateHint);
el('go').addEventListener('click', async () => {
  if (!selectedFile) { showError('请先选择一张漫画图片。'); return; }
  reset();
  el('go').disabled = true;
  el('status').hidden = false;
  setStatus('提交任务…', 3);
  try {
    const fd = new FormData();
    fd.append('image', selectedFile);
    fd.append('provider', el('provider').value);
    fd.append('texture', el('texture').checked ? 'true' : 'false');
    const geo = el('geometry').value;
    if (geo) fd.append('geometry_resolution', geo);
    const poly = el('polycount').value;
    if (poly) fd.append('target_polycount', poly);

    const res = await fetch('/api/generate', { method: 'POST', body: fd });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || '创建任务失败');
    startPolling(json.data.jobId);
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

function startPolling(jobId) {
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
        renderResult(d);
        return;
      }
      if (d.status === 'FAILED') {
        throw new Error(d.error || '生成失败');
      }
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

function renderResult(d) {
  el('result').hidden = false;
  const preview = el('preview');
  preview.innerHTML = '';
  if (d.previewUrl) {
    const img = document.createElement('img');
    img.src = d.previewUrl;
    img.alt = '3D 预览';
    preview.appendChild(img);
  } else {
    preview.innerHTML = '<span class="hint">无预览图，下载后用 GLB 查看。</span>';
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

  el('cost').textContent = d.creditsUsed ? `本次消耗 ${d.creditsUsed} credits` : '';
  el('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

loadProviders();
