// Ground-truth leg geometry: sample the Idle clip at mid-frame, walk the bone
// tree to get world positions, and plot a side view (forward x up) of the front
// leg under several bend-correction variants, plus the hind leg for reference.
// No rendering, no hallucination — just the rig's own numbers.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const GLB = path.resolve('public/assets/models/horse-rigged.glb');
const buf = readFileSync(GLB);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);
let p = 12;
const C = {};
while (p < ab.byteLength) {
  const len = dv.getUint32(p, true); p += 4;
  const t = dv.getUint32(p, true); p += 4;
  C[t === 0x4e4f534a ? 'j' : 'b'] = new Uint8Array(ab, p, len);
  p += len; p = Math.ceil(p / 4) * 4;
}
const g = JSON.parse(new TextDecoder().decode(C.j));
const binDv = new DataView(C.b.buffer, C.b.byteOffset, C.b.byteLength);
const SZ = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const GT = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };
const TN = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function readAcc(idx) {
  const a = g.accessors[idx]; const bv = g.bufferViews[a.bufferView];
  const size = SZ[a.componentType], n = TN[a.type], stride = bv.byteStride ?? 0;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), getter = GT[a.componentType];
  const rows = [];
  for (let i = 0; i < a.count; i++) {
    const off = base + i * (stride || size * n); const row = [];
    for (let j = 0; j < n; j++) row.push(binDv[getter](off + j * size, true));
    rows.push(row);
  }
  return rows;
}
const nodes = g.nodes;
const idx = {}; nodes.forEach((n, i) => { if (n?.name) idx[n.name] = i; });
const par = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n?.children ?? []).forEach((c) => { par[c] = i; }));

// Build per-node sampler for a given animation: maps node -> {rot:[times],[qx,qy,qz,w]..., trans:...}
function buildSampler(animName) {
  const anim = g.animations.find((a) => a.name === animName);
  const rot = {}, tr = {};
  if (!anim) return { rot, tr, dur: 0 };
  let dur = 0;
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const times = readAcc(s.input).map((r) => r[0]);
    const vals = readAcc(s.output);
    dur = Math.max(dur, times[times.length - 1] ?? 0);
    const ni = ch.target.node;
    if (ch.target.path === 'rotation') rot[ni] = { times, vals };
    if (ch.target.path === 'translation') tr[ni] = { times, vals };
  }
  return { rot, tr, dur };
}
function slerp(qa, qb, t) {
  let bx = qb[0], by = qb[1], bz = qb[2], bw = qb[3];
  let dot = qa[0] * bx + qa[1] * by + qa[2] * bz + qa[3] * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) {
    return [qa[0] + t * (bx - qa[0]), qa[1] + t * (by - qa[1]), qa[2] + t * (bz - qa[2]), qa[3] + t * (bw - qa[3])];
  }
  const th = Math.acos(Math.min(1, dot)), sth = Math.sin(th);
  const a = Math.sin((1 - t) * th) / sth, b = Math.sin(t * th) / sth;
  return [a * qa[0] + b * bx, a * qa[1] + b * by, a * qa[2] + b * bz, a * qa[3] + b * bw];
}
function sample(track, t, ncomp, slerpIt) {
  if (!track) return null;
  const { times, vals } = track;
  if (t <= times[0]) return vals[0];
  if (t >= times[times.length - 1]) return vals[vals.length - 1];
  let i = 0; while (i < times.length - 1 && times[i + 1] < t) i++;
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  if (slerpIt) return slerp(vals[i], vals[i + 1], u);
  const out = [];
  for (let j = 0; j < ncomp; j++) out.push(vals[i][j] + u * (vals[i + 1][j] - vals[i][j]));
  return out;
}

// Compute world position of every node given a localRot override map and time t.
function worldPositions(sampler, t, rotOverride) {
  const wpos = new Array(nodes.length).fill(null);
  const wrot = new Array(nodes.length).fill(null);
  const visit = (i, ppos, prot) => {
    const node = nodes[i];
    let lr = rotOverride?.get(i);
    if (!lr) {
      const s = sampler.rot[i] ? sample(sampler.rot[i], t, 4, true) : null;
      const arr = s ?? node.rotation ?? [0, 0, 0, 1];
      lr = new THREE.Quaternion(arr[0], arr[1], arr[2], arr[3]);
    }
    const ts = sampler.tr[i] ? sample(sampler.tr[i], t, 3, false) : null;
    const tarr = ts ?? node.translation ?? [0, 0, 0];
    const ltrans = new THREE.Vector3(tarr[0], tarr[1], tarr[2]);
    const wr = prot ? prot.clone().multiply(lr) : lr.clone();
    const wp = prot ? ppos.clone().add(ltrans.applyQuaternion(prot)) : ltrans.clone();
    wrot[i] = wr; wpos[i] = wp;
    for (const c of node.children ?? []) visit(c, wp, wr);
  };
  for (let i = 0; i < nodes.length; i++) if (par[i] < 0) visit(i, null, null);
  return { wpos, wrot };
}

const sampler = buildSampler('Idle');
const t = sampler.dur / 2 || 0;

// Forward axis = head direction projected to xz.
const base = worldPositions(sampler, t, null);
const head = idx.Head, hips = idx.Hips;
const fwd = new THREE.Vector3(
  base.wpos[head].x - base.wpos[hips].x, 0, base.wpos[head].z - base.wpos[hips].z,
).normalize();

