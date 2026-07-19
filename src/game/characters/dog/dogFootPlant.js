/**
 * Ground contact for procedural dogs of any breed scale / leg length.
 *
 * Bind-time: pelvis plant + per-leg single-axis CCD so all four pads share a
 * plane (fixes front/hind mismatch from legLength phenotype).
 *
 * Runtime: sample ground under each paw (raycast / heightfield), snap the actor
 * root to the support plane, then CCD residual errors so no foot floats or
 * sinks when breeds differ or the pose changes.
 */

import * as THREE from 'three';
import { dogDebugState } from '../../config/dogDebugConfig.js';

// Local chain table avoids a circular import with dogSkeleton.js (skeleton
// calls plantBindSoles during construction). Keep in sync with DOG_LEG_CHAINS.
const LEG_CHAINS = Object.freeze({
  frontL: {
    front: true,
    hip: 'ShoulderL', upper: 'UpperArmL', lower: 'ForearmL', pastern: 'PasternL', paw: 'PawL',
  },
  frontR: {
    front: true,
    hip: 'ShoulderR', upper: 'UpperArmR', lower: 'ForearmR', pastern: 'PasternR', paw: 'PawR',
  },
  hindL: {
    hip: 'HipL', upper: 'ThighL', lower: 'ShinL', pastern: 'HockL', paw: 'HindPawL',
  },
  hindR: {
    hip: 'HipR', upper: 'ThighR', lower: 'ShinR', pastern: 'HockR', paw: 'HindPawR',
  },
});

/**
 * Rendered pad hang below the paw bone in bind/local skeleton meters.
 * dogBodyGeometry's lowest pad ring is 0.014m down with a 0.010m radius.
 */
export const DOG_PAW_MESH_PAD = 0.024;
/** Small visual compression so the fur/pad shell reads as weight-bearing. */
export const DOG_GROUND_CONTACT_COMPRESSION = 0.006;

const _paw = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _toEnd = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _projectedEnd = new THREE.Vector3();
const _projectedTarget = new THREE.Vector3();
const _target = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _rootWorldQ = new THREE.Quaternion();
const _bindRootInvQ = new THREE.Quaternion();
const _desiredWorldQ = new THREE.Quaternion();
const _parentWorldQ = new THREE.Quaternion();

const PAW_NAMES = Object.freeze(['PawL', 'PawR', 'HindPawL', 'HindPawR']);

function boneWorldPos(bonesByName, name, out = new THREE.Vector3()) {
  const bone = bonesByName.get(name);
  if (!bone) return out.set(0, 0, 0);
  return bone.getWorldPosition(out);
}

/** Approximate pad bottom (sole) in world space. */
export function getPadWorldPosition(rig, pawName, out = new THREE.Vector3()) {
  boneWorldPos(rig.bonesByName, pawName, out);
  // Pad mesh hangs below the paw bone; scale is already in the world matrix.
  const scaleY = rig.root?.matrixWorld
    ? new THREE.Vector3().setFromMatrixScale(rig.root.matrixWorld).y
    : 1;
  // Prefer the dog actor root scale when the skeleton is nested under a scaled Group.
  out.y -= DOG_PAW_MESH_PAD * Math.max(1e-4, Math.abs(scaleY));
  return out;
}

function updateRigWorld(rig) {
  rig.root.updateMatrixWorld(true);
  rig.skeleton?.update?.();
}

/** Restore a paw's bind-world pitch/roll under the actor's current root yaw. */
function flattenPawToBindPlane(rig, pawName) {
  const paw = rig.bonesByName.get(pawName);
  const bindPaw = rig.worldBindQuaternions?.get(pawName);
  const bindRoot = rig.worldBindQuaternions?.get('Root');
  if (!paw?.parent || !bindPaw || !bindRoot) return;

  rig.root.getWorldQuaternion(_rootWorldQ);
  _bindRootInvQ.copy(bindRoot).invert();
  _desiredWorldQ
    .copy(_rootWorldQ)
    .multiply(_bindRootInvQ)
    .multiply(bindPaw);
  paw.parent.getWorldQuaternion(_parentWorldQ).invert();
  paw.quaternion.copy(_parentWorldQ.multiply(_desiredWorldQ)).normalize();
  updateRigWorld(rig);
}

function meanMinPawY(rig) {
  let sum = 0;
  let min = Infinity;
  let n = 0;
  for (const name of PAW_NAMES) {
    if (!rig.bonesByName.get(name)) continue;
    boneWorldPos(rig.bonesByName, name, _paw);
    sum += _paw.y;
    min = Math.min(min, _paw.y);
    n += 1;
  }
  return { mean: n ? sum / n : 0, min: Number.isFinite(min) ? min : 0, count: n };
}

/**
 * Single-axis CCD on local X (matches dog leg contract) to drive a paw toward
 * a world-space target Y while keeping the foot roughly under its current XZ.
 *
 * @param {object} rig
 * @param {{ hip: string, upper: string, lower: string, pastern: string, paw: string }} chain
 * @param {number} targetY world Y for the paw bone (not pad bottom)
 * @param {number} [iterations]
 */
