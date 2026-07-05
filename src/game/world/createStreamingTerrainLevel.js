/**
 * createStreamingTerrainLevel.js
 *
 * The playable "World": an infinite, chunk-streaming terrain that Mara can walk
 * on. The procedural base is deterministic (same seed/params as the Map Builder),
 * and any edits authored in the Map Builder persist as an authored overlay on top
 * (loaded from localStorage). It returns the same level descriptor shape that
 * createInfiniteCityLevel returns, so LevelSystem / GameRuntime / PhysicsSystem
 * consume it unchanged.
 *
 * Streaming contract (consumed by GameRuntime + PhysicsSystem.applyStreamingChanges):
 *   updateStreaming(position) -> {
 *     addedChunks: [{ group, chunkKey }],          // group used for shader pre-warm
 *     removedChunkKeys: [chunkKey],                 // also drops Rapier heightfields by owner
 *     addedTerrainChunks: [{ cx, cz, size, resolution, heights, holeMask, chunkKey }],
 *   }
 */

import * as THREE from 'three';
import { ChunkManager } from '../../world/terrain/ChunkManager.js';
import { createTerrainChunkMesh } from '../../world/terrain/TerrainChunk.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { ZONE_TYPES, POI_KINDS, ENTITY_GROUND_MODES, TERRAIN_BIOMES } from '../../world/worldMap/worldMapSchema.js';
import { zoneContains, zoneDistanceOutside, zoneBounds } from '../../world/worldMap/zoneGeometry.js';
import {
  buildRoadProfile,
  applyRoadCorridorHeight,
  findNearestRoadPoint,
  TUNNEL_INTERIOR_HEIGHT,
} from '../../world/worldMap/roadProfile.js';
import { buildRiverProfile, applyRiverCorridorHeight } from '../../world/worldMap/riverProfile.js';
import { createTerrainBiomeMaterial } from '../materials/createTerrainBiomeMaterial.js';
import { createZoneForest } from './createZoneForest.js';
import { createForestZone } from './forest/createForestZone.js';
import { setForestLitterMask, clearForestLitterMask } from './forest/forestLitter.js';
import { createRoadworks, ROAD_SURFACE_LIFT } from './createRoadworks.js';
import { createTracksideLayers } from './createTracksideLayers.js';
import { createSpectatorCrowd } from './spectatorCrowd.js';
import { getQualityLevel } from '../config/qualityPresets.js';
import { isSpectatorCrowdEnabled } from '../config/renderDebugSettings.js';
import { createRiverworks } from './createRiverworks.js';
import { createBlueprintEntities, collectBlueprintRoads, collectBlueprintRivers, collectBlueprintTerrainTexture } from './createBlueprintEntities.js';
import { getGroundHeightAt as colliderGroundHeightAt } from './createBaseLevel.js';
import { createMudDeformField } from './mudDeformField.js';
import { surfaceForRoad } from '../../world/worldMap/roadSurface.js';

const DEFAULT_LOAD_RADIUS = 3;

// Max terrain chunks to build per streaming update. Building a whole ring edge
// (2*loadRadius+1 chunks) synchronously in one frame — procedural gen +
// seamless-normal resampling + Rapier heightfields — spiked the frame and
// rubber-banded the vehicle every time it crossed a 32 m chunk boundary
// (~once/second at car speed). Spreading the builds over a few frames keeps each
// frame cheap; nearest-first ordering + ensureGroundCollider (which force-builds
// the chunk under a dynamic vehicle immediately) make the lag at the far edge of
// the load ring invisible.
const DEFAULT_CHUNK_BUILDS_PER_FRAME = 2;
// Max terrain chunks to UNLOAD per streaming update. Each unload disposes a GPU
// geometry + removes a Rapier heightfield body, so a whole row going stale at once
// (a fast crossing) is its own main-thread lump. Slightly higher than the build
// cap so the live set stays bounded as new chunks stream in.
const DEFAULT_CHUNK_REMOVES_PER_FRAME = 3;

// Must match the Map Builder's ChunkManager params (src/map/MapBuilder.js) so the
// procedural base is identical and authored-overlay chunks seam cleanly into it.
const TERRAIN_PARAMS = {
  chunkSize: 32,
  resolution: 33,
  seed: 1729,
  amplitude: 2.8,
  octaves: 5,
};

// How far (world m) outside a flatten rect the terrain ramps from procedural → 0,
// so a city zone meets the surrounding terrain on a slope, not a cliff.
const FLATTEN_MARGIN = 16;
// Flatten target sits just BELOW the city road plane (y=0) so the road fully
// covers the terrain instead of z-fighting it (the green mottling on the street).
// The city's colliders/spawn stay at y=0; the player still stands on the road.
const FLATTEN_TARGET_Y = -0.25;

// Bridged road corridors float on a thin deck collider (see createRoadworks:
// DECK_THICK 0.6, deck top ≈ roadY). The terrain heightfield under a bridged
// corridor is HARD-clamped to roadY - BRIDGE_CLEARANCE (just below the deck
// underside) so it can never punch UP through the deck — which would put
// invisible blockers on the road for both the character and the dynamic vehicle,
// worst where tall alpine (wilds) amplitude would otherwise leave terrain far
// above the deck. The clamp is a hard min INDEPENDENT of corridor weight: a
// weighted blend (cap*w + h*(1-w)) does NOT bound the result, so the heightfield
// rose above the deck at the corridor edge. Going DEEPER than this clearance
// (the old 2.0 m) carved a trench at bridge FEET (where road ≈ terrain), and
// once the deck colliders stopped overhanging that trench the player fell into
// it. Deep gorges already sit far below roadY - BRIDGE_CLEARANCE, so min() leaves
// them untouched.
const BRIDGE_CLEARANCE = 0.8;

// The procedural sampler returns ~[-1, 1]; we multiply by an amplitude (metres) to
// give it real relief. Default for areas with no terrain-biome zone.
const BASE_TERRAIN_AMPLITUDE = 2.5;
// Blend distance (world m) outside a biome zone, so a Mountains zone rises from
// the surrounding terrain rather than stepping up at the boundary.
const BIOME_MARGIN = 48;

// Blend distance (world m) outside an elevation-constrained `terrain` zone (one
// with props.minHeight/maxHeight set), so "always above 0" (mountains) / "always
// below 0" (canyons) eases in rather than stepping at the zone edge.
const ELEVATION_MARGIN = 24;

