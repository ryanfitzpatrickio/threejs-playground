// Diagnostic: parse horse-rigged.glb directly (no mesh decode) to confirm the
// front-leg bone chain, the rest length axis of each bone (used for twist-swing
// decomposition), and the actual knee bend axis/direction sampled from the
// Walk/Run/Idle rotation tracks. This validates the swing-inversion rewrite.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const GLB = path.resolve('public/assets/models/horse-rigged.glb');
const buf = readFileSync(GLB);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);

// --- GLB container ---------------------------------------------------------
let p = 12; // skip 12-byte header (magic, version, length)
const chunks = {};
while (p < ab.byteLength) {
  const len = dv.getUint32(p, true); p += 4;
  const type = dv.getUint32(p, true); p += 4;
  const data = new Uint8Array(ab, p, len);
  const tag = type === 0x4e4f534a ? 'json' : type === 0x004e4942 ? 'bin' : `chunk_${type}`;
  chunks[tag] = data;
  p += len;
  p = Math.ceil(p / 4) * 4; // chunk padding
}
if (!chunks.json || !chunks.bin) {
  console.error('Expected JSON + BIN chunks; got:', Object.keys(chunks));
  process.exit(1);
}
const gltf = JSON.parse(new TextDecoder().decode(chunks.json));
const binDv = new DataView(
  chunks.bin.buffer,
  chunks.bin.byteOffset,
  chunks.bin.byteLength,
);

// --- Accessor reader -------------------------------------------------------
const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMP_GET = {
  5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16',
  5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32',
};
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(idx) {
  const a = gltf.accessors[idx];
  const bv = gltf.bufferViews[a.bufferView];
  const size = COMP_SIZE[a.componentType];
  const n = TYPE_N[a.type];
  const stride = bv.byteStride ?? 0;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const getter = COMP_GET[a.componentType];
  const rows = [];
  for (let i = 0; i < a.count; i++) {
    const rowOff = base + i * (stride || size * n);
    const row = [];
    for (let j = 0; j < n; j++) {
      row.push(binDv[getter](rowOff + j * size, true));
    }
    rows.push(row);
  }
  return { count: a.count, n, rows };
}

// --- Node graph ------------------------------------------------------------
const nodes = gltf.nodes ?? [];
const parentOf = new Array(nodes.length).fill(-1);
for (let i = 0; i < nodes.length; i++) {
  for (const c of nodes[i]?.children ?? []) parentOf[c] = i;
}
const nameOf = (i) => nodes[i]?.name ?? `node_${i}`;
const isFront = (name) => /front/i.test(name ?? '');
const frontIdx = nodes
  .map((n, i) => ({ n, i }))
  .filter(({ n }) => isFront(n?.name))
  .map(({ i }) => i);

const vec = (arr) => arr && Array.isArray(arr) ? new THREE.Vector3(arr[0], arr[1], arr[2]) : null;
const quat = (arr) => arr && Array.isArray(arr) ? new THREE.Quaternion(arr[0], arr[1], arr[2], arr[3]) : null;

console.log(`\n=== ${nodes.length} nodes; ${frontIdx.length} match /front/i ===\n`);
console.log('Front-leg bone chain (name | parent | translation | rest length axis from first child):');
for (const i of frontIdx) {
  const node = nodes[i];
  const childIdx = (node.children ?? [])[0];
  const childT = childIdx != null ? vec(nodes[childIdx]?.translation) : null;
  const axis = childT && childT.lengthSq() > 1e-9 ? childT.clone().normalize() : null;
  const t = vec(node.translation);
  const fmt = (v) => v ? `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]` : '—';
  console.log(
    `  ${node.name.padEnd(26)} parent=${(parentOf[i] >= 0 ? nameOf(parentOf[i]) : '—').padEnd(22)} ` +
    `T=${fmt(t)} axis=${fmt(axis)}`,
  );
}

// --- Knee bend from animation tracks ---------------------------------------
// For each front-leg LOWER node with a rotation track, decompose each keyframe
// relative to its static rest rotation into swing (bend) about the rest length
// axis and report the hinge axis + angle range.
const lowerIdx = frontIdx.filter((i) => /lower|knee|carp|cannon/i.test(nodes[i]?.name ?? ''));
console.log(`\n=== Knee candidate nodes (/${'lower|knee|carp|cannon'}/i): ${lowerIdx.map(nameOf).join(', ') || 'none'} ===`);

const anims = gltf.animations ?? [];
console.log(`\n=== ${anims.length} animations; sampling rotation tracks on knee candidates ===`);
for (const anim of anims) {
  for (const ch of anim.channels ?? []) {
    const tgt = ch.target;
    if (tgt.path !== 'rotation') continue;
    if (!lowerIdx.includes(tgt.node)) continue;
    const sampler = anim.samplers[ch.sampler];
    const out = readAccessor(sampler.output);
    const rest = quat(nodes[tgt.node]?.rotation) ?? new THREE.Quaternion();
    const restInv = rest.clone().invert();
    // length axis from first child translation
    const childIdx = (nodes[tgt.node].children ?? [])[0];
    const childT = childIdx != null ? vec(nodes[childIdx]?.translation) : null;
    if (!childT || childT.lengthSq() <= 1e-9) continue;
    const n = childT.clone().normalize();

    const swingAxes = [];
    let minA = Infinity, maxA = -Infinity;
    for (const row of out.rows) {
      const q = new THREE.Quaternion(row[0], row[1], row[2], row[3]).normalize();
      const delta = restInv.clone().multiply(q); // rest^-1 * q
      const rotated = n.clone().applyQuaternion(delta);
      const swing = new THREE.Quaternion().setFromUnitVectors(n, rotated);
      const ang = swing.angleTo(new THREE.Quaternion()); // identity
      if (Number.isFinite(ang)) {
        minA = Math.min(minA, ang);
        maxA = Math.max(maxA, ang);
        const ax = new THREE.Vector3(swing.x, swing.y, swing.z);
        if (ax.lengthSq() > 1e-9) swingAxes.push(ax.normalize());
      }
    }
    const hinge = swingAxes.length
      ? swingAxes.reduce((a, b) => a.add(b), new THREE.Vector3()).normalize()
      : new THREE.Vector3();
    console.log(
      `  anim="${anim.name ?? '?'}" bone=${nameOf(tgt.node).padEnd(24)} ` +
      `kf=${out.count} hinge≈[${hinge.x.toFixed(2)}, ${hinge.y.toFixed(2)}, ${hinge.z.toFixed(2)}] ` +
      `bendAngle=${THREE.MathUtils.radToDeg(minA).toFixed(1)}°..${THREE.MathUtils.radToDeg(maxA).toFixed(1)}°`,
    );
  }
}
