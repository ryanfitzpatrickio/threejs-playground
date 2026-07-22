/**
 * Procedural ladybug body — one skinned BufferGeometry at boot.
 *
 * Pieces (merged):
 *   - oval dome body (thorax + abdomen under closed elytra)
 *   - soft belly plate
 *   - two curved elytra shells
 *   - head + compound eyes
 *   - 6 multi-segment legs
 *   - 2 antennae
 *
 * Vertex attributes (WebGPU-friendly, ≤8 buffers):
 *   position / normal / uv / skinIndex / skinWeight
 *   shellLen  float — soft underside shell height (0 on hard chitin)
 *   zoneId    float — LADYBUG_ZONE region gate for materials
 *   spotMask  float — 0..1 baked spot influence on elytra
 */

import * as THREE from 'three';
import { LADYBUG_DIMS, LADYBUG_BONE_DEFS, LADYBUG_LEG_BONES } from './ladybugSkeleton.js';

export const LADYBUG_ZONE = Object.freeze({
  elytra: 0,    // hard wing covers — glossy spots
  pronotum: 1,  // thorax shield
  belly: 2,     // soft underside — short shells
  head: 3,
  eye: 4,
  leg: 5,
  antenna: 6,
  joint: 7,     // leg joints — soft shells
});

const D = LADYBUG_DIMS;

