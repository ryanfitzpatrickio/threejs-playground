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
  0.055,
  -0.02,
  -0.065,
]);

/**
 * Left-hand support IK (Desert AR-15 live-fit 2026-07-10). Offset from
 * left_hand_ik_target in gun-local meters; Euler XYZ ° for palm/wrist after reach.
 * Hand blend is an on/off gate in the solver (>0 hard-locks palm).
 */
export const LEFT_HAND_IK_POSITION = Object.freeze([-0.055, 0.025, 0.06]);
export const LEFT_HAND_IK_ROTATION_DEG = Object.freeze([-78.5, -11.5, -39]);
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

/**
 * Right-hand (dominant grip) IK — mirror of the left support solve. The gun is
 * anchored in body space (chest holder) and the right arm reaches grip_mount, so
 * moving the gun in the debug pane pulls the right hand with it. Offset from
 * grip_mount in gun-local meters; Euler XYZ ° for palm/wrist after reach.
 */
export const RIGHT_HAND_IK_ENABLED = true;
export const RIGHT_HAND_IK_POSITION = Object.freeze([0.01, 0, 0.175]);
export const RIGHT_HAND_IK_ROTATION_DEG = Object.freeze([-86, -98, 0]);
/** >0 = hard-lock palm to grip (walk clips cannot residual-twist the wrist). */
export const RIGHT_HAND_IK_HAND_BLEND = 1;
/** Right elbow pole (body-local): right + down + slightly forward (mirror of left). */
export const RIGHT_HAND_IK_ELBOW_POLE = Object.freeze([-0.3, -1, 0.15]);
export const RIGHT_HAND_IK_ELBOW_SWING_DEG = 0;
export const RIGHT_HAND_IK_ELBOW_BEND_DEG = 0;

/**
 * Base gun pose in chest-anchor (body) space — meters + Euler XYZ °. Meant to be
 * re-fit live in the Guns debug pane; +X = character left, +Y = up, +Z = forward,
 * so a right-shoulder hold sits at −X and the muzzle points +Z (gun −Z + 180° Y).
 */
export const BODY_ANCHORED_GUN_REST_POSITION = Object.freeze([-0.12, -0.05, 0.30]);
export const BODY_ANCHORED_GUN_REST_EULER_DEG = Object.freeze([0, 180, 0]);

/** Look-pitch multipliers (gun holder + spine). Input is view pitch (+ = look up).
 *  Negative flips direction. Both use the same sign: body +Z forward, rotateX /
 *  Mixamo local-X need a negative multiplier to raise the muzzle / arch the back. */
export const AIM_PITCH_GUN = -1;
export const AIM_PITCH_SPINE = -0.6;

/** Shared AR-family fallback socket (Desert AR-15 live-fit; chest-anchored dual-hand IK). */
export const DEFAULT_GUN_SOCKET_PRESET = Object.freeze({
  handPosition: [...BODY_ANCHORED_GUN_REST_POSITION],
  handRotationDeg: [...BODY_ANCHORED_GUN_REST_EULER_DEG],
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
  rightIkEnabled: RIGHT_HAND_IK_ENABLED,
  rightIkPosition: [...RIGHT_HAND_IK_POSITION],
  rightIkRotationDeg: [...RIGHT_HAND_IK_ROTATION_DEG],
  rightIkHandBlend: RIGHT_HAND_IK_HAND_BLEND,
  rightIkElbowPole: [...RIGHT_HAND_IK_ELBOW_POLE],
  rightIkElbowSwingDeg: RIGHT_HAND_IK_ELBOW_SWING_DEG,
  rightIkElbowBendDeg: RIGHT_HAND_IK_ELBOW_BEND_DEG,
  aimPitchGun: AIM_PITCH_GUN,
  aimPitchSpine: AIM_PITCH_SPINE,
});

/** Shared long-gun dual-hand chest IK (cloned from desert-scar live-fit). */
function freezeRifleSocketPreset(overrides = null) {
  const base = {
    handPosition: Object.freeze([-0.11, -0.055, 0.25]),
    handRotationDeg: Object.freeze([0, 180, 0]),
    gunPosition: Object.freeze([0.055, -0.02, -0.065]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.055, 0.025, 0.045]),
    leftIkRotationDeg: Object.freeze([-78.5, -11.5, -39]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.015, -0.005, 0.125]),
    rightIkRotationDeg: Object.freeze([-86, -98, 0]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  };
  if (!overrides) return Object.freeze(base);
  return Object.freeze({ ...base, ...overrides });
}

