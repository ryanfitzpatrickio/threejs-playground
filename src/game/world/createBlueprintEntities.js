/**
 * createBlueprintEntities.js
 *
 * Instantiates world-map `entities` (placed blueprint instances) into the live
 * world. Called by createStreamingTerrainLevel, which feeds the result back into
 * its terrain shaping (merge), ground resolution (platform + object colliders),
 * scene group (object meshes), and geometry index.
 *
 * Two phases avoid a terrain<->blueprint ordering cycle:
 *   Phase A (at construction, before the terrain's initial ring is shaped):
 *     build the merge field (sampled blueprint heightfields) + platform colliders.
 *     Needs only the analytic base ground height (pre-merge).
 *   Phase B (placeObjects, after the terrain's shaped-height sampler exists):
 *     place each object mesh on the right surface (existing ground / merged
 *     surface / platform top) and derive its world-space collider box.
 *
 * Object meshes are built identically to the Map Builder via the shared
 * createPrimitiveGeometry + createAtlasMaterial, so an entity looks the same in
 * the world as it did in the editor.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ChunkManager } from '../../world/terrain/ChunkManager.js';
import { createPrimitiveGeometry, primitiveHalfExtents } from '../../map/primitiveGeometry.js';
import { createAtlasMaterial } from '../../map/textureAtlas.js';
import { getBlueprintProject } from '../../map/blueprintLibrary.js';
import { terrainTextureUrl } from '../../map/editorTerrainMaterial.js';

const _texLoader = new THREE.TextureLoader();

// World metres: ramp stamped terrain into the surrounding terrain over this
// distance so a merge entity meets the world on a slope, not a cliff. Matches
// the FLATTEN_MARGIN discipline used for city zones in createStreamingTerrainLevel.
const MERGE_FEATHER = 16;
const PLATFORM_THICKNESS = 1.0;
const DEG = Math.PI / 180;

// Reusable unit-box corners for collider AABB derivation.
const BOX_CORNERS = [
  [-1, -1, -1], [1, -1, -1], [-1, -1, 1], [1, -1, 1],
  [-1, 1, -1], [1, 1, -1], [-1, 1, 1], [1, 1, 1],
];
const _v = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _euler = new THREE.Euler();

export function createBlueprintEntities(_qualityPreset = {}, { worldMap = null, baseGroundAt = null, terrainTexture = null } = {}) {
  const group = new THREE.Group();
  group.name = 'Blueprint Entities';

  const entities = (worldMap?.entities ?? []).filter((e) => e && e.blueprintId);
  const colliders = [];          // platform colliders (Phase A) + object colliders (Phase B)
  const meshes = [];             // object meshes (Phase B) — for the geometry index
  const mergeContributors = [];  // merge-mode entities → stamped heightfield samplers
  const texContributors = [];    // merge-mode footprints carrying the shared terrain texture

  // One shared blueprint terrain texture (resolved by the caller) painted onto
  // merge footprints (per-vertex mask, below) and onto platform slabs.
  const sharedTexId = terrainTexture?.id ?? null;
  let slabMaterial = null; // lazily created plain material for platform slabs

  // ------------------------------------------------------------------
  // Phase A: merge field + platform colliders (no shaped-ground sampling yet)
  // ------------------------------------------------------------------
  for (const entity of entities) {
    const project = loadProjectSafe(entity.blueprintId);
    if (!project) continue;
    const yawRad = (Number(entity.yaw) || 0) * DEG;
    const scale = Math.max(0.01, Number(entity.scale) || 1);
    const baseGroundY = baseGroundAt ? baseGroundAt(entity.x, entity.z) : 0;
    const localAabb = blueprintLocalAabb(project);
    // This entity carries the shared terrain texture if its blueprint uses it.
    const hasTex = !!sharedTexId && (project.terrainTexture?.id ?? null) === sharedTexId;

    if (entity.groundMode === 'merge') {
      const manager = buildBlueprintManager(project);
      if (!manager || !localAabb) continue;
      const contributor = {
        x: entity.x, z: entity.z, yawRad, scale, baseGroundY, manager,
        minLX: localAabb.minX, maxLX: localAabb.maxX,
        minLZ: localAabb.minZ, maxLZ: localAabb.maxZ,
      };
      mergeContributors.push(contributor);
      if (hasTex) texContributors.push(contributor);
    } else if (entity.groundMode === 'platform' && localAabb) {
      const rect = transformLocalRect(localAabb, entity.x, entity.z, yawRad, scale);
      const topY = platformTopY(rect, baseGroundAt); // clear terrain so the flat top always wins
      colliders.push({
        name: `bp-platform:${entity.id}`,
        minX: rect.minX, maxX: rect.maxX, minZ: rect.minZ, maxZ: rect.maxZ,
        topY, bottomY: topY - PLATFORM_THICKNESS,
        surfaceHeightAt: () => topY,
        physicsOwnerKey: `bp-platform:${entity.id}`,
      });
      // Platform mode otherwise renders no terrain; give it a visible textured
      // slab so the blueprint's terrain texture shows on the flat top.
      if (hasTex) {
        if (!slabMaterial) slabMaterial = buildSlabMaterial(terrainTexture);
        const slab = buildPlatformSlab(rect, topY, slabMaterial);
        group.add(slab);
        meshes.push(slab);
      }
    }
    // 'none' entities contribute nothing in Phase A.
  }

  // Per-vertex terrain-texture coverage (0..1) for the merge footprints that
  // carry the shared texture — mirrors mergeField's weight so the painted
  // texture fades out exactly where the stamped height feathers into the base.
  const texMask = (wx, wz) => {
    let best = 0;
    for (const m of texContributors) {
      const dx = wx - m.x;
      const dz = wz - m.z;
      const cos = Math.cos(m.yawRad);
      const sin = Math.sin(m.yawRad);
      const lx = (dx * cos + dz * sin) / m.scale;
      const lz = (-dx * sin + dz * cos) / m.scale;
      const outsideX = Math.max(m.minLX - lx, lx - m.maxLX, 0);
      const outsideZ = Math.max(m.minLZ - lz, lz - m.maxLZ, 0);
      const dWorld = Math.hypot(outsideX, outsideZ) * m.scale;
      const weight = dWorld <= 0 ? 1 : dWorld >= MERGE_FEATHER ? 0 : 1 - dWorld / MERGE_FEATHER;
      if (weight > best) best = weight;
    }
    return best;
  };

  /**
   * Stamped-terrain sampler for merge entities: (wx,wz) -> { height, weight }.
   * `weight` is 1 inside an entity's footprint, ramping to 0 over MERGE_FEATHER
   * (world m) outside it; `height` is that entity's blueprint surface lifted to
   * its base-ground Y. The max-weight contributor wins (dominant entity).
   */
  const mergeField = (wx, wz) => {
    let bestWeight = 0;
    let bestHeight = 0;
    for (const m of mergeContributors) {
      const dx = wx - m.x;
      const dz = wz - m.z;
      const cos = Math.cos(m.yawRad);
      const sin = Math.sin(m.yawRad);
      // Inverse entity transform: world → blueprint-local (rotate -yaw, scale 1/s).
      const lx = (dx * cos + dz * sin) / m.scale;
      const lz = (-dx * sin + dz * cos) / m.scale;
      const outsideX = Math.max(m.minLX - lx, lx - m.maxLX, 0);
      const outsideZ = Math.max(m.minLZ - lz, lz - m.maxLZ, 0);
      const dWorld = Math.hypot(outsideX, outsideZ) * m.scale;
      const weight = dWorld <= 0 ? 1 : dWorld >= MERGE_FEATHER ? 0 : 1 - dWorld / MERGE_FEATHER;
      if (weight <= bestWeight) continue;
      bestWeight = weight;
      bestHeight = m.baseGroundY + m.manager.getHeightAt(lx, lz) * m.scale;
    }
    return { height: bestHeight, weight: bestWeight };
  };

  // ------------------------------------------------------------------
  // Phase B: object meshes + per-object colliders (after ground exists)
  // ------------------------------------------------------------------
  function placeObjects({ sampleGround = null } = {}) {
    for (const entity of entities) {
      const project = loadProjectSafe(entity.blueprintId);
      if (!project || !Array.isArray(project.objects) || project.objects.length === 0) continue;

      const yawRad = (Number(entity.yaw) || 0) * DEG;
      const scale = Math.max(0.01, Number(entity.scale) || 1);
      const localAabb = blueprintLocalAabb(project);

      // Entity transform in the XZ plane (Y resolved per object against ground).
      _pos.set(entity.x, 0, entity.z);
      _quat.setFromEuler(_euler.set(0, yawRad, 0));
      _scl.set(scale, scale, scale);
      const entityMatrix = new THREE.Matrix4().compose(_pos, _quat, _scl);

      const entityGroup = new THREE.Group();
      entityGroup.name = `Entity ${entity.id}`;
      group.add(entityGroup);

      // Draw-call batching: placed blueprints are static, so instead of one
      // Mesh + cloned texture + material PER OBJECT (241 draws for the race
      // track center piece), bake each object's world transform (and its
      // textureRepeat, into UVs — equivalent under RepeatWrapping) into its
      // geometry and merge everything sharing a material signature into one
      // mesh. Colliders stay per-object below — they're analytic AABBs.
      const batches = new Map(); // materialKey -> { geometries, makeMaterial }
      const addToBatch = (key, geometry, makeMaterial) => {
        let batch = batches.get(key);
        if (!batch) { batch = { geometries: [], makeMaterial }; batches.set(key, batch); }
        batch.geometries.push(geometry);
      };

      project.objects.forEach((obj, i) => {
        const type = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'player_spawn'].includes(obj.type) ? obj.type : 'box';
        const isSpawn = type === 'player_spawn';

        // Object local transform, composed with the entity transform → world.
        const lp = obj.position ?? [0, 0, 0];
        const lr = obj.rotationDegrees ?? [0, 0, 0];
        const ls = obj.scale ?? [1, 1, 1];
        _pos.set(lp[0], lp[1], lp[2]);
        _quat.setFromEuler(_euler.set(lr[0] * DEG, lr[1] * DEG, lr[2] * DEG));
        _scl.set(Math.max(0.01, ls[0]), Math.max(0.01, ls[1]), Math.max(0.01, ls[2]));
        const objectMatrix = new THREE.Matrix4().compose(_pos, _quat, _scl);
        const worldMatrix = entityMatrix.clone().multiply(objectMatrix);

        // Resolve ground Y per object footprint so objects follow sloped/merged ground.
        const ox = worldMatrix.elements[12];
        const oz = worldMatrix.elements[14];
        const authoredY = scale * (Number(lp[1]) || 0);
        let groundY;
        if (entity.groundMode === 'platform' && localAabb) {
          const rect = transformLocalRect(localAabb, entity.x, entity.z, yawRad, scale);
          groundY = platformTopY(rect, baseGroundAt);
        } else if (sampleGround) {
          groundY = sampleGround(ox, oz);
        } else {
          groundY = baseGroundAt ? baseGroundAt(entity.x, entity.z) : 0;
        }
        worldMatrix.setPosition(ox, groundY + authoredY, oz);

        const geometry = createPrimitiveGeometry(type).applyMatrix4(worldMatrix);
        if (isSpawn) {
          addToBatch('spawn', geometry, () =>
            new THREE.MeshStandardMaterial({ color: 0x4ab3ff, emissive: 0x123a58, emissiveIntensity: 0.55, roughness: 0.52 }));
        } else {
          const tile = normalizeTile(obj.tileIndex);
          const zIndex = obj.zIndex ?? 0;
          const rx = Math.max(0.01, Number(obj.textureRepeat?.[0]) || 1);
          const ry = Math.max(0.01, Number(obj.textureRepeat?.[1]) || 1);
          if (rx !== 1 || ry !== 1) {
            const uv = geometry.getAttribute('uv');
            for (let u = 0; u < uv.count; u += 1) uv.setXY(u, uv.getX(u) * rx, uv.getY(u) * ry);
          }
          addToBatch(`${tile}:${zIndex}`, geometry, () => createAtlasMaterial(tile, [1, 1], zIndex));
        }

        // A player-spawn primitive is an editor/runtime marker, not level geometry.
        // Giving it a collider traps the character inside the marker at spawn: input
        // velocity changes, but Rapier resolves every horizontal move to zero.
        if (isSpawn) return;

        // World-space AABB collider from the unit-box corners through the final matrix.
        const he = primitiveHalfExtents(type);
        const aabb = worldAabbFromHalfExtents(he, worldMatrix);
        if (!Number.isFinite(aabb.minX)) return;
        colliders.push({
          name: `bp-obj:${entity.id}:${i}`,
          minX: aabb.minX, maxX: aabb.maxX, minZ: aabb.minZ, maxZ: aabb.maxZ,
          topY: aabb.maxY, bottomY: aabb.minY,
          physicsOwnerKey: `bp-obj:${entity.id}:${i}`,
        });
      });

      for (const [key, batch] of batches) {
        const merged = batch.geometries.length === 1
          ? batch.geometries[0]
          : mergeGeometries(batch.geometries, false);
        if (batch.geometries.length > 1) for (const g of batch.geometries) g.dispose();
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, batch.makeMaterial());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `bp-batch:${entity.id}:${key}`;
        entityGroup.add(mesh);
        meshes.push(mesh);
      }
    }
  }

  function dispose() {
    for (const m of meshes) {
      m.geometry?.dispose?.();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.());
      else mat?.dispose?.();
    }
    group.removeFromParent();
  }

  return {
    group,
    colliders,      // platform (Phase A) + object (Phase B) colliders
    meshes,         // populated after placeObjects; the terrain level adds these to its geometry index
    mergeField,     // (wx, wz) -> { height, weight }
    texMask,        // (wx, wz) -> 0..1 shared-texture coverage over merge footprints
    placeObjects,
    dispose,
  };
}

