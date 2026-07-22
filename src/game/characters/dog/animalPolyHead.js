/**
 * Continuous polygonal animal heads — one authored surface, not merged spheres.
 *
 * headShape presets:
 *   'suid'   — domestic pig / warthog: curved crown, blocky cylindrical snout
 *              (rehomed from earlier capybara attempts that read as pig).
 *   'caviid' — capybara: gently domed blocky head with a blunt rounded snout
 *              (highest point ~1/3 forward from the nape, wedge taper to the
 *              nose). An earlier flat-top rectangle read wrong vs the ref
 *              board; see buildCaviidPolyHead.
 */

import * as THREE from 'three';
import { LoftGeometry } from '../../../three-addons/geometries/LoftGeometry.js';
import {
  COAT_ZONE,
  headGroomAt,
  lengthAt,
  colorMaskAt,
  packCoatMask,
} from './dogCoatFields.js';

function blendSkin(a, b, t) {
  const w = THREE.MathUtils.clamp(t, 0, 1);
  return { indices: [a, b, 0, 0], weights: [1 - w, w, 0, 0] };
}

/**
 * Closed section polygon in the local (side, up) plane of a station.
 * Points wind CCW as seen looking back along the loft tangent.
 */
function sectionPolygon(rx, ry, segs, {
  n = 2.4,
  cheek = 0,
  cheekY = -0.15,
  topFlat = 0.2,
  bottomFlat = 0.12,
  upperHalf = 1,
  lowerHalf = 1,
  faceFlat = 0,
} = {}) {
  const pts = [];
  const invN = 1 / n;
  for (let i = 0; i < segs; i += 1) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let sx = Math.sign(c) * (Math.abs(c) ** invN);
    let sy = Math.sign(s) * (Math.abs(s) ** invN);

    if (sy >= 0) sy *= upperHalf;
    else sy *= lowerHalf;

    if (sy > 0) sy *= 1 - topFlat * (sy * sy);
    else sy *= 1 - bottomFlat * (sy * sy);

    if (cheek > 0) {
      const d = sy - cheekY;
      const lobe = Math.exp(-d * d * 6.5);
      sx *= 1 + cheek * lobe * Math.abs(c);
    }

    if (faceFlat > 0) {
      sy *= 1 - faceFlat * 0.22;
      sx *= 1 + faceFlat * 0.08;
    }

    pts.push(new THREE.Vector3(sx * rx, sy * ry, 0));
  }
  return pts;
}

function frameFromTangent(tangent, upHint = new THREE.Vector3(0, 1, 0)) {
  const t = tangent.clone().normalize();
  let up = upHint.clone();
  let side = new THREE.Vector3().crossVectors(up, t);
  if (side.lengthSq() < 1e-8) {
    up = new THREE.Vector3(1, 0, 0);
    side = new THREE.Vector3().crossVectors(up, t);
  }
  side.normalize();
  up = new THREE.Vector3().crossVectors(t, side).normalize();
  return { side, up, tangent: t };
}

function rotateTowards(vec, fromDir, toDir) {
  const from = fromDir.clone().normalize();
  const to = toDir.clone().normalize();
  const dot = THREE.MathUtils.clamp(from.dot(to), -1, 1);
  if (dot > 0.99999) return vec.clone();
  if (dot < -0.99999) {
    let axis = new THREE.Vector3(1, 0, 0).cross(from);
    if (axis.lengthSq() < 1e-8) axis = new THREE.Vector3(0, 1, 0).cross(from);
    axis.normalize();
    return vec.clone().applyAxisAngle(axis, Math.PI);
  }
  const axis = new THREE.Vector3().crossVectors(from, to).normalize();
  return vec.clone().applyAxisAngle(axis, Math.acos(dot));
}

function placeSection(localPts, center, side, up) {
  return localPts.map((lp) => center.clone()
    .addScaledVector(side, lp.x)
    .addScaledVector(up, lp.y));
}

/**
 * Skin a multi-section loft and stamp coat attributes.
 */
