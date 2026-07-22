/**
 * Bake the procedural goose onto the SHARED bird rig (bird-rigged.glb).
 *
 * The goose geometry/shells/feathers are authored in "goose space" against
 * anatomical bone names (neck_0..11, femur_L, shoulder_L, …). The shared bird
 * rig has different joints and, critically, NO neck bones (spine_3 → head).
 * To ride the embedded GLB clips we:
 *
 *   1. RENAME every geometry weight to a bird-rig joint (MY_TO_BIRD), turning
 *      the 12 cervical controls into a spine_3↔head blend (see neckBirdBones).
 *   2. RETARGET joint translations to goose landmarks (GOOSE_RETARGET) while
 *      KEEPING native bind quaternions — those parent-local frames are what
 *      Walk/Flap were authored in. Zeroing quats made both legs swing in the
 *      wrong plane / cross the midline.
 *   3. SANITIZE clips: drop `.position` tracks and rewrite rotations as
 *      delta(t)·Q_bind so goose landmark translations + native rest axes
 *      survive; only the clip's motion delta plays on top.
 *
 * Result: at bind the goose renders exactly as authored (boneWorld·inverse = I),
 * and Idle/Walk/Flap/Glide rotate both legs in the authored swing plane. The
 * long S-neck is a baked bind-pose curve (no cervical joints on the shared rig).
 */

import * as THREE from 'three';
import { GOOSE_DIMS, GOOSE_BONE_DEFS } from './gooseSkeleton.js';

const D = GOOSE_DIMS;

/**
 * Goose bone order (index → anatomical name) — mirrors the order
 * `createGooseSkeleton` registers bones, which is what the geometry builders
 * bake into `skinIndex`. Used to translate those indices back to names before
 * remapping onto bird-rig joints.
 */
const GOOSE_BONE_ORDER = GOOSE_BONE_DEFS.map(([name]) => name);

/**
 * Resolve one goose bone to its bird-rig (jointName, weight) contributions.
 * Most bones map 1:1 via MY_TO_BIRD; the 12 cervical controls (neck_0..11)
 * each split into a spine_3(base)↔head(top) blend so the baked S-neck still
 * deforms smoothly when the head bone moves on the shared rig.
 * @param {string} name
 * @returns {Array<[string, number]>}
 */
function gooseBoneToBirdPairs(name) {
  const m = /^neck_(\d+)$/.exec(name);
  if (m) return neckBirdBones(Number(m[1]));
  return [[toBirdBone(name), 1]];
}

/**
 * Remap a goose-authored geometry's skinIndex/skinWeight onto the bird rig.
 *
 * Goose geometry is skinned to the bespoke 55-bone order (GOOSE_BONE_ORDER).
 * The bird rig has fewer joints and NO neck bones, so the mapping is
 * many-to-one (12 cervicals → spine_3/head blend; toe_in/out/hallux →
 * Toes/Foot; eye_L/R → head). Per vertex we sum each bird joint's contributed
 * weight, keep the top 4, and renormalize — yielding valid 4-weight skinning
 * with no duplicate indices.
 *
 * Must run AFTER `retargetBirdRigToGoose` so the skeleton's bind pose already
 * matches goose anatomy (the bind inverses the mesh binds to are recomputed
 * there). At bind, skinning then reproduces the authored goose positions
 * exactly (boneWorld · boneInverse = I), independent of the weight split.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Skeleton} skeleton retargeted bird skeleton
 */
export function remapGooseSkinToBird(geometry, skeleton) {
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) return;

  const birdIdx = new Map(skeleton.bones.map((b, i) => [b.name, i]));
  /** @type {Map<number, number>} birdIndex → accumulated weight */
  const acc = new Map();

  for (let v = 0; v < skinIndex.count; v += 1) {
    acc.clear();
    for (let k = 0; k < 4; k += 1) {
      const w = skinWeight.getComponent(v, k);
      if (w <= 0) continue;
      const gName = GOOSE_BONE_ORDER[skinIndex.getComponent(v, k)];
      if (!gName) continue;
      for (const [bn, wm] of gooseBoneToBirdPairs(gName)) {
        if (wm <= 0) continue;
        const bi = birdIdx.get(bn);
        if (bi == null) continue;
        acc.set(bi, (acc.get(bi) ?? 0) + w * wm);
      }
    }
    // Top-4 bird joints by weight.
    const entries = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (let i = 0; i < entries.length; i += 1) sum += entries[i][1];
    if (sum <= 0) {
      // No usable weight (shouldn't happen) — fall back to root.
      skinIndex.setComponent(v, 0, 0);
      skinWeight.setComponent(v, 0, 1);
      for (let k = 1; k < 4; k += 1) {
        skinIndex.setComponent(v, k, 0);
        skinWeight.setComponent(v, k, 0);
      }
      continue;
    }
    for (let k = 0; k < 4; k += 1) {
      const e = entries[k];
      if (e) {
        skinIndex.setComponent(v, k, e[0]);
        skinWeight.setComponent(v, k, e[1] / sum);
      } else {
        skinIndex.setComponent(v, k, 0);
        skinWeight.setComponent(v, k, 0);
      }
    }
  }
  skinIndex.needsUpdate = true;
  skinWeight.needsUpdate = true;
}