/**
 * Resolve the single shared blueprint terrain texture for a world map: the first
 * placed merge/platform entity whose blueprint carries a terrainTexture id wins.
 * Returns { id, url, tiling, blend } or null. (One shared texture by design.)
 */
export function collectBlueprintTerrainTexture(worldMap) {
  const entities = (worldMap?.entities ?? []).filter((e) => e && e.blueprintId);
  for (const entity of entities) {
    if (entity.groundMode !== 'merge' && entity.groundMode !== 'platform') continue;
    const project = loadProjectSafe(entity.blueprintId);
    const tt = project?.terrainTexture;
    const url = terrainTextureUrl(tt?.id);
    if (url) {
      return {
        id: tt.id,
        url,
        tiling: typeof tt.tiling === 'number' ? tt.tiling : 0.08,
        blend: typeof tt.blend === 'number' ? tt.blend : 1,
      };
    }
  }
  return null;
}

/** Plain (WebGPU-compatible) standard material for a platform slab top. */
function buildSlabMaterial(terrainTexture) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.02 });
  const tex = _texLoader.load(terrainTexture.url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  mat.map = tex;
  mat.userData.tiling = terrainTexture.tiling > 0 ? terrainTexture.tiling : 0.08;
  return mat;
}

/** A thin world-axis-aligned box whose top sits at topY, textured by tiling. */
function buildPlatformSlab(rect, topY, baseMaterial) {
  const w = Math.max(0.5, rect.maxX - rect.minX);
  const d = Math.max(0.5, rect.maxZ - rect.minZ);
  const tiling = baseMaterial.userData.tiling ?? 0.08;
  const material = baseMaterial.clone();
  // Per-slab map clone so the world-size UV repeat is consistent across slabs.
  if (baseMaterial.map) {
    const map = baseMaterial.map.clone();
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.SRGBColorSpace;
    map.repeat.set(w * tiling, d * tiling);
    map.needsUpdate = true;
    material.map = map;
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, PLATFORM_THICKNESS, d), material);
  mesh.name = 'bp-platform-slab';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.set((rect.minX + rect.maxX) * 0.5, topY - PLATFORM_THICKNESS * 0.5, (rect.minZ + rect.maxZ) * 0.5);
  mesh.updateMatrixWorld(true);
  return mesh;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function loadProjectSafe(id) {
  try {
    return getBlueprintProject(id);
  } catch {
    return null;
  }
}

