/**
 * Per-vertex coat fields for a plush golden-retriever read.
 * Short face, medium body volume, long ears/ruff/plume.
 */

import * as THREE from 'three';

export const COAT_ZONE = {
  body: 0,
  belly: 1,
  head: 2,
  muzzle: 3,
  ear: 4,
  leg: 5,
  paw: 6,
  tail: 7,
};

/**
 * Head groom: lays back/down (plush, not radial spikes).
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} headCenter
 */
export function headGroomAt(p, headCenter) {
  const local = p.clone().sub(headCenter);
  const flow = new THREE.Vector3(local.x * 0.4, -0.25, -0.9);
  flow.x += local.x * 0.2;
  if (flow.lengthSq() < 1e-8) flow.set(0, -0.15, -1);
  flow.normalize();
  return [flow.x, flow.y, flow.z];
}

/**
 * Body coat lays back along the torso.
 * @param {THREE.Vector3} p
 */
export function bodyGroomAt(p) {
  const g = new THREE.Vector3(p.x * 0.18, -0.28, -1);
  g.normalize();
  return [g.x, g.y, g.z];
}

/**
 * @param {number} side +1 L / -1 R
 */
export function earGroomAt(side) {
  // Outward-down: fur lifts off the leather instead of extending the drape.
  const g = new THREE.Vector3(side * 0.45, -0.85, -0.15);
  g.normalize();
  return [g.x, g.y, g.z];
}

/**
 * Absolute fur length (metres). Must be long enough for shell volume to read.
 * @param {number} zone
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} [headCenter]
 */
export function lengthAt(zone, p, headCenter, phenotype = null) {
  let baseLength;
  switch (zone) {
    case COAT_ZONE.muzzle: baseLength = 0.0035; break;
    case COAT_ZONE.paw: baseLength = 0.007; break;
    case COAT_ZONE.leg: baseLength = 0.028; break;
    case COAT_ZONE.ear: baseLength = 0.03; break;
    case COAT_ZONE.tail: baseLength = 0.06; break;
    case COAT_ZONE.head: {
      if (!headCenter) { baseLength = 0.026; break; }
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      const localX = Math.abs(p.x - headCenter.x);
      // Face front: short so eyes/nose sit cleanly.
      if (localZ > 0.038) { baseLength = 0.004; break; }
      // Under-ear patch: the ear leather lies here — short head fur so the
      // ear reads as its own surface instead of drowning in cheek fluff.
      if (localZ < -0.004 && localX > 0.04 && localY < 0.045) { baseLength = 0.006; break; }
      // Crown: short smooth cap (ref dome reads as one surface).
      if (localY > 0.025) { baseLength = 0.02; break; }
      // Cheeks / sides: soft short feather — long fluff here petals out.
      if (localX > 0.025) { baseLength = 0.026; break; }
      baseLength = 0.026;
      break;
    }
    case COAT_ZONE.belly: baseLength = 0.034; break;
    default: {
      // Neck band draped by the ear leather: covered fur stays short so the
      // ear hangs in front of the neck fluff instead of drowning in it.
      if (headCenter) {
        const lx = Math.abs(p.x - headCenter.x);
        const lz = p.z - headCenter.z;
        const ly = p.y - headCenter.y;
        if (lx > 0.035 && lz < 0.01 && lz > -0.09 && ly < 0.02 && ly > -0.13) {
          baseLength = 0.004;
          break;
        }
      }
      // Neck ruff longer; body medium-plush for volume.
      if (baseLength == null) baseLength = p.z > 0.18 && p.y > 0.38 ? 0.038 : 0.035;
    }
  }
  const coat = phenotype?.coat;
  if (!coat) return baseLength;
  const zoneKey = zone === COAT_ZONE.body || zone === COAT_ZONE.belly ? 'body'
    : zone === COAT_ZONE.head ? 'head'
      : zone === COAT_ZONE.muzzle ? 'muzzle'
        : zone === COAT_ZONE.ear ? 'ears'
          : zone === COAT_ZONE.leg ? 'legs'
            : zone === COAT_ZONE.paw ? 'paws'
              : 'tail';
  return baseLength * (coat.length ?? 1) * (coat[zoneKey] ?? 1);
}

/**
 * 0 = cream undercoat, 1 = rich golden guard.
 * @param {number} zone
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} [headCenter]
 */
