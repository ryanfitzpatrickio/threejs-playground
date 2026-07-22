#!/usr/bin/env node
/**
 * probe-goose-bake — node-side logic check for the goose→bird-rig bake.
 *
 * The GLB can't be loaded headlessly (textures hit `self is not defined` in
 * GLTFParser.loadImageSource), so this builds a SYNTHETIC bird skeleton from
 * the 55 joint names and exercises the retarget + remap in isolation:
 *   - retargetBirdRigToGoose lands every targeted joint on its goose landmark;
 *   - remapGooseSkinToBird yields in-range, normalized, NaN-free weights;
 *   - at bind, linear-blend skinning reproduces the authored positions exactly
 *     (the invariant that lets the goose render as-authored at rest).
 *
 * Visual validation (bind reproduces the reference poses + clips look right)
 * is done in the browser via scripts/probe-goose.mjs.
 */
import * as THREE from 'three';
import { createGooseSkeleton } from '../src/game/characters/goose/gooseSkeleton.js';
import { buildGooseBodyGeometry } from '../src/game/characters/goose/gooseBodyGeometry.js';
import { buildGooseFeatherGeometry } from '../src/game/characters/goose/gooseFeatherGeometry.js';
import {
  GOOSE_RETARGET_FULL,
  retargetBirdRigToGoose,
  sanitizeClipForRetarget,
  remapGooseSkinToBird,
} from '../src/game/characters/goose/gooseBirdRigMap.js';

const JOINTS = [
  'root', 'hips', 'spine_0', 'spine_1', 'spine_2', 'spine_3', 'head',
  'mouth_upper', 'mouth_upper_tip', 'mouth_lower', 'mouth_lower_tip',
  'wing_1_L', 'wing_2_L', 'wing_feather_1_1_L', 'wing_feather_1_2_L', 'wing_3_L',
  'wing_4_L', 'wing_5_L', 'wing_tip_L', 'wing_feather_4_1_L', 'wing_feather_4_2_L',
  'wing_feather_3_1_L', 'wing_feather_3_2_L', 'wing_feather_2_1_L', 'wing_feather_2_2_L',
  'wing_1_R', 'wing_2_R', 'wing_feather_1_1_R', 'wing_feather_1_2_R', 'wing_3_R',
  'wing_4_R', 'wing_5_R', 'wing_tip_R', 'wing_feather_4_1_R', 'wing_feather_4_2_R',
  'wing_feather_3_1_R', 'wing_feather_3_2_R', 'wing_feather_2_1_R', 'wing_feather_2_2_R',
  'tail_1', 'tail_2', 'tail_3', 'tail_tip',
  'UpperLeg_L', 'LowerLeg_L', 'AnkleLeg_L', 'Foot_L', 'Toes_L', 'Toes_tip_L',
  'UpperLeg_R', 'LowerLeg_R', 'AnkleLeg_R', 'Foot_R', 'Toes_R', 'Toes_tip_R',
];

// Hierarchical synthetic bird armature (matches bird-rigged.glb parentage).
// Retarget now orients +Y along each primary child — flat parenting would leave
// every bone under the Group and hide parent-local quat bugs.
const HIER = {
  root: null,
  hips: 'root',
  spine_0: 'hips', spine_1: 'spine_0', spine_2: 'spine_1', spine_3: 'spine_2', head: 'spine_3',
  mouth_upper: 'head', mouth_upper_tip: 'mouth_upper', mouth_lower: 'head', mouth_lower_tip: 'mouth_lower',
  wing_1_L: 'spine_1', wing_2_L: 'wing_1_L', wing_3_L: 'wing_2_L', wing_4_L: 'wing_3_L',
  wing_5_L: 'wing_4_L', wing_tip_L: 'wing_5_L',
  wing_1_R: 'spine_1', wing_2_R: 'wing_1_R', wing_3_R: 'wing_2_R', wing_4_R: 'wing_3_R',
  wing_5_R: 'wing_4_R', wing_tip_R: 'wing_5_R',
  tail_1: 'hips', tail_2: 'tail_1', tail_3: 'tail_2', tail_tip: 'tail_3',
  UpperLeg_L: 'hips', LowerLeg_L: 'UpperLeg_L', AnkleLeg_L: 'LowerLeg_L',
  Foot_L: 'AnkleLeg_L', Toes_L: 'Foot_L', Toes_tip_L: 'Toes_L',
  UpperLeg_R: 'hips', LowerLeg_R: 'UpperLeg_R', AnkleLeg_R: 'LowerLeg_R',
  Foot_R: 'AnkleLeg_R', Toes_R: 'Foot_R', Toes_tip_R: 'Toes_R',
};
for (const side of ['L', 'R']) {
  for (const key of [
    'wing_feather_1_1', 'wing_feather_1_2', 'wing_feather_2_1', 'wing_feather_2_2',
    'wing_feather_3_1', 'wing_feather_3_2', 'wing_feather_4_1', 'wing_feather_4_2',
  ]) {
    HIER[`${key}_${side}`] = `wing_2_${side}`;
  }
}