/**
 * Local→world transform of a blueprint-local XZ point for a placed entity.
 * Mirrors the transform used by mergeField + transformLocalRect (rotate +yaw,
 * scale, translate). Returns a function closure over the entity's cos/sin/scale.
 */
function makeLocalToWorld(entity) {
  const ex = Number(entity.x) || 0;
  const ez = Number(entity.z) || 0;
  const scale = Math.max(0.01, Number(entity.scale) || 1);
  const yawRad = (Number(entity.yaw) || 0) * DEG;
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  return (lx, lz) => ({
    x: ex + scale * (lx * cos - lz * sin),
    z: ez + scale * (lx * sin + lz * cos),
  });
}

/**
 * Collect every ROAD from placed blueprint entities, transformed into WORLD
 * frame. Pure (no ChunkManager, no terrain sampling) — just the local→world
 * point transform + width scaling. createStreamingTerrainLevel merges this with
 * worldMap.roads so blueprint roads flow through the SAME carve + ribbon pipeline
 * as 2D-editor roads: the profile re-samples world terrain, so a road conforms to
 * its placement terrain (spiral up a world hill) — matching "same as 2D editor".
 */
export function collectBlueprintRoads(worldMap) {
  const out = [];
  const entities = (worldMap?.entities ?? []).filter((e) => e && e.blueprintId);
  for (const entity of entities) {
    const project = loadProjectSafe(entity.blueprintId);
    if (!project || !Array.isArray(project.roads)) continue;
    const scale = Math.max(0.01, Number(entity.scale) || 1);
    const toWorld = makeLocalToWorld(entity);
    for (const road of project.roads) {
      if (!Array.isArray(road?.points)) continue;
      const points = [];
      for (const p of road.points) {
        const lx = Number(p?.x);
        const lz = Number(p?.z);
        if (Number.isFinite(lx) && Number.isFinite(lz)) points.push(toWorld(lx, lz));
      }
      if (points.length < 2) continue;
      out.push({
        id: `${entity.id ?? '?'}:${road.id ?? '?'}`,
        points,
        width: Math.max(2, Number(road.width) || 8) * scale,
        type: 'road',
        // Without this, a road authored with trackStyle (e.g. 'tunnel') inside a
        // blueprint renders as a bare plain road once placed in the world — the
        // field survives inside the blueprint project but was silently dropped here.
        trackStyle: typeof road.trackStyle === 'string' && road.trackStyle ? road.trackStyle : null,
        surface: typeof road.surface === 'string' && road.surface ? road.surface : null,
        // Fixed elevations are currently world-space, matching world-map roads.
        elevation: Number.isFinite(Number(road.elevation)) && road.elevation !== null
          ? Number(road.elevation)
          : null,
      });
    }
  }
  return out;
}