function loftPolyStations(stations, coatFn) {
  if (stations.length < 2) throw new Error('loftPolyStations needs ≥2 stations');

  let propagatedUp = new THREE.Vector3(0, 1, 0);
  let prevTangent = null;
  const sections = [];

  for (let i = 0; i < stations.length; i += 1) {
    const prev = stations[Math.max(0, i - 1)].c;
    const next = stations[Math.min(stations.length - 1, i + 1)].c;
    const tangent = next.clone().sub(prev);
    if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1);
    if (prevTangent) propagatedUp = rotateTowards(propagatedUp, prevTangent, tangent);
    const { side, up } = frameFromTangent(tangent, propagatedUp);
    sections.push(placeSection(stations[i].local, stations[i].c, side, up));
    prevTangent = tangent;
  }

  const geo = new LoftGeometry(sections, {
    closed: true,
    capStart: true,
    capEnd: true,
  });

  const lengths = [0];
  let total = 0;
  for (let i = 1; i < stations.length; i += 1) {
    total += stations[i].c.distanceTo(stations[i - 1].c);
    lengths.push(total);
  }
  if (total < 1e-6) total = 1;

  const pos = geo.getAttribute('position');
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const furLength = new Float32Array(count);
  const coatMask = new Float32Array(count);
  const groom = new Float32Array(count * 3);
  const zone = new Float32Array(count);
  const restPos = new Float32Array(count * 3);
  const p = new THREE.Vector3();

  for (let i = 0; i < count; i += 1) {
    p.fromBufferAttribute(pos, i);
    let bestSeg = 0;
    let bestT = 0;
    let bestDist = Infinity;
    for (let s = 0; s < stations.length - 1; s += 1) {
      const a = stations[s].c;
      const b = stations[s + 1].c;
      const ab = b.clone().sub(a);
      const len = ab.length() || 1;
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / (len * len), 0, 1);
      const proj = a.clone().addScaledVector(ab, t);
      const d = proj.distanceToSquared(p);
      if (d < bestDist) {
        bestDist = d;
        bestSeg = s;
        bestT = t;
      }
    }
    const boneA = stations[bestSeg].bone;
    const boneB = stations[bestSeg + 1]?.bone ?? boneA;
    const skin = blendSkin(boneA, boneB, bestT);
    const stationT = (lengths[bestSeg] + bestT * (lengths[bestSeg + 1] - lengths[bestSeg])) / total;
    const sample = coatFn(p, stationT);
    skinIndex[i * 4] = skin.indices[0];
    skinIndex[i * 4 + 1] = skin.indices[1];
    skinIndex[i * 4 + 2] = skin.indices[2];
    skinIndex[i * 4 + 3] = skin.indices[3];
    skinWeight[i * 4] = skin.weights[0];
    skinWeight[i * 4 + 1] = skin.weights[1];
    skinWeight[i * 4 + 2] = skin.weights[2];
    skinWeight[i * 4 + 3] = skin.weights[3];
    furLength[i] = sample.length;
    coatMask[i] = packCoatMask(sample.colorMask, sample.zone, false);
    groom[i * 3] = sample.groom[0];
    groom[i * 3 + 1] = sample.groom[1];
    groom[i * 3 + 2] = sample.groom[2];
    zone[i] = sample.zone;
    restPos[i * 3] = p.x;
    restPos[i * 3 + 1] = p.y;
    restPos[i * 3 + 2] = p.z;
  }

  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  geo.setAttribute('furLength', new THREE.Float32BufferAttribute(furLength, 1));
  geo.setAttribute('coatMask', new THREE.Float32BufferAttribute(coatMask, 1));
  geo.setAttribute('groomDir', new THREE.Float32BufferAttribute(groom, 3));
  geo.setAttribute('coatZone', new THREE.Float32BufferAttribute(zone, 1));
  geo.setAttribute('restPosition', new THREE.Float32BufferAttribute(restPos, 3));
  return geo;
}

function makePathSampler(knots) {
  const pathLen = [0];
  for (let i = 1; i < knots.length; i += 1) {
    pathLen.push(pathLen[i - 1] + knots[i].distanceTo(knots[i - 1]));
  }
  const pathTotal = pathLen[pathLen.length - 1] || 1;
  return (u) => {
    const target = THREE.MathUtils.clamp(u, 0, 1) * pathTotal;
    let i = 0;
    while (i < pathLen.length - 2 && pathLen[i + 1] < target) i += 1;
    const seg = pathLen[i + 1] - pathLen[i] || 1;
    const t = THREE.MathUtils.clamp((target - pathLen[i]) / seg, 0, 1);
    return knots[i].clone().lerp(knots[i + 1], t);
  };
}

