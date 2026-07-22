/**
 * Canada goose body geometry — one skinned BufferGeometry generated at boot.
 *
 * Core trick: a SINGLE ring-loft runs tail-stub → torso → breast → up the
 * S-curve neck → over the skull → out the bill to the nail tip. The loft path
 * lives in the YZ plane, so ring frames never twist and the surface is
 * seam-free from rump to bill.
 *
 * Shape is driven by `gooseMorph` (neck length, body upright, beak/foot/eye
 * styles) so other bird varieties share this body as remorphed silhouettes.
 *
 * Baked vertex attributes (consumed by goosePlumage TSL):
 *   position/normal/uv(coatUV)/skinIndex/skinWeight
 *   featherLen / groomDir / zoneId
 */

import * as THREE from 'three';
import { GOOSE_DIMS } from './gooseDims.js';
import {
  applyBeakXform,
  beakXformIsIdentity,
  DEFAULT_GOOSE_MORPH,
  morphBodyYZ,
  resolveGooseMorph,
} from './gooseMorph.js';

export const GOOSE_ZONE = Object.freeze({
  plumage: 0,   // body contour feathers only (brown/barred — never black stocking)
  bill: 1,      // keratin — hard, no shells
  leg: 2,       // bare tarsus/foot/web skin (black on Canada goose)
  eye: 3,
  wing: 4,      // folded wing envelope (covert rows, shells on)
  tail: 5,      // tail stub under the rectrices
  neck: 6,      // head + neck contour (black stocking lives only here)
});

/** @typedef {{
 *   c: [number, number],            // path center (y, z)
 *   cx?: number,                    // optional lateral center offset (neck socket)
 *   hw: number,                     // half width  (±X)
 *   ht: number,                     // half height above center
 *   hb: number,                     // half height below center
 *   keel?: number,                  // 0..1 breast keel pinch
 *   exp?: number,                   // superellipse exponent (2 = ellipse)
 *   crease?: number,                // bill tomium inward pinch 0..1
 *   zone?: number,
 *   fl?: number,                    // featherLen meters
 *   bones: Array<[string, number]>, // [boneName, weight] up to 4
 * }} LoftStation */

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Apply morph.beakXform to bill/jaw loft stations about bill-base pivot.
 * Scale X → half-width, Y → ht/hb, Z → path length (via center).
 * @param {LoftStation[]} stations
 * @param {{ x: number, y: number, z: number }} pivot
 * @param {import('./gooseMorph.js').GooseMorph['beakXform']} xform
 * @returns {LoftStation[]}
 */
function transformBillStations(stations, pivot, xform) {
  if (!stations?.length || beakXformIsIdentity(xform)) return stations;
  const sx = xform.scale?.x ?? 1;
  const sy = xform.scale?.y ?? 1;
  return stations.map((st) => {
    const cx = st.cx ?? 0;
    const [nx, ny, nz] = applyBeakXform(cx, st.c[0], st.c[1], pivot, xform);
    return {
      ...st,
      c: [ny, nz],
      cx: nx,
      hw: st.hw * sx,
      ht: st.ht * sy,
      hb: st.hb * sy,
    };
  });
}

/**
 * Style-driven bill loft stations from head toward the tip.
 * @param {number} headY
 * @param {number} headZ
 * @param {object} D morph.dims
 * @param {import('./gooseMorph.js').GooseMorph['beak']} bk
 * @returns {LoftStation[]}
 */
function buildBillStations(headY, headZ, D, bk) {
  const baseY = D.billBaseY;
  const baseZ = D.billBaseZ;
  const tipY = D.billTipY;
  const tipZ = D.billTipZ;
  const w0 = D.billHalfWidth;
  const depth = bk.depth;
  const box = 2 + bk.boxy * 1.1;
  const crease = bk.crease;
  const isHook = bk.style === 'hook' || bk.hook > 0.5;

  /**
   * Profile samples: t along culmen, w/h/b = half-width / upper / lower relative
   * to w0.
   *
   * Hook (macaw/raptor): high deep cere, strongly arched culmen (C-curve),
   * sharp downturned tip past the lower jaw. Soft cross-section — no heavy
   * tomium "teeth" crease.
   * @type {Array<{ t: number, w: number, h: number, b: number, exp: number, cr: number }>}
   */
  let samples;
  if (isHook) {
    samples = [
      // Cere — deep, wide, rounded where it leaves the skull
      { t: 0.0, w: 1.38, h: 1.55, b: 0.72, exp: 2.35, cr: crease * 0.12 },
      { t: 0.10, w: 1.35, h: 1.70, b: 0.65, exp: 2.4, cr: crease * 0.18 },
      // Peak mass just past the cere (high arched culmen)
      { t: 0.22, w: 1.22, h: 1.58, b: 0.52, exp: 2.35, cr: crease * 0.2 },
      { t: 0.38, w: 1.02, h: 1.28, b: 0.42, exp: 2.3, cr: crease * 0.18 },
      // Descent — height collapses as the bill curves down
      { t: 0.55, w: 0.78, h: 0.95, b: 0.32, exp: 2.2, cr: crease * 0.12 },
      { t: 0.70, w: 0.52, h: 0.62, b: 0.22, exp: 2.12, cr: crease * 0.06 },
      { t: 0.84, w: 0.30, h: 0.36, b: 0.14, exp: 2.05, cr: 0 },
      // Sharp hooked tip
      { t: 0.94, w: 0.14, h: 0.18, b: 0.07, exp: 2.0, cr: 0 },
      { t: 1.0, w: 0.05, h: 0.07, b: 0.03, exp: 2.0, cr: 0 },
    ];
  } else {
    samples = [
      { t: 0.0, w: 1.12, h: 0.93, b: 0.79, exp: box * 0.9, cr: crease * 0.55 },
      { t: 0.22, w: 0.98, h: 0.74, b: 0.64, exp: box, cr: crease },
      { t: 0.45, w: 0.84, h: 0.60, b: 0.55, exp: box * 1.05, cr: crease * 1.05 },
      { t: 0.68, w: 0.69, h: 0.48, b: 0.45, exp: box, cr: crease * 0.75 },
      { t: 0.86, w: 0.50, h: 0.34, b: 0.31, exp: 2.2, cr: crease * 0.25 },
      { t: 1.0, w: 0.26, h: 0.17, b: 0.15, exp: 2.0, cr: 0 },
    ];
  }

  // Hook: forward reach of the culmen (slightly shorter than a goose bill).
  const lenZ = isHook
    ? (D.billTipZ - D.billBaseZ) * Math.max(0.75, Math.min(1.1, bk.length / 0.75))
    : (tipZ - baseZ);

  return samples.map((s, i) => {
    let y;
    let z;

    if (isHook) {
      // Side-view culmen as a macaw C-curve:
      //   early dome high above the gape, then continuous fall through the tip
      //   so the tomium hangs well below the lower jaw.
      // Relative Y: peak ~+0.034 near t=0.18, tip ~-0.058.
      const t = s.t;
      const dome = 0.036 * Math.sin(Math.min(1, t / 0.2) * Math.PI * 0.5)
        * Math.exp(-t * 2.4);
      // Steady fall + accelerating tip hook
      const fall = 0.016 * t + 0.052 * Math.pow(t, 2.35);
      y = baseY + dome - fall * bk.hook;
      // Forward with a slight tip tuck (hook curves under)
      const tuck = t > 0.72
        ? bk.hook * 0.022 * Math.pow((t - 0.72) / 0.28, 2.1)
        : 0;
      z = baseZ + lenZ * t - tuck;
    } else {
      y = lerp(baseY, tipY, s.t);
      z = lerp(baseZ, tipZ, s.t);
      if (bk.hook > 0 && s.t > 0.45) {
        const ht = (s.t - 0.45) / 0.55;
        y -= bk.hook * 0.028 * ht * ht;
        z -= bk.hook * 0.01 * ht;
      }
    }

    const flatMulH = bk.style === 'flat' ? 0.85 : 1;
    const flatMulB = bk.style === 'flat' ? 0.7 : 1;
    const hw = w0 * s.w * (isHook ? 1.0 : 1);
    const ht = w0 * s.h * depth * flatMulH;
    const hb = w0 * s.b * depth * flatMulB;
    void headY; void headZ;
    return {
      c: [y, z],
      hw,
      ht,
      hb,
      exp: s.exp,
      crease: s.cr,
      zone: GOOSE_ZONE.bill,
      fl: 0,
      bones: i < 2
        ? [['head', 0.92], ['jaw', 0.08]]
        : i < 4
          ? [['head', 0.9], ['jaw', 0.1]]
          : [['head', 1]],
    };
  });
}

