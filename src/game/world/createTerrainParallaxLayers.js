/**
 * createTerrainParallaxLayers.js
 *
 * Continuous inward-facing haze cylinders beyond the loaded chunk ring. No
 * billboard cards — those read as floating rectangles against the sky.
 */

import * as THREE from 'three';
import { createTerrainHazeMaterial } from '../materials/createTerrainHazeMaterial.js';

const LAYER_PRESETS = [
  { depth: 0.82, height: 48, noiseScale: 0.0016, alpha: 0.16 },
  { depth: 0.94, height: 64, noiseScale: 0.0011, alpha: 0.12 },
  { depth: 1.02, height: 78, noiseScale: 0.00075, alpha: 0.09 },
];

/**
 * @param {object} opts
 * @param {number} opts.viewDistance camera far / terrain reach scale (metres)
 * @param {number} [opts.layerCount] 1–3
 */
export function createTerrainParallaxLayers({ viewDistance, layerCount = 2 }) {
  const group = new THREE.Group();
  group.name = 'Terrain Parallax Layers';
  group.renderOrder = -8;
  group.frustumCulled = false;

  const count = Math.max(0, Math.min(LAYER_PRESETS.length, layerCount | 0));
  const shells = [];

  for (let i = 0; i < count; i += 1) {
    const preset = LAYER_PRESETS[i];
    const radius = viewDistance * preset.depth;
    const geometry = new THREE.CylinderGeometry(
      radius,
      radius,
      preset.height,
      48,
      1,
      true,
    );
    geometry.translate(0, preset.height * 0.5, 0);
    const material = createTerrainHazeMaterial(preset);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Terrain Haze Shell ${i + 1}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = -8 - i;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    shells.push({ mesh, y: preset.height * 0.5 });
    group.add(mesh);
  }

  return {
    group,
    update(cameraX, cameraZ) {
      for (const { mesh, y } of shells) {
        mesh.position.set(cameraX, y, cameraZ);
      }
    },
    dispose() {
      const materials = new Set();
      for (const { mesh } of shells) {
        materials.add(mesh.material);
        mesh.geometry.dispose();
        group.remove(mesh);
      }
      for (const material of materials) material.dispose();
    },
  };
}