function buildJawLoft(ctx, coatLength, coatMaskFn) {
  const {
    muzzle, nose, jawPos, headScale, muzzleWidth, muzzleHeight, jawBone, headCenter, phenotype,
  } = ctx;
  const hs = headScale;
  const mw = muzzleWidth;
  const mh = muzzleHeight;

  const jawStations = [
    {
      c: jawPos.clone().add(new THREE.Vector3(0, 0.002 * hs, -0.008 * hs)),
      bone: jawBone,
      local: sectionPolygon(0.030 * hs * mw, 0.018 * hs * mh, 28, {
        n: 2.4, upperHalf: 0.7, lowerHalf: 1.15, topFlat: 0.2, bottomFlat: 0.1,
      }),
    },
    {
      c: jawPos.clone().lerp(muzzle, 0.4).add(new THREE.Vector3(0, -0.014 * hs, 0)),
      bone: jawBone,
      local: sectionPolygon(0.040 * hs * mw, 0.022 * hs * mh, 28, {
        n: 2.5, upperHalf: 0.65, lowerHalf: 1.2, cheek: 0.12, cheekY: 0.1,
      }),
    },
    {
      c: jawPos.clone().lerp(muzzle, 0.85).add(new THREE.Vector3(0, -0.02 * hs, 0)),
      bone: jawBone,
      local: sectionPolygon(0.038 * hs * mw, 0.020 * hs * mh, 28, {
        n: 2.55, upperHalf: 0.6, lowerHalf: 1.15,
      }),
    },
    {
      c: muzzle.clone().lerp(nose, 0.55).add(new THREE.Vector3(0, -0.024 * hs, 0)),
      bone: jawBone,
      local: sectionPolygon(0.032 * hs * mw, 0.016 * hs * mh, 28, {
        n: 2.6, upperHalf: 0.55, lowerHalf: 1.1, faceFlat: 0.2,
      }),
    },
    {
      c: muzzle.clone().lerp(nose, 0.9).add(new THREE.Vector3(0, -0.02 * hs, -0.002 * hs)),
      bone: jawBone,
      local: sectionPolygon(0.026 * hs * mw, 0.013 * hs * mh, 28, {
        n: 2.7, upperHalf: 0.5, lowerHalf: 1.05, faceFlat: 0.5,
      }),
    },
  ];

  return loftPolyStations(jawStations, (p, t) => {
    const zone = t > 0.45 ? COAT_ZONE.muzzle : COAT_ZONE.head;
    return {
      length: coatLength(zone, p) * 0.6,
      colorMask: coatMaskFn(zone, p),
      groom: headGroomAt(p, headCenter),
      zone,
    };
  });
}

function headCoatFn(ctx, coatLength, coatMaskFn, { tipStart = 0.72, frontStart = 0.4 } = {}) {
  const { headCenter, eyeX, eyeY, eyeZ } = ctx;
  return (p, t) => {
    const zone = t > 0.55 ? COAT_ZONE.muzzle : COAT_ZONE.head;
    let len = coatLength(zone, p);
    if (t > tipStart) {
      const tipAmt = THREE.MathUtils.smoothstep(t, tipStart, 0.98);
      len = THREE.MathUtils.lerp(len, 0.0006, tipAmt * 0.95);
    } else if (t > frontStart) {
      const front = THREE.MathUtils.smoothstep(t, frontStart, 0.7);
      len = Math.min(len, THREE.MathUtils.lerp(len, len * 0.55, front * 0.5));
    }
    const dx = Math.abs(p.x - headCenter.x);
    const dy = p.y - headCenter.y;
    const dz = p.z - headCenter.z;
    const eyeD = Math.hypot(dx - eyeX, (dy - eyeY) * 1.3, (dz - eyeZ) * 0.9);
    const eyeMask = THREE.MathUtils.smoothstep(eyeD, 0.014, 0.034);
    len = Math.min(len, THREE.MathUtils.lerp(0.0005, len, eyeMask));
    return {
      length: len,
      colorMask: coatMaskFn(zone, p),
      groom: headGroomAt(p, headCenter),
      zone,
    };
  };
}