const model = new THREE.Group();
const bonesByName = new Map();
const bones = [];
for (const name of JOINTS) {
  const b = new THREE.Bone();
  b.name = name;
  bones.push(b);
  bonesByName.set(name, b);
}
for (const name of JOINTS) {
  const p = HIER[name];
  if (p && bonesByName.has(p)) bonesByName.get(p).add(bonesByName.get(name));
  else model.add(bonesByName.get(name));
}
bonesByName.set('Head', bonesByName.get('head'));

// Seed native bind rotations from bird-rigged.glb so position-only retarget
// keeps the parent-local frames Walk clips were authored against (identity
// quats would recreate the broken leg-swing axes).
{
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const buf = readFileSync(join(root, 'public/assets/models/bird-rigged.glb'));
  let off = 12;
  let gltfJson = null;
  while (off < buf.length) {
    const chunkLen = buf.readUInt32LE(off);
    const chunkType = buf.toString('utf8', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + chunkLen);
    if (chunkType === 'JSON') gltfJson = JSON.parse(data.toString('utf8'));
    off += 8 + chunkLen;
  }
  for (const n of gltfJson.nodes) {
    if (!n.name || !n.rotation) continue;
    const b = bonesByName.get(n.name);
    if (b) b.quaternion.fromArray(n.rotation);
  }
  model.updateMatrixWorld(true);
}
const skeleton = new THREE.Skeleton(bones);

// Build goose geometry against the goose bone order.
const gooseBoneIndex = createGooseSkeleton().boneIndex;
const body = buildGooseBodyGeometry(gooseBoneIndex);
const feathers = buildGooseFeatherGeometry(gooseBoneIndex);

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗', msg); failures += 1; }
};

// ---- retarget ---------------------------------------------------------------
retargetBirdRigToGoose(model, skeleton, bonesByName);
model.updateMatrixWorld(true);

const _p = new THREE.Vector3();
let retargetHits = 0;
let retargetMisses = 0;
for (const [name, target] of Object.entries(GOOSE_RETARGET_FULL)) {
  const bone = bonesByName.get(name);
  if (!bone) { retargetMisses += 1; continue; }
  bone.getWorldPosition(_p);
  const dx = _p.x - target[0], dy = _p.y - target[1], dz = _p.z - target[2];
  if (Math.hypot(dx, dy, dz) < 1e-4) retargetHits += 1;
  else {
    retargetMisses += 1;
    console.error(`    ${name}: expected (${target}) got (${_p.x.toFixed(4)},${_p.y.toFixed(4)},${_p.z.toFixed(4)})`);
  }
}
ok(retargetMisses === 0, `retarget landed all ${retargetHits} targeted joints on goose landmarks`);

// ---- remap ------------------------------------------------------------------
remapGooseSkinToBird(body, skeleton);
remapGooseSkinToBird(feathers.geometry, skeleton);

function checkWeights(label, geo) {
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  let outOfRange = 0, nanW = 0, badSum = 0, maxBone = -1;
  for (let v = 0; v < si.count; v += 1) {
    let sum = 0;
    for (let k = 0; k < 4; k += 1) {
      const idx = si.getComponent(v, k);
      const w = sw.getComponent(v, k);
      if (idx >= bones.length || idx < 0) outOfRange += 1;
      if (!Number.isFinite(w)) nanW += 1;
      sum += w;
      if (idx > maxBone) maxBone = idx;
    }
    if (Math.abs(sum - 1) > 1e-3) badSum += 1;
  }
  ok(outOfRange === 0, `${label}: all skinIndex in [0, ${bones.length}) (max used ${maxBone})`);
  ok(nanW === 0, `${label}: no NaN weights`);
  ok(badSum === 0, `${label}: all vertex weights sum to 1 (±1e-3)`);
}
checkWeights('body', body);
checkWeights('feathers', feathers.geometry);

