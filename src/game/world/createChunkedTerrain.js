/**
 * createChunkedTerrain.js
 *
 * Integration helper: turns a map builder "runtime project" (or autosave JSON)
 * into something that createBaseLevel / LevelSystem can consume.
 *
 * Returns an object shaped similarly to what createPlatformingArena returns,
 * plus a full level-like descriptor (group, getGroundHeightAt, etc.).
 *
 * This lets switching from the map editor to "Play" immediately run the
 * sculpted terrain as the world.
 */

import * as THREE from 'three';
import { ChunkManager } from '../../world/terrain/ChunkManager.js';
import { createTerrainChunkMesh } from '../../world/terrain/TerrainChunk.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { getMapBuilderAutosave } from '../../store/fileStore.js';

export function createChunkedTerrain(projectJson) {
  const manager = new ChunkManager();

  if (projectJson) {
    try {
      manager.loadProject(projectJson);
    } catch (e) {
      console.warn('Failed to load terrain project into ChunkManager, falling back to procedural only.', e);
    }
  }

  const group = new THREE.Group();
  group.name = 'Chunked Terrain';

  const handles = []; // {mesh, updateHeights, chunkData}

  // Create visuals for all currently loaded/authored chunks.
  // (After loadProject these are the authored ones.)
  const chunksToRender = manager.getLoadedChunks();

  for (const data of chunksToRender) {
    const handle = createTerrainChunkMesh(data, {
      castShadow: true,
      receiveShadow: true,
    });
    group.add(handle.mesh);
    handles.push(handle);
  }

  // Build BVH index so existing raycast / ledge / traversal queries can see the terrain.
  const geometryIndex = createLevelGeometryIndex(group);

  // Note: the legacy AABB "colliders" below are kept for API compatibility with LevelSystem
  // queries, but actual *physics collision* for terrain now uses real Rapier heightfield
  // colliders (see PhysicsSystem.createTerrainHeightfield) that match the visual surface exactly.
  // The old slab logic is no longer the source of "stuck in terrain" problems.
  const colliders = chunksToRender.map((data) => {
    const half = data.size * 0.5;
    const wx = data.cx * data.size;
    const wz = data.cz * data.size;

    // Compute rough top/bottom from the height data (cheap)
    let minH = Infinity;
    let maxH = -Infinity;
    for (let i = 0; i < data.heights.length; i += 1) {
      const h = data.heights[i];
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
    if (!Number.isFinite(minH)) { minH = 0; maxH = 0; }

    return {
      name: `TerrainChunk_${data.cx}_${data.cz}`,
      minX: wx - half,
      maxX: wx + half,
      minZ: wz - half,
      maxZ: wz + half,
      topY: maxH,
      bottomY: minH,
      width: data.size,
      depth: data.size,
      vaultable: false,
      noGroundSnap: false,
    };
  });

  function getGroundHeightAt(position, radius = 0.28, options = {}) {
    // Use the manager's interpolated height at the center and a few points around
    // the radius, then take the max. This mimics the old "highest collider under feet"
    // behavior and prevents the character from sinking into lower interpolated areas
    // or getting stuck on the discrete grid.
    // The manager now does proper bilinear interp so sampled height == actual surface height.
    const c = manager.getHeightAt(position.x, position.z);
    if (radius <= 0.01) return c;

    const r = radius * 0.7; // sample inside the foot area
    const samples = [
      c,
      manager.getHeightAt(position.x + r, position.z),
      manager.getHeightAt(position.x - r, position.z),
      manager.getHeightAt(position.x, position.z + r),
      manager.getHeightAt(position.x, position.z - r),
      // also diagonals for better coverage on 1m grid
      manager.getHeightAt(position.x + r * 0.7, position.z + r * 0.7),
      manager.getHeightAt(position.x - r * 0.7, position.z - r * 0.7),
    ];
    return Math.max(...samples);
  }

  function getBlockingColliderAt({ position, radius, feetY, height, stepHeight }) {
    // Terrain is generally not a "wall" – return null so the old blocking logic doesn't fight the heightfield.
    // Steep slopes can be handled later by slope checks or by returning a virtual collider when the
    // height delta inside the query radius is too large.
    return null;
  }

  return {
    group,
    colliders,
    ledges: [],            // pure terrain has no authored ledges yet (future: paint or auto-detect)
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    geometryIndex,

    getGroundHeightAt,
    getBlockingColliderAt,

    // Raw per-chunk data (including exact heights) so PhysicsSystem can create accurate
    // Rapier heightfield colliders that match the visual sculpted surface.
    terrainChunks: chunksToRender.map((data) => ({
      cx: data.cx,
      cz: data.cz,
      size: data.size,
      resolution: data.resolution,
      heights: data.heights,
    })),

    // Expose the manager in case higher-level code wants direct access (e.g. future ledge extraction)
    _manager: manager,

    dispose: () => {
      geometryIndex.dispose();
      for (const h of handles) {
        disposeObject3D(h.mesh);
      }
      disposeObject3D(group);
    },
  };
}

/**
 * Convenience: load the latest autosaved terrain project from the map builder
 * (if the user has used the editor and produced authored chunks).
 */
export function loadLatestTerrainProjectFromStorage() {
  try {
    const project = getMapBuilderAutosave();
    if (project && ((project.chunks && project.chunks.length > 0) || (project.objects && project.objects.length > 0))) {
      return project;
    }
  } catch (e) {
    // ignore corrupt storage
  }
  return null;
}
