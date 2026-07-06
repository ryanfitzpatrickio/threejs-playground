/**
 * createWildsLevel.js
 *
 * The "Wilds" scene: a finite eroded alpine valley built with three r185's
 * procedural TerrainGenerator + ForestGenerator (both fully TSL/procedural — no
 * textures, so no sampler-limit conflict with the clipmap shadows). Wrapped into
 * the level descriptor shape LevelSystem / GameRuntime / PhysicsSystem consume.
 *
 * Terrain physics is one big Rapier heightfield from the generator's baked height
 * grid; ground queries use TerrainGenerator.sampleHeight. The 500k-tree forest is
 * a single InstancedMesh (one draw call) and is intentionally NOT added to the
 * geometry index (raycasting it for hook/ledge would be ruinous).
 */

import * as THREE from 'three';
import { TerrainGenerator } from 'three/examples/jsm/generators/TerrainGenerator.js';
import { ForestGenerator } from 'three/examples/jsm/generators/ForestGenerator.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { getRecommendedCameraFar } from '../config/qualityPresets.js';

const TERRAIN_SIZE = 700;
const TERRAIN_SEGMENTS = 256;
const TERRAIN_HEIGHT_SCALE = 95;
// ForestGenerator's node material exceeds the available vertex-buffer layout,
// causing Three to bind its per-instance arrays as uniform buffers. Keep the
// single draw below WebGPU's common 64 KiB uniform-binding limit.
const MAX_FOREST_INSTANCES_PER_DRAW = 512;

const cullCenter = new THREE.Vector3();

export function createWildsLevel(qualityPreset = {}) {
  const group = new THREE.Group();
  group.name = 'Wilds';

  const terrain = new TerrainGenerator({
    seed: qualityPreset.wildsSeed ?? 7,
    size: TERRAIN_SIZE,
    segments: TERRAIN_SEGMENTS,
    heightScale: TERRAIN_HEIGHT_SCALE,
  });
  const terrainGroup = terrain.build(); // Group with the terrain mesh (procedural material)
  group.add(terrainGroup);

  const camFar = qualityPreset.cameraFar ?? getRecommendedCameraFar(qualityPreset);
  const forest = new ForestGenerator({
    seed: qualityPreset.wildsSeed ?? 7,
    count: Math.min(qualityPreset.wildsForestCount ?? 500000, MAX_FOREST_INSTANCES_PER_DRAW),
    castShadow: false, // 500k shadow casters is too costly; terrain still casts
    // Keep the draw band inside the camera far / fog so culled trees aren't wasted.
    from: 90,
    to: Math.min(650, Math.floor(camFar * 0.75)),
  });
  const forestGroup = forest.build(terrain);
  group.add(forestGroup);

  // BVH over the terrain mesh ONLY (not the forest instanced mesh).
  const geometryIndex = createLevelGeometryIndex(terrainGroup);

  const N = terrain.gridSize; // segments + 1
  const spawnY = terrain.sampleHeight(0, 0);

  return {
    name: 'Wilds',
    group,
    colliders: [],
    ledges: [],
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    geometryIndex,
    spawnPoint: new THREE.Vector3(0, spawnY, 0),
    // One big Rapier heightfield matching the visual mesh. heights are row-major
    // [iz*N+ix] (i=x, j=z) — exactly what PhysicsSystem.createTerrainHeightfield expects.
    terrainChunks: [
      {
        cx: 0,
        cz: 0,
        size: TERRAIN_SIZE,
        resolution: N,
        heights: terrain.heights,
        chunkKey: 'wilds',
      },
    ],

    // Finite terrain: no streaming. Drive the forest's distance cull each frame
    // (player position is a fine proxy for the cull centre).
    updateStreaming: (position) => {
      if (position) {
        cullCenter.set(position.x, position.y, position.z);
        forest.setCameraPosition(cullCenter);
      }
      return null;
    },

    getGroundHeightAt: (position) => terrain.sampleHeight(position.x, position.z),
    getBlockingColliderAt: () => null,

    snapshot: () => ({
      size: TERRAIN_SIZE,
      segments: TERRAIN_SEGMENTS,
      minY: Number((terrain.minY ?? 0).toFixed(2)),
      maxY: Number((terrain.maxY ?? 0).toFixed(2)),
      trees: forest.mesh?.count ?? 0,
    }),

    dispose: () => {
      geometryIndex.dispose();
      forest.dispose?.();
      terrain.dispose?.();
      disposeObject3D(group);
    },
  };
}
