/**
 * Horse v2 body geometry — one skinned BufferGeometry generated at boot.
 *
 * Core trick (shared with the goose/cat): a SINGLE ring-loft runs tail stub →
 * hindquarters → barrel → chest → up the neck → over the poll → down the long
 * nasal line → nose. The loft path lives in the YZ plane so ring frames never
 * twist and the surface is seam-free from rump to nose. That parameterization
 * yields coatUV (s = arc length, t = arc around the ring) and groomDir =
 * -tangent (hair lays head → tail everywhere), i.e. one continuous flow field
 * following the muscle contours.
 *
 * Merged extras: a mandible/cheek loft closing the underside of the head, four
 * leg lofts with proper hooves (wall + sole + toe-forward), a crest mane
 * volume + forelock, a tail dock + hanging hair volume, ear pinnae, and
 * lateral sclera eye spheres (iris painted in-shader).
 *
 * Baked vertex attributes (consumed by horseCoatMaterial TSL). Exactly 8
 * buffers — the WebGPU per-vertex cap — so there is NO separate restPosition
 * attribute: geometry is authored in bind space, so TSL positionGeometry IS
 * rest position.
 *   position / normal / uv(coatUV) / skinIndex / skinWeight
 *   furLen   float — shell height in meters (0 on hoof/eye/nose leather)
 *   groomDir vec3  — hair lay direction in bind space
 *   zoneId   float — HORSE_ZONE region gate
 */

import * as THREE from 'three';
import { HORSE_DIMS, HORSE_BONE_DEFS } from './horseSkeleton.js';

export const HORSE_ZONE = Object.freeze({
  coat: 0,     // body / neck / head contour coat (short shells)
  hoof: 1,     // keratin hoof wall + sole — bare
  eye: 2,      // sclera sphere — bare, wet
  nose: 3,     // muzzle leather (nostril rim / lips) — near-bare, soft
  mane: 4,     // crest mane + forelock (long hair)
  tail: 5,     // tail hair mass (long hair)
  ear: 6,      // pinna (short fur, bare rim)
});

const D = HORSE_DIMS;