/**
 * @param {Map<string, number>} boneIndex
 * @param {import('./gooseMorph.js').GooseMorphInput | import('./gooseMorph.js').GooseMorph} [morphInput]
 */
export function buildGooseBodyGeometry(boneIndex, morphInput = DEFAULT_GOOSE_MORPH) {
  const morph = /** @type {import('./gooseMorph.js').GooseMorph} */ (
    morphInput.dims ? morphInput : resolveGooseMorph(morphInput)
  );
  const D = morph.dims;
  const fat = morph.bodyFat;
  const positions = [];
  const normals = [];
  const uvs = [];
  const skinIndices = [];
  const skinWeights = [];
  const featherLens = [];
  const groomDirs = [];
  const zoneIds = [];
  const indices = [];

  const bi = (name) => {
    const idx = boneIndex.get(name);
    if (idx == null) throw new Error(`goose geometry: unknown bone ${name}`);
    return idx;
  };

  /** Map a canonical torso station (y,z) through the morph. */
  const mapYZ = (y, z) => morphBodyYZ(y, z, morph);

  /**
   * @param {THREE.Vector3} p position
   * @param {THREE.Vector2} uv coatUV
   * @param {Array<[string, number]>} bones
   * @param {THREE.Vector3} groom
   * @param {number} fl
   * @param {number} zone
   * @returns {number} vertex index
   */
  function addVertex(p, uv, bones, groom, fl, zone) {
    positions.push(p.x, p.y, p.z);
    normals.push(0, 1, 0); // recomputed at the end
    uvs.push(uv.x, uv.y);
    const idx = [0, 0, 0, 0];
    const wts = [0, 0, 0, 0];
    let total = 0;
    bones.slice(0, 4).forEach(([name, w], k) => {
      idx[k] = bi(name);
      wts[k] = Math.max(0, w);
      total += wts[k];
    });
    if (total <= 0) { wts[0] = 1; total = 1; }
    skinIndices.push(...idx);
    skinWeights.push(wts[0] / total, wts[1] / total, wts[2] / total, wts[3] / total);
    featherLens.push(fl);
    groomDirs.push(groom.x, groom.y, groom.z);
    zoneIds.push(zone);
    return positions.length / 3 - 1;
  }

  const _T = new THREE.Vector3();
  const _R = new THREE.Vector3(1, 0, 0);
  const _U = new THREE.Vector3();
  const _P = new THREE.Vector3();
  const _G = new THREE.Vector3();

  /**
   * Ring-loft along a station list. Stations' centers are (y,z) in the YZ
   * plane, optional `cx` shifts the path off midplane (neck socket yaw/roll).
   *
   * @param {LoftStation[]} stations
   * @param {number} segs
   * @param {{ capStart?: boolean, capEnd?: boolean, sOffset?: number, groomSign?: number }} [opts]
   * @returns {number} accumulated arc length
   */
  function loftPath(stations, segs, opts = {}) {
    const groomSign = opts.groomSign ?? -1; // feathers lay toward the tail
    const ringStart = [];
    let s = opts.sOffset ?? 0;
    const stX = (st) => (Number.isFinite(st.cx) ? st.cx : 0);

    for (let i = 0; i < stations.length; i += 1) {
      const st = stations[i];
      const prevSt = stations[Math.max(0, i - 1)];
      const nextSt = stations[Math.min(stations.length - 1, i + 1)];
      // Tangent from neighbors (supports slight X drift from socket yaw).
      _T.set(
        stX(nextSt) - stX(prevSt),
        nextSt.c[0] - prevSt.c[0],
        nextSt.c[1] - prevSt.c[1],
      );
      if (_T.lengthSq() < 1e-12) _T.set(0, 0, 1);
      _T.normalize();
      _U.crossVectors(_T, _R).normalize(); // "up" of the ring frame
      if (_U.lengthSq() < 1e-8) {
        _U.set(0, 1, 0);
        _U.crossVectors(_T, _R).normalize();
      }
      if (i > 0) {
        s += Math.hypot(stX(st) - stX(prevSt), st.c[0] - prevSt.c[0], st.c[1] - prevSt.c[1]);
      }

      const zone = st.zone ?? GOOSE_ZONE.plumage;
      const fl = st.fl ?? 0.015;
      const exp = st.exp ?? 2;
      const ringIdx = [];
      const circumference = Math.PI * (st.hw + (st.ht + st.hb) * 0.5);

      for (let j = 0; j < segs; j += 1) {
        const theta = (j / segs) * Math.PI * 2; // 0 at +X (left side), CCW seen from +T
        let cx = Math.cos(theta);
        let cy = Math.sin(theta);
        // Superellipse rounding (exp>2 boxier — used on the bill).
        if (exp !== 2) {
          const n = 2 / exp;
          cx = Math.sign(cx) * Math.abs(cx) ** n;
          cy = Math.sign(cy) * Math.abs(cy) ** n;
        }
        let px = cx * st.hw;
        let py = cy > 0 ? cy * st.ht : cy * st.hb;
        // Breast keel: pinch the lower half toward a soft V.
        if (st.keel && cy < 0) {
          const kb = st.keel * Math.pow(-cy, 1.5);
          px *= 1 - kb * 0.55;
          py *= 1 + st.keel * 0.12 * -cy;
        }
        // Bill tomium crease: inward pinch just below the horizontal midline.
        if (st.crease) {
          const dLeft = Math.abs(theta - Math.PI * 0.94);
          const dRight = Math.abs(theta - Math.PI * 2.06 + Math.PI * 2 * (theta < Math.PI ? 1 : 0));
          const dd = Math.min(
            Math.abs(theta - Math.PI * 1.06),
            Math.abs(theta - (Math.PI * 2 - Math.PI * 0.06) + (theta < Math.PI ? -Math.PI * 2 : 0)),
          );
          void dLeft; void dRight;
          const pinch = Math.exp(-((dd / 0.28) ** 2));
          px *= 1 - st.crease * 0.32 * pinch;
          py -= st.crease * 0.0016 * pinch * Math.sign(py || -1);
        }

        _P.set(stX(st) + px, st.c[0], st.c[1]).addScaledVector(_U, py);
        _G.copy(_T).multiplyScalar(groomSign);
        const uv = new THREE.Vector2(s, (j / segs) * circumference);
        ringIdx.push(addVertex(_P, uv, st.bones, _G.clone(), fl, zone));
      }
      ringStart.push(ringIdx);
    }

    // Winding: CCW when viewed from outside the tube (outward normals under
    // computeVertexNormals). Previous order was inverted — bare zones (bill /
    // legs, fl=0) use FrontSide undercoat only, so they vanished from outside.
    for (let i = 0; i < stations.length - 1; i += 1) {
      const a = ringStart[i];
      const b = ringStart[i + 1];
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        indices.push(a[j], b[j2], b[j]);
        indices.push(a[j], a[j2], b[j2]);
      }
    }

    // End caps: small triangle fans to a center point.
    const cap = (stationIdx, ringIdxs, flip) => {
      const st = stations[stationIdx];
      const prevSt = stations[Math.max(0, stationIdx - 1)];
      const nextSt = stations[Math.min(stations.length - 1, stationIdx + 1)];
      const sx = Number.isFinite(st.cx) ? st.cx : 0;
      _T.set(
        (Number.isFinite(nextSt.cx) ? nextSt.cx : 0) - (Number.isFinite(prevSt.cx) ? prevSt.cx : 0),
        nextSt.c[0] - prevSt.c[0],
        nextSt.c[1] - prevSt.c[1],
      ).normalize();
      if (_T.lengthSq() < 1e-12) _T.set(0, 0, 1);
      _P.set(sx, st.c[0], st.c[1]);
      const centerIdx = addVertex(
        _P,
        new THREE.Vector2(stationIdx === 0 ? 0 : 999, 0),
        st.bones,
        _T.clone().multiplyScalar(opts.groomSign ?? -1),
        st.fl ?? 0,
        st.zone ?? GOOSE_ZONE.plumage,
      );
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        // flip=true for end cap faces outward along +T; start cap faces −T.
        if (flip) indices.push(centerIdx, ringIdxs[j], ringIdxs[j2]);
        else indices.push(centerIdx, ringIdxs[j2], ringIdxs[j]);
      }
    };
    if (opts.capStart) cap(0, ringStart[0], false);
    if (opts.capEnd) cap(stations.length - 1, ringStart[ringStart.length - 1], true);

    return s;
  }

  // ==========================================================================
  // MAIN LOFT: tail stub → torso → breast (morphed horizontal↔upright)
  // ==========================================================================

  const NECK = morph.neckPath;
  const neckBones = (i) => {
    const names = [];
    if (i > 0) names.push([`neck_${i - 1}`, 0.25]);
    names.push([`neck_${i}`, 0.5]);
    if (i < 11) names.push([`neck_${i + 1}`, 0.25]);
    else names.push(['head', 0.25]);
    return names;
  };

  /** Canonical torso stations; centers remapped through morph. */
  const torsoCanon = [
    // --- tail stub / rump ---------------------------------------------------
    { c: [0.392, -0.302], hw: 0.020, ht: 0.017, hb: 0.014, fl: 0.008, zone: GOOSE_ZONE.tail, bones: [['tail_2', 1]] },
    { c: [0.396, -0.272], hw: 0.050, ht: 0.038, hb: 0.032, fl: 0.013, zone: GOOSE_ZONE.tail, bones: [['tail_1', 0.7], ['tail_2', 0.3]] },
    { c: [0.400, -0.242], hw: 0.080, ht: 0.060, hb: 0.055, fl: 0.022, bones: [['tail_0', 0.55], ['tail_1', 0.45]] },
    { c: [0.404, -0.200], hw: 0.106, ht: 0.088, hb: 0.086, fl: 0.025, bones: [['hips', 0.6], ['tail_0', 0.4]] },
    // --- torso ---------------------------------------------------------------
    { c: [0.406, -0.148], hw: 0.136, ht: 0.110, hb: 0.116, fl: 0.026, bones: [['hips', 0.85], ['spine_0', 0.15]] },
    { c: [0.407, -0.078], hw: 0.148, ht: 0.122, hb: 0.142, fl: 0.024, bones: [['hips', 0.5], ['spine_0', 0.5]] },
    { c: [0.406, 0.002], hw: 0.152, ht: 0.126, hb: 0.150, keel: 0.10, fl: 0.022, bones: [['spine_0', 0.6], ['spine_1', 0.4]] },
    { c: [0.408, 0.078], hw: 0.146, ht: 0.124, hb: 0.148, keel: 0.24, fl: 0.020, bones: [['spine_1', 0.7], ['spine_2', 0.3]] },
    { c: [0.414, 0.140], hw: 0.132, ht: 0.116, hb: 0.134, keel: 0.34, fl: 0.019, bones: [['spine_1', 0.3], ['spine_2', 0.6], ['keel', 0.1]] },
    { c: [0.420, 0.190], hw: 0.113, ht: 0.108, hb: 0.114, keel: 0.32, fl: 0.018, bones: [['spine_2', 0.75], ['spine_3', 0.25]] },
    { c: [0.428, 0.228], hw: 0.090, ht: 0.088, hb: 0.088, keel: 0.2, fl: 0.017, bones: [['spine_2', 0.6], ['spine_3', 0.4]] },
    { c: [0.436, 0.256], hw: 0.062, ht: 0.062, hb: 0.060, fl: 0.016, bones: [['spine_3', 0.7], ['spine_2', 0.3]] },
    { c: [0.443, 0.272], hw: 0.032, ht: 0.032, hb: 0.032, fl: 0.015, bones: [['spine_3', 1]] },
  ];
  // Upright birds: slightly deeper (more Y) and less long (fat already on hw).
  const uprightDeep = 1 + morph.bodyUpright * 0.12;
  /** @type {LoftStation[]} */
  const torsoStations = torsoCanon.map((st) => {
    const [y, z] = mapYZ(st.c[0], st.c[1]);
    return {
      ...st,
      c: [y, z],
      hw: st.hw * fat,
      ht: st.ht * fat * uprightDeep,
      hb: st.hb * fat * uprightDeep,
    };
  });
  loftPath(torsoStations, 32, { capStart: true, capEnd: true });

  // ==========================================================================
  // NECK TUBE → SKULL → BILL (styles + neck length from morph)
  // ==========================================================================
  const neckRadiusScale = THREE.MathUtils.lerp(1.15, 1.0, morph.neckLen);
  const headX = D.headCenterX ?? 0;
  const headY = D.headCenterY;
  const headZ = D.headCenterZ;
  const headHw = D.headHalfWidth;
  const bk = morph.beak;
  /** Normalize neck path entry to {x,y,z}. */
  const neckPt = (p) => {
    if (!p) return { x: 0, y: 0, z: 0 };
    if (p.length >= 3) return { x: p[0], y: p[1], z: p[2] };
    return { x: 0, y: p[0], z: p[1] };
  };

  // Neck–body join: bury a slim plug in the breast, then ramp into the cervical
  // tube. Kept body-weighted (spine_3) so flight neck poses don't balloon a
  // white lump at the collar (cervicals own the tube above this).
  const [rootY, rootZ] = mapYZ(0.430, 0.168);
  const n0 = neckPt(NECK[0]);
  const root2Y = NECK[0] ? THREE.MathUtils.lerp(rootY, n0.y, 0.55) : rootY;
  const root2Z = NECK[0] ? THREE.MathUtils.lerp(rootZ, n0.z, 0.55) : rootZ;
  const root2X = NECK[0] ? n0.x * 0.35 : 0;
  const root3Y = NECK[0] ? THREE.MathUtils.lerp(root2Y, n0.y, 0.7) : root2Y;
  const root3Z = NECK[0] ? THREE.MathUtils.lerp(root2Z, n0.z, 0.7) : root2Z;
  const root3X = NECK[0] ? n0.x * 0.7 : 0;

  /** @type {LoftStation[]} */
  const neckStations = [
    // Slim buried plug — body-colored, almost fully spine-weighted.
    { c: [rootY, rootZ], cx: 0, hw: 0.036 * fat, ht: 0.034 * fat, hb: 0.036 * fat, fl: 0.010, zone: GOOSE_ZONE.plumage, bones: [['spine_3', 0.85], ['spine_2', 0.15]] },
    { c: [root2Y, root2Z], cx: root2X, hw: 0.038 * fat, ht: 0.036 * fat, hb: 0.037 * fat, fl: 0.009, zone: GOOSE_ZONE.plumage, bones: [['spine_3', 0.8], ['neck_0', 0.2]] },
    // Soft handoff into the black stocking tube.
    { c: [root3Y, root3Z], cx: root3X, hw: 0.040 * fat, ht: 0.039 * fat, hb: 0.039 * fat, fl: 0.008, zone: GOOSE_ZONE.neck, bones: [['spine_3', 0.45], ['neck_0', 0.55]] },
    // --- neck: 12 cervical stations (black stocking zone) --------------------
    ...NECK.map((p, i) => {
      const pt = neckPt(p);
      const t = i / 11;
      // Slightly slimmer base rings; taper cleanly toward the head.
      const r = (0.040 - 0.012 * Math.min(1, t * 1.55) + 0.0016 * Math.max(0, t - 0.7) / 0.3)
        * neckRadiusScale * THREE.MathUtils.lerp(0.92, 1, fat);
      // Short necks: keep rings slightly fatter so the stump doesn't go wire-thin.
      const shortBoost = 1 + (1 - morph.neckLen) * 0.18 * (1 - t);
      // Early cervicals share weight with spine_3 so the join deforms smoothly
      // when the neck streams forward in flight.
      const baseBlend = i <= 2 ? (1 - i / 3) * 0.28 : 0;
      const bones = neckBones(i);
      if (baseBlend > 1e-3) {
        // Rebalance: pull a little weight onto spine_3 without dropping other bones.
        const scaled = bones.map(([n, w]) => /** @type {[string, number]} */ ([n, w * (1 - baseBlend)]));
        scaled.push(['spine_3', baseBlend]);
        return {
          c: [pt.y, pt.z + 0.006 * morph.neckLen],
          cx: pt.x,
          hw: r * shortBoost,
          ht: r * 1.04 * shortBoost,
          hb: r * shortBoost,
          fl: 0.007 - 0.0022 * t,
          zone: GOOSE_ZONE.neck,
          bones: scaled,
        };
      }
      return {
        c: [pt.y, pt.z + 0.006 * morph.neckLen],
        cx: pt.x,
        hw: r * shortBoost,
        ht: r * 1.04 * shortBoost,
        hb: r * shortBoost,
        fl: 0.007 - 0.0022 * t,
        zone: GOOSE_ZONE.neck,
        bones,
      };
    }),
    // --- skull (black head contour — still neck zone for stocking) -----------
    { c: [headY - 0.006, headZ - 0.011], cx: headX, hw: headHw * 1.04, ht: headHw * 1.17, hb: headHw * 1.02, fl: 0.0045, zone: GOOSE_ZONE.neck, bones: [['neck_11', 0.25], ['head', 0.75]] },
    { c: [headY, headZ + 0.013], cx: headX, hw: headHw * 1.08, ht: headHw * 1.14, hb: headHw * 1.04, fl: 0.004, zone: GOOSE_ZONE.neck, bones: [['head', 1]] },
    { c: [headY + 0.0015, headZ + 0.036], cx: headX, hw: headHw * 1.05, ht: headHw * 1.08, hb: headHw * 0.98, fl: 0.004, zone: GOOSE_ZONE.neck, bones: [['head', 1]] },
    { c: [headY - 0.001, headZ + 0.055], cx: headX, hw: headHw * 0.9, ht: headHw * 0.95, hb: headHw * 0.81, fl: 0.0038, zone: GOOSE_ZONE.neck, bones: [['head', 1]] },
    { c: [headY - 0.0045, headZ + 0.067], cx: headX, hw: headHw * 0.71, ht: headHw * 0.74, hb: headHw * 0.62, fl: 0.0034, zone: GOOSE_ZONE.neck, bones: [['head', 1]] },
    // --- bill (style-driven length / width / depth / hook + local xform) -----
    ...transformBillStations(
      buildBillStations(headY, headZ, D, bk).map((st) => ({ ...st, cx: headX })),
      { x: headX, y: D.billBaseY, z: D.billBaseZ },
      morph.beakXform,
    ),
  ];
  loftPath(neckStations, 32, { capStart: true, capEnd: true });

  // ==========================================================================
  // LOWER MANDIBLE + CHIN WEDGE
  // ==========================================================================
  const jawLen = bk.length;
  const jawW = bk.width;
  const jawD = bk.depth;
  const isHookJaw = bk.style === 'hook' || bk.hook > 0.5;
  const billPivot = { x: headX, y: D.billBaseY, z: D.billBaseZ };
  /** @type {LoftStation[]} */
  const jawStationsRaw = isHookJaw
    ? (() => {
      // Macaw/raptor lower mandible: short U-shaped spoon that stops well
      // before the upper tip so the hooked overhang reads clearly. Smooth
      // rounded cross-section (no tomium crease / "teeth").
      const jBaseY = D.billBaseY - 0.012;
      const jBaseZ = D.billBaseZ - 0.004;
      // Reach only ~52% of the upper bill's forward extent.
      const jLenZ = (D.billTipZ - D.billBaseZ) * 0.52 * Math.max(0.7, jawLen);
      const jTipY = jBaseY - 0.018;
      /** @type {Array<{ t: number, w: number, h: number, b: number }>} */
      const jSamp = [
        { t: 0.0, w: 1.15, h: 0.55, b: 0.85 },
        { t: 0.22, w: 1.05, h: 0.48, b: 0.78 },
        { t: 0.48, w: 0.82, h: 0.38, b: 0.62 },
        { t: 0.72, w: 0.52, h: 0.28, b: 0.42 },
        { t: 1.0, w: 0.22, h: 0.16, b: 0.22 },
      ];
      const jw0 = 0.022 * jawW;
      return jSamp.map((s, i) => {
        const t = s.t;
        // Slight downward scoop; no serration ridge.
        const y = lerp(jBaseY, jTipY, t) - 0.004 * t * t;
        const z = jBaseZ + jLenZ * t;
        return {
          c: [y, z],
          cx: headX,
          hw: jw0 * s.w,
          ht: jw0 * s.h * jawD * 0.55,
          hb: jw0 * s.b * jawD * 0.7,
          exp: 2.15,
          zone: GOOSE_ZONE.bill,
          fl: i === 0 ? 0.002 : 0,
          bones: i === 0
            ? [['head', 0.55], ['jaw', 0.45]]
            : i === 1
              ? [['jaw', 0.9], ['head', 0.1]]
              : [['jaw', 1]],
        };
      });
    })()
    : [
      { c: [D.billBaseY - 0.017, D.billBaseZ - 0.018], cx: headX, hw: 0.020 * jawW, ht: 0.007 * jawD, hb: 0.009 * jawD, fl: 0.0028, bones: [['head', 0.7], ['jaw', 0.3]] },
      { c: [D.billBaseY - 0.018, D.billBaseZ + 0.008 * jawLen], cx: headX, hw: 0.0185 * jawW, ht: 0.005 * jawD, hb: 0.0075 * jawD, zone: GOOSE_ZONE.bill, fl: 0, bones: [['jaw', 0.9], ['head', 0.1]] },
      { c: [lerp(D.billBaseY, D.billTipY, 0.45) - 0.01, lerp(D.billBaseZ, D.billTipZ, 0.45)], cx: headX, hw: 0.0155 * jawW, ht: 0.004 * jawD, hb: 0.0065 * jawD, exp: 2.6, zone: GOOSE_ZONE.bill, fl: 0, bones: [['jaw', 1]] },
      { c: [lerp(D.billBaseY, D.billTipY, 0.75) - 0.008 - bk.hook * 0.01, lerp(D.billBaseZ, D.billTipZ, 0.75)], cx: headX, hw: 0.0125 * jawW, ht: 0.0032 * jawD, hb: 0.0052 * jawD, exp: 2.6, zone: GOOSE_ZONE.bill, fl: 0, bones: [['jaw', 1]] },
      { c: [D.billTipY - 0.001 - bk.hook * 0.012, D.billTipZ - 0.01], cx: headX, hw: 0.0082 * jawW, ht: 0.0024 * jawD, hb: 0.0036 * jawD, zone: GOOSE_ZONE.bill, fl: 0, bones: [['jaw', 1]] },
    ];
  const jawStations = transformBillStations(jawStationsRaw, billPivot, morph.beakXform);
  loftPath(jawStations, isHookJaw ? 20 : 18, { capStart: true, capEnd: true });

  // ==========================================================================
  // EYES — style scales radius / placement (from morph.dims)
  // ==========================================================================
  // Pole axis along ±X (outward). Flipping the pole for the right eye inverts
  // the (φ,θ)→world Jacobian, so triangle winding must flip per side or the
  // left eye ends up with fully inverted normals (FrontSide culls it from
  // outside — invisible when that side faces the camera).
  function addEyeSphere(sideSign) {
    const worldL = D.eyeWorldL;
    const worldR = D.eyeWorldR;
    const useWorld = Array.isArray(worldL) && Array.isArray(worldR) && worldL.length >= 3;
    const cx = useWorld
      ? (sideSign > 0 ? worldL[0] : worldR[0])
      : sideSign * D.eyeX;
    const cy = useWorld
      ? (sideSign > 0 ? worldL[1] : worldR[1])
      : D.eyeY;
    const cz = useWorld
      ? (sideSign > 0 ? worldL[2] : worldR[2])
      : D.eyeZ;
    const r = D.eyeRadius;
    const rings = morph.eyeStyle === 'beady' ? 8 : 10;
    const segs = morph.eyeStyle === 'beady' ? 10 : 12;
    const bones = [[sideSign > 0 ? 'eye_L' : 'eye_R', 1]];
    const ringIdx = [];
    for (let i = 0; i <= rings; i += 1) {
      const phi = (i / rings) * Math.PI;
      const row = [];
      for (let j = 0; j < segs; j += 1) {
        const th = (j / segs) * Math.PI * 2;
        // Local sphere: outward pole at φ=0 along +sideSign·X from center.
        _P.set(
          cx + sideSign * Math.cos(phi) * r,
          cy + Math.sin(phi) * Math.sin(th) * r,
          cz + Math.sin(phi) * Math.cos(th) * r,
        );
        row.push(addVertex(
          _P,
          new THREE.Vector2(2.0 + phi, th),
          bones,
          new THREE.Vector3(sideSign, 0, 0), // temporary; recomputed
          0,
          GOOSE_ZONE.eye,
        ));
      }
      ringIdx.push(row);
    }
    for (let i = 0; i < rings; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        const a = ringIdx[i][j];
        const b = ringIdx[i + 1][j];
        const c = ringIdx[i + 1][j2];
        const d = ringIdx[i][j2];
        // sideSign > 0 (left/+X) needs reversed winding so normals point out.
        if (sideSign > 0) {
          indices.push(a, c, b);
          indices.push(a, d, c);
        } else {
          indices.push(a, b, c);
          indices.push(a, c, d);
        }
      }
    }
  }
  addEyeSphere(1);
  addEyeSphere(-1);

  // ==========================================================================
  // LEGS — feathered boot (thigh/shank) then bare tarsus down to the foot
  // ==========================================================================
  function addLeg(side) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.legX;
    /** Leg loft path is mostly vertical: stations as (y,z), ring frame reuses
     * loftPath but with lateral center offset applied afterwards — instead we
     * inline a simple vertical loft here with per-station x. */
    const stations = [
      // thigh + shank buried under the belly; short feathered boot below
      { x: x * 1.02, y: 0.360, z: -0.015, r: 0.048, fl: 0.020, zone: GOOSE_ZONE.plumage, bones: [['femur_' + side, 0.8], ['hips', 0.2]] },
      { x: x * 1.06, y: 0.300, z: 0.022, r: 0.037, fl: 0.017, zone: GOOSE_ZONE.plumage, bones: [['tibia_' + side, 0.7], ['femur_' + side, 0.3]] },
      { x: x * 1.02, y: 0.252, z: 0.008, r: 0.0245, fl: 0.012, zone: GOOSE_ZONE.plumage, bones: [['tibia_' + side, 0.9], ['Foot_' + side, 0.1]] },
      { x, y: 0.212, z: -0.001, r: 0.0142, fl: 0.005, zone: GOOSE_ZONE.plumage, bones: [['tibia_' + side, 0.55], ['Foot_' + side, 0.45]] },
      { x, y: 0.180, z: -0.004, r: 0.0105, fl: 0, zone: GOOSE_ZONE.leg, bones: [['Foot_' + side, 1]] },
      { x, y: 0.090, z: 0.002, r: 0.0092, fl: 0, zone: GOOSE_ZONE.leg, bones: [['Foot_' + side, 1]] },
      { x, y: 0.030, z: 0.008, r: 0.0100, fl: 0, zone: GOOSE_ZONE.leg, bones: [['Foot_' + side, 0.6], ['Toes_' + side, 0.4]] },
      { x, y: 0.014, z: 0.012, r: 0.0120, fl: 0, zone: GOOSE_ZONE.leg, bones: [['Toes_' + side, 1]] },
    ];
    const segs = 12;
    const ringIdx = [];
    for (let i = 0; i < stations.length; i += 1) {
      const st = stations[i];
      const prevSt = stations[Math.max(0, i - 1)];
      const nextSt = stations[Math.min(stations.length - 1, i + 1)];
      _T.set(nextSt.x - prevSt.x, nextSt.y - prevSt.y, nextSt.z - prevSt.z).normalize();
      // Ring frame: R along world X-ish, U = T×R
      _U.crossVectors(_T, _R);
      if (_U.lengthSq() < 1e-8) _U.set(0, 0, 1);
      _U.normalize();
      const Rv = new THREE.Vector3().crossVectors(_U, _T).normalize();
      const row = [];
      for (let j = 0; j < segs; j += 1) {
        const th = (j / segs) * Math.PI * 2;
        _P.set(st.x, st.y, st.z)
          .addScaledVector(Rv, Math.cos(th) * st.r)
          .addScaledVector(_U, Math.sin(th) * st.r);
        row.push(addVertex(
          _P,
          new THREE.Vector2(4.0 + st.y, th * st.r),
          st.bones,
          new THREE.Vector3(0, -1, 0),
          st.fl,
          st.zone,
        ));
      }
      ringIdx.push(row);
    }
    for (let i = 0; i < stations.length - 1; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        // Outward winding (matches body loftPath).
        indices.push(ringIdx[i][j], ringIdx[i + 1][j2], ringIdx[i + 1][j]);
        indices.push(ringIdx[i][j], ringIdx[i][j2], ringIdx[i + 1][j2]);
      }
    }
  }
  addLeg('L');
  addLeg('R');

  // ==========================================================================
  // FEET — web / perch / talon / zygodactyl (morph.foot)
  // ==========================================================================
  function addFoot(side) {
    const s = side === 'L' ? 1 : -1;
    const x = s * GOOSE_DIMS.legX;
    const ft = morph.foot;
    const ball = new THREE.Vector3(x, GOOSE_DIMS.footBallY, GOOSE_DIMS.footBallZ);
    const tipZ = GOOSE_DIMS.toeTipZ * ft.toeLen;
    const spread = ft.toeSpread;
    const arch = 0.004 + ft.arch * 0.008;
    const clawLen = 0.004 + ft.claw * 0.014;
    const clawR = 0.0014 + ft.claw * 0.0022;

    /** @type {Array<{ bone: string, tip: THREE.Vector3, r: number }>} */
    let toes;
    if (ft.zygodactyl) {
      toes = [
        { bone: `toe_in_${side}`, tip: new THREE.Vector3(x - s * 0.038 * spread, 0.005, tipZ * 0.78), r: 0.0064 },
        { bone: `Toes_tip_${side}`, tip: new THREE.Vector3(x + s * 0.012 * spread, 0.005, tipZ), r: 0.0074 },
        { bone: `toe_out_${side}`, tip: new THREE.Vector3(x + s * 0.045 * spread, 0.007, -0.04 * ft.toeLen), r: 0.0066 },
      ];
    } else {
      toes = [
        { bone: `toe_in_${side}`, tip: new THREE.Vector3(x - s * 0.042 * spread, 0.005, tipZ * 0.76), r: 0.0068 },
        { bone: `Toes_tip_${side}`, tip: new THREE.Vector3(x, 0.005, tipZ), r: 0.008 },
        { bone: `toe_out_${side}`, tip: new THREE.Vector3(x + s * 0.05 * spread, 0.005, tipZ * 0.72), r: 0.0072 },
      ];
    }

    const toeSpines = [];
    for (const toe of toes) {
      const segsAlong = 5;
      const segs = 8;
      const ringIdx = [];
      const spine = [];
      for (let i = 0; i <= segsAlong; i += 1) {
        const t = i / segsAlong;
        _P.copy(ball).lerp(toe.tip, t);
        _P.y += Math.sin(t * Math.PI) * arch;
        spine.push(_P.clone());
        const r = THREE.MathUtils.lerp(toe.r, toe.r * (ft.claw > 0.9 ? 0.28 : 0.35), t);
        _T.copy(toe.tip).sub(ball).normalize();
        if (_T.lengthSq() < 1e-8) _T.set(0, 0, 1);
        _U.set(0, 1, 0);
        const Rv = new THREE.Vector3().crossVectors(_U, _T).normalize();
        const row = [];
        for (let j = 0; j < segs; j += 1) {
          const th = (j / segs) * Math.PI * 2;
          const q = _P.clone()
            .addScaledVector(Rv, Math.cos(th) * r)
            .addScaledVector(_U, Math.sin(th) * r * 0.82);
          row.push(addVertex(
            q,
            new THREE.Vector2(6.0 + t, th * r),
            [[toe.bone, Math.min(1, t + 0.35)], [`Toes_${side}`, Math.max(0, 0.65 - t)]],
            new THREE.Vector3(0, 0, 1),
            0,
            GOOSE_ZONE.leg,
          ));
        }
        ringIdx.push(row);
      }
      for (let i = 0; i < segsAlong; i += 1) {
        for (let j = 0; j < segs; j += 1) {
          const j2 = (j + 1) % segs;
          indices.push(ringIdx[i][j], ringIdx[i + 1][j], ringIdx[i + 1][j2]);
          indices.push(ringIdx[i][j], ringIdx[i + 1][j2], ringIdx[i][j2]);
        }
      }
      // Claw: longer/sharper for talon, small nub for webbed.
      const clawDir = toe.tip.clone().sub(ball).normalize();
      if (clawDir.lengthSq() < 1e-8) clawDir.set(0, -0.2, 1).normalize();
      const clawTip = toe.tip.clone().addScaledVector(clawDir, clawLen).add(new THREE.Vector3(0, -0.002 * ft.claw, 0));
      const clawSegs = 6;
      const clawRings = [];
      for (let i = 0; i <= 2; i += 1) {
        const t = i / 2;
        _P.copy(toe.tip).lerp(clawTip, t);
        const r = THREE.MathUtils.lerp(clawR * 1.6, clawR * 0.25, t);
        const row = [];
        for (let j = 0; j < clawSegs; j += 1) {
          const th = (j / clawSegs) * Math.PI * 2;
          const q = _P.clone().add(new THREE.Vector3(
            Math.cos(th) * r,
            Math.sin(th) * r * 0.7,
            0,
          ));
          row.push(addVertex(q, new THREE.Vector2(6.9, th), [[toe.bone, 1]], clawDir, 0, GOOSE_ZONE.leg));
        }
        clawRings.push(row);
      }
      for (let i = 0; i < 2; i += 1) {
        for (let j = 0; j < clawSegs; j += 1) {
          const j2 = (j + 1) % clawSegs;
          indices.push(clawRings[i][j], clawRings[i + 1][j], clawRings[i + 1][j2]);
          indices.push(clawRings[i][j], clawRings[i + 1][j2], clawRings[i][j2]);
        }
      }
      toeSpines.push({ spine, bone: toe.bone });
    }

    // Interdigital membranes only for webbed feet.
    if (ft.web) {
      for (let pair = 0; pair < 2; pair += 1) {
        const A = toeSpines[pair];
        const B = toeSpines[pair + 1];
        const rows = 4;
        const cols = 5;
        const grid = [];
        for (let i = 0; i <= rows; i += 1) {
          const ti = 0.15 + (i / rows) * 0.8;
          const pa = A.spine[Math.round(ti * (A.spine.length - 1))];
          const pb = B.spine[Math.round(ti * (B.spine.length - 1))];
          const row = [];
          for (let j = 0; j <= cols; j += 1) {
            const tj = j / cols;
            _P.copy(pa).lerp(pb, tj);
            const sag = Math.sin(tj * Math.PI) * (0.0035 + 0.004 * (1 - ti));
            _P.y = Math.max(0.0035, _P.y - sag);
            _P.z -= Math.sin(tj * Math.PI) * 0.012 * (1 - ti * 0.4);
            const wA = 1 - tj;
            row.push(addVertex(
              _P,
              new THREE.Vector2(7.0 + ti, tj * 0.05),
              [[A.bone, wA * 0.9], [B.bone, (1 - wA) * 0.9], [`Toes_${side}`, 0.1]],
              new THREE.Vector3(0, 0, 1),
              0,
              GOOSE_ZONE.leg,
            ));
          }
          grid.push(row);
        }
        for (let i = 0; i < rows; i += 1) {
          for (let j = 0; j < cols; j += 1) {
            const a = grid[i][j];
            const b = grid[i + 1][j];
            const c = grid[i + 1][j + 1];
            const d = grid[i][j + 1];
            indices.push(a, b, c, a, c, d);
            indices.push(a, c, b, a, d, c);
          }
        }
      }
    }

    // Hallux — longer/stronger for talon & zygodactyl.
    {
      const hx = x;
      const base = new THREE.Vector3(hx, 0.02, -0.008);
      const tip = ft.zygodactyl
        ? new THREE.Vector3(hx - s * 0.01, 0.01, -0.045 * ft.halluxLen)
        : new THREE.Vector3(hx - s * 0.006, 0.008, -0.034 * ft.halluxLen);
      const segs = 6;
      const rings = [];
      for (let i = 0; i <= 2; i += 1) {
        const t = i / 2;
        _P.copy(base).lerp(tip, t);
        const r = THREE.MathUtils.lerp(0.005 * (0.9 + ft.claw * 0.25), 0.0018, t);
        const row = [];
        for (let j = 0; j < segs; j += 1) {
          const th = (j / segs) * Math.PI * 2;
          const q = _P.clone().add(new THREE.Vector3(Math.cos(th) * r, Math.sin(th) * r * 0.8, 0));
          row.push(addVertex(
            q,
            new THREE.Vector2(7.9, th * r),
            [[`hallux_${side}`, 1]],
            new THREE.Vector3(0, 0, -1),
            0,
            GOOSE_ZONE.leg,
          ));
        }
        rings.push(row);
      }
      for (let i = 0; i < 2; i += 1) {
        for (let j = 0; j < segs; j += 1) {
          const j2 = (j + 1) % segs;
          indices.push(rings[i][j], rings[i + 1][j], rings[i + 1][j2]);
          indices.push(rings[i][j], rings[i + 1][j2], rings[i][j2]);
        }
      }
      // Hallux claw
      if (ft.claw > 0.5) {
        const clawTip = tip.clone().add(new THREE.Vector3(0, -0.003, -clawLen * 0.7));
        const capIdx = addVertex(clawTip, new THREE.Vector2(8.0, 0), [[`hallux_${side}`, 1]], new THREE.Vector3(0, 0, -1), 0, GOOSE_ZONE.leg);
        const last = rings[rings.length - 1];
        for (let j = 0; j < segs; j += 1) {
          indices.push(capIdx, last[j], last[(j + 1) % segs]);
        }
      }
    }
  }
  addFoot('L');
  addFoot('R');

  // ==========================================================================
  // FOLDED WING ENVELOPES — flattened lofts hugging the body sides
  // ==========================================================================
  function addWingEnvelope(side) {
    const s = side === 'L' ? 1 : -1;
    // Proximal shoulder/covert pad only — stops before the hand.
    // Distal remiges are the flight-feather cards; skinning the body envelope
    // out to wing_tip accordion-stretched into a broken wing on open poses.
    // Lower fl so shell layers don't read as corrugated paper when flexed.
    const wingCanon = [
      { y: 0.464, z: 0.130, x: 0.078, chord: 0.055, thick: 0.010, tilt: 0.22, bones: [[`shoulder_${side}`, 0.85], ['spine_2', 0.15]], fl: 0.008 },
      { y: 0.462, z: 0.055, x: 0.110, chord: 0.100, thick: 0.012, tilt: 0.28, bones: [[`shoulder_${side}`, 0.55], [`wing_0_${side}`, 0.45]], fl: 0.010 },
      { y: 0.456, z: -0.030, x: 0.118, chord: 0.112, thick: 0.011, tilt: 0.30, bones: [[`wing_0_${side}`, 0.7], [`shoulder_${side}`, 0.3]], fl: 0.010 },
      { y: 0.450, z: -0.100, x: 0.108, chord: 0.095, thick: 0.010, tilt: 0.32, bones: [[`wing_0_${side}`, 0.55], [`wing_1_${side}`, 0.45]], fl: 0.009 },
      { y: 0.444, z: -0.165, x: 0.090, chord: 0.070, thick: 0.008, tilt: 0.34, bones: [[`wing_1_${side}`, 0.85], [`wing_0_${side}`, 0.15]], fl: 0.007 },
    ];
    const stations = wingCanon.map((st) => {
      const [y, z] = mapYZ(st.y, st.z);
      return {
        p: new THREE.Vector3(s * st.x * fat, y, z),
        chord: st.chord * fat,
        thick: st.thick,
        tilt: st.tilt,
        bones: st.bones,
        fl: st.fl,
      };
    });
    const segs = 14;
    const rows = [];
    for (let i = 0; i < stations.length; i += 1) {
      const st = stations[i];
      const prev = stations[Math.max(0, i - 1)];
      const next = stations[Math.min(stations.length - 1, i + 1)];
      _T.copy(next.p).sub(prev.p).normalize();
      // Section frame: chordDir points down-flank (outward+down), thickDir out.
      const out = new THREE.Vector3(s, 0, 0);
      const down = new THREE.Vector3(0, -1, 0);
      const chordDir = down.clone().addScaledVector(out, st.tilt).normalize();
      const thickDir = new THREE.Vector3().crossVectors(_T, chordDir).normalize().multiplyScalar(s > 0 ? 1 : 1);
      const row = [];
      for (let j = 0; j < segs; j += 1) {
        const th = (j / segs) * Math.PI * 2;
        // flattened ellipse: chord along chordDir, thin along thickDir
        const q = st.p.clone()
          .addScaledVector(chordDir, Math.sin(th) * st.chord * 0.5)
          .addScaledVector(thickDir, Math.cos(th) * st.thick * 0.5);
        row.push(addVertex(
          q,
          new THREE.Vector2(9.0 + (i * 0.11), (j / segs) * (st.chord * 2)),
          st.bones,
          _T.clone().negate(),
          st.fl,
          GOOSE_ZONE.wing,
        ));
      }
      rows.push(row);
    }
    for (let i = 0; i < stations.length - 1; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        if (s > 0) {
          indices.push(rows[i][j], rows[i + 1][j], rows[i + 1][j2]);
          indices.push(rows[i][j], rows[i + 1][j2], rows[i][j2]);
        } else {
          indices.push(rows[i][j], rows[i + 1][j2], rows[i + 1][j]);
          indices.push(rows[i][j], rows[i][j2], rows[i + 1][j2]);
        }
      }
    }
    // caps
    const capA = addVertex(stations[0].p.clone(), new THREE.Vector2(9.0, 0), stations[0].bones, new THREE.Vector3(0, 0, -1), stations[0].fl, GOOSE_ZONE.wing);
    const capB = addVertex(stations[stations.length - 1].p.clone(), new THREE.Vector2(9.9, 0), stations[stations.length - 1].bones, new THREE.Vector3(0, 0, -1), 0.006, GOOSE_ZONE.wing);
    for (let j = 0; j < segs; j += 1) {
      const j2 = (j + 1) % segs;
      if (s > 0) {
        indices.push(capA, rows[0][j2], rows[0][j]);
        indices.push(capB, rows[rows.length - 1][j], rows[rows.length - 1][j2]);
      } else {
        indices.push(capA, rows[0][j], rows[0][j2]);
        indices.push(capB, rows[rows.length - 1][j2], rows[rows.length - 1][j]);
      }
    }
  }
  addWingEnvelope('L');
  addWingEnvelope('R');

  // ==========================================================================
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  // NOTE: no separate restPosition attribute — geometry is authored in bind
  // space, so TSL positionGeometry IS the rest position. WebGPU caps vertex
  // buffers at 8 and this geometry uses all of them:
  // position/normal/uv/skinIndex/skinWeight/featherLen/groomDir/zoneId.
  geometry.setAttribute('featherLen', new THREE.Float32BufferAttribute(featherLens, 1));
  geometry.setAttribute('groomDir', new THREE.Float32BufferAttribute(groomDirs, 3));
  geometry.setAttribute('zoneId', new THREE.Float32BufferAttribute(zoneIds, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
