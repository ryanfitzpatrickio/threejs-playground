/**
 * createRiverworks.js
 *
 * Builds the visible water surface from a river profile
 * (src/world/worldMap/riverProfile.js): one translucent animated ribbon per river
 * laid at the river's `waterY`. The carved heightfield IS the channel floor
 * (bedY becomes the standing surface via the streaming heightfield collider), so —
 * unlike roads — rivers add NO colliders: the water is visual + a swim trigger
 * (getWaterHeightAt) only.
 *
 * Returns { group, getWaterHeightAt, dispose }. getWaterHeightAt(x,z) → { waterY,
 * weight } is what the character swim detector (MovementSystem) queries each frame.
 */

import * as THREE from 'three';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createWaterMaterial } from '../materials/createWaterMaterial.js';
import { chunkGeometriesByGrid } from '../utils/chunkGeometryByGrid.js';

// How far the visual water plane extends on an ocean-fill side, and past the
// river's own ends (the 90° corner). qualityPresets.js's aerialEnd (fog/aerial
// perspective cutoff) tops out at 1800m on Ultra — extending much past that
// wastes vertices on something fog always hides anyway, so this only needs to
// clear the cutoff with a little margin, not be literally as large as possible.
const OCEAN_VISUAL_EXTENT = 2200;
// Chunk size (metres) the merged ribbon/water geometry is split into so
// Three.js's default per-mesh frustum culling can skip whole chunks that are
// off-screen — see chunkGeometryByGrid.js. A long road/coastline no longer has
// to be one always-submitted mesh.
const CHUNK_SIZE = 128;

export function createRiverworks({ profile }) {
  const group = new THREE.Group();
  group.name = 'Riverworks';
  group.userData.noCollision = true;

  const waterMaterial = createWaterMaterial();
  const ribbonGeoms = [];
  const tan = new THREE.Vector2();

  profile.rivers.forEach((b, riverIndex) => {
    const { samples, n, surfaceHalf, waterY, oceanLeft, oceanRight } = b;
    const leftExtent = oceanLeft ? OCEAN_VISUAL_EXTENT : surfaceHalf;
    const rightExtent = oceanRight ? OCEAN_VISUAL_EXTENT : surfaceHalf;

    const positions = new Float32Array(n * 2 * 3);
    let startTanX = 1, startTanZ = 0, endTanX = 1, endTanZ = 0;
    for (let i = 0; i < n; i += 1) {
      const prev = samples[Math.max(0, i - 1)];
      const next = samples[Math.min(n - 1, i + 1)];
      tan.set(next.x - prev.x, next.z - prev.z);
      if (tan.lengthSq() < 1e-8) tan.set(1, 0);
      tan.normalize();
      const px = -tan.y; // perpendicular to centerline (left)
      const pz = tan.x;
      if (i === 0) { startTanX = tan.x; startTanZ = tan.y; }
      if (i === n - 1) { endTanX = tan.x; endTanZ = tan.y; }
      const y = waterY[i];
      const lx = samples[i].x + px * leftExtent;
      const lz = samples[i].z + pz * leftExtent;
      const rx = samples[i].x - px * rightExtent;
      const rz = samples[i].z - pz * rightExtent;
      const o = i * 6;
      positions[o] = lx;
      positions[o + 1] = y;
      positions[o + 2] = lz;
      positions[o + 3] = rx;
      positions[o + 4] = y;
      positions[o + 5] = rz;
    }
    const indices = [];
    for (let i = 0; i < n - 1; i += 1) {
      const a = i * 2, bb = a + 1, c = a + 2, d = a + 3;
      indices.push(a, c, bb, bb, c, d);
    }

    const positionList = Array.from(positions);
    const indexList = indices;
    // 90° corner patches at each end, on every ocean-flagged side: a flat quad
    // running from the shore point, out along the river's own tangent (backward
    // past the start / forward past the end), then turning 90° out to sea —
    // closing the gap so the water plane covers the same corner region the
    // terrain carve does (riverProfile.js), instead of leaving a triangular gap
    // of exposed land past the river's tip. `fwdX/fwdZ` is always the TRUE
    // forward tangent (so the outward normal matches the main ribbon's
    // left/right convention exactly); `extendSign` picks which way along it to
    // stretch the shoreline (-1 = before the start, +1 = past the end).
    const addCornerQuad = (shore, fwdX, fwdZ, extendSign, sideSign, extent, y) => {
      const nx = -fwdZ * sideSign, nz = fwdX * sideSign; // outward normal for this side
      const A = { x: shore.x, z: shore.z };
      const B = { x: shore.x + fwdX * extendSign * OCEAN_VISUAL_EXTENT, z: shore.z + fwdZ * extendSign * OCEAN_VISUAL_EXTENT };
      const C = { x: B.x + nx * extent, z: B.z + nz * extent };
      const D = { x: shore.x + nx * extent, z: shore.z + nz * extent };
      const base = positionList.length / 3;
      for (const p of [A, B, C, D]) positionList.push(p.x, y, p.z);
      indexList.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    if (oceanLeft) {
      addCornerQuad(samples[0], startTanX, startTanZ, -1, 1, OCEAN_VISUAL_EXTENT, waterY[0]);
      addCornerQuad(samples[n - 1], endTanX, endTanZ, 1, 1, OCEAN_VISUAL_EXTENT, waterY[n - 1]);
    }
    if (oceanRight) {
      addCornerQuad(samples[0], startTanX, startTanZ, -1, -1, OCEAN_VISUAL_EXTENT, waterY[0]);
      addCornerQuad(samples[n - 1], endTanX, endTanZ, 1, -1, OCEAN_VISUAL_EXTENT, waterY[n - 1]);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positionList), 3));
    geom.setIndex(indexList);
    geom.computeVertexNormals();
    ribbonGeoms.push(geom);
    void riverIndex;
  });

  if (ribbonGeoms.length > 0) {
    // Chunked instead of one merged mesh: a long coastline (especially with an
    // ocean-fill side, which can span kilometres) would otherwise be a single
    // always-submitted mesh regardless of how much of it is actually on screen.
    const chunks = chunkGeometriesByGrid(ribbonGeoms, CHUNK_SIZE);
    for (const g of ribbonGeoms) g.dispose();
    for (const [key, geom] of chunks) {
      geom.computeBoundingSphere();
      const mesh = new THREE.Mesh(geom, waterMaterial);
      mesh.name = `River Water ${key}`;
      mesh.renderOrder = 1; // draw after opaque terrain (transparent, depthWrite off)
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
  }

  // Character swim detector query. corridorAt is null outside every river corridor.
  const corridorAt = profile.corridorAt;
  const getWaterHeightAt = (position) => {
    const r = corridorAt(position.x, position.z);
    if (!r) return { waterY: 0, weight: 0 };
    return { waterY: r.waterY, weight: r.weight };
  };

  return {
    group,
    getWaterHeightAt,
    dispose: () => disposeObject3D(group),
  };
}
