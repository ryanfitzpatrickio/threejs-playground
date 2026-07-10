/**
 * Gun mesh orient + Mixamo right-hand rest pose.
 *
 * Weapon space after orient: −Z = muzzle, +Y = top, +X = right.
 * Rest pose is relative to mixamorigRightHand (same idea as great-sword socket).
 *
 * Per-gun hand / support-IK sockets live in GUN_SOCKET_PRESETS; the frozen
 * MIXAMO_* / LEFT_HAND_IK_* exports are the shared AR-family fallback.
 */

import * as THREE from 'three';

/**
 * Desert Tan AR-15 hand socket (live-fit 2026-07-10 via Guns debug pane).
 * Hand attach under mixamorigRightHand, then grip snap + gun-local visual offset.
 * Euler XYZ degrees → quaternion for the attach rest pose.
 */
export const MIXAMO_RIGHT_HAND_GUN_REST_EULER_DEG = Object.freeze([
  78.16285564453351,
  7.809732444202059,
  -74.28932778278669,
]);

export const MIXAMO_RIGHT_HAND_GUN_REST_QUATERNION = Object.freeze([
  0.4694329776495109,
  0.4219226183866408,
  -0.43341342532415816,
  0.6432470647718924,
]);

/** Rest offset in meters (converted to hand-local by 1/handScale at attach). */
export const MIXAMO_RIGHT_HAND_GUN_REST_POSITION = Object.freeze([
  -0.085,
  0.035,
  0.065,
]);

/**
 * Presentation offset after grip_mount is snapped to the hand (gun-local meters).
 */
export const MIXAMO_RIGHT_HAND_GUN_VISUAL_OFFSET_METERS = Object.freeze([
  -0.01,
  0.01,
  -0.165,
]);

/**
 * Left-hand support IK (live-fit 2026-07-10). Offset from left_hand_ik_target
 * in gun-local meters; Euler XYZ ° for palm/wrist after reach.
 * Hand blend is an on/off gate in the solver (>0 hard-locks palm).
 */
export const LEFT_HAND_IK_POSITION = Object.freeze([-0.08, -0.035, 0.115]);
export const LEFT_HAND_IK_ROTATION_DEG = Object.freeze([-19.5, 39, -47]);
/** >0 = hard-lock palm to support (walk clips cannot residual-twist the wrist). */
export const LEFT_HAND_IK_HAND_BLEND = 1;

/**
 * Left elbow pole (body-local direction). Controls where the elbow points while
 * the hand stays on the support target.
 */
export const LEFT_HAND_IK_ELBOW_POLE = Object.freeze([0.3, -1, 0.15]);
/** Extra rotation of the pole around the shoulder→hand axis (degrees). */
export const LEFT_HAND_IK_ELBOW_SWING_DEG = 0;
/**
 * Preferred interior elbow angle (degrees). 0 = auto from hand distance only.
 * ~90 = right angle, ~160 = nearly straight. Clamps reach distance via law of cosines
 * (hand still aims at support; only used when reachable).
 */
export const LEFT_HAND_IK_ELBOW_BEND_DEG = 0;

/** Shared AR-family fallback socket (same numbers as the frozen exports above). */
export const DEFAULT_GUN_SOCKET_PRESET = Object.freeze({
  handPosition: [...MIXAMO_RIGHT_HAND_GUN_REST_POSITION],
  handRotationDeg: [...MIXAMO_RIGHT_HAND_GUN_REST_EULER_DEG],
  gunPosition: [...MIXAMO_RIGHT_HAND_GUN_VISUAL_OFFSET_METERS],
  gunRotationDeg: [0, 0, 0],
  gunScale: 1,
  leftIkEnabled: true,
  leftIkPosition: [...LEFT_HAND_IK_POSITION],
  leftIkRotationDeg: [...LEFT_HAND_IK_ROTATION_DEG],
  leftIkHandBlend: LEFT_HAND_IK_HAND_BLEND,
  leftIkElbowPole: [...LEFT_HAND_IK_ELBOW_POLE],
  leftIkElbowSwingDeg: LEFT_HAND_IK_ELBOW_SWING_DEG,
  leftIkElbowBendDeg: LEFT_HAND_IK_ELBOW_BEND_DEG,
});

/**
 * Per-catalog-gun hand / support sockets (Guns debug pane live-fit).
 * Missing ids fall back to DEFAULT_GUN_SOCKET_PRESET.
 */
export const GUN_SOCKET_PRESETS = Object.freeze({
  // Midnight Glock — live-fit 2026-07 (pistol two-hand grip).
  'midnight-glock': Object.freeze({
    handPosition: Object.freeze([-0.055, 0.035, 0.065]),
    handRotationDeg: Object.freeze([
      101.66285564453351,
      7.809732444202059,
      -89.78932778278669,
    ]),
    gunPosition: Object.freeze([0.01, 0.01, -0.12]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.07, -0.06, 0.14]),
    leftIkRotationDeg: Object.freeze([-47, 39, -39]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: -8,
    leftIkElbowBendDeg: 0,
  }),
});