/** Anatomical goose bone → shared-bird-rig joint. */
export const MY_TO_BIRD = Object.freeze({
  root: 'root',
  hips: 'hips',
  spine_0: 'spine_0',
  spine_1: 'spine_1',
  spine_2: 'spine_2',
  spine_3: 'spine_3',
  keel: 'spine_1',
  crop: 'spine_3',
  head: 'head',
  jaw: 'mouth_lower',
  eye_L: 'head',
  eye_R: 'head',
  // tail chain (goose has 3, bird has 4 + tip)
  tail_0: 'tail_1',
  tail_1: 'tail_2',
  tail_2: 'tail_3',
  rectrix_L: 'tail_3',
  rectrix_R: 'tail_tip',
  // wings: goose shoulder/elbow/wrist/hand/digit → bird wing_1/2/3/4/tip
  shoulder_L: 'wing_1_L', wing_0_L: 'wing_2_L', wing_1_L: 'wing_3_L', wing_2_L: 'wing_4_L', wing_tip_L: 'wing_tip_L',
  shoulder_R: 'wing_1_R', wing_0_R: 'wing_2_R', wing_1_R: 'wing_3_R', wing_2_R: 'wing_4_R', wing_tip_R: 'wing_tip_R',
  // legs: bird has an extra AnkleLeg joint (matches the tarsometatarsus)
  femur_L: 'UpperLeg_L', tibia_L: 'LowerLeg_L', Foot_L: 'AnkleLeg_L', Toes_L: 'Foot_L', Toes_tip_L: 'Toes_tip_L', toe_in_L: 'Toes_L', toe_out_L: 'Toes_L', hallux_L: 'Foot_L',
  femur_R: 'UpperLeg_R', tibia_R: 'LowerLeg_R', Foot_R: 'AnkleLeg_R', Toes_R: 'Foot_R', Toes_tip_R: 'Toes_tip_R', toe_in_R: 'Toes_R', toe_out_R: 'Toes_R', hallux_R: 'Foot_R',
});

/** Resolve a goose bone name to its bird-rig joint (identity if already bird). */
export function toBirdBone(name) {
  return MY_TO_BIRD[name] ?? name;
}

/**
 * Neck cervical index → bird-rig weight pair. The 12 goose neck controls
 * become a smooth spine_3 (base) → head (top) blend so the long baked neck
 * still deforms sensibly when the head bone moves.
 * @param {number} i 0..11
 * @returns {Array<[string, number]>}
 */
export function neckBirdBones(i) {
  const t = i / 11;
  return [['spine_3', 1 - t], ['head', t]];
}

/**
 * Bird-rig joint → goose-space bind world position. Joints absent here keep
 * their GLB position (they are unused by any weight, e.g. wing_feather_*).
 */
export const GOOSE_RETARGET = Object.freeze({
  root: [0, 0, 0],
  hips: [0, 0.415, -0.06],
  spine_0: [0, 0.42, 0.015],
  spine_1: [0, 0.435, 0.09],
  spine_2: [0, 0.455, 0.135],
  spine_3: [0, 0.492, 0.152],
  head: [0, D.headCenterY, D.headCenterZ],
  mouth_upper: [0, 0.860, 0.345],
  mouth_upper_tip: [0, 0.836, 0.418],
  mouth_lower: [0, 0.846, 0.302],
  mouth_lower_tip: [0, 0.838, 0.400],
  tail_1: [0, 0.412, -0.185],
  tail_2: [0, 0.398, -0.245],
  tail_3: [0, 0.378, -0.30],
  tail_tip: [0, 0.372, -0.35],
});

// Mirror the L/R wing + leg joints from goose anatomy.
const RETARGET_SIDED = {
  wing_1: [D.shoulderX, D.shoulderY, D.shoulderZ],
  wing_2: [0.108, 0.455, -0.005],
  wing_3: [0.102, D.wristY, D.wristZ],
  wing_4: [0.078, 0.468, D.handTipZ],
  wing_5: [0.062, 0.44, -0.33],
  wing_tip: [0.052, 0.425, -0.355],
  UpperLeg: [D.legX, D.hipY, D.hipZ],
  LowerLeg: [D.legX * 1.12, D.kneeY, D.kneeZ],
  AnkleLeg: [D.legX, D.ankleY, D.ankleZ],
  Foot: [D.legX, D.footBallY, D.footBallZ],
  Toes: [D.legX, 0.01, 0.072],
  Toes_tip: [D.legX, 0.006, D.toeTipZ],
};