// ---------------------------------------------------------------------------
// Suid (pig / warthog) — curved crown, blocky cylindrical snout
// Rehomed from the poly head that kept reading as a better pig than capybara.
// ---------------------------------------------------------------------------
export function buildSuidPolyHead(ctx) {
  const {
    headCenter, muzzle, nose, headScale,
    skullWidth, skullHeight, skullLength,
    muzzleWidth, muzzleHeight, cheekFullness,
    headBone, muzzleBone, phenotype,
  } = ctx;

  const hs = headScale;
  const sw = skullWidth;
  const sh = skullHeight;
  const sl = skullLength;
  const mw = muzzleWidth;
  const mh = muzzleHeight;
  const cheek = cheekFullness;
  const segs = 40;

  const nape = headCenter.clone().add(new THREE.Vector3(0, 0.002 * hs, -0.05 * hs * sl));
  const path = [
    nape,
    headCenter.clone().add(new THREE.Vector3(0, 0.01 * hs, 0)),
    headCenter.clone().lerp(muzzle, 0.45).add(new THREE.Vector3(0, 0.002 * hs, 0)),
    muzzle.clone().add(new THREE.Vector3(0, -0.004 * hs, 0)),
    muzzle.clone().lerp(nose, 0.55).add(new THREE.Vector3(0, -0.004 * hs, 0)),
    nose.clone().add(new THREE.Vector3(0, -0.002 * hs, 0.004 * hs)),
  ];
  const samplePath = makePathSampler(path);
  const crownLift = (u) => {
    const peak = Math.exp(-((u - 0.22) ** 2) / (2 * 0.12 * 0.12));
    return 0.02 * hs * sh * peak;
  };

  const schedule = [
    { u: 0.0, rx: 0.030 * sw, ry: 0.032 * sh, bone: headBone, n: 2.15, topFlat: 0.1, bottomFlat: 0.16, upper: 1.0, lower: 0.92, cheekAmt: 0.05, cheekY: -0.1, faceFlat: 0 },
    { u: 0.1, rx: 0.044 * sw, ry: 0.046 * sh, bone: headBone, n: 2.18, topFlat: 0.14, bottomFlat: 0.12, upper: 1.0, lower: 0.9, cheekAmt: 0.12, cheekY: -0.08, faceFlat: 0 },
    { u: 0.2, rx: 0.052 * sw, ry: 0.048 * sh, bone: headBone, n: 2.2, topFlat: 0.16, bottomFlat: 0.12, upper: 1.0, lower: 0.9, cheekAmt: 0.18, cheekY: -0.1, faceFlat: 0 },
    { u: 0.32, rx: 0.054 * sw, ry: 0.046 * sh, bone: headBone, n: 2.22, topFlat: 0.14, bottomFlat: 0.12, upper: 0.98, lower: 0.95, cheekAmt: 0.32, cheekY: -0.18, faceFlat: 0 },
    { u: 0.44, rx: 0.055 * mw, ry: 0.046 * mh, bone: headBone, n: 2.24, topFlat: 0.12, bottomFlat: 0.1, upper: 0.94, lower: 1.04, cheekAmt: 0.48, cheekY: -0.22, faceFlat: 0 },
    { u: 0.56, rx: 0.050 * mw, ry: 0.044 * mh, bone: muzzleBone, n: 2.26, topFlat: 0.1, bottomFlat: 0.12, upper: 0.92, lower: 1.06, cheekAmt: 0.28, cheekY: -0.18, faceFlat: 0 },
    { u: 0.68, rx: 0.046 * mw, ry: 0.042 * mh, bone: muzzleBone, n: 2.28, topFlat: 0.1, bottomFlat: 0.12, upper: 0.94, lower: 1.05, cheekAmt: 0.14, cheekY: -0.12, faceFlat: 0.05 },
    { u: 0.8, rx: 0.042 * mw, ry: 0.038 * mh, bone: muzzleBone, n: 2.3, topFlat: 0.1, bottomFlat: 0.14, upper: 0.95, lower: 1.02, cheekAmt: 0.06, cheekY: -0.08, faceFlat: 0.18 },
    { u: 0.9, rx: 0.038 * mw, ry: 0.034 * mh, bone: muzzleBone, n: 2.32, topFlat: 0.1, bottomFlat: 0.14, upper: 0.96, lower: 1.0, cheekAmt: 0.02, cheekY: 0, faceFlat: 0.35 },
    { u: 1.0, rx: 0.034 * mw, ry: 0.030 * mh, bone: muzzleBone, n: 2.35, topFlat: 0.08, bottomFlat: 0.16, upper: 0.98, lower: 0.98, cheekAmt: 0, cheekY: 0, faceFlat: 0.55 },
  ];

  const stations = schedule.map((s) => {
    const c = samplePath(s.u);
    c.y += crownLift(s.u);
    return {
      c,
      bone: s.bone,
      local: sectionPolygon(s.rx * hs, s.ry * hs, segs, {
        n: s.n,
        topFlat: s.topFlat,
        bottomFlat: s.bottomFlat,
        upperHalf: s.upper,
        lowerHalf: s.lower,
        cheek: s.cheekAmt * cheek,
        cheekY: s.cheekY,
        faceFlat: s.faceFlat,
      }),
    };
  });

  const coatLength = (zone, p) => lengthAt(zone, p, headCenter, phenotype);
  const coatMaskFn = (zone, p) => colorMaskAt(zone, p, headCenter, phenotype);
  const headMesh = loftPolyStations(stations, headCoatFn(ctx, coatLength, coatMaskFn));
  const jawMesh = buildJawLoft(ctx, coatLength, coatMaskFn);
  return [headMesh, jawMesh];
}

