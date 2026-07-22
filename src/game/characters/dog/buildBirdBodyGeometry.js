/**
 * Procedural bird body mesh skinned to bird-rigged.glb bones.
 *
 * Same philosophy as dogBodyGeometry: rudimentary lofts / spheres / tubes /
 * cards — not a triangle copy of any reference GLB. Body-plan profiles
 * (`birdProportionProfile.js`) set waterfowl vs passerine vs raptor kits;
 * breed knobs (bodyFat, neckLen, beakStyle, …) refine per species.
 *
 * Authored in bind **world** space. Vertex `color` encodes plumage zones
 * (BIRD_ZONE / ZONE_RGB) for TSL materials.
 */

import * as THREE from 'three';
import {
  getBodyPlanProfile,
  planStationRadii,
} from './birdProportionProfile.js';

export const BIRD_ZONE = Object.freeze({
  body: 0,
  belly: 1,
  wing: 2,
  accent: 3,
  beak: 4,
  leg: 5,
});

const ZONE_RGB = Object.freeze({
  [BIRD_ZONE.body]: [1, 0, 0],
  [BIRD_ZONE.belly]: [0, 1, 0],
  [BIRD_ZONE.wing]: [0, 0, 1],
  [BIRD_ZONE.accent]: [1, 1, 0],
  [BIRD_ZONE.beak]: [0, 1, 1],
  [BIRD_ZONE.leg]: [1, 0, 1],
});

/**
 * @typedef {{
 *   bodyFat?: number,
 *   wingChord?: number,
 *   beakLen?: number,
 *   legThick?: number,
 *   tailSpread?: number,
 *   neckThick?: number,
 *   neckLen?: number,
 *   breast?: number,
 *   headSize?: number,
 *   eyeSize?: number,
 *   bodyPlan?: 'passerine'|'hummingbird'|'raptor'|'parrot'|'waterfowl'|'pigeon',
 *   beakStyle?: 'point'|'needle'|'hook'|'flat'|'cone'|'goose',
 *   footStyle?: 'perch'|'talon'|'web'|'zygodactyl',
 * }} BirdShape
 */

/**
 * @param {Map<string, THREE.Bone | THREE.Object3D>} bonesByName
 * @param {BirdShape} [shape]
 */