const _fullRetarget = { ...GOOSE_RETARGET };
for (const [stem, pos] of Object.entries(RETARGET_SIDED)) {
  _fullRetarget[`${stem}_L`] = [pos[0], pos[1], pos[2]];
  _fullRetarget[`${stem}_R`] = [-pos[0], pos[1], pos[2]];
}
// wing feather bones: park them near the folded hand so unused weights (none)
// and skeleton bounds stay sane.
for (const side of ['L', 'R']) {
  const s = side === 'L' ? 1 : -1;
  for (const key of ['wing_feather_1_1', 'wing_feather_1_2', 'wing_feather_2_1', 'wing_feather_2_2',
    'wing_feather_3_1', 'wing_feather_3_2', 'wing_feather_4_1', 'wing_feather_4_2']) {
    _fullRetarget[`${key}_${side}`] = [s * 0.06, 0.44, -0.30];
  }
}

/** @type {Record<string, [number, number, number]>} */
export const GOOSE_RETARGET_FULL = _fullRetarget;

const _retargetP = new THREE.Vector3();
const _retargetM = new THREE.Matrix4();

/**
 * Reposition a cloned bird-rig hierarchy so joint WORLDS match goose anatomy,
 * then recompute skeleton bind inverses.
 *
 * CRITICAL: local quaternions stay at the native bird bind. Walk/Flap/Idle were
 * authored in those parent-local frames; zeroing them (identity retarget) made
 * clip rotation deltas swing both legs in the wrong plane / across the midline.
 * Only translations are rewritten so each joint sits on its goose landmark
 * while skinning at bind still reproduces the authored mesh (boneWorld ·
 * boneInverse = I after calculateInverses). Parent-first.
 *
 * @param {THREE.Object3D} model armature root (contains the bones)
 * @param {THREE.Skeleton} skeleton
 * @param {Map<string, THREE.Bone>} bonesByName
 */
export function retargetBirdRigToGoose(model, skeleton, bonesByName) {
  model.updateMatrixWorld(true);
  // Depth-ordered bone list (parents before children).
  const ordered = [];
  const seen = new Set();
  const visit = (bone) => {
    if (!bone || seen.has(bone)) return;
    if (bone.parent && bone.parent.isBone && !seen.has(bone.parent)) visit(bone.parent);
    seen.add(bone);
    ordered.push(bone);
  };
  bonesByName.forEach((b) => visit(b));

  for (const bone of ordered) {
    const target = GOOSE_RETARGET_FULL[bone.name];
    let world;
    if (target) {
      world = _retargetP.set(target[0], target[1], target[2]);
    } else {
      bone.getWorldPosition(_retargetP);
      world = _retargetP;
    }
    // Keep native bind quaternion + scale — only the local translation changes.
    bone.scale.setScalar(1);
    const parent = bone.parent && bone.parent.isBone ? bone.parent : null;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      bone.position.copy(world).applyMatrix4(_retargetM.copy(parent.matrixWorld).invert());
    } else {
      bone.position.copy(world);
    }
    bone.updateMatrixWorld(true);
  }
  model.updateMatrixWorld(true);
  skeleton.calculateInverses();
  skeleton.update();
}

const _q0 = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/**
 * Strip bone `.position` tracks AND rewrite each `.quaternion` track as
 *   Q_out(t) = (Q_clip(t) · Q_clip(0)⁻¹) · Q_bind
 * so the mixer preserves the retargeted goose bind at t=0 and applies only the
 * clip's parent-local motion delta on top.
 *
 * Retarget keeps native bind quaternions (position-only), so Q_bind matches the
 * frames the Walk/Flap clips were authored in — deltas then swing both legs in
 * the correct plane. Position tracks are dropped so goose landmark translations
 * survive. Pass `bonesByName` from the post-retarget skeleton; without it bind
 * is treated as identity (legacy / tests).
 *
 * @param {THREE.AnimationClip} clip
 * @param {Map<string, THREE.Bone> | null} [bonesByName]
 * @returns {THREE.AnimationClip} new sanitized clip (template clip untouched)
 */
export function sanitizeClipForRetarget(clip, bonesByName = null) {
  const tracks = [];
  for (const track of clip.tracks) {
    if (track.name.endsWith('.position')) continue;
    if (track.name.endsWith('.quaternion') && track.values.length >= 4) {
      const v = track.values;
      const out = new v.constructor(v.length);
      const boneName = track.name.slice(0, -'.quaternion'.length);
      const bindBone = bonesByName?.get(boneName);
      if (bindBone) _qb.copy(bindBone.quaternion);
      else _qb.identity();
      _q0.set(v[0], v[1], v[2], v[3]).invert();        // Q_clip(0)⁻¹
      for (let i = 0; i < v.length; i += 4) {
        _qt.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
        // out = delta(t) · Q_goose_bind
        _qd.copy(_qt).multiply(_q0).multiply(_qb).normalize();
        out[i] = _qd.x; out[i + 1] = _qd.y; out[i + 2] = _qd.z; out[i + 3] = _qd.w;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(track.name, track.times, out));
      continue;
    }
    tracks.push(track);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
}
