/**
 * createTerrainHorizon.js
 *
 * Low-poly annulus just outside the streamed chunk ring. Uses unlit haze
 * material (not the terrain PBR shader) so it melts into the sky instead of
 * reading as a black lit silhouette.
 */

import * as THREE from 'three';
import { createTerrainHazeMaterial } from '../materials/createTerrainHazeMaterial.js';

const ANGLE_SEGMENTS = 48;
const RADIAL_SEGMENTS = 3;

/**
 * @param {object} opts
 * @param {(wx:number, wz:number) => number} opts.sampleHeight world-space shaped height
 * @param {number} opts.innerRadius metres from the follow centre
 * @param {number} opts.outerRadius metres from the follow centre
 */
export function createTerrainHorizon({ sampleHeight, innerRadius, outerRadius }) {
  const group = new THREE.Group();
  group.name = 'Terrain Horizon';
  group.frustumCulled = false;

  const hazeMaterial = createTerrainHazeMaterial({
    noiseScale: 0.0012,
    alpha: 0.2,
    heightFade: 0.45,
  });
  const ring = buildHorizonRing({
    innerRadius,
    outerRadius,
    material: hazeMaterial,
    sampleHeight,
  });
  group.add(ring.mesh);

  let lastX = Infinity;
  let lastZ = Infinity;
  const recenterThreshold = 16;

  return {
    group,
    update(cameraX, cameraZ) {
      const moved = Math.hypot(cameraX - lastX, cameraZ - lastZ);
      if (!Number.isFinite(lastX) || moved >= recenterThreshold) {
        ring.setCenter(cameraX, cameraZ, sampleHeight);
        lastX = cameraX;
        lastZ = cameraZ;
      }
    },
    dispose() {
      ring.mesh.geometry.dispose();
      ring.mesh.material.dispose();
      group.remove(ring.mesh);
    },
  };
}

function buildHorizonRing({ innerRadius, outerRadius, material, sampleHeight }) {
  const angleCount = ANGLE_SEGMENTS + 1;
  const radialCount = RADIAL_SEGMENTS + 1;
  const positions = new Float32Array(angleCount * radialCount * 3);
  const uvs = new Float32Array(angleCount * radialCount * 2);
  const indices = [];
  const radii = [];
  for (let r = 0; r < radialCount; r += 1) {
    const t = r / RADIAL_SEGMENTS;
    radii.push(innerRadius + (outerRadius - innerRadius) * t);
  }

  for (let a = 0; a < ANGLE_SEGMENTS; a += 1) {
    for (let r = 0; r < RADIAL_SEGMENTS; r += 1) {
      const i0 = a * radialCount + r;
      const i1 = i0 + 1;
      const i2 = i0 + radialCount;
      const i3 = i2 + 1;
      indices.push(i0, i2, i1, i1, i2, i3);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Terrain Horizon Ring';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = -9;

  const setCenter = (centerX, centerZ, heightAt) => {
    let v = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let a = 0; a < angleCount; a += 1) {
      const angle = (a / ANGLE_SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let r = 0; r < radialCount; r += 1) {
        const radius = radii[r];
        const wx = centerX + cos * radius;
        const wz = centerZ + sin * radius;
        const y = heightAt(wx, wz);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        const i3 = v * 3;
        positions[i3] = wx;
        positions[i3 + 1] = y;
        positions[i3 + 2] = wz;
        const i2 = v * 2;
        uvs[i2] = a / ANGLE_SEGMENTS;
        uvs[i2 + 1] = r / RADIAL_SEGMENTS;
        v += 1;
      }
    }
    const ySpan = Math.max(4, maxY - minY);
    for (let i = 0; i < uvs.length; i += 2) {
      const vi = (i / 2) * 3 + 1;
      uvs[i + 1] = (positions[vi] - minY) / ySpan;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.uv.needsUpdate = true;
    geometry.computeBoundingSphere();
  };

  return { mesh, setCenter };
}