/**
 * Collect every RIVER from placed blueprint entities, transformed into WORLD
 * frame (points + width + depth all scaled by the entity scale). Pure; mirrors
 * collectBlueprintRoads. Fed into the world river pipeline alongside
 * worldMap.rivers.
 */
export function collectBlueprintRivers(worldMap) {
  const out = [];
  const entities = (worldMap?.entities ?? []).filter((e) => e && e.blueprintId);
  for (const entity of entities) {
    const project = loadProjectSafe(entity.blueprintId);
    if (!project || !Array.isArray(project.rivers)) continue;
    const scale = Math.max(0.01, Number(entity.scale) || 1);
    const toWorld = makeLocalToWorld(entity);
    for (const river of project.rivers) {
      if (!Array.isArray(river?.points)) continue;
      const points = [];
      for (const p of river.points) {
        const lx = Number(p?.x);
        const lz = Number(p?.z);
        if (Number.isFinite(lx) && Number.isFinite(lz)) points.push(toWorld(lx, lz));
      }
      if (points.length < 2) continue;
      out.push({
        id: `${entity.id ?? '?'}:${river.id ?? '?'}`,
        points,
        width: Math.max(2, Number(river.width) || 10) * scale,
        depth: Math.max(1, Number(river.depth) || 6) * scale,
        type: 'river',
        // Without this, ocean-fill authored inside a blueprint reverts to a
        // plain river once placed — same class of bug fixed for roads'
        // trackStyle in collectBlueprintRoads.
        oceanLeft: river.oceanLeft === true,
        oceanRight: river.oceanRight === true,
      });
    }
  }
  return out;
}