// ---------------------------------------------------------------------------
// Caviid (capybara) — domed blocky head, blunt rounded snout
//
// Reference silhouette (assets-source/rodent-ref/capybara/board.jpg):
//  - Gently DOMED dorsal line: highest point ~1/3 forward from the nape
//    (u≈0.33), gradual slope down to the nose. NOT a flat-top rectangle.
//  - Blunt ROUNDED snout tip (soft, not squared-off); boxy/full muzzle that
//    stays wide nearly to the tip.
//  - Full-but-light rounded jaw (no heavy low jowl).
//  - Wedge profile: taller/wider at the crown, tapering toward the nose.
//  - Snout ≈ 1/3 of length, skull ≈ 2/3; length ≈ 1.2 × height.
//  - Single continuous mesh (the earlier "drawer plank" jaw is gone); a tiny
//    internal jaw token stays hidden inside for open-mouth frames.
//  - Authored along +Z with per-station top/bot Y so the dog-rig NoseTip bone
//    can't drag the snout into a thin detached plank.
// ---------------------------------------------------------------------------
export function buildCaviidPolyHead(ctx) {
  const {
    headCenter, nose, headScale,
    skullWidth, skullHeight, skullLength,
    muzzleWidth, muzzleHeight, cheekFullness,
    headBone, muzzleBone, phenotype,
  } = ctx;

  const hs = headScale;
  const sw = skullWidth;
  const sh = skullHeight;
  const sl = skullLength;
  const mw = muzzleWidth;
  const mh = muzzleHeight;
  const cheek = cheekFullness;
  const segs = 48;

  // Z path: nape → nose tip. Length tracks the skeleton muzzle but stays
  // compact (the reference is a short blocky head, ~1.2× its height, not a
  // long pipe).
  const napeZ = headCenter.z - 0.022 * hs * sl;
  const tipZ = Math.max(nose.z + 0.003 * hs, headCenter.z + 0.072 * hs);

  // Per-station top/bot Y offsets from headCenter.y (× hs × height factor).
  // top peaks at u≈0.33 (crown); both top and bot taper toward the blunt nose.
  // Skull (u<0.6) uses sh; snout (u≥0.6) uses mh. topFlat/botFlat stay small
  // so the crown is rounded, not flat; faceFlat stays 0 so the snout tip is
  // rounded/blunt, not squared. Cheek is centered near the equator (full
  // cheek, no low jowl). Width holds nearly to the tip (boxy muzzle).
  const sched = [
    { u: 0.00, top: 0.052, bot: -0.044, rxM: 0.046, w: 'sw', n: 2.35, tF: 0.10, bF: 0.16, ck: 0.06, ckY: -0.05, bone: headBone },
    { u: 0.10, top: 0.060, bot: -0.048, rxM: 0.054, w: 'sw', n: 2.38, tF: 0.10, bF: 0.16, ck: 0.14, ckY: -0.06, bone: headBone },
    { u: 0.22, top: 0.070, bot: -0.049, rxM: 0.058, w: 'sw', n: 2.40, tF: 0.09, bF: 0.15, ck: 0.22, ckY: -0.08, bone: headBone },
    { u: 0.33, top: 0.074, bot: -0.049, rxM: 0.058, w: 'sw', n: 2.42, tF: 0.08, bF: 0.14, ck: 0.26, ckY: -0.10, bone: headBone },
    { u: 0.45, top: 0.068, bot: -0.047, rxM: 0.056, w: 'sw', n: 2.44, tF: 0.08, bF: 0.14, ck: 0.22, ckY: -0.10, bone: headBone },
    { u: 0.55, top: 0.057, bot: -0.043, rxM: 0.054, w: 'sw', n: 2.46, tF: 0.08, bF: 0.14, ck: 0.16, ckY: -0.08, bone: headBone },
    { u: 0.66, top: 0.049, bot: -0.037, rxM: 0.052, w: 'mw', n: 2.48, tF: 0.08, bF: 0.15, ck: 0.10, ckY: -0.05, bone: muzzleBone },
    { u: 0.77, top: 0.042, bot: -0.030, rxM: 0.048, w: 'mw', n: 2.50, tF: 0.09, bF: 0.16, ck: 0.05, ckY: -0.02, bone: muzzleBone },
    { u: 0.86, top: 0.038, bot: -0.026, rxM: 0.046, w: 'mw', n: 2.52, tF: 0.10, bF: 0.17, ck: 0.02, ckY: 0.00, bone: muzzleBone },
    { u: 0.93, top: 0.036, bot: -0.024, rxM: 0.045, w: 'mw', n: 2.55, tF: 0.12, bF: 0.18, ck: 0.00, ckY: 0.00, bone: muzzleBone },
    { u: 1.00, top: 0.038, bot: -0.025, rxM: 0.045, w: 'mw', n: 2.60, tF: 0.16, bF: 0.20, ck: 0.00, ckY: 0.00, bone: muzzleBone },
  ];

  const stations = sched.map((s) => {
    const z = THREE.MathUtils.lerp(napeZ, tipZ, s.u);
    const hf = s.u < 0.6 ? sh : mh;
    const topY = headCenter.y + s.top * hs * hf;
    const botY = headCenter.y + s.bot * hs * hf;
    const cy = (topY + botY) * 0.5;
    const ry = (topY - botY) * 0.5;
    const rx = s.rxM * hs * (s.w === 'sw' ? sw : mw);
    return {
      c: new THREE.Vector3(0, cy, z),
      bone: s.bone,
      local: sectionPolygon(rx, ry, segs, {
        n: s.n,
        topFlat: s.tF,
        bottomFlat: s.bF,
        upperHalf: 1.0,
        lowerHalf: 1.0,
        cheek: s.ck * cheek,
        cheekY: s.ckY,
        faceFlat: 0,
      }),
    };
  });

  const coatLength = (zone, p) => lengthAt(zone, p, headCenter, phenotype);
  const coatMaskFn = (zone, p) => colorMaskAt(zone, p, headCenter, phenotype);

  // Single solid — no separate jaw mesh (closed-mouth capybara stills).
  const headMesh = loftPolyStations(
    stations,
    headCoatFn(ctx, coatLength, coatMaskFn, { tipStart: 0.82, frontStart: 0.55 }),
  );

  // Tiny internal jaw token so mouth-open frames still have a hinge mass, but
  // it stays fully INSIDE the solid (never a visible plank).
  const jawRy = 0.006 * hs;
  const jawInside = [
    {
      c: new THREE.Vector3(0, headCenter.y - 0.030 * hs, THREE.MathUtils.lerp(napeZ, tipZ, 0.4)),
      bone: ctx.jawBone,
      local: sectionPolygon(0.028 * hs * mw, jawRy, 20, { n: 2.5, upperHalf: 0.4, lowerHalf: 1.0 }),
    },
    {
      c: new THREE.Vector3(0, headCenter.y - 0.030 * hs, THREE.MathUtils.lerp(napeZ, tipZ, 0.85)),
      bone: ctx.jawBone,
      local: sectionPolygon(0.022 * hs * mw, jawRy * 0.85, 20, { n: 2.6, upperHalf: 0.4, lowerHalf: 1.0 }),
    },
  ];
  const jawMesh = loftPolyStations(jawInside, (p, t) => ({
    length: 0.0004,
    colorMask: coatMaskFn(COAT_ZONE.muzzle, p) * 0.3,
    groom: headGroomAt(p, headCenter),
    zone: COAT_ZONE.muzzle,
  }));

  return [headMesh, jawMesh];
}

