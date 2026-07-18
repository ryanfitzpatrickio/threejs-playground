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
  hairPartStrength,
} from './dogCoatFields.js';

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
    coatMask[i] = s.colorMask + (s.earInner ? 2 : 0) + s.zone * 4;
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
    const normal = faceNormal.clone().addScaledVector(tangent, -faceNormal.dot(tangent));
    if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
    normal.normalize();
    const widthDir = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    if (previousWidth && widthDir.dot(previousWidth) < 0) widthDir.negate();
    previousWidth = widthDir.clone();
    frames.push({ normal, widthDir });

    const station = stations[i];
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
  const neckWidth = geom.neckWidth ?? 1;
  const skullWidth = geom.skullWidth ?? 1;
  const skullHeight = geom.skullHeight ?? 1;
  const skullLength = geom.skullLength ?? 1;
  const muzzleWidth = geom.muzzleWidth ?? 1;
  const legThickness = geom.legThickness ?? 1;
  const pawSize = geom.pawSize ?? 1;
  const faceShape = phenotype?.face ?? {};
  const eyeX = 0.032 * headScale * (faceShape.eyeSpacing ?? 1);
  const eyeY = 0.016 * headScale * (faceShape.eyeHeight ?? 1);
  const skullRx = 0.07 * headScale * 1.18 * skullWidth;
  const skullRy = 0.07 * headScale * 0.97 * skullHeight;
  const skullRz = 0.07 * headScale * 1.1 * skullLength;
  const eyeSurface = Math.sqrt(Math.max(
    0.08,
    1 - (eyeX / skullRx) ** 2 - ((eyeY - 0.008) / skullRy) ** 2,
  ));
  const eyeZ = 0.005 + skullRz * eyeSurface
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
      { c: pelvis.clone().add(new THREE.Vector3(0, 0.018, 0.02)), rx: 0.12 * torsoWidth, ry: 0.128 * torsoDepth, bone: idx('Pelvis') },
      { c: spine, rx: 0.128 * torsoWidth, ry: 0.138 * torsoDepth, bone: idx('Spine') },
      { c: spine1, rx: 0.132 * torsoWidth, ry: 0.142 * torsoDepth, bone: idx('Spine1') },
      { c: chest, rx: 0.13 * torsoWidth, ry: 0.14 * torsoDepth, bone: idx('Chest') },
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

  // ---- Head: broad golden skull + short muzzle (ref head-close) ----
  {
    const head = headCenter.clone();
    const muzzle = wp('Muzzle');
    const nose = wp('NoseTip');

    // Broad dome skull (wider than tall — golden proportions).
    {
      const skull = new THREE.SphereGeometry(0.07 * headScale, 48, 36);
      skull.scale(1.18 * skullWidth, 0.97 * skullHeight, 1.1 * skullLength);
      skull.translate(head.x, head.y + 0.008, head.z + 0.005);
      stampPerVertex(skull, (_i, p) => {
        let len = coatLength(COAT_ZONE.head, p);
        const dx = Math.abs(p.x - headCenter.x);
        const dy = p.y - headCenter.y;
        const dz = p.z - headCenter.z;
        // Short face plate with soft edges — hard cutoffs read as seams.
        const front = THREE.MathUtils.smoothstep(dz, 0.015, 0.055)
          * (1 - THREE.MathUtils.smoothstep(Math.abs(dy - 0.008), 0.03, 0.08));
        len = Math.min(len, THREE.MathUtils.lerp(0.03, 0.004, front));
        // Bare soft ovals follow the breed-scaled eye placement on the skull.
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

    // Short wide muzzle (ref is blocky-soft, not fox snout).
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

    // Soft cheeks (ref fill — not mumps spheres).
    for (const side of [1, -1]) {
      const c = head.clone().add(new THREE.Vector3(side * 0.047 * headScale * skullWidth, -0.006, 0.012));
      const cheek = new THREE.SphereGeometry(0.04 * headScale, 28, 22);
      cheek.scale(skullWidth, 0.95 * skullHeight, 1.1 * skullLength);
      cheek.translate(c.x, c.y, c.z);
      stampPerVertex(cheek, (_i, p) => {
        let len = coatLength(COAT_ZONE.head, p) * 1.1;
        const dx = Math.abs(p.x - headCenter.x);
        const dy = p.y - headCenter.y;
        const dz = p.z - headCenter.z;
        // Same soft eye ovals as the skull so the seam never shows.
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

    // ---- Bottom jaw: an actual lower-jaw loft, not a chin nub ----
    // Rigidly skinned to the Jaw bone end to end (a real jaw swinging on its
    // hinge), running from near the Jaw bone's pivot back under the cheek
    // forward past the muzzle base to a rounded chin tip that sits just
    // below and slightly behind the nose — where a real lower jaw/lip
    // actually reaches, not stopping short under the muzzle base. Its own
    // upper surface becomes the visible floor of the mouth once the jaw
    // drops, instead of needing a separate hidden shape to mask the gap.
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
      // Hang from the lower-jaw chin tip, fully skinned to Jaw so the beard
      // swings with the mouth (not glued to the upper muzzle mid-face).
      const jawBone = idx('Jaw');
      const muzzle = wp('Muzzle');
      const nose = wp('NoseTip');
      // Match the jaw loft's forward chin tip (see lower-jaw stations above).
      const chinTip = muzzle.clone().lerp(nose, 0.92).add(
        new THREE.Vector3(0, -0.024 * headScale, -0.004 * headScale),
      );
      const hang = Math.max(0.55, beard);
      const beardGeo = loftChain([
        // Root: underside of the chin tip
        {
          c: chinTip.clone().add(new THREE.Vector3(0, -0.002 * headScale, 0.002 * headScale)),
          rx: 0.026 * headScale * muzzleWidth,
          ry: 0.012 * headScale,
          bone: jawBone,
        },
        {
          c: chinTip.clone().add(new THREE.Vector3(0, -0.032 * headScale * hang, 0.01 * headScale)),
          rx: 0.03 * headScale * muzzleWidth,
          ry: 0.016 * headScale,
          bone: jawBone,
        },
        {
          c: chinTip.clone().add(new THREE.Vector3(0, -0.062 * headScale * hang, 0.006 * headScale)),
          rx: 0.022 * headScale * muzzleWidth,
          ry: 0.013 * headScale,
          bone: jawBone,
        },
        // Tip: droops down / slightly back under the chin
        {
          c: chinTip.clone().add(new THREE.Vector3(0, -0.09 * headScale * hang, -0.004 * headScale)),
          rx: 0.011 * headScale * muzzleWidth,
          ry: 0.008 * headScale,
          bone: jawBone,
        },
      ], 20, (p) => ({
        length: 0.038 * beard,
        colorMask: coatMask(COAT_ZONE.muzzle, p),
        groom: [0, -0.95, 0.12],
        zone: COAT_ZONE.muzzle,
      }));
      parts.push(beardGeo);
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
    const isErect = earType === 'erect' || isBat;
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
      faceNormal: new THREE.Vector3(0, 0, 1),
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
    const stations = DOG_TAIL_BONES.map((name, i) => {
      const c = wp(name);
      const r = (0.042 - i * 0.0055) * (phenotype?.tail?.thickness ?? 1);
      return { c, rx: r, ry: r * 0.95, bone: idx(name) };
    });
    stations.push({
      c: wp('Tail4').add(new THREE.Vector3(0, -0.012, -0.05)),
      rx: 0.01,
      ry: 0.009,
      bone: idx('Tail4'),
    });
    parts.push(loftChain(stations, 20, (p) => ({
      length: coatLength(COAT_ZONE.tail, p),
      colorMask: coatMask(COAT_ZONE.tail, p),
      groom: [0, -0.15, -1],
      zone: COAT_ZONE.tail,
    })));
  }

  // ---- Legs + flat pads (not tippy-toe spikes) ----
  for (const chain of Object.values(DOG_LEG_CHAINS)) {
    const names = chain.bones;
    const stations = [];
    for (let i = 0; i < names.length; i += 1) {
      const c = wp(names[i]);
      let rx;
      if (i === 0) rx = (chain.front ? 0.05 : 0.054) * legThickness;
      else if (i === 1) rx = 0.042 * legThickness;
      else if (i === 2) rx = 0.034 * legThickness;
      else if (i === 3) rx = 0.028 * legThickness; // pastern / hock
      else rx = 0.026 * pawSize; // paw bone (mid-pad)
      stations.push({
        c,
        rx,
        ry: rx * (i >= names.length - 2 ? 0.75 : 0.95),
        bone: idx(names[i]),
      });
    }
    // Flat foot pad: from pastern/hock down to ground, then forward under the paw.
    // These three rings force an explicit world-up hint (rather than the
    // propagated frame) so the flat pad stays level and on the floor
    // regardless of how the chain above it is oriented.
    const padUp = new THREE.Vector3(0, 1, 0);
    const pastern = wp(names[names.length - 2]);
    const paw = wp(names[names.length - 1]);
    // Heel under pastern/hock
    stations.splice(stations.length - 1, 0, {
      c: pastern.clone().add(new THREE.Vector3(0, -0.016, 0.008)),
      rx: 0.03 * pawSize,
      ry: 0.014,
      bone: idx(names[names.length - 2]),
      up: padUp,
    });
    // Mid pad at paw bone
    stations[stations.length - 1] = {
      c: paw.clone().add(new THREE.Vector3(0, -0.01, 0)),
      rx: 0.034 * pawSize,
      ry: 0.012,
      bone: idx(names[names.length - 1]),
      up: padUp,
    };
    // Toe end of pad (forward, still on the floor)
    stations.push({
      c: paw.clone().add(new THREE.Vector3(0, -0.014, 0.028)),
      rx: 0.026 * pawSize,
      ry: 0.01,
      bone: idx(names[names.length - 1]),
      up: padUp,
    });

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
    const capStations = [
      { c: parent.clone().lerp(attach, 0.35), rx: 0.068, ry: 0.058, bone: idx(parentName) },
      { c: attach.clone().lerp(parent, 0.25), rx: 0.058, ry: 0.052, bone: idx(rootBone) },
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
    const pawStartT = (capLen + 0.72 * legLen) / mergedLen;
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

    const anklePuffs = phenotype?.furnishings?.anklePuffs ?? 0;
    if (anklePuffs > 0) {
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