export function ccdPlantLeg(rig, chain, targetY, iterations = 5) {
  const bones = rig.bonesByName;
  // Only upper + lower (stifle/hock hinge pair). Never rotate pastern/hock tip —
  // that flips the flat paw and can bury the hock under the foot.
  const effectors = [chain.lower, chain.upper].filter((name) => bones.get(name));
  const pawName = chain.paw;
  const hockName = chain.pastern;
  if (!bones.get(pawName) || !effectors.length) return;

  // Preserve the clip's continuous fore/aft placement. Solving Y alone via a
  // Jacobian lets the two-joint chain flip between multiple valid Z solutions,
  // which showed up as 5–7cm single-frame foot jumps in Idle.
  updateRigWorld(rig);
  boneWorldPos(bones, pawName, _target);
  _target.y = targetY;

  for (let iter = 0; iter < iterations; iter += 1) {
    updateRigWorld(rig);
    boneWorldPos(bones, pawName, _paw);
    const err = targetY - _paw.y;
    if (Math.abs(err) < 0.0015) break;

    for (const boneName of effectors) {
      const bone = bones.get(boneName);
      if (!bone) continue;
      updateRigWorld(rig);
      boneWorldPos(bones, pawName, _paw);
      boneWorldPos(bones, boneName, _hip);

      const still = targetY - _paw.y;
      if (Math.abs(still) < 0.0015) break;

      _toEnd.subVectors(_paw, _hip);
      _toTarget.subVectors(_target, _hip);
      if (_toEnd.lengthSq() < 1e-8 || _toTarget.lengthSq() < 1e-8) continue;
      // Prefer bone-local X expressed in world (leg pitch axis):
      bone.getWorldQuaternion(_q);
      _axis.set(1, 0, 0).applyQuaternion(_q).normalize();

      // Signed shortest rotation from the current effector ray to the full
      // YZ target, projected around the hinge's world-space local-X axis.
      _projectedEnd.copy(_toEnd).addScaledVector(_axis, -_toEnd.dot(_axis));
      _projectedTarget.copy(_toTarget).addScaledVector(_axis, -_toTarget.dot(_axis));
      if (_projectedEnd.lengthSq() < 1e-8 || _projectedTarget.lengthSq() < 1e-8) continue;
      _projectedEnd.normalize();
      _projectedTarget.normalize();
      _cross.crossVectors(_projectedEnd, _projectedTarget);
      let dTheta = Math.atan2(
        _axis.dot(_cross),
        THREE.MathUtils.clamp(_projectedEnd.dot(_projectedTarget), -1, 1),
      );
      dTheta = THREE.MathUtils.clamp(dTheta, -0.16, 0.16); // ~9° per bone/iter
      bone.rotateX(dTheta);
    }

    // Keep hock above the paw after each pass (hind S-curve safety).
    if (hockName && bones.get(hockName)) {
      updateRigWorld(rig);
      boneWorldPos(bones, pawName, _paw);
      boneWorldPos(bones, hockName, _hip);
      if (_hip.y < _paw.y + 0.012) {
        // Undo a little lower-joint flex if we inverted the foot.
        const lower = bones.get(chain.lower);
        if (lower) lower.rotateX(-0.08);
      }
    }
  }
  updateRigWorld(rig);
}

/**
 * Bind-time plant: put every paw bone on a shared plane so legLength / breed
 * proportions don't leave front or hind floating before geometry is built.
 * Call before capturing rest quaternions / building mesh.
 *
 * @param {object} rig createDogSkeleton partial (bones + root, skeleton optional)
 * @param {number} [targetPawY] world Y for paw bones (pad hangs below by DOG_PAW_MESH_PAD)
 */
export function plantBindSoles(rig, targetPawY = DOG_PAW_MESH_PAD) {
  const pelvis = rig.bonesByName.get('Pelvis');
  if (!pelvis) return;

  // Bind plant is pelvis-only. Aggressive per-leg CCD here crushed the hind
  // hock into the paw (looked like missing lower joints). Runtime plantDogFeet
  // handles residual front/hind mismatch after animation without rewriting rest.
  updateRigWorld(rig);
  const { min } = meanMinPawY(rig);
  pelvis.position.y += targetPawY - min;
  updateRigWorld(rig);

  // Very light IK only when spread is large — never enough to invert hock/paw.
  const after = meanMinPawY(rig);
  const maxY = (() => {
    let m = -Infinity;
    for (const name of PAW_NAMES) {
      if (!rig.bonesByName.get(name)) continue;
      boneWorldPos(rig.bonesByName, name, _paw);
      m = Math.max(m, _paw.y);
    }
    return m;
  })();
  if (maxY - after.min > 0.028) {
    for (const chain of Object.values(LEG_CHAINS)) {
      boneWorldPos(rig.bonesByName, chain.paw, _paw);
      if (_paw.y > targetPawY + 0.012) ccdPlantLeg(rig, chain, targetPawY, 2);
    }
    updateRigWorld(rig);
    const { min: min2 } = meanMinPawY(rig);
    if (min2 < targetPawY - 0.001) {
      pelvis.position.y += targetPawY - min2;
      updateRigWorld(rig);
    }
  }
}

