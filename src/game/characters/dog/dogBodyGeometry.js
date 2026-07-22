/**
 * Procedural dog body from skeleton bind world positions.
 * Dense continuous lofts tuned toward golden-retriever silhouette
 * (broad skull, soft stop, flopped ears, plush ruff).
 */

import * as THREE from 'three';
import { mergeGeometries } from '../../../three-addons/utils/BufferGeometryUtils.js';
import { LoftGeometry } from '../../../three-addons/geometries/LoftGeometry.js';
import { DOG_LEG_CHAINS, DOG_TAIL_BONES, DOG_EAR_BONES } from './dogSkeleton.js';
import {
  COAT_ZONE,
  headGroomAt,
  bodyGroomAt,
  earGroomAt,
  lengthAt,
  colorMaskAt,
  packCoatMask,
  hairPartStrength,
} from './dogCoatFields.js';
import { buildCaviidPolyHead, buildEquidPolyHead, buildSuidPolyHead } from './animalPolyHead.js';

export { COAT_ZONE };

function monoSkin(a) {
  return { indices: [a, 0, 0, 0], weights: [1, 0, 0, 0] };
}

function blendSkin(a, b, t) {
  const w = THREE.MathUtils.clamp(t, 0, 1);
  return { indices: [a, b, 0, 0], weights: [1 - w, w, 0, 0] };
}

/**
 * @param {THREE.BufferGeometry} geo
 * @param {(i: number, p: THREE.Vector3) => object} sample
 */
function stampPerVertex(geo, sample) {
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
    const s = sample(i, p);
    skinIndex[i * 4] = s.indices[0];
    skinIndex[i * 4 + 1] = s.indices[1];
    skinIndex[i * 4 + 2] = s.indices[2];
    skinIndex[i * 4 + 3] = s.indices[3];
    skinWeight[i * 4] = s.weights[0];
    skinWeight[i * 4 + 1] = s.weights[1];
    skinWeight[i * 4 + 2] = s.weights[2];
    skinWeight[i * 4 + 3] = s.weights[3];
    furLength[i] = s.length;
    // Pack coat color + inner-pinna flag + anatomical zone in one scalar.
    // `coatZone` remains available to CPU/debug tools, while shaders decode it
    // here to stay below the WebGPU eight-active-buffer limit.
    coatMask[i] = packCoatMask(s.colorMask, s.zone, !!s.earInner);
    groom[i * 3] = s.groom[0];
    groom[i * 3 + 1] = s.groom[1];
    groom[i * 3 + 2] = s.groom[2];
    zone[i] = s.zone;
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

function ringAt(rx, ry, segs, center, tangent, upHint = new THREE.Vector3(0, 1, 0)) {
  const t = tangent.clone().normalize();
  let up = upHint.clone();
  let side = new THREE.Vector3().crossVectors(up, t);
  if (side.lengthSq() < 1e-8) {
    up = new THREE.Vector3(1, 0, 0);
    side = new THREE.Vector3().crossVectors(up, t);
  }
  side.normalize();
  up = new THREE.Vector3().crossVectors(t, side).normalize();

  const pts = [];
  for (let i = 0; i < segs; i += 1) {
    const a = (i / segs) * Math.PI * 2;
    pts.push(
      center.clone()
        .addScaledVector(side, Math.cos(a) * rx)
        .addScaledVector(up, Math.sin(a) * ry),
    );
  }
  return pts;
}

/**
 * Superellipse ring for softer, fuller cross-sections (n > 2 → squarer, n < 2 → diamond).
 * Golden body uses n≈2.2 for a plush rounded look.
 */
function softRingAt(rx, ry, segs, center, tangent, n = 2.2, upHint = new THREE.Vector3(0, 1, 0)) {
  const t = tangent.clone().normalize();
  let up = upHint.clone();
  let side = new THREE.Vector3().crossVectors(up, t);
  if (side.lengthSq() < 1e-8) {
    up = new THREE.Vector3(1, 0, 0);
    side = new THREE.Vector3().crossVectors(up, t);
  }
  side.normalize();
  up = new THREE.Vector3().crossVectors(t, side).normalize();

  const pts = [];
  const invN = 1 / n;
  for (let i = 0; i < segs; i += 1) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // Superellipse radius scale
    const sx = Math.sign(c) * (Math.abs(c) ** invN);
    const sy = Math.sign(s) * (Math.abs(s) ** invN);
    pts.push(
      center.clone()
        .addScaledVector(side, sx * rx)
        .addScaledVector(up, sy * ry),
    );
  }
  return pts;
}

/**
 * Rotates `vec` by the minimal rotation that takes `fromDir` to `toDir`
 * (both treated as directions, not normalized in place).
 */
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

function loftChain(stations, segs, coatFn, { soft = true, n = 2.15 } = {}) {
  if (stations.length < 2) throw new Error('loftChain needs ≥2 stations');
  const sections = [];
  // Ring orientation is propagated (parallel-transported) from station to
  // station instead of re-derived from a fixed world-up each time. Chains
  // that bend sharply (torso→leg attach into the near-vertical upper leg,
  // pastern into the forward-pointing paw pad) would otherwise recompute
  // `side = up × tangent` independently per ring; near-vertical tangents make
  // that cross product unstable, so the ring basis can flip/rotate abruptly
  // between adjacent rings — the "twisted leg" seam. Stations with an
  // explicit `up` (ears, tail) opt out and keep their authored orientation.
  let propagatedUp = new THREE.Vector3(0, 1, 0);
  let prevTangent = null;
  for (let i = 0; i < stations.length; i += 1) {
    const s = stations[i];
    const prev = stations[Math.max(0, i - 1)].c;
    const next = stations[Math.min(stations.length - 1, i + 1)].c;
    const tangent = next.clone().sub(prev);
    if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1);
    let upHint;
    if (s.up) {
      upHint = s.up;
      propagatedUp = s.up.clone();
    } else {
      if (prevTangent) propagatedUp = rotateTowards(propagatedUp, prevTangent, tangent);
      upHint = propagatedUp;
    }
    const ring = soft
      ? softRingAt(s.rx, s.ry, segs, s.c, tangent, s.n ?? n, upHint)
      : ringAt(s.rx, s.ry, segs, s.c, tangent, upHint);
    sections.push(ring);
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

  stampPerVertex(geo, (_i, p) => {
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
    return { ...skin, ...coatFn(p, stationT) };
  });
  return geo;
}

/**
 * Thin, double-sided skinned ear leather. Unlike an elliptical loft this keeps
 * a pinna leaf-like in silhouette instead of turning folds into thick paddles
 * and erect ears into cones.
 */
function earLeafGeometry(stations, coatFn, {
  thickness = 0.003,
  faceNormal = new THREE.Vector3(0, 0, 1),
  // When set, the "inner" face (short fur / dark tint, vertexIndex%4<2) is
  // derived per-station as the direction toward this point instead of a
  // fixed world axis. A fixed axis picks an arbitrary face per ear chain —
  // since the two ears are mirror images, the *same* fixed axis can resolve
  // to the skull-facing side on one ear and the outward (long-fur) side on
  // the other, leaving one ear looking bald/flat while its mirror looks
  // properly furred. Anchoring to the skull center keeps "inner" always
  // facing the head and "outer" (full coat) always facing away, on both
  // ears symmetrically.
  innerTowardPoint = null,
} = {}) {
  if (stations.length < 2) throw new Error('earLeafGeometry needs at least two stations');
  const positions = [];
  const indices = [];
  const frames = [];
  let previousWidth = null;

  for (let i = 0; i < stations.length; i += 1) {
    const prev = stations[Math.max(0, i - 1)].c;
    const next = stations[Math.min(stations.length - 1, i + 1)].c;
    const tangent = next.clone().sub(prev).normalize();
    const station = stations[i];
    const stationFaceNormal = innerTowardPoint
      ? innerTowardPoint.clone().sub(station.c).normalize()
      : faceNormal;
    const normal = stationFaceNormal.clone().addScaledVector(tangent, -stationFaceNormal.dot(tangent));
    if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
    normal.normalize();
    const widthDir = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    if (previousWidth && widthDir.dot(previousWidth) < 0) widthDir.negate();
    previousWidth = widthDir.clone();
    frames.push({ normal, widthDir });

    const halfThickness = thickness * 0.5;
    const left = station.c.clone().addScaledVector(widthDir, -station.width);
    const right = station.c.clone().addScaledVector(widthDir, station.width);
    for (const point of [
      left.clone().addScaledVector(normal, halfThickness),
      right.clone().addScaledVector(normal, halfThickness),
      left.clone().addScaledVector(normal, -halfThickness),
      right.clone().addScaledVector(normal, -halfThickness),
    ]) positions.push(point.x, point.y, point.z);
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a = i * 4;
    const b = (i + 1) * 4;
    // Front (+faceNormal), back, and both leather edges.
    indices.push(a, b, b + 1, a, b + 1, a + 1);
    indices.push(a + 2, a + 3, b + 3, a + 2, b + 3, b + 2);
    indices.push(a, a + 2, b + 2, a, b + 2, b);
    indices.push(a + 1, b + 1, b + 3, a + 1, b + 3, a + 3);
  }
  const last = (stations.length - 1) * 4;
  indices.push(0, 1, 3, 0, 3, 2);
  indices.push(last, last + 2, last + 3, last, last + 3, last + 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const lengths = [0];
  let total = 0;
  for (let i = 1; i < stations.length; i += 1) {
    total += stations[i].c.distanceTo(stations[i - 1].c);
    lengths.push(total);
  }
  total = Math.max(total, 1e-6);

  stampPerVertex(geo, (vertexIndex, p) => {
    let bestSeg = 0;
    let bestT = 0;
    let bestDist = Infinity;
    for (let i = 0; i < stations.length - 1; i += 1) {
      const a = stations[i].c;
      const b = stations[i + 1].c;
      const ab = b.clone().sub(a);
      const lenSq = Math.max(ab.lengthSq(), 1e-8);
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lenSq, 0, 1);
      const distance = a.clone().addScaledVector(ab, t).distanceToSquared(p);
      if (distance < bestDist) {
        bestDist = distance;
        bestSeg = i;
        bestT = t;
      }
    }
    const stationT = (lengths[bestSeg]
      + bestT * (lengths[bestSeg + 1] - lengths[bestSeg])) / total;
    const inner = vertexIndex % 4 < 2 ? 1 : 0;
    const coat = coatFn(p, stationT);
    return {
      ...blendSkin(stations[bestSeg].bone, stations[bestSeg + 1].bone, bestT),
      ...coat,
      length: coat.length * (inner ? 0.32 : 1),
      earInner: inner,
    };
  });
  return geo;
}

