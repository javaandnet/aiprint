// Dependency-free STL utilities: read (binary + ASCII), compute bbox,
// uniformly scale to a target size (mm), sit the model flat on Z=0 and center it in XY.
// STL is unit-agnostic here: we scale by the ratio targetHeight / currentHeight and treat units as mm.

export function readStl(buf) {
  // ASCII if it starts with "solid" AND contains "facet"; otherwise binary.
  const head = buf.slice(0, Math.min(512, buf.length)).toString('ascii');
  if (head.trimStart().startsWith('solid') && head.includes('facet')) {
    return readAscii(buf);
  }
  return readBinary(buf);
}

function readBinary(buf) {
  // 80-byte header, uint32 count, then per-triangle: 12 floats + uint16.
  const tris = [];
  const count = buf.readUInt32LE(80);
  let off = 84;
  for (let i = 0; i < count; i++) {
    // normal at off..off+12 (we recompute not needed), vertices next
    const v = [
      [buf.readFloatLE(off + 12), buf.readFloatLE(off + 16), buf.readFloatLE(off + 20)],
      [buf.readFloatLE(off + 24), buf.readFloatLE(off + 28), buf.readFloatLE(off + 32)],
      [buf.readFloatLE(off + 36), buf.readFloatLE(off + 40), buf.readFloatLE(off + 44)],
    ];
    tris.push(v);
    off += 50;
  }
  return tris;
}

function readAscii(buf) {
  const tris = [];
  const text = buf.toString('ascii');
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  const pts = [];
  while ((m = re.exec(text))) pts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  for (let i = 0; i + 2 < pts.length; i += 3) tris.push([pts[i], pts[i + 1], pts[i + 2]]);
  return tris;
}

export function bbox(tris) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const p of t) {
      for (let a = 0; a < 3; a++) {
        if (p[a] < min[a]) min[a] = p[a];
        if (p[a] > max[a]) max[a] = p[a];
      }
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// Scale uniformly so the chosen axis (default Z, height) equals targetMM, then drop base to 0 and center XY.
export function normalize(tris, { targetMM = 80, axis = 2 } = {}) {
  const bb = bbox(tris);
  const cur = bb.size[axis];
  const scale = cur > 0 ? targetMM / cur : 1;
  const cx = (bb.min[0] + bb.max[0]) / 2;
  const cy = (bb.min[1] + bb.max[1]) / 2;
  const out = [];
  for (const t of tris) {
    out.push(t.map((p) => [
      (p[0] - cx) * scale,
      (p[1] - cy) * scale,
      (p[2] - bb.min[2]) * scale, // base sits at z=0
    ]));
  }
  return { tris: out, scale, bbox: bbox(out) };
}

function normalOf(t) {
  const ax = t[1][0] - t[0][0], ay = t[1][1] - t[0][1], az = t[1][2] - t[0][2];
  const bx = t[2][0] - t[0][0], by = t[2][1] - t[0][1], bz = t[2][2] - t[0][2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

export function writeBinaryStl(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let off = 84;
  for (const t of tris) {
    const n = normalOf(t);
    buf.writeFloatLE(n[0], off); buf.writeFloatLE(n[1], off + 4); buf.writeFloatLE(n[2], off + 8);
    for (let i = 0; i < 3; i++) {
      buf.writeFloatLE(t[i][0], off + 12 + i * 12);
      buf.writeFloatLE(t[i][1], off + 16 + i * 12);
      buf.writeFloatLE(t[i][2], off + 20 + i * 12);
    }
    buf.writeUInt16LE(0, off + 48);
    off += 50;
  }
  return buf;
}