/**
 * Runtime plant after animation.
 *
 * @param {{ root: THREE.Object3D, rig: object, phenotype?: object }} dog
 * @param {{
 *   getGroundHeight?: (x: number, z: number) => number,
 *   enabled?: boolean,
 *   ik?: boolean,
 * }} [opts]
 * @returns {{ rootDeltaY: number, maxErr: number }}
 */
export function plantDogFeet(dog, opts = {}) {
  if (opts.enabled === false || !dog?.rig || !dog?.root) {
    return { rootDeltaY: 0, maxErr: 0 };
  }
  const getGroundHeight = opts.getGroundHeight
    ?? (() => 0);
  const useIk = opts.ik ?? dogDebugState.footIkEnabled;
  const rig = dog.rig;
  const scaleY = Math.max(1e-4, Math.abs(dog.root.scale?.y ?? 1));
  const pad = DOG_PAW_MESH_PAD * scaleY;
  const supportOffset = Math.max(
    0,
    pad - DOG_GROUND_CONTACT_COMPRESSION * scaleY,
  );

  updateRigWorld(rig);

  /** @type {{ chain: object, pawY: number, groundY: number, x: number, z: number }[]} */
  const samples = [];
  for (const chain of Object.values(LEG_CHAINS)) {
    boneWorldPos(rig.bonesByName, chain.paw, _paw);
    const gx = _paw.x;
    const gz = _paw.z;
    let groundY = getGroundHeight(gx, gz);
    if (!Number.isFinite(groundY)) groundY = dog.root.position.y;
    // Sink the rendered pad slightly into the support plane so it reads as
    // weight-bearing rather than hovering on the outer fur shell.
    samples.push({
      chain,
      pawY: _paw.y,
      groundY,
      targetPawY: groundY + supportOffset,
      x: gx,
      z: gz,
    });
  }
  if (!samples.length) return { rootDeltaY: 0, maxErr: 0 };

  // Establish the support height first. The lowest pad is authoritative, so a
  // planted rear paw cannot be pulled through the floor by the opposite end.
  let maxErrSnap = -Infinity; // target - pawY; max lifts the sunk-most foot
  let minErrSnap = Infinity;
  for (const s of samples) {
    const err = s.targetPawY - s.pawY;
    if (err > maxErrSnap) maxErrSnap = err;
    if (err < minErrSnap) minErrSnap = err;
  }
  // Bias slightly toward average so front/hind share contact on flat ground.
  const rootDeltaY = Number.isFinite(maxErrSnap)
    ? maxErrSnap * 0.55 + minErrSnap * 0.45
    : 0;
  dog.root.position.y += rootDeltaY;
  updateRigWorld(rig);

  // Absolute floor: never leave a pad underground after the blend.
  let minPad = Infinity;
  let groundAtMin = dog.root.position.y;
  for (const s of samples) {
    boneWorldPos(rig.bonesByName, s.chain.paw, _paw);
    const padY = _paw.y - supportOffset;
    if (padY < minPad) {
      minPad = padY;
      let g = getGroundHeight(_paw.x, _paw.z);
      if (!Number.isFinite(g)) g = s.groundY + rootDeltaY;
      groundAtMin = g;
    }
  }
  if (Number.isFinite(minPad) && minPad < groundAtMin - 0.001) {
    dog.root.position.y += groundAtMin - minPad;
    updateRigWorld(rig);
  }

  // Retargeted Idle flexes the forearms more than the source rest pose. With
  // the rear pads supporting the body that can leave the front pads hovering.
  // Solve only floating forelegs downward: the authored hind stifle/hock S is
  // deliberately never touched here, which avoids the old reverse-hock fold.
  if (useIk) {
    for (const s of samples) {
      if (!s.chain.front) continue;
      boneWorldPos(rig.bonesByName, s.chain.paw, _paw);
      let groundY = getGroundHeight(_paw.x, _paw.z);
      if (!Number.isFinite(groundY)) groundY = s.groundY + rootDeltaY;
      const targetY = groundY + supportOffset;
      if (_paw.y > targetY + 0.004) {
        ccdPlantLeg(rig, s.chain, targetY, 10);
      }
    }
    // Horse toe tracks pitch the dog forepaw about 30° downward in Idle.
    // Keep the solved paw position, but restore the bind-world pad plane so
    // weight lands across the pad instead of balancing on the toe tip.
    for (const s of samples) {
      if (s.chain.front) flattenPawToBindPlane(rig, s.chain.paw);
    }
    updateRigWorld(rig);
  }

  let maxErr = 0;
  for (const s of samples) {
    boneWorldPos(rig.bonesByName, s.chain.paw, _paw);
    let groundY = getGroundHeight(_paw.x, _paw.z);
    if (!Number.isFinite(groundY)) groundY = s.groundY + rootDeltaY;
    maxErr = Math.max(maxErr, Math.abs((groundY + supportOffset) - _paw.y));
  }

  return { rootDeltaY, maxErr };
}

export { PAW_NAMES };