export function buildHorseBodyGeometry(boneIndex) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const skinIndices = [];
  const skinWeights = [];
  const furLens = [];
  const groomDirs = [];
  const zoneIds = [];
  const indices = [];

  const bi = (name) => {
    const idx = boneIndex.get(name);
    if (idx == null) throw new Error(`horse geometry: unknown bone ${name}`);
    return idx;
  };

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
    furLens.push(fl);
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
   * Ring-loft along a station list whose centers are (y,z) in the YZ plane.
   * @param {Array<{c:[number,number],hw:number,ht:number,hb:number,keel?:number,exp?:number,zone?:number,fl?:number,xOff?:number,bones:Array<[string,number]>}>} stations
   * @param {number} segs
   * @param {{capStart?:boolean,capEnd?:boolean,sOffset?:number,groomSign?:number}} [opts]
   */
  function loftPath(stations, segs, opts = {}) {
    const groomSign = opts.groomSign ?? -1; // hair lays toward the tail
    const ringStart = [];
    let s = opts.sOffset ?? 0;

    for (let i = 0; i < stations.length; i += 1) {
      const st = stations[i];
      const prevSt = stations[Math.max(0, i - 1)];
      const nextSt = stations[Math.min(stations.length - 1, i + 1)];
      _T.set(0, nextSt.c[0] - prevSt.c[0], nextSt.c[1] - prevSt.c[1]);
      if (_T.lengthSq() < 1e-12) _T.set(0, 0, 1);
      _T.normalize();
      _U.crossVectors(_T, _R).normalize();
      if (i > 0) s += Math.hypot(st.c[0] - prevSt.c[0], st.c[1] - prevSt.c[1]);

      const zone = st.zone ?? HORSE_ZONE.coat;
      const fl = st.fl ?? 0.009;
      const exp = st.exp ?? 2;
      const ringIdx = [];
      const circumference = Math.PI * (st.hw + (st.ht + st.hb) * 0.5);

      for (let j = 0; j < segs; j += 1) {
        const theta = (j / segs) * Math.PI * 2;
        let cx = Math.cos(theta);
        let cy = Math.sin(theta);
        if (exp !== 2) {
          const n = 2 / exp;
          cx = Math.sign(cx) * Math.abs(cx) ** n;
          cy = Math.sign(cy) * Math.abs(cy) ** n;
        }
        const px = cx * st.hw;
        let py = cy > 0 ? cy * st.ht : cy * st.hb;
        // Breast keel: narrow + drop the underside toward a pectoral V.
        let pxAdj = px;
        if (st.keel && cy < 0) {
          const kb = st.keel * Math.pow(-cy, 1.5);
          pxAdj *= 1 - kb * 0.4;
          py *= 1 + st.keel * 0.10 * -cy;
        }
        _P.set(pxAdj + (st.xOff ?? 0), st.c[0], st.c[1]).addScaledVector(_U, py);
        _G.copy(_T).multiplyScalar(groomSign);
        const uv = new THREE.Vector2(s, (j / segs) * circumference);
        ringIdx.push(addVertex(_P, uv, st.bones, _G.clone(), fl, zone));
      }
      ringStart.push(ringIdx);
    }

    for (let i = 0; i < stations.length - 1; i += 1) {
      const a = ringStart[i];
      const b = ringStart[i + 1];
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        indices.push(a[j], b[j], b[j2]);
        indices.push(a[j], b[j2], a[j2]);
      }
    }

    const cap = (stationIdx, ringIdxs, flip) => {
      const st = stations[stationIdx];
      _P.set(st.xOff ?? 0, st.c[0], st.c[1]);
      const centerIdx = addVertex(
        _P,
        new THREE.Vector2(stationIdx === 0 ? 0 : 999, 0),
        st.bones,
        _G.set(0, 0, groomSign),
        st.fl ?? 0,
        st.zone ?? HORSE_ZONE.coat,
      );
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        if (flip) indices.push(centerIdx, ringIdxs[j2], ringIdxs[j]);
        else indices.push(centerIdx, ringIdxs[j], ringIdxs[j2]);
      }
    };
    if (opts.capStart) cap(0, ringStart[0], false);
    if (opts.capEnd) cap(stations.length - 1, ringStart[ringStart.length - 1], true);

    return s;
  }

  // ==========================================================================
  // MAIN LOFT: tail stub → hindquarters → barrel → chest → neck → skull → nose
  // Muscular masses (croup, barrel spring, shoulder, gaskin) are shaped by the
  // per-station widths measured off the profile board.
  // ==========================================================================
  /** @type {Array<any>} */
  const bodyStations = [
    // --- tail stub / point of buttock ---------------------------------------
    { c: [1.44, -0.84], hw: 0.085, ht: 0.075, hb: 0.085, fl: 0.012, zone: HORSE_ZONE.coat, bones: [['tail_0', 0.6], ['hips', 0.4]] },
    { c: [1.40, -0.74], hw: 0.20, ht: 0.115, hb: 0.24, fl: 0.010, bones: [['hips', 0.8], ['tail_0', 0.2]] },
    // --- croup / hindquarters (round, muscular — quarters are the widest mass)
    { c: [1.37, -0.56], hw: 0.335, ht: 0.150, hb: 0.42, fl: 0.009, bones: [['hips', 0.7], ['pelvis_L', 0.15], ['pelvis_R', 0.15]] },
    { c: [1.34, -0.38], hw: 0.340, ht: 0.140, hb: 0.445, fl: 0.009, bones: [['hips', 0.5], ['spine_0', 0.3], ['flank_L', 0.1], ['flank_R', 0.1]] },
    // --- loin / barrel (deep, sprung ribs, belly tucks slightly up front) ----
    { c: [1.32, -0.20], hw: 0.325, ht: 0.125, hb: 0.45, fl: 0.009, bones: [['spine_1', 0.6], ['spine_2', 0.25], ['belly', 0.15]] },
    { c: [1.31, -0.02], hw: 0.33, ht: 0.12, hb: 0.455, fl: 0.009, bones: [['spine_3', 0.55], ['belly', 0.2], ['rib_L_1', 0.125], ['rib_R_1', 0.125]] },
    { c: [1.31, 0.14], hw: 0.325, ht: 0.125, hb: 0.44, keel: 0.10, fl: 0.009, bones: [['spine_4', 0.5], ['chest', 0.25], ['rib_L_3', 0.125], ['rib_R_3', 0.125]] },
    // --- girth / shoulder mass ----------------------------------------------
    { c: [1.34, 0.28], hw: 0.30, ht: 0.15, hb: 0.42, keel: 0.16, fl: 0.009, bones: [['spine_6', 0.45], ['chest', 0.25], ['shoulder_L', 0.15], ['shoulder_R', 0.15]] },
    { c: [1.39, 0.40], hw: 0.26, ht: 0.16, hb: 0.37, keel: 0.24, fl: 0.009, bones: [['spine_7', 0.45], ['shoulder_L', 0.2], ['shoulder_R', 0.2], ['breast', 0.15]] },
    // --- withers / breast ----------------------------------------------------
    { c: [1.45, 0.50], hw: 0.195, ht: 0.155, hb: 0.32, keel: 0.30, fl: 0.010, bones: [['spine_9', 0.5], ['breast', 0.3], ['spine_8', 0.2]] },
    // --- neck: long, deep at the base, tapering to the throatlatch -----------
    { c: [1.53, 0.61], hw: 0.15, ht: 0.135, hb: 0.245, fl: 0.010, bones: [['neck_0', 0.7], ['spine_9', 0.3]] },
    { c: [1.62, 0.74], hw: 0.132, ht: 0.13, hb: 0.20, fl: 0.010, bones: [['neck_1', 0.65], ['neck_2', 0.25], ['throat', 0.1]] },
    { c: [1.71, 0.86], hw: 0.118, ht: 0.125, hb: 0.168, fl: 0.010, bones: [['neck_3', 0.7], ['neck_2', 0.3]] },
    { c: [1.80, 0.97], hw: 0.105, ht: 0.115, hb: 0.138, fl: 0.010, bones: [['neck_4', 0.7], ['neck_5', 0.3]] },
    { c: [1.87, 1.06], hw: 0.096, ht: 0.105, hb: 0.115, fl: 0.009, bones: [['neck_5', 0.6], ['neck_6', 0.4]] },
    // --- poll / skull --------------------------------------------------------
    { c: [1.905, 1.16], hw: 0.099, ht: 0.09, hb: 0.118, fl: 0.007, bones: [['neck_6', 0.4], ['head', 0.6]] },
    // --- forehead / brow (eyes sit on this ring's side wall). DEEP hb: the
    //     underside of these face rings IS the cheek/jowl + jaw line, so no
    //     separate mandible tube pokes out below the head. ---------------------
    { c: [1.845, 1.28], hw: 0.104, ht: 0.072, hb: 0.165, fl: 0.006, bones: [['head', 0.7], ['brow_L', 0.06], ['brow_R', 0.06], ['cheek_L', 0.09], ['cheek_R', 0.09]] },
    // --- long nasal line (the defining rectangular equine face) --------------
    { c: [1.75, 1.355], hw: 0.086, ht: 0.06, hb: 0.175, fl: 0.006, bones: [['head', 0.55], ['cheek_L', 0.1], ['cheek_R', 0.1], ['jaw', 0.25]] },
    { c: [1.66, 1.41], hw: 0.072, ht: 0.055, hb: 0.145, fl: 0.005, bones: [['head', 0.3], ['muzzle', 0.45], ['jaw', 0.25]] },
    // --- muzzle (soft, rounded, nostrils flare off the sides) ----------------
    { c: [1.565, 1.465], hw: 0.062, ht: 0.052, hb: 0.095, fl: 0.004, bones: [['muzzle', 0.7], ['noseTip', 0.15], ['jaw', 0.15]] },
    { c: [1.50, 1.505], hw: 0.056, ht: 0.048, hb: 0.055, exp: 2.2, zone: HORSE_ZONE.nose, fl: 0.002, bones: [['muzzle', 0.35], ['noseTip', 0.5], ['nostril_L', 0.075], ['nostril_R', 0.075]] },
    // --- upper lip -----------------------------------------------------------
    { c: [1.462, 1.53], hw: 0.042, ht: 0.032, hb: 0.036, exp: 2.2, zone: HORSE_ZONE.nose, fl: 0, bones: [['noseTip', 0.5], ['lip_upper', 0.5]] },
  ];
  loftPath(bodyStations, 32, { capStart: true, capEnd: true });

  // ==========================================================================
  // CHIN / LOWER-LIP LOFT — a small wedge tucked under the deepened face rings
  // (the jowl itself lives on the main loft's hb) so a jaw gape still reads.
  // ==========================================================================
  const jawStations = [
    // start buried inside the face underside so the cap never shows
    { c: [1.64, 1.26], hw: 0.046, ht: 0.018, hb: 0.024, fl: 0.005, bones: [['jaw', 0.8], ['chin', 0.2]] },
    { c: [1.53, 1.40], hw: 0.044, ht: 0.020, hb: 0.026, fl: 0.004, bones: [['chin', 0.7], ['jaw', 0.3]] },
    { c: [1.478, 1.475], hw: 0.036, ht: 0.018, hb: 0.020, zone: HORSE_ZONE.nose, fl: 0.001, bones: [['chin', 0.5], ['lip_lower', 0.5]] },
    { c: [1.455, 1.515], hw: 0.028, ht: 0.013, hb: 0.013, zone: HORSE_ZONE.nose, fl: 0, bones: [['lip_lower', 1]] },
  ];
  loftPath(jawStations, 16, { capStart: true, capEnd: true });

  // ==========================================================================
  // EARS — cupped pointed pinnae (double-sided grids, like the cat's but
  // taller/narrower, curving slightly outward)
  // ==========================================================================
  function addEar(side) {
    const s = side === 'L' ? 1 : -1;
    const base = new THREE.Vector3(s * D.earBaseX, D.earBaseY, D.earBaseZ);
    const tip = new THREE.Vector3(s * D.earTipX, D.earTipY, D.earTipZ);
    const b0 = `ear_${side}_0`;
    const b1 = `ear_${side}_1`;
    const rows = 6;
    const cols = 5;
    const grid = [];
    const halfBase = 0.042;
    const fwd = new THREE.Vector3(0, 0.15, 1).normalize(); // cup opens up-forward
    const side3 = new THREE.Vector3(1, 0, 0);
    for (let i = 0; i <= rows; i += 1) {
      const t = i / rows;
      const center = base.clone().lerp(tip, t);
      // pointed tip: width collapses faster near the top
      const halfW = halfBase * (1 - t) * (1 - t * 0.35);
      const row = [];
      for (let j = 0; j <= cols; j += 1) {
        const u = (j / cols) * 2 - 1;
        const p = center.clone().addScaledVector(side3, u * halfW * s);
        const cup = (1 - u * u) * (0.014 * (1 - t));
        p.addScaledVector(fwd, cup);
        const w0 = 1 - t;
        row.push(addVertex(
          p,
          new THREE.Vector2(10.0 + t, (u * 0.5 + 0.5) * 0.08),
          [[b1, t * 0.85 + 0.05], [b0, w0 * 0.9 + 0.05], ['head', 0.1 * (1 - t)]],
          tip.clone().sub(base).normalize(),
          i === rows ? 0.002 : 0.005,
          HORSE_ZONE.ear,
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
        indices.push(a, c, b, a, d, c); // double-sided pinna
      }
    }
  }
  addEar('L');
  addEar('R');

  // ==========================================================================
  // EYES — prominent lateral sclera spheres seated on the side wall of the
  // skull (equine eyes protrude — unlike the cat, real geometry reads best).
  // The iris/pupil is painted in-shader on the outward hemisphere; blinking
  // flattens the eye bone's y-scale under shader-darkened lids.
  // ==========================================================================
  function addEyeSphere(sideSign) {
    const cx = sideSign * D.eyeX;
    const r = D.eyeRadius;
    const rings = 9;
    const segs = 12;
    const bones = [[sideSign > 0 ? 'eye_L' : 'eye_R', 1]];
    const ringIdx = [];
    for (let i = 0; i <= rings; i += 1) {
      const phi = (i / rings) * Math.PI;       // 0..pi from +Y pole
      const row = [];
      for (let j = 0; j < segs; j += 1) {
        const th = (j / segs) * Math.PI * 2;
        const sinP = Math.sin(phi);
        _P.set(
          cx + sinP * Math.cos(th) * r * 0.78 * sideSign, // bedded into the socket
          D.eyeY + Math.cos(phi) * r,
          D.eyeZ + sinP * Math.sin(th) * r,
        );
        row.push(addVertex(
          _P,
          new THREE.Vector2(2.0 + phi, th),
          bones,
          new THREE.Vector3(sideSign, 0, 0),
          0,
          HORSE_ZONE.eye,
        ));
      }
      ringIdx.push(row);
    }
    for (let i = 0; i < rings; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        indices.push(ringIdx[i][j], ringIdx[i + 1][j], ringIdx[i + 1][j2]);
        indices.push(ringIdx[i][j], ringIdx[i + 1][j2], ringIdx[i][j2]);
      }
    }
  }
  addEyeSphere(1);
  addEyeSphere(-1);

  // ==========================================================================
  // MANE — a thin crest volume hanging down the RIGHT side of the neck (as on
  // the reference board): rings are tall, narrow ellipses whose long axis
  // drops below the crest line. Long furLen turns the shells into hair.
  // Forelock: a small tuft falling between the ears onto the forehead.
  // ==========================================================================
  function addMane() {
    const crest = HORSE_BONE_DEFS
      .filter(([name]) => name.startsWith('mane_'))
      .map(([name, , pos]) => ({ name, p: new THREE.Vector3(...pos) }));
    const segs = 10;
    const rings = [];
    for (let i = 0; i < crest.length; i += 1) {
      const node = crest[i];
      const t = i / (crest.length - 1);
      // hang length: longest mid-neck, shorter at withers + poll
      const hang = 0.16 + Math.sin(t * Math.PI) * 0.12;
      const row = [];
      for (let j = 0; j < segs; j += 1) {
        const a = (j / segs) * Math.PI * 2;
        // Curtain ring: starts ON the crest ridge and drapes down the LEFT
        // (+x, camera-facing) side of the neck, clear of the neck surface —
        // the reference board carries the mane on that side.
        const px = Math.cos(a) * 0.02 + 0.045;
        const py = Math.sin(a) * hang * 0.5 - hang * 0.42;
        _P.set(node.p.x + px, node.p.y + py, node.p.z + Math.sin(a) * 0.022);
        row.push(addVertex(
          _P,
          new THREE.Vector2(16.0 + t, a * 0.05),
          [[node.name, 0.85], [crest[Math.min(crest.length - 1, i + 1)].name, 0.15]],
          new THREE.Vector3(0.3, -1, -0.08).normalize(), // hair falls down the side
          0.10 + Math.sin(t * Math.PI) * 0.05,
          HORSE_ZONE.mane,
        ));
      }
      rings.push(row);
    }
    for (let i = 0; i < rings.length - 1; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        indices.push(rings[i][j], rings[i + 1][j], rings[i + 1][j2]);
        indices.push(rings[i][j], rings[i + 1][j2], rings[i][j2]);
      }
    }

    // forelock tuft: small loft from between the ears down over the forehead
    const flock = [
      { p: new THREE.Vector3(0, 2.00, 1.20), r: 0.030, bone: 'forelock' },
      { p: new THREE.Vector3(0, 1.965, 1.30), r: 0.034, bone: 'forelock' },
      { p: new THREE.Vector3(0, 1.92, 1.345), r: 0.026, bone: 'forelock_1' },
      { p: new THREE.Vector3(0, 1.88, 1.36), r: 0.014, bone: 'forelock_1' },
    ];
    const frings = [];
    for (let i = 0; i < flock.length; i += 1) {
      const st = flock[i];
      const row = [];
      for (let j = 0; j < 8; j += 1) {
        const a = (j / 8) * Math.PI * 2;
        _P.set(st.p.x + Math.cos(a) * st.r, st.p.y, st.p.z + Math.sin(a) * st.r * 0.6);
        row.push(addVertex(
          _P,
          new THREE.Vector2(17.5 + i * 0.1, a * 0.04),
          [[st.bone, 1]],
          new THREE.Vector3(0, -0.75, 0.66),
          0.075,
          HORSE_ZONE.mane,
        ));
      }
      frings.push(row);
    }
    for (let i = 0; i < frings.length - 1; i += 1) {
      for (let j = 0; j < 8; j += 1) {
        const j2 = (j + 1) % 8;
        indices.push(frings[i][j], frings[i + 1][j], frings[i + 1][j2]);
        indices.push(frings[i][j], frings[i + 1][j2], frings[i][j2]);
      }
    }
  }
  addMane();

  // ==========================================================================
  // TAIL — short dock cone + the long hanging hair mass riding the caudal
  // chain (fullest mid-fall, tapering toward the hock-height tip)
  // ==========================================================================
  function addTail() {
    const NODES = HORSE_BONE_DEFS
      .filter(([name]) => name.startsWith('tail_'))
      .map(([name, , pos]) => ({ name, p: new THREE.Vector3(...pos) }));
    // Root the loft INSIDE the rump on a hips-weighted ring so posed tail
    // carriage (swish / gallop banner) never tears a gap at the dock.
    NODES.unshift({ name: 'hips', p: new THREE.Vector3(0, 1.45, -0.72) });
    const segs = 12;
    const rings = [];
    for (let i = 0; i < NODES.length; i += 1) {
      const node = NODES[i];
      const prev = NODES[Math.max(0, i - 1)].p;
      const next = NODES[Math.min(NODES.length - 1, i + 1)].p;
      _T.copy(next).sub(prev).normalize();
      _U.crossVectors(_T, _R);
      if (_U.lengthSq() < 1e-8) _U.set(0, 1, 0);
      _U.normalize();
      const Rv = new THREE.Vector3().crossVectors(_U, _T).normalize();
      const t = i / (NODES.length - 1);
      // dock (t<0.25) is slim; hair mass swells then tapers
      const r = t < 0.22
        ? THREE.MathUtils.lerp(0.075, 0.05, t / 0.22)
        : 0.05 + Math.sin(((t - 0.22) / 0.78) * Math.PI) * 0.035 - (t > 0.9 ? (t - 0.9) * 0.25 : 0);
      const nextName = NODES[Math.min(NODES.length - 1, i + 1)].name;
      const row = [];
      for (let j = 0; j < segs; j += 1) {
        const th = (j / segs) * Math.PI * 2;
        _P.copy(node.p)
          .addScaledVector(Rv, Math.cos(th) * r)
          .addScaledVector(_U, Math.sin(th) * r);
        row.push(addVertex(
          _P,
          new THREE.Vector2(12.0 + t, th * r),
          [[node.name, 0.7], [nextName, 0.3]],
          _T.clone().negate(),
          t < 0.2 ? 0.03 : 0.065,
          HORSE_ZONE.tail,
        ));
      }
      rings.push(row);
    }
    for (let i = 0; i < rings.length - 1; i += 1) {
      for (let j = 0; j < segs; j += 1) {
        const j2 = (j + 1) % segs;
        indices.push(rings[i][j], rings[i + 1][j], rings[i + 1][j2]);
        indices.push(rings[i][j], rings[i + 1][j2], rings[i][j2]);
      }
    }
    const tail = NODES[NODES.length - 1];
    const capIdx = addVertex(
      tail.p.clone().add(new THREE.Vector3(0, -0.05, 0)),
      new THREE.Vector2(12.95, 0),
      [[tail.name, 1]],
      new THREE.Vector3(0, -1, 0),
      0.05,
      HORSE_ZONE.tail,
    );
    const last = rings[rings.length - 1];
    for (let j = 0; j < segs; j += 1) {
      indices.push(capIdx, last[j], last[(j + 1) % segs]);
    }
  }
  addTail();

  // ==========================================================================
  // LEGS — muscular upper masses melting into the body, clean tendon-backed
  // cannons, flexible fetlock/pastern, and a proper keratin hoof:
  // coronet ring → toe-forward wall (squarish superellipse) → flat sole.
  //
  // Frames use parallel transport so a bent chain (stifle / hock) keeps a
  // continuous ring orientation instead of flipping and pinching.
  // ==========================================================================
  function addLeg(stations) {
    const segs = 14;
    const ringIdx = [];
    // seed frame from first segment
    const seedNext = stations[Math.min(1, stations.length - 1)];
    const seedPrev = stations[0];
    _T.set(seedNext.x - seedPrev.x, seedNext.y - seedPrev.y, seedNext.z - seedPrev.z);
    if (_T.lengthSq() < 1e-12) _T.set(0, -1, 0);
    _T.normalize();
    _U.crossVectors(_T, _R);
    if (_U.lengthSq() < 1e-8) _U.set(0, 0, 1);
    _U.normalize();
    let prevT = _T.clone();
    let prevU = _U.clone();
    let prevR = new THREE.Vector3().crossVectors(prevU, prevT).normalize();

    for (let i = 0; i < stations.length; i += 1) {
      const st = stations[i];
      const prevSt = stations[Math.max(0, i - 1)];
      const nextSt = stations[Math.min(stations.length - 1, i + 1)];
      _T.set(nextSt.x - prevSt.x, nextSt.y - prevSt.y, nextSt.z - prevSt.z);
      if (_T.lengthSq() < 1e-12) _T.copy(prevT);
      else _T.normalize();

      // parallel transport previous frame onto the new tangent
      const axis = new THREE.Vector3().crossVectors(prevT, _T);
      const axisLen = axis.length();
      if (axisLen > 1e-8) {
        const angle = Math.atan2(axisLen, THREE.MathUtils.clamp(prevT.dot(_T), -1, 1));
        axis.multiplyScalar(1 / axisLen);
        prevU.applyAxisAngle(axis, angle).normalize();
        prevR.applyAxisAngle(axis, angle).normalize();
      }
      // re-orthonormalize against the new tangent (kills drift)
      prevR.crossVectors(prevU, _T).normalize();
      if (prevR.lengthSq() < 1e-8) {
        prevR.crossVectors(_R, _T);
        if (prevR.lengthSq() < 1e-8) prevR.set(0, 0, 1);
        prevR.normalize();
      }
      prevU.crossVectors(_T, prevR).normalize();
      prevT.copy(_T);

      const exp = st.exp ?? 2;
      const row = [];
      for (let j = 0; j < segs; j += 1) {
        const th = (j / segs) * Math.PI * 2;
        let cx = Math.cos(th);
        let cy = Math.sin(th);
        if (exp !== 2) {
          const n = 2 / exp;
          cx = Math.sign(cx) * Math.abs(cx) ** n;
          cy = Math.sign(cy) * Math.abs(cy) ** n;
        }
        // optional medial bias: pull the inner half of the ring toward the
        // body so a fat haunch merges instead of forming a waist crease
        let rx = st.r;
        let ry = st.rz ?? st.r;
        if (st.medial && Math.sign(st.x) * cx < 0) {
          const m = Math.abs(cx); // 0 at side, 1 at medial pole
          rx *= 1 - st.medial * m;
        }
        _P.set(st.x, st.y, st.z)
          .addScaledVector(prevR, cx * rx)
          .addScaledVector(prevU, cy * ry);
        row.push(addVertex(
          _P,
          new THREE.Vector2(6.0 + st.y, th * st.r),
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
        indices.push(ringIdx[i][j], ringIdx[i + 1][j], ringIdx[i + 1][j2]);
        indices.push(ringIdx[i][j], ringIdx[i + 1][j2], ringIdx[i][j2]);
      }
    }
    // flat sole cap
    const st = stations[stations.length - 1];
    const capIdx = addVertex(
      new THREE.Vector3(st.x, 0.002, st.z),
      new THREE.Vector2(6.95, 0),
      st.bones,
      new THREE.Vector3(0, -1, 0),
      0,
      HORSE_ZONE.hoof,
    );
    const last = ringIdx[ringIdx.length - 1];
    for (let j = 0; j < segs; j += 1) {
      indices.push(capIdx, last[j], last[(j + 1) % segs]);
    }
  }

  function foreLeg(side) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.foreX;
    addLeg([
      // shoulder muscle cap buried in the body — leg swells from the chest
      { x: x * 0.72, y: 1.34, z: 0.48, r: 0.155, fl: 0.009, zone: HORSE_ZONE.coat, bones: [['shoulder_' + side, 0.5], ['scapula_' + side, 0.3], ['spine_8', 0.2]] },
      { x: x * 0.92, y: 1.14, z: 0.585, r: 0.120, fl: 0.008, zone: HORSE_ZONE.coat, bones: [['humerus_' + side, 0.6], ['scapula_' + side, 0.4]] },
      { x, y: 0.94, z: 0.565, r: 0.097, fl: 0.007, zone: HORSE_ZONE.coat, bones: [['humerus_' + side, 0.7], ['radius_' + side, 0.3]] },
      { x, y: 0.81, z: 0.545, r: 0.085, fl: 0.006, zone: HORSE_ZONE.coat, bones: [['radius_' + side, 0.85], ['humerus_' + side, 0.15]] },
      { x, y: 0.63, z: 0.565, r: 0.068, rz: 0.078, fl: 0.005, zone: HORSE_ZONE.coat, bones: [['radius_' + side, 0.9], ['carpus_' + side, 0.1]] },
      { x, y: 0.48, z: 0.58, r: 0.058, rz: 0.066, fl: 0.004, zone: HORSE_ZONE.coat, bones: [['carpus_' + side, 0.75], ['radius_' + side, 0.25]] },
      { x, y: 0.31, z: 0.59, r: 0.040, rz: 0.052, fl: 0.004, zone: HORSE_ZONE.coat, bones: [['cannon_F_' + side, 0.85], ['carpus_' + side, 0.15]] },
      { x, y: 0.175, z: 0.60, r: 0.048, rz: 0.055, fl: 0.005, zone: HORSE_ZONE.coat, bones: [['fetlock_F_' + side, 0.75], ['cannon_F_' + side, 0.25]] },
      { x, y: 0.105, z: 0.625, r: 0.041, fl: 0.004, zone: HORSE_ZONE.coat, bones: [['fetlock_F_' + side, 0.55], ['hoof_F_' + side, 0.45]] },
      // coronet band → hoof wall (squarish, toe forward) → ground rim
      { x, y: 0.068, z: 0.648, r: 0.052, exp: 2.4, fl: 0.002, zone: HORSE_ZONE.hoof, bones: [['hoof_F_' + side, 0.8], ['fetlock_F_' + side, 0.2]] },
      { x, y: 0.03, z: 0.665, r: 0.059, exp: 2.8, fl: 0, zone: HORSE_ZONE.hoof, bones: [['hoof_F_' + side, 0.6], ['hoofTip_F_' + side, 0.4]] },
      { x, y: 0.004, z: 0.672, r: 0.062, exp: 3.0, fl: 0, zone: HORSE_ZONE.hoof, bones: [['hoofTip_F_' + side, 0.7], ['hoof_F_' + side, 0.3]] },
    ]);
  }

  function hindLeg(side) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.hindX;
    // Quarter mass is the horse's power plant — much fuller than the fore
    // shoulder. Centerline stays nearly vertical under the hip so the loft
    // fills a rounded quarter silhouette instead of tracking the thin bone
    // S-curve (hip → stifle tip → hock), which was pinching into a V at the
    // stifle. Medial bias collapses the inner half of fat rings into the body.
    addLeg([
      // haunch / quarter — huge outer mass, medial side melts into croup
      { x: x * 0.62, y: 1.36, z: -0.54, r: 0.275, rz: 0.240, medial: 0.55, fl: 0.009, zone: HORSE_ZONE.coat, bones: [['haunch_' + side, 0.45], ['hips', 0.35], ['femur_' + side, 0.2]] },
      { x: x * 0.78, y: 1.24, z: -0.50, r: 0.255, rz: 0.220, medial: 0.50, fl: 0.009, zone: HORSE_ZONE.coat, bones: [['haunch_' + side, 0.55], ['femur_' + side, 0.3], ['hips', 0.15]] },
      { x: x * 0.92, y: 1.12, z: -0.47, r: 0.225, rz: 0.195, medial: 0.40, fl: 0.008, zone: HORSE_ZONE.coat, bones: [['femur_' + side, 0.55], ['haunch_' + side, 0.45]] },
      // mid thigh — still heavy, center slightly forward of hip but not at stifle tip
      { x: x * 1.00, y: 1.00, z: -0.45, r: 0.185, rz: 0.165, medial: 0.25, fl: 0.008, zone: HORSE_ZONE.coat, bones: [['femur_' + side, 0.8], ['haunch_' + side, 0.2]] },
      { x: x * 1.03, y: 0.90, z: -0.44, r: 0.150, rz: 0.140, medial: 0.12, fl: 0.007, zone: HORSE_ZONE.coat, bones: [['femur_' + side, 0.5], ['tibia_' + side, 0.5]] },
      // soft descent into gaskin (no sharp corner)
      { x: x * 1.02, y: 0.80, z: -0.47, r: 0.120, fl: 0.007, zone: HORSE_ZONE.coat, bones: [['tibia_' + side, 0.8], ['femur_' + side, 0.2]] },
      { x, y: 0.70, z: -0.52, r: 0.098, fl: 0.006, zone: HORSE_ZONE.coat, bones: [['tibia_' + side, 0.85], ['tarsus_' + side, 0.15]] },
      { x, y: 0.62, z: -0.58, r: 0.078, rz: 0.088, fl: 0.005, zone: HORSE_ZONE.coat, bones: [['tibia_' + side, 0.4], ['tarsus_' + side, 0.6]] },
      { x, y: 0.56, z: -0.64, r: 0.062, rz: 0.075, fl: 0.005, zone: HORSE_ZONE.coat, bones: [['tarsus_' + side, 0.85], ['tibia_' + side, 0.15]] },
      { x, y: 0.39, z: -0.60, r: 0.040, rz: 0.052, fl: 0.004, zone: HORSE_ZONE.coat, bones: [['cannon_H_' + side, 0.85], ['tarsus_' + side, 0.15]] },
      { x, y: 0.175, z: -0.558, r: 0.048, rz: 0.055, fl: 0.005, zone: HORSE_ZONE.coat, bones: [['fetlock_H_' + side, 0.75], ['cannon_H_' + side, 0.25]] },
      { x, y: 0.105, z: -0.538, r: 0.041, fl: 0.004, zone: HORSE_ZONE.coat, bones: [['fetlock_H_' + side, 0.55], ['hoof_H_' + side, 0.45]] },
      { x, y: 0.068, z: -0.518, r: 0.052, exp: 2.4, fl: 0.002, zone: HORSE_ZONE.hoof, bones: [['hoof_H_' + side, 0.8], ['fetlock_H_' + side, 0.2]] },
      { x, y: 0.03, z: -0.500, r: 0.059, exp: 2.8, fl: 0, zone: HORSE_ZONE.hoof, bones: [['hoof_H_' + side, 0.6], ['hoofTip_H_' + side, 0.4]] },
      { x, y: 0.004, z: -0.492, r: 0.062, exp: 3.0, fl: 0, zone: HORSE_ZONE.hoof, bones: [['hoofTip_H_' + side, 0.7], ['hoof_H_' + side, 0.3]] },
    ]);
  }

  foreLeg('L');
  foreLeg('R');
  hindLeg('L');
  hindLeg('R');

  // ==========================================================================
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setAttribute('furLen', new THREE.Float32BufferAttribute(furLens, 1));
  geometry.setAttribute('groomDir', new THREE.Float32BufferAttribute(groomDirs, 3));
  geometry.setAttribute('zoneId', new THREE.Float32BufferAttribute(zoneIds, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