function buildBlueprintManager(project) {
  try {
    const manager = new ChunkManager({
      chunkSize: project.chunkSize ?? 32,
      resolution: project.resolution ?? 33,
      seed: project.seed ?? 1337,
      amplitude: project.amplitude ?? 2.4,
      octaves: project.octaves ?? 5,
    });
    manager.loadProject(project);
    return manager;
  } catch {
    return null;
  }
}

/** Blueprint-local AABB (metres) spanning its authored chunk coords. */
function blueprintLocalAabb(project) {
  const size = project.chunkSize ?? 32;
  const chunks = Array.isArray(project.chunks) ? project.chunks : [];
  if (chunks.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of chunks) {
    const cx = Number(c.cx);
    const cz = Number(c.cz);
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
    minX = Math.min(minX, cx * size - size * 0.5);
    maxX = Math.max(maxX, cx * size + size * 0.5);
    minZ = Math.min(minZ, cz * size - size * 0.5);
    maxZ = Math.max(maxZ, cz * size + size * 0.5);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minZ, maxZ };
}

/** A blueprint-local XZ rect transformed to a world axis-aligned rect. */
function transformLocalRect(aabb, ex, ez, yawRad, scale) {
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  const corners = [
    [aabb.minX, aabb.minZ], [aabb.maxX, aabb.minZ],
    [aabb.minX, aabb.maxZ], [aabb.maxX, aabb.maxZ],
  ];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [lx, lz] of corners) {
    const wx = ex + scale * (lx * cos - lz * sin);
    const wz = ez + scale * (lx * sin + lz * cos);
    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
    minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
  }
  return { minX, maxX, minZ, maxZ };
}