export function createStreamingTerrainLevel(qualityPreset = {}, { worldMap = null, flattenZones = [], levelMode = 'city', renderer = null } = {}) {
  const loadRadius = qualityPreset.terrainLoadRadius ?? DEFAULT_LOAD_RADIUS;
  const unloadRadius = qualityPreset.terrainUnloadRadius ?? loadRadius + 1;
  const maxChunkBuildsPerFrame = qualityPreset.terrainChunkBuildsPerFrame ?? DEFAULT_CHUNK_BUILDS_PER_FRAME;
  const maxChunkRemovesPerFrame = qualityPreset.terrainChunkRemovesPerFrame ?? DEFAULT_CHUNK_REMOVES_PER_FRAME;
  const idlePrefetchRadius = qualityPreset.terrainIdlePrefetchRadius ?? 1;
  const lodRings = qualityPreset.terrainLodRings ?? [2, 4];
  const lodResolutions = qualityPreset.terrainLodResolutions ?? [33, 17, 9];
  const physicsRadius = qualityPreset.terrainPhysicsRadius ?? 3;
  let lastStreamingPosition = null;
  let lastStreamingAt = 0;

  // Road corridor query (assigned after the profile is built, below); shapeChunk +
  // sampleShapedHeight reference it via this closure (null until roads exist).
  let roadCorridor = null;
  let roadworks = null;
  let trackside = null;
  let spectatorCrowd = null;

  // River corridor query (assigned after the profile is built, below). Null until
  // the river profile exists so buildRiverProfile's sampleHeight (base + road +
  // blueprint) never includes the river carve itself — the same recursion guard
  // roads use. Rivers carve AFTER roads + blueprints, so they trench the final
  // graded surface.
  let riverCorridor = null;
  let riverworks = null;

  // Blueprint merge field ((wx,wz) -> { height, weight }), published after entities
  // are constructed and before the initial ring is shaped. shapeChunk +
  // sampleShapedHeight apply it identically so stamped terrain (merge-mode
  // entities) seams cleanly with the procedural base.
  let blueprintMergeSampler = null;
  // Per-vertex coverage (0..1) of the shared blueprint terrain texture over merge
  // footprints; assigned after blueprint entities are built (below). Baked into
  // each chunk's `bpTexMask` attribute when a blueprint terrain texture exists.
  let blueprintTexMask = null;

  // 1 inside any flatten zone, ramping to 0 over FLATTEN_MARGIN outside its edge.
  // flattenZones are full zone objects (rect or polygon).
  const flattenFactor = (x, z) => {
    let best = 0;
    for (const zone of flattenZones) {
      const d = zoneDistanceOutside(zone, x, z);
      const t = d <= 0 ? 1 : d >= FLATTEN_MARGIN ? 0 : 1 - d / FLATTEN_MARGIN;
      if (t > best) best = t;
    }
    return best;
  };

  // Per-zone height: terrain zones use their `biome` preset; `wilds` zones use the
  // tall `alpine` preset. Each entry keeps the zone object (rect or polygon).
  const biomeZones = (worldMap?.zones ?? [])
    .map((z) => {
      if (z.type === 'wilds') return { zone: z, isWilds: true, amplitude: TERRAIN_BIOMES.alpine.amplitude };
      if (z.type === 'terrain' && TERRAIN_BIOMES[z.props?.biome]) {
        return { zone: z, isWilds: false, amplitude: TERRAIN_BIOMES[z.props.biome].amplitude };
      }
      return null;
    })
    .filter(Boolean);

  // Wilds zones take PRIORITY over terrain-biome zones wherever they overlap
  // (the "wilds over terrain" rule): if a wilds zone covers (x,z) — even
  // partially, within BIOME_MARGIN — the wilds (alpine) amplitude wins outright
  // and terrain biomes are ignored. Terrain-biome amplitudes contribute only
  // where NO wilds zone covers the point. Each is blended back toward
  // BASE_TERRAIN_AMPLITUDE by its own coverage falloff, so there are no hard
  // steps at zone edges and adjacent chunks (sampling the same continuous
  // zoneDistanceOutside) seam cleanly.
  const biomeAmplitudeAt = (x, z) => {
    // 1) Strongest wilds coverage — winner-take-all over terrain biomes.
    let wildsW = 0;
    let wildsAmp = 0;
    for (const entry of biomeZones) {
      if (!entry.isWilds) continue;
      const d = zoneDistanceOutside(entry.zone, x, z);
      const w = d <= 0 ? 1 : d >= BIOME_MARGIN ? 0 : 1 - d / BIOME_MARGIN;
      if (w > wildsW) { wildsW = w; wildsAmp = entry.amplitude; }
    }
    if (wildsW > 0) {
      return BASE_TERRAIN_AMPLITUDE + (wildsAmp - BASE_TERRAIN_AMPLITUDE) * wildsW;
    }
    // 2) No wilds here — coverage-weighted average over terrain biomes only.
    let wSum = 0;
    let ampSum = 0;
    for (const entry of biomeZones) {
      if (entry.isWilds) continue;
      const d = zoneDistanceOutside(entry.zone, x, z);
      const w = d <= 0 ? 1 : d >= BIOME_MARGIN ? 0 : 1 - d / BIOME_MARGIN;
      if (w > 0) { wSum += w; ampSum += entry.amplitude * w; }
    }
    if (wSum <= 0) return BASE_TERRAIN_AMPLITUDE;
    const zoneAmp = ampSum / wSum;
    const coverage = Math.min(wSum, 1);
    return BASE_TERRAIN_AMPLITUDE + (zoneAmp - BASE_TERRAIN_AMPLITUDE) * coverage;
  };

  // Elevation-constrained `terrain` zones: props.minHeight guarantees the surface
  // never dips below it (e.g. "always > 0" so a mountain zone can never dip to sea
  // level); props.maxHeight guarantees it never rises above it (e.g. "always < 0"
  // for a canyon/valley floor). props.relief (metres) is how much natural variation
  // to preserve above the floor / below the ceiling — defaults to the zone's own
  // biome amplitude if unset. Either, both, or neither of min/max may be set.
  const elevationZones = (worldMap?.zones ?? [])
    .filter((z) => z.type === 'terrain')
    .map((z) => {
      const minHeight = Number(z.props?.minHeight);
      const maxHeight = Number(z.props?.maxHeight);
      const relief = Number(z.props?.relief);
      const hasMin = Number.isFinite(minHeight);
      const hasMax = Number.isFinite(maxHeight);
      if (!hasMin && !hasMax) return null;
      return {
        zone: z,
        minHeight: hasMin ? minHeight : null,
        maxHeight: hasMax ? maxHeight : null,
        relief: Number.isFinite(relief) && relief > 0 ? relief : null,
      };
    })
    .filter(Boolean);

  // REMAPS the natural noise into the requested band rather than clamping it.
  // A clamp (h = max(h, floor)) pins every point where the raw noise falls below
  // the floor to the SAME flat value — since noise averages ~0, that's most of a
  // zone, leaving a flat plateau with only rare peaks poking above it. Remapping
  // the ~[-amp, amp] noise into [0,1] and placing it inside [floor, floor+relief]
  // (or [ceiling-relief, ceiling]) instead means every point keeps its own
  // relative height, so the whole zone reads as rolling terrain sitting above the
  // floor (or below the ceiling), not a table with a few chimneys.
  // Winner-take-all coverage weighting (mirrors biomeAmplitudeAt) blended over
  // ELEVATION_MARGIN so the constraint eases in at the zone edge.
  const applyElevationZones = (x, z, h, amp) => {
    if (elevationZones.length === 0) return h;
    let minW = 0, minHeight = null, minRelief = null;
    let maxW = 0, maxHeight = null, maxRelief = null;
    for (const entry of elevationZones) {
      const d = zoneDistanceOutside(entry.zone, x, z);
      const t = d <= 0 ? 1 : d >= ELEVATION_MARGIN ? 0 : 1 - d / ELEVATION_MARGIN;
      if (t <= 0) continue;
      if (entry.minHeight !== null && t > minW) { minW = t; minHeight = entry.minHeight; minRelief = entry.relief; }
      if (entry.maxHeight !== null && t > maxW) { maxW = t; maxHeight = entry.maxHeight; maxRelief = entry.relief; }
    }
    if (minW <= 0 && maxW <= 0) return h;

    const safeAmp = Math.max(amp, 0.01);
    const noise01 = Math.max(0, Math.min(1, (h / safeAmp + 1) / 2));

    if (minW > 0 && maxW > 0) {
      // Both a floor and ceiling apply — remap straight into that band (the band
      // itself IS the relief; a separate relief field would be meaningless here).
      const lo = minHeight;
      const hi = Math.max(minHeight + 0.5, maxHeight);
      const target = lo + noise01 * (hi - lo);
      const w = Math.max(minW, maxW);
      return h * (1 - w) + target * w;
    }
    if (minW > 0) {
      const relief = minRelief ?? safeAmp;
      const target = minHeight + noise01 * relief;
      return h * (1 - minW) + target * minW;
    }
    const relief = maxRelief ?? safeAmp;
    const target = maxHeight - noise01 * relief;
    return h * (1 - maxW) + target * maxW;
  };

  // Shape a freshly-sampled chunk: scale procedural ([-1,1]) by the per-zone biome
  // amplitude (skipped for hand-authored sculpt chunks), then flatten under city
  // zones. Runs once per chunk; reloads re-sample fresh procedural.
  const shapeChunk = (data, cx, cz) => {
    if (data.__shaped) return;
    data.__shaped = true;
    const authored = manager.hasAuthored?.(cx, cz) ?? false;
    const hasFlatten = flattenZones.length > 0;
    const hasElevation = elevationZones.length > 0;
    if (authored && !hasFlatten && !hasElevation && !roadCorridor && !blueprintMergeSampler && !riverCorridor) return;

    const res = data.resolution;
    const step = data.size / (res - 1);
    const minX = data.cx * data.size - data.size * 0.5;
    const minZ = data.cz * data.size - data.size * 0.5;
    for (let j = 0; j < res; j += 1) {
      for (let i = 0; i < res; i += 1) {
        const wx = minX + i * step;
        const wz = minZ + j * step;
        const idx = j * res + i;
        let h = data.heights[idx];
        const amp = biomeAmplitudeAt(wx, wz);
        if (!authored) h *= amp;
        if (hasElevation) h = applyElevationZones(wx, wz, h, amp);
        if (hasFlatten) {
          const t = flattenFactor(wx, wz);
          if (t > 0) h = h * (1 - t) + FLATTEN_TARGET_Y * t;
        }
        // Stamp merge-mode blueprint terrain into the world FIRST, feathering its
        // edge into the procedural base. Must match sampleShapedHeight exactly so
        // the seamless normals (computed from sampleShapedHeight) agree with the
        // baked heightfield across the seam. Done before the road carve so a road
        // authored inside a blueprint grades the sculpted/merged surface instead of
        // being overwritten by the merge (which buried the carve at runtime).
        if (blueprintMergeSampler) {
          const m = blueprintMergeSampler(wx, wz);
          if (m.weight > 0) h = h * (1 - m.weight) + m.height * m.weight;
        }
        // Grade/clamp the terrain to the road corridor via the shared pure helper
        // (grounded grades toward roadY; bridged HARD-clamps to roadY-clearance so
        // the heightfield can't punch up through the thin deck box — worst in tall
        // alpine/wilds terrain). See applyRoadCorridorHeight for why the clamp is a
        // hard min independent of weight.
        if (roadCorridor) {
          h = applyRoadCorridorHeight(h, roadCorridor(wx, wz), BRIDGE_CLEARANCE);
        }
        // Carve terrain DOWN into the river channel via the shared pure helper
        // (blend toward bedY across the weight falloff). Mirrors the road pass and
        // must match sampleShapedHeight exactly so seamless normals agree.
        if (riverCorridor) {
          h = applyRiverCorridorHeight(h, riverCorridor(wx, wz));
        }
        data.heights[idx] = h;
      }
    }
  };

  const manager = new ChunkManager(TERRAIN_PARAMS);

  // NOTE: the legacy 3D Map-Builder sculpt overlay is intentionally NOT loaded
  // globally here. Those authored chunks are not biome-scaled, so they stepped
  // against the (now amplitude-scaled) procedural neighbours — a wall/gap seam at
  // the authored region's edge. World terrain is purely procedural + per-zone
  // biome, which is continuous everywhere. Merge-mode blueprint entities DO
  // re-introduce authored sculpt, but only inside each entity's footprint and
  // feathered over MERGE_FEATHER into the base (see createBlueprintEntities) — the
  // seam fix that was previously missing.

  const chunkSize = manager.chunkSize;
  const group = new THREE.Group();
  group.name = 'Streaming Terrain';

  // Resolved BEFORE the material so the biome shader can include the blueprint
  // texture-overlay branch (and chunks know to bake the `bpTexMask` attribute).
  const bpTerrainTexture = collectBlueprintTerrainTexture(worldMap);

  // One shared material for every terrain chunk: a single render pipeline, so
  // streamed-in chunks reuse the already-compiled pipeline and never need to be
  // hidden-until-compiled (which was causing the chunk-edge flicker while moving).
  // Height + slope blended PBR (sand → grass → rock → snow), plus the optional
  // single blueprint terrain texture painted over merge footprints.
  const terrainMaterial = createTerrainBiomeMaterial({
    overlay: bpTerrainTexture,
    hextile: qualityPreset.terrainHextile,
  });

  const liveChunks = new Map(); // chunkKey -> { handle, data, group, chunkKey, cx, cz }
  const geometryIndex = createLevelGeometryIndex(group);

  // 't:' prefix so terrain heightfield owner-keys never collide with city chunk
  // keys ('cx:cz') when both stream into one PhysicsSystem owner registry.
  const chunkKey = (cx, cz) => `t:${cx}:${cz}`;
  const coordForWorld = (value) => Math.floor((value + chunkSize * 0.5) / chunkSize);

  const terrainChunkPayload = (entry) => ({
    cx: entry.data.cx,
    cz: entry.data.cz,
    size: entry.data.size,
    resolution: entry.data.resolution,
    heights: entry.data.heights,
    holeMask: entry.data.holeMask,
    chunkKey: entry.chunkKey,
  });

  // Heightfields cannot contain holes. Mark authoritative terrain grid cells
  // whose centres lie inside a tunnel bore. Only terrain that intersects the
  // shell is removed from the visual and physical surface; high triangles remain
  // above the ceiling as collidable mountain cover (a trimesh is not a solid).
  const applyTunnelHoleMask = (data) => {
    if (data.__tunnelHolesApplied) return;
    data.__tunnelHolesApplied = true;
    if (!roadCorridor) return;
    const cells = data.resolution - 1;
    const step = data.size / cells;
    const minX = data.cx * data.size - data.size * 0.5;
    const minZ = data.cz * data.size - data.size * 0.5;
    let cutMask = null;
    for (let j = 0; j < cells; j += 1) {
      for (let i = 0; i < cells; i += 1) {
        const corridor = roadCorridor(minX + (i + 0.5) * step, minZ + (j + 0.5) * step);
        if (!corridor?.tunnel || corridor.withinRoad === false || corridor.weight < 0.999) continue;
        const a = j * data.resolution + i;
        const minTerrain = Math.min(
          data.heights[a],
          data.heights[a + 1],
          data.heights[a + data.resolution],
          data.heights[a + data.resolution + 1],
        );
        // Shell thickness + a small grid tolerance prevents the height surface
        // from clipping through the arched concrete at the cut boundary.
        if (minTerrain <= corridor.roadY + TUNNEL_INTERIOR_HEIGHT + 0.75) {
          cutMask ??= new Uint8Array(cells * cells);
          cutMask[j * cells + i] = 1;
        }
      }
    }
    if (cutMask) {
      data.holeMask = cutMask;
      data.visualHoleMask = cutMask;
    }
  };

  // The shaped surface height as a continuous function of world (x,z) — the same
  // value shapeChunk bakes for procedural chunks. Used to compute seamless normals.
  const sampleShapedHeight = (wx, wz) => {
    const ampAtSample = biomeAmplitudeAt(wx, wz);
    let h = manager.procedural(wx, wz) * ampAtSample;
    h = applyElevationZones(wx, wz, h, ampAtSample);
    const t = flattenFactor(wx, wz);
    if (t > 0) h = h * (1 - t) + FLATTEN_TARGET_Y * t;
    // Stamp merge-mode blueprint terrain FIRST (mirrors shapeChunk's pass exactly)
    // so the road carve below grades the sculpted/merged surface, not the raw
    // procedural base — a road authored inside a blueprint conforms to its sculpted
    // terrain (matching the editor) instead of being buried by the merge stamp.
    if (blueprintMergeSampler) {
      const m = blueprintMergeSampler(wx, wz);
      if (m.weight > 0) h = h * (1 - m.weight) + m.height * m.weight;
    }
    // Mirror shapeChunk's corridor pass by sharing applyRoadCorridorHeight, so
    // seamless normals, tree placement, and road-profile terrainY agree with the
    // baked heightfield by construction. roadCorridor is null during
    // buildRoadProfile (published afterwards), so this is correctly skipped while
    // the profile samples terrain — applying the clamp during profiling would push
    // terrainY toward roadY-clearance, flip grounded true, and stop deck colliders
    // from being built.
    if (roadCorridor) {
      h = applyRoadCorridorHeight(h, roadCorridor(wx, wz), BRIDGE_CLEARANCE);
    }
    // River carve (mirrors shapeChunk's pass exactly). riverCorridor is null during
    // buildRiverProfile (published afterwards), so profiling samples pre-river
    // terrain — no recursion.
    if (riverCorridor) {
      h = applyRiverCorridorHeight(h, riverCorridor(wx, wz));
    }
    return h;
  };

  // Replace per-chunk computed normals (one-sided at edges → bright seam lines)
  // with normals from central differences of the continuous height field, so
  // adjacent chunks agree exactly on shared-edge normals.
  //
  // The chunk's own `data.heights` already hold sampleShapedHeight at every grid
  // point (only called for non-authored chunks), so INTERIOR central differences
  // are plain array reads. Only the chunk's four edges need the continuous sampler
  // for their out-of-chunk neighbour (which is what makes the seam match). This
  // cuts ~4*res^2 sampleShapedHeight calls (the dominant per-chunk build cost — it
  // re-runs procedural+biome+road+river noise) down to the edge ring (~16*res),
  // which is what kept the streamed-chunk build cheap enough to not hitch at speed.
  const applySeamlessNormals = (geometry, data) => {
    const res = data.resolution;
    const size = data.size;
    const step = size / (res - 1);
    const minX = data.cx * size - size * 0.5;
    const minZ = data.cz * size - size * 0.5;
    const heights = data.heights;
    const normalAttr = geometry.attributes.normal;
    // Height at grid neighbour (i,j): array read when in-bounds, else the
    // continuous sampler at (wx,wz) so edge normals match the adjacent chunk.
    const hAt = (i, j, wx, wz) =>
      (i >= 0 && i < res && j >= 0 && j < res) ? heights[j * res + i] : sampleShapedHeight(wx, wz);
    for (let j = 0; j < res; j += 1) {
      for (let i = 0; i < res; i += 1) {
        const wx = minX + i * step;
        const wz = minZ + j * step;
        const nx = hAt(i - 1, j, wx - step, wz) - hAt(i + 1, j, wx + step, wz);
        const nz = hAt(i, j - 1, wx, wz - step) - hAt(i, j + 1, wx, wz + step);
        const ny = 2 * step;
        const inv = 1 / Math.hypot(nx, ny, nz);
        normalAttr.setXYZ(j * res + i, nx * inv, ny * inv, nz * inv);
      }
    }
    normalAttr.needsUpdate = true;
  };

  // Bake the shared blueprint texture's per-vertex coverage into a `bpTexMask`
  // attribute (one float per grid vertex, same order as heights/positions). 0
  // everywhere until blueprintTexMask is assigned (only matters if a chunk is
  // built before then, which the ordering avoids).
  const applyBlueprintTexMask = (geometry, data) => {
    const res = Math.round(Math.sqrt(geometry.attributes.position.count));
    const size = data.size;
    const step = size / (res - 1);
    const minX = data.cx * size - size * 0.5;
    const minZ = data.cz * size - size * 0.5;
    const arr = new Float32Array(res * res);
    if (blueprintTexMask) {
      for (let j = 0; j < res; j += 1) {
        for (let i = 0; i < res; i += 1) {
          arr[j * res + i] = blueprintTexMask(minX + i * step, minZ + j * step);
        }
      }
    }
    geometry.setAttribute('bpTexMask', new THREE.BufferAttribute(arr, 1));
  };

  const visualResolutionFor = (cx, cz, centerX, centerZ) => {
    const distance = Math.max(Math.abs(cx - centerX), Math.abs(cz - centerZ));
    const level = distance <= lodRings[0] ? 0 : distance <= lodRings[1] ? 1 : 2;
    return Math.min(TERRAIN_PARAMS.resolution, lodResolutions[level] ?? TERRAIN_PARAMS.resolution);
  };

  const createVisualHandle = (data, visualResolution) => {
    const handle = createTerrainChunkMesh(data, {
      material: terrainMaterial,
      castShadow: visualResolution === data.resolution,
      receiveShadow: true,
      visualResolution,
    });
    if (visualResolution === data.resolution && !(manager.hasAuthored?.(data.cx, data.cz) ?? false)) {
      applySeamlessNormals(handle.geometry, data);
    }
    if (bpTerrainTexture) applyBlueprintTexMask(handle.geometry, data);
    return handle;
  };

  function addChunk(cx, cz, centerX = cx, centerZ = cz) {
    const key = chunkKey(cx, cz);
    if (liveChunks.has(key)) return null;

    const data = manager.getOrCreateChunk(cx, cz);
    shapeChunk(data, cx, cz); // biome amplitude + city flatten before building the mesh
    applyTunnelHoleMask(data);
    const visualResolution = visualResolutionFor(cx, cz, centerX, centerZ);
    const handle = createVisualHandle(data, visualResolution);
    handle.mesh.name = `TerrainChunk ${key}`;
    group.add(handle.mesh);
    geometryIndex.addRoot(handle.mesh);

    const entry = { handle, data, group: handle.mesh, chunkKey: key, cx, cz, visualResolution, physicsActive: false };
    liveChunks.set(key, entry);
    return entry;
  }

  function removeChunk(entry) {
    geometryIndex.removeRoot(entry.group);
    entry.group.removeFromParent();
    // Dispose geometry only — the material is shared across all chunks.
    entry.group.geometry?.dispose();
    manager.unloadChunk(entry.cx, entry.cz);
    liveChunks.delete(entry.chunkKey);
  }

  function replaceChunkLOD(entry, visualResolution) {
    geometryIndex.removeRoot(entry.group);
    const oldMesh = entry.group;
    const handle = createVisualHandle(entry.data, visualResolution);
    handle.mesh.name = oldMesh.name;
    group.add(handle.mesh);
    geometryIndex.addRoot(handle.mesh);
    oldMesh.removeFromParent();
    oldMesh.geometry?.dispose();
    entry.handle = handle;
    entry.group = handle.mesh;
    entry.visualResolution = visualResolution;
  }

  // Roads authored inside placed blueprint entities, transformed to world frame
  // (pure — no terrain sampling). Merged with worldMap.roads below so blueprint
  // roads flow through the SAME carve + ribbon pipeline; the profile re-samples
  // world terrain, so they conform to placement terrain like a 2D-editor road.
  const bpRoads = collectBlueprintRoads(worldMap);
  const bpRivers = collectBlueprintRivers(worldMap);

  // Blueprint entities — Phase A: build the merge field (merge-mode entities) +
  // platform colliders. Done BEFORE roads so the road profile (below) samples the
  // sculpted/merged surface and a road authored inside a blueprint conforms to its
  // sculpted terrain — matching the editor — instead of being computed against the
  // raw procedural base and then buried by the merge stamp. Built BEFORE the
  // initial ring is shaped, so stamped terrain is baked into the first chunks.
  // baseGroundAt is sampleShapedHeight, which at this point still has
  // blueprintMergeSampler === null (set on the next line), so the base-ground
  // sample is the pre-merge analytic surface — no recursive merge.
  const blueprints = createBlueprintEntities(qualityPreset, {
    worldMap,
    baseGroundAt: sampleShapedHeight,
    terrainTexture: bpTerrainTexture,
  });
  blueprintMergeSampler = blueprints.mergeField;
  blueprintTexMask = blueprints.texMask;

  // Roads: build the auto-graded profile BEFORE shaping chunks. The profile
  // samples sampleShapedHeight (now including the merge stamp) while
  // roadCorridor is still null, then we publish roadCorridor so chunk shaping
  // grades to the road. Roadworks (ribbon + deck colliders) is built AFTER the
  // river profile so deck placement sees the carved channel under crossings.
  // Sources: world-map roads + world-frame blueprint roads.
  const allRoads = [...(worldMap?.roads ?? []), ...bpRoads];
  let roadProfile = null;
  if (allRoads.length) {
    const wildsZones = (worldMap.zones ?? []).filter((z) => z.type === 'wilds');
    const cityZones = (worldMap.zones ?? []).filter((z) => z.type === 'city');
    roadProfile = buildRoadProfile({
      roads: allRoads,
      sampleHeight: sampleShapedHeight,
      isWilds: (x, z) => wildsZones.some((zone) => zoneContains(zone, x, z)),
      isCity: (x, z) => cityZones.some((zone) => zoneContains(zone, x, z)),
      // Match the Map Builder editor: roads conform to terrain grade faithfully
      // (tiny smoothing, no grade clamp) so a blueprint road placed on a hill
      // matches its editor preview instead of sinking below the spline.
      // Finer 1 m samples (was 2 m) so curves read smooth, not faceted; smoothRadius
      // doubled to 4 to keep the same ~10 m metre-window (it counts in samples).
      sampleSpacing: 0.5,
      smoothRadius: 8,
      maxGrade: Infinity,
    });
    roadCorridor = roadProfile.corridorAt;
  }

  // Rally mud deform field (docs/rally-mud-tread-plan.md). Constructed ONLY in
  // rally mode AND only when the map actually contains a mud-surface road — every
  // other mode (and mud-less rally maps) leaves `mudField` null so getGroundHeightAt,
  // BaseVehicle, and the deform texture all cost zero. See the scope guarantee.
  const hasMudRoad = levelMode === 'rally' && allRoads.some((r) => surfaceForRoad(r) === 'mud');
  // Deep, churned, PERSISTENT ruts: FINE cells (0.15 m) so a skinny tyre-width
  // trough still has ~2 cells of falloff across it (crisp, not a one-cell spike),
  // a wide (~115 m) footprint so a run of tracks stays behind the car, and long
  // decay so ruts linger for ~40 s instead of melting in a few seconds.
  const mudField = hasMudRoad
    ? createMudDeformField({
      maxDepth: 0.25,
      cellSize: 0.15,
      resolution: 1024,
      depthTau: 40,
      treadTau: 22,
      wetnessTau: 16,
    })
    : null;

  // Rivers: build the carve profile + water surface AFTER roads + blueprints (so
  // each river trenches the final graded surface) but BEFORE the initial ring is
  // shaped, so the channel is baked into the first chunks. The profile samples
  // sampleShapedHeight while riverCorridor is still null (pure road+blueprint
  // terrain), then we publish riverCorridor so chunk shaping carves to the bed.
  // Sources: world-map rivers + world-frame blueprint rivers.
  const allRivers = [...(worldMap?.rivers ?? []), ...bpRivers];
  if (allRivers.length) {
    const riverProfile = buildRiverProfile({
      rivers: allRivers,
      sampleHeight: sampleShapedHeight,
      // Match the Map Builder editor: carve the channel into the actual surface,
      // not an over-smoothed average (which misplaces the bed on steep hills).
      smoothRadius: 2,
    });
    riverCorridor = riverProfile.corridorAt;
    riverworks = createRiverworks({ profile: riverProfile });
    group.add(riverworks.group);
  }

  if (roadProfile) {
    roadworks = createRoadworks({ profile: roadProfile, sampleHeight: sampleShapedHeight, mudField });
    group.add(roadworks.group);
    // GT3-style trackside stack (curbs/shoulders/walls) for roads with a trackStyle.
    // Its wall colliders go into level.colliders so the vehicle is contained.
    const qualityLevel = getQualityLevel();
    const useAnimatedSpectatorCrowd = isSpectatorCrowdEnabled() && qualityLevel !== 'low';
    trackside = createTracksideLayers({
      profile: roadProfile,
      sampleHeight: sampleShapedHeight,
      crowdQuality: useAnimatedSpectatorCrowd ? qualityLevel : 'low',
    });
    if (trackside.group.children.length) group.add(trackside.group);
    if (useAnimatedSpectatorCrowd && trackside.crowdPlacements?.length) {
      spectatorCrowd = createSpectatorCrowd({
        placements: trackside.crowdPlacements,
        quality: qualityLevel,
      });
      group.add(spectatorCrowd.group);
      spectatorCrowd.load().catch((err) => {
        console.warn('[level] spectator crowd failed to load', err);
      });
    }
  }

  // Build the initial ring synchronously around the actual map spawn so Rapier has
  // ground beneath the character before the first streaming update. Building this
  // around world origin left remote saved-map spawns (including city zones) with
  // only analytic/visual ground during physics initialization.
  const initialEntries = [];
  const initialCenterX = coordForWorld(worldMap?.spawn?.x ?? 0);
  const initialCenterZ = coordForWorld(worldMap?.spawn?.z ?? 0);
  // Only the near/physics ring is synchronous. Outer visual LOD rings stream in
  // under the normal per-frame build budget instead of extending level-load time.
  const initialRadius = Math.min(loadRadius, physicsRadius);
  for (let cx = initialCenterX - initialRadius; cx <= initialCenterX + initialRadius; cx += 1) {
    for (let cz = initialCenterZ - initialRadius; cz <= initialCenterZ + initialRadius; cz += 1) {
      const entry = addChunk(cx, cz, initialCenterX, initialCenterZ);
      if (entry) initialEntries.push(entry);
    }
  }

  const groundAt = (x, z) => manager.getHeightAt(x, z);

  // World-map overlay: zone tints + POI markers (visual only — not added to the
  // geometry index, so they never affect traversal/hook raycasts). Spawn comes
  // from the map. Without a map, this is plain infinite terrain.
  let spawnPoint;
  if (worldMap) {
    spawnPoint = new THREE.Vector3(worldMap.spawn.x, groundAt(worldMap.spawn.x, worldMap.spawn.z), worldMap.spawn.z);
    const overlay = buildWorldMapOverlay(worldMap, groundAt);
    if (overlay) group.add(overlay);
  } else {
    spawnPoint = new THREE.Vector3(0, groundAt(0, 0), 0);
  }

  // Wilds zones: a polygon-masked instanced forest on the (alpine-shaped) terrain.
  // Uses the continuous shaped-height sampler so trees sit on the same surface the
  // chunks/heightfield use. NOT added to the geometry index (no tree raycasts).
  const wildsZones = (worldMap?.zones ?? []).filter((z) => z.type === 'wilds');
  let forest = null;
  if (wildsZones.length > 0) {
    forest = createZoneForest({
      zones: wildsZones,
      sampleHeight: sampleShapedHeight,
      forestCount: qualityPreset.wildsForestCount,
      // These profiles contain both map-authored vectors and blueprint-local
      // vectors after their placement transform into world coordinates.
      roadCorridor,
      riverCorridor,
    });
    if (forest.group) group.add(forest.group);
  }

  // Blueprint entities — Phase B: place object meshes on the resolved surface
  // (none/merge → shaped terrain via sampleGround; platform → flat top) and derive
  // their world colliders. Runs once the shaped surface (incl. merge) exists. Meshes
  // join the scene group + geometry index so traversal/hook raycasts see them.
  blueprints.placeObjects({ sampleGround: sampleShapedHeight });
  if (blueprints.meshes.length) {
    group.add(blueprints.group);
    for (const mesh of blueprints.meshes) geometryIndex.addRoot(mesh);
  }

  const colliders = [
    ...(roadworks?.colliders ?? []),
    ...(trackside?.colliders ?? []),
    ...blueprints.colliders,
  ];

  // Forest zones: SeedThree procedural trees with LOD rebinning + impostors (M3+).
  const forestMapZones = (worldMap?.zones ?? []).filter((z) => z.type === 'forest');
  let forestZone = null;
  const forestZoneReady = forestMapZones.length > 0
    ? createForestZone({
      zones: forestMapZones,
      sampleHeight: sampleShapedHeight,
      roadCorridor,
      riverCorridor,
      findNearestRoadPoint: (x, z, options) =>
        roadProfile ? findNearestRoadPoint(roadProfile, x, z, options) : null,
      qualityPreset,
      renderer,
    }).then((built) => {
      forestZone = built;
      if (built.group) group.add(built.group);
      if (built.colliders?.length) colliders.push(...built.colliders);
      if (built.litterMask) {
        setForestLitterMask(built.litterMask);
      }
      return built;
    })
    : Promise.resolve(null);

  for (const entry of initialEntries) {
    const distance = Math.max(Math.abs(entry.cx - initialCenterX), Math.abs(entry.cz - initialCenterZ));
    entry.physicsActive = distance <= physicsRadius;
  }

  return {
    name: worldMap ? `World Map: ${worldMap.name ?? 'Untitled'}` : 'Streaming Terrain',
    group,
    // Bridge deck colliders (static; built once) + blueprint platform/object
    // colliders. PhysicsSystem builds these and getGroundHeightAt stands the
    // player on them.
    colliders,
    ledges: [],
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    geometryIndex,
    spawnPoint,
    // Rally mud deformation field (null unless this is a rally map with a mud
    // road). VehicleSystem stamps tyre ruts into it and decays it per frame;
    // getGroundHeightAt (above) folds it into the analytic surface.
    mudField,
    spectatorCrowd,
    // Heightfields for these are built at physics init; streaming handles the rest.
    terrainChunks: initialEntries.filter((entry) => entry.physicsActive).map(terrainChunkPayload),

    ready: forestZoneReady,

    updateForestEnvironment: (env) => {
      forestZone?.updateEnvironment?.(env);
    },

    updateForestDrivingColliders: (position, physics) => {
      forestZone?.updateDrivingColliders?.(position, physics);
    },

    updateForestAmbience: (position, delta) => {
      forestZone?.updateAmbience?.(position, delta);
    },

    wakeForestAmbience: () => {
      forestZone?.wakeAmbience?.();
    },

    updateStreaming: (position, options = {}) => {
      const lodCenter = options.viewPosition ?? position;
      if (forest && lodCenter) forest.setCameraPosition(lodCenter);
      if (forestZone && lodCenter) forestZone.setCameraPosition(lodCenter);
      roadworks?.updateLOD?.(position);
      trackside?.updateLOD?.(position);
      const current = {
        x: coordForWorld(position?.x ?? 0),
        z: coordForWorld(position?.z ?? 0),
      };
      const addedChunks = [];
      const addedTerrainChunks = [];
      const removedChunkKeys = [];
      const now = performance.now();
      let streamSpeed = Infinity;
      if (position && lastStreamingPosition && now > lastStreamingAt) {
        streamSpeed = Math.hypot(
          position.x - lastStreamingPosition.x,
          position.z - lastStreamingPosition.z,
        ) / ((now - lastStreamingAt) / 1000);
      }
      if (position) {
        lastStreamingPosition ??= new THREE.Vector2();
        lastStreamingPosition.set(position.x, position.z);
        lastStreamingAt = now;
      }
      // Spend one otherwise quiet build on a deeper ring while stopped/walking.
      // The reserve is discarded naturally once driving resumes.
      const idlePrefetch = streamSpeed < 8 ? idlePrefetchRadius : 0;
      const targetLoadRadius = loadRadius + idlePrefetch;

      // Change at most one already-live visual per frame to avoid an LOD-ring
      // boundary causing a burst of geometry allocation.
      for (const entry of liveChunks.values()) {
        const wanted = visualResolutionFor(entry.cx, entry.cz, current.x, current.z);
        if (wanted === entry.visualResolution) continue;
        replaceChunkLOD(entry, wanted);
        break;
      }

      // Physics follows only the near field; distant LOD chunks remain visual.
      for (const entry of liveChunks.values()) {
        const distance = Math.max(Math.abs(entry.cx - current.x), Math.abs(entry.cz - current.z));
        const wanted = distance <= physicsRadius;
        if (wanted === entry.physicsActive) continue;
        entry.physicsActive = wanted;
        if (wanted) addedTerrainChunks.push(terrainChunkPayload(entry));
        else removedChunkKeys.push(entry.chunkKey);
      }

      // Unload stale first so BatchedMesh buffer space is reclaimed (deleteGeometry + optimize)
      // before we add new chunks. Prevents high-water from spiking over the max during movement.
      const stale = [];
      for (const entry of liveChunks.values()) {
        const dx = Math.abs(entry.cx - current.x);
        const dz = Math.abs(entry.cz - current.z);
        if (dx <= unloadRadius + idlePrefetch && dz <= unloadRadius + idlePrefetch) continue;
        stale.push({ entry, distSq: dx * dx + dz * dz });
      }
      if (stale.length > 1) {
        stale.sort((a, b) => b.distSq - a.distSq);
      }
      const removeCount = Math.min(stale.length, maxChunkRemovesPerFrame);
      for (let i = 0; i < removeCount; i += 1) {
        removedChunkKeys.push(stale[i].entry.chunkKey);
        removeChunk(stale[i].entry);
      }

      // Collect every not-yet-live coord in the load window, then build only a
      // few (nearest-first) this frame. The remaining coords are re-detected on
      // the next update and drained over subsequent frames — this is the spread
      // that removes the per-boundary frame spike (see DEFAULT_CHUNK_BUILDS_PER_FRAME).
      const missing = [];
      for (let cx = current.x - targetLoadRadius; cx <= current.x + targetLoadRadius; cx += 1) {
        for (let cz = current.z - targetLoadRadius; cz <= current.z + targetLoadRadius; cz += 1) {
          if (liveChunks.has(chunkKey(cx, cz))) continue;
          const dx = cx - current.x;
          const dz = cz - current.z;
          missing.push({ cx, cz, distSq: dx * dx + dz * dz });
        }
      }
      if (missing.length > 1) {
        missing.sort((a, b) => a.distSq - b.distSq);
      }
      const buildCount = Math.min(missing.length, maxChunkBuildsPerFrame + (idlePrefetch ? 1 : 0));
      for (let i = 0; i < buildCount; i += 1) {
        const entry = addChunk(missing[i].cx, missing[i].cz, current.x, current.z);
        if (!entry) continue;
        // NOTE: deliberately NOT pushed to addedChunks — terrain chunks share
        // one already-compiled pipeline, so they don't go through the
        // hide-until-compiled path (that hide was the streaming flicker).
        const distance = Math.max(Math.abs(entry.cx - current.x), Math.abs(entry.cz - current.z));
        entry.physicsActive = distance <= physicsRadius;
        if (entry.physicsActive) addedTerrainChunks.push(terrainChunkPayload(entry));
      }

      return { addedChunks, removedChunkKeys, addedTerrainChunks };
    },

    // Multi-sample around the foot radius (matches createChunkedTerrain) so the
    // controller never sinks into a lower interpolated cell. getHeightAt is
    // infinite (procedural fallback outside authored/loaded chunks).
    getGroundHeightAt: (position, radius = 0.28, options = {}) => {
      const centerCorridor = roadCorridor?.(position.x, position.z);
      const insideTunnel = !!(centerCorridor?.tunnel && centerCorridor.withinRoad !== false && centerCorridor.weight >= 0.999);
      const c = insideTunnel ? centerCorridor.roadY : manager.getHeightAt(position.x, position.z);
      let ground = c;
      if (!insideTunnel && radius > 0.01) {
        const r = radius * 0.7;
        ground = Math.max(
          c,
          manager.getHeightAt(position.x + r, position.z),
          manager.getHeightAt(position.x - r, position.z),
          manager.getHeightAt(position.x, position.z + r),
          manager.getHeightAt(position.x, position.z - r),
          manager.getHeightAt(position.x + r * 0.7, position.z + r * 0.7),
          manager.getHeightAt(position.x - r * 0.7, position.z - r * 0.7),
        );
      }
      // Stand on bridge decks: analytic lookup over deck colliders, gated by the
      // caller's step/snap window so you aren't yanked up from under a bridge.
      if (roadworks?.colliders.length) {
        const deckY = colliderGroundHeightAt({
          position, radius,
          maxStepUp: options.maxStepUp,
          maxSnapDown: options.maxSnapDown,
          colliders: roadworks.colliders,
          baseHeight: -Infinity,
        });
        if (deckY > ground) ground = deckY;
      }
      // Stand on blueprint platforms + object tops: analytic lookup over the
      // entity colliders (Math.max so platform tops win where they overlap).
      if (blueprints.colliders.length) {
        const bpY = colliderGroundHeightAt({
          position, radius,
          maxStepUp: options.maxStepUp,
          maxSnapDown: options.maxSnapDown,
          colliders: blueprints.colliders,
          baseHeight: -Infinity,
        });
        if (bpY > ground) ground = bpY;
      }
      // Vehicle spawn: the paved ribbon (and deck colliders on bridges) sit
      // ROAD_SURFACE_LIFT above the graded terrain heightfield. Characters walk
      // the heightfield; a rigid chassis must clear the actual drivable surface.
      if (options.preferRoadSurface && centerCorridor?.weight > 0.5 && centerCorridor.grounded) {
        ground = Math.max(ground, centerCorridor.roadY + ROAD_SURFACE_LIFT);
      }
      // Rally mud ruts sink the analytic surface so the character/vehicle ground
      // query follows the tyre troughs. Null (and zero) everywhere but a stamped
      // mud corridor in rally mode, so this is inert elsewhere.
      if (mudField) {
        const sink = mudField.sampleDepthAt(position.x, position.z);
        if (sink > 0) ground -= sink;
      }
      return ground;
    },

    // A corridor includes a six-metre terrain feather beyond the visible ribbon.
    // Vehicle surfaces intentionally change only on the full-strength road deck;
    // the feather and surrounding terrain are off-road.
    getRoadSurfaceAt: (x, z) => {
      const corridor = roadCorridor?.(x, z);
      return corridor?.withinRoad !== false && corridor?.weight >= 0.999
        ? (corridor.surface ?? 'asphalt')
        : null;
    },

    findNearestRoadPoint: (x, z, options) =>
      roadProfile ? findNearestRoadPoint(roadProfile, x, z, options) : null,

    // Guarantee a physics heightfield exists under `position` without forcing a
    // complete visual chunk/BatchedMesh attachment outside the streaming budget.
    //
    // Why: the character controller rides the ANALYTIC ground (getGroundHeightAt),
    // so a chunk can be visually live without ever having a heightfield built — and
    // because streaming only emits NEWLY-live chunks, that missing heightfield is
    // never backfilled. A dynamic vehicle is a real rigid body, so spawning one on
    // such a chunk drops it through the world. Call this before spawning a ground
    // vehicle so it always has real ground to land on, regardless of streaming state.
    // `maxBuilds` caps how many missing heightfields one call may force-build
    // (shapeChunk is main-thread heavy), so a driving-lookahead prefetch can
    // spread a fresh ring over several frames instead of hitching one.
    ensureGroundCollider: (position, physics, { radiusChunks = 1, maxBuilds = Infinity } = {}) => {
      if (!physics?.createTerrainHeightfield) return false;
      const ccx = coordForWorld(position.x);
      const ccz = coordForWorld(position.z);
      let built = 0;
      for (let cx = ccx - radiusChunks; cx <= ccx + radiusChunks; cx += 1) {
        for (let cz = ccz - radiusChunks; cz <= ccz + radiusChunks; cz += 1) {
          if (built >= maxBuilds) return built > 0;
          const key = chunkKey(cx, cz);
          const entry = liveChunks.get(key);
          if (physics.hasStaticOwner?.(key)) continue;
          // If the visual isn't live, create only the shaped height data. The
          // normal streaming queue will attach its mesh later under its cap.
          const data = entry?.data ?? manager.getOrCreateChunk(cx, cz);
          shapeChunk(data, cx, cz);
          applyTunnelHoleMask(data);
          physics.createTerrainHeightfield({
            cx, cz,
            size: data.size,
            resolution: data.resolution,
            heights: data.heights,
            holeMask: data.holeMask,
            chunkKey: key,
          }, key);
          built += 1;
        }
      }
      return built > 0;
    },

    // Terrain is never a vertical wall; the heightfield provides the surface.
    getBlockingColliderAt: () => null,

    // Water surface query for the character swim detector (MovementSystem). Returns
    // { waterY, weight } at a world point; weight 0 outside every river corridor.
    getWaterHeightAt: (position) =>
      riverworks ? riverworks.getWaterHeightAt(position) : { waterY: 0, weight: 0 },

    snapshot: () => ({
      liveChunks: liveChunks.size,
      trees: forest?.count ?? 0,
      forestTrees: forestZone?.count ?? 0,
      forestArchetypes: forestZone?.snapshot?.()?.forestArchetypes ?? 0,
      forestNear: forestZone?.snapshot?.()?.forestNear ?? 0,
      forestImpostors: forestZone?.snapshot?.()?.forestImpostors ?? 0,
      forestRebinMs: forestZone?.snapshot?.()?.forestRebinMs ?? 0,
      forestNearRadius: forestZone?.snapshot?.()?.forestNearRadius ?? 0,
      forestFarRadius: forestZone?.snapshot?.()?.forestFarRadius ?? 0,
      forestOffRoadPool: forestZone?.snapshot?.()?.forestOffRoadPool ?? 0,
      forestAmbience: forestZone?.snapshot?.()?.forestAmbience ?? false,
      ...manager.getStats(),
    }),

    _manager: manager,

    dispose: () => {
      clearForestLitterMask();
      forest?.dispose?.();
      forestZone?.dispose?.();
      roadworks?.dispose?.();
      trackside?.dispose?.();
      spectatorCrowd?.dispose?.();
      riverworks?.dispose?.();
      blueprints?.dispose?.();
      geometryIndex.dispose();
      for (const entry of [...liveChunks.values()]) {
        entry.group.removeFromParent();
        disposeObject3D(entry.group);
      }
      liveChunks.clear();
      disposeObject3D(group);
    },
  };
}