// Swing-inversion of a bone's local rot (mirror, amount=1), matching the impl.
function invertLocal(nodeIdx, wrotUnused) {
  const node = nodes[nodeIdx];
  const child = (node.children ?? []).find((c) => nodes[c]?.name);
  const ctrans = child != null ? new THREE.Vector3(...(nodes[child].translation ?? [0, 0, 0])) : null;
  if (!ctrans || ctrans.lengthSq() <= 1e-9) return null;
  const lengthAxis = ctrans.clone().normalize();
  const s = sampler.rot[nodeIdx] ? sample(sampler.rot[nodeIdx], t, 4, true) : null;
  const arr = s ?? node.rotation ?? [0, 0, 0, 1];
  const localRot = new THREE.Quaternion(arr[0], arr[1], arr[2], arr[3]);
  const restArr = node.rotation ?? [0, 0, 0, 1];
  const rest = new THREE.Quaternion(restArr[0], restArr[1], restArr[2], restArr[3]);
  const delta = rest.clone().invert().multiply(localRot);
  const rotated = lengthAxis.clone().applyQuaternion(delta);
  const swing = new THREE.Quaternion().setFromUnitVectors(lengthAxis, rotated);
  const twist = swing.clone().invert().multiply(delta);
  swing.slerp(swing.clone().invert(), 1);
  const corrected = rest.clone().multiply(swing.multiply(twist));
  return corrected;
}

function buildOverride(invertNames) {
  const ov = new Map();
  for (const name of invertNames) {
    const i = idx[name]; if (i == null) continue;
    const q = invertLocal(i); if (q) ov.set(i, q);
  }
  return ov;
}

const CHAIN = ['Front_Leg_Shoulder_L', 'Front_Leg_Upper_L', 'Front_Leg_Lower_L', 'Front_Leg_Ankle_L', 'Front_Leg_Foot_L', 'Front_Leg_Tip_L'];
const HIND = ['Back_Leg_Pelvis_L', 'Back_Leg_Upper_L', 'Back_Leg_Lower_L', 'Back_Leg_Ankle_L', 'Back_Leg_Foot_L', 'Back_Leg_Foot_1_L', 'Back_Leg_Tip_L'];

function plot(title, pose) {
  const pts = CHAIN.map((n) => pose.wpos[idx[n]]).filter(Boolean);
  // side plane: horizontal = forward component, vertical = y
  const xs = pts.map((p) => p.clone().sub(pts[0]).dot(fwd));
  const ys = pts.map((p) => p.y);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const W = 46, H = 18;
  const grid = Array.from({ length: H }, () => ' '.repeat(W).split(''));
  const map = (x, y) => [
    Math.round(((x - xmin) / (xmax - xmin || 1)) * (W - 1)),
    Math.round(((ymax - y) / (ymax - ymin || 1)) * (H - 1)),
  ];
  // draw segments
  for (let k = 0; k < pts.length - 1; k++) {
    const [x0, y0] = map(xs[k], ys[k]); const [x1, y1] = map(xs[k + 1], ys[k + 1]);
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) {
      const cx = Math.round(x0 + (x1 - x0) * s / steps);
      const cy = Math.round(y0 + (y1 - y0) * s / steps);
      if (grid[cy] && grid[cy][cx] === ' ') grid[cy][cx] = grid[cy][cx] = '·';
    }
  }
  // draw joints
  pts.forEach((_, k) => {
    const [cx, cy] = map(xs[k], ys[k]);
    if (grid[cy]) grid[cy][cx] = String(k + 1);
  });
  // signed bend at carpus (joint 2: parent=Upper idx1, this=Lower idx2, child=Ankle idx3)
  const A = pts[1], B = pts[2], Cc = pts[3];
  const d1x = B.clone().sub(A), d2x = Cc.clone().sub(B);
  const d1 = new THREE.Vector2(d1x.dot(fwd), d1x.y), d2 = new THREE.Vector2(d2x.dot(fwd), d2x.y);
  const crossCarpus = d1.x * d2.y - d1.y * d2.x;
  // fetlock: parent=Ankle idx3, this=Foot idx4, child=Tip idx5
  const Af = pts[3], Bf = pts[4], Cf = pts[5];
  const e1 = new THREE.Vector2(Bf.clone().sub(Af).dot(fwd), Bf.y - Af.y);
  const e2 = new THREE.Vector2(Cf.clone().sub(Bf).dot(fwd), Cf.y - Bf.y);
  const crossFetlock = e1.x * e2.y - e1.y * e2.x;
  console.log(`\n=== ${title} ===  (knee folds ${crossCarpus > 0 ? 'BACKWARD (real-horse carpus)' : 'FORWARD (human-knee)'}, cross=${crossCarpus.toFixed(3)}; fetlock cross=${crossFetlock.toFixed(3)})`);
  console.log('  1 Shoulder  2 Upper  3 Lower/knee  4 Ankle/fetlock  5 Foot  6 Tip   | fwd→');
  grid.forEach((row) => console.log('  ' + row.join('')));
}

const variants = [
  ['HIND leg (reference, Back_Leg_Lower)', null, HIND],
  ['FRONT original (no correction)', null, CHAIN],
  ['FRONT invert Lower (carpus only)', ['Front_Leg_Lower_L'], CHAIN],
  ['FRONT invert Lower+Ankle', ['Front_Leg_Lower_L', 'Front_Leg_Ankle_L'], CHAIN],
  ['FRONT invert Lower+Ankle+Foot', ['Front_Leg_Lower_L', 'Front_Leg_Ankle_L', 'Front_Leg_Foot_L'], CHAIN],
];

for (const [title, invertNames, chain] of variants) {
  const ov = invertNames ? buildOverride(invertNames) : null;
  const pose = worldPositions(sampler, t, ov);
  // temporarily swap CHAIN for the hind reference plot
  const orig = CHAIN.slice();
  if (chain === HIND) { CHAIN.length = 0; CHAIN.push(...HIND); }
  plot(title, pose);
  if (chain === HIND) { CHAIN.length = 0; CHAIN.push(...orig); }
}
