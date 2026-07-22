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
 * Pack per-vertex coat payload into the single `coatMask` buffer attribute.
 * Layout matches dogBodyGeometry / dogFurMaterial decode:
 *   packed = colorMask + (earInner ? 2 : 0) + zone * 4
 * colorMask is 0..1 (undercoat→guard); earInner flag occupies the +2 band.
 * @param {number} colorMask
 * @param {number} zone COAT_ZONE.*
 * @param {boolean} [earInner]
 */
export function packCoatMask(colorMask, zone, earInner = false) {
  const mask = THREE.MathUtils.clamp(Number(colorMask) || 0, 0, 1);
  const z = Number(zone) || 0;
  return mask + (earInner ? 2 : 0) + z * 4;
}

/**
 * Unpack `coatMask` buffer values stamped by packCoatMask / dogBodyGeometry.
 * @param {number} packed
 * @returns {{ zone: number, colorMask: number, earInner: boolean }}
 */
export function unpackCoatMask(packed) {
  const p = Number(packed) || 0;
  const zone = Math.floor(p / 4);
  const payload = p - zone * 4;
  const earInner = payload >= 1.5;
  const colorMask = payload - (earInner ? 2 : 0);
  return { zone, colorMask, earInner };
}

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
  let len = baseLength * (coat.length ?? 1) * (coat[zoneKey] ?? 1);

  // Coarse-guard fiber: shorter undercoat/body shells, longer sparse furnishings feel.
  const fiber = coat.fiber ?? 'soft';
  if (fiber === 'coarse-guard') {
    if (zone === COAT_ZONE.body || zone === COAT_ZONE.leg) len *= 0.78;
    if (zone === COAT_ZONE.belly) len *= 1.12;
    if (zone === COAT_ZONE.head) len *= 0.85;
    if (zone === COAT_ZONE.muzzle) len *= 0.7;
    if (zone === COAT_ZONE.paw) len *= 0.35;
  }

  // Cloven/solid hooves + rodent paws: bare pad / pink skin — almost no shell fur.
  const foot = phenotype?.extremities?.foot ?? 'paw';
  if ((foot === 'cloven-hoof' || foot === 'solid-hoof' || foot === 'rodent-paw')
    && zone === COAT_ZONE.paw) {
    len *= foot === 'rodent-paw' ? 0.05 : 0.08;
  }
  if ((foot === 'cloven-hoof' || foot === 'solid-hoof' || foot === 'rodent-paw')
    && zone === COAT_ZONE.leg) {
    // bareBelow: 0.75–1 → short fur climbs higher up the pastern/forearm.
    // Rodents bare more of the distal limb (skinny pink ankles).
    const bare = THREE.MathUtils.clamp(phenotype?.extremities?.bareBelow ?? 0.75, 0.3, 1);
    const bareY = foot === 'rodent-paw' ? 0.16 + bare * 0.12 : 0.12 + bare * 0.1;
    if (p.y < bareY) {
      len *= foot === 'rodent-paw'
        ? THREE.MathUtils.lerp(0.22, 0.04, bare)
        : THREE.MathUtils.lerp(0.35, 0.08, bare);
    }
  }

  return len;
}

/**
 * 0 = cream undercoat, 1 = rich golden guard.
 * @param {number} zone
 * @param {THREE.Vector3} p
 * @param {THREE.Vector3} [headCenter]
 * @param {object|null} [phenotype]
 * @param {{ alongT?: number }|null} [opts] alongT = loft parameter 0..1 for tail
 */