// ---------------------------------------------------------------------------
// Equid (horse) — long rectangular head: deep cheek/masseter at the back,
// flat forehead with a slight brow, straight nasal line, long tapering
// rectangular muzzle ending in a soft squared tip (no dog stop).
// Path follows the Head→Muzzle→NoseTip bones so the head keeps the equid
// down-forward carriage from the skeleton.
// ---------------------------------------------------------------------------
export function buildEquidPolyHead(ctx) {
  const {
    headCenter, muzzle, nose, headScale,
    skullWidth, skullHeight, skullLength,
    muzzleWidth, muzzleHeight, cheekFullness,
    headBone, muzzleBone, phenotype,
  } = ctx;

  const hs = headScale;
  const sw = skullWidth;
  const sh = skullHeight;
  const sl = skullLength;
  const mw = muzzleWidth;
  const mh = muzzleHeight;
  const cheek = Math.max(cheekFullness, 0.4);
  const segs = 44;

  // Nape reaches back far enough to overlap the raised neck loft (carriage
  // leaves a visible ring gap otherwise).
  const nape = headCenter.clone().add(new THREE.Vector3(0, 0.002 * hs, -0.072 * hs * sl));
  const path = [
    nape,
    headCenter.clone().add(new THREE.Vector3(0, 0.008 * hs, 0)),
    headCenter.clone().lerp(muzzle, 0.5).add(new THREE.Vector3(0, 0, 0)),
    muzzle.clone().add(new THREE.Vector3(0, -0.004 * hs, 0)),
    muzzle.clone().lerp(nose, 0.6).add(new THREE.Vector3(0, -0.006 * hs, 0)),
    nose.clone().add(new THREE.Vector3(0, -0.006 * hs, 0.002 * hs)),
  ];
  const samplePath = makePathSampler(path);
  // Slight brow rise at the crown; nasal line declines gently to the nose.
  const profileLift = (u) => {
    const brow = Math.exp(-((u - 0.16) ** 2) / (2 * 0.1 * 0.1));
    const drop = THREE.MathUtils.smoothstep(u, 0.55, 1);
    return 0.01 * hs * sh * brow - 0.006 * hs * drop;
  };

  const schedule = [
    { u: 0.0, rx: 0.028 * sw, ry: 0.040 * sh, bone: headBone, n: 2.2, topFlat: 0.1, bottomFlat: 0.1, upper: 1.0, lower: 1.0, cheekAmt: 0.05, cheekY: -0.1, faceFlat: 0 },
    { u: 0.1, rx: 0.044 * sw, ry: 0.050 * sh, bone: headBone, n: 2.25, topFlat: 0.16, bottomFlat: 0.08, upper: 0.98, lower: 1.08, cheekAmt: 0.22, cheekY: -0.12, faceFlat: 0 },
    { u: 0.2, rx: 0.048 * sw, ry: 0.053 * sh, bone: headBone, n: 2.28, topFlat: 0.18, bottomFlat: 0.08, upper: 0.96, lower: 1.16, cheekAmt: 0.42, cheekY: -0.16, faceFlat: 0 },
    { u: 0.32, rx: 0.045 * sw, ry: 0.049 * sh, bone: headBone, n: 2.28, topFlat: 0.16, bottomFlat: 0.09, upper: 0.95, lower: 1.1, cheekAmt: 0.34, cheekY: -0.16, faceFlat: 0 },
    { u: 0.45, rx: 0.055 * mw, ry: 0.042 * sh, bone: headBone, n: 2.3, topFlat: 0.14, bottomFlat: 0.1, upper: 0.95, lower: 1.02, cheekAmt: 0.18, cheekY: -0.1, faceFlat: 0 },
    { u: 0.58, rx: 0.051 * mw, ry: 0.037 * mh, bone: muzzleBone, n: 2.32, topFlat: 0.13, bottomFlat: 0.11, upper: 0.95, lower: 1.0, cheekAmt: 0.08, cheekY: -0.05, faceFlat: 0.04 },
    { u: 0.72, rx: 0.048 * mw, ry: 0.033 * mh, bone: muzzleBone, n: 2.34, topFlat: 0.12, bottomFlat: 0.12, upper: 0.96, lower: 0.99, cheekAmt: 0.03, cheekY: 0, faceFlat: 0.08 },
    { u: 0.84, rx: 0.046 * mw, ry: 0.030 * mh, bone: muzzleBone, n: 2.38, topFlat: 0.12, bottomFlat: 0.13, upper: 0.97, lower: 0.98, cheekAmt: 0, cheekY: 0, faceFlat: 0.16 },
    { u: 0.93, rx: 0.045 * mw, ry: 0.028 * mh, bone: muzzleBone, n: 2.44, topFlat: 0.13, bottomFlat: 0.14, upper: 0.98, lower: 0.97, cheekAmt: 0, cheekY: 0, faceFlat: 0.3 },
    { u: 1.0, rx: 0.042 * mw, ry: 0.026 * mh, bone: muzzleBone, n: 2.5, topFlat: 0.14, bottomFlat: 0.15, upper: 0.98, lower: 0.96, cheekAmt: 0, cheekY: 0, faceFlat: 0.45 },
  ];

  const stations = schedule.map((s) => {
    const c = samplePath(s.u);
    c.y += profileLift(s.u);
    return {
      c,
      bone: s.bone,
      local: sectionPolygon(s.rx * hs, s.ry * hs, segs, {
        n: s.n,
        topFlat: s.topFlat,
        bottomFlat: s.bottomFlat,
        upperHalf: s.upper,
        lowerHalf: s.lower,
        cheek: s.cheekAmt * cheek,
        cheekY: s.cheekY,
        faceFlat: s.faceFlat,
      }),
    };
  });

  const coatLength = (zone, p) => lengthAt(zone, p, headCenter, phenotype);
  const coatMaskFn = (zone, p) => colorMaskAt(zone, p, headCenter, phenotype);
  const headMesh = loftPolyStations(
    stations,
    headCoatFn(ctx, coatLength, coatMaskFn, { tipStart: 0.8, frontStart: 0.5 }),
  );
  // Closed-mouth stills: compact internal jaw token (hinge mass for open-mouth
  // frames). The shared jaw loft is wider than this narrow muzzle and poked
  // through the side walls as a discolored band.
  const jawRy = 0.007 * hs;
  const jawInside = [
    {
      c: samplePath(0.5).add(new THREE.Vector3(0, -0.024 * hs * mh, 0)),
      bone: ctx.jawBone,
      local: sectionPolygon(0.03 * hs * mw, jawRy, 20, { n: 2.5, upperHalf: 0.4, lowerHalf: 1.0 }),
    },
    {
      c: samplePath(0.88).add(new THREE.Vector3(0, -0.018 * hs * mh, 0)),
      bone: ctx.jawBone,
      local: sectionPolygon(0.024 * hs * mw, jawRy * 0.85, 20, { n: 2.6, upperHalf: 0.4, lowerHalf: 1.0 }),
    },
  ];
  const jawMesh = loftPolyStations(jawInside, (p) => ({
    length: 0.0004,
    colorMask: coatMaskFn(COAT_ZONE.muzzle, p) * 0.3,
    groom: headGroomAt(p, headCenter),
    zone: COAT_ZONE.muzzle,
  }));
  return [headMesh, jawMesh];
}