// ---- bind reproduction ------------------------------------------------------
// At bind, linear-blend skinning = Σ w_k (boneWorld · boneInverse_k) · pos.
// boneWorld · boneInverse == I when inverses were computed from the current
// pose (retarget calls calculateInverses), so the result equals the authored
// position attribute exactly, independent of the weight split.
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
function maxBindDrift(geo) {
  const pos = geo.attributes.position;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  let maxDrift = 0;
  for (let v = 0; v < pos.count; v += 1) {
    const px = pos.getX(v), py = pos.getY(v), pz = pos.getZ(v);
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k += 1) {
      const w = sw.getComponent(v, k);
      if (w === 0) continue;
      const bi = si.getComponent(v, k);
      _m.multiplyMatrices(skeleton.bones[bi].matrixWorld, skeleton.boneInverses[bi]);
      _v.set(px, py, pz).applyMatrix4(_m).multiplyScalar(w);
      x += _v.x; y += _v.y; z += _v.z;
    }
    const d = Math.hypot(x - px, y - py, z - pz);
    if (d > maxDrift) maxDrift = d;
  }
  return maxDrift;
}
// matrixWorld must be fresh after retarget repositioned bones.
model.updateMatrixWorld(true);
skeleton.update();
ok(maxBindDrift(body) < 1e-5, `body: bind reproduces authored positions (drift < 1e-5)`);
ok(maxBindDrift(feathers.geometry) < 1e-5, `feathers: bind reproduces authored positions (drift < 1e-5)`);

// ---- clip sanitize ----------------------------------------------------------
const sampleClip = new THREE.AnimationClip('Walk', 1, [
  new THREE.VectorKeyframeTrack('hips.position', [0, 1], [0, 0, 0, 0, 0.05, 0]),
  new THREE.QuaternionKeyframeTrack('head.quaternion', [0, 1], [0, 0, 0, 1, 0, 0.1, 0, 1]),
]);
const sanitized = sanitizeClipForRetarget(sampleClip, bonesByName);
ok(sanitized.tracks.length === 1, 'sanitize strips .position tracks, keeps rotations');
ok(sanitized.tracks[0].name === 'head.quaternion', 'surviving track is the rotation');
// With bind baked in, t=0 equals the post-retarget head quat (not forced identity).
{
  const headBind = bonesByName.get('head').quaternion;
  const v = sanitized.tracks[0].values;
  const d = Math.hypot(v[0] - headBind.x, v[1] - headBind.y, v[2] - headBind.z, v[3] - headBind.w);
  ok(d < 1e-5, 'sanitize t=0 preserves goose bind quat when bonesByName is passed');
}

// ---- walk leg sides (axis-preserving retarget + bind-baked deltas) ----------
{
  const qtrack = (name, keys) => new THREE.QuaternionKeyframeTrack(
    `${name}.quaternion`,
    keys.map((k) => k[0]),
    keys.flatMap((k) => k.slice(1)),
  );
  // Sparse Walk-like swing (values sampled from bird-rigged.glb Walk keys).
  const walkSrc = new THREE.AnimationClip('Walk', 1, [
    qtrack('UpperLeg_L', [[0, 0.288, 0.302, -0.330, 0.847], [0.5, 0.575, 0.604, -0.168, 0.526]]),
    qtrack('UpperLeg_R', [[0, 0.600, -0.570, 0.106, 0.551], [0.5, 0.310, -0.316, 0.339, 0.830]]),
    qtrack('LowerLeg_L', [[0, 0.387, -0.106, 0.453, 0.796], [0.5, 0.501, 0.026, 0.611, 0.613]]),
    qtrack('LowerLeg_R', [[0, 0.477, 0.015, -0.577, 0.663], [0.5, 0.417, 0.084, -0.494, 0.758]]),
    qtrack('AnkleLeg_L', [[0, -0.355, 0.046, -0.076, 0.931], [0.5, -0.654, 0.087, -0.015, 0.752]]),
    qtrack('AnkleLeg_R', [[0, -0.577, -0.075, 0.035, 0.813], [0.5, -0.417, -0.053, 0.068, 0.905]]),
  ]);
  const walkClip = sanitizeClipForRetarget(walkSrc, bonesByName);
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(walkClip);
  action.play();
  mixer.setTime(0.5);
  model.updateMatrixWorld(true);
  const L = new THREE.Vector3();
  const R = new THREE.Vector3();
  bonesByName.get('Toes_tip_L').getWorldPosition(L);
  bonesByName.get('Toes_tip_R').getWorldPosition(R);
  ok(L.x > 0.01, `Walk mid: left toes stay on +X (x=${L.x.toFixed(3)})`);
  ok(R.x < -0.01, `Walk mid: right toes stay on -X (x=${R.x.toFixed(3)})`);
  ok(Math.abs(L.z - R.z) > 0.03, `Walk mid: legs alternate in Z (dz=${(L.z - R.z).toFixed(3)})`);
}

console.log(`\nbones ${bones.length}  bodyVerts ${body.attributes.position.count}  featherVerts ${feathers.geometry.attributes.position.count}`);
console.log(failures === 0 ? '\nPROBE OK' : `\nPROBE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
