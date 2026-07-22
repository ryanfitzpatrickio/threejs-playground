/**
 * Domestic cat body geometry — one skinned BufferGeometry generated at boot.
 *
 * Core trick (shared with the goose): a SINGLE ring-loft runs tail-stub →
 * torso → chest → up the neck → over the skull → out to the nose. The loft path
 * lives in the YZ plane so ring frames never twist and the surface is seam-free
 * from rump to nose. That one parameterization yields:
 *   - coatUV: (s = arc-length along the path, t = arc around the ring), and
 *   - groomDir = -tangent (fur lays head → tail everywhere),
 * i.e. the "one continuous flow field, no zone seams" the cat coat wants.
 *
 * Merged extras: four digitigrade leg lofts, two flat triangular ear pinnae,
 * a long tapering tail loft, a small lower-jaw wedge, and eye spheres.
 *
 * Baked vertex attributes (consumed by catFurMaterial TSL). Exactly 8 buffers —
 * the WebGPU per-vertex cap — so there is NO separate restPosition attribute:
 * geometry is authored in bind space, so TSL positionGeometry IS rest position.
 *   position / normal / uv(coatUV) / skinIndex / skinWeight
 *   furLen   float — shell height in meters (0 on nose/eyes/pads)
 *   groomDir vec3  — fur lay direction in bind space
 *   zoneId   float — CAT_ZONE region gate
 */

import * as THREE from 'three';
import { CAT_DIMS, CAT_BONE_DEFS, CAT_CLAWS } from './catSkeleton.js';

export const CAT_ZONE = Object.freeze({
  fur: 0,     // body / neck / head contour fur (shells on)
  nose: 1,    // nose leather — bare, wet
  pad: 2,     // paw pads / lower legs — very short fur
  eye: 3,
  ear: 4,     // pinna (thin, short fur outside)
  tail: 5,    // tail (long fur)
  claw: 6,    // keratin claw — bare, pale
});

const D = CAT_DIMS;

