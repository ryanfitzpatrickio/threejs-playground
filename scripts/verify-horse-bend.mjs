// Verify the bend-correction rewrite against the REAL horse animation data.
// For each front-knee rotation track we read the actual keyframes from the GLB,
// then report — using the rig's own length axis and a data-fitted hinge — the
// signed bend and signed twist produced by:
//   original  : the clip as-is
//   new       : twist–swing swing inversion (the rewrite), amount=1, mirror
//   old       : Euler-XYZ single-axis negation (the prior approach), axis=x
// New is correct when bend sign-flips AND twist is preserved. If the old
// approach scrambled, its twist will diverge from the original (the sideways/
// wrenched artifact), especially at the ~90°+ bends this rig reaches.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const GLB = path.resolve('public/assets/models/horse-rigged.glb');
const buf = readFileSync(GLB);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const dv = new DataView(ab);
let p = 12;
const chunks = {};
while (p < ab.byteLength) {
  const len = dv.getUint32(p, true); p += 4;
  const type = dv.getUint32(p, true); p += 4;
  chunks[type === 0x4e4f534a ? 'json' : 'bin'] = new Uint8Array(ab, p, len);
  p += len; p = Math.ceil(p / 4) * 4;
}
const gltf = JSON.parse(new TextDecoder().decode(chunks.json));
const binDv = new DataView(chunks.bin.buffer, chunks.bin.byteOffset, chunks.bin.byteLength);

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMP_GET = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
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
    const off = base + i * (stride || size * n);
    const row = [];
    for (let j = 0; j < n; j++) row.push(binDv[getter](off + j * size, true));
    rows.push(row);
  }
  return rows;
}

const nodes = gltf.nodes;
const nameOf = (i) => nodes[i]?.name ?? `node_${i}`;
const V = (a) => a ? new THREE.Vector3(a[0], a[1], a[2]) : null;
const Q = (a) => a ? new THREE.Quaternion(a[0], a[1], a[2], a[3]) : null;

// Signed bend (deg) about a hinge axis + signed twist (deg) about a length axis,
// for a delta quaternion. Hemisphere-stable.
function measure(delta, lengthAxis, hinge) {
  const rotAxis = lengthAxis.clone().applyQuaternion(delta);
  const swing = new THREE.Quaternion().setFromUnitVectors(lengthAxis, rotAxis);
  const twist = swing.clone().invert().multiply(delta);
  if (twist.w < 0) twist.set(-twist.x, -twist.y, -twist.z, -twist.w); // canonical hemisphere
  const bend = Math.atan2(new THREE.Vector3().crossVectors(lengthAxis, rotAxis).dot(hinge), lengthAxis.dot(rotAxis));
  const twistAng = 2 * Math.atan2(twist.x * lengthAxis.x + twist.y * lengthAxis.y + twist.z * lengthAxis.z, twist.w);
  return { bend: THREE.MathUtils.radToDeg(bend), twist: THREE.MathUtils.radToDeg(twistAng) };
}

function newCorrected(delta, lengthAxis) {
  const rotAxis = lengthAxis.clone().applyQuaternion(delta);
  const swing = new THREE.Quaternion().setFromUnitVectors(lengthAxis, rotAxis);
  const twist = swing.clone().invert().multiply(delta);
  const target = swing.clone().invert();
  swing.slerp(target, 1);
  return swing.multiply(twist);
}

function oldCorrected(delta) {
  const e = new THREE.Euler().setFromQuaternion(delta, 'XYZ');
  e.x = -e.x;
  return new THREE.Quaternion().setFromEuler(e);
}

const ID = new THREE.Quaternion();
const want = ['Walk', 'Run', 'Jump'];
let allOk = true;

for (const anim of gltf.animations) {
  if (!want.includes(anim.name)) continue;
  for (const boneName of ['Front_Leg_Lower_L', 'Front_Leg_Lower_R']) {
    const ni = nodes.findIndex((n) => n?.name === boneName);
    const ch = (anim.channels ?? []).find((c) => c.target.node === ni && c.target.path === 'rotation');
    if (!ch) continue;
    const rows = readAccessor(anim.samplers[ch.sampler].output);
    const rest = Q(nodes[ni].rotation) ?? ID.clone();
    const restInv = rest.clone().invert();
    const childT = V(nodes[(nodes[ni].children ?? [])[0]]?.translation);
    const lengthAxis = childT.clone().normalize();

    // Fit the hinge as the averaged swing axis across keyframes.
    const hingeAcc = new THREE.Vector3();
    for (const row of rows) {
      const delta = restInv.clone().multiply(Q(row));
      const rotAxis = lengthAxis.clone().applyQuaternion(delta);
      const swing = new THREE.Quaternion().setFromUnitVectors(lengthAxis, rotAxis);
      const ax = new THREE.Vector3(swing.x, swing.y, swing.z);
      if (ax.lengthSq() > 1e-9) hingeAcc.add(ax.normalize());
    }
    const hinge = hingeAcc.normalize();

    const mm = (arr) => [Math.min(...arr), Math.max(...arr)];
    const toDeg = (a) => `${a[0].toFixed(1)}..${a[1].toFixed(1)}`;
    const oB = [], oT = [], nB = [], nT = [], ldB = [], ldT = [];
    for (const row of rows) {
      const delta = restInv.clone().multiply(Q(row));
      const o = measure(delta, lengthAxis, hinge);
      const n = measure(newCorrected(delta, lengthAxis), lengthAxis, hinge);
      const l = measure(oldCorrected(delta), lengthAxis, hinge);
      oB.push(o.bend); oT.push(o.twist); nB.push(n.bend); nT.push(n.twist); ldB.push(l.bend); ldT.push(l.twist);
    }
    const ob = mm(oB), ot = mm(oT), nb = mm(nB), nt = mm(nT), lb = mm(ldB), lt = mm(ldT);
    const twistPreserved = Math.abs(nt[0] - ot[0]) < 0.5 && Math.abs(nt[1] - ot[1]) < 0.5;
    const bendInverted = Math.abs(nb[0] + ob[1]) < 0.5 && Math.abs(nb[1] + ob[0]) < 0.5;
    const oldTwistCorrupt = Math.abs(lt[0] - ot[0]) > 1 || Math.abs(lt[1] - ot[1]) > 1;
    if (!twistPreserved || !bendInverted) allOk = false;

    console.log(`\n${anim.name} / ${boneName}   lengthAxis=${`[${lengthAxis.x.toFixed(2)},${lengthAxis.y.toFixed(2)},${lengthAxis.z.toFixed(2)}]`} hinge≈[${hinge.x.toFixed(2)},${hinge.y.toFixed(2)},${hinge.z.toFixed(2)}]`);
    console.log(`  original : bend ${toDeg(ob).padStart(16)}°   twist ${toDeg(ot).padStart(14)}°`);
    console.log(`  new      : bend ${toDeg(nb).padStart(16)}°   twist ${toDeg(nt).padStart(14)}°   ${bendInverted && twistPreserved ? 'OK (bend flipped, twist kept)' : 'PROBLEM'}`);
    console.log(`  old      : bend ${toDeg(lb).padStart(16)}°   twist ${toDeg(lt).padStart(14)}°   ${oldTwistCorrupt ? 'twist corrupted (the scramble)' : 'twist ok'}`);
  }
}

console.log(`\n${allOk ? 'PASS' : 'FAIL'}: new method ${allOk ? 'flips bend and preserves twist on real keyframes.' : 'did not cleanly invert — see PROBLEM lines.'}`);
process.exit(allOk ? 0 : 1);