/**
 * @param {string} [gunId]
 * @returns {typeof DEFAULT_GUN_SOCKET_PRESET}
 */
export function getGunSocketPreset(gunId) {
  if (gunId && GUN_SOCKET_PRESETS[gunId]) {
    return GUN_SOCKET_PRESETS[gunId];
  }
  return DEFAULT_GUN_SOCKET_PRESET;
}

export function getMixamoRightHandGunRestQuaternion(out = new THREE.Quaternion()) {
  return out.fromArray(MIXAMO_RIGHT_HAND_GUN_REST_QUATERNION).normalize();
}

/**
 * Orient mesh: longest AABB axis → −Z (muzzle), next → +Y (top), then
 * 180° Y flip so Meshy AR muzzle (−X source) ends on −Z.
 */
export function orientGunMeshToWeaponSpace(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    return { forwardAxis: 'z', upAxis: 'y', length: 0, height: 0, width: 0 };
  }
  const size = box.getSize(new THREE.Vector3());
  const axes = [
    { axis: 'x', size: size.x },
    { axis: 'y', size: size.y },
    { axis: 'z', size: size.z },
  ].sort((a, b) => b.size - a.size);

  const longest = axes[0].axis;
  const upCandidate = size.y >= Math.min(size.x, size.z) * 0.9
    ? 'y'
    : axes[1].axis;

  const fromForward = axisVector(longest);
  const toForward = new THREE.Vector3(0, 0, -1);
  const q1 = new THREE.Quaternion().setFromUnitVectors(fromForward, toForward);

  const fromUp = axisVector(upCandidate).applyQuaternion(q1).normalize();
  const toUp = new THREE.Vector3(0, 1, 0);
  fromUp.addScaledVector(toForward, -fromUp.dot(toForward));
  if (fromUp.lengthSq() < 1e-8) fromUp.set(0, 1, 0);
  else fromUp.normalize();
  const q2 = new THREE.Quaternion().setFromUnitVectors(fromUp, toUp);
  const orient = q2.multiply(q1);

  // Meshy AR: muzzle on −X of longest → flip so −Z is muzzle end.
  const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  const visual = new THREE.Group();
  visual.name = 'GunVisual';
  for (const child of [...root.children]) {
    root.remove(child);
    visual.add(child);
  }
  visual.quaternion.copy(orient).multiply(flip);
  root.add(visual);

  visual.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(visual);
  const center = box2.getCenter(new THREE.Vector3());
  visual.position.x -= center.x;
  visual.position.z -= center.z;
  visual.position.y -= box2.min.y;
  visual.updateMatrixWorld(true);

  const finalSize = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  return {
    forwardAxis: 'z',
    upAxis: 'y',
    length: finalSize.z,
    height: finalSize.y,
    width: finalSize.x,
  };
}

function axisVector(axis) {
  if (axis === 'x') return new THREE.Vector3(1, 0, 0);
  if (axis === 'y') return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

/** Anchors in weapon space (−Z muzzle, +Z stock). */
export function buildAnchorsFromOrientedBounds(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const zMin = box.min.z;
  const zMax = box.max.z;
  const yMin = box.min.y;
  const h = size.y;
  const midY = yMin + h * 0.32;
  // Pistol grip roughly under receiver center-rear.
  const gripZ = zMin + (zMax - zMin) * 0.58;
  const handguardZ = zMin + (zMax - zMin) * 0.30;
  return {
    grip_mount: {
      name: 'grip_mount',
      position: [0, midY, gripZ],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    left_hand_ik_target: {
      name: 'left_hand_ik_target',
      position: [0.015, midY + h * 0.06, handguardZ],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    muzzle: {
      name: 'muzzle',
      position: [0, midY + h * 0.04, zMin + 0.01],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    adsCamera: {
      name: 'adsCamera',
      position: [0, yMin + h * 0.82, gripZ - size.z * 0.08],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    mag_socket: {
      name: 'mag_socket',
      position: [0, yMin + h * 0.08, gripZ],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    ejection_port: {
      name: 'ejection_port',
      position: [0.03, midY + h * 0.12, gripZ - size.z * 0.04],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    stock_shoulder: {
      name: 'stock_shoulder',
      position: [0, midY, zMax - 0.015],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
  };
}

export function applyMixamoRightHandGunRest(gunRoot) {
  if (!gunRoot) return;
  const [x, y, z] = MIXAMO_RIGHT_HAND_GUN_REST_POSITION;
  gunRoot.position.set(x, y, z);
  gunRoot.quaternion.copy(getMixamoRightHandGunRestQuaternion());
}