/** Tallest base-ground height across a rect so a flat platform clears the terrain. */
function platformTopY(rect, baseGroundAt) {
  if (!baseGroundAt) return 0;
  const pts = [
    [rect.minX, rect.minZ], [rect.maxX, rect.minZ],
    [rect.minX, rect.maxZ], [rect.maxX, rect.maxZ],
    [(rect.minX + rect.maxX) * 0.5, (rect.minZ + rect.maxZ) * 0.5],
  ];
  let top = -Infinity;
  for (const [x, z] of pts) top = Math.max(top, baseGroundAt(x, z));
  return Number.isFinite(top) ? top : 0;
}

/** World AABB from local half-extents through a matrix (8-corner transform). */
function worldAabbFromHalfExtents(he, worldMatrix) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const [cx, cy, cz] of BOX_CORNERS) {
    _v.set(cx * he.x, cy * he.y, cz * he.z).applyMatrix4(worldMatrix);
    minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x);
    minY = Math.min(minY, _v.y); maxY = Math.max(maxY, _v.y);
    minZ = Math.min(minZ, _v.z); maxZ = Math.max(maxZ, _v.z);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function normalizeTile(tileIndex) {
  const n = Number(tileIndex);
  return Number.isFinite(n) ? Math.max(0, Math.min(99, Math.round(n))) : 0;
}