/** Deterministic hash for baked spot layout. */
function hash2(ix, iy) {
  const s = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Classic seven-spot layout in elytra UV space (u along length, v across width).
 * Returns soft influence 0..1 for black spots on red base.
 */
function spotInfluence(u, v, sideSign) {
  // Mirror left/right elytra so spots are bilateral.
  const x = (u - 0.5) * sideSign;
  const y = v - 0.5;
  // Seven classic spots: scutellar (shared center) + 3 per elytron.
  const spots = [
    [0.00, 0.08, 0.11],   // scutellar / suture
    [0.22, 0.22, 0.10],
    [0.38, -0.08, 0.11],
    [0.18, -0.28, 0.09],
  ];
  let maxInf = 0;
  for (const [sx, sy, r] of spots) {
    const dx = x - sx;
    const dy = y - sy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const inf = Math.max(0, 1 - d / r);
    // Soft edge
    const soft = inf * inf * (3 - 2 * inf);
    if (soft > maxInf) maxInf = soft;
  }
  // Tiny micro-variation so spots aren't perfect circles
  const jitter = (hash2(Math.floor(u * 40), Math.floor(v * 40)) - 0.5) * 0.08;
  return THREE.MathUtils.clamp(maxInf + jitter * maxInf, 0, 1);
}

/**
 * @param {Map<string, number>} boneIndex
 * @returns {THREE.BufferGeometry}
 */
export function buildLadybugBodyGeometry(boneIndex) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const skinIndices = [];
  const skinWeights = [];
  const shellLens = [];
  const zoneIds = [];
  const spotMasks = [];
  const indices = [];

  const bi = (name) => {
    const idx = boneIndex.get(name);
    if (idx == null) throw new Error(`ladybug geometry: unknown bone ${name}`);
    return idx;
  };

  function addVertex(p, n, uv, bones, shellLen, zone, spot = 0) {
    positions.push(p.x, p.y, p.z);
    normals.push(n.x, n.y, n.z);
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
    shellLens.push(shellLen);
    zoneIds.push(zone);
    spotMasks.push(spot);
    return positions.length / 3 - 1;
  }

  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _uv = new THREE.Vector2();

  // ---- Oval dome body (soft under-shell + hard pronotum strip) ---------------
  function buildDome() {
    const segsU = 24;
    const segsV = 16;
    const ringStart = [];
    for (let j = 0; j <= segsV; j += 1) {
      const v = j / segsV; // 0 = rear, 1 = front
      const phi = Math.PI * (0.08 + v * 0.84); // leave open ends slightly
      const z = Math.cos(phi) * (D.bodyLen * 0.48);
      const rScale = Math.sin(phi);
      const row = [];
      for (let i = 0; i <= segsU; i += 1) {
        const u = i / segsU;
        const theta = u * Math.PI * 2;
        const x = Math.cos(theta) * D.bodyHalfW * rScale;
        const yRaw = Math.sin(theta);
        // Upper hemisphere more domed; belly flatter
        const y = yRaw >= 0
          ? D.bellyY + yRaw * D.domeH
          : D.bellyY + yRaw * D.domeH * 0.45;
        _p.set(x, y, z + D.thoraxZ * 0.15);
        // Normal from ellipsoid-ish surface
        _n.set(
          x / (D.bodyHalfW + 1e-6),
          (y - D.bellyY) / (D.domeH + 1e-6),
          (z) / (D.bodyLen * 0.48 + 1e-6),
        ).normalize();
        _uv.set(u, v);

        const isBelly = yRaw < -0.15;
        const isFront = v > 0.72;
        const zone = isBelly ? LADYBUG_ZONE.belly
          : isFront ? LADYBUG_ZONE.pronotum
            : LADYBUG_ZONE.elytra; // covered by elytra mesh; this is under-body
        const shell = isBelly ? 0.0028 : isFront ? 0.0004 : 0;
        // Skin: front → thorax/head, mid → thorax, rear → abdomen
        const bones = v > 0.7
          ? [['thorax', 0.7], ['head', 0.3]]
          : v > 0.4
            ? [['thorax', 1]]
            : v > 0.2
              ? [['thorax', 0.4], ['abdomen_0', 0.6]]
              : [['abdomen_0', 0.45], ['abdomen_1', 0.55]];
        row.push(addVertex(_p, _n, _uv, bones, shell, zone, 0));
      }
      ringStart.push(row);
    }
    for (let j = 0; j < segsV; j += 1) {
      for (let i = 0; i < segsU; i += 1) {
        const a = ringStart[j][i];
        const b = ringStart[j][i + 1];
        const c = ringStart[j + 1][i + 1];
        const d = ringStart[j + 1][i];
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  // ---- Elytra (two hard wing covers) ----------------------------------------
  function buildElytron(sideSign) {
    const bone = sideSign > 0 ? 'elytra_L' : 'elytra_R';
    const segsU = 12;
    const segsV = 14;
    const hinge = new THREE.Vector3(
      sideSign * D.elytraHingeX,
      D.elytraHingeY,
      D.elytraHingeZ,
    );
    const rows = [];
    for (let j = 0; j <= segsV; j += 1) {
      const v = j / segsV; // 0 = hinge/front, 1 = rear tip
      const row = [];
      for (let i = 0; i <= segsU; i += 1) {
        const u = i / segsU; // 0 = suture (midline), 1 = outer edge
        // Local oval shell from hinge
        const along = v * D.bodyLen * 0.92;
        const across = u * D.bodyHalfW * 1.05;
        const dome = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * D.domeH * 0.55;
        const x = sideSign * (0.002 + across);
        const y = D.elytraHingeY - 0.004 + dome - v * 0.006;
        const z = D.elytraHingeZ - along + 0.008;
        _p.set(x, y, z);
        // Approximate outward normal
        _n.set(sideSign * (0.3 + u), 0.85 + dome * 2, -0.15).normalize();
        _uv.set(u, v);
        const spot = spotInfluence(v, u, sideSign);
        // Mostly elytra bone; slight blend to thorax near hinge
        const hingeW = Math.max(0, 1 - v * 2.2);
        const bones = hingeW > 0.05
          ? [[bone, 1 - hingeW * 0.35], ['thorax', hingeW * 0.35]]
          : [[bone, 1]];
        row.push(addVertex(_p, _n, _uv, bones, 0, LADYBUG_ZONE.elytra, spot));
      }
      rows.push(row);
    }
    for (let j = 0; j < segsV; j += 1) {
      for (let i = 0; i < segsU; i += 1) {
        const a = rows[j][i];
        const b = rows[j][i + 1];
        const c = rows[j + 1][i + 1];
        const d = rows[j + 1][i];
        indices.push(a, b, c, a, c, d);
      }
    }
    void hinge;
  }

  // ---- Head + eyes ----------------------------------------------------------
  function buildSphere(center, radius, segs, bones, zone, shellLen = 0) {
    const stacks = segs;
    const slices = segs * 2;
    const rows = [];
    for (let j = 0; j <= stacks; j += 1) {
      const v = j / stacks;
      const phi = v * Math.PI;
      const row = [];
      for (let i = 0; i <= slices; i += 1) {
        const u = i / slices;
        const theta = u * Math.PI * 2;
        const sx = Math.sin(phi) * Math.cos(theta);
        const sy = Math.cos(phi);
        const sz = Math.sin(phi) * Math.sin(theta);
        _p.set(
          center.x + sx * radius,
          center.y + sy * radius,
          center.z + sz * radius,
        );
        _n.set(sx, sy, sz);
        _uv.set(u, v);
        row.push(addVertex(_p, _n, _uv, bones, shellLen, zone, 0));
      }
      rows.push(row);
    }
    for (let j = 0; j < stacks; j += 1) {
      for (let i = 0; i < slices; i += 1) {
        const a = rows[j][i];
        const b = rows[j][i + 1];
        const c = rows[j + 1][i + 1];
        const d = rows[j + 1][i];
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  function buildHead() {
    buildSphere(
      new THREE.Vector3(0, D.headCenterY, D.headCenterZ),
      D.headRadius,
      10,
      [['head', 1]],
      LADYBUG_ZONE.head,
      0.0003,
    );
    for (const sx of [1, -1]) {
      buildSphere(
        new THREE.Vector3(sx * D.eyeX, D.eyeY, D.eyeZ),
        D.eyeRadius,
        6,
        [['head', 1]],
        LADYBUG_ZONE.eye,
        0,
      );
    }
  }

  // ---- Antennae (thin tapered capsules) -------------------------------------
  function buildAntenna(sideSign) {
    const bone = sideSign > 0 ? 'ant_L' : 'ant_R';
    const segs = 6;
    const radSegs = 5;
    const base = new THREE.Vector3(sideSign * D.antBaseX, D.antBaseY, D.antBaseZ);
    // Curve forward-up-out
    const tip = base.clone().add(new THREE.Vector3(
      sideSign * 0.010,
      0.012,
      0.014,
    ));
    const rows = [];
    for (let j = 0; j <= segs; j += 1) {
      const t = j / segs;
      const c = base.clone().lerp(tip, t);
      const r = 0.0016 * (1 - t * 0.55);
      const row = [];
      // Local frame: approximate along
      const along = tip.clone().sub(base).normalize();
      const right = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0));
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      right.normalize();
      const up = new THREE.Vector3().crossVectors(right, along).normalize();
      for (let i = 0; i <= radSegs; i += 1) {
        const a = (i / radSegs) * Math.PI * 2;
        const ox = Math.cos(a) * r;
        const oy = Math.sin(a) * r;
        _p.copy(c).addScaledVector(right, ox).addScaledVector(up, oy);
        _n.copy(right).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a)).normalize();
        _uv.set(i / radSegs, t);
        row.push(addVertex(_p, _n, _uv, [[bone, 1]], 0.0005, LADYBUG_ZONE.antenna, 0));
      }
      rows.push(row);
    }
    for (let j = 0; j < segs; j += 1) {
      for (let i = 0; i < radSegs; i += 1) {
        const a = rows[j][i];
        const b = rows[j][i + 1];
        const c = rows[j + 1][i + 1];
        const d = rows[j + 1][i];
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  // ---- Legs (4-segment capsule chains, single-bone skin) --------------------
  function buildLeg(legName) {
    const attach = (() => {
      const def = LADYBUG_BONE_DEFS.find((d) => d[0] === legName);
      return new THREE.Vector3(...def[2]);
    })();
    const sideSign = legName.endsWith('L') ? 1 : -1;
    const isFront = legName.includes('_F');
    const isHind = legName.includes('_H');
    const tip = attach.clone().add(new THREE.Vector3(
      sideSign * D.legTipOut,
      -D.legTipDown,
      (isFront ? D.legTipFwd : isHind ? -D.legTipFwd : 0),
    ));
    // Segment joints along attach→tip
    const joints = [0, 0.28, 0.55, 0.82, 1.0];
    const radii = [0.0032, 0.0028, 0.0022, 0.0016, 0.0011];
    const segs = joints.length - 1;
    const radSegs = 6;
    const along = tip.clone().sub(attach).normalize();
    const right = new THREE.Vector3().crossVectors(along, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, along).normalize();

    const rows = [];
    for (let j = 0; j <= segs; j += 1) {
      const t = joints[j];
      const c = attach.clone().lerp(tip, t);
      const r = radii[j];
      const row = [];
      const zone = (j === 0 || j === 2) ? LADYBUG_ZONE.joint : LADYBUG_ZONE.leg;
      const shell = zone === LADYBUG_ZONE.joint ? 0.0012 : 0.0004;
      for (let i = 0; i <= radSegs; i += 1) {
        const a = (i / radSegs) * Math.PI * 2;
        _p.copy(c)
          .addScaledVector(right, Math.cos(a) * r)
          .addScaledVector(up, Math.sin(a) * r);
        _n.copy(right).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a)).normalize();
        _uv.set(i / radSegs, t);
        // Weight toward thorax near coxa
        const bones = t < 0.2
          ? [[legName, 0.75], ['thorax', 0.25]]
          : [[legName, 1]];
        row.push(addVertex(_p, _n, _uv, bones, shell, zone, 0));
      }
      rows.push(row);
    }
    for (let j = 0; j < segs; j += 1) {
      for (let i = 0; i < radSegs; i += 1) {
        const a = rows[j][i];
        const b = rows[j][i + 1];
        const c = rows[j + 1][i + 1];
        const d = rows[j + 1][i];
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  buildDome();
  buildElytron(1);
  buildElytron(-1);
  buildHead();
  buildAntenna(1);
  buildAntenna(-1);
  for (const leg of LADYBUG_LEG_BONES) buildLeg(leg);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geo.setAttribute('shellLen', new THREE.Float32BufferAttribute(shellLens, 1));
  geo.setAttribute('zoneId', new THREE.Float32BufferAttribute(zoneIds, 1));
  geo.setAttribute('spotMask', new THREE.Float32BufferAttribute(spotMasks, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  // Recompute may overwrite authored normals — re-apply smoothed but keep dome.
  // computeVertexNormals is fine for lighting; spots use spotMask not normals.
  geo.computeBoundingSphere();
  return geo;
}