/**
 * Eye placement radii for the equid head: eyes sit on the SIDE WALL at the
 * brow (wide monocular field), not on a forward sphere surface.
 */
export function equidEyeSkullRadii(headScale, skullWidth, skullHeight, skullLength) {
  return {
    skullRx: 0.046 * headScale * skullWidth,
    skullRy: 0.05 * headScale * skullHeight,
    skullRz: 0.07 * headScale * 1.1 * skullLength,
    eyeYBoost: 0.012 * headScale,
    eyeZBase: 0.004,
  };
}

/**
 * Approximate skull radii for eye placement (head features).
 */
export function caviidEyeSkullRadii(headScale, skullWidth, skullHeight, skullLength) {
  return {
    skullRx: 0.054 * headScale * skullWidth,
    skullRy: 0.042 * headScale * skullHeight,
    skullRz: 0.07 * headScale * 1.1 * skullLength,
    eyeYBoost: 0.01 * headScale,
    eyeZBase: 0.016,
  };
}

export function suidEyeSkullRadii(headScale, skullWidth, skullHeight, skullLength) {
  return {
    skullRx: 0.054 * headScale * skullWidth,
    skullRy: 0.046 * headScale * skullHeight,
    skullRz: 0.07 * headScale * 1.2 * skullLength,
    eyeYBoost: 0.006 * headScale,
    eyeZBase: 0.014,
  };
}