export function colorMaskAt(zone, p, headCenter, phenotype = null, opts = null) {
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
  if (pattern === 'tortoiseshell') {
    // Ref board (public/assets/cat-ref/tortoiseshell): black-DOMINANT coat
    // broken by brindled ginger AND chocolate patches. Key landmarks: large
    // ginger saddle across the mid-back, small orange chest patch on an
    // otherwise black chest, pale/tan lower legs and toes, split face with an
    // orange nose-bridge blaze, near-black ears.
    // TRI-COLOR mask (palette.midcoat): 0 → undercoat (ginger), 0.5 →
    // midcoat (chocolate brown), 1 → guard (near-black). Black/ginger still
    // binarize; a second independent blob field then pulls regions to 0.5 so
    // brown reads as its own patches, not as a blend rim.
    // The old field's wavelength (~0.55m) exceeded the cat body, collapsing
    // into one blob — patch blobs here are ~0.15–0.25m with fine brindle
    // ticking dithering the edges so patches read mottled, not painted.
    // Anatomy space (verify: dump worldBindPos): torso spine y 0.34–0.47,
    // z −0.23…+0.26; back surface tops out ~y 0.52; elbows y≈0.26, pasterns
    // y≈0.04. The torso loft has only 7 stations along the spine (~9cm apart)
    // so along-body frequencies must stay ≲24 or they alias into smears.
    const blob = Math.sin(p.x * 24 + p.z * 19 + Math.sin(p.y * 23) * 1.4)
      + Math.sin(p.y * 27 - p.z * 22 + Math.sin(p.x * 19) * 1.2);
    const brindle = Math.sin(p.x * 68 + p.y * 52 + p.z * 60) * 0.5 + 0.5;
    // Brown-patch selector — decorrelated from `blob` (different phases/freqs)
    // so chocolate lands independently of the black/ginger split.
    const blob2 = Math.sin(p.x * 19 - p.z * 23 + Math.sin(p.y * 17) * 1.3)
      + Math.sin(p.y * 21 + p.z * 15 - Math.sin(p.x * 14) * 1.1);
    const brown = THREE.MathUtils.smoothstep(
      blob2 * 0.34 + 0.56 + (brindle - 0.5) * 0.26, 0.6, 0.72,
    );
    let m = THREE.MathUtils.smoothstep(
      blob * 0.34 + 0.72 + (brindle - 0.5) * 0.3, 0.48, 0.64,
    );
    m = THREE.MathUtils.smoothstep(m, 0.3, 0.62);
    m = THREE.MathUtils.lerp(m, 0.5, brown * 0.92);
    if (zone === COAT_ZONE.ear) return THREE.MathUtils.clamp(0.93 + brindle * 0.04, 0, 0.97);
    if (zone === COAT_ZONE.paw) {
      // Cream toes with occasional black toe-spots (ref front-sit).
      return brindle > 0.86 ? 0.72 : 0.06;
    }
    if (zone === COAT_ZONE.leg) {
      // Brindled dark upper legs; only the pastern/foot fades to pale tan
      // (ref profile — rear feet tan, front legs stay mottled to the toes).
      const pale = 1 - THREE.MathUtils.smoothstep(p.y, 0.05, 0.16);
      let ml = THREE.MathUtils.smoothstep(
        blob * 0.34 + 0.74 + (brindle - 0.5) * 0.3, 0.48, 0.64,
      );
      ml = THREE.MathUtils.smoothstep(ml, 0.3, 0.62);
      ml = THREE.MathUtils.lerp(ml, 0.5, brown * 0.8);
      return THREE.MathUtils.clamp(THREE.MathUtils.lerp(ml, 0.07, pale), 0.03, 0.97);
    }
    if (zone === COAT_ZONE.muzzle && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      // Orange blaze down the nose bridge; chin/jaw sides stay dark.
      if (localY > 0 && Math.abs(localX) < 0.018) return 0.12;
      return THREE.MathUtils.clamp(0.84 + (brindle - 0.5) * 0.22, 0, 0.95);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      // Head sphere is dense (48×36) so it can carry a finer mottle than the
      // torso loft. Mostly-dark face, ginger flecking, classic tortie split
      // (one side leans ginger), and an orange blaze between the eyes.
      const localX = p.x - headCenter.x;
      const localZ = p.z - headCenter.z;
      const fleck = Math.sin(p.x * 90 + p.y * 70 + p.z * 80) * 0.5 + 0.5;
      const front = THREE.MathUtils.smoothstep(localZ, -0.02, 0.03);
      const split = (localX > 0 ? -0.26 : 0.12) * front;
      const blaze = (1 - THREE.MathUtils.smoothstep(Math.abs(localX), 0.008, 0.022))
        * THREE.MathUtils.smoothstep(localZ, 0.01, 0.045);
      let mh = THREE.MathUtils.smoothstep(
        blob * 0.3 + 0.84 + (fleck - 0.5) * 0.42 + split - blaze * 0.95, 0.48, 0.64,
      );
      mh = THREE.MathUtils.smoothstep(mh, 0.32, 0.6);
      // Chocolate cheek/crown patches; the orange blaze stays orange.
      mh = THREE.MathUtils.lerp(mh, 0.5, brown * 0.55 * (1 - blaze));
      return THREE.MathUtils.clamp(mh, 0.04, 0.96);
    }
    if (zone === COAT_ZONE.tail) {
      // Dark brindled tail with small ginger flecks.
      return THREE.MathUtils.clamp(0.66 + m * 0.3 + (brindle - 0.5) * 0.25, 0.05, 0.97);
    }
    // Chest/bib: black wrapping the front of the torso and throat, with a
    // small centred orange sternum patch (ref front-sit / head-close).
    const bib = THREE.MathUtils.smoothstep(p.z, 0.2, 0.3);
    const patch = 1 - THREE.MathUtils.smoothstep(
      Math.hypot(p.x / 0.05, (p.y - 0.33) / 0.06, (p.z - 0.29) / 0.09), 0.6, 1.2,
    );
    m = THREE.MathUtils.lerp(m, 0.92 + (brindle - 0.5) * 0.08, bib * 0.88);
    m -= patch * 0.9;
    // Ginger saddle over the mid-back — brindled, not solid orange, and kept
    // to a patch (a wide band here washes the whole upper body orange).
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.44, 0.51);
    const zBand = 1 - THREE.MathUtils.smoothstep(Math.abs(p.z + 0.04), 0.03, 0.12);
    m = THREE.MathUtils.lerp(m, 0.16 + brindle * 0.4, dorsal * zBand * 0.7 * (1 - bib));
    if (zone === COAT_ZONE.belly) m = Math.min(m, 0.55 + brindle * 0.25);
    return THREE.MathUtils.clamp(m, 0.03, 0.97);
  }
  if (pattern === 'solid-white') {
    // Near-uniform pale; tiny shade break so shells don't look plastic.
    return 0.08 + Math.sin(p.x * 17 + p.y * 13 + p.z * 11) * 0.02;
  }
  if (pattern === 'coati-snout') {
    // White-nosed coati: elongated pale snout, warm brown grizzled body,
    // lightly ringed long tail. Mask 0 → pale undercoat, 1 → dark guard.
    const ticking = Math.sin(p.x * 90 + p.y * 64 + p.z * 78) * 0.5 + 0.5;
    if (zone === COAT_ZONE.tail) return Math.sin(p.z * 88) > 0.05 ? 0.78 : 0.22;
    if (zone === COAT_ZONE.muzzle) return 0.05 + ticking * 0.04;
    if (zone === COAT_ZONE.paw) return 0.35 + ticking * 0.12;
    if (zone === COAT_ZONE.ear) return 0.42 + ticking * 0.15;
    if (zone === COAT_ZONE.belly) return 0.12 + ticking * 0.08;
    if (zone === COAT_ZONE.leg) return 0.4 + ticking * 0.15;
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // Pale face into the white snout; crown browner.
      const snout = THREE.MathUtils.smoothstep(localZ, -0.005, 0.04)
        * (1 - THREE.MathUtils.smoothstep(localY, 0.01, 0.04));
      let m = 0.42 + (ticking - 0.5) * 0.2;
      if (localY > 0.02) m = Math.min(0.72, m + 0.15);
      m = THREE.MathUtils.lerp(m, 0.06, snout * 0.95);
      return THREE.MathUtils.clamp(m, 0.05, 0.85);
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.52);
    return THREE.MathUtils.clamp(0.38 + (ticking - 0.5) * 0.28 + dorsal * 0.18, 0.12, 0.88);
  }
  if (pattern === 'ringed-tail') {
    // Ringtail / cacomistle: no full bandit mask — fox-grey body, pale under,
    // strongly ringed long tail.
    const ticking = Math.sin(p.x * 94 + p.y * 70 + p.z * 80) * 0.5 + 0.5;
    if (zone === COAT_ZONE.tail) return Math.sin(p.z * 110) > 0 ? 0.96 : 0.08;
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.belly || zone === COAT_ZONE.paw) {
      return 0.08 + ticking * 0.06;
    }
    if (zone === COAT_ZONE.ear) return 0.55 + ticking * 0.15;
    if (zone === COAT_ZONE.leg) return 0.35 + ticking * 0.15;
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      let m = 0.4 + (ticking - 0.5) * 0.18;
      if (localY > 0.02) m = Math.min(0.7, m + 0.12);
      return THREE.MathUtils.clamp(m, 0.1, 0.8);
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.52);
    return THREE.MathUtils.clamp(0.32 + (ticking - 0.5) * 0.26 + dorsal * 0.16, 0.12, 0.85);
  }
  if (pattern === 'raccoon-mask') {
    // Ringed tail: alternating dark/light bands along the tail's local axis.
    if (zone === COAT_ZONE.tail) return Math.sin(p.z * 102) > 0 ? 0.94 : 0.1;
    // Dark "gloved" paws/lower legs.
    if (zone === COAT_ZONE.paw) return 0.86;
    if (zone === COAT_ZONE.leg) return 0.28;
    // Pale muzzle/chin; light-rimmed rounded ears.
    if (zone === COAT_ZONE.muzzle) return 0.1;
    if (zone === COAT_ZONE.ear) return 0.12;
    if (zone === COAT_ZONE.belly) return 0.1;
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // Bandit mask: joined dark eye lobes, broad at the eyes and tapering
      // onto the cheek instead of a mechanically straight painted stripe.
      const eyeDistance = Math.hypot(
        (Math.abs(localX) - 0.027) / 0.032,
        (localY - 0.016) / 0.022,
      );
      const eyeLobes = 1 - THREE.MathUtils.smoothstep(eyeDistance, 0.68, 1.2);
      const maskBand = 1 - THREE.MathUtils.smoothstep(Math.abs(localY - 0.012), 0.012, 0.043);
      const mask = Math.max(eyeLobes, maskBand * 0.28);
      if (localZ > -0.01) return THREE.MathUtils.clamp(0.08 + mask * 0.9, 0, 1);
      return 0.22;
    }
    // Body: grizzled salt-and-pepper ticking with a slightly darker dorsal saddle.
    const ticking = Math.sin(p.x * 97 + p.y * 61 + p.z * 83) * 0.5 + 0.5;
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.56);
    return THREE.MathUtils.clamp(0.23 + ticking * 0.34 + dorsal * 0.14, 0, 1);
  }
  if (pattern === 'goat-pied') {
    // Large irregular white (undercoat) vs dark (guard) patches — goat piebald.
    const patch = Math.sin(p.x * 6.2 + p.z * 5.1) * Math.cos(p.y * 4.4 + p.x * 3.1);
    const blob = Math.sin(p.x * 2.4 + p.z * 2.8 + p.y * 1.7) * 0.5 + 0.5;
    let m = THREE.MathUtils.smoothstep(patch * 0.5 + blob * 0.5, 0.32, 0.68);
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.belly) m *= 0.45;
    if (zone === COAT_ZONE.leg || zone === COAT_ZONE.paw) m = m > 0.5 ? 0.85 : 0.12;
    if (zone === COAT_ZONE.head && headCenter) {
      // Face often light with darker poll/cheeks.
      const localY = p.y - headCenter.y;
      if (localY > 0.02) m = Math.min(1, m + 0.25);
      else m *= 0.55;
    }
    return THREE.MathUtils.clamp(m, 0.04, 0.96);
  }
  if (pattern === 'dorsal-stripe') {
    // Dark stripe along the spine; lighter flanks/belly (goat / donkey-ish).
    if (zone === COAT_ZONE.belly || zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw) return 0.1;
    if (zone === COAT_ZONE.tail) return 0.72;
    if (zone === COAT_ZONE.head || zone === COAT_ZONE.ear) return 0.55;
    const lateral = Math.abs(p.x);
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.36, 0.58);
    const stripe = 1 - THREE.MathUtils.smoothstep(lateral, 0.02, 0.08);
    return THREE.MathUtils.clamp(0.12 + dorsal * 0.35 + stripe * 0.55, 0, 1);
  }
  if (pattern === 'squirrel-grey') {
    // Eastern grey squirrel (rodent-ref board): cool salt-and-pepper dorsal,
    // chalk-white belly/chest/chin, pale eye rings, silver-tipped plume.
    // Mask 0 → pale undercoat, 1 → dark charcoal guard.
    // Keep dorsal masks high so multiply-root/tip still reads charcoal grey
    // (raccoon-style); belly stays near-zero so chalk undercoat survives.
    const ticking = Math.sin(p.x * 92 + p.y * 71 + p.z * 83) * 0.5 + 0.5;
    const fleck = Math.sin(p.x * 41 + p.z * 37 + p.y * 29) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.02 + ticking * 0.03;
    if (zone === COAT_ZONE.muzzle) return 0.04 + ticking * 0.04;
    if (zone === COAT_ZONE.paw) return 0.72 + ticking * 0.16;
    if (zone === COAT_ZONE.ear) return 0.48 + fleck * 0.2;
    if (zone === COAT_ZONE.leg) {
      // Distal limbs charcoal (ref paws/forearms).
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.08, 0.28);
      return THREE.MathUtils.clamp(0.48 + distal * 0.3 + ticking * 0.14, 0.3, 0.9);
    }
    if (zone === COAT_ZONE.tail) {
      // Silvery plume: mid-length darker charcoal, tip frosted, high-freq grizzle.
      // Prefer loft alongT (0 base → 1 tip) — world -Z is non-monotonic on a
      // rising sciurid plume and frosted the crook instead of the tip.
      const along = Number.isFinite(opts?.alongT)
        ? THREE.MathUtils.clamp(opts.alongT, 0, 1)
        : THREE.MathUtils.smoothstep(-p.z, 0.05, 0.42);
      const tipFrost = THREE.MathUtils.smoothstep(along, 0.62, 0.95);
      const mid = 0.52 + along * 0.26 + (ticking - 0.5) * 0.3;
      return THREE.MathUtils.clamp(THREE.MathUtils.lerp(mid, 0.2, tipFrost * 0.92), 0.16, 0.9);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // White periocular ring (Sciurus carolinensis) — annulus around the eye
      // lobe, not the pupil center. Peak at eyeDist≈0.72; interior/exterior fade.
      const eyeDist = Math.hypot(
        (Math.abs(localX) - 0.028) / 0.03,
        (localY - 0.014) / 0.022,
      );
      const eyeRing = 1 - THREE.MathUtils.smoothstep(Math.abs(eyeDist - 0.72), 0.0, 0.42);
      // Chin / lower face stays pale into the white bib.
      const chin = THREE.MathUtils.smoothstep(-localY, 0.0, 0.03)
        * THREE.MathUtils.smoothstep(localZ, -0.01, 0.04);
      let m = 0.58 + (ticking - 0.5) * 0.26 + (fleck - 0.5) * 0.12;
      m = THREE.MathUtils.lerp(m, 0.05, eyeRing * 0.96);
      m = THREE.MathUtils.lerp(m, 0.04, chin * 0.92);
      // Slightly darker crown / poll.
      if (localY > 0.02) m = Math.min(0.88, m + 0.14);
      return THREE.MathUtils.clamp(m, 0.04, 0.92);
    }
    // Body: grizzled charcoal agouti with darker dorsal saddle and pale chest bib.
    // Base sits high so average body reads grey (not washed beige) after the
    // root/tip multiply in dogFurMaterial — bib still drops to chalk.
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.32, 0.52);
    // Broad chalk chest/throat bib (refs: bright white underparts from chin
    // through sternum). Start earlier on +Z and fall off slowly laterally so
    // three-quarter/front-sit read white, not just the belly zone.
    const bib = THREE.MathUtils.smoothstep(p.z, 0.02, 0.22)
      * (1 - THREE.MathUtils.smoothstep(Math.abs(p.x), 0.04, 0.16))
      * (1 - THREE.MathUtils.smoothstep(p.y, 0.48, 0.58));
    let m = 0.62 + (ticking - 0.5) * 0.3 + (fleck - 0.5) * 0.12 + dorsal * 0.2;
    m = THREE.MathUtils.lerp(m, 0.025, bib * 0.99);
    return THREE.MathUtils.clamp(m, 0.025, 0.94);
  }
  if (pattern === 'chipmunk-stripe') {
    // Eastern chipmunk (rodent-ref board): 5 longitudinal stripes (dark–pale–
    // dark–pale–dark) on a warm russet ground, chalk belly/chest, white facial
    // stripe + pale periocular, grizzled mid-length tail with frosted tip.
    // Mask 0 → pale undercoat (cream/white), 1 → dark guard (near-black stripe).
    const ticking = Math.sin(p.x * 88 + p.y * 63 + p.z * 71) * 0.5 + 0.5;
    const fleck = Math.sin(p.x * 39 + p.z * 33 + p.y * 27) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.03 + ticking * 0.04;
    if (zone === COAT_ZONE.muzzle) return 0.05 + ticking * 0.05;
    if (zone === COAT_ZONE.paw) return 0.38 + ticking * 0.18;
    if (zone === COAT_ZONE.ear) return 0.42 + fleck * 0.22;
    if (zone === COAT_ZONE.leg) {
      // Warm distal limbs (refs: rusty forearms / tan toes), not black socks.
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.08, 0.26);
      return THREE.MathUtils.clamp(0.28 + distal * 0.18 + ticking * 0.12, 0.18, 0.55);
    }
    if (zone === COAT_ZONE.tail) {
      // Reddish-brown plume with dark grizzle + frosted tip (alongT base→tip).
      const along = Number.isFinite(opts?.alongT)
        ? THREE.MathUtils.clamp(opts.alongT, 0, 1)
        : THREE.MathUtils.smoothstep(-p.z, 0.05, 0.42);
      const tipFrost = THREE.MathUtils.smoothstep(along, 0.58, 0.94);
      const mid = 0.42 + along * 0.22 + (ticking - 0.5) * 0.28;
      return THREE.MathUtils.clamp(THREE.MathUtils.lerp(mid, 0.16, tipFrost * 0.9), 0.12, 0.78);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // White facial stripe through/above the eye (Tamias signature marking).
      // Horizontal band at eye height; peak pale on the annulus + stripe path.
      const eyeDist = Math.hypot(
        (Math.abs(localX) - 0.027) / 0.03,
        (localY - 0.014) / 0.022,
      );
      const eyeRing = 1 - THREE.MathUtils.smoothstep(Math.abs(eyeDist - 0.72), 0.0, 0.4);
      // Superciliary stripe: pale horizontal bar across the eye row.
      const faceStripe = (1 - THREE.MathUtils.smoothstep(Math.abs(localY - 0.012), 0.0, 0.018))
        * THREE.MathUtils.smoothstep(Math.abs(localX), 0.008, 0.055)
        * THREE.MathUtils.smoothstep(localZ, -0.02, 0.04);
      // Dark eye line just below the white stripe (cheek stripe suggestion).
      const darkCheek = (1 - THREE.MathUtils.smoothstep(Math.abs(localY + 0.006), 0.0, 0.014))
        * THREE.MathUtils.smoothstep(Math.abs(localX), 0.012, 0.05)
        * THREE.MathUtils.smoothstep(localZ, -0.01, 0.04);
      // Chin / lower face pale into the white bib.
      const chin = THREE.MathUtils.smoothstep(-localY, 0.0, 0.028)
        * THREE.MathUtils.smoothstep(localZ, -0.01, 0.04);
      // Warm brown crown / poll.
      let m = 0.48 + (ticking - 0.5) * 0.2 + (fleck - 0.5) * 0.1;
      if (localY > 0.018) m = Math.min(0.78, m + 0.18);
      m = THREE.MathUtils.lerp(m, 0.78, darkCheek * 0.85);
      m = THREE.MathUtils.lerp(m, 0.06, faceStripe * 0.95);
      m = THREE.MathUtils.lerp(m, 0.05, eyeRing * 0.92);
      m = THREE.MathUtils.lerp(m, 0.04, chin * 0.94);
      return THREE.MathUtils.clamp(m, 0.04, 0.9);
    }
    // Body: longitudinal 5-stripe (dark–pale–dark–pale–dark) over warm flank.
    // Stripes run along Z at fixed |x|. Mesh is coarse (~±0.10 body width,
    // y up to ~0.45 at rodent scale) so bands are wide enough to survive verts.
    const lateral = Math.abs(p.x);
    // Centers sized for body half-width ~0.10: mid dark, pale, outer dark, outer pale.
    const d0 = Math.abs(lateral - 0.0);
    const p1 = Math.abs(lateral - 0.035);
    const d1 = Math.abs(lateral - 0.065);
    const p2 = Math.abs(lateral - 0.09);
    const darkStripe = Math.max(
      1 - THREE.MathUtils.smoothstep(d0, 0.0, 0.022),
      1 - THREE.MathUtils.smoothstep(d1, 0.0, 0.02),
    );
    const paleStripe = Math.max(
      1 - THREE.MathUtils.smoothstep(p1, 0.0, 0.018),
      1 - THREE.MathUtils.smoothstep(p2, 0.0, 0.018),
    );
    // Stripe on the upper half of the scaled body (y≈0.30–0.45 at scale 0.34).
    const stripeWindow = THREE.MathUtils.smoothstep(p.y, 0.30, 0.36)
      * (1 - THREE.MathUtils.smoothstep(p.y, 0.44, 0.50))
      * (1 - THREE.MathUtils.smoothstep(p.z, 0.14, 0.26));
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.32, 0.44);
    // Chalk chest only — low y + forward z. Do NOT wash the whole torso pale
    // (rodent scale puts dorsal y < 0.46 so a high y-fade left the bib on everything).
    const bib = THREE.MathUtils.smoothstep(p.z, 0.06, 0.24)
      * (1 - THREE.MathUtils.smoothstep(lateral, 0.02, 0.10))
      * (1 - THREE.MathUtils.smoothstep(p.y, 0.34, 0.42));
    // Warm russet ground at mid mask; dark stripes near 1, pale stripes near 0
    // (with near-white root/tip, baseCol mix carries the real colors).
    let m = 0.42 + (ticking - 0.5) * 0.12 + (fleck - 0.5) * 0.06 + dorsal * 0.14;
    m = THREE.MathUtils.lerp(m, 0.97, darkStripe * stripeWindow * 0.99);
    m = THREE.MathUtils.lerp(m, 0.05, paleStripe * stripeWindow * 0.97);
    m = THREE.MathUtils.lerp(m, 0.02, bib * 0.99);
    return THREE.MathUtils.clamp(m, 0.02, 0.98);
  }
  if (pattern === 'panda-bicolor') {
    // Giant panda: white body/head ground with black ears, eye patches,
    // limbs, and a dark shoulder/leg saddle. Mask 0 → white undercoat, 1 → black guard.
    if (zone === COAT_ZONE.ear) return 0.96;
    if (zone === COAT_ZONE.paw) return 0.94;
    if (zone === COAT_ZONE.leg) return 0.92;
    if (zone === COAT_ZONE.tail) return 0.88;
    if (zone === COAT_ZONE.belly) return 0.04;
    if (zone === COAT_ZONE.muzzle) return 0.06;
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // Round black eye patches (not a continuous bandit band).
      const eyeDist = Math.hypot(
        (Math.abs(localX) - 0.028) / 0.034,
        (localY - 0.012) / 0.028,
      );
      const eyePatch = 1 - THREE.MathUtils.smoothstep(eyeDist, 0.55, 1.15);
      // Ears already zone-black; crown stays white.
      let m = 0.06;
      m = THREE.MathUtils.lerp(m, 0.96, eyePatch * 0.98);
      if (localY > 0.03 && localZ < 0.02) m = Math.min(m, 0.08);
      return THREE.MathUtils.clamp(m, 0.04, 0.98);
    }
    // Body: white ground with dark shoulder/forelimb saddle.
    const lateral = Math.abs(p.x);
    const shoulder = THREE.MathUtils.smoothstep(p.z, 0.02, 0.22)
      * THREE.MathUtils.smoothstep(lateral, 0.02, 0.1)
      * (1 - THREE.MathUtils.smoothstep(p.y, 0.48, 0.56));
    const flankBand = THREE.MathUtils.smoothstep(lateral, 0.04, 0.1)
      * THREE.MathUtils.smoothstep(p.y, 0.28, 0.42);
    let m = 0.06;
    m = THREE.MathUtils.lerp(m, 0.92, Math.max(shoulder, flankBand * 0.55));
    return THREE.MathUtils.clamp(m, 0.04, 0.96);
  }
  if (pattern === 'hamster-golden') {
    // Syrian hamster (rodent-ref): warm golden body, thin white chin/muzzle
    // strip (not a full white muzzle block), pale belly/paws.
    // Mask 0 → cream undercoat, 1 → golden guard.
    const ticking = Math.sin(p.x * 78 + p.y * 61 + p.z * 70) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.04 + ticking * 0.04;
    // Muzzle loft stays mostly golden; only the underside goes chalk.
    if (zone === COAT_ZONE.muzzle) {
      const underside = THREE.MathUtils.smoothstep(-p.y + 0.55, 0.0, 0.04);
      return THREE.MathUtils.clamp(0.42 - underside * 0.36 + ticking * 0.06, 0.05, 0.55);
    }
    if (zone === COAT_ZONE.paw) return 0.06 + ticking * 0.05;
    if (zone === COAT_ZONE.ear) return 0.38 + ticking * 0.14;
    if (zone === COAT_ZONE.leg) {
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.08, 0.24);
      return THREE.MathUtils.clamp(0.42 - distal * 0.32 + ticking * 0.08, 0.06, 0.55);
    }
    if (zone === COAT_ZONE.tail) return 0.35 + ticking * 0.12;
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // Thin white chin strip only (ref: white under lower lip, not whole face).
      const chin = THREE.MathUtils.smoothstep(-localY, 0.005, 0.04)
        * THREE.MathUtils.smoothstep(localZ, 0.0, 0.045)
        * (1 - THREE.MathUtils.smoothstep(Math.abs(p.x - headCenter.x), 0.01, 0.04));
      let m = 0.52 + (ticking - 0.5) * 0.12;
      if (localY > 0.015) m = Math.min(0.7, m + 0.08);
      m = THREE.MathUtils.lerp(m, 0.04, chin * 0.97);
      return THREE.MathUtils.clamp(m, 0.04, 0.78);
    }
    // Body: even golden with pale chest bib (scaled y ~0.22–0.45).
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.32, 0.44);
    const bib = THREE.MathUtils.smoothstep(p.z, 0.04, 0.22)
      * (1 - THREE.MathUtils.smoothstep(Math.abs(p.x), 0.02, 0.1))
      * (1 - THREE.MathUtils.smoothstep(p.y, 0.34, 0.42));
    let m = 0.5 + (ticking - 0.5) * 0.1 + dorsal * 0.08;
    m = THREE.MathUtils.lerp(m, 0.04, bib * 0.95);
    return THREE.MathUtils.clamp(m, 0.04, 0.75);
  }
  if (pattern === 'murine-agouti') {
    // Norway rat / house mouse (rodent-ref boards): grizzled dorsal, chalk-
    // pale belly/chest/chin, pale paws into pink skin, nearly bare scaly tail.
    // Mask 0 → pale undercoat, 1 → dark guard. Palette differs by breed
    // (cool grey-brown rat vs warm sandy mouse); this field is shared.
    const ticking = Math.sin(p.x * 86 + p.y * 67 + p.z * 79) * 0.5 + 0.5;
    const fleck = Math.sin(p.x * 43 + p.z * 39 + p.y * 31) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.03 + ticking * 0.04;
    if (zone === COAT_ZONE.muzzle) return 0.06 + ticking * 0.05;
    if (zone === COAT_ZONE.paw) return 0.08 + ticking * 0.06;
    if (zone === COAT_ZONE.ear) return 0.32 + fleck * 0.18;
    if (zone === COAT_ZONE.leg) {
      // Distal limbs fade pale toward pink paws (refs).
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.08, 0.26);
      return THREE.MathUtils.clamp(0.38 - distal * 0.28 + ticking * 0.1, 0.08, 0.55);
    }
    if (zone === COAT_ZONE.tail) {
      // Thin scaly tail — mid-dark, slight tip lighten; fur length is nearly 0.
      const along = Number.isFinite(opts?.alongT)
        ? THREE.MathUtils.clamp(opts.alongT, 0, 1)
        : THREE.MathUtils.smoothstep(-p.z, 0.05, 0.42);
      return THREE.MathUtils.clamp(0.42 + along * 0.08 + (ticking - 0.5) * 0.1, 0.28, 0.58);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // Chin / lower face pale into the white bib.
      const chin = THREE.MathUtils.smoothstep(-localY, 0.0, 0.03)
        * THREE.MathUtils.smoothstep(localZ, -0.01, 0.04);
      // Soft cheek pale (mouse/rat have lighter lower face, not a white eye stripe).
      const cheek = THREE.MathUtils.smoothstep(-localY, -0.005, 0.02)
        * THREE.MathUtils.smoothstep(Math.abs(p.x - headCenter.x), 0.01, 0.05);
      let m = 0.5 + (ticking - 0.5) * 0.22 + (fleck - 0.5) * 0.1;
      if (localY > 0.02) m = Math.min(0.78, m + 0.12);
      m = THREE.MathUtils.lerp(m, 0.05, chin * 0.94);
      m = THREE.MathUtils.lerp(m, 0.12, cheek * 0.55);
      return THREE.MathUtils.clamp(m, 0.04, 0.88);
    }
    // Body: grizzled mid-dorsal, pale chest bib (scaled body y ~0.22–0.45).
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.32, 0.44);
    const bib = THREE.MathUtils.smoothstep(p.z, 0.04, 0.22)
      * (1 - THREE.MathUtils.smoothstep(Math.abs(p.x), 0.02, 0.11))
      * (1 - THREE.MathUtils.smoothstep(p.y, 0.34, 0.42));
    let m = 0.5 + (ticking - 0.5) * 0.28 + (fleck - 0.5) * 0.12 + dorsal * 0.16;
    m = THREE.MathUtils.lerp(m, 0.03, bib * 0.98);
    return THREE.MathUtils.clamp(m, 0.03, 0.9);
  }
  // ---- Feline pattern kit (cat-ref reference boards). Mask 0 → undercoat
  // (ground/pale color), 1 → guard (marking color). Torso tessellation caps
  // along-body frequencies at ~24 (see the tortoiseshell comment above).
  if (pattern === 'cat-tabby') {
    // Broad classic-tabby read: dark dorsal mantle + swirled flank patches,
    // pale belly/muzzle, ringed tail, barred upper legs, striped crown.
    const swirl = Math.sin(p.z * 22 + Math.sin(p.y * 26) * 1.6 + p.x * 12)
      + Math.sin(p.y * 30 - p.z * 14);
    const ticking = Math.sin(p.x * 70 + p.y * 55 + p.z * 62) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly || zone === COAT_ZONE.muzzle) return 0.1 + ticking * 0.08;
    if (zone === COAT_ZONE.paw) return 0.12;
    if (zone === COAT_ZONE.ear) return 0.78 + ticking * 0.12;
    if (zone === COAT_ZONE.tail) return Math.sin(p.z * 85 + p.y * 20) > 0.1 ? 0.88 : 0.25;
    if (zone === COAT_ZONE.leg) {
      const bar = Math.sin(p.y * 52 + p.x * 8) * 0.5 + 0.5;
      const upper = THREE.MathUtils.smoothstep(p.y, 0.12, 0.3);
      return THREE.MathUtils.clamp(0.18 + bar * 0.5 * upper, 0.06, 0.85);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      if (localY > 0.02) return 0.55 + (Math.sin(p.x * 160) * 0.5 + 0.5) * 0.35;
      if (localZ > 0.03 && localY < -0.005) return 0.15;
      return 0.3 + ticking * 0.2;
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.52);
    // Two-stage smoothstep: soft swirl mids render as a brown wash that hides
    // the tabby markings entirely (same failure the tortoiseshell hit).
    let stripe = THREE.MathUtils.smoothstep(swirl + (ticking - 0.5) * 0.5, 0.0, 0.7);
    stripe = THREE.MathUtils.smoothstep(stripe, 0.35, 0.6);
    const m = 0.14 + stripe * (0.55 + dorsal * 0.22) + dorsal * 0.12;
    return THREE.MathUtils.clamp(m, 0.06, 0.94);
  }
  if (pattern === 'cat-spotted') {
    // Bengal/Mau/Ocicat/Savannah: dark spots over a lighter ground, pale
    // belly, ringed tail with a dark tip.
    const spots = Math.sin(p.x * 42 + 1.7) * Math.sin(p.y * 38 + 0.6) * Math.sin(p.z * 34 + 2.3);
    // Tight threshold so spots stay bold dark dots, not a soft wash.
    const spot = THREE.MathUtils.smoothstep(spots, 0.28, 0.4);
    const ticking = Math.sin(p.x * 90 + p.y * 70 + p.z * 80) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly || zone === COAT_ZONE.muzzle) return 0.08 + spot * 0.4;
    if (zone === COAT_ZONE.paw) return 0.15;
    if (zone === COAT_ZONE.ear) return 0.72 + ticking * 0.15;
    if (zone === COAT_ZONE.tail) {
      if (p.z < -0.46) return 0.9;
      return Math.sin(p.z * 80) > 0.25 ? 0.85 : 0.2;
    }
    if (zone === COAT_ZONE.leg) return 0.14 + spot * 0.6;
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      if (localY > 0.02) return 0.35 + spot * 0.45;
      return 0.18 + spot * 0.3;
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.36, 0.52);
    return THREE.MathUtils.clamp(0.12 + dorsal * 0.1 + spot * 0.8, 0.05, 0.95);
  }
  if (pattern === 'cat-ticked') {
    // Abyssinian/Somali/Singapura agouti: near-uniform warm ticking, pale
    // muzzle/belly, darker dorsal wash, dark tail tip.
    const ticking = Math.sin(p.x * 84 + p.y * 66 + p.z * 74) * 0.5 + 0.5;
    if (zone === COAT_ZONE.muzzle || zone === COAT_ZONE.belly) return 0.08;
    if (zone === COAT_ZONE.paw) return 0.14;
    if (zone === COAT_ZONE.ear) return 0.55 + ticking * 0.2;
    if (zone === COAT_ZONE.tail) {
      if (p.z < -0.44) return 0.88;
      return 0.34 + ticking * 0.22;
    }
    if (zone === COAT_ZONE.leg) {
      return 0.12 + THREE.MathUtils.smoothstep(p.y, 0.1, 0.3) * (0.2 + ticking * 0.15);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localZ = p.z - headCenter.z;
      const localY = p.y - headCenter.y;
      if (localZ > 0.035 && localY < 0.005) return 0.1;
      return 0.3 + ticking * 0.24;
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.32, 0.52);
    return THREE.MathUtils.clamp(0.2 + dorsal * 0.28 + (ticking - 0.5) * 0.34, 0.06, 0.9);
  }
  if (pattern === 'cat-colorpoint') {
    // Siamese-family points: dark face mask/ears/legs/tail over a pale body.
    // `coat.pointGloves` (Birman) keeps the paws white.
    const gloves = !!phenotype?.coat?.pointGloves;
    if (zone === COAT_ZONE.muzzle) return 0.93;
    if (zone === COAT_ZONE.ear) return 0.95;
    if (zone === COAT_ZONE.paw) return gloves ? 0.03 : 0.9;
    if (zone === COAT_ZONE.tail) return 0.92;
    if (zone === COAT_ZONE.leg) {
      const dark = 1 - THREE.MathUtils.smoothstep(p.y, gloves ? 0.06 : 0.02, 0.34);
      return THREE.MathUtils.clamp(0.08 + dark * (gloves ? 0.55 : 0.85), 0.05, 0.92);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localZ = p.z - headCenter.z;
      const localY = p.y - headCenter.y;
      const front = THREE.MathUtils.smoothstep(localZ, -0.045, 0.03);
      const low = 1 - THREE.MathUtils.smoothstep(localY, -0.01, 0.05);
      return THREE.MathUtils.clamp(0.12 + Math.max(front, low * 0.5) * 0.85, 0.08, 0.95);
    }
    if (zone === COAT_ZONE.belly) return 0.05;
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.52);
    return 0.07 + dorsal * 0.12;
  }
  if (pattern === 'cat-van') {
    // Turkish Van: chalk-white body, colored crown patches split by a white
    // blaze, colored tail.
    if (zone === COAT_ZONE.tail) return 0.88 + Math.sin(p.z * 70) * 0.06;
    if (zone === COAT_ZONE.ear) return 0.8;
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      const crown = THREE.MathUtils.smoothstep(localY, 0.005, 0.03);
      const blaze = 1 - THREE.MathUtils.smoothstep(Math.abs(localX), 0.008, 0.02);
      const frontal = THREE.MathUtils.smoothstep(localZ, -0.03, 0.02);
      return THREE.MathUtils.clamp(crown * frontal * (1 - blaze) * 0.95, 0.03, 0.92);
    }
    return 0.04;
  }
  if (pattern === 'cat-mike') {
    // Japanese Bobtail tri-color approximation: white base with large dark
    // patches; the warm guard/root palette makes mid-mask patches lean red.
    const blob = Math.sin(p.x * 26 + p.z * 20 + Math.sin(p.y * 24) * 1.3)
      + Math.sin(p.y * 30 - p.z * 18);
    if (zone === COAT_ZONE.belly || zone === COAT_ZONE.muzzle || zone === COAT_ZONE.paw
      || zone === COAT_ZONE.leg) return 0.05;
    if (zone === COAT_ZONE.tail) return 0.8;
    if (zone === COAT_ZONE.ear) return 0.85;
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localZ = p.z - headCenter.z;
      const crown = THREE.MathUtils.smoothstep(p.y - headCenter.y, 0.0, 0.03);
      const side = localX > 0 ? 0.95 : 0.55;
      const blaze = 1 - THREE.MathUtils.smoothstep(Math.abs(localX), 0.006, 0.018);
      const frontal = THREE.MathUtils.smoothstep(localZ, -0.04, 0.02);
      return THREE.MathUtils.clamp(crown * side * (1 - blaze) * frontal, 0.03, 0.95);
    }
    const patch = THREE.MathUtils.smoothstep(blob, 0.5, 1.1);
    const tone = Math.sin(p.x * 13 + p.z * 11) > 0 ? 0.95 : 0.55;
    return THREE.MathUtils.clamp(patch * tone, 0.04, 0.95);
  }
  if (pattern === 'badger-faced') {
    // European badger (mustelid): white crown/face with broad black eye-stripes
    // running nose→over-the-eyes→ears, grizzled grey-silver back, black belly &
    // lower legs, pale tail. Mask 0 → white, 1 → black; mid mask = grey (the
    // grizzled silver back is the mix of the two endpoints).
    const ticking = Math.sin(p.x * 90 + p.y * 68 + p.z * 80) * 0.5 + 0.5;
    const fleck = Math.sin(p.x * 42 + p.z * 36 + p.y * 28) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.9 + ticking * 0.04;
    if (zone === COAT_ZONE.paw) return 0.88 + ticking * 0.06;
    if (zone === COAT_ZONE.leg) {
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.1, 0.3);
      return THREE.MathUtils.clamp(0.66 + distal * 0.26 + (ticking - 0.5) * 0.08, 0.6, 0.94);
    }
    if (zone === COAT_ZONE.ear) return 0.86 + ticking * 0.08;
    if (zone === COAT_ZONE.muzzle) return 0.06; // white nose bridge/chin
    if (zone === COAT_ZONE.tail) {
      // Pale silvery tail with a faint darker dorsal line.
      const dorsal = 1 - THREE.MathUtils.smoothstep(Math.abs(p.x), 0.0, 0.03);
      return THREE.MathUtils.clamp(0.14 + dorsal * 0.4 + (ticking - 0.5) * 0.08, 0.08, 0.6);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // Two broad black stripes: one over each eye, running nose→crown→ear.
      // Band peaks offset from the centerline; white between them + on cheeks.
      const eyeStripe = 1 - THREE.MathUtils.smoothstep(
        Math.abs(Math.abs(localX) - 0.022), 0.0, 0.016,
      );
      const stripeWindow = THREE.MathUtils.smoothstep(localZ, -0.02, 0.025);
      const crown = THREE.MathUtils.smoothstep(localY, -0.005, 0.022);
      let m = 0.05 + (ticking - 0.5) * 0.04; // white face
      m = THREE.MathUtils.lerp(m, 0.92, eyeStripe * stripeWindow * (0.6 + crown * 0.4));
      if (localZ > 0.04 && localY < 0.0) m = Math.min(m, 0.1); // white snout tip
      return THREE.MathUtils.clamp(m, 0.04, 0.95);
    }
    // Body: grizzled grey-silver back (mid mask), darker dorsal ridge.
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.52);
    let m = 0.5 + (ticking - 0.5) * 0.24 + (fleck - 0.5) * 0.1 + dorsal * 0.16;
    const spineStripe = 1 - THREE.MathUtils.smoothstep(Math.abs(p.x), 0.0, 0.035);
    m = THREE.MathUtils.lerp(m, 0.8, spineStripe * dorsal * 0.3);
    return THREE.MathUtils.clamp(m, 0.2, 0.86);
  }
  if (pattern === 'skunk-striped') {
    // Striped skunk (mephitid): glossy black body with twin white dorsal stripes
    // running crown→rump, a white forehead blaze, black limbs/belly, and a big
    // bushy tail with white flanking stripes + frosted tip.
    // Mask 0 → white undercoat, 1 → black guard.
    if (zone === COAT_ZONE.belly) return 0.94;
    if (zone === COAT_ZONE.leg || zone === COAT_ZONE.paw) return 0.95;
    if (zone === COAT_ZONE.ear) return 0.92;
    if (zone === COAT_ZONE.muzzle) return 0.9;
    if (zone === COAT_ZONE.tail) {
      // Bushy tail: black core, white side edges + frosted tip (alongT base→tip).
      const along = Number.isFinite(opts?.alongT)
        ? THREE.MathUtils.clamp(opts.alongT, 0, 1)
        : THREE.MathUtils.smoothstep(-p.z, 0.05, 0.42);
      const tipFrost = THREE.MathUtils.smoothstep(along, 0.55, 0.95);
      const edge = THREE.MathUtils.smoothstep(Math.abs(p.x), 0.0, 0.028);
      const core = THREE.MathUtils.lerp(0.9, 0.16, edge * 0.85);
      return THREE.MathUtils.clamp(THREE.MathUtils.lerp(core, 0.12, tipFrost * 0.9), 0.08, 0.95);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // White blaze up the forehead into the crown (single broad central patch).
      const blaze = (1 - THREE.MathUtils.smoothstep(Math.abs(localX), 0.006, 0.026))
        * THREE.MathUtils.smoothstep(localY, -0.01, 0.02)
        * THREE.MathUtils.smoothstep(localZ, -0.03, 0.03);
      return THREE.MathUtils.clamp(0.92 - blaze * 0.9, 0.05, 0.96);
    }
    // Body: twin parallel white stripes either side of the spine on black ground.
    const lateral = Math.abs(p.x);
    const stripe = 1 - THREE.MathUtils.smoothstep(Math.abs(lateral - 0.04), 0.0, 0.018);
    const dorsalWindow = THREE.MathUtils.smoothstep(p.y, 0.30, 0.40)
      * (1 - THREE.MathUtils.smoothstep(p.y, 0.50, 0.56));
    const zRun = 1 - THREE.MathUtils.smoothstep(p.z, 0.12, 0.26); // fade only at front chest
    return THREE.MathUtils.clamp(0.92 - stripe * dorsalWindow * zRun * 0.9, 0.05, 0.96);
  }
  if (pattern === 'hyena-spotted') {
    // Spotted hyena (hyaenidae): tawny-sandy ground with irregular dark brown
    // blotchy spots (densest over the back/flanks), darker lower legs & muzzle,
    // short bristly dorsalCrest mane (geometry; coat stays spotted here).
    // Mask 0 → pale tawny undercoat, 1 → dark brown spot.
    const spots = Math.sin(p.x * 26 + p.z * 19 + 1.3) * Math.sin(p.y * 22 - p.z * 13 + 0.7)
      * Math.sin(p.x * 14 - p.y * 11 + 2.1);
    const blob = Math.sin(p.x * 9 + p.z * 7 + Math.sin(p.y * 8) * 1.4) * 0.5 + 0.5;
    const spot = THREE.MathUtils.smoothstep(spots + (blob - 0.5) * 0.6, 0.06, 0.24);
    const ticking = Math.sin(p.x * 80 + p.y * 60 + p.z * 70) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.1 + spot * 0.18;
    if (zone === COAT_ZONE.muzzle) return 0.5 + ticking * 0.2;
    if (zone === COAT_ZONE.paw) return 0.6 + ticking * 0.2;
    if (zone === COAT_ZONE.leg) {
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.1, 0.3);
      return THREE.MathUtils.clamp(0.34 + distal * 0.4 + spot * 0.2, 0.2, 0.85);
    }
    if (zone === COAT_ZONE.ear) return 0.5 + ticking * 0.18;
    if (zone === COAT_ZONE.tail) return THREE.MathUtils.clamp(0.3 + spot * 0.5 + (ticking - 0.5) * 0.2, 0.1, 0.85);
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      let m = 0.32 + spot * 0.5 + (ticking - 0.5) * 0.14;
      if (localY > 0.02) m = Math.min(0.85, m + 0.12);
      return THREE.MathUtils.clamp(m, 0.1, 0.9);
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.52);
    return THREE.MathUtils.clamp(0.18 + dorsal * 0.12 + spot * 0.7, 0.08, 0.9);
  }
  if (pattern === 'genet-spotted') {
    // Common genet (viverridae): grey-ticked ground with small dark spots in
    // rough rows over the back/flanks, dark facial mask, very long ringed tail
    // with a black tip. Mask 0 → pale under, 1 → dark spot.
    const rows = Math.sin(p.x * 44 + p.z * 33 + Math.sin(p.y * 30) * 1.2)
      * Math.sin(p.y * 38 - p.z * 22 + 0.8);
    const spot = THREE.MathUtils.smoothstep(rows, 0.18, 0.32);
    const ticking = Math.sin(p.x * 88 + p.y * 66 + p.z * 74) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.08 + ticking * 0.05;
    if (zone === COAT_ZONE.muzzle) return 0.72 + ticking * 0.1;
    if (zone === COAT_ZONE.paw) return 0.4 + ticking * 0.14;
    if (zone === COAT_ZONE.leg) return 0.36 + ticking * 0.14;
    if (zone === COAT_ZONE.ear) return 0.62 + ticking * 0.14;
    if (zone === COAT_ZONE.tail) {
      // Long ringed tail — tight dark/light bands + black tip.
      const along = Number.isFinite(opts?.alongT)
        ? THREE.MathUtils.clamp(opts.alongT, 0, 1)
        : THREE.MathUtils.smoothstep(-p.z, 0.05, 0.5);
      if (along > 0.88) return 0.95;
      return Math.sin(along * 60) > 0 ? 0.9 : 0.18;
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localX = p.x - headCenter.x;
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      // Dark mask around/behind the eyes; pale nose bridge between them.
      const eyeBand = 1 - THREE.MathUtils.smoothstep(Math.abs(localY - 0.014), 0.0, 0.022);
      const side = THREE.MathUtils.smoothstep(Math.abs(localX), 0.008, 0.04);
      let m = 0.32 + (ticking - 0.5) * 0.18;
      m = THREE.MathUtils.lerp(m, 0.82, eyeBand * side * 0.9);
      if (localZ > 0.02 && localY < 0.005) m = Math.min(m, 0.4);
      return THREE.MathUtils.clamp(m, 0.06, 0.9);
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.52);
    return THREE.MathUtils.clamp(0.3 + dorsal * 0.1 + spot * 0.6 + (ticking - 0.5) * 0.1, 0.1, 0.85);
  }
  if (pattern === 'red-panda') {
    // Red panda (ailuridae): auburn-red upper body & face & bushy ringed tail,
    // black underparts (belly/lower legs). The 2-channel coat (undercoat↔guard)
    // cannot express the iconic white face mask as a third color, so the muzzle
    // leans toward the pale undercoat tint and the strong red-back / black-belly
    // silhouette carries the read. Mask 0 → red undercoat, 1 → near-black guard.
    const ticking = Math.sin(p.x * 78 + p.y * 62 + p.z * 70) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.92 + ticking * 0.04;
    if (zone === COAT_ZONE.leg) {
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.1, 0.32);
      return THREE.MathUtils.clamp(THREE.MathUtils.lerp(0.4, 0.94, distal), 0.36, 0.96);
    }
    if (zone === COAT_ZONE.paw) return 0.94;
    if (zone === COAT_ZONE.ear) return 0.12 + ticking * 0.06; // red ears (earInner tint for inner)
    if (zone === COAT_ZONE.muzzle) return 0.04; // pale muzzle toward undercoat
    if (zone === COAT_ZONE.tail) {
      // Ringed bushy tail: red with alternating slightly darker bands.
      const along = Number.isFinite(opts?.alongT)
        ? THREE.MathUtils.clamp(opts.alongT, 0, 1)
        : THREE.MathUtils.smoothstep(-p.z, 0.05, 0.42);
      const ring = Math.sin(along * 50);
      return THREE.MathUtils.clamp(0.16 + (ring > 0 ? 0.12 : 0.0) + (ticking - 0.5) * 0.06, 0.08, 0.34);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      let m = 0.14 + (ticking - 0.5) * 0.08; // red face
      if (localY > 0.018 && localZ < 0.02) m = Math.min(0.3, m + 0.06); // red crown
      return THREE.MathUtils.clamp(m, 0.04, 0.4);
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.52);
    return THREE.MathUtils.clamp(0.14 + dorsal * 0.08 + (ticking - 0.5) * 0.06, 0.06, 0.3);
  }
  if (pattern === 'cervid-fawn') {
    // Cervid fawn / red deer (cervidae): warm tawny ground with neat round white
    // spots in longitudinal rows over the back/flanks (fading toward the legs),
    // pale belly, white rump patch. Mask 0 → white spot, 1 → tawny guard.
    const spotRow = Math.sin(p.x * 40 + p.z * 30 + Math.sin(p.y * 28) * 1.1)
      * Math.sin(p.y * 44 - p.z * 24 + 0.6);
    const spot = THREE.MathUtils.smoothstep(spotRow, 0.22, 0.34);
    const ticking = Math.sin(p.x * 80 + p.y * 60 + p.z * 70) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.08 + ticking * 0.05;
    if (zone === COAT_ZONE.muzzle) return 0.34 + ticking * 0.1;
    if (zone === COAT_ZONE.paw) return 0.4 + ticking * 0.12;
    if (zone === COAT_ZONE.leg) {
      // Lower legs unspotted, slightly darker (deer "socks").
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.1, 0.3);
      return THREE.MathUtils.clamp(0.5 + distal * 0.22 + (ticking - 0.5) * 0.1, 0.36, 0.78);
    }
    if (zone === COAT_ZONE.ear) return 0.42 + ticking * 0.16;
    if (zone === COAT_ZONE.tail) return 0.18 + ticking * 0.06; // white rump tuft
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      const localZ = p.z - headCenter.z;
      let m = 0.58 + (ticking - 0.5) * 0.12;
      if (localY > 0.02) m = 0.66 - spot * 0.5; // fawn spots on crown
      if (localZ > 0.03 && localY < 0.0) m = Math.min(m, 0.4); // pale nose bridge
      return THREE.MathUtils.clamp(m, 0.06, 0.8);
    }
    // Body: tawny with white spots (upper back only) + white rump patch (rear).
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.34, 0.5);
    const spotWindow = THREE.MathUtils.smoothstep(p.y, 0.3, 0.4)
      * (1 - THREE.MathUtils.smoothstep(p.y, 0.48, 0.54));
    const rump = THREE.MathUtils.smoothstep(-p.z, -0.05, 0.12)
      * (1 - THREE.MathUtils.smoothstep(Math.abs(p.x), 0.04, 0.12));
    let m = 0.66 + dorsal * 0.14 + (ticking - 0.5) * 0.1;
    m = THREE.MathUtils.lerp(m, 0.04, spot * spotWindow * 0.95);
    m = THREE.MathUtils.lerp(m, 0.06, rump * 0.85);
    return THREE.MathUtils.clamp(m, 0.04, 0.86);
  }
  if (pattern === 'chinchilla-silver') {
    // Chinchilla (chinchillid): ultra-dense silky silver-grey, even over the
    // back with darker guard tips on the nape, chalk-white belly & inner limbs.
    // Mask 0 → white undercoat, 1 → dark slate guard; mid mask = silver.
    const ticking = Math.sin(p.x * 120 + p.y * 96 + p.z * 110) * 0.5 + 0.5;
    const fleck = Math.sin(p.x * 53 + p.z * 47 + p.y * 33) * 0.5 + 0.5;
    if (zone === COAT_ZONE.belly) return 0.05 + ticking * 0.03;
    if (zone === COAT_ZONE.muzzle) return 0.1 + ticking * 0.04;
    if (zone === COAT_ZONE.paw) return 0.14 + ticking * 0.05;
    if (zone === COAT_ZONE.ear) return 0.6 + ticking * 0.14;
    if (zone === COAT_ZONE.leg) {
      const distal = 1 - THREE.MathUtils.smoothstep(p.y, 0.08, 0.26);
      return THREE.MathUtils.clamp(0.5 - distal * 0.3 + (ticking - 0.5) * 0.1, 0.16, 0.62);
    }
    if (zone === COAT_ZONE.tail) {
      const along = Number.isFinite(opts?.alongT)
        ? THREE.MathUtils.clamp(opts.alongT, 0, 1)
        : THREE.MathUtils.smoothstep(-p.z, 0.05, 0.42);
      return THREE.MathUtils.clamp(0.58 + along * 0.16 + (ticking - 0.5) * 0.1, 0.4, 0.78);
    }
    if (zone === COAT_ZONE.head && headCenter) {
      const localY = p.y - headCenter.y;
      let m = 0.56 + (ticking - 0.5) * 0.18 + (fleck - 0.5) * 0.08;
      if (localY > 0.02) m = Math.min(0.82, m + 0.16); // darker crown/nape
      return THREE.MathUtils.clamp(m, 0.3, 0.86);
    }
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.32, 0.5);
    return THREE.MathUtils.clamp(0.56 + (ticking - 0.5) * 0.2 + (fleck - 0.5) * 0.08 + dorsal * 0.18, 0.34, 0.86);
  }
  if (pattern === 'bay-points') {
    // Bay horse (equid-ref board): red-brown body with BLACK points — lower
    // legs, tail, muzzle tip and ear rims. Mane blackness comes from the
    // crest-mane loft's own mask override. Mask 0 → red-brown undercoat,
    // 1 → black guard.
    if (zone === COAT_ZONE.paw) return 0.95;
    if (zone === COAT_ZONE.leg) {
      const dark = 1 - THREE.MathUtils.smoothstep(p.y, 0.22, 0.42);
      return THREE.MathUtils.clamp(0.18 + dark * 0.78, 0.12, 0.95);
    }
    if (zone === COAT_ZONE.tail) return 0.94;
    if (zone === COAT_ZONE.ear) return 0.6;
    if (zone === COAT_ZONE.muzzle && headCenter) {
      // Soft dark muzzle tip fading into the red-brown face.
      const tip = THREE.MathUtils.smoothstep(p.z - headCenter.z, 0.1, 0.19);
      return 0.24 + tip * 0.6;
    }
    if (zone === COAT_ZONE.head) return 0.3;
    if (zone === COAT_ZONE.belly) return 0.24;
    // Body: red-brown with a slightly darker dorsal wash. The wash keys off
    // world Y, which is fine for a horizontal-backed dog torso — but the
    // equid neck rises steeply from chest to poll, so the same world-Y band
    // cuts diagonally across the neck's length and reads as a dark stripe/X
    // instead of a smooth all-over tint. Fade the wash out as the body loft
    // approaches the head (the neck) so only the level back gets it.
    const neckFade = headCenter
      ? 1 - THREE.MathUtils.smoothstep(p.z, headCenter.z - 0.55, headCenter.z - 0.18)
      : 1;
    const dorsal = THREE.MathUtils.smoothstep(p.y, 0.4, 0.58);
    return 0.14 + dorsal * 0.1 * neckFade;
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
