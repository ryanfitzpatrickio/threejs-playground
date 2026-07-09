/**
 * Shared uniforms for terrain parallax backdrop layers (camera-delta offset + wind).
 */

import * as THREE from 'three';
import { uniform } from 'three/tsl';

/** World-space XZ offset applied to parallax noise (camera movement × layer scale). */
export const terrainParallaxOffset = uniform(new THREE.Vector2());
/** Slow wind phase for haze animation on far layers. */
export const terrainParallaxWind = uniform(0);

export function syncTerrainParallaxOffset(deltaX, deltaZ, scale = 1) {
  terrainParallaxOffset.value.set(deltaX * scale, deltaZ * scale);
}

export function advanceTerrainParallaxWind(delta, speed = 0.04) {
  if (!Number.isFinite(delta) || delta <= 0) return;
  terrainParallaxWind.value = (terrainParallaxWind.value + delta * speed) % 1000;
}
