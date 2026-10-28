// Headless slicing with OrcaSlicer for Bambu Lab P2S.
// Produces real G-code or a sliced 3MF project by driving the OrcaSlicer CLI
// with the app's bundled Bambu P2S presets (machine + process + filament).

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const CANDIDATE_BINS = [
  process.env.ORCASLICER_BIN,
  '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
  'orca-slicer',
  'OrcaSlicer',
].filter(Boolean);

export function detectOrca() {
  for (const b of CANDIDATE_BINS) {
    if (b.includes('/') && fs.existsSync(b)) return b;
    // PATH lookup for bare names
    if (!b.includes('/')) {
      const found = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, b)).find((p) => fs.existsSync(p));
      if (found) return found;
    }
  }
  return null;
}

function profilesRoot(bin) {
  if (process.env.ORCA_PROFILES_DIR && fs.existsSync(process.env.ORCA_PROFILES_DIR)) return process.env.ORCA_PROFILES_DIR;
  // .../OrcaSlicer.app/Contents/MacOS/OrcaSlicer -> .../Contents/Resources/profiles/BBL
  const resolved = fs.realpathSync(bin);
  const contents = path.resolve(resolved, '..', '..'); // Contents
  const bbl = path.join(contents, 'Resources', 'profiles', 'BBL');
  if (fs.existsSync(bbl)) return bbl;
  throw new Error('Bambu profiles not found next to OrcaSlicer binary. Set ORCA_PROFILES_DIR.');
}

// Pick the newest available variant: "<name> @BBL P2S 0.4 nozzle.json" -> "... @BBL P2S.json" -> bare "<name>.json".
function pickFile(dir, patterns) {
  for (const p of patterns) {
    const full = path.join(dir, p);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function resolveMachine(dir, printer, nozzle) {
  return pickFile(path.join(dir, 'machine'), [`${printer} ${nozzle} nozzle.json`, `${printer}.json`]);
}

// Nozzle-specific layer profiles are named "@BBL P2S 0.6 nozzle.json"; the default 0.4
// nozzle profiles carry no suffix ("@BBL P2S.json"). Try the nozzle-specific file first,
// then fall back to the default (0.4) profile.
function resolveProcess(dir, printerTag, quality, nozzle) {
  const cands = [
    `${quality} @${printerTag} ${nozzle} nozzle.json`, // e.g. "0.16mm Balanced Quality @BBL P2S 0.6 nozzle.json"
    `${quality} @${printerTag}.json`,                   // e.g. "0.20mm Standard @BBL P2S.json" (0.4 default)
  ];
  const f = pickFile(path.join(dir, 'process'), cands);
  if (f) return f;
  throw new Error(`找不到切片层高预设：${quality} @${printerTag} ${nozzle} nozzle`);
}

function resolveFilament(dir, printerTag, material, nozzle) {
  const files = fs.readdirSync(path.join(dir, 'filament'));
  // Prefer an exact material + nozzle variant, else the default (no nozzle suffix), else any matching material.
  const bySuffix = (sfx) => files.find((n) => n.startsWith(material) && n.endsWith(sfx));
  const pick =
    bySuffix(`@${printerTag} ${nozzle} nozzle.json`) ||
    bySuffix(`@${printerTag}.json`) ||
    files.find((n) => n.startsWith(material));
  if (!pick) throw new Error(`找不到耗材预设：${material} @${printerTag}`);
  return path.join(dir, 'filament', pick);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scan the bundled presets and return, per nozzle, the valid layer-height profiles.
// This keeps the UI dropdowns in sync with what the slicer can actually resolve.
export function listSliceOptions(opts = {}) {
  const bin = detectOrca();
  if (!bin) return null;
  let dir;
  try {
    dir = profilesRoot(bin);
  } catch {
    return null;
  }
  const printer = opts.printer || 'Bambu Lab P2S';
  const printerTag = opts.printerTag || 'BBL P2S';

  // Nozzles come from the machine profiles: "<printer> 0.4 nozzle.json".
  const prefix = `${printer} `;
  const nozzles = fs
    .readdirSync(path.join(dir, 'machine'))
    .filter((n) => n.startsWith(prefix) && n.endsWith(' nozzle.json'))
    .map((n) => n.slice(prefix.length, n.length - ' nozzle.json'.length))
    .sort((a, b) => Number(a) - Number(b));

  // Map nozzle -> [quality], default (0.4) nozzle profiles are the suffix-less ones.
  const DEFAULT_NOZZLE = '0.4';
  const qualityByNozzle = Object.fromEntries(nozzles.map((nz) => [nz, []]));
  const re = new RegExp(`^(.+) @${escapeRe(printerTag)}(?: (\\d+(?:\\.\\d+)?) nozzle)?\\.json$`);
  for (const name of fs.readdirSync(path.join(dir, 'process'))) {
    const m = name.match(re);
    if (!m) continue;
    const quality = m[1];
    const nz = m[2] || DEFAULT_NOZZLE; // suffix-less file belongs to the default nozzle
    if (qualityByNozzle[nz]) {
      if (!qualityByNozzle[nz].includes(quality)) qualityByNozzle[nz].push(quality);
    }
  }
  for (const nz of Object.keys(qualityByNozzle)) {
    qualityByNozzle[nz].sort((a, b) => parseFloat(a) - parseFloat(b));
  }

  // Available materials (strip the "@..." suffix, dedupe, drop base templates / stray files).
  const rawMaterials = fs.readdirSync(path.join(dir, 'filament')).map((n) => n.replace(/ @.*$/, ''));
  const materials = [...new Set(rawMaterials)].filter((n) => n && !n.endsWith('.json') && !n.startsWith('fdm_') && n !== 'filaments_color_codes').sort();

  return {
    printer,
    nozzles,
    qualityByNozzle,
    materials,
    defaultNozzle: nozzles.includes(DEFAULT_NOZZLE) ? DEFAULT_NOZZLE : nozzles[0],
    defaultQuality: '0.20mm Standard',
    defaultMaterial: 'Bambu PLA Basic',
  };
}

// printerId: "Bambu Lab P2S", printerTag: "BBL P2S"
function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd });
    let err = '';
    child.stdout.on('data', () => {}); // slice logs are verbose; ignore
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`OrcaSlicer 退出码 ${code}: ${err.slice(-800) || '(无错误输出)'}`));
    });
  });
}

