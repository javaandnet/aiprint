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

// Layer profiles for the default 0.4 nozzle are named "@BBL P2S.json"; other nozzles carry the suffix.
function resolveProcess(dir, printerTag, quality) {
  const cands = [
    `${quality} @${printerTag} nozzle.json`, // e.g. "0.16mm High Quality @BBL P2S 0.6 nozzle.json"
    `${quality} @${printerTag}.json`,         // e.g. "0.20mm Standard @BBL P2S.json" (0.4 default)
  ];
  const f = pickFile(path.join(dir, 'process'), cands);
  if (f) return f;
  throw new Error(`找不到切片层高预设：${quality} @${printerTag}`);
}

function resolveFilament(dir, printerTag, material) {
  const files = fs.readdirSync(path.join(dir, 'filament'));
  // Prefer an exact material + nozzle variant, else the default (no nozzle suffix), else any matching material.
  const bySuffix = (sfx) => files.find((n) => n.startsWith(material) && n.endsWith(sfx));
  const pick = bySuffix(`@${printerTag} nozzle.json`) || bySuffix(`@${printerTag}.json`) || files.find((n) => n.startsWith(material));
  if (!pick) throw new Error(`找不到耗材预设：${material} @${printerTag}`);
  return path.join(dir, 'filament', pick);
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
  const material = opts.material || 'Bambu PLA Basic';

  fs.mkdirSync(outDir, { recursive: true });
  const settings = [resolveMachine(dir, printer, nozzle), resolveProcess(dir, printerTag, quality)];
  const args = [
    stlPath,
    '--load-settings', settings.join(';'),
    '--load-filaments', resolveFilament(dir, printerTag, material),
    '--assemble',
    '--outputdir', outDir,
    '--slice', '0',
  ];
  if (opts.format === '3mf') {
    // OrcaSlicer resolves --export-3mf relative to --outputdir; pass only the filename.
    args.push('--export-3mf', 'aiprint.3mf');
  }
  await run(bin, args, outDir);

  const result = { dir: outDir, slice: { printer, nozzle, quality, material } };
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