// Visual-only overlay so you can see the authored layout while walking the
// terrain: a translucent tinted slab per zone + a colored pole/orb per POI.
// Not registered with the geometry index, so it never blocks raycasts.
function buildWorldMapOverlay(worldMap, groundAt) {
  const overlay = new THREE.Group();
  overlay.name = 'World Map Overlay';
  overlay.userData.noCollision = true;
  // Off by default — the minimap shows the layout now. Toggle via the P debug menu.
  overlay.userData.worldZoneOverlay = true;
  overlay.visible = false;

  for (const zone of worldMap.zones ?? []) {
    // City zones are filled by the real city generator in the composed level, so
    // don't draw a tint slab over them.
    if (zone.type === 'city') continue;
    const color = ZONE_TYPES[zone.type]?.color ?? '#888888';
    const b = zoneBounds(zone);
    if (!(b.maxX > b.minX && b.maxZ > b.minZ)) continue;
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    // Float the slab just above the highest sampled corner so it reads as a marker.
    const topY = Math.max(
      groundAt(b.minX, b.minZ), groundAt(b.maxX, b.minZ),
      groundAt(b.minX, b.maxZ), groundAt(b.maxX, b.maxZ), groundAt(cx, cz),
    ) + 0.4;
    const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false });
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });

    if (zone.shape === 'polygon') {
      const shape = new THREE.Shape();
      shape.moveTo(zone.points[0].x, zone.points[0].z);
      for (let i = 1; i < zone.points.length; i += 1) shape.lineTo(zone.points[i].x, zone.points[i].z);
      shape.closePath();
      // ShapeGeometry is in the XY plane; rotateX(+90°) maps its Y → world Z.
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2), fillMat);
      fill.position.y = topY;
      fill.name = `Zone Tint ${zone.type}`;
      overlay.add(fill);
      const ring = zone.points.map((p) => new THREE.Vector3(p.x, topY, p.z));
      ring.push(ring[0].clone());
      overlay.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), lineMat));
    } else {
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), fillMat);
      fill.position.set(cx, topY, cz);
      fill.name = `Zone Tint ${zone.type}`;
      overlay.add(fill);
      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.02, d)),
        lineMat,
      );
      border.position.set(cx, topY, cz);
      overlay.add(border);
    }
  }

  const poleGeom = new THREE.CylinderGeometry(0.08, 0.08, 2.4, 6);
  const orbGeom = new THREE.SphereGeometry(0.35, 12, 8);
  for (const poi of worldMap.pois ?? []) {
    const color = POI_KINDS[poi.kind]?.color ?? '#ffffff';
    const base = groundAt(poi.x, poi.z);
    const mat = new THREE.MeshBasicMaterial({ color });

    const pole = new THREE.Mesh(poleGeom, mat);
    pole.position.set(poi.x, base + 1.2, poi.z);
    overlay.add(pole);

    const orb = new THREE.Mesh(orbGeom, mat);
    orb.position.set(poi.x, base + 2.6, poi.z);
    overlay.add(orb);
  }

  // Entity (placed blueprint) markers: a ground-mode-coloured pad sized by scale
  // + a thin pole, so placed blueprints are visible when the overlay is toggled on.
  for (const entity of worldMap.entities ?? []) {
    const color = ENTITY_GROUND_MODES[entity.groundMode]?.color ?? '#cccccc';
    const base = groundAt(entity.x, entity.z);
    const mat = new THREE.MeshBasicMaterial({ color });
    const s = Math.max(0.5, Number(entity.scale) || 1);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(2 * s, 0.16, 2 * s), mat);
    pad.position.set(entity.x, base + 0.3, entity.z);
    pad.rotation.y = (Number(entity.yaw) || 0) * Math.PI / 180;
    pad.name = `Entity Pad ${entity.id}`;
    overlay.add(pad);
    const pole = new THREE.Mesh(poleGeom, mat);
    pole.position.set(entity.x, base + 1.2, entity.z);
    overlay.add(pole);
  }

  return overlay.children.length > 0 ? overlay : null;
}