export function colorMaskAt(zone, p, headCenter, phenotype = null) {
  const pattern = phenotype?.coat?.pattern ?? 'golden-shade';
  if (pattern === 'black-tan') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.92;
    if (zone === COAT_ZONE.leg) return p.y < 0.25 ? 0.82 : 0.04;
    if (zone === COAT_ZONE.head && headCenter && p.y < headCenter.y - 0.005) return 0.42;
    return 0.025;
  }
  if (pattern === 'saddle') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw || zone === COAT_ZONE.leg) return 0.08;
    if (zone === COAT_ZONE.head || zone === COAT_ZONE.ear) return 0.72;
    if (zone === COAT_ZONE.tail) return 0.55;
    return THREE.MathUtils.clamp(0.2 + THREE.MathUtils.smoothstep(p.y, 0.38, 0.56) * 0.72, 0, 1);
  }
  if (pattern === 'brindle-mask') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.ear) return 0.86;
    return THREE.MathUtils.clamp(0.28 + (Math.sin(p.z * 105 + p.x * 38) * 0.5 + 0.5) * 0.42, 0, 1);
  }
  if (pattern === 'salt-pepper') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.leg || zone === COAT_ZONE.paw) return 0.32;
    return THREE.MathUtils.clamp(0.38 + Math.sin(p.x * 113 + p.y * 71 + p.z * 47) * 0.2, 0, 1);
  }
  if (pattern === 'tan-points') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.18;
    return 0.55;
  }
  if (pattern === 'hound-saddle') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw || zone === COAT_ZONE.leg) return 0.08;
    if (zone === COAT_ZONE.ear) return 0.18;
    if (zone === COAT_ZONE.head && headCenter) {
      return p.y > headCenter.y + 0.018 ? 0.62 : 0.12;
    }
    if (zone === COAT_ZONE.tail) return p.y > 0.25 ? 0.7 : 0.12;
    return THREE.MathUtils.clamp(0.12 + THREE.MathUtils.smoothstep(p.y, 0.34, 0.48) * 0.82, 0, 1);
  }
  if (pattern === 'liver-roan') {
    if (zone === COAT_ZONE.head || zone === COAT_ZONE.ear || zone === COAT_ZONE.muzzle) return 0.9;
    const ticking = Math.sin(p.x * 181 + p.y * 137 + p.z * 223) * 0.5 + 0.5;
    return THREE.MathUtils.clamp(0.18 + ticking * 0.58, 0, 1);
  }
  if (pattern === 'pied') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.08;
    const patch = Math.sin(p.x * 17 + p.z * 13) + Math.sin(p.y * 19 - p.z * 8);
    return THREE.MathUtils.smoothstep(patch, -0.15, 0.65);
  }
  if (pattern === 'blenheim') {
    if (zone === COAT_ZONE.ear) return 0.98;
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.04;
    if (zone === COAT_ZONE.head && headCenter) {
      const blaze = 1 - THREE.MathUtils.smoothstep(Math.abs(p.x - headCenter.x), 0.006, 0.026);
      return THREE.MathUtils.clamp(0.94 - blaze * 0.9, 0, 1);
    }
    const patch = Math.sin(p.x * 20 + p.z * 11) + Math.cos(p.y * 14 - p.z * 9);
    return THREE.MathUtils.smoothstep(patch, 0.1, 0.72);
  }
  if (pattern === 'blue-tan') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.head || zone === COAT_ZONE.paw) return 0.06;
    if (zone === COAT_ZONE.leg) return THREE.MathUtils.smoothstep(p.y, 0.16, 0.3);
    if (zone === COAT_ZONE.ear) return 0.18;
    return 0.9;
  }
  if (pattern === 'blue-merle') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.12;
    const broadPatch = Math.sin(p.x * 19 + p.z * 15) + Math.cos(p.y * 17 - p.z * 11);
    const fleck = Math.sin(p.x * 91 + p.y * 73 + p.z * 119) * 0.18;
    return THREE.MathUtils.clamp(THREE.MathUtils.smoothstep(broadPatch, -0.4, 0.55) + fleck, 0, 1);
  }
  if (pattern === 'red-white') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.04;
    if (zone === COAT_ZONE.leg) return THREE.MathUtils.smoothstep(p.y, 0.12, 0.28);
    if (zone === COAT_ZONE.head && headCenter) {
      const blaze = 1 - THREE.MathUtils.smoothstep(Math.abs(p.x - headCenter.x), 0.006, 0.024);
      return THREE.MathUtils.clamp(0.9 - blaze * 0.86, 0, 1);
    }
    return zone === COAT_ZONE.body || zone === COAT_ZONE.tail ? 0.86 : 0.7;
  }
  if (pattern === 'fawn-mask') {
    // Boxer-style: black mask on muzzle + periocular face only; ears and body stay fawn.
    if (zone === COAT_ZONE.muzzle) return 0.96;
    if (zone === COAT_ZONE.ear) return 0.1;
    if (zone === COAT_ZONE.head && headCenter) {
      const localZ = p.z - headCenter.z;
      const localY = p.y - headCenter.y;
      // Front face / eye band — dark mask; crown and cheeks remain fawn.
      if (localZ > 0.012 && localY < 0.028) return 0.9;
      if (localZ > 0.0 && localY < 0.01) return 0.55;
      return 0.12;
    }
    return 0.07;
  }
  if (pattern === 'parti') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.08;
    const patch = Math.sin(p.x * 18 + p.z * 13) + Math.cos(p.y * 15 - p.z * 10);
    return THREE.MathUtils.smoothstep(patch, 0.05, 0.75);
  }
  if (pattern === 'tuxedo') {
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.04;
    if (zone === COAT_ZONE.leg) return p.y < 0.22 ? 0.08 : 0.9;
    if (zone === COAT_ZONE.head && headCenter) {
      const blaze = 1 - THREE.MathUtils.smoothstep(Math.abs(p.x - headCenter.x), 0.004, 0.02);
      return THREE.MathUtils.clamp(0.94 - blaze * 0.88, 0, 1);
    }
    if (zone === COAT_ZONE.body && p.z > 0.34 && p.y < 0.48) return 0.08;
    return 0.94;
  }
  if (pattern === 'husky-mask') {
    if (zone === COAT_ZONE.belly || zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.03;
    if (zone === COAT_ZONE.leg) return THREE.MathUtils.smoothstep(p.y, 0.16, 0.34) * 0.72;
    if (zone === COAT_ZONE.ear) return 0.88;
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = Math.abs(p.x - headCenter.x);
      const localY = p.y - headCenter.y;
      const blaze = 1 - THREE.MathUtils.smoothstep(localX, 0.009, 0.032);
      const lowerFace = 1 - THREE.MathUtils.smoothstep(localY, -0.02, 0.018);
      return THREE.MathUtils.clamp(0.92 - blaze * 0.9 - lowerFace * 0.5, 0, 1);
    }
    if (zone === COAT_ZONE.tail) return 0.46;
    // Body: light lower flanks/chest rising to a dark saddle over the back —
    // the previous floor (0.52) never let the torso read lighter than mid-gray,
    // so the whole body looked like a flat wash instead of the ref's clear
    // light-body / dark-mantle split.
    return THREE.MathUtils.clamp(0.12 + THREE.MathUtils.smoothstep(p.y, 0.26, 0.56) * 0.8, 0, 1);
  }
  if (pattern === 'solid') return 0.35;
  if (zone === COAT_ZONE.belly) return 0.06;
  if (zone === COAT_ZONE.muzzle) return 0.18;
  if (zone === COAT_ZONE.paw) return 0.14;
  if (zone === COAT_ZONE.ear) return 0.95;
  if (zone === COAT_ZONE.head && headCenter) {
    const localY = p.y - headCenter.y;
    const localZ = p.z - headCenter.z;
    // Base mid-gold; richer crown; cream only on the muzzle front/chin —
    // the face between the eyes stays golden (ref).
    let m = 0.62;
    if (localY > 0.02) m = 0.8;
    if (localY < -0.01) m = 0.42;
    if (localZ > 0.045 && localY < 0.01) m = 0.06;
    if (localZ > 0.02 && localY < -0.015) m = 0.15;
    return m;
  }
  const dorsal = THREE.MathUtils.smoothstep(p.y, 0.36, 0.56);
  return THREE.MathUtils.clamp(0.3 + dorsal * 0.5, 0, 1);
}

/**
 * Subtle crown part.
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} headCenter
 */
export function hairPartStrength(p, headCenter) {
  if (p.y < headCenter.y + 0.015) return 0;
  // Only the forehead/crown front — a full-length groove notches the silhouette.
  const localZ = p.z - headCenter.z;
  if (localZ < -0.01 || localZ > 0.05) return 0;
  return (1 - THREE.MathUtils.smoothstep(Math.abs(p.x - headCenter.x), 0.0, 0.02)) * 0.32;
}