export function buildCatBodyGeometry(boneIndex) {
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
    if (idx == null) throw new Error(`cat geometry: unknown bone ${name}`);
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
   * @param {Array<{c:[number,number],hw:number,ht:number,hb:number,keel?:number,exp?:number,zone?:number,fl?:number,bones:Array<[string,number]>}>} stations
   * @param {number} segs
   * @param {{capStart?:boolean,capEnd?:boolean,sOffset?:number,groomSign?:number}} [opts]
   */
  function loftPath(stations, segs, opts = {}) {
    const groomSign = opts.groomSign ?? -1; // fur lays toward the tail
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

      const zone = st.zone ?? CAT_ZONE.fur;
      const fl = st.fl ?? 0.006;
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
        // Breast keel: gently narrow + drop the lower belly toward a soft V.
        let pxAdj = px;
        if (st.keel && cy < 0) {
          const kb = st.keel * Math.pow(-cy, 1.5);
          pxAdj *= 1 - kb * 0.4;
          py *= 1 + st.keel * 0.10 * -cy;
        }
        _P.set(pxAdj, st.c[0], st.c[1]).addScaledVector(_U, py);
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
      _P.set(0, st.c[0], st.c[1]);
      const centerIdx = addVertex(
        _P,
        new THREE.Vector2(stationIdx === 0 ? 0 : 999, 0),
        st.bones,
        _G.set(0, 0, groomSign),
        st.fl ?? 0,
        st.zone ?? CAT_ZONE.fur,
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
  // MAIN LOFT: tail stub → torso → chest → neck → skull → nose
  // ==========================================================================
  /** @type {Array<any>} */
  const bodyStations = [
    // --- rump / tail stub ---------------------------------------------------
    { c: [0.204, -0.190], hw: 0.028, ht: 0.028, hb: 0.026, fl: 0.010, zone: CAT_ZONE.tail, bones: [['tail_0', 0.7], ['hips', 0.3]] },
    { c: [0.200, -0.158], hw: 0.052, ht: 0.055, hb: 0.052, fl: 0.009, bones: [['hips', 0.9], ['tail_0', 0.1]] },
    // --- torso barrel (deep back, belly tucked up between the legs) ----------
    { c: [0.198, -0.104], hw: 0.063, ht: 0.064, hb: 0.056, fl: 0.008, bones: [['hips', 0.6], ['spine_0', 0.4]] },
    { c: [0.196, -0.044], hw: 0.066, ht: 0.068, hb: 0.056, fl: 0.008, bones: [['spine_0', 0.6], ['spine_1', 0.4]] },
    { c: [0.195, 0.020], hw: 0.066, ht: 0.069, hb: 0.055, fl: 0.008, bones: [['spine_1', 0.6], ['spine_2', 0.4]] },
    { c: [0.196, 0.080], hw: 0.061, ht: 0.066, hb: 0.052, keel: 0.18, fl: 0.008, bones: [['spine_2', 0.5], ['spine_3', 0.3], ['chest', 0.2]] },
    // --- shoulders / neck base ----------------------------------------------
    { c: [0.196, 0.126], hw: 0.055, ht: 0.064, hb: 0.052, keel: 0.15, fl: 0.008, bones: [['spine_3', 0.55], ['spine_4', 0.45]] },
    { c: [0.210, 0.160], hw: 0.045, ht: 0.050, hb: 0.043, fl: 0.009, bones: [['spine_4', 0.6], ['neck_0', 0.4]] },
    // --- neck: SHORT and thick — the head sits close over the chest, so the
    //     neck is a stout truncated cone blending shoulders straight into the
    //     skull (the reference shows almost no free neck at all).
    { c: [0.222, 0.180], hw: 0.054, ht: 0.052, hb: 0.047, fl: 0.010, bones: [['neck_0', 0.75], ['neck_1', 0.25]] },
    { c: [0.246, 0.198], hw: 0.051, ht: 0.048, hb: 0.043, fl: 0.010, bones: [['neck_1', 0.7], ['head', 0.3]] },
    // --- throat / lower jaw junction ----------------------------------------
    { c: [0.268, 0.214], hw: 0.047, ht: 0.044, hb: 0.037, fl: 0.008, bones: [['head', 0.7], ['neck_1', 0.2], ['jaw', 0.1]] },
    // --- skull (round, wide, full cheeks — short flat-fronted feline face) --
    { c: [0.292, 0.232], hw: 0.053, ht: 0.050, hb: 0.044, fl: 0.006, bones: [['head', 1]] },
    { c: [0.294, 0.256], hw: 0.055, ht: 0.047, hb: 0.046, fl: 0.006, bones: [['head', 1]] }, // brow — eyes sit here
    // --- whisker-pad cheeks (wide, full — the face stays broad to the front) -
    { c: [0.285, 0.274], hw: 0.047, ht: 0.036, hb: 0.041, fl: 0.005, bones: [['head', 0.8], ['muzzle', 0.2]] },
    // --- muzzle: a SHORT downward bump, blunt front (nose drops below eyes) --
    { c: [0.274, 0.286], hw: 0.030, ht: 0.026, hb: 0.030, fl: 0.004, bones: [['muzzle', 0.7], ['head', 0.2], ['jaw', 0.1]] },
    { c: [0.264, 0.293], hw: 0.020, ht: 0.017, hb: 0.019, exp: 2.3, fl: 0.003, bones: [['muzzle', 0.9], ['jaw', 0.1]] },
    // --- nose leather: small pad at the front-bottom -------------------------
    { c: [0.257, 0.295], hw: 0.007, ht: 0.006, hb: 0.006, exp: 2.2, zone: CAT_ZONE.nose, fl: 0, bones: [['muzzle', 1]] },
  ];
  loftPath(bodyStations, 30, { capStart: true, capEnd: true });

  // ==========================================================================
  // LOWER-JAW / CHIN WEDGE (small loft under the muzzle so a gape reads)
  // ==========================================================================
  // Lower jaw / chin — tucked just under the muzzle to CLOSE the mouth gap
  // (was leaving a dark cavity between muzzle and jaw).
  const jawStations = [
    { c: [0.262, 0.218], hw: 0.034, ht: 0.013, hb: 0.014, fl: 0.005, bones: [['jaw', 0.8], ['head', 0.2]] },
    { c: [0.257, 0.246], hw: 0.030, ht: 0.015, hb: 0.012, fl: 0.004, bones: [['jaw', 1]] },
    { c: [0.251, 0.270], hw: 0.022, ht: 0.012, hb: 0.010, fl: 0.003, bones: [['jaw', 1]] },
    { c: [0.248, 0.288], hw: 0.013, ht: 0.009, hb: 0.007, fl: 0, bones: [['jaw', 1]] },
  ];
  loftPath(jawStations, 16, { capStart: true, capEnd: true });

  // ==========================================================================
  // EARS — thin triangular pinnae (cupped double-sided cards)
  // ==========================================================================
  function addEar(side) {
    const s = side === 'L' ? 1 : -1;
    const base = new THREE.Vector3(s * D.earBaseX, D.earBaseY, D.earBaseZ);
    const tip = new THREE.Vector3(s * D.earTipX, D.earTipY, D.earTipZ);
    const b0 = `ear_${side}_0`;
    const b1 = `ear_${side}_1`;
    // Build a flat triangle from a widening base to a point, cupped forward.
    const rows = 5;
    const grid = [];
    const halfBase = 0.028;    // ear width at the base
    const fwd = new THREE.Vector3(0, 0.18, 1).normalize(); // cup opening faces up-fwd
    const side3 = new THREE.Vector3(1, 0, 0);
    for (let i = 0; i <= rows; i += 1) {
      const t = i / rows;
      const center = base.clone().lerp(tip, t);
      const halfW = halfBase * (1 - t) * (1 - t * 0.2);
      const row = [];
      const cols = 5;
      for (let j = 0; j <= cols; j += 1) {
        const u = (j / cols) * 2 - 1; // -1..1 across the ear
        const p = center.clone().addScaledVector(side3, u * halfW * s);
        // Cup: pull the middle forward, edges back, deeper near the base.
        const cup = (1 - u * u) * (0.010 * (1 - t)) ;
        p.addScaledVector(fwd, cup);
        const w0 = 1 - t;
        row.push(addVertex(
          p,
          new THREE.Vector2(10.0 + t, (u * 0.5 + 0.5) * 0.05),
          [[b1, t * 0.85 + 0.05], [b0, w0 * 0.9 + 0.05], ['head', 0.1 * (1 - t)]],
          tip.clone().sub(base).normalize(),
          i === rows ? 0.002 : 0.004,
          CAT_ZONE.ear,
        ));
      }
      grid.push(row);
    }
    const cols = 5;
    for (let i = 0; i < rows; i += 1) {
      for (let j = 0; j < cols; j += 1) {
        const a = grid[i][j];
        const b = grid[i + 1][j];
        const c = grid[i + 1][j + 1];
        const d = grid[i][j + 1];
        // Single-sided: flipped duplicate triangles made computeVertexNormals
        // sum to ~zero (garbage lighting → pale ears). The undercoat renders
        // DoubleSide so the back face still draws.
        indices.push(a, b, c, a, c, d);
      }
    }
  }
  addEar('L');
  addEar('R');

  // ==========================================================================
  // EYES — round eyeballs seated in the socket, iris faces forward (shaded).
  // A standard +Y-pole sphere (flattened in z so it beds into the face); the
  // catAlbedo eye shader paints the forward hemisphere as the green iris +
  // vertical-slit pupil, and the rest as dark rim.
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
          cx + sinP * Math.cos(th) * r * 0.60 * sideSign, // bedded into the socket (horse trick)
          D.eyeY + Math.cos(phi) * r * 0.92,
          D.eyeZ + sinP * Math.sin(th) * r * 0.86,        // forward dome, slightly flattened
        );
        row.push(addVertex(
          _P,
          new THREE.Vector2(2.0 + phi, th),
          bones,
          new THREE.Vector3(0, 0, 1),
          0,
          CAT_ZONE.eye,
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
  // Real bedded eyeball geometry (the horse approach): the sphere is squashed
  // 0.68× along ±x so it seats into the skull side-front, the iris/pupil is
  // painted in-shader on the forward hemisphere, and a dark socket ring in the
  // fur anchors it. Blink squashes the eye bone's y-scale.
  addEyeSphere(1);
  addEyeSphere(-1);

  // ==========================================================================
  // TAIL — long tapering loft riding the 7-bone caudal chain
  // ==========================================================================
  function addTail() {
    const NODES = CAT_BONE_DEFS
      .filter(([name]) => name.startsWith('tail_'))
      .map(([name, , pos]) => ({ name, p: new THREE.Vector3(...pos) }));
    // Root the loft INSIDE the rump on a hips-weighted ring: posed tail
    // carriage (high-carry / swish) can then never tear a gap where the tail
    // tube meets the body stub — the first ring rides the pelvis, not tail_0.
    NODES.unshift({ name: 'hips', p: new THREE.Vector3(0, 0.220, -0.150) });
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
      const r = THREE.MathUtils.lerp(0.030, 0.011, t) * (1 - 0.12 * Math.sin(t * Math.PI));
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
          THREE.MathUtils.lerp(0.014, 0.020, t),
          CAT_ZONE.tail,
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
    // tip cap
    const tail = NODES[NODES.length - 1];
    const capIdx = addVertex(
      tail.p.clone().add(new THREE.Vector3(0, -0.004, -0.014)),
      new THREE.Vector2(12.9, 0),
      [[tail.name, 1]],
      new THREE.Vector3(0, 0, -1),
      0.020,
      CAT_ZONE.tail,
    );
    const last = rings[rings.length - 1];
    for (let j = 0; j < segs; j += 1) {
      indices.push(capIdx, last[j], last[(j + 1) % segs]);
    }
  }
  addTail();

  // ==========================================================================
  // LEGS — digitigrade lofts (feathered thigh → short-fur shank → paw)
  // ==========================================================================
  function addLeg(chain, stations) {
    const segs = 10;
    const ringIdx = [];
    for (let i = 0; i < stations.length; i += 1) {
      const st = stations[i];
      const prevSt = stations[Math.max(0, i - 1)];
      const nextSt = stations[Math.min(stations.length - 1, i + 1)];
      _T.set(nextSt.x - prevSt.x, nextSt.y - prevSt.y, nextSt.z - prevSt.z).normalize();
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
    // paw cap (rounded toe)
    const st = stations[stations.length - 1];
    const capIdx = addVertex(
      new THREE.Vector3(st.x, Math.max(0.006, st.y - 0.004), st.z + 0.014),
      new THREE.Vector2(6.9, 0),
      st.bones,
      new THREE.Vector3(0, 0, 1),
      0,
      CAT_ZONE.pad,
    );
    const last = ringIdx[ringIdx.length - 1];
    for (let j = 0; j < segs; j += 1) {
      indices.push(capIdx, last[j], last[(j + 1) % segs]);
    }
  }

  function foreLeg(side) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.legX;
    addLeg(`fore${side}`, [
      // shoulder cap — a muscle mass buried in the body so the leg swells
      // into the chest instead of poking out as a bare cylinder (kept modest:
      // an oversized cap reads as a slab wall from the front).
      { x: x * 0.84, y: 0.200, z: 0.108, r: 0.032, fl: 0.008, zone: CAT_ZONE.fur, bones: [['scapula_' + side, 0.5], ['spine_3', 0.5]] },
      { x: x * 0.98, y: 0.178, z: 0.116, r: 0.028, fl: 0.008, zone: CAT_ZONE.fur, bones: [['scapula_' + side, 0.7], ['spine_3', 0.3]] },
      { x: x * 1.04, y: 0.112, z: 0.126, r: 0.026, fl: 0.007, zone: CAT_ZONE.fur, bones: [['humerus_' + side, 0.8], ['scapula_' + side, 0.2]] },
      { x: x * 1.05, y: 0.085, z: 0.123, r: 0.025, fl: 0.006, zone: CAT_ZONE.fur, bones: [['radius_' + side, 0.5], ['humerus_' + side, 0.5]] },
      { x: x * 1.06, y: 0.058, z: 0.120, r: 0.024, fl: 0.005, zone: CAT_ZONE.fur, bones: [['radius_' + side, 0.85], ['humerus_' + side, 0.15]] },
      { x: x * 1.06, y: 0.026, z: 0.122, r: 0.024, fl: 0.004, zone: CAT_ZONE.fur, bones: [['radius_' + side, 0.4], ['Hand_' + side, 0.6]] },
      { x: x * 1.06, y: 0.012, z: 0.146, r: 0.022, fl: 0, zone: CAT_ZONE.pad, bones: [['Hand_' + side, 0.6], ['Fingers_tip_' + side, 0.4]] },
    ]);
  }

  function hindLeg(side) {
    const s = side === 'L' ? 1 : -1;
    const x = s * D.legX;
    addLeg(`hind${side}`, [
      // haunch cap — broad thigh muscle merging into the rump.
      { x: x * 0.84, y: 0.196, z: -0.108, r: 0.062, fl: 0.009, zone: CAT_ZONE.fur, bones: [['femur_' + side, 0.5], ['hips', 0.5]] },
      { x: x * 1.0, y: 0.166, z: -0.115, r: 0.050, fl: 0.009, zone: CAT_ZONE.fur, bones: [['femur_' + side, 0.75], ['hips', 0.25]] },
      { x: x * 1.03, y: 0.114, z: -0.072, r: 0.041, fl: 0.008, zone: CAT_ZONE.fur, bones: [['tibia_' + side, 0.7], ['femur_' + side, 0.3]] },
      { x: x * 1.05, y: 0.060, z: -0.106, r: 0.028, fl: 0.005, zone: CAT_ZONE.fur, bones: [['Foot_' + side, 0.75], ['tibia_' + side, 0.25]] },
      { x: x * 1.06, y: 0.026, z: -0.086, r: 0.024, fl: 0.004, zone: CAT_ZONE.fur, bones: [['Foot_' + side, 0.3], ['Toes_' + side, 0.7]] },
      { x: x * 1.06, y: 0.012, z: -0.058, r: 0.022, fl: 0, zone: CAT_ZONE.pad, bones: [['Toes_' + side, 0.6], ['Toes_tip_' + side, 0.4]] },
    ]);
  }

  foreLeg('L');
  foreLeg('R');
  hindLeg('L');
  hindLeg('R');

  // ==========================================================================
  // CLAWS — small curved keratin cones at each paw tip, fully weighted to the
  // retractable claw carrier bone so they sheath/protract with it.
  // ==========================================================================
  function addClaws() {
    const bonePos = new Map(CAT_BONE_DEFS.map(([n, , p]) => [n, new THREE.Vector3(...p)]));
    for (const [clawBone, toe, side] of CAT_CLAWS) {
      const s = side === 'L' ? 1 : -1;
      const root = bonePos.get(toe).clone();
      // three little claws per paw (splayed), curving forward-down to a point
      for (let c = -1; c <= 1; c += 1) {
        const lat = c * 0.008 * (s > 0 ? 1 : -1);
        const base = root.clone().add(new THREE.Vector3(lat, 0.004, 0.004));
        const tip = base.clone().add(new THREE.Vector3(lat * 0.4, -0.006, 0.014));
        const segs = 4;
        const rings = [];
        for (let i = 0; i <= 2; i += 1) {
          const t = i / 2;
          _P.copy(base).lerp(tip, t);
          _P.y += Math.sin(t * Math.PI) * 0.0015; // slight upward curve
          const r = THREE.MathUtils.lerp(0.0028, 0.0004, t);
          const row = [];
          for (let j = 0; j < segs; j += 1) {
            const th = (j / segs) * Math.PI * 2;
            const q = _P.clone().add(new THREE.Vector3(Math.cos(th) * r, Math.sin(th) * r, 0));
            row.push(addVertex(
              q,
              new THREE.Vector2(14.0 + t, th * r),
              [[clawBone, 1]],
              new THREE.Vector3(0, 0, 1),
              0,
              CAT_ZONE.claw,
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
      }
    }
  }
  addClaws();

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

/**
 * Procedural whiskers — thin tapered ribbons off the muzzle pads + brow, all
 * skinned 100% to the `muzzle` bone. `uv.x` carries t (0 root … 1 tip) so the
 * whisker material can taper the ribbon and drive the sway (light dynamics)
 * as t², and `uv.y` selects the ribbon edge (0/1). Returned as its own skinned
 * geometry (rendered by createCatWhiskerMaterial), kept off the body mesh so
 * it stays under the 8-buffer cap and needs no fur shells.
 */
export function buildCatWhiskers(boneIndex) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const skinIndices = [];
  const skinWeights = [];
  const indices = [];
  const mi = boneIndex.get('muzzle');
  if (mi == null) throw new Error('cat whiskers: missing muzzle bone');

  const up = new THREE.Vector3(0, 1, 0);
  const _d = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _perp = new THREE.Vector3();

  /** @param {THREE.Vector3} root @param {THREE.Vector3} dir @param {number} len @param {number} width */
  function ribbon(root, dir, len, width) {
    _d.copy(dir).normalize();
    _perp.crossVectors(_d, up).normalize();
    if (_perp.lengthSq() < 1e-6) _perp.set(1, 0, 0);
    const segs = 6;
    const rows = [];
    for (let i = 0; i <= segs; i += 1) {
      const t = i / segs;
      // gentle natural droop along the length
      _p.copy(root).addScaledVector(_d, len * t);
      _p.y -= t * t * len * 0.18;
      const hw = width * (1 - t) * 0.5 + 0.00015;
      const a = _p.clone().addScaledVector(_perp, hw);
      const b = _p.clone().addScaledVector(_perp, -hw);
      const ia = positions.length / 3;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      normals.push(0, 1, 0, 0, 1, 0);
      uvs.push(t, 0, t, 1);
      skinIndices.push(mi, 0, 0, 0, mi, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0, 1, 0, 0, 0);
      rows.push([ia, ia + 1]);
    }
    for (let i = 0; i < segs; i += 1) {
      const [a0, b0] = rows[i];
      const [a1, b1] = rows[i + 1];
      indices.push(a0, a1, b1, a0, b1, b0);
      indices.push(a0, b1, a1, a0, b0, b1); // double-sided (thin ribbon)
    }
  }

  // Anchor whiskers to the current muzzle/eye landmarks so they re-place with
  // the head proportions.
  const padY = D.noseY - 0.004;
  const padZ = D.noseZ - 0.020;
  for (const s of [1, -1]) {
    // mystacial pad: 4 whiskers fanning forward + outward, staggered elevation
    const pad = new THREE.Vector3(s * 0.020, padY, padZ);
    const fan = [
      { dir: new THREE.Vector3(s * 0.55, 0.02, 1.0), len: 0.115, w: 0.0014 },
      { dir: new THREE.Vector3(s * 0.78, -0.06, 0.9), len: 0.125, w: 0.0015 },
      { dir: new THREE.Vector3(s * 0.95, -0.16, 0.7), len: 0.110, w: 0.0014 },
      { dir: new THREE.Vector3(s * 1.05, -0.28, 0.5), len: 0.090, w: 0.0012 },
    ];
    for (let k = 0; k < fan.length; k += 1) {
      const f = fan[k];
      ribbon(pad.clone().add(new THREE.Vector3(0, k * 0.004 - 0.006, -k * 0.003)), f.dir, f.len, f.w);
    }
    // brow (superciliary) whiskers above the eye
    ribbon(new THREE.Vector3(s * 0.023, D.eyeY + 0.008, D.eyeZ - 0.010), new THREE.Vector3(s * 0.45, 0.55, 0.7), 0.070, 0.0013);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