/**
 * @param {ReturnType<import('./dogSkeleton.js').createDogSkeleton>} rig
 */
export function buildDogBodyGeometry(rig, phenotype = rig.phenotype ?? null) {
  const { boneIndex, worldBindPos } = rig;
  const idx = (name) => {
    const i = boneIndex.get(name);
    if (i == null) throw new Error(`Missing bone ${name}`);
    return i;
  };
  const wp = (name) => worldBindPos.get(name).clone();
  const headCenter = wp('Head');
  const shape = phenotype?.skeleton ?? {};
  const geom = phenotype?.geometry ?? {};
  const headScale = shape.headSize ?? 1;
  const torsoWidth = geom.torsoWidth ?? 1;
  const torsoDepth = geom.torsoDepth ?? 1;
  const backArch = geom.backArch ?? 0;
  const frontTaper = geom.frontTaper ?? 1;
  const neckWidth = geom.neckWidth ?? 1;
  const skullWidth = geom.skullWidth ?? 1;
  const skullHeight = geom.skullHeight ?? 1;
  const skullLength = geom.skullLength ?? 1;
  const cheekFullness = geom.cheekFullness ?? 1;
  const muzzleWidth = geom.muzzleWidth ?? 1;
  // Vertical depth of the muzzle loft (suid blocky snouts / poly head scales).
  const muzzleHeight = geom.muzzleHeight ?? 1;
  // Named head silhouettes:
  //   canid     — sphere skull + soft muzzle loft + cheek spheres (default)
  //   suid      — blocky rectangular loft (pig / warthog); was mis-used as capybara
  //   caviid    — continuous polygonal head (capybara) via animalPolyHead.js
  // 'hydrochoerine' kept as alias of 'suid' for older phenotypes.
  const headShape = geom.headShape ?? 'canid';
  const isCaviidPoly = headShape === 'caviid';
  const isEquid = headShape === 'equid';
  const isSuid = headShape === 'suid' || headShape === 'hydrochoerine';
  const isHydrochoerine = isSuid; // legacy name used by the blocky loft path
  const legThickness = geom.legThickness ?? 1;
  // Haunches default slightly bulkier than the front column (real quadruped
  // read). Phenotypes may push further via hindLegThickness (felines).
  const hindLegThickness = geom.hindLegThickness
    ?? legThickness * 1.14;
  const pawSize = geom.pawSize ?? 1;
  const faceShape = phenotype?.face ?? {};
  const eyeX = (isEquid ? 0.044 : 0.032) * headScale * (faceShape.eyeSpacing ?? 1);
  const eyeY = 0.016 * headScale * (faceShape.eyeHeight ?? 1) + (isEquid ? 0.012 * headScale : 0);
  // Match skullRx/Ry/Rz to the actual head mesh scales (canid / suid / caviid).
  const skullRx = 0.07 * headScale * (isCaviidPoly ? 0.78 : isSuid ? 0.95 : 1.18) * skullWidth;
  const skullRy = 0.07 * headScale * (isCaviidPoly ? 0.72 : isSuid ? 0.9 : 0.97) * skullHeight;
  const skullRz = 0.07 * headScale * (isCaviidPoly ? 1.05 : isSuid ? 1.2 : 1.1) * skullLength;
  const eyeSurface = Math.sqrt(Math.max(
    0.08,
    1 - (eyeX / skullRx) ** 2 - ((eyeY - 0.008) / skullRy) ** 2,
  ));
  const eyeZ = isEquid
    ? 0.01 * headScale * skullLength * (faceShape.eyeForward ?? 1)
    : 0.005 + skullRz * eyeSurface
      + ((faceShape.eyeForward ?? 1) - 1) * 0.008 * headScale;
  const coatLength = (zone, p) => lengthAt(zone, p, headCenter, phenotype);
  const coatMask = (zone, p) => colorMaskAt(zone, p, headCenter, phenotype);

  /** @type {THREE.BufferGeometry[]} */
  const parts = [];

  // ---- Torso (plush golden body — wider chest, soft belly) ----
  {
    const pelvis = wp('Pelvis');
    const spine = wp('Spine');
    const spine1 = wp('Spine1');
    const chest = wp('Chest');
    const neck = wp('Neck');

    const stations = [
      { c: pelvis.clone().add(new THREE.Vector3(0, -0.01, -0.06)), rx: 0.095 * torsoWidth, ry: 0.105 * torsoDepth, bone: idx('Pelvis') },
      { c: pelvis.clone().add(new THREE.Vector3(0, 0.018 + backArch * 0.35, 0.02)), rx: 0.12 * torsoWidth, ry: 0.128 * torsoDepth, bone: idx('Pelvis') },
      { c: spine.clone().add(new THREE.Vector3(0, backArch * 0.72, 0)), rx: 0.128 * torsoWidth, ry: 0.138 * torsoDepth, bone: idx('Spine') },
      { c: spine1.clone().add(new THREE.Vector3(0, backArch, 0)), rx: 0.132 * torsoWidth * THREE.MathUtils.lerp(1, frontTaper, 0.42), ry: 0.142 * torsoDepth * THREE.MathUtils.lerp(1, frontTaper, 0.35), bone: idx('Spine1') },
      { c: chest.clone().add(new THREE.Vector3(0, backArch * 0.42, 0)), rx: 0.13 * torsoWidth * frontTaper, ry: 0.14 * torsoDepth * frontTaper, bone: idx('Chest') },
      // Thick neck ruff base
      { c: chest.clone().lerp(neck, 0.45), rx: 0.105 * neckWidth, ry: 0.11 * neckWidth, bone: idx('Chest') },
      { c: neck.clone().add(new THREE.Vector3(0, -0.008, -0.012)), rx: 0.082 * neckWidth, ry: 0.088 * neckWidth, bone: idx('Neck') },
    ];
    parts.push(loftChain(stations, 36, (p) => {
      const zone = p.y < pelvis.y - 0.05 ? COAT_ZONE.belly : COAT_ZONE.body;
      return {
        length: coatLength(zone, p),
        colorMask: coatMask(zone, p),
        groom: bodyGroomAt(p),
        zone,
      };
    }));
  }

  // ---- Neck ----
  {
    const neck = wp('Neck');
    const head = wp('Head');
    const stations = [
      { c: neck, rx: 0.078 * neckWidth, ry: 0.082 * neckWidth, bone: idx('Neck') },
      { c: neck.clone().lerp(head, 0.4), rx: 0.074 * neckWidth, ry: 0.078 * neckWidth, bone: idx('Neck') },
      { c: neck.clone().lerp(head, 0.75), rx: 0.07 * neckWidth, ry: 0.074 * neckWidth, bone: idx('Head') },
      { c: head.clone().add(new THREE.Vector3(0, -0.012, -0.02)), rx: 0.068 * neckWidth, ry: 0.072 * neckWidth, bone: idx('Head') },
    ];
    parts.push(loftChain(stations, 28, (p) => ({
      length: coatLength(COAT_ZONE.body, p) * (1 + (phenotype?.furnishings?.ruff ?? 0) * 0.3),
      colorMask: coatMask(COAT_ZONE.body, p),
      groom: bodyGroomAt(p),
      zone: COAT_ZONE.body,
    })));
  }

  // ---- Lion-mane collar (furnishings.mane, ruffed longhair cats) ----
  // A dedicated flared loft around the neck: widest ring frames the face
  // just behind the skull, tapering down over the shoulders into the chest
  // (lion-mane taper) instead of just lengthening neck fur. Fur is stamped
  // long over the collar and grooms radially outward with a downward bias so
  // the shells read as a mane, not an Elizabethan cone.
  const maneAmount = THREE.MathUtils.clamp(phenotype?.furnishings?.mane ?? 0, 0, 1);
  if (maneAmount > 0.01) {
    const chest = wp('Chest');
    const neck = wp('Neck');
    const head = wp('Head');
    const flare = (f) => THREE.MathUtils.lerp(1, f, maneAmount);
    const baseR = 0.095 * Math.max(neckWidth, 0.5);
    const headR = 0.07 * headScale * Math.max(skullWidth, 0.6);
    const stations = [
      { c: chest.clone().add(new THREE.Vector3(0, -0.028, 0.035)), rx: baseR * flare(1.12), ry: baseR * flare(1.18), bone: idx('Chest') },
      { c: chest.clone().lerp(neck, 0.55).add(new THREE.Vector3(0, 0.004, 0)), rx: baseR * flare(1.38), ry: baseR * flare(1.42), bone: idx('Chest') },
      { c: neck.clone().add(new THREE.Vector3(0, 0.008, 0.004)), rx: baseR * flare(1.45), ry: baseR * flare(1.38), bone: idx('Neck') },
      { c: neck.clone().lerp(head, 0.66), rx: headR * flare(1.45), ry: headR * flare(1.3), bone: idx('Head') },
      { c: head.clone().add(new THREE.Vector3(0, 0.002, 0.012)), rx: headR * flare(1.36), ry: headR * flare(1.22), bone: idx('Head') },
      // Snug closing ring hidden inside the skull so the end cap never shows.
      { c: head.clone().add(new THREE.Vector3(0, 0.004, 0.03)), rx: headR * 0.72, ry: headR * 0.68, bone: idx('Head') },
    ];
    const axisA = stations[0].c.clone();
    const axisB = stations[stations.length - 1].c.clone();
    const axisDir = axisB.clone().sub(axisA).normalize();
    parts.push(loftChain(stations, 32, (p, t) => {
      // Taper: fullest framing the face (t≈0.8), fading into body coat at the
      // chest end and pulling short at the closing ring so the face stays clear.
      const frame = THREE.MathUtils.smoothstep(t, 0.15, 0.72);
      const faceFade = 1 - THREE.MathUtils.smoothstep(t, 0.86, 1) * 0.75;
      const onAxis = axisA.clone().addScaledVector(
        axisDir,
        THREE.MathUtils.clamp(p.clone().sub(axisA).dot(axisDir), 0, axisB.clone().sub(axisA).length()),
      );
      const out = p.clone().sub(onAxis);
      if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
      out.normalize();
      // Lion manes are fullest at the sides/chin and thin over the crown —
      // without this the mane swallows the ears at full strength.
      const crownThin = 1 - 0.45 * Math.max(out.y, 0) * THREE.MathUtils.smoothstep(t, 0.45, 0.85);
      const len = (0.026 + 0.04 * frame) * faceFade * crownThin * (0.45 + 0.55 * maneAmount);
      out.y -= 0.45;
      out.z -= 0.15;
      out.normalize();
      return {
        length: len,
        colorMask: coatMask(COAT_ZONE.body, p),
        groom: [out.x, out.y, out.z],
        zone: COAT_ZONE.body,
      };
    }));
  }

  // ---- Dorsal hump (camel) ----
  const humpAmt = THREE.MathUtils.clamp(phenotype?.geometry?.hump ?? 0, 0, 0.1);
  if (humpAmt > 0.001) {
    // Fat mass over the withers. A single peak reads dromedary; a large value
    // splits into two lobes (bactrian / llama-wool read). Skinned across the
    // Chest↔Spine1 seam so it rides the torso.
    const chest = wp('Chest');
    const spine1 = wp('Spine1');
    const twoPeaks = humpAmt > 0.06;
    const peaks = twoPeaks
      ? [chest.clone().lerp(spine1, 0.2), chest.clone().lerp(spine1, 0.85)]
      : [chest.clone().lerp(spine1, 0.5)];
    for (const peak of peaks) {
      const radius = humpAmt * 1.7 + 0.022;
      const h = new THREE.SphereGeometry(radius, 22, 16);
      h.scale(0.92, 0.85, 1.5); // elongated along the body, flatter on top
      h.translate(peak.x, peak.y + humpAmt * 1.3 + 0.035, peak.z);
      stampPerVertex(h, (_i, p) => ({
        ...blendSkin(idx('Chest'), idx('Spine1'), 0.5),
        length: coatLength(COAT_ZONE.body, p),
        colorMask: coatMask(COAT_ZONE.body, p),
        groom: bodyGroomAt(p),
        zone: COAT_ZONE.body,
      }));
      parts.push(h);
    }
  }

  // ---- Dorsal crest / stand-up mane (hyena, badger, warthog) ----
  const dorsalAmt = THREE.MathUtils.clamp(phenotype?.furnishings?.dorsalCrest ?? 0, 0, 1.5);
  if (dorsalAmt > 0.02) {
    // Narrow raised ridge lofted along the spine (not a full neck ruff like the
    // lion mane). Fur grooms up-and-back; length grows with crest strength.
    const pelvis = wp('Pelvis');
    const spine = wp('Spine');
    const spine1 = wp('Spine1');
    const chest = wp('Chest');
    const neck = wp('Neck');
    const w = 0.028 + dorsalAmt * 0.01;
    const stations = [
      { c: pelvis.clone().add(new THREE.Vector3(0, 0.042, 0)), rx: w * 0.8, ry: w * 0.5, bone: idx('Pelvis'), up: new THREE.Vector3(0, 1, 0) },
      { c: spine.clone().add(new THREE.Vector3(0, 0.05, 0)), rx: w, ry: w * 0.5, bone: idx('Spine'), up: new THREE.Vector3(0, 1, 0) },
      { c: spine1.clone().add(new THREE.Vector3(0, 0.058, 0)), rx: w * 1.05, ry: w * 0.5, bone: idx('Spine1'), up: new THREE.Vector3(0, 1, 0) },
      { c: chest.clone().add(new THREE.Vector3(0, 0.058, 0)), rx: w * 0.95, ry: w * 0.5, bone: idx('Chest'), up: new THREE.Vector3(0, 1, 0) },
      { c: chest.clone().lerp(neck, 0.5).add(new THREE.Vector3(0, 0.05, 0)), rx: w * 0.7, ry: w * 0.45, bone: idx('Neck'), up: new THREE.Vector3(0, 1, 0) },
    ];
    parts.push(loftChain(stations, 24, (p) => ({
      length: 0.028 + 0.045 * dorsalAmt,
      colorMask: coatMask(COAT_ZONE.body, p),
      groom: [0, 1, -0.25], // stand up + lean back
      zone: COAT_ZONE.body,
    })));
  }

  // ---- Equid crest mane: ridge along the neck topline, hair to one side ----
  // The mane needs to read as a solid hanging hank from every angle,
  // including near edge-on (3/4 views looking down the neck length) — a
  // thin base ribbon that relies on long shell-fur extrusion for its width
  // goes translucent/gray at grazing angles (sparse shells over a long
  // extrusion never resolve to a solid tint, unlike the tail's much thicker
  // base loft). So the base ribbon itself now carries most of the visual
  // bulk (comparable to the tail's ~0.03-0.04 base radius); fur only adds a
  // short fuzzy edge on top.
  const crestManeAmt = THREE.MathUtils.clamp(phenotype?.furnishings?.crestMane ?? 0, 0, 1);
  if (crestManeAmt > 0.02) {
    const chest = wp('Chest');
    const neck = wp('Neck');
    const head = wp('Head');
    const w = 0.03 + 0.032 * crestManeAmt;
    const up = new THREE.Vector3(0, 1, 0);
    const neckDir = head.clone().sub(chest).normalize();
    // Perpendicular lift off the neck topline (not straight up) so the ridge
    // hugs the raised neck column at any carriage angle. Hair hangs to one
    // side, so the ribbon itself leans that way too (not a centered mohawk).
    const lift = up.clone().addScaledVector(neckDir, -up.dot(neckDir)).normalize();
    const side = new THREE.Vector3().crossVectors(neckDir, lift).normalize();
    const at = (a, b, t, liftAmt, sideAmt = 0) => a.clone().lerp(b, t)
      .addScaledVector(lift, liftAmt)
      .addScaledVector(side, sideAmt);
    // Tall crest (ry) + proud lift so the mane reads as a solid dark ridge in
    // profile too — a thin low ribbon goes edge-on and vanishes from the side.
    const stations = [
      { c: at(chest, neck, 0.05, 0.07, 0.014), rx: w * 0.78, ry: w * 0.6, bone: idx('Chest'), up },
      { c: at(chest, neck, 0.5, 0.074, 0.02), rx: w, ry: w * 0.66, bone: idx('Neck'), up },
      { c: at(neck, head, 0.05, 0.07, 0.022), rx: w * 1.02, ry: w * 0.66, bone: idx('Neck'), up },
      { c: at(neck, head, 0.55, 0.062, 0.02), rx: w * 0.85, ry: w * 0.58, bone: idx('Head'), up },
      { c: head.clone().add(new THREE.Vector3(0, 0.026, -0.048)), rx: w * 0.55, ry: w * 0.42, bone: idx('Head'), up },
    ];
    parts.push(loftChain(stations, 20, (p) => ({
      // Short fuzz only — the base ribbon above already carries the mane's
      // visual width and thickness. Mask ~1 → guard (black on bay).
      length: 0.014 + 0.012 * crestManeAmt,
      colorMask: 0.96,
      groom: [0.35, -0.75, -0.15],
      zone: COAT_ZONE.body,
    })));
  }

  // ---- Dorsal quill field (porcupine) ----
  const quillAmt = THREE.MathUtils.clamp(phenotype?.furnishings?.quills ?? 0, 0, 1.5);
  if (quillAmt > 0.02) {
    // Layered cone quills over the back from withers to rump, densest toward the
    // rump, fanned laterally and pointing up-and-back. Skinned to the nearest
    // spine bone so they ride the torso. Pale shaft → dark tip per-vertex gives
    // the banded porcupine-quill read without a second material.
    const along = ['Chest', 'Spine1', 'Spine', 'Pelvis'];
    const density = [0.45, 0.7, 0.95, 1.0];
    const addQuill = (base, dir, len, radius, boneIdx) => {
      const geo = new THREE.ConeGeometry(Math.max(0.001, radius), len, 5, 1);
      geo.translate(0, len * 0.5, 0); // base at origin, apex at +len·Y
      const m = new THREE.Matrix4();
      m.compose(
        base,
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir),
        new THREE.Vector3(1, 1, 1),
      );
      geo.applyMatrix4(m);
      stampPerVertex(geo, (_i, p) => {
        const alongTip = THREE.MathUtils.clamp(p.clone().sub(base).dot(dir) / len, 0, 1);
        return {
          ...monoSkin(boneIdx),
          length: 0.001,
          colorMask: THREE.MathUtils.lerp(0.18, 0.9, alongTip),
          groom: [dir.x, dir.y, dir.z],
          zone: COAT_ZONE.body,
        };
      });
      parts.push(geo);
    };
    for (let r = 0; r < along.length; r += 1) {
      const c = wp(along[r]);
      const dens = density[r];
      const bandRows = Math.max(1, Math.round(2 + quillAmt * 2 * dens));
      const halfCols = Math.max(1, Math.round(1 + quillAmt * 2 * dens));
      for (let i = 0; i < bandRows; i += 1) {
        for (const side of [-1, 1]) {
          for (let j = 0; j < halfCols; j += 1) {
            const lateralFrac = (j + 0.6) / halfCols;
            const lateral = side * lateralFrac * 0.045 * dens;
            const forward = (i / Math.max(1, bandRows - 1) - 0.5) * 0.04;
            const base = c.clone().add(new THREE.Vector3(lateral, 0.045 + j * 0.004, forward));
            const dir = new THREE.Vector3(side * 0.35 * lateralFrac, 1, -0.55).normalize();
            const len = (0.035 + 0.018 * ((i + j) % 2)) * (0.7 + quillAmt * 0.4);
            addQuill(base, dir, len, 0.0032, idx(along[r]));
          }
        }
      }
    }
  }

  // ---- Head ----
  // headShape 'caviid'  → flat-top rectangular poly head (capybara)
  // headShape 'suid'    → curved-crown blocky poly head (pig / warthog)
  // default 'canid'     → golden sphere skull + soft muzzle + cheek spheres
  {
    const head = headCenter.clone();
    const muzzle = wp('Muzzle');
    const nose = wp('NoseTip');
    const muzzleLen = phenotype?.skeleton?.muzzleLength ?? 1;
    const brachyFace = muzzleLen < 0.48 && !isSuid && !isCaviidPoly;

    const polyCtx = {
      headCenter,
      muzzle,
      nose,
      jawPos: wp('Jaw'),
      headScale,
      skullWidth,
      skullHeight,
      skullLength,
      muzzleWidth,
      muzzleHeight,
      cheekFullness,
      headBone: idx('Head'),
      muzzleBone: idx('Muzzle'),
      jawBone: idx('Jaw'),
      phenotype,
      eyeX,
      eyeY,
      eyeZ,
    };

    if (isCaviidPoly) {
      parts.push(...buildCaviidPolyHead(polyCtx));
    } else if (isEquid) {
      parts.push(...buildEquidPolyHead(polyCtx));
    } else if (isSuid) {
      parts.push(...buildSuidPolyHead(polyCtx));
    } else {
      // Canid: sphere skull + soft muzzle loft + cheek spheres.
      {
        const skull = new THREE.SphereGeometry(0.07 * headScale, 48, 36);
        skull.scale(1.18 * skullWidth, 0.97 * skullHeight, 1.1 * skullLength);
        skull.translate(head.x, head.y + 0.008, head.z + 0.005);
        stampPerVertex(skull, (_i, p) => {
          let len = coatLength(COAT_ZONE.head, p);
          const dx = Math.abs(p.x - headCenter.x);
          const dy = p.y - headCenter.y;
          const dz = p.z - headCenter.z;
          const front = THREE.MathUtils.smoothstep(dz, 0.015, 0.055)
            * (1 - THREE.MathUtils.smoothstep(Math.abs(dy - 0.008), 0.03, 0.08));
          if (brachyFace) {
            len = Math.min(len, THREE.MathUtils.lerp(len, len * 0.55, front * 0.7));
          } else {
            len = Math.min(len, THREE.MathUtils.lerp(0.03, 0.004, front));
          }
          const eyeD = Math.hypot(dx - eyeX, (dy - eyeY) * 1.3, (dz - eyeZ) * 0.9);
          const eyeMask = THREE.MathUtils.smoothstep(eyeD, 0.014, 0.034);
          len = Math.min(len, THREE.MathUtils.lerp(0.0005, 0.004, eyeMask));
          return {
            ...monoSkin(idx('Head')),
            length: len,
            colorMask: coatMask(COAT_ZONE.head, p),
            groom: headGroomAt(p, headCenter),
            zone: COAT_ZONE.head,
          };
        });
        parts.push(skull);
      }

      const muzzleStations = [
        { c: head.clone().lerp(muzzle, 0.32), rx: 0.054 * headScale * muzzleWidth, ry: 0.045 * headScale, bone: idx('Head'), n: 2.05 },
        { c: head.clone().lerp(muzzle, 0.62), rx: 0.047 * headScale * muzzleWidth, ry: 0.037 * headScale, bone: idx('Muzzle'), n: 2.1 },
        { c: muzzle.clone().add(new THREE.Vector3(0, -0.002, 0)), rx: 0.039 * headScale * muzzleWidth, ry: 0.031 * headScale, bone: idx('Muzzle'), n: 2.1 },
        { c: muzzle.clone().lerp(nose, 0.55), rx: 0.031 * headScale * muzzleWidth, ry: 0.025 * headScale, bone: idx('Muzzle'), n: 2.15 },
        { c: nose.clone().add(new THREE.Vector3(0, -0.002, -0.002)), rx: 0.019 * headScale * muzzleWidth, ry: 0.015 * headScale, bone: idx('Muzzle'), n: 2.2 },
      ];
      parts.push(loftChain(muzzleStations, 32, (p, t) => {
        const zone = t > 0.3 ? COAT_ZONE.muzzle : COAT_ZONE.head;
        return {
          length: coatLength(zone, p),
          colorMask: coatMask(zone, p),
          groom: headGroomAt(p, headCenter),
          zone,
        };
      }, { n: 2.1 }));

      const cheekLateral = brachyFace ? 0.036 : 0.047;
      const cheekScaleX = brachyFace ? Math.min(skullWidth, 1.12) : skullWidth;
      for (const side of [1, -1]) {
        const c = head.clone().add(new THREE.Vector3(side * cheekLateral * headScale * skullWidth, -0.006, 0.012));
        const cheek = new THREE.SphereGeometry(0.04 * headScale * cheekFullness, 28, 22);
        cheek.scale(cheekScaleX, 0.95 * skullHeight, 1.1 * skullLength);
        cheek.translate(c.x, c.y, c.z);
        stampPerVertex(cheek, (_i, p) => {
          let len = coatLength(COAT_ZONE.head, p) * 1.1;
          const dx = Math.abs(p.x - headCenter.x);
          const dy = p.y - headCenter.y;
          const dz = p.z - headCenter.z;
          const eyeD = Math.hypot(dx - eyeX, (dy - eyeY) * 1.3, (dz - eyeZ) * 0.9);
          const eyeMask = THREE.MathUtils.smoothstep(eyeD, 0.014, 0.034);
          len = Math.min(len, THREE.MathUtils.lerp(0.0008, len, eyeMask));
          return {
            ...monoSkin(idx('Head')),
            length: len,
            colorMask: coatMask(COAT_ZONE.head, p) * 0.9,
            groom: headGroomAt(p, headCenter),
            zone: COAT_ZONE.head,
          };
        });
        parts.push(cheek);
      }

      {
        const jawPos = wp('Jaw');
        const jawStations = [
          { c: jawPos.clone().add(new THREE.Vector3(0, 0.006 * headScale, -0.014 * headScale)), rx: 0.028 * headScale * muzzleWidth, ry: 0.026 * headScale, bone: idx('Jaw'), n: 2.05 },
          { c: jawPos.clone().lerp(muzzle, 0.38).add(new THREE.Vector3(0, -0.015 * headScale, 0)), rx: 0.037 * headScale * muzzleWidth, ry: 0.031 * headScale, bone: idx('Jaw'), n: 2.1 },
          { c: jawPos.clone().lerp(muzzle, 0.85).add(new THREE.Vector3(0, -0.021 * headScale, 0)), rx: 0.028 * headScale * muzzleWidth, ry: 0.022 * headScale, bone: idx('Jaw'), n: 2.15 },
          { c: muzzle.clone().lerp(nose, 0.55).add(new THREE.Vector3(0, -0.025 * headScale, 0)), rx: 0.021 * headScale * muzzleWidth, ry: 0.017 * headScale, bone: idx('Jaw'), n: 2.2 },
          { c: muzzle.clone().lerp(nose, 0.92).add(new THREE.Vector3(0, -0.021 * headScale, -0.006 * headScale)), rx: 0.013 * headScale * muzzleWidth, ry: 0.011 * headScale, bone: idx('Jaw'), n: 2.25 },
        ];
        parts.push(loftChain(jawStations, 24, (p, t) => {
          const zone = t > 0.45 ? COAT_ZONE.muzzle : COAT_ZONE.head;
          return {
            length: coatLength(zone, p) * 0.65,
            colorMask: coatMask(zone, p),
            groom: headGroomAt(p, headCenter),
            zone,
          };
        }, { n: 2.15 }));
      }
    }
  }

  // ---- Optional breed furnishings (shared skinned primitives) ----
  {
    const brows = phenotype?.furnishings?.brows ?? 0;
    const beard = phenotype?.furnishings?.beard ?? 0;
    const topknot = phenotype?.furnishings?.topknot ?? 0;
    const tailPom = phenotype?.furnishings?.tailPom ?? 0;
    if (brows > 0) {
      for (const side of [1, -1]) {
        const brow = new THREE.SphereGeometry(0.019 * headScale, 18, 12);
        brow.scale(1.45, 0.42, 0.65);
        brow.translate(
          headCenter.x + side * 0.031 * headScale,
          headCenter.y + 0.035 * headScale,
          headCenter.z + 0.058 * headScale,
        );
        stampPerVertex(brow, (_i, p) => ({
          ...monoSkin(idx('Head')),
          length: 0.03 * brows,
          colorMask: coatMask(COAT_ZONE.head, p),
          groom: [side * 0.35, -0.55, 0.75],
          zone: COAT_ZONE.head,
        }));
        parts.push(brow);
      }
    }
    if (beard > 0) {
      // Terrier / wire furnishings: chin goatee + modest mustache + neck skirt.
      // Geometry is kept tight so the nose/eyes stay readable (v1 was too bulky).
      // mustache / neckSkirt default from beard unless a profile sets them.
      const mustache = phenotype?.furnishings?.mustache ?? beard * 0.75;
      const neckSkirt = phenotype?.furnishings?.neckSkirt ?? beard * 0.65;
      const jawBone = idx('Jaw');
      const headBone = idx('Head');
      const neckBone = idx('Neck');
      const chestBone = idx('Chest');
      const muzzle = wp('Muzzle');
      const nose = wp('NoseTip');
      const jawPos = wp('Jaw');
      const head = wp('Head');
      const neck = wp('Neck');
      const chest = wp('Chest');
      // Match the jaw loft's forward chin tip (see lower-jaw stations above).
      const chinTip = muzzle.clone().lerp(nose, 0.92).add(
        new THREE.Vector3(0, -0.024 * headScale, -0.004 * headScale),
      );
      const hang = Math.max(0.4, beard * 0.72);

      // ---- Chin goatee ----
      const beardGeo = loftChain([
        {
          c: chinTip.clone().add(new THREE.Vector3(0, -0.002 * headScale, 0.002 * headScale)),
          rx: 0.02 * headScale * muzzleWidth,
          ry: 0.01 * headScale,
          bone: jawBone,
        },
        {
          c: chinTip.clone().add(new THREE.Vector3(0, -0.022 * headScale * hang, 0.008 * headScale)),
          rx: 0.022 * headScale * muzzleWidth,
          ry: 0.012 * headScale,
          bone: jawBone,
        },
        {
          c: chinTip.clone().add(new THREE.Vector3(0, -0.042 * headScale * hang, 0.004 * headScale)),
          rx: 0.016 * headScale * muzzleWidth,
          ry: 0.01 * headScale,
          bone: jawBone,
        },
        {
          c: chinTip.clone().add(new THREE.Vector3(0, -0.058 * headScale * hang, -0.002 * headScale)),
          rx: 0.008 * headScale * muzzleWidth,
          ry: 0.006 * headScale,
          bone: jawBone,
        },
      ], 18, (p) => ({
        length: 0.026 * beard,
        colorMask: coatMask(COAT_ZONE.muzzle, p),
        groom: [0, -0.95, 0.12],
        zone: COAT_ZONE.muzzle,
      }));
      parts.push(beardGeo);

      // ---- Mustache (compact upper-lip pad + small side tufts) ----
      if (mustache > 0.05) {
        const m = Math.max(0.35, mustache * 0.7);
        // Stay under the nose pad so the black nose remains visible.
        const lipRoot = muzzle.clone().lerp(nose, 0.48).add(
          new THREE.Vector3(0, -0.014 * headScale, 0.002 * headScale),
        );
        const mustachePad = loftChain([
          {
            c: lipRoot.clone(),
            rx: 0.022 * headScale * muzzleWidth * (0.9 + 0.12 * m),
            ry: 0.009 * headScale,
            bone: idx('Muzzle'),
          },
          {
            c: lipRoot.clone().add(new THREE.Vector3(0, -0.016 * headScale * m, 0.008 * headScale)),
            rx: 0.026 * headScale * muzzleWidth * (0.9 + 0.1 * m),
            ry: 0.012 * headScale,
            bone: idx('Muzzle'),
          },
          {
            c: lipRoot.clone().add(new THREE.Vector3(0, -0.03 * headScale * m, 0.004 * headScale)),
            rx: 0.018 * headScale * muzzleWidth,
            ry: 0.01 * headScale,
            bone: idx('Muzzle'),
          },
          {
            c: lipRoot.clone().add(new THREE.Vector3(0, -0.042 * headScale * m, -0.002 * headScale)),
            rx: 0.009 * headScale * muzzleWidth,
            ry: 0.007 * headScale,
            bone: idx('Muzzle'),
          },
        ], 16, (p) => ({
          length: 0.028 * mustache,
          colorMask: coatMask(COAT_ZONE.muzzle, p),
          groom: [0, -0.9, 0.28],
          zone: COAT_ZONE.muzzle,
        }));
        parts.push(mustachePad);

        // Side tufts — short whisker-like lobes, not cheek blankets.
        for (const side of [1, -1]) {
          const cheekRoot = muzzle.clone().lerp(nose, 0.32).add(
            new THREE.Vector3(side * 0.032 * headScale * muzzleWidth, -0.01 * headScale, 0.002 * headScale),
          );
          const lobe = loftChain([
            {
              c: cheekRoot.clone(),
              rx: 0.012 * headScale,
              ry: 0.01 * headScale,
              bone: idx('Muzzle'),
            },
            {
              c: cheekRoot.clone().add(new THREE.Vector3(
                side * 0.012 * headScale * m,
                -0.018 * headScale * m,
                0.008 * headScale,
              )),
              rx: 0.015 * headScale,
              ry: 0.013 * headScale,
              bone: idx('Muzzle'),
            },
            {
              c: cheekRoot.clone().add(new THREE.Vector3(
                side * 0.014 * headScale * m,
                -0.034 * headScale * m,
                0.002 * headScale,
              )),
              rx: 0.01 * headScale,
              ry: 0.009 * headScale,
              bone: idx('Muzzle'),
            },
            {
              c: cheekRoot.clone().add(new THREE.Vector3(
                side * 0.01 * headScale * m,
                -0.048 * headScale * m,
                -0.004 * headScale,
              )),
              rx: 0.006 * headScale,
              ry: 0.006 * headScale,
              bone: idx('Muzzle'),
            },
          ], 14, (p) => ({
            length: 0.026 * mustache,
            colorMask: coatMask(COAT_ZONE.muzzle, p),
            groom: [side * 0.4, -0.85, 0.2],
            zone: COAT_ZONE.muzzle,
          }));
          parts.push(lobe);
        }
      }

      // ---- Neck skirt (throat fringe — shorter, narrower than v1) ----
      if (neckSkirt > 0.05) {
        const s = Math.max(0.35, neckSkirt * 0.7);
        const throatStart = jawPos.clone().add(
          new THREE.Vector3(0, -0.01 * headScale, -0.008 * headScale),
        );
        const throatMid = head.clone().lerp(neck, 0.5).add(
          new THREE.Vector3(0, -0.028 * headScale - 0.028 * headScale * s, 0.008 * headScale),
        );
        const throatChest = neck.clone().lerp(chest, 0.35).add(
          new THREE.Vector3(0, -0.014 * headScale - 0.022 * headScale * s, 0.012 * headScale),
        );
        const skirtGeo = loftChain([
          {
            c: throatStart,
            rx: 0.028 * headScale * muzzleWidth * (0.9 + 0.12 * s),
            ry: 0.012 * headScale,
            bone: jawBone,
          },
          {
            c: chinTip.clone().lerp(throatMid, 0.4).add(new THREE.Vector3(0, -0.012 * headScale * s, 0)),
            rx: 0.034 * headScale * (1 + 0.08 * s),
            ry: 0.015 * headScale,
            bone: headBone,
          },
          {
            c: throatMid,
            rx: 0.036 * headScale * (1 + 0.1 * s),
            ry: 0.018 * headScale,
            bone: neckBone,
          },
          {
            c: throatMid.clone().lerp(throatChest, 0.55).add(
              new THREE.Vector3(0, -0.014 * headScale * s, 0.004 * headScale),
            ),
            rx: 0.028 * headScale,
            ry: 0.014 * headScale,
            bone: neckBone,
          },
          {
            c: throatChest.clone().add(new THREE.Vector3(0, -0.012 * headScale * s, 0)),
            rx: 0.018 * headScale,
            ry: 0.01 * headScale,
            bone: chestBone,
          },
          {
            c: throatChest.clone().add(new THREE.Vector3(0, -0.024 * headScale * s, -0.006 * headScale)),
            rx: 0.01 * headScale,
            ry: 0.007 * headScale,
            bone: chestBone,
          },
        ], 18, (p, t) => ({
          length: 0.028 * neckSkirt * (0.85 + 0.2 * (1 - t)),
          colorMask: coatMask(t < 0.35 ? COAT_ZONE.muzzle : COAT_ZONE.head, p),
          groom: [0, -0.92, 0.15],
          zone: t < 0.35 ? COAT_ZONE.muzzle : COAT_ZONE.head,
        }));
        parts.push(skirtGeo);
      }
    }
    if (topknot > 0) {
      const topknotGeo = new THREE.SphereGeometry(0.052 * headScale, 28, 20);
      topknotGeo.scale(0.92, 0.72, 0.78);
      topknotGeo.translate(
        headCenter.x,
        headCenter.y + 0.064 * headScale,
        headCenter.z - 0.004 * headScale,
      );
      stampPerVertex(topknotGeo, (_i, p) => ({
        ...monoSkin(idx('Head')),
        length: 0.038 * topknot,
        colorMask: coatMask(COAT_ZONE.head, p),
        groom: headGroomAt(p, headCenter),
        zone: COAT_ZONE.head,
      }));
      parts.push(topknotGeo);
    }
    if (tailPom > 0) {
      const tailTip = wp('Tail4');
      const pomGeo = new THREE.SphereGeometry(0.045 * tailPom, 24, 18);
      pomGeo.translate(tailTip.x, tailTip.y - 0.008, tailTip.z - 0.025);
      stampPerVertex(pomGeo, (_i, p) => ({
        ...monoSkin(idx('Tail4')),
        length: 0.045 * tailPom,
        colorMask: coatMask(COAT_ZONE.tail, p),
        groom: [0, -0.1, -1],
        zone: COAT_ZONE.tail,
      }));
      parts.push(pomGeo);
    }
  }

  // ---- Ears: erect pinna / rose-fold / floppy leaf ----
  for (const side of ['L', 'R']) {
    const names = DOG_EAR_BONES[side];
    const s = side === 'L' ? 1 : -1;
    const base = wp(names[0]);
    const mid = wp(names[1]);
    const tipBone = wp(names[2]);
    const earWidth = (phenotype?.ears?.width ?? 1) * headScale;
    const earType = phenotype?.ears?.type ?? 'floppy';
    const isBat = earType === 'bat';
    const isRounded = earType === 'rounded';
    const isErect = earType === 'erect' || isBat || isRounded;
    const isFolded = earType === 'folded';
    const foldType = phenotype?.ears?.fold ?? 'drop';
    const tipDirection = tipBone.clone().sub(mid);
    if (tipDirection.lengthSq() < 1e-10) tipDirection.set(0, -1, 0);
    tipDirection.normalize();
    const foldedTipExtension = foldType === 'rose' ? 0.004
      : foldType === 'semi-prick' ? 0.006
        : foldType === 'button' ? 0.007
          : 0.008;
    const tipExtension = isErect ? (isBat ? 0.014 : 0.015)
      : isFolded ? foldedTipExtension
        : 0.028;
    const tip = tipBone.clone().addScaledVector(
      tipDirection,
      tipExtension * (phenotype?.ears?.length ?? 1),
    );

    if (isRounded) {
      // A rounded procyonid pinna needs a circular silhouette. The shared
      // leaf loft always reads triangular even with a blunt final station,
      // so use a shallow, rigidly-skinned cup with a smaller dark inner cup.
      const earLength = phenotype?.ears?.length ?? 1;
      const center = base.clone().lerp(tipBone, 0.58);
      const outer = new THREE.SphereGeometry(0.04 * headScale, 24, 18);
      outer.scale(earWidth * 0.7, earLength * 1.15, 0.2);
      outer.translate(center.x, center.y, center.z);
      stampPerVertex(outer, (_i, p) => ({
        ...monoSkin(idx(names[0])),
        length: coatLength(COAT_ZONE.ear, p),
        colorMask: coatMask(COAT_ZONE.ear, p),
        groom: earGroomAt(s),
        zone: COAT_ZONE.ear,
      }));
      parts.push(outer);

      const inner = new THREE.SphereGeometry(0.031 * headScale, 22, 16);
      inner.scale(earWidth * 0.62, earLength * 1.04, 0.11);
      inner.translate(center.x, center.y, center.z + 0.009 * headScale);
      stampPerVertex(inner, (_i, p) => ({
        ...monoSkin(idx(names[0])),
        length: coatLength(COAT_ZONE.ear, p) * 0.22,
        colorMask: coatMask(COAT_ZONE.ear, p),
        groom: earGroomAt(s),
        zone: COAT_ZONE.ear,
        earInner: 1,
      }));
      parts.push(inner);
      continue;
    }

    // Soft ear-root pad on the skull so the loft doesn't float as a detached block.
    {
      const rootPad = new THREE.SphereGeometry(0.0075 * headScale, 14, 8);
      rootPad.scale(1.2, 0.5, 0.55);
      rootPad.translate(base.x - s * 0.009 * headScale, base.y - 0.002 * headScale, base.z - 0.003 * headScale);
      stampPerVertex(rootPad, (_i, p) => ({
        ...monoSkin(idx('Head')),
        length: coatLength(COAT_ZONE.head, p) * 0.6,
        colorMask: coatMask(COAT_ZONE.head, p),
        groom: headGroomAt(p, headCenter),
        zone: COAT_ZONE.head,
      }));
      parts.push(rootPad);
    }

    let stations;
    if (isErect) {
      // Flat triangular pinna. Bat ears retain a wider, softly capped tip;
      // shepherd/spitz ears converge to a clean point.
      stations = [
        { c: base, width: (isBat ? 0.049 : 0.043) * earWidth, bone: idx(names[0]) },
        { c: base.clone().lerp(mid, 0.32), width: (isBat ? 0.052 : 0.045) * earWidth, bone: idx(names[0]) },
        { c: base.clone().lerp(mid, 0.68), width: (isBat ? 0.048 : 0.039) * earWidth, bone: idx(names[0]) },
        { c: mid, width: (isBat ? 0.042 : 0.031) * earWidth, bone: idx(names[1]) },
        { c: mid.clone().lerp(tipBone, 0.5), width: (isBat ? 0.034 : 0.023) * earWidth, bone: idx(names[1]) },
        { c: tipBone, width: (isBat ? 0.022 : 0.012) * earWidth, bone: idx(names[2]) },
        { c: tip, width: (isBat ? 0.008 : 0.0025) * earWidth, bone: idx(names[2]) },
      ];
    } else if (isFolded) {
      // Each natural fold needs a distinct outline: rose ears are compact,
      // semi-prick and button ears are broad at the crease, and drop ears
      // taper from a fuller triangular leather.
      const widths = foldType === 'rose'
        ? [0.02, 0.027, 0.029, 0.025, 0.018, 0.01, 0.0025]
        : foldType === 'semi-prick'
          ? [0.03, 0.041, 0.046, 0.043, 0.035, 0.024, 0.0035]
          : foldType === 'button'
            ? [0.03, 0.042, 0.047, 0.043, 0.035, 0.024, 0.0035]
            // Triangular drop leather widest at the skull attachment, tapering
            // steadily to the tip — a mid-shaft bulge read as a rounded paddle
            // instead of the flat wedge real drop ears show.
            : [0.036, 0.034, 0.031, 0.027, 0.021, 0.013, 0.003];
      stations = [
        { c: base.clone().add(new THREE.Vector3(-s * 0.003 * headScale, 0, 0)), width: widths[0] * earWidth, bone: idx(names[0]) },
        { c: base.clone().lerp(mid, 0.3), width: widths[1] * earWidth, bone: idx(names[0]) },
        { c: base.clone().lerp(mid, 0.7), width: widths[2] * earWidth, bone: idx(names[0]) },
        { c: mid, width: widths[3] * earWidth, bone: idx(names[1]) },
        { c: mid.clone().lerp(tipBone, 0.55), width: widths[4] * earWidth, bone: idx(names[1]) },
        { c: tipBone, width: widths[5] * earWidth, bone: idx(names[2]) },
        { c: tip, width: widths[6] * earWidth, bone: idx(names[2]) },
      ];
    } else {
      // Rounded drop leaf; longer spaniel/hound profiles inherit length from
      // their bones without becoming a thick hanging slab.
      stations = [
        { c: base, width: 0.027 * earWidth, bone: idx(names[0]) },
        { c: base.clone().lerp(mid, 0.32), width: 0.036 * earWidth, bone: idx(names[0]) },
        { c: base.clone().lerp(mid, 0.68), width: 0.043 * earWidth, bone: idx(names[0]) },
        { c: mid, width: 0.046 * earWidth, bone: idx(names[1]) },
        { c: mid.clone().lerp(tipBone, 0.55), width: 0.041 * earWidth, bone: idx(names[1]) },
        { c: tipBone, width: 0.03 * earWidth, bone: idx(names[2]) },
        { c: tip, width: 0.006 * earWidth, bone: idx(names[2]) },
      ];
    }
    const groom = earGroomAt(s);
    parts.push(earLeafGeometry(stations, (p) => ({
      length: coatLength(COAT_ZONE.ear, p) * (isFolded ? 0.7 : 1),
      colorMask: coatMask(COAT_ZONE.ear, p),
      groom,
      zone: COAT_ZONE.ear,
    }), {
      thickness: headScale * (isFolded ? 0.0032 : isErect ? 0.0026 : 0.003),
      innerTowardPoint: headCenter,
    }));

    // A flat leaf meets a round skull at a single tangent point at best —
    // everywhere else along the hinge a sliver of sky showed through between
    // the leaf's OUTER edge and the skull, worst from above/behind. Fanning a
    // fold to the station *centerlines* (tried first) only closes half that
    // gap and reads as a second spike, because the visible floating corner is
    // the outer edge (c + width*widthDir), not the centerline. Reproduce the
    // leaf's own tangent/widthDir frame for stations 0-1 to find that exact
    // corner, then fan a small triangle from a skull-surface point out to it
    // — sharing the leaf's real edge instead of a separate one to gap against.
    if (foldType === 'drop') {
      const faceNormal = new THREE.Vector3(0, 0, 1);
      let previousWidth = null;
      const corners = [];
      for (let i = 0; i < 2; i += 1) {
        const prev = stations[Math.max(0, i - 1)].c;
        const next = stations[Math.min(stations.length - 1, i + 1)].c;
        const tangent = next.clone().sub(prev).normalize();
        const normal = faceNormal.clone().addScaledVector(tangent, -faceNormal.dot(tangent));
        if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
        normal.normalize();
        const widthDir = new THREE.Vector3().crossVectors(normal, tangent).normalize();
        if (previousWidth && widthDir.dot(previousWidth) < 0) widthDir.negate();
        previousWidth = widthDir.clone();
        const station = stations[i];
        const a = station.c.clone().addScaledVector(widthDir, station.width);
        const b = station.c.clone().addScaledVector(widthDir, -station.width);
        // The floating corner is whichever sits farther from the skull center.
        corners.push(a.distanceToSquared(headCenter) > b.distanceToSquared(headCenter) ? a : b);
      }

      // A single shared anchor point can only touch the curved skull at one
      // angle, so it still gapped against whichever corner sat at a
      // different angle. Pull EACH corner inward along its own direction
      // from head-center to just under the ellipsoid surface instead — that
      // guarantees both edges of the quad are embedded in (overlapping) the
      // opaque skull mesh, so the strip between them crosses the surface
      // with no seam, regardless of viewing angle.
      const anchorFor = (corner) => {
        const rel = corner.clone().sub(headCenter);
        const ellipsoidLen = Math.sqrt(
          (rel.x / skullRx) ** 2 + (rel.y / skullRy) ** 2 + (rel.z / skullRz) ** 2,
        );
        return headCenter.clone().addScaledVector(rel, 0.92 / ellipsoidLen);
      };
      const anchors = [anchorFor(corners[0]), anchorFor(corners[1])];

      const foldGeo = new THREE.BufferGeometry();
      const quadPoints = [anchors[0], anchors[1], corners[1], corners[0]];
      const triNormal = new THREE.Triangle(quadPoints[0], quadPoints[1], quadPoints[2]).getNormal(new THREE.Vector3());
      const halfThick = headScale * 0.0016;
      const front = quadPoints.map((p) => p.clone().addScaledVector(triNormal, halfThick));
      const back = quadPoints.map((p) => p.clone().addScaledVector(triNormal, -halfThick));
      const positions = [...front, ...back].flatMap((p) => [p.x, p.y, p.z]);
      foldGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      foldGeo.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]);
      foldGeo.computeVertexNormals();
      const foldBones = [
        idx('Head'), idx('Head'), idx(names[0]), idx(names[0]),
        idx('Head'), idx('Head'), idx(names[0]), idx(names[0]),
      ];
      stampPerVertex(foldGeo, (vertexIndex, p) => ({
        ...monoSkin(foldBones[vertexIndex]),
        length: coatLength(COAT_ZONE.head, p) * 0.6,
        colorMask: coatMask(COAT_ZONE.head, p),
        groom: headGroomAt(p, headCenter),
        zone: COAT_ZONE.head,
      }));
      parts.push(foldGeo);
    }
  }

  // ---- Tail (plume) ----
  {
    const tailThickness = phenotype?.tail?.thickness ?? 1;
    const tailTaper = phenotype?.tail?.taper ?? 1;
    const isSciuridTail = phenotype?.tail?.type === 'sciurid';
    const isPaddleTail = phenotype?.tail?.type === 'paddle';
    if (isPaddleTail) {
      // Flat horizontal scaly paddle (beaver): a wide lateral ribbon (rx) that
      // is razor-thin vertically (ry), laid straight back along the caudal chain.
      // An explicit world-up hint keeps the plate level regardless of how the
      // chain is posed; the skeleton dispatch already holds it near-horizontal.
      const paddleStations = DOG_TAIL_BONES.map((name, i) => {
        const c = wp(name);
        const tChain = i / Math.max(1, DOG_TAIL_BONES.length - 1);
        // Oval plate: narrow at the rump attach, widest through the mid,
        // rounding off to a tapered trailing edge.
        const widthProfile = 0.45 + 0.55 * Math.sin(tChain * Math.PI);
        const rx = (0.05 + 0.04 * widthProfile) * tailThickness;
        return {
          c, rx, ry: 0.006 * tailThickness, bone: idx(name), up: new THREE.Vector3(0, 1, 0),
        };
      });
      const last = paddleStations[paddleStations.length - 1];
      paddleStations.push({
        c: last.c.clone().add(new THREE.Vector3(0, 0, -0.022)),
        rx: 0.014 * tailThickness,
        ry: 0.004 * tailThickness,
        bone: last.bone,
        up: new THREE.Vector3(0, 1, 0),
      });
      parts.push(loftChain(paddleStations, 24, (p, t) => ({
        // Leathery / scaly paddle — only a short nap of fur.
        length: coatLength(COAT_ZONE.tail, p) * 0.2,
        colorMask: colorMaskAt(COAT_ZONE.tail, p, headCenter, phenotype, { alongT: t }),
        groom: [0, -0.1, -1],
        zone: COAT_ZONE.tail,
      })));
    } else {
    // Sciurid: narrow solid core (shell fur carries bushiness). Avoid thick
    // mid-bulge tubes that read as a potato fused to the torso.
    const baseR = isSciuridTail ? 0.028 : 0.042;
    const boneStations = DOG_TAIL_BONES.map((name, i) => {
      const c = wp(name);
      const tChain = i / Math.max(1, DOG_TAIL_BONES.length - 1);
      const linearTaper = 1 - i * (0.0055 / baseR);
      // Slight mid-softening only — bush comes from coat.tail shells, not loft.
      const midBulge = isSciuridTail ? (1 + 0.06 * Math.sin(tChain * Math.PI)) : 1;
      // Sciurid base stays thinner than mid so the plume lifts free of the rump.
      const basePinch = isSciuridTail ? THREE.MathUtils.lerp(0.72, 1, THREE.MathUtils.smoothstep(tChain, 0, 0.35)) : 1;
      const r = baseR * THREE.MathUtils.lerp(1, linearTaper, tailTaper) * tailThickness * midBulge * basePinch;
      return { c, rx: r, ry: r * (isSciuridTail ? 0.92 : 0.95), bone: idx(name) };
    });
    boneStations.push({
      c: wp('Tail4').add(new THREE.Vector3(
        0,
        isSciuridTail ? 0.018 : -0.012,
        isSciuridTail ? -0.01 : -0.05,
      )),
      rx: THREE.MathUtils.lerp((isSciuridTail ? 0.012 : 0.018) * tailThickness, 0.008, tailTaper),
      ry: THREE.MathUtils.lerp((isSciuridTail ? 0.011 : 0.017) * tailThickness, 0.007, tailTaper),
      bone: idx('Tail4'),
    });
    const ringSubdivisions = phenotype?.coat?.pattern === 'raccoon-mask' ? 3 : 1;
    const stations = [];
    for (let i = 0; i < boneStations.length - 1; i += 1) {
      const from = boneStations[i];
      const to = boneStations[i + 1];
      stations.push(from);
      for (let sub = 1; sub < ringSubdivisions; sub += 1) {
        const t = sub / ringSubdivisions;
        stations.push({
          c: from.c.clone().lerp(to.c, t),
          rx: THREE.MathUtils.lerp(from.rx, to.rx, t),
          ry: THREE.MathUtils.lerp(from.ry, to.ry, t),
          bone: from.bone,
        });
      }
    }
    stations.push(boneStations[boneStations.length - 1]);
    const ringedTail = phenotype?.coat?.pattern === 'raccoon-mask';
    // Sciurid / chipmunk / murine tails use loft-parameter alongT (world -Z
    // is non-monotonic on rising/curved plumes).
    const alongTTail = phenotype?.coat?.pattern === 'squirrel-grey'
      || phenotype?.coat?.pattern === 'chipmunk-stripe'
      || phenotype?.coat?.pattern === 'murine-agouti';
    parts.push(loftChain(stations, 20, (p, t) => ({
      length: coatLength(COAT_ZONE.tail, p),
      colorMask: ringedTail
        ? (Math.sin(t * Math.PI * 12) > 0 ? 0.94 : 0.1)
        : colorMaskAt(COAT_ZONE.tail, p, headCenter, phenotype, {
          // alongT is monotonic base→tip even when the sciurid plume rises.
          alongT: alongTTail ? t : undefined,
        }),
      groom: [0, -0.15, -1],
      zone: COAT_ZONE.tail,
    })));
    }
  }

  // ---- Legs + paws / rodent paws / ungulate hooves ----
  const footType = phenotype?.extremities?.foot ?? 'paw';
  const hoofSize = phenotype?.extremities?.hoofSize ?? 1;
  const dewclawAmt = phenotype?.extremities?.dewclaw ?? 0;
  const isHoof = footType === 'cloven-hoof' || footType === 'solid-hoof';
  const isRodentPaw = footType === 'rodent-paw';
  const isWebbedPaw = footType === 'webbed-paw';

  for (const chain of Object.values(DOG_LEG_CHAINS)) {
    const names = chain.bones;
    // Front column stays lean (think fox/dog reference). Hind uses haunch bulk
    // so the top of the rear leg is never skinnier than the front.
    // Rodent-paw: keep a little bulk at the root, then wire-thin forearm/shin
    // and a tiny plantigrade foot (mouse/rat/squirrel refs).
    const thick = chain.front ? legThickness : hindLegThickness;
    const stations = [];
    for (let i = 0; i < names.length; i += 1) {
      const c = wp(names[i]);
      let rx;
      let ryScale = i >= names.length - 2 ? 0.75 : 0.95;
      if (isRodentPaw) {
        if (chain.front) {
          // Shoulder → upper arm stay modest; forearm + pastern go skinny.
          if (i === 0) rx = 0.032 * thick;
          else if (i === 1) rx = 0.024 * thick;
          else if (i === 2) { rx = 0.014 * thick; ryScale = 0.85; } // forearm
          else if (i === 3) { rx = 0.011 * thick; ryScale = 0.8; } // pastern
          else { rx = 0.014 * pawSize; ryScale = 0.7; } // paw joint
        } else {
          // Hip/thigh keep a bit of haunch; tibia + hock skinny plantigrade stilts.
          if (i === 0) { rx = 0.036 * thick; ryScale = 0.9; }
          else if (i === 1) { rx = 0.034 * thick; ryScale = 0.92; }
          else if (i === 2) { rx = 0.016 * thick; ryScale = 0.85; } // tibia
          else if (i === 3) { rx = 0.012 * thick; ryScale = 0.8; } // hock
          else { rx = 0.014 * pawSize; ryScale = 0.7; }
        }
      } else if (chain.front) {
        // Lean front: shoulder → forearm → pastern (was reading thicker than haunch).
        if (i === 0) rx = 0.044 * thick;
        else if (i === 1) rx = 0.036 * thick;
        else if (i === 2) rx = 0.030 * thick;
        else if (i === 3) rx = 0.025 * thick;
        else rx = isHoof ? 0.018 * pawSize * hoofSize : 0.026 * pawSize;
      } else {
        // Hip joins the rump flush (thin "rear shoulder"), then mid-thigh has
        // a little bulk before tapering to hock/cannon — not a thick bulb at
        // the pelvis seam.
        if (i === 0) { rx = 0.046 * thick; ryScale = 0.92; } // hip — flush with rump
        else if (i === 1) { rx = 0.050 * thick; ryScale = 0.96; } // stifle / mid-thigh
        else if (i === 2) rx = 0.036 * thick; // tibia
        else if (i === 3) rx = 0.028 * thick; // hock / cannon
        else rx = isHoof ? 0.018 * pawSize * hoofSize : 0.026 * pawSize;
      }
      stations.push({
        c,
        rx,
        ry: rx * ryScale,
        bone: idx(names[i]),
      });
    }
    const padUp = new THREE.Vector3(0, 1, 0);
    const pastern = wp(names[names.length - 2]);
    const paw = wp(names[names.length - 1]);
    // Re-anchor the ring frame at the lower leg (tangent is well off vertical
    // here, so the world-up cross product is stable). The torso→shoulder cap
    // bends out of the sagittal plane, so the propagated frame arrives at the
    // foot with accumulated roll; meeting the world-up-hinted pad rings with
    // that roll twisted the pad loft into a bowtie "hook" behind the paw.
    // Anchoring here keeps the rest of the (planar) chain roll-free.
    stations[2].up = padUp;

    if (isHoof) {
      // Taper the distal chain into a short cannon above the hoof; no flat pad.
      stations.splice(stations.length - 1, 0, {
        c: pastern.clone().add(new THREE.Vector3(0, -0.01, 0.004)),
        rx: 0.022 * legThickness,
        ry: 0.018 * legThickness,
        bone: idx(names[names.length - 2]),
        up: padUp,
      });
      if (footType === 'solid-hoof') {
        // Equid hoof: narrow coronet flaring into a wall that meets the
        // ground on a flat rim with a slight forward toe — a readable hoof
        // capsule, not a tapered stump.
        // The coronet ring is DUPLICATED: the packed coatMask encodes
        // zone*4 + mask, so a triangle spanning a leg-zone ring and a
        // paw-zone ring interpolates through garbage encodings (phantom
        // earInner flags, out-of-range mixes → orange/white bands down the
        // pastern). A zero-length seam segment keeps every triangle within
        // one zone; the paw boundary is pinned to this seam below.
        const hb = idx(names[names.length - 1]);
        const hw = pawSize * hoofSize;
        const coronet = {
          c: paw.clone().add(new THREE.Vector3(0, 0.012, 0.001)),
          rx: 0.019 * hw, ry: 0.016 * hw, bone: hb, up: padUp,
        };
        stations[stations.length - 1] = coronet;
        stations.push({ ...coronet, c: coronet.c.clone().add(new THREE.Vector3(0, -0.0006, 0)) });
        stations.push({
          c: paw.clone().add(new THREE.Vector3(0, -0.004, 0.005)),
          rx: 0.024 * hw, ry: 0.02 * hw, bone: hb, up: padUp,
        });
        stations.push({
          c: paw.clone().add(new THREE.Vector3(0, -0.015, 0.008)),
          rx: 0.026 * hw, ry: 0.021 * hw, bone: hb, up: padUp,
        });
      } else {
        stations[stations.length - 1] = {
          c: paw.clone().add(new THREE.Vector3(0, -0.004, 0.002)),
          rx: 0.016 * pawSize * hoofSize,
          ry: 0.014 * pawSize * hoofSize,
          bone: idx(names[names.length - 1]),
          up: padUp,
        };
      }
    } else if (isRodentPaw) {
      // Skinny plantigrade foot: narrow ankle into a small elongated sole
      // (mouse/rat/squirrel — not a dog pad loaf). Slightly longer along Z
      // for plantigrade contact, very thin left/right.
      const ps = Math.max(0.35, pawSize);
      stations.splice(stations.length - 1, 0, {
        c: pastern.clone().add(new THREE.Vector3(0, -0.01, 0.004)),
        rx: 0.012 * ps,
        ry: 0.01 * ps,
        bone: idx(names[names.length - 2]),
        up: padUp,
      });
      stations[stations.length - 1] = {
        c: paw.clone().add(new THREE.Vector3(0, -0.006, 0.002)),
        rx: 0.016 * ps,
        ry: 0.008 * ps,
        bone: idx(names[names.length - 1]),
        up: padUp,
      };
      stations.push({
        c: paw.clone().add(new THREE.Vector3(0, -0.01, 0.018)),
        rx: 0.014 * ps,
        ry: 0.007 * ps,
        bone: idx(names[names.length - 1]),
        up: padUp,
      });
      // Tiny toe nubs at the sole tip (reads as a rodent foot, not a hoof).
      stations.push({
        c: paw.clone().add(new THREE.Vector3(0, -0.009, 0.028)),
        rx: 0.01 * ps,
        ry: 0.006 * ps,
        bone: idx(names[names.length - 1]),
        up: padUp,
      });
    } else {
      // Flat foot pad: from pastern/hock down to ground, then forward under the paw.
      // These three rings force an explicit world-up hint (rather than the
      // propagated frame) so the flat pad stays level and on the floor
      // regardless of how the chain above it is oriented.
      stations.splice(stations.length - 1, 0, {
        c: pastern.clone().add(new THREE.Vector3(0, -0.016, 0.008)),
        rx: 0.03 * pawSize,
        ry: 0.014,
        bone: idx(names[names.length - 2]),
        up: padUp,
      });
      stations[stations.length - 1] = {
        c: paw.clone().add(new THREE.Vector3(0, -0.01, 0)),
        rx: 0.034 * pawSize,
        ry: 0.012,
        bone: idx(names[names.length - 1]),
        up: padUp,
      };
      stations.push({
        c: paw.clone().add(new THREE.Vector3(0, -0.014, 0.028)),
        rx: 0.026 * pawSize,
        ry: 0.01,
        bone: idx(names[names.length - 1]),
        up: padUp,
      });
    }

    // Shoulder/hip cap blends the leg into the torso. This used to be a
    // separate loftChain call sharing only its terminal point with the leg's
    // first station — two independently-oriented rings meeting at a seam,
    // which (combined with the old per-station frame recompute) is what
    // produced the twisted/pinched look right at the top of the leg. Folding
    // the cap stations into the SAME loftChain call gives one continuously
    // propagated ring orientation with no seam.
    const rootBone = names[0];
    const attach = wp(rootBone);
    const parentName = chain.front ? 'Chest' : 'Pelvis';
    const parent = wp(parentName);
    // Cap blends leg into torso. Hind cap stays slim so the rump outline is
    // continuous (flush rear shoulder), not a thick haunch bulb off the pelvis.
    const capStations = chain.front
      ? [
        { c: parent.clone().lerp(attach, 0.35), rx: 0.052 * thick, ry: 0.044 * thick, bone: idx(parentName) },
        { c: attach.clone().lerp(parent, 0.25), rx: 0.046 * thick, ry: 0.040 * thick, bone: idx(rootBone) },
      ]
      : [
        { c: parent.clone().lerp(attach, 0.38), rx: 0.050 * thick, ry: 0.044 * thick, bone: idx(parentName) },
        { c: attach.clone().lerp(parent, 0.28), rx: 0.046 * thick, ry: 0.040 * thick, bone: idx(rootBone) },
      ];
    const chainLength = (list) => {
      let sum = 0;
      for (let i = 1; i < list.length; i += 1) sum += list[i].c.distanceTo(list[i - 1].c);
      return sum;
    };
    const capLen = chainLength(capStations) + capStations[capStations.length - 1].c.distanceTo(stations[0].c);
    const legLen = chainLength(stations);
    const mergedLen = capLen + legLen || 1;
    const capEndT = capLen / mergedLen;
    let pawStartT;
    if (footType === 'solid-hoof') {
      // Zone boundary pinned to the duplicated coronet seam ring: the leg→paw
      // switch happens across the near-zero seam segment, never mid-pastern.
      const seamIdx = stations.length - 3;
      let sum = 0;
      for (let i = 1; i <= seamIdx; i += 1) sum += stations[i].c.distanceTo(stations[i - 1].c);
      const half = stations[seamIdx].c.distanceTo(stations[seamIdx - 1].c) * 0.5;
      pawStartT = (capLen + sum - half) / mergedLen;
    } else {
      pawStartT = (capLen + 0.72 * legLen) / mergedLen;
    }
    const mergedStations = [...capStations, ...stations];

    parts.push(loftChain(mergedStations, 20, (p, t) => {
      if (t < capEndT) {
        return {
          length: coatLength(COAT_ZONE.leg, p) * 1.1,
          colorMask: coatMask(COAT_ZONE.body, p),
          groom: bodyGroomAt(p),
          zone: COAT_ZONE.leg,
        };
      }
      const zone = t > pawStartT ? COAT_ZONE.paw : COAT_ZONE.leg;
      return {
        length: coatLength(zone, p),
        colorMask: coatMask(zone, p),
        groom: bodyGroomAt(p),
        zone,
      };
    }));

    if (isHoof) {
      const hs = pawSize * hoofSize;
      const pawBone = idx(names[names.length - 1]);
      const bareStamp = (_i, p) => ({
        ...monoSkin(pawBone),
        length: 0.0004,
        colorMask: 0.88,
        groom: bodyGroomAt(p),
        zone: COAT_ZONE.paw,
      });

      if (footType === 'cloven-hoof') {
        // Two keratin toes split left/right under the distal bone.
        for (const toe of [-1, 1]) {
          const toeGeo = new THREE.SphereGeometry(0.015 * hs, 12, 10);
          toeGeo.scale(0.62, 0.48, 1.18);
          toeGeo.translate(
            paw.x + toe * 0.011 * hs,
            paw.y - 0.013 * hs,
            paw.z + 0.01 * hs,
          );
          stampPerVertex(toeGeo, bareStamp);
          parts.push(toeGeo);
        }
        // Soft cleft filler so the split does not read as a hole.
        const cleft = new THREE.SphereGeometry(0.008 * hs, 8, 6);
        cleft.scale(0.45, 0.35, 0.7);
        cleft.translate(paw.x, paw.y - 0.01 * hs, paw.z + 0.006 * hs);
        stampPerVertex(cleft, bareStamp);
        parts.push(cleft);
      } else {
        // Solid hoof (horse-like single wall) — same attach point.
        const wall = new THREE.SphereGeometry(0.02 * hs, 14, 12);
        wall.scale(0.95, 0.55, 1.15);
        wall.translate(paw.x, paw.y - 0.012 * hs, paw.z + 0.008 * hs);
        stampPerVertex(wall, bareStamp);
        parts.push(wall);
      }

      if (dewclawAmt > 0.05) {
        const dew = new THREE.SphereGeometry(0.007 * hs * (0.6 + dewclawAmt * 0.4), 8, 6);
        dew.scale(0.8, 0.7, 0.9);
        dew.translate(paw.x, pastern.y - 0.008, pastern.z - 0.012);
        stampPerVertex(dew, (_i, p) => ({
          ...monoSkin(idx(names[names.length - 2])),
          length: 0.0005,
          colorMask: 0.75,
          groom: bodyGroomAt(p),
          zone: COAT_ZONE.paw,
        }));
        parts.push(dew);
      }
    }

    const anklePuffs = phenotype?.furnishings?.anklePuffs ?? 0;
    // Rodent paws stay bare/skinny — skip dog ankle fur puffs.
    if (anklePuffs > 0 && !isHoof && !isRodentPaw) {
      const puffCenter = paw.clone().add(new THREE.Vector3(0, 0.018, 0));
      const puff = new THREE.SphereGeometry(0.038 * pawSize, 20, 14);
      puff.scale(1, 0.82, 1.05);
      puff.translate(puffCenter.x, puffCenter.y, puffCenter.z);
      stampPerVertex(puff, (_i, p) => ({
        ...monoSkin(idx(names[names.length - 1])),
        length: 0.035 * anklePuffs,
        colorMask: coatMask(COAT_ZONE.paw, p),
        groom: bodyGroomAt(p),
        zone: COAT_ZONE.paw,
      }));
      parts.push(puff);
    }

    // Rodent toe nubs — three tiny bare pads at the sole tip for a plantigrade
    // foot read (geometry loft alone is a single skinny pad).
    if (isRodentPaw) {
      const ps = Math.max(0.35, pawSize);
      const pawBone = idx(names[names.length - 1]);
      const bareToe = (_i, p) => ({
        ...monoSkin(pawBone),
        length: 0.0003,
        colorMask: 0.12,
        groom: bodyGroomAt(p),
        zone: COAT_ZONE.paw,
      });
      for (const toe of [-1, 0, 1]) {
        const toeGeo = new THREE.SphereGeometry(0.006 * ps, 8, 6);
        toeGeo.scale(0.55, 0.4, 0.95);
        toeGeo.translate(
          paw.x + toe * 0.006 * ps,
          paw.y - 0.01 * ps,
          paw.z + 0.03 * ps,
        );
        stampPerVertex(toeGeo, bareToe);
        parts.push(toeGeo);
      }
    }

    // Webbed paw (otter / beaver): regular flat pad (fell through above) plus
    // 4 forward toes spanned by a thin webbing membrane for the aquatic read.
    if (isWebbedPaw) {
      const ps = Math.max(0.5, pawSize);
      const pawBone = idx(names[names.length - 1]);
      const toes = [-1.5, -0.5, 0.5, 1.5];
      for (const toe of toes) {
        const toeGeo = new THREE.SphereGeometry(0.009 * ps, 10, 8);
        toeGeo.scale(0.7, 0.5, 1.1);
        toeGeo.translate(paw.x + toe * 0.012 * ps, paw.y - 0.009 * ps, paw.z + 0.03 * ps);
        stampPerVertex(toeGeo, (_i, p) => ({
          ...monoSkin(pawBone),
          length: 0.0006,
          colorMask: 0.16,
          groom: bodyGroomAt(p),
          zone: COAT_ZONE.paw,
        }));
        parts.push(toeGeo);
      }
      // Thin webbing disc spanning the toes (wide in X, deep in Z, razor-thin Y).
      const web = new THREE.SphereGeometry(0.022 * ps, 16, 10);
      web.scale(1.3, 0.18, 0.9);
      web.translate(paw.x, paw.y - 0.006 * ps, paw.z + 0.018 * ps);
      stampPerVertex(web, (_i, p) => ({
        ...monoSkin(pawBone),
        length: 0.0007,
        colorMask: 0.18,
        groom: bodyGroomAt(p),
        zone: COAT_ZONE.paw,
      }));
      parts.push(web);
    }
  }

  for (const geo of parts) {
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    if (!geo.getAttribute('uv')) {
      const n = geo.getAttribute('position').count;
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    }
  }

  const merged = mergeGeometries(parts, false);
  for (const geo of parts) geo.dispose();
  if (!merged) throw new Error('dog body geometry merge failed');

  // Crown hair-part length cut (ref: clear centerline groove)
  {
    const pos = merged.getAttribute('position');
    const fur = merged.getAttribute('furLength');
    const zone = merged.getAttribute('coatZone');
    for (let i = 0; i < pos.count; i += 1) {
      if (zone.getX(i) !== COAT_ZONE.head) continue;
      const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const part = hairPartStrength(p, headCenter);
      if (part > 0) fur.setX(i, fur.getX(i) * (1 - part * 0.94));
    }
    fur.needsUpdate = true;
  }

  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