/**
 * Per-catalog-gun hand / support sockets (Guns debug pane live-fit).
 * Missing ids fall back to DEFAULT_GUN_SOCKET_PRESET.
 */
export const GUN_SOCKET_PRESETS = Object.freeze({
  // Desert Tan AR-15 — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'desert-ar15': Object.freeze({
    handPosition: Object.freeze([-0.185, -0.085, 0.36]),
    handRotationDeg: Object.freeze([0, 180, 0]),
    gunPosition: Object.freeze([0, 0, 0]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.065, -0.025, 0.01]),
    leftIkRotationDeg: Object.freeze([-78.5, -8, -62.5]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.5, -0.9, 0.25]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.01, 0, 0.05]),
    rightIkRotationDeg: Object.freeze([-82, -78.5, -4]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // Desert Tan SCAR — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'desert-scar': Object.freeze({
    handPosition: Object.freeze([-0.11, -0.055, 0.25]),
    handRotationDeg: Object.freeze([0, 180, 0]),
    gunPosition: Object.freeze([0.055, -0.02, -0.065]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.07, 0, -0.005]),
    leftIkRotationDeg: Object.freeze([-78.5, -8, -66.5]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.01, 0, 0.035]),
    rightIkRotationDeg: Object.freeze([-86, -98, 0]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // Modern AR-15 — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'modern-ar15': Object.freeze({
    handPosition: Object.freeze([-0.13, -0.035, 0.37]),
    handRotationDeg: Object.freeze([0, -180, 0]),
    gunPosition: Object.freeze([0, 0, 0]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.055, -0.04, 0.085]),
    leftIkRotationDeg: Object.freeze([-101.5, -23.5, -66.5]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.005, -0.005, 0.065]),
    rightIkRotationDeg: Object.freeze([-78.5, -86, 0]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // AK-47 — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'ak47': Object.freeze({
    handPosition: Object.freeze([-0.14, -0.045, 0.27]),
    handRotationDeg: Object.freeze([0, 180, 0]),
    gunPosition: Object.freeze([0.045, -0.035, -0.075]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.035, -0.035, 0.09]),
    leftIkRotationDeg: Object.freeze([-78.5, -11.5, -39]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.01, 0, 0.06]),
    rightIkRotationDeg: Object.freeze([-86, -98, 0]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // Folding-stock AR — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'folding-stock-ar': Object.freeze({
    handPosition: Object.freeze([-0.12, -0.1, 0.26]),
    handRotationDeg: Object.freeze([0, 180, 4]),
    gunPosition: Object.freeze([0.065, 0, -0.055]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.075, 0, 0.055]),
    leftIkRotationDeg: Object.freeze([-98, -15.5, -70.5]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.025, 0.015, 0.1]),
    rightIkRotationDeg: Object.freeze([-94, -94, -4]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // Obsidian carbine — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'obsidian-carbine': Object.freeze({
    handPosition: Object.freeze([-0.12, -0.075, 0.24]),
    handRotationDeg: Object.freeze([0, 180, 0]),
    gunPosition: Object.freeze([0.045, -0.035, -0.065]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.04, -0.02, 0.07]),
    leftIkRotationDeg: Object.freeze([-70.5, 19.5, -31.5]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.035, 0.025, 0.035]),
    rightIkRotationDeg: Object.freeze([-86, -129, -4]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // Olive bullpup — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'olive-bullpup': Object.freeze({
    handPosition: Object.freeze([-0.12, -0.065, 0.185]),
    handRotationDeg: Object.freeze([0, 180, 0]),
    gunPosition: Object.freeze([0.055, -0.035, -0.065]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.02, -0.025, 0.09]),
    leftIkRotationDeg: Object.freeze([-90, 113.5, 0]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.015, -0.005, 0.08]),
    rightIkRotationDeg: Object.freeze([-90, -98, 0]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -0.25, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // Tactical Pump Shotgun — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'tactical-shotgun': Object.freeze({
    handPosition: Object.freeze([-0.01, 0.12, 0.315]),
    handRotationDeg: Object.freeze([0, -180, 0]),
    gunPosition: Object.freeze([0.205, -0.205, -0.065]),
    gunRotationDeg: Object.freeze([0, 0, 8]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.065, -0.025, 0.07]),
    leftIkRotationDeg: Object.freeze([-62.5, 4, 11.5]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.55, -1, -0.65]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.015, -0.02, 0.06]),
    rightIkRotationDeg: Object.freeze([-180, -180, -90]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.05, -1.15, -0.35]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // Desert Sentinel — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'desert-sentinel': Object.freeze({
    handPosition: Object.freeze([-0.11, -0.055, 0.25]),
    handRotationDeg: Object.freeze([0, 180, 0]),
    gunPosition: Object.freeze([0.055, -0.02, -0.065]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 1,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.045, -0.025, 0.085]),
    leftIkRotationDeg: Object.freeze([-78.5, -11.5, -39]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.3, -1, 0.15]),
    leftIkElbowSwingDeg: 0,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.035, -0.06, 0.25]),
    rightIkRotationDeg: Object.freeze([-86, -98, 0]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1, 0.15]),
    rightIkElbowSwingDeg: 0,
    rightIkElbowBendDeg: 0,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
  }),
  // Midnight Glock — live-fit 2026-07-11 (chest-anchored dual-hand IK).
  'midnight-glock': Object.freeze({
    handPosition: Object.freeze([-0.13, 0.02, 0.465]),
    handRotationDeg: Object.freeze([4, 180, 0]),
    gunPosition: Object.freeze([0, 0, -0.01]),
    gunRotationDeg: Object.freeze([0, 0, 0]),
    gunScale: 0.98,
    leftIkEnabled: true,
    leftIkPosition: Object.freeze([-0.105, 0.01, 0.12]),
    leftIkRotationDeg: Object.freeze([152.5, 105.5, 101.5]),
    leftIkHandBlend: 1,
    leftIkElbowPole: Object.freeze([0.25, -1.1, -0.15]),
    leftIkElbowSwingDeg: 8,
    leftIkElbowBendDeg: 0,
    rightIkEnabled: true,
    rightIkPosition: Object.freeze([0.01, 0, 0.075]),
    rightIkRotationDeg: Object.freeze([-74.5, -94, 11.5]),
    rightIkHandBlend: 1,
    rightIkElbowPole: Object.freeze([-0.3, -1.15, -0.45]),
    rightIkElbowSwingDeg: -31,
    rightIkElbowBendDeg: 170,
    aimPitchGun: -1,
    aimPitchSpine: -0.6,
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
  visual.updateMatrix();

  const finalSize = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  return {
    forwardAxis: 'z',
    upAxis: 'y',
    length: finalSize.z,
    height: finalSize.y,
    width: finalSize.x,
    // Maps an anchor authored against the source GLB into canonical weapon
    // space (−Z muzzle, +Y top). Kept as a Matrix4 for the legacy Gunsmith
    // migration path; new editor profiles are authored in weapon space.
    anchorTransform: visual.matrix.clone(),
  };
}

/** Convert source-GLB anchor coordinates into canonical weapon space. */
export function transformGunAnchorsToWeaponSpace(anchors, anchorTransform) {
  if (!Array.isArray(anchors) || !anchorTransform) return anchors ?? [];
  const transformRotation = new THREE.Quaternion().setFromRotationMatrix(anchorTransform);
  return anchors.map((anchor) => {
    const position = new THREE.Vector3().fromArray(anchor?.position ?? [0, 0, 0])
      .applyMatrix4(anchorTransform);
    const quaternion = transformRotation.clone().multiply(
      new THREE.Quaternion().fromArray(anchor?.quaternion ?? [0, 0, 0, 1]),
    ).normalize();
    return {
      ...anchor,
      position: position.toArray(),
      quaternion: quaternion.toArray(),
    };
  });
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
    mag_insert: {
      name: 'mag_insert',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    mag_belt_source: {
      name: 'mag_belt_source',
      position: [size.x * 0.22, yMin - h * 0.30, gripZ + size.z * 0.10],
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
