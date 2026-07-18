// Arm-space (bind-axis) correction for DEF skeletons that are not human5.
//
// Rigify locomotion clips are retargeted offline against human5's bone rolls.
// Bodies like Universal Base Characters (UE axes) share DEF bone *names* but
// not bind orientations, so the same quaternion tracks fold the arms wrong.
//
// Preferred fix: re-retarget Mixamo → that body
//   (npm run retarget:rigify -- --target public/assets/simhuman/ubc-male.glb
//                              --out public/assets/animations-rigify-ubc-male)
//
// This module is the runtime fallback / online adapter: rewrite clip quaternion
// tracks with bind-delta local offsets
//   q'(t) = q_tgt_bind * inv(q_ref_bind) * q(t)
// for the arm (and optional leg) chains.

import * as THREE from 'three';
import { toRuntimeRigifyBoneName } from './rigifySkeleton.js';

/** Limb bones whose local axes commonly differ across humanoid packs. */
export const ARM_SPACE_BONES = Object.freeze([
  'DEF-shoulder.L',
  'DEF-upper_arm.L',
  'DEF-forearm.L.001',
  'DEF-forearm.L',
  'DEF-hand.L',
  'DEF-shoulder.R',
  'DEF-upper_arm.R',
  'DEF-forearm.R.001',
  'DEF-forearm.R',
  'DEF-hand.R',
]);

export const LEG_SPACE_BONES = Object.freeze([
  'DEF-thigh.L',
  'DEF-thigh.L.001',
  'DEF-shin.L',
  'DEF-shin.L.001',
  'DEF-foot.L',
  'DEF-toe.L',
  'DEF-thigh.R',
  'DEF-thigh.R.001',
  'DEF-shin.R',
  'DEF-shin.R.001',
  'DEF-foot.R',
  'DEF-toe.R',
]);

function runtimeKey(name) {
  return toRuntimeRigifyBoneName(name);
}

function collectBones(root) {
  const byRuntime = new Map();
  root.traverse((node) => {
    if (!node.isBone) return;
    byRuntime.set(runtimeKey(node.name), node);
    byRuntime.set(node.name, node);
  });
  return byRuntime;
}

function localBindQuaternion(bone) {
  // Bone.quaternion at bind (after skeleton.pose()) is the rest local rotation.
  return bone.quaternion.clone().normalize();
}

/**
 * Build per-bone local offsets that map reference-bind local quats → target-bind.
 * @returns {Map<string, THREE.Quaternion>} keyed by runtime bone name
 */
export function buildArmSpaceOffsets(targetRoot, referenceRoot, {
  bones = [...ARM_SPACE_BONES, ...LEG_SPACE_BONES],
} = {}) {
  const tgtBones = collectBones(targetRoot);
  const refBones = collectBones(referenceRoot);
  const offsets = new Map();
  const qRef = new THREE.Quaternion();
  const qTgt = new THREE.Quaternion();

  for (const rawName of bones) {
    const key = runtimeKey(rawName);
    const tgt = tgtBones.get(key) ?? tgtBones.get(rawName);
    const ref = refBones.get(key) ?? refBones.get(rawName);
    if (!tgt || !ref) continue;
    qRef.copy(localBindQuaternion(ref));
    qTgt.copy(localBindQuaternion(tgt));
    // q' = qTgt * inv(qRef) * q  ⇒  left-multiply by (qTgt * inv(qRef))
    const offset = qTgt.clone().multiply(qRef.clone().invert()).normalize();
    // Skip near-identity
    if (Math.abs(offset.w) > 0.9999 && offset.x * offset.x + offset.y * offset.y + offset.z * offset.z < 1e-6) {
      continue;
    }
    offsets.set(key, offset);
  }
  return offsets;
}

/**
 * Extra constant local rolls (degrees) applied after bind-delta, for manual tune.
 * Keys are runtime or Blender DEF names; values { x, y, z } euler degrees (XYZ).
 */