export function buildBirdBodyGeometry(bonesByName, shape = {}) {
  const bodyPlan = shape.bodyPlan ?? 'passerine';
  const bodyFat = shape.bodyFat ?? 1;
  const wingChord = shape.wingChord ?? 1;
  const beakLen = shape.beakLen ?? 1;
  const legThick = shape.legThick ?? 1;
  const tailSpread = shape.tailSpread ?? 1;
  const neckThick = shape.neckThick ?? 1;
  const neckLen = shape.neckLen ?? 1;
  const breast = shape.breast ?? 1;
  const headSize = shape.headSize ?? 1;
  const eyeSize = shape.eyeSize ?? 1;
  const beakStyle = shape.beakStyle ?? defaultBeakStyle(bodyPlan);
  const footStyle = shape.footStyle ?? defaultFootStyle(bodyPlan);

  /** Plan-driven silhouette multipliers from body-plan profiles. */
  const plan = planSilhouette(bodyPlan);

  // Effective head position. Stays at the head bone for the default short-neck
  // teardrop; raised above the body when neckLen > 1 (goose). Set in BODY, read
  // in HEAD/BEAK so the skull/beak/eyes ride atop a long neck instead of
  // detaching. bodyHeadOffset is zero in the default case (byte-identical).
  let bodyEffectiveHead = null;
  let bodyHeadOffset = null;

  /** @type {number[]} */
  const positions = [];
  /** @type {number[]} */
  const normals = [];
  /** @type {number[]} */
  const uvs = [];
  /** @type {number[]} */
  const colors = [];
  /** @type {number[]} */
  const indices = [];
  /** @type {number[]} */
  const skinIndex = [];
  /** @type {number[]} */
  const skinWeight = [];

  const boneList = [];
  const boneIndex = new Map();
  bonesByName.forEach((bone, name) => {
    if (boneIndex.has(name) || name === 'Head') return;
    boneIndex.set(name, boneList.length);
    boneList.push(bone);
  });
  if (!boneIndex.has('head') && bonesByName.has('head')) {
    boneIndex.set('head', boneList.length);
    boneList.push(bonesByName.get('head'));
  }

  function bi(name) {
    const i = boneIndex.get(name);
    if (i == null) throw new Error(`buildBirdBodyGeometry: missing bone ${name}`);
    return i;
  }
  function has(name) {
    return bonesByName.has(name);
  }
  function wp(name) {
    const bone = bonesByName.get(name);
    if (!bone) throw new Error(`buildBirdBodyGeometry: missing bone ${name}`);
    const p = new THREE.Vector3();
    bone.getWorldPosition(p);
    return p;
  }

  function addVertex(p, n, uv, bones, weights, zone = BIRD_ZONE.body, bellyMix = 0) {
    positions.push(p.x, p.y, p.z);
    normals.push(n.x, n.y, n.z);
    uvs.push(uv.x, uv.y);
    const key = ZONE_RGB[zone] ?? ZONE_RGB[BIRD_ZONE.body];
    if (zone === BIRD_ZONE.body && bellyMix > 0.01) {
      const t = THREE.MathUtils.clamp(bellyMix, 0, 1);
      colors.push(1 - t, t, 0);
    } else {
      colors.push(key[0], key[1], key[2]);
    }
    const b = [0, 0, 0, 0];
    const w = [0, 0, 0, 0];
    for (let i = 0; i < 4; i += 1) {
      b[i] = bones[i] ?? 0;
      w[i] = weights[i] ?? 0;
    }
    const sum = w[0] + w[1] + w[2] + w[3] || 1;
    skinIndex.push(b[0], b[1], b[2], b[3]);
    skinWeight.push(w[0] / sum, w[1] / sum, w[2] / sum, w[3] / sum);
    return positions.length / 3 - 1;
  }

  function addSphere(center, radius, bone, zone, seg = 10) {
    const rings = Math.max(6, Math.floor(seg * 0.75));
    const slices = seg;
    const ringStart = [];
    for (let y = 0; y <= rings; y += 1) {
      const v = y / rings;
      const phi = v * Math.PI;
      const base = positions.length / 3;
      ringStart.push(base);
      for (let x = 0; x <= slices; x += 1) {
        const u = x / slices;
        const theta = u * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(theta);
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.sin(theta);
        const p = center.clone().add(new THREE.Vector3(nx, ny, nz).multiplyScalar(radius));
        addVertex(
          p,
          new THREE.Vector3(nx, ny, nz),
          new THREE.Vector2(u, v),
          [bone, 0, 0, 0],
          [1, 0, 0, 0],
          zone,
          0,
        );
      }
    }
    for (let y = 0; y < rings; y += 1) {
      for (let x = 0; x < slices; x += 1) {
        const a0 = ringStart[y] + x;
        const a1 = ringStart[y] + x + 1;
        const b0 = ringStart[y + 1] + x;
        const b1 = ringStart[y + 1] + x + 1;
        indices.push(a0, b0, b1, a0, b1, a1);
      }
    }
  }

  /**
   * Oval loft. Stations may set bellyBias (ventral push) and zone.
   * @param {{ c: THREE.Vector3, rx: number, ry: number, bone: number, zone?: number, bellyBias?: number }[]} stations
   * @param {number} segs
   */
  function loftOval(stations, segs = 14) {
    if (stations.length < 2) return;
    const ringStart = [];
    let prevWidth = null;
    for (let i = 0; i < stations.length; i += 1) {
      const prev = stations[Math.max(0, i - 1)].c;
      const next = stations[Math.min(stations.length - 1, i + 1)].c;
      const tangent = next.clone().sub(prev);
      if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1);
      else tangent.normalize();
      let normal = new THREE.Vector3(0, 1, 0);
      if (Math.abs(tangent.dot(normal)) > 0.92) normal.set(1, 0, 0);
      const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
      normal = new THREE.Vector3().crossVectors(binormal, tangent).normalize();
      if (prevWidth && binormal.dot(prevWidth) < 0) {
        binormal.negate();
        normal.negate();
      }
      prevWidth = binormal.clone();

      const st = stations[i];
      const zone = st.zone ?? BIRD_ZONE.body;
      const bellyBias = st.bellyBias ?? 0;
      const base = positions.length / 3;
      ringStart.push(base);
      const t = i / Math.max(1, stations.length - 1);
      const prevB = stations[Math.max(0, i - 1)].bone;
      const nextB = stations[Math.min(stations.length - 1, i + 1)].bone;
      for (let s = 0; s < segs; s += 1) {
        const a = (s / segs) * Math.PI * 2;
        let ry = st.ry;
        let rx = st.rx;
        // Ventral breast / belly push (photo: soft rounded underside)
        if (Math.sin(a) < 0) {
          ry *= 1 + bellyBias * (-Math.sin(a));
        }
        // Dorsal slightly flatter for perched silhouette
        if (Math.sin(a) > 0) {
          ry *= plan.dorsalFlat;
        }
        const radial = binormal.clone().multiplyScalar(Math.cos(a) * rx)
          .addScaledVector(normal, Math.sin(a) * ry);
        const p = st.c.clone().add(radial);
        const n = binormal.clone().multiplyScalar(Math.cos(a) / Math.max(rx, 1e-6))
          .addScaledVector(normal, Math.sin(a) / Math.max(ry, 1e-6))
          .normalize();
        const bellyMix = zone === BIRD_ZONE.body
          ? THREE.MathUtils.clamp((-Math.sin(a) + 0.15) * 0.85, 0, 1)
          : 0;
        addVertex(
          p,
          n,
          new THREE.Vector2(s / segs, t),
          [st.bone, prevB, nextB, 0],
          i === 0 || i === stations.length - 1
            ? [1, 0, 0, 0]
            : [0.55, 0.225, 0.225, 0],
          zone,
          bellyMix,
        );
      }
    }
    for (let i = 0; i < stations.length - 1; i += 1) {
      const a0 = ringStart[i];
      const a1 = ringStart[i + 1];
      for (let s = 0; s < segs; s += 1) {
        const s1 = (s + 1) % segs;
        indices.push(a0 + s, a1 + s, a1 + s1, a0 + s, a1 + s1, a0 + s1);
      }
    }
  }

  function loftTube(stations, segs, zone) {
    loftOval(
      stations.map((st) => ({
        c: st.c,
        rx: st.r,
        ry: st.r * (st.ryScale ?? 1),
        bone: st.bone,
        zone: st.zone ?? zone,
        bellyBias: st.bellyBias,
      })),
      segs,
    );
  }

  /**
   * Wing membrane along bone chain — thin feather sheet for Flap/Glide.
   */
  function loftWing(chain, halfChord, zone = BIRD_ZONE.wing, chordSamples = 6) {
    const pts = chain.filter(has).map((name) => ({ c: wp(name), bone: bi(name) }));
    if (pts.length < 2) return;
    const rowStart = [];
    for (let i = 0; i < pts.length; i += 1) {
      const prev = pts[Math.max(0, i - 1)].c;
      const next = pts[Math.min(pts.length - 1, i + 1)].c;
      const tangent = next.clone().sub(prev);
      if (tangent.lengthSq() < 1e-10) tangent.set(1, 0, 0);
      else tangent.normalize();
      let chord = new THREE.Vector3(0, 0, 1);
      chord.addScaledVector(tangent, -chord.dot(tangent));
      if (chord.lengthSq() < 1e-8) {
        chord.set(0, 1, 0).addScaledVector(tangent, -tangent.y);
      }
      chord.normalize();
      const normal = new THREE.Vector3().crossVectors(tangent, chord).normalize();
      const t = i / Math.max(1, pts.length - 1);
      // Taper strongly toward tip (primary feathers)
      const chordW = halfChord * (1.35 - t * 1.05) * wingChord * plan.wingScale;
      const thick = chordW * 0.08;
      const base = positions.length / 3;
      rowStart.push(base);
      const b0 = pts[i].bone;
      const b1 = pts[Math.min(pts.length - 1, i + 1)].bone;
      const bPrev = pts[Math.max(0, i - 1)].bone;
      for (let v = 0; v < chordSamples; v += 1) {
        const u = v / (chordSamples - 1);
        // Leading edge closer to bone, trailing longer (photo feather cascade)
        const d = THREE.MathUtils.lerp(-chordW * 0.28, chordW * 1.05, u);
        const h = Math.sin(u * Math.PI) * thick * (u < 0.4 ? 1.0 : 0.45);
        const p = pts[i].c.clone()
          .addScaledVector(chord, d)
          .addScaledVector(normal, h);
        addVertex(
          p,
          normal,
          new THREE.Vector2(u, t),
          [b0, b1, bPrev, 0],
          [0.55, 0.25, 0.2, 0],
          zone,
          0,
        );
      }
    }
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a0 = rowStart[i];
      const a1 = rowStart[i + 1];
      for (let v = 0; v < chordSamples - 1; v += 1) {
        const i00 = a0 + v;
        const i01 = a0 + v + 1;
        const i10 = a1 + v;
        const i11 = a1 + v + 1;
        indices.push(i00, i10, i11, i00, i11, i01);
        indices.push(i00, i01, i11, i00, i11, i10);
      }
    }
  }

  /**
   * Photo-accurate folded wing pack (Idle profile):
   * - Covert mass on the flank (shoulder → rump)
   * - Stacked primary cards pointing caudal (toward tail), slightly down
   * - Optional pale wing-bar stripe (phoebe / passerine boards)
   *
   * Weighted to wing_1/2 + spine so Flap/Glide still peel the pack open.
   * Authored in bind space near the body (not along hanging wing tips) so the
   * perched silhouette matches refs before any clip plays.
   */
  function addFoldedWingPack(side) {
    const hip = wp('hips');
    const head = wp('head');
    const s0 = has('spine_0') ? wp('spine_0') : hip;
    const s1 = has('spine_1') ? wp('spine_1') : s0;
    const w1Name = `wing_1_${side}`;
    const w2Name = `wing_2_${side}`;
    if (!has(w1Name)) return;
    const w1 = wp(w1Name);
    const sx = side === 'L' ? 1 : -1;
    const bodyLen = hip.distanceTo(head) || 0.5;
    // Waterfowl: longer flank pack (profile ref: primaries reach near tail).
    const waterfowlFold = bodyPlan === 'waterfowl' ? 1.18 : 1;
    const packLen = bodyLen * 0.78 * plan.foldWing * waterfowlFold;
    // Tighter to body (less lateral bulge in front-sit)
    const packThick = bodyLen * 0.075 * bodyFat * plan.foldWing
      * (bodyPlan === 'waterfowl' ? 1.15 : 1);
    const shoulder = s1.clone().lerp(w1, 0.55);
    // Folded primaries aim caudal (Idle wing_tip sits near y=0, z toward tail).
    // Front-sit: wings almost invisible as separate lobes — tuck tight to body.
    // Profile: primaries stream back along the flanks toward the tail.
    const foldDir = new THREE.Vector3(
      sx * (bodyPlan === 'waterfowl' ? 0.04 : 0.06),
      bodyPlan === 'waterfowl' ? -0.08 : -0.12,
      -1,
    ).normalize();
    const outDir = new THREE.Vector3(sx, bodyPlan === 'waterfowl' ? 0.04 : 0.08, 0.02).normalize();
    const upDir = new THREE.Vector3().crossVectors(foldDir, outDir).normalize();

    const bW1 = bi(w1Name);
    const bW2 = has(w2Name) ? bi(w2Name) : bW1;
    const bS1 = bi('spine_1');
    const bHip = bi('hips');

    // ── Covert / secondary body (soft oval pack) ────────────────────────
    const stations = 7;
    const segs = 12;
    const ringStart = [];
    for (let i = 0; i < stations; i += 1) {
      const t = i / (stations - 1);
      // Shoulder (t=0) → past hips toward tail (t=1)
      const along = THREE.MathUtils.lerp(-packLen * 0.08, packLen * 0.95, t);
      const lateral = packThick * (0.55 + 0.7 * Math.sin(t * Math.PI));
      const c = shoulder.clone()
        .addScaledVector(foldDir, along)
        .addScaledVector(outDir, lateral * 0.85)
        .addScaledVector(upDir, packThick * 0.15 * Math.sin(t * Math.PI));
      // Tear-drop cross-section: thicker mid-wing (coverts), thin at primary tips
      const rx = packThick * (0.55 + 0.85 * Math.sin(t * Math.PI));
      const ry = packThick * (0.32 + 0.42 * Math.sin(t * Math.PI));
      const base = positions.length / 3;
      ringStart.push(base);
      // Weight shifts caudal → more hip influence at tips
      const wWing = 0.55 - t * 0.2;
      const wSpine = 0.3;
      const wHip = 0.15 + t * 0.2;
      for (let s = 0; s < segs; s += 1) {
        const a = (s / segs) * Math.PI * 2;
        // Flatten medial face against body
        let ox = Math.cos(a) * rx;
        if (ox * sx < 0) ox *= 0.35;
        const local = outDir.clone().multiplyScalar(ox)
          .addScaledVector(upDir, Math.sin(a) * ry);
        const p = c.clone().add(local);
        const n = local.lengthSq() > 1e-10 ? local.clone().normalize() : outDir.clone();
        addVertex(
          p,
          n,
          new THREE.Vector2(s / segs, t),
          [bW1, bS1, bHip, bW2],
          [wWing, wSpine, wHip, 0.1],
          BIRD_ZONE.wing,
          0,
        );
      }
    }
    for (let i = 0; i < stations - 1; i += 1) {
      for (let s = 0; s < segs; s += 1) {
        const s1i = (s + 1) % segs;
        indices.push(
          ringStart[i] + s, ringStart[i + 1] + s, ringStart[i + 1] + s1i,
          ringStart[i] + s, ringStart[i + 1] + s1i, ringStart[i] + s1i,
        );
      }
    }

    // ── Layered primary cards (photo: long folded primaries toward tail) ─
    const primaries = Math.round(9 * plan.foldWing);
    for (let i = 0; i < primaries; i += 1) {
      const t = i / Math.max(1, primaries - 1);
      // Fan slightly: outer feathers longer and more lateral
      const baseAlong = packLen * (0.1 + t * 0.14);
      const length = packLen * (0.62 + t * 0.55);
      const lat = packThick * (1.0 + t * 1.25);
      const drop = packThick * (0.04 + t * 0.4);
      const root = shoulder.clone()
        .addScaledVector(foldDir, baseAlong)
        .addScaledVector(outDir, lat * 0.55)
        .addScaledVector(upDir, packThick * 0.05 - drop * 0.2);
      const tip = root.clone()
        .addScaledVector(foldDir, length)
        .addScaledVector(outDir, lat * 0.35)
        .addScaledVector(upDir, -drop);
      const width = packThick * (0.55 - t * 0.2);
      let sideV = new THREE.Vector3().crossVectors(foldDir, upDir).normalize();
      sideV.multiplyScalar(width * 0.5);
      // Slight rotation per feather
      sideV.applyAxisAngle(foldDir, (t - 0.5) * 0.35 * sx);
      const n = new THREE.Vector3().crossVectors(tip.clone().sub(root), sideV).normalize();
      if (n.lengthSq() < 1e-8) n.copy(outDir);
      const corners = [
        root.clone().add(sideV),
        root.clone().sub(sideV),
        tip.clone().sub(sideV.clone().multiplyScalar(0.35)),
        tip.clone().add(sideV.clone().multiplyScalar(0.35)),
      ];
      const bones = [bW1, bW2, bHip, bS1];
      const weights = [0.4, 0.25, 0.2 + t * 0.15, 0.15];
      const i0 = addVertex(corners[0], n, new THREE.Vector2(0, 0), bones, weights, BIRD_ZONE.wing);
      const i1 = addVertex(corners[1], n, new THREE.Vector2(1, 0), bones, weights, BIRD_ZONE.wing);
      const i2 = addVertex(corners[2], n, new THREE.Vector2(1, 1), bones, weights, BIRD_ZONE.wing);
      const i3 = addVertex(corners[3], n, new THREE.Vector2(0, 1), bones, weights, BIRD_ZONE.wing);
      indices.push(i0, i1, i2, i0, i2, i3, i0, i2, i1, i0, i3, i2);
    }

    // ── Pale wing bar (phoebe / many passerines) ────────────────────────
    if (plan.wingBar > 0.01) {
      const barT = 0.38;
      const barAlong = packLen * barT;
      const barC = shoulder.clone()
        .addScaledVector(foldDir, barAlong)
        .addScaledVector(outDir, packThick * 1.05)
        .addScaledVector(upDir, packThick * 0.12);
      const barW = packThick * 1.1;
      const barH = packThick * 0.22;
      const barD = packThick * 0.35;
      // Use belly zone encoding as pale stripe (material mixes belly color)
      const barBones = [bW1, bS1, bHip, 0];
      const barWeights = [0.5, 0.3, 0.2, 0];
      const corners = [
        barC.clone().addScaledVector(foldDir, -barD).addScaledVector(outDir, -barW * 0.1).addScaledVector(upDir, barH),
        barC.clone().addScaledVector(foldDir, -barD).addScaledVector(outDir, barW).addScaledVector(upDir, barH),
        barC.clone().addScaledVector(foldDir, barD).addScaledVector(outDir, barW).addScaledVector(upDir, -barH * 0.2),
        barC.clone().addScaledVector(foldDir, barD).addScaledVector(outDir, -barW * 0.1).addScaledVector(upDir, -barH * 0.2),
      ];
      const n = outDir.clone();
      // Encode as body→belly mix high (pale) via bellyMix on body zone
      const bi0 = addVertex(corners[0], n, new THREE.Vector2(0, 0), barBones, barWeights, BIRD_ZONE.body, 0.85 * plan.wingBar);
      const bi1 = addVertex(corners[1], n, new THREE.Vector2(1, 0), barBones, barWeights, BIRD_ZONE.body, 0.85 * plan.wingBar);
      const bi2 = addVertex(corners[2], n, new THREE.Vector2(1, 1), barBones, barWeights, BIRD_ZONE.body, 0.85 * plan.wingBar);
      const bi3 = addVertex(corners[3], n, new THREE.Vector2(0, 1), barBones, barWeights, BIRD_ZONE.body, 0.85 * plan.wingBar);
      indices.push(bi0, bi1, bi2, bi0, bi2, bi3, bi0, bi2, bi1, bi0, bi3, bi2);
    }
  }

  function featherCard(b0, b1, width) {
    if (!has(b0) || !has(b1)) return;
    const p0 = wp(b0);
    const p1 = wp(b1);
    const dir = p1.clone().sub(p0);
    if (dir.lengthSq() < 1e-10) return;
    dir.normalize();
    let side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-8) side.crossVectors(dir, new THREE.Vector3(1, 0, 0));
    side.normalize().multiplyScalar(width * 0.5 * wingChord * plan.wingScale);
    const n = new THREE.Vector3().crossVectors(dir, side).normalize();
    const mid = p0.clone().lerp(p1, 0.5).addScaledVector(n, width * 0.06);
    const corners = [
      p0.clone().add(side),
      p0.clone().sub(side),
      p1.clone().sub(side.clone().multiplyScalar(0.45)),
      p1.clone().add(side.clone().multiplyScalar(0.45)),
    ];
    const i0 = addVertex(corners[0], n, new THREE.Vector2(0, 0), [bi(b0), bi(b1), 0, 0], [0.7, 0.3, 0, 0], BIRD_ZONE.wing);
    const i1 = addVertex(corners[1], n, new THREE.Vector2(1, 0), [bi(b0), bi(b1), 0, 0], [0.7, 0.3, 0, 0], BIRD_ZONE.wing);
    const i2 = addVertex(corners[2], n, new THREE.Vector2(1, 1), [bi(b1), bi(b0), 0, 0], [0.7, 0.3, 0, 0], BIRD_ZONE.wing);
    const i3 = addVertex(corners[3], n, new THREE.Vector2(0, 1), [bi(b1), bi(b0), 0, 0], [0.7, 0.3, 0, 0], BIRD_ZONE.wing);
    const im = addVertex(mid, n, new THREE.Vector2(0.5, 0.5), [bi(b0), bi(b1), 0, 0], [0.5, 0.5, 0, 0], BIRD_ZONE.wing);
    indices.push(i0, i1, im, i1, i2, im, i2, i3, im, i3, i0, im);
    indices.push(i0, im, i1, i1, im, i2, i2, im, i3, i3, im, i0);
  }

  /**
   * Soft fluff patches (front-sit + head-close):
   * - Deep cream belly (almost spherical from front)
   * - Lateral thigh coverts that hide UpperLeg (photo: only feet show)
   * - Throat ruff continuity into breast
   */
  function addBreastFluff() {
    const hips = wp('hips');
    const s0 = has('spine_0') ? wp('spine_0') : hips;
    const s1 = has('spine_1') ? wp('spine_1') : s0;
    const head = wp('head');
    const bodyLen = hips.distanceTo(head) || 0.5;
    const r = bodyLen * 0.16 * bodyFat * plan.breastDepth * breast;

    function fluffSphere(center, rad, bones, w, mix, flattenTop = 0.5) {
      const rings = 7;
      const slices = 12;
      const ringStart = [];
      for (let y = 0; y <= rings; y += 1) {
        const v = y / rings;
        const phi = v * Math.PI;
        const flatten = v < 0.42 ? flattenTop : 1;
        const base = positions.length / 3;
        ringStart.push(base);
        for (let x = 0; x <= slices; x += 1) {
          const u = x / slices;
          const theta = u * Math.PI * 2;
          const nx = Math.sin(phi) * Math.cos(theta);
          const ny = Math.cos(phi) * flatten;
          const nz = Math.sin(phi) * Math.sin(theta);
          const p = center.clone().add(new THREE.Vector3(nx, ny, nz).multiplyScalar(rad));
          addVertex(
            p,
            new THREE.Vector3(nx, ny, nz).normalize(),
            new THREE.Vector2(u, v),
            bones,
            w,
            BIRD_ZONE.body,
            mix,
          );
        }
      }
      for (let y = 0; y < rings; y += 1) {
        for (let x = 0; x < slices; x += 1) {
          indices.push(
            ringStart[y] + x, ringStart[y + 1] + x, ringStart[y + 1] + x + 1,
            ringStart[y] + x, ringStart[y + 1] + x + 1, ringStart[y] + x + 1,
          );
        }
      }
    }

    // Keel / belly core — waterfowl: deeper cream breast (front-sit oval)
    const keelMul = bodyPlan === 'waterfowl' ? 1.18 : 1;
    const creamMix = bodyPlan === 'waterfowl' ? 0.78 : 0.95;
    fluffSphere(
      s0.clone().add(new THREE.Vector3(0, -r * 0.95 * plan.breastDrop * keelMul, bodyLen * 0.06)),
      r * 1.2 * keelMul,
      [bi('spine_0'), bi('hips'), bi('spine_1'), 0],
      [0.5, 0.3, 0.2, 0],
      creamMix,
      0.42,
    );
    fluffSphere(
      s0.clone().lerp(s1, 0.3).add(new THREE.Vector3(0, -r * 0.55, bodyLen * 0.08)),
      r * 0.9 * keelMul,
      [bi('spine_0'), bi('spine_1'), bi('hips'), 0],
      [0.45, 0.35, 0.2, 0],
      creamMix * 0.95,
      0.48,
    );
    fluffSphere(
      hips.clone().lerp(s0, 0.45).add(new THREE.Vector3(0, -r * 0.8, 0)),
      r * 1.0 * keelMul,
      [bi('hips'), bi('spine_0'), 0, 0],
      [0.55, 0.45, 0, 0],
      creamMix * 0.92,
      0.5,
    );
    // Lateral thigh coverts — hide upper legs (front-sit: feet only)
    for (const sx of [-1, 1]) {
      const thigh = hips.clone().add(new THREE.Vector3(
        sx * r * 0.95,
        -r * 0.55,
        bodyLen * 0.02,
      ));
      fluffSphere(
        thigh,
        r * 0.7,
        [bi('hips'), bi('spine_0'), has(`UpperLeg_${sx > 0 ? 'L' : 'R'}`) ? bi(`UpperLeg_${sx > 0 ? 'L' : 'R'}`) : bi('hips'), 0],
        [0.45, 0.3, 0.25, 0],
        0.75,
        0.6,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BODY — plump teardrop (photo: continuous head→breast→belly→tail taper)
  // ═══════════════════════════════════════════════════════════════════════
  {
    const hips = wp('hips');
    const s0 = wp('spine_0');
    const s1 = wp('spine_1');
    const s2 = wp('spine_2');
    const s3 = wp('spine_3');
    const head = wp('head');
    const bodyLen = hips.distanceTo(head) || 0.5;
    // Front-sit: almost spherical body; profile: teardrop. Bias width (rx) up.
    // Body plans with measured envelopes (waterfowl, passerine, …) drive radii.
    const rMid = bodyLen * 0.24 * bodyFat * plan.bodyScale;
    const planProfile = getBodyPlanProfile(bodyPlan);
    const useEnvelope = Boolean(planProfile.envelope?.length);
    const envAt = (t, wMul = 1, hMul = 1) => {
      if (!useEnvelope) return null;
      return planStationRadii(bodyPlan, t, bodyLen * 1.55, {
        widthScale: bodyFat * plan.breastWidth * wMul,
        heightScale: bodyFat * plan.breastDepth * hMul,
      });
    };

    // Opt-in long neck (neckLen > 1, e.g. goose). The shared bird rig has no
    // neck bones, so we raise the effective head above the shoulder and grow a
    // tapered accent-zone tube between them; the HEAD section follows via
    // bodyEffectiveHead. Default (neckLen <= 1) keeps the short-neck teardrop
    // byte-identical — existing breeds are unaffected.
    const useLongNeck = neckLen > 1.0001;
    // Goose oracle: head is ~0.3 of body length above hips and forward on neck.
    const effectiveHead = useLongNeck
      ? head.clone().add(new THREE.Vector3(
          bodyLen * 0.04,
          bodyLen * 0.48 * (neckLen - 1),
          bodyLen * 0.06 * (neckLen - 1),
        ))
      : head;
    bodyEffectiveHead = effectiveHead;
    bodyHeadOffset = effectiveHead.clone().sub(head);

    const eTail = envAt(0.08, 0.9, 0.85);
    const eRump = envAt(0.25, 1.0, 0.95);
    const eBreast = envAt(0.45, 1.05, 1.05);
    const eChest = envAt(0.52, 1.0, 1.0);
    const eShoulder = envAt(0.58, 0.95, 0.9);

    const bodyStations = [
      // Rump — soft, continuous into tail coverts
      {
        c: hips.clone().lerp(has('tail_1') ? wp('tail_1') : hips, 0.22)
          .add(new THREE.Vector3(0, bodyLen * 0.025 * plan.rumpLift, 0)),
        rx: eTail?.rx ?? rMid * 0.88 * breast,
        ry: eTail?.ry ?? rMid * 0.65 * breast,
        bone: bi('hips'),
        bellyBias: 0.3,
      },
      {
        c: hips.clone().add(new THREE.Vector3(0, bodyLen * 0.01, 0)),
        rx: eRump?.rx ?? rMid * 1.22 * breast,
        ry: eRump?.ry ?? rMid * 1.02 * breast,
        bone: bi('hips'),
        bellyBias: 0.5,
      },
      // Deep keel / breast (front-sit: widest, fullest)
      {
        c: hips.clone().lerp(s0, 0.5).add(new THREE.Vector3(
          0,
          -bodyLen * 0.04 * plan.breastDrop,
          bodyLen * 0.035,
        )),
        rx: eBreast?.rx ?? rMid * 1.38 * breast * plan.breastWidth,
        ry: eBreast?.ry ?? rMid * 1.28 * breast * plan.breastDepth,
        bone: bi('spine_0'),
        bellyBias: 0.85,
      },
      {
        c: s0.clone().add(new THREE.Vector3(0, -bodyLen * 0.02 * plan.breastDrop, 0)),
        rx: eChest?.rx ?? rMid * 1.32 * breast * plan.breastWidth,
        ry: eChest?.ry ?? rMid * 1.18 * breast * plan.breastDepth,
        bone: bi('spine_0'),
        bellyBias: 0.7,
      },
      {
        c: s0.clone().lerp(s1, 0.55),
        rx: eShoulder?.rx ?? rMid * 1.08 * plan.shoulder,
        ry: eShoulder?.ry ?? rMid * 0.95 * plan.shoulder,
        bone: bi('spine_0'),
        bellyBias: 0.35,
      },
      // Mantle / shoulder — continuous into head (almost no neck)
      {
        c: s1,
        rx: (eShoulder?.rx ?? rMid * 0.98 * plan.shoulder) * 0.92,
        ry: (eShoulder?.ry ?? rMid * 0.9 * plan.shoulder) * 0.92,
        bone: bi('spine_1'),
        bellyBias: 0.15,
      },
    ];

    if (useLongNeck) {
      // Long waterfowl neck (goose): multi-station tube with a mild S-curve
      // (cervical stack approximated along spine_1→3), accent-zone black.
      // Base sits on the mantle with a short pale breast fairing; tip feeds
      // the black skull. Cross-section stays nearly circular (ref profile).
      const neckBase = s1.clone().lerp(s2, 0.35)
        .add(new THREE.Vector3(0, bodyLen * 0.02, bodyLen * 0.02));
      // Slightly oval: thicker front-back than side (streamlined).
      const neckRadBase = rMid * 0.52 * neckThick * plan.neck;
      const neckRadTip = rMid * 0.38 * neckThick * plan.neck;
      // Pale breast fairing into black neck (sharp field-mark boundary).
      bodyStations.push({
        c: s1.clone().add(new THREE.Vector3(0, bodyLen * 0.01, bodyLen * 0.04)),
        rx: rMid * 0.72 * breast * plan.shoulder,
        ry: rMid * 0.62 * breast,
        bone: bi('spine_1'),
        bellyBias: 0.55,
        zone: BIRD_ZONE.body,
      });
      const SEG = 11;
      for (let i = 0; i <= SEG; i += 1) {
        const t = i / SEG;
        // S-curve: push forward mid-neck, settle under the skull (photo profile).
        const sCurveZ = bodyLen * 0.07 * Math.sin(t * Math.PI);
        const sCurveY = bodyLen * 0.015 * Math.sin(t * Math.PI * 1.2);
        const c = neckBase.clone().lerp(effectiveHead, t)
          .add(new THREE.Vector3(0, sCurveY, sCurveZ));
        // Gentle taper base→tip; slight mid-thick for contour plumage read.
        const midBulge = 1 + 0.08 * Math.sin(t * Math.PI);
        const rad = (neckRadBase * (1 - t) + neckRadTip * t) * midBulge;
        const boneIdx = t < 0.28 ? bi('spine_1')
          : t < 0.55 ? bi('spine_2')
            : t < 0.82 ? bi('spine_3')
              : bi('head');
        bodyStations.push({
          c,
          rx: rad * 0.92,
          ry: rad * 1.05,
          bone: boneIdx,
          zone: BIRD_ZONE.accent,
        });
      }
      // Head bulb — black skull (chinstrap patches added in HEAD).
      bodyStations.push({
        c: effectiveHead,
        rx: rMid * 0.7 * headSize * plan.head,
        ry: rMid * 0.72 * headSize * plan.head,
        bone: bi('head'),
        zone: BIRD_ZONE.accent,
      });
    } else {
      // Short neck + head (original teardrop, byte-identical to pre-neckLen path).
      bodyStations.push(
        {
          c: s1.clone().lerp(s2, 0.6),
          rx: rMid * 0.78 * neckThick * plan.neck,
          ry: rMid * 0.75 * neckThick * plan.neck,
          bone: bi('spine_1'),
        },
        {
          c: s2.clone().lerp(s3, 0.4),
          rx: rMid * 0.68 * neckThick * plan.neck * headSize,
          ry: rMid * 0.68 * neckThick * plan.neck * headSize,
          bone: bi('spine_2'),
        },
        {
          c: s3.clone().lerp(head, 0.35),
          rx: rMid * 0.72 * headSize * plan.head,
          ry: rMid * 0.74 * headSize * plan.head,
          bone: bi('spine_3'),
          zone: BIRD_ZONE.accent,
        },
        {
          c: head,
          rx: rMid * 0.78 * headSize * plan.head,
          ry: rMid * 0.8 * headSize * plan.head,
          bone: bi('head'),
          zone: BIRD_ZONE.accent,
        },
      );
    }

    loftOval(bodyStations, 18);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HEAD — rounded skull + eyes (photo: large dark eye, soft crown)
  // ═══════════════════════════════════════════════════════════════════════
  {
    // HEAD rides the effective head position (bodyEffectiveHead) so the skull /
    // beak / eyes sit atop a long neck instead of detaching above the shoulder.
    // In the default short-neck case bodyEffectiveHead === the head bone, so
    // headOffset is zero and output stays byte-identical to the original.
    const head = bodyEffectiveHead;
    const headOffset = bodyHeadOffset;
    const beakBase = (has('mouth_upper')
      ? wp('mouth_upper')
      : wp('head').clone().add(new THREE.Vector3(0, 0, 0.08))
    ).add(headOffset);
    const r = Math.max(head.distanceTo(beakBase) * 0.55, 0.03) * headSize * plan.head;
    loftOval([
      {
        c: head.clone().add(new THREE.Vector3(0, r * 0.35, -r * 0.45)),
        rx: r * 0.95,
        ry: r * 0.9,
        bone: bi('head'),
        zone: BIRD_ZONE.accent,
      },
      {
        c: head.clone().add(new THREE.Vector3(0, r * 0.08, 0)),
        rx: r * 1.2,
        ry: r * 1.15,
        bone: bi('head'),
        zone: BIRD_ZONE.accent,
      },
      {
        c: head.clone().lerp(beakBase, 0.35),
        rx: r * 1.0,
        ry: r * 0.95,
        bone: bi('head'),
        zone: BIRD_ZONE.accent,
      },
      {
        c: head.clone().lerp(beakBase, 0.75),
        rx: r * 0.55,
        ry: r * 0.5,
        bone: bi('head'),
        zone: BIRD_ZONE.accent,
      },
    ], 14);

    // Eyes — large dark orbs, slightly forward (head-close / front-sit)
    const eyeR = r * 0.28 * eyeSize * plan.eye;
    const eyeForward = beakBase.clone().sub(head);
    if (eyeForward.lengthSq() < 1e-8) eyeForward.set(0, 0, 1);
    else eyeForward.normalize();
    const eyeUp = new THREE.Vector3(0, 1, 0);
    const eyeSide = new THREE.Vector3().crossVectors(eyeUp, eyeForward).normalize();
    // Front-sit: eyes face more forward on the skull
    const eyeCenter = head.clone()
      .addScaledVector(eyeForward, r * 0.42)
      .addScaledVector(eyeUp, r * 0.04);
    // Canada goose chinstrap: white cheek/chin patches (landmark ratios from
    // head-close ref) — belly zone so materials read pure white field marks.
    const gooseChinstrap = bodyPlan === 'waterfowl' && neckLen > 1.2;
    for (const sx of [1, -1]) {
      const ec = eyeCenter.clone().addScaledVector(eyeSide, sx * r * 0.72);
      // White-ish sclera ring (subtle) then dark iris/pupil
      addSphere(ec, eyeR * 1.05, bi('head'), BIRD_ZONE.beak, 11);
      addSphere(
        ec.clone().addScaledVector(eyeForward, eyeR * 0.5).addScaledVector(eyeSide, sx * eyeR * 0.05),
        eyeR * 0.55,
        bi('head'),
        BIRD_ZONE.leg,
        10,
      );
      if (gooseChinstrap) {
        // White chinstrap: broad cheek pad from eye-rear to under-bill.
        // Shape matches head-close: tall oval, sharp edge into black crown.
        const cheek = head.clone()
          .addScaledVector(eyeSide, sx * r * 0.78)
          .addScaledVector(eyeForward, r * 0.12)
          .addScaledVector(eyeUp, -r * 0.12);
        // Flattened ellipsoid loft along cheek → chin
        loftOval([
          {
            c: cheek.clone().addScaledVector(eyeForward, -r * 0.25).addScaledVector(eyeUp, r * 0.2),
            rx: r * 0.22,
            ry: r * 0.28,
            bone: bi('head'),
            zone: BIRD_ZONE.belly,
          },
          {
            c: cheek,
            rx: r * 0.38,
            ry: r * 0.48,
            bone: bi('head'),
            zone: BIRD_ZONE.belly,
          },
          {
            c: cheek.clone()
              .addScaledVector(eyeForward, r * 0.35)
              .addScaledVector(eyeUp, -r * 0.35)
              .addScaledVector(eyeSide, sx * r * -0.12),
            rx: r * 0.28,
            ry: r * 0.32,
            bone: bi('head'),
            zone: BIRD_ZONE.belly,
          },
          {
            // Chin join under bill base
            c: head.clone()
              .addScaledVector(eyeForward, r * 0.55)
              .addScaledVector(eyeUp, -r * 0.55),
            rx: r * 0.22,
            ry: r * 0.18,
            bone: bi('head'),
            zone: BIRD_ZONE.belly,
          },
        ], 12);
      } else {
        // Generic cheek under eye (passerine / non-chinstrap)
        const cheek = ec.clone()
          .addScaledVector(eyeSide, sx * r * 0.12)
          .addScaledVector(eyeUp, -r * 0.4)
          .addScaledVector(eyeForward, -r * 0.08);
        addSphere(cheek, r * 0.34, bi('head'), BIRD_ZONE.accent, 8);
      }
    }
    // Dark lores / face mask bridge between eyes (phoebe / flycatcher)
    if (plan.faceMask > 0.01) {
      const mask = head.clone()
        .addScaledVector(eyeForward, r * 0.55)
        .addScaledVector(eyeUp, -r * 0.05);
      loftOval([
        {
          c: mask.clone().addScaledVector(eyeSide, -r * 0.45),
          rx: r * 0.22 * plan.faceMask,
          ry: r * 0.18 * plan.faceMask,
          bone: bi('head'),
          zone: BIRD_ZONE.accent,
        },
        {
          c: mask,
          rx: r * 0.28 * plan.faceMask,
          ry: r * 0.2 * plan.faceMask,
          bone: bi('head'),
          zone: BIRD_ZONE.accent,
        },
        {
          c: mask.clone().addScaledVector(eyeSide, r * 0.45),
          rx: r * 0.22 * plan.faceMask,
          ry: r * 0.18 * plan.faceMask,
          bone: bi('head'),
          zone: BIRD_ZONE.accent,
        },
      ], 8);
    }
    // Throat ruff — skip pale throat on long-neck waterfowl (black neck all the way)
    if (!(bodyPlan === 'waterfowl' && neckLen > 1.2)) {
      const throat = head.clone()
        .addScaledVector(eyeForward, r * 0.45)
        .addScaledVector(eyeUp, -r * 0.7);
      addSphere(throat, r * 0.52 * plan.throat, bi('head'), BIRD_ZONE.accent, 10);
    }
    // Crown cap
    const crown = head.clone().addScaledVector(eyeUp, r * 0.5).addScaledVector(eyeForward, -r * 0.12);
    addSphere(crown, r * 0.58, bi('head'), BIRD_ZONE.accent, 10);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BEAK — style from photo (point / needle / hook / flat / cone)
  // ═══════════════════════════════════════════════════════════════════════
  if (has('mouth_upper') && has('mouth_upper_tip')) {
    const a = wp('mouth_upper').add(bodyHeadOffset);
    const b = wp('mouth_upper_tip').add(bodyHeadOffset);
    const dir = b.clone().sub(a);
    const len = Math.max(dir.length(), 0.02) * beakLen * plan.beak;
    const tipPos = a.clone().addScaledVector(dir.clone().normalize(), len);
    const r0 = len * beakRadiusForStyle(beakStyle);

    if (beakStyle === 'hook') {
      // Macaw / raptor: deep base, curved tip down
      const mid = a.clone().lerp(tipPos, 0.45);
      mid.y -= len * 0.12;
      const tip = tipPos.clone();
      tip.y -= len * 0.22;
      loftOval([
        { c: a, rx: r0 * 1.35, ry: r0 * 1.1, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: mid, rx: r0 * 0.85, ry: r0 * 0.7, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: tip, rx: r0 * 0.2, ry: r0 * 0.15, bone: bi('mouth_upper_tip'), zone: BIRD_ZONE.beak },
      ], 10);
      // Maxilla bulk
      loftOval([
        { c: a.clone().add(new THREE.Vector3(0, r0 * 0.3, -r0 * 0.2)), rx: r0 * 1.1, ry: r0 * 0.7, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: a.clone().lerp(tip, 0.35), rx: r0 * 0.7, ry: r0 * 0.45, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
      ], 8);
    } else if (beakStyle === 'flat') {
      // Duck: wide flat bill
      loftOval([
        { c: a, rx: r0 * 1.8, ry: r0 * 0.45, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: a.clone().lerp(tipPos, 0.55), rx: r0 * 1.5, ry: r0 * 0.35, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: tipPos, rx: r0 * 0.9, ry: r0 * 0.2, bone: bi('mouth_upper_tip'), zone: BIRD_ZONE.beak },
      ], 10);
    } else if (beakStyle === 'goose') {
      // Canada goose: black triangular bill with slight nail tip (head-close ref).
      // Less spatulate than mallard; deeper base, taper to a blunt nail.
      const mid = a.clone().lerp(tipPos, 0.48);
      mid.y -= len * 0.04;
      const nail = tipPos.clone();
      nail.y -= len * 0.02;
      loftOval([
        { c: a, rx: r0 * 1.35, ry: r0 * 0.85, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: mid, rx: r0 * 0.95, ry: r0 * 0.55, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: nail, rx: r0 * 0.42, ry: r0 * 0.28, bone: bi('mouth_upper_tip'), zone: BIRD_ZONE.beak },
      ], 11);
      // Lower mandible (slight gape read)
      if (has('mouth_lower')) {
        const la = wp('mouth_lower').add(bodyHeadOffset);
        loftOval([
          { c: la, rx: r0 * 1.1, ry: r0 * 0.35, bone: bi('mouth_lower'), zone: BIRD_ZONE.beak },
          { c: la.clone().lerp(nail, 0.75).add(new THREE.Vector3(0, -r0 * 0.15, 0)),
            rx: r0 * 0.35, ry: r0 * 0.15,
            bone: has('mouth_lower_tip') ? bi('mouth_lower_tip') : bi('mouth_lower'),
            zone: BIRD_ZONE.beak },
        ], 8);
      }
      // Nostril pits (tiny dark dimples — same beak zone, slightly inset)
      for (const sx of [-1, 1]) {
        const nare = a.clone().lerp(tipPos, 0.28)
          .add(new THREE.Vector3(sx * r0 * 0.55, r0 * 0.25, 0));
        addSphere(nare, r0 * 0.12, bi('mouth_upper'), BIRD_ZONE.beak, 6);
      }
    } else if (beakStyle === 'needle') {
      loftOval([
        { c: a, rx: r0 * 0.7, ry: r0 * 0.55, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: a.clone().lerp(tipPos, 0.5), rx: r0 * 0.35, ry: r0 * 0.28, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: tipPos, rx: r0 * 0.08, ry: r0 * 0.06, bone: bi('mouth_upper_tip'), zone: BIRD_ZONE.beak },
      ], 8);
    } else {
      // point / cone — passerine
      loftOval([
        { c: a, rx: r0 * 1.0, ry: r0 * 0.7, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: a.clone().lerp(tipPos, 0.5), rx: r0 * 0.5, ry: r0 * 0.35, bone: bi('mouth_upper'), zone: BIRD_ZONE.beak },
        { c: tipPos, rx: r0 * 0.1, ry: r0 * 0.07, bone: bi('mouth_upper_tip'), zone: BIRD_ZONE.beak },
      ], 9);
    }
  }
  if (has('mouth_lower') && has('mouth_lower_tip') && beakStyle !== 'flat' && beakStyle !== 'goose') {
    const a = wp('mouth_lower').add(bodyHeadOffset);
    const b = wp('mouth_lower_tip').add(bodyHeadOffset);
    const dir = b.clone().sub(a);
    const tipPos = a.clone().addScaledVector(dir, beakLen * plan.beak * 0.85);
    const r0 = Math.max(dir.length() * 0.2, 0.005) * plan.beak;
    loftOval([
      { c: a, rx: r0, ry: r0 * 0.45, bone: bi('mouth_lower'), zone: BIRD_ZONE.beak },
      { c: tipPos, rx: r0 * 0.1, ry: r0 * 0.06, bone: bi('mouth_lower_tip'), zone: BIRD_ZONE.beak },
    ], 7);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FOLDED WING PACK = primary perched silhouette (photo boards)
  // Distal hang-chain geometry is intentionally sparse: bind pose drops
  // wing_tip to y≈-2 and inflated the mesh into a vertical blob. Flap/Glide
  // still open the pack via wing_1/2 weights; thin proximal ribbons + feather
  // cards give open-wing area without bind-pose spaghetti.
  // ═══════════════════════════════════════════════════════════════════════
  addFoldedWingPack('L');
  addFoldedWingPack('R');

  for (const side of ['L', 'R']) {
    // Proximal arm only (wing_1 → wing_3) — skip tip bones for solid loft
    const proxChain = [
      `wing_1_${side}`,
      `wing_2_${side}`,
      `wing_3_${side}`,
    ].filter(has);
    if (proxChain.length >= 2) {
      const span = wp(proxChain[0]).distanceTo(wp(proxChain[proxChain.length - 1])) || 0.3;
      loftWing(proxChain, span * 0.16 * plan.wingScale, BIRD_ZONE.wing, 5);
      loftOval(
        proxChain.map((name, i) => {
          const t = i / Math.max(1, proxChain.length - 1);
          const r = span * 0.04 * wingChord * (1 - t * 0.35);
          return {
            c: wp(name),
            rx: r,
            ry: r * 0.55,
            bone: bi(name),
            zone: BIRD_ZONE.wing,
          };
        }),
        8,
      );
    }
    // Feather cards on mid primaries (still deform with Flap)
    for (const n of [1, 2, 3]) {
      featherCard(
        `wing_feather_${n}_1_${side}`,
        `wing_feather_${n}_2_${side}`,
        0.045 * (1.15 - n * 0.12),
      );
    }
    // Ultra-thin ribbon to tip so Glide still has a leading edge (minimal verts)
    const tipChain = [
      `wing_3_${side}`,
      `wing_4_${side}`,
      `wing_5_${side}`,
      `wing_tip_${side}`,
    ].filter(has);
    if (tipChain.length >= 2) {
      const span = wp(tipChain[0]).distanceTo(wp(tipChain[tipChain.length - 1])) || 0.4;
      loftWing(tipChain, span * 0.055 * plan.wingScale, BIRD_ZONE.wing, 3);
    }
  }

  // Soft breast fluff shell (photo: downy white/cream belly under folded wing)
  addBreastFluff();

  // ═══════════════════════════════════════════════════════════════════════
  // TAIL — discrete rectrices (photo: long taper, not a sausage)
  // ═══════════════════════════════════════════════════════════════════════
  {
    const chain = ['tail_1', 'tail_2', 'tail_3', 'tail_tip'].filter(has);
    if (chain.length >= 2) {
      const root = wp(chain[0]);
      const tip = wp(chain[chain.length - 1]);
      const len = root.distanceTo(tip) || 0.2;
      const tailLen = len * plan.tail * tailSpread;
      const dir = tip.clone().sub(root);
      if (dir.lengthSq() < 1e-10) dir.set(0, 0, -1);
      else dir.normalize();
      const up = new THREE.Vector3(0, 1, 0);
      let side = new THREE.Vector3().crossVectors(dir, up);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      const nrm = new THREE.Vector3().crossVectors(side, dir).normalize();

      // Soft undertail coverts — white V/U on waterfowl (belly zone)
      const undertailZone = bodyPlan === 'waterfowl' ? BIRD_ZONE.belly : BIRD_ZONE.wing;
      loftOval(
        chain.map((name, i) => {
          const t = i / Math.max(1, chain.length - 1);
          const r = tailLen * 0.07 * (1.15 - t * 0.85);
          return {
            c: wp(name).clone().add(new THREE.Vector3(0, bodyPlan === 'waterfowl' ? -tailLen * 0.04 : 0, 0)),
            rx: r * 1.4 * plan.tailFan * (bodyPlan === 'waterfowl' ? 1.25 : 1),
            ry: r * 0.28,
            bone: bi(name),
            zone: undertailZone,
            bellyBias: bodyPlan === 'waterfowl' ? 0.4 : 0,
          };
        }),
        10,
      );
      // Extra white undertail pad at rump (goose profile: bright V under black tail)
      if (bodyPlan === 'waterfowl') {
        loftOval([
          {
            c: root.clone().add(new THREE.Vector3(0, -tailLen * 0.08, tailLen * 0.05)),
            rx: tailLen * 0.18,
            ry: tailLen * 0.06,
            bone: bi(chain[0]),
            zone: BIRD_ZONE.belly,
          },
          {
            c: root.clone().add(new THREE.Vector3(0, -tailLen * 0.05, -tailLen * 0.1)),
            rx: tailLen * 0.12,
            ry: tailLen * 0.04,
            bone: bi(chain[0]),
            zone: BIRD_ZONE.belly,
          },
        ], 8);
      }

      // Discrete tail feathers — black (accent) on waterfowl, wing-zone otherwise
      const rectZone = bodyPlan === 'waterfowl' ? BIRD_ZONE.accent : BIRD_ZONE.wing;
      const rectrices = Math.max(6, Math.round(8 * plan.tailFan));
      for (let i = 0; i < rectrices; i += 1) {
        const u = (i / Math.max(1, rectrices - 1)) * 2 - 1; // -1..1
        const spread = u * tailLen * 0.22 * plan.tailFan;
        const featherLen = tailLen * (0.85 + (1 - Math.abs(u)) * 0.25);
        const rootP = root.clone()
          .addScaledVector(side, spread * 0.25)
          .addScaledVector(nrm, tailLen * 0.02);
        const tipP = rootP.clone()
          .addScaledVector(dir, featherLen)
          .addScaledVector(side, spread * 0.85)
          .addScaledVector(nrm, -tailLen * 0.02 * Math.abs(u));
        const halfW = tailLen * 0.045 * (1 - Math.abs(u) * 0.25);
        const sVec = side.clone().multiplyScalar(halfW);
        const bones = [bi(chain[0]), bi(chain[Math.min(chain.length - 1, 1)]), bi(chain[chain.length - 1]), 0];
        const weights = [0.35, 0.35, 0.3, 0];
        const n = nrm.clone();
        const c0 = addVertex(rootP.clone().add(sVec), n, new THREE.Vector2(0, 0), bones, weights, rectZone);
        const c1 = addVertex(rootP.clone().sub(sVec), n, new THREE.Vector2(1, 0), bones, weights, rectZone);
        const c2 = addVertex(tipP.clone().sub(sVec.clone().multiplyScalar(0.3)), n, new THREE.Vector2(1, 1), bones, weights, rectZone);
        const c3 = addVertex(tipP.clone().add(sVec.clone().multiplyScalar(0.3)), n, new THREE.Vector2(0, 1), bones, weights, rectZone);
        indices.push(c0, c1, c2, c0, c2, c3, c0, c2, c1, c0, c3, c2);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LEGS + FEET
  // Front-sit: thighs buried in belly fluff — only tarsus + toes show.
  // Skip UpperLeg mesh for passerine/pigeon plans (hidden by fluff).
  // ═══════════════════════════════════════════════════════════════════════
  for (const side of ['L', 'R']) {
    const hideThigh = bodyPlan === 'passerine' || bodyPlan === 'pigeon' || bodyPlan === 'hummingbird';
    const chain = (hideThigh
      ? [`LowerLeg_${side}`, `AnkleLeg_${side}`, `Foot_${side}`, `Toes_${side}`, `Toes_tip_${side}`]
      : [`UpperLeg_${side}`, `LowerLeg_${side}`, `AnkleLeg_${side}`, `Foot_${side}`, `Toes_${side}`, `Toes_tip_${side}`]
    ).filter(has);
    if (chain.length < 2) continue;
    const thick = 0.01 * legThick * plan.leg * (hideThigh ? 0.85 : 1);
    loftTube(
      chain.map((name, i) => {
        const t = i / Math.max(1, chain.length - 1);
        let r = thick * (1.15 - t * 0.4);
        if (name.startsWith('Foot') || name.startsWith('Toes')) r *= footStyle === 'talon' ? 1.8 : 1.4;
        return { c: wp(name), r, bone: bi(name), zone: BIRD_ZONE.leg };
      }),
      7,
      BIRD_ZONE.leg,
    );

    if (has(`Foot_${side}`)) {
      const foot = wp(`Foot_${side}`);
      const toe = has(`Toes_tip_${side}`) ? wp(`Toes_tip_${side}`) : foot.clone().add(new THREE.Vector3(0, -0.02, -0.04));
      const forward = toe.clone().sub(foot);
      if (forward.lengthSq() < 1e-10) forward.set(0, 0, -1);
      else forward.normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const sideV = new THREE.Vector3().crossVectors(up, forward).normalize();
      const padR = thick * (footStyle === 'web' ? 3.2 : footStyle === 'talon' ? 2.4 : 1.8);

      if (footStyle === 'web') {
        // Mallard-style paddle
        const padC = foot.clone().lerp(toe, 0.4);
        loftOval([
          { c: padC.clone().addScaledVector(forward, -padR * 0.3), rx: padR * 0.7, ry: padR * 0.2, bone: bi(`Foot_${side}`), zone: BIRD_ZONE.leg },
          { c: padC, rx: padR * 1.2, ry: padR * 0.22, bone: bi(`Foot_${side}`), zone: BIRD_ZONE.leg },
          {
            c: padC.clone().addScaledVector(forward, padR * 0.9),
            rx: padR * 0.9,
            ry: padR * 0.15,
            bone: has(`Toes_${side}`) ? bi(`Toes_${side}`) : bi(`Foot_${side}`),
            zone: BIRD_ZONE.leg,
          },
        ], 8);
      } else {
        // Anisodactyl / zygodactyl toe rays
        const toeBone = has(`Toes_${side}`) ? bi(`Toes_${side}`) : bi(`Foot_${side}`);
        const tipBone = has(`Toes_tip_${side}`) ? bi(`Toes_tip_${side}`) : toeBone;
        const rays = footStyle === 'zygodactyl'
          ? [
            { ang: 0.35, len: 1.0 },
            { ang: -0.35, len: 0.95 },
            { ang: 2.5, len: 0.75 },
            { ang: -2.5, len: 0.75 },
          ]
          : footStyle === 'talon'
            ? [
              { ang: 0.4, len: 1.15 },
              { ang: 0.0, len: 1.2 },
              { ang: -0.4, len: 1.15 },
              { ang: Math.PI, len: 0.7 },
            ]
            : [
              { ang: 0.45, len: 1.0 },
              { ang: 0.0, len: 1.05 },
              { ang: -0.45, len: 1.0 },
              { ang: Math.PI * 0.95, len: 0.55 },
            ];
        for (const ray of rays) {
          const dir = forward.clone().applyAxisAngle(up, ray.ang).normalize();
          const tip = foot.clone()
            .addScaledVector(dir, padR * 1.6 * ray.len)
            .add(new THREE.Vector3(0, -padR * 0.35, 0));
          loftOval([
            { c: foot.clone().add(new THREE.Vector3(0, -padR * 0.1, 0)), rx: thick * 0.9, ry: thick * 0.7, bone: bi(`Foot_${side}`), zone: BIRD_ZONE.leg },
            { c: tip, rx: thick * 0.35, ry: thick * 0.25, bone: tipBone, zone: BIRD_ZONE.leg },
          ], 5);
        }
        addSphere(
          foot.clone().add(new THREE.Vector3(0, -padR * 0.15, 0)),
          padR * 0.55,
          bi(`Foot_${side}`),
          BIRD_ZONE.leg,
          7,
        );
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.userData.boneNames = boneList.map((b) => b.name);
  geo.userData.vertexCount = positions.length / 3;
  geo.userData.zones = BIRD_ZONE;
  geo.userData.bodyPlan = bodyPlan;
  return geo;
}

function defaultBeakStyle(plan) {
  if (plan === 'hummingbird') return 'needle';
  if (plan === 'raptor' || plan === 'parrot') return 'hook';
  if (plan === 'waterfowl') return 'flat';
  if (plan === 'pigeon') return 'cone';
  return 'point';
}

function defaultFootStyle(plan) {
  if (plan === 'raptor') return 'talon';
  if (plan === 'waterfowl') return 'web';
  if (plan === 'parrot') return 'zygodactyl';
  return 'perch';
}

function beakRadiusForStyle(style) {
  if (style === 'hook') return 0.38;
  if (style === 'flat') return 0.28;
  if (style === 'goose') return 0.32;
  if (style === 'needle') return 0.12;
  if (style === 'cone') return 0.22;
  return 0.26;
}

/**
 * Silhouette multipliers from BODY_PLAN_PROFILES (single source of truth).
 * Maps profile fields onto the names used by loft/capsule construction.
 */
function planSilhouette(planId) {
  const p = getBodyPlanProfile(planId);
  return {
    bodyScale: p.bodyScale,
    breastWidth: p.breastWidth,
    breastDepth: p.breastDepth,
    breastDrop: p.breastDrop,
    shoulder: p.shoulder,
    neck: p.neckThick,
    head: p.head,
    eye: p.eye,
    beak: p.beak,
    wingScale: p.wingScale,
    foldWing: p.foldWing,
    tail: p.tail,
    tailFan: p.tailFan,
    leg: p.leg,
    rumpLift: p.rumpLift,
    dorsalFlat: p.dorsalFlat,
    wingBar: p.wingBar,
    throat: p.throat,
    faceMask: p.faceMask,
  };
}

/**
 * Remap geometry skinIndex from builder bone-name order → skeleton.bones order.
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Skeleton} skeleton
 */
export function remapBirdSkinIndices(geometry, skeleton) {
  const names = geometry.userData.boneNames;
  if (!Array.isArray(names)) return;
  const skeletonIndex = new Map(skeleton.bones.map((b, i) => [b.name, i]));
  const attr = geometry.getAttribute('skinIndex');
  if (!attr) return;
  for (let i = 0; i < attr.count; i += 1) {
    for (let k = 0; k < 4; k += 1) {
      const local = attr.getComponent(i, k);
      const boneName = names[local];
      attr.setComponent(i, k, skeletonIndex.get(boneName) ?? 0);
    }
  }
  attr.needsUpdate = true;
}