// Slice an STL to G-code and/or a 3MF project. Returns produced file paths.
export async function slice(stlPath, outDir, opts = {}) {
  const bin = detectOrca();
  if (!bin) throw new Error('未找到 OrcaSlicer，请安装或设置 ORCASLICER_BIN。');
  const dir = profilesRoot(bin);
  const printer = opts.printer || 'Bambu Lab P2S';
  const printerTag = opts.printerTag || 'BBL P2S';
  const nozzle = opts.nozzle || '0.4';
  const quality = opts.quality || '0.20mm Standard';

  // AMS has 4 tray slots. `materials` is the per-slot list (up to 4 names, blanks = empty tray).
  // `activeMaterial` (or legacy `material`) is the filament the model actually prints with.
  const slots = (Array.isArray(opts.materials) ? opts.materials : []).map((m) => String(m || '').trim()).filter(Boolean);
  const active = String(opts.activeMaterial || opts.material || slots[0] || 'Bambu PLA Basic').trim();
  // G-code (real print): load only the active filament so the plate stays single-material.
  // 3MF project: carry the chosen filament first, then the other loaded slots, for AMS mapping.
  const filamentNames = opts.format === '3mf' ? [active, ...slots.filter((m) => m !== active)] : [active];
  const filamentFiles = [...new Set(filamentNames)].map((m) => resolveFilament(dir, printerTag, m, nozzle));

  fs.mkdirSync(outDir, { recursive: true });
  const settings = [resolveMachine(dir, printer, nozzle), resolveProcess(dir, printerTag, quality, nozzle)];
  const args = [
    stlPath,
    '--load-settings', settings.join(';'),
    '--load-filaments', filamentFiles.join(';'),
    '--assemble',
    '--outputdir', outDir,
    '--slice', '0',
  ];
  if (opts.format === '3mf') {
    // OrcaSlicer resolves --export-3mf relative to --outputdir; pass only the filename.
    args.push('--export-3mf', 'aiprint.3mf');
  }
  await run(bin, args, outDir);

  const result = { dir: outDir, slice: { printer, nozzle, quality, material: active, slots } };
  if (opts.format === '3mf') {
    result.output = path.join(outDir, 'aiprint.3mf');
  } else {
    // --slice writes plate_1.gcode (single plate after --assemble)
    const g = path.join(outDir, 'plate_1.gcode');
    if (!fs.existsSync(g)) throw new Error('切片未生成 plate_1.gcode');
    result.output = g;
  }
  return result;
}

export function orcaVersion(bin) {
  const b = bin || detectOrca();
  if (!b) return null;
  return 'OrcaSlicer (headless)';
}