export function buildManualRollOffsets(rollsDeg = {}) {
  const out = new Map();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  for (const [name, deg] of Object.entries(rollsDeg)) {
    if (!deg) continue;
    e.set(
      THREE.MathUtils.degToRad(deg.x ?? 0),
      THREE.MathUtils.degToRad(deg.y ?? 0),
      THREE.MathUtils.degToRad(deg.z ?? 0),
      'XYZ',
    );
    q.setFromEuler(e);
    out.set(runtimeKey(name), q.clone());
  }
  return out;
}

function composeOffsetMaps(...maps) {
  const out = new Map();
  for (const map of maps) {
    if (!map) continue;
    for (const [key, q] of map) {
      if (!out.has(key)) out.set(key, q.clone());
      else out.get(key).premultiply(q).normalize();
    }
  }
  return out;
}

/**
 * Rewrite clip quaternion tracks in-place (clones the clip first).
 * Track names look like `DEF-upper_armL.quaternion` (GLTFLoader sanitised).
 */
export function adaptClipToArmSpace(clip, offsetMap) {
  if (!clip || !offsetMap?.size) return clip;
  const adapted = clip.clone();
  const q = new THREE.Quaternion();
  const offset = new THREE.Quaternion();

  adapted.tracks = adapted.tracks.map((track) => {
    if (!track.name.endsWith('.quaternion')) return track;
    const boneName = track.name.slice(0, -'.quaternion'.length);
    const key = runtimeKey(boneName);
    const off = offsetMap.get(key) ?? offsetMap.get(boneName);
    if (!off) return track;

    const next = track.clone();
    const { values } = next;
    for (let i = 0; i < values.length; i += 4) {
      q.set(values[i], values[i + 1], values[i + 2], values[i + 3]).normalize();
      // q' = offset * q
      offset.copy(off).multiply(q).normalize();
      values[i] = offset.x;
      values[i + 1] = offset.y;
      values[i + 2] = offset.z;
      values[i + 3] = offset.w;
    }
    return next;
  });
  return adapted;
}

/**
 * Adapt a Map/object of { clip } entries (MaraAnimationController shape).
 */
export function adaptClipMapToArmSpace(clipMap, offsetMap) {
  if (!clipMap || !offsetMap?.size) return clipMap;
  const out = new Map();
  for (const [action, entry] of clipMap) {
    if (!entry?.clip) {
      out.set(action, entry);
      continue;
    }
    out.set(action, {
      ...entry,
      clip: adaptClipToArmSpace(entry.clip, offsetMap),
    });
  }
  return out;
}

/**
 * Full pipeline: build offsets from reference+target, optionally merge manual rolls,
 * adapt clips. Returns { clips, offsets, adaptedCount }.
 */
export function applyArmSpaceModifier({
  clips,
  targetRoot,
  referenceRoot = null,
  includeLegs = true,
  manualRollsDeg = null,
}) {
  const boneList = includeLegs
    ? [...ARM_SPACE_BONES, ...LEG_SPACE_BONES]
    : [...ARM_SPACE_BONES];

  let offsets = new Map();
  if (referenceRoot) {
    offsets = buildArmSpaceOffsets(targetRoot, referenceRoot, { bones: boneList });
  }
  if (manualRollsDeg) {
    offsets = composeOffsetMaps(offsets, buildManualRollOffsets(manualRollsDeg));
  }

  const adapted = adaptClipMapToArmSpace(clips, offsets);
  return {
    clips: adapted,
    offsets,
    adaptedCount: offsets.size,
  };
}

/**
 * Default manual arm rolls for Universal Base Characters when reference retarget
 * is unavailable. Tuned for UE mannequin → Rigify clip axes (degrees, bone local).
 * Override via ?armRoll= or setArmSpaceRolls in the viewer.
 */
export const UBC_DEFAULT_ARM_ROLLS_DEG = Object.freeze({
  // UE upper arms often need ~90° around local bone axis vs Rigify clip space.
  'DEF-upper_arm.L': { x: 0, y: 0, z: -90 },
  'DEF-upper_arm.R': { x: 0, y: 0, z: 90 },
  'DEF-forearm.L.001': { x: 0, y: 0, z: 0 },
  'DEF-forearm.R.001': { x: 0, y: 0, z: 0 },
  'DEF-shoulder.L': { x: 0, y: 0, z: 0 },
  'DEF-shoulder.R': { x: 0, y: 0, z: 0 },
});
