import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color } from 'three/tsl';
import { createWaterMaterial } from '../materials/createWaterMaterial.js';
import { createSceneSurfaceMaterial } from '../materials/createSceneSurfaceMaterial.js';
import { createMallWaterHeightfield } from '../render/createMallWaterHeightfield.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { createMaterialWarmupGroup } from './createMaterialWarmupGroup.js';
import { getBlockingColliderAt, getGroundHeightAt } from './createBaseLevel.js';
import { scatterForestPlacements } from './forest/forestPlacement.js';
import { placementToTrunkCollider } from './forest/forestColliders.js';
import { createMudDeformField } from './mudDeformField.js';
import {
  CITY_SEED,
  createCityMaterialWarmupGroup,
  createGeneratorCityLevel,
  getCityStride,
} from './createGeneratorCityLevel.js';
import { createSkyscraperMaterial } from '../../three-addons/generators/city/SkyscraperGenerator.js';

const PARK_HALF_X = 30;
const PARK_HALF_Z = 22.5;
/**
 * Grass apron past the fence before city cement starts. City clearRect uses the
 * same extent so asphalt/sidewalk don't poke through under the lawn.
 */
const LAWN_OVERSHOOT = 14;
/** Keep city roads/buildings/furniture outside the grass apron. */
const CITY_CLEAR_MARGIN = LAWN_OVERSHOOT;
/**
 * Chebyshev radius of full downtown tiles around the carved park block.
 * Default 0 = center tile only (fence-adjacent real buildings). Radius 1 is
 * nine full downtown generators and tanks GPU draw cost — avoid unless needed.
 * Skip entirely with dogParkSkipCity: true.
 */
const CITY_RING_RADIUS = 0;
const FLOOR_Y = 0;
const MUD_Y = 0.052;
const WATER_Y = 0.04;
const LAKE = Object.freeze({ x: 16, z: 8, radiusX: 8, radiusZ: 5.5 });
const MUD_PATCHES = Object.freeze([
  Object.freeze({ name: 'West Mud Wallow', x: -21, z: -5, radiusX: 3.6, radiusZ: 2.25 }),
  Object.freeze({ name: 'Lake Shore Mud', x: 10.5, z: 8.2, radiusX: 3.2, radiusZ: 2.1 }),
]);

/**
 * Finite, deterministic dog-park level. Architecture stays deliberately simple,
 * while water and trees use the same material/forest paths as world levels.
 * Ground + props use shared hex-tiled PBR surfaces (`createSceneSurfaceMaterial`).
 */
export function createDogParkLevel(qualityPreset = {}, { renderer = null } = {}) {
  const group = new THREE.Group();
  group.name = 'Riverside Dog Park';
  group.userData.freezeStaticWorldMatrices = true;

  const colliders = [];
  const walkableSurfaces = [];
  const surfaceZones = [];
  // 256² is enough for dog-scale ruts; 512² was a large empty GPU texture upload
  // surface and amplified mudField.syncTexture cost in dog-park traces.
  const mudField = createMudDeformField({
    cellSize: 0.1,
    resolution: 256,
    maxDepth: 0.16,
    depthTau: 110,
    treadTau: 80,
    wetnessTau: 65,
    maxFootprints: 120,
    footprintFadeTau: 0.7,
  });
  const mudTexture = mudField.ensureTexture();
  const surfaceOpts = { qualityPreset };
  // Deformable mud wallow: shared PBR path + hex tile, same deform field as before.
  const mudMaterial = createSceneSurfaceMaterial('mud', {
    ...surfaceOpts,
    deformTexture: mudTexture,
    orientationTexture: mudField.orientationTexture,
    deformTilesPerMetre: mudField.deformTilesPerMetre,
    deformSinkScale: mudField.maxDepth,
    deformCenter: mudField.centerUniform,
    deformFadeNear: mudField.footprint * 0.42,
    deformFadeFar: mudField.footprint * 0.49,
  });
  mudMaterial.side = THREE.DoubleSide;
  mudMaterial.userData.dogParkMud = true;
  const materials = {
    lawn: createSceneSurfaceMaterial('grass', surfaceOpts),
    sand: createSceneSurfaceMaterial('sand', surfaceOpts),
    dirt: createSceneSurfaceMaterial('dirt', surfaceOpts),
    mud: mudMaterial,
    wood: createSceneSurfaceMaterial('wood', surfaceOpts),
    fence: createSceneSurfaceMaterial('fence', surfaceOpts),
    metal: createSceneSurfaceMaterial('metal', surfaceOpts),
    curb: createSceneSurfaceMaterial('curb', surfaceOpts),
    water: createWaterMaterial(),
  };
  // Ground planes are single-sided; double-side only for thin props if needed.
  materials.lawn.side = THREE.FrontSide;
  materials.sand.side = THREE.DoubleSide;
  materials.dirt.side = THREE.DoubleSide;
  // Agility tube is an open cylinder — need PBR on the interior when dogs run through.
  materials.tunnel = materials.metal.clone();
  materials.tunnel.side = THREE.DoubleSide;
  materials.tunnel.userData = {
    ...(materials.metal.userData ?? {}),
    ...(materials.tunnel.userData ?? {}),
    sceneSurface: 'metal',
    dogParkTunnel: true,
  };
  const pawTrailVisual = createDogPawTrailVisual(160);
  group.add(pawTrailVisual.mesh);
  materials.pawPrint = pawTrailVisual.mesh.material;

  addLawn(group, materials.lawn);

  addSurfacePatch(group, surfaceZones, 'Sand Dog Run', [-13, 0.012, 7], [21, 0.025, 11], materials.sand, {
    surfaceClass: 'sand',
  });
  addBox(group, colliders, 'Sand Run Curb North', [-13, 0.11, 12.5], [21.5, 0.22, 0.25], materials.curb, { collider: true });
  addBox(group, colliders, 'Sand Run Curb South', [-13, 0.11, 1.5], [21.5, 0.22, 0.25], materials.curb, { collider: true });
  addBox(group, colliders, 'Sand Run Curb West', [-23.5, 0.11, 7], [0.25, 0.22, 11.25], materials.curb, { collider: true });
  addBox(group, colliders, 'Sand Run Curb East', [-2.5, 0.11, 7], [0.25, 0.22, 11.25], materials.curb, { collider: true });

  addSurfacePatch(group, surfaceZones, 'South Dirt Path', [0, 0.018, -12.2], [45, 0.035, 2.7], materials.dirt, {
    surfaceClass: 'dirt',
  });
  addSurfacePatch(group, surfaceZones, 'Lake Dirt Path', [8.5, 0.019, -3.5], [2.8, 0.037, 18], materials.dirt, {
    surfaceClass: 'dirt',
  });

  for (const patch of MUD_PATCHES) {
    addDeformMudPatch(
      group,
      surfaceZones,
      patch.name,
      patch.x,
      patch.z,
      patch.radiusX,
      patch.radiusZ,
      materials.mud,
    );
  }
  createLake(group, materials.water, materials.dirt);

  // One bounded spring/deposit field spans both authored wallows. It is sparse
  // visually until an impact, but shares the aquarium floor-water mechanics.
  // Lower-res spring mesh — full 112×64 double-loop update was a top CPU self-time
  // hotspot in dog-park traces even when barely wet.
  const mudBlob = createMallWaterHeightfield({
    centerX: -5.5,
    centerZ: 1.5,
    width: 44,
    depth: 24,
    columns: 48,
    rows: 28,
    floorY: MUD_Y,
    parent: group,
    name: 'Dog Park Ground Mud Blob',
    appearance: 'mud',
  });
  let flopImpactCount = 0;
  let npcFlopImpactCount = 0;

  addFence(group, colliders, materials.fence);
  addPlayStructure(group, colliders, walkableSurfaces, materials);
  addParkFurniture(group, colliders, materials);

  // Real downtown near the fence (default: center tile only). The far skyline
  // matte sits *behind* this city, not around the park fence.
  const cityRadius = resolveDogParkCityRadius(qualityPreset);
  const cityChunks = cityRadius == null
    ? []
    : buildDogParkCityRing(group, colliders, {
      ...qualityPreset,
      dogParkCityRadius: cityRadius,
    });

  // Thin connected building-face wall on the outer edge of the city tiles —
  // occludes empty draw distance behind the real blocks. Opt out:
  // dogParkSkipSkylineMatte: true.
  const skylineMatte = qualityPreset.dogParkSkipSkylineMatte === true
    ? null
    : addCitySkylineMatte(group, qualityPreset, {
      // Match city ring even when city is skipped, so extents stay consistent.
      cityRadius: cityRadius ?? CITY_RING_RADIUS,
    });
  if (skylineMatte?.material) materials.skyline = skylineMatte.material;

  const spawnPoint = new THREE.Vector3(-2, FLOOR_Y, -15.5);
  const dogSpawnPoint = new THREE.Vector3(-2, FLOOR_Y, -9.2);
  // The shared runtime still requires a non-null character. This pad keeps its
  // invisible, geometry-free stub stable while the dog owns camera/gameplay.
  colliders.push({
    name: 'Hidden Player Park',
    minX: -4,
    maxX: 0,
    minZ: -18,
    maxZ: -14,
    bottomY: -0.3,
    topY: 0,
    surfaceClass: 'grass',
  });

  let forestZone = null;
  let disposed = false;
  const forestBuild = qualityPreset.dogParkHeroTrees === true
    ? Promise.resolve(createFallbackParkTrees(dogParkForestZones(), sampleBaseGroundHeight, 18))
    : import('./forest/createForestZone.js').then(({ createForestZone }) => createForestZone({
      zones: dogParkForestZones(),
      sampleHeight: (x, z) => sampleBaseGroundHeight(x, z),
      // Park trees are all near the playable route, so every placement gets a
      // static trunk collider from the shared forest collider builder.
      findNearestRoadPoint: (x, z) => ({ x, z, distance: 0 }),
      qualityPreset: {
        ...qualityPreset,
        forestTreeBudget: Math.min(qualityPreset.forestTreeBudget ?? 18, 24),
        forestNearCount: Math.min(qualityPreset.forestNearCount ?? 18, 24),
        forestHeroCount: Math.min(qualityPreset.forestHeroCount ?? 6, 8),
        forestNearRadius: Math.min(qualityPreset.forestNearRadius ?? 70, 90),
        forestFarRadius: Math.min(qualityPreset.forestFarRadius ?? 120, 160),
      },
      renderer,
      initialCameraPosition: dogSpawnPoint,
    }));
  const ready = forestBuild
    .then((built) => {
      if (disposed) {
        built.dispose?.();
        return null;
      }
      forestZone = built;
      if (built.group) group.add(built.group);
      if (built.colliders?.length) colliders.push(...built.colliders);
      return built;
    })
    .catch((error) => {
      console.warn('[dog-park] shared forest failed; using deterministic hero-tree fallback', error);
      const built = createFallbackParkTrees(dogParkForestZones(), sampleBaseGroundHeight, 18);
      if (disposed) {
        built.dispose();
        return null;
      }
      forestZone = built;
      group.add(built.group);
      colliders.push(...built.colliders);
      return built;
    });

  const geometryIndex = createLevelGeometryIndex(group);

  function groundHeightAt(position, radius = 0.28, options = {}) {
    const surface = surfaceClassAt(position.x, position.z, surfaceZones);
    const baseHeight = surface === 'mud'
      ? MUD_Y - mudField.sampleDepthAt(position.x, position.z)
      : sampleBaseGroundHeight(position.x, position.z);
    let ground = getGroundHeightAt({
      position,
      radius,
      maxStepUp: options.maxStepUp,
      maxSnapDown: options.maxSnapDown,
      requiredInset: options.requiredInset,
      colliders,
      baseHeight,
    });
    for (const surface of walkableSurfaces) {
      const y = surface.heightAt(position.x, position.z);
      if (!Number.isFinite(y)) continue;
      if (Number.isFinite(options.maxStepUp) && y > position.y + options.maxStepUp) continue;
      if (Number.isFinite(options.maxSnapDown) && y < position.y - options.maxSnapDown) continue;
      ground = Math.max(ground, y);
    }
    return ground;
  }

  function updateMud(delta, focusPosition = null) {
    if (focusPosition) mudField.setCenter(focusPosition.x, focusPosition.z);
    mudField.decay(delta);
    mudField.syncTexture();
    mudBlob.update(delta);
  }

  function applyDogFlopImpact({ position, headingX = 0, headingZ = 1, trackImpact = true } = {}) {
    if (!position || surfaceClassAt(position.x, position.z, surfaceZones) !== 'mud') return false;
    const length = Math.hypot(headingX, headingZ) || 1;
    const dx = headingX / length;
    const dz = headingZ / length;
    for (const brush of [
      { along: -0.34, radius: 0.4, depth: 0.105 },
      { along: 0, radius: 0.48, depth: 0.15 },
      { along: 0.36, radius: 0.42, depth: 0.125 },
    ]) {
      mudField.stampBrush(
        position.x + dx * brush.along,
        position.z + dz * brush.along,
        brush.radius,
        {
          depth: brush.depth,
          wetness: 1,
          tread: 0.55,
          directionX: dx,
          directionZ: dz,
          kind: 'foot',
        },
      );
    }
    // Keep the springy splash close to the torso. A larger aquarium-style
    // deposit hid the entire incoming paw trail after the flop.
    mudBlob.deposit(position.x + dx * 0.05, position.z + dz * 0.05, 0.26, 3.2, dx * 0.85, dz * 0.85);
    // NPC flops use their own counter — the player-facing telemetry below is a
    // regression-tested exact count for the player's own flop action and must
    // not drift because background NPC dogs are also playing in the mud.
    if (trackImpact) flopImpactCount += 1;
    else npcFlopImpactCount += 1;
    return true;
  }

  function addDogPawVisual({ x, z, headingX = 0, headingZ = 1, scale = 1 } = {}) {
    if (surfaceClassAt(x, z, surfaceZones) !== 'mud') return false;
    pawTrailVisual.add({
      x,
      // Overlay remains just above the undeformed skin; the CPU field still
      // supplies the physical depression below it.
      y: MUD_Y + 0.008,
      z,
      headingX,
      headingZ,
      scale,
    });
    return true;
  }

  return {
    name: 'Riverside Dog Park',
    group,
    colliders,
    ledges: [],
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    geometryIndex,
    spawnPoint,
    spawnYaw: 0,
    dogSpawnPoint,
    mudField,
    mudBlob,
    ready,
    isNearFieldReady: () => true,
    // Three r185 can emit an incomplete depthStencil descriptor when this
    // mixed NodeMaterial/MeshStandardMaterial scene is sent through
    // compileAsync(scene). The real render-context warmup batches below are
    // safe and cover the same park materials.
    skipInitialAsyncCompile: true,
    createPipelineWarmupGroup: () => {
      const parkWarmup = createMaterialWarmupGroup(
        Object.values(materials),
        'Dog Park Pipeline Warmup',
      );
      if (!cityChunks.length) return parkWarmup;
      // Full city tiles (optional) — asphalt, furniture, extra skyscraper variants.
      const cityWarmup = createCityMaterialWarmupGroup();
      parkWarmup.add(cityWarmup);
      const parkDispose = parkWarmup.userData.disposeWarmup;
      parkWarmup.userData.disposeWarmup = () => {
        parkDispose?.();
        cityWarmup.userData.disposeWarmup?.();
      };
      return parkWarmup;
    },
    getGroundHeightAt: groundHeightAt,
    getBlockingColliderAt: ({ position, radius, feetY, height, stepHeight }) => getBlockingColliderAt({
      position,
      radius,
      feetY,
      height,
      stepHeight,
      colliders,
    }),
    getSurfaceAt: (x, z) => surfaceClassAt(x, z, surfaceZones),
    getWaterHeightAt: (position) => surfaceClassAt(position.x, position.z, surfaceZones) === 'mud'
      ? { waterY: WATER_Y, weight: 0 }
      : sampleLakeWater(position.x, position.z),
    getRoadSurfaceAt: () => null,
    findNearestRoadPoint: () => null,
    parkBounds: { minX: -PARK_HALF_X, maxX: PARK_HALF_X, minZ: -PARK_HALF_Z, maxZ: PARK_HALF_Z },
    mudPatches: MUD_PATCHES.map((patch) => ({ ...patch })),
    lake: { ...LAKE },
    cityChunks,
    updateStreaming: (position) => {
      forestZone?.setCameraPosition?.(position);
      return null;
    },
    updateForestEnvironment: (environment) => forestZone?.updateEnvironment?.(environment),
    updateForestAmbience: (position, delta) => forestZone?.updateAmbience?.(position, delta),
    wakeForestAmbience: () => forestZone?.wakeAmbience?.() ?? false,
    updateMud,
    applyDogFlopImpact,
    addDogPawVisual,
    snapshot: () => ({
      mode: 'dog-park',
      lotSize: [PARK_HALF_X * 2, PARK_HALF_Z * 2],
      colliders: colliders.length,
      surfaces: ['grass', 'dirt', 'sand', 'mud', 'water'],
      water: sampleLakeWater(LAKE.x, LAKE.z),
      forest: forestZone?.snapshot?.() ?? { forestTrees: 0 },
      city: {
        chunks: cityChunks.length,
        keys: cityChunks.map((chunk) => chunk.chunkKey),
        skylineMatte: skylineMatte
          ? {
              segments: skylineMatte.segments,
              heightMin: skylineMatte.heightMin,
              heightMax: skylineMatte.heightMax,
              halfX: skylineMatte.halfX,
              halfZ: skylineMatte.halfZ,
            }
          : null,
      },
      playStructureSurfaces: walkableSurfaces.length,
      mud: {
        activeDeformCells: mudField.activeCount,
        pawStampCount: mudField.dogPawStampCount ?? 0,
        visiblePawPrints: pawTrailVisual.count,
        flopImpactCount,
        npcFlopImpactCount,
        deformTextureActive: Boolean(mudField.texture && mudField.activeCount > 0),
        groundBlob: mudBlob.snapshot(),
      },
    }),
    dispose: () => {
      disposed = true;
      if (forestZone?.group) forestZone.group.removeFromParent();
      forestZone?.dispose?.();
      forestZone = null;
      for (const chunk of cityChunks) {
        chunk.group?.removeFromParent();
        chunk.dispose?.();
      }
      cityChunks.length = 0;
      mudBlob.dispose();
      mudField.disposeTexture();
      disposeObject3D(group);
    },
  };
}

/** Skyscraper material part ids (WALL brick + GLASS window panes). */
const SKYLINE_PART = Object.freeze({ WALL: 0, GLASS: 4 });
/** Extra metres past the city tile outer edge. */
const SKYLINE_OUTER_GAP = 4;
/** Thin shell depth — far backdrop wall, not a walkable block. */
const SKYLINE_THICK = 1.2;
/** Bay width along the city outer edge (one “building” face). Wider = cheaper. */
const SKYLINE_BAY = 14;
/** Window grid inset from each bay edge. */
const SKYLINE_WIN_INSET = 1.1;
const SKYLINE_WIN_COLS = 2;
const SKYLINE_FLOOR_H = 3.4;

/**
 * Resolve city ring radius: null = no city tiles.
 * @param {object} [qualityPreset]
 * @returns {number | null}
 */
function resolveDogParkCityRadius(qualityPreset = {}) {
  if (qualityPreset.dogParkSkipCity === true) return null;
  if (Number.isFinite(qualityPreset.dogParkCityRadius)) {
    return Math.max(0, Math.min(2, qualityPreset.dogParkCityRadius | 0));
  }
  return CITY_RING_RADIUS;
}

/**
 * Half-extents of the outer city boundary (world metres from origin).
 * Matte sits just past this so it is *behind* the real city, not around the park.
 * @param {number} cityRadius
 */
function cityOuterHalfExtents(cityRadius = 0) {
  const stride = getCityStride();
  const r = Math.max(0, cityRadius | 0);
  // Outer edge of the outermost tile: (radius + 0.5) * stride.
  return {
    halfX: (r + 0.5) * stride.x + SKYLINE_OUTER_GAP,
    halfZ: (r + 0.5) * stride.z + SKYLINE_OUTER_GAP,
  };
}

/**
 * Continuous thin facade wall on the *outer* edge of the city ring — behind the
 * real downtown tiles. Connected building faces with brick + sparse windows,
 * one merged mesh / one draw call. Hides empty horizon past city draw distance.
 *
 * @param {THREE.Group} group
 * @param {object} [qualityPreset]
 * @param {{ cityRadius?: number }} [opts]
 * @returns {{ mesh: THREE.Mesh, material: THREE.Material, segments: number, heightMin: number, heightMax: number, halfX: number, halfZ: number } | null}
 */
function addCitySkylineMatte(group, qualityPreset = {}, opts = {}) {
  const cityRadius = Number.isFinite(opts.cityRadius) ? opts.cityRadius : CITY_RING_RADIUS;
  const { halfX, halfZ } = cityOuterHalfExtents(cityRadius);
  const castShadows = qualityPreset.shadows !== false;
  const seed = (qualityPreset.dogParkSkylineSeed | 0) || 4107;

  /** @type {THREE.BufferGeometry[]} */
  const geos = [];
  let segments = 0;
  let heightMin = Infinity;
  let heightMax = 0;

  /**
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @param {number} sx
   * @param {number} sy
   * @param {number} sz
   * @param {number} partId
   * @param {number} [yaw]
   */
  const pushBox = (cx, cy, cz, sx, sy, sz, partId, yaw = 0) => {
    const geo = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
    const matrix = new THREE.Matrix4();
    matrix.makeRotationY(yaw);
    matrix.setPosition(cx, cy, cz);
    geo.applyMatrix4(matrix);
    const n = geo.attributes.position.count;
    geo.setAttribute('partId', new THREE.BufferAttribute(new Float32Array(n).fill(partId), 1));
    geos.push(geo);
  };

  /**
   * Place a run of building bays along an axis-aligned edge facing the park.
   * @param {'n'|'s'|'e'|'w'} side
   */
  const placeEdge = (side) => {
    const alongX = side === 'n' || side === 's';
    const length = alongX ? halfX * 2 : halfZ * 2;
    const bayCount = Math.max(2, Math.round(length / SKYLINE_BAY));
    const bayW = length / bayCount;
    for (let i = 0; i < bayCount; i += 1) {
      const t = (i + 0.5) / bayCount;
      // Far backdrop skyline — taller massing so it reads behind near city blocks.
      const hHash = skylineHash(seed, side.charCodeAt(0) * 31 + i);
      const stories = 8 + Math.floor(hHash * 14); // 8–21 floors
      const height = stories * SKYLINE_FLOOR_H + 2.0 + (hHash - 0.5) * 2.2;
      heightMin = Math.min(heightMin, height);
      heightMax = Math.max(heightMax, height);

      let cx;
      let cz;
      let sx;
      let sz;
      let yaw = 0;
      if (side === 'n') {
        cx = -halfX + t * length;
        cz = halfZ;
        sx = bayW;
        sz = SKYLINE_THICK;
      } else if (side === 's') {
        cx = -halfX + t * length;
        cz = -halfZ;
        sx = bayW;
        sz = SKYLINE_THICK;
      } else if (side === 'e') {
        cx = halfX;
        cz = -halfZ + t * length;
        sx = SKYLINE_THICK;
        sz = bayW;
      } else {
        cx = -halfX;
        cz = -halfZ + t * length;
        sx = SKYLINE_THICK;
        sz = bayW;
      }

      // Main brick face — slightly proud of window panes so sills read.
      pushBox(cx, height * 0.5, cz, sx, height, sz, SKYLINE_PART.WALL, yaw);

      // Window grid on the city-facing side (inward toward the park/city).
      // Every other floor keeps far-matte geometry cheap.
      const faceInset = SKYLINE_THICK * 0.52;
      const winDepth = 0.12;
      const colW = (bayW - SKYLINE_WIN_INSET * 2) / SKYLINE_WIN_COLS;
      const winW = colW * 0.7;
      const winH = SKYLINE_FLOOR_H * 0.46;
      for (let floor = 2; floor < stories; floor += 2) {
        const wy = floor * SKYLINE_FLOOR_H + winH * 0.3;
        for (let col = 0; col < SKYLINE_WIN_COLS; col += 1) {
          const along = -bayW * 0.5 + SKYLINE_WIN_INSET + (col + 0.5) * colW;
          let wcx = cx;
          let wcz = cz;
          let wsx = winW;
          let wsz = winDepth;
          if (side === 'n') {
            wcx = cx + along;
            wcz = cz - faceInset;
            wsx = winW;
            wsz = winDepth;
          } else if (side === 's') {
            wcx = cx + along;
            wcz = cz + faceInset;
            wsx = winW;
            wsz = winDepth;
          } else if (side === 'e') {
            wcx = cx - faceInset;
            wcz = cz + along;
            wsx = winDepth;
            wsz = winW;
          } else {
            wcx = cx + faceInset;
            wcz = cz + along;
            wsx = winDepth;
            wsz = winW;
          }
          const lit = skylineHash(seed, floor * 97 + col * 13 + i * 7 + side.charCodeAt(0)) > 0.22;
          if (!lit) continue;
          pushBox(wcx, wy, wcz, wsx, winH, wsz, SKYLINE_PART.GLASS, yaw);
        }
      }
      segments += 1;
    }
  };

  placeEdge('n');
  placeEdge('s');
  placeEdge('e');
  placeEdge('w');

  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;

  // Reuse city skyscraper TSL — brick coursing + dark glazing from partId.
  const material = createSkyscraperMaterial(color(0xb8b0a0));
  material.side = THREE.DoubleSide;
  material.userData.dogParkSkylineMatte = true;

  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'Dog Park City Skyline Matte';
  mesh.castShadow = castShadows;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.userData.freezeStaticWorldMatrices = true;
  mesh.userData.skipLevelRaycast = true;
  mesh.userData.noCollision = true;
  group.add(mesh);

  return {
    mesh,
    material,
    segments,
    heightMin: Number.isFinite(heightMin) ? heightMin : 0,
    heightMax,
    halfX,
    halfZ,
  };
}

/** Deterministic 0–1 hash for skyline bay heights / window skip. */
function skylineHash(seed, n) {
  let h = (seed ^ (n * 374761393)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Downtown tile under the park (lot carved out) + optional neighbor tiles.
 * Center tile: full physics + furniture outside the fence.
 * Neighbor tiles (radius ≥ 1): skyline visuals only — no Rapier bodies — but
 * still full CityGenerator meshes/materials (very expensive; keep radius 0).
 */
function buildDogParkCityRing(group, colliders, qualityPreset = {}) {
  const stride = getCityStride();
  const radius = Number.isFinite(qualityPreset.dogParkCityRadius)
    ? Math.max(0, Math.min(2, qualityPreset.dogParkCityRadius | 0))
    : CITY_RING_RADIUS;
  const clearRect = {
    minX: -PARK_HALF_X - CITY_CLEAR_MARGIN,
    maxX: PARK_HALF_X + CITY_CLEAR_MARGIN,
    minZ: -PARK_HALF_Z - CITY_CLEAR_MARGIN,
    maxZ: PARK_HALF_Z + CITY_CLEAR_MARGIN,
  };
  const castShadows = qualityPreset.shadows !== false;
  /** @type {ReturnType<typeof createGeneratorCityLevel>[]} */
  const chunks = [];
  const ring = new THREE.Group();
  ring.name = 'Dog Park City Ring';
  ring.userData.freezeStaticWorldMatrices = true;

  for (let cz = -radius; cz <= radius; cz += 1) {
    for (let cx = -radius; cx <= radius; cx += 1) {
      const isCenter = cx === 0 && cz === 0;
      const chunkKey = `dog-park:${cx}:${cz}`;
      const originX = cx * stride.x;
      const originZ = cz * stride.z;
      // Distinct seeds per tile so the ring doesn't look like a tiled stamp.
      const seed = CITY_SEED + 17 + cx * 31 + cz * 97;
      try {
        const chunk = createGeneratorCityLevel({
          seed,
          cityStyle: 'downtown',
          chunkKey,
          chunkX: cx,
          chunkZ: cz,
          originX,
          originZ,
          // Park lot hole only on the center tile — neighbors are full blocks.
          clearRect: isCenter ? clearRect : null,
          includeDebugOverlay: false,
          // Dog mode doesn't need tower parkour extraction.
          extractTraversal: false,
          // Only the carved block casts shadows into the park; ring is skyline.
          castShadows: castShadows && isCenter,
        });
        ring.add(chunk.group);
        if (isCenter) colliders.push(...chunk.colliders);
        chunks.push(chunk);
      } catch (error) {
        console.warn(`[dog-park] city chunk ${chunkKey} failed`, error);
      }
    }
  }

  if (chunks.length) group.add(ring);
  return chunks;
}

function addLawn(group, lawnMaterial) {
  // Extend past the fence so the apron fills the gap before city cement.
  const halfX = PARK_HALF_X + LAWN_OVERSHOOT;
  const halfZ = PARK_HALF_Z + LAWN_OVERSHOOT;
  const segsX = Math.max(60, Math.round(halfX * 2.2));
  const segsZ = Math.max(45, Math.round(halfZ * 2.2));
  const geometry = new THREE.PlaneGeometry(halfX * 2, halfZ * 2, segsX, segsZ);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    const baseY = sampleBaseGroundHeight(x, z);
    // Leave enough hidden clearance for max-depth mud displacement. Without
    // this carve the lawn occludes paw depressions and can flash green through
    // a flop impact.
    position.setY(index, isInsideMudPatch(x, z, 1.08) ? Math.min(baseY, -0.22) : baseY);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, lawnMaterial);
  mesh.name = 'Park Lawn';
  mesh.receiveShadow = true;
  mesh.userData.surfaceClass = 'grass';
  group.add(mesh);
  return mesh;
}

function isInsideMudPatch(x, z, scale = 1) {
  return MUD_PATCHES.some((patch) => {
    const dx = (x - patch.x) / (patch.radiusX * scale);
    const dz = (z - patch.z) / (patch.radiusZ * scale);
    return dx * dx + dz * dz <= 1;
  });
}

function addBox(group, colliders, name, [x, y, z], [sx, sy, sz], boxMaterial, options = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), boxMaterial);
  mesh.name = name;
  mesh.position.set(x, y, z);
  mesh.castShadow = options.collider === true && sy > 0.18;
  mesh.receiveShadow = true;
  if (options.surfaceClass) mesh.userData.surfaceClass = options.surfaceClass;
  group.add(mesh);
  if (colliders && options.collider) {
    colliders.push({
      name,
      minX: x - sx * 0.5,
      maxX: x + sx * 0.5,
      minZ: z - sz * 0.5,
      maxZ: z + sz * 0.5,
      bottomY: y - sy * 0.5,
      topY: y + sy * 0.5,
      surfaceClass: options.surfaceClass ?? null,
      noGroundSnap: options.noGroundSnap === true,
    });
  }
  return mesh;
}

function addSurfacePatch(group, zones, name, [x, y, z], [sx, sy, sz], patchMaterial, options) {
  addBox(group, null, name, [x, y, z], [sx, sy, sz], patchMaterial, options);
  zones.push({ type: 'rect', x, z, halfX: sx * 0.5, halfZ: sz * 0.5, surfaceClass: options.surfaceClass });
}

function addDeformMudPatch(group, zones, name, x, z, radiusX, radiusZ, patchMaterial) {
  const mesh = new THREE.Mesh(createDenseEllipseGeometry(x, z, radiusX, radiusZ), patchMaterial);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.userData.surfaceClass = 'mud';
  mesh.userData.deformableMud = true;
  group.add(mesh);
  zones.push({ type: 'ellipse', x, z, radiusX, radiusZ, surfaceClass: 'mud' });
}

function createDogPawTrailVisual(capacity) {
  const positions = [];
  const indices = [];
  const addEllipse = (cx, cz, radiusX, radiusZ, segments = 14) => {
    const center = positions.length / 3;
    positions.push(cx, 0, cz);
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = segment / segments * Math.PI * 2;
      positions.push(cx + Math.cos(angle) * radiusX, 0, cz + Math.sin(angle) * radiusZ);
    }
    for (let segment = 0; segment < segments; segment += 1) {
      indices.push(center, center + 1 + (segment + 1) % segments, center + 1 + segment);
    }
  };
  addEllipse(0, -0.025, 0.09, 0.105, 16);
  addEllipse(-0.06, 0.09, 0.034, 0.044, 12);
  addEllipse(0, 0.105, 0.036, 0.048, 12);
  addEllipse(0.06, 0.09, 0.034, 0.044, 12);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0x2d1c12,
    roughness: 0.94,
    metalness: 0,
    transparent: true,
    opacity: 0.76,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'Dog Park Persistent Paw Prints';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.userData.noStaticMerge = true;
  mesh.userData.skipLevelRaycast = true;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const size = new THREE.Vector3();
  let total = 0;
  return {
    mesh,
    get count() { return Math.min(total, capacity); },
    add({ x, y, z, headingX, headingZ, scale }) {
      const index = total % capacity;
      position.set(x, y, z);
      quaternion.setFromAxisAngle(
        THREE.Object3D.DEFAULT_UP,
        Math.atan2(headingX, headingZ),
      );
      const printScale = THREE.MathUtils.clamp(scale, 0.72, 1.35);
      size.set(printScale, printScale, printScale);
      matrix.compose(position, quaternion, size);
      mesh.setMatrixAt(index, matrix);
      total += 1;
      mesh.count = Math.min(total, capacity);
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

function createDenseEllipseGeometry(centerX, centerZ, radiusX, radiusZ) {
  const rings = Math.max(16, Math.ceil(Math.max(radiusX, radiusZ) / 0.11));
  const segments = 96;
  const positions = [centerX, MUD_Y, centerZ];
  const uvs = [0.5, 0.5];
  const indices = [];
  for (let ring = 1; ring <= rings; ring += 1) {
    const radius = ring / rings;
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = segment / segments * Math.PI * 2;
      positions.push(
        centerX + Math.cos(angle) * radiusX * radius,
        MUD_Y,
        centerZ + Math.sin(angle) * radiusZ * radius,
      );
      uvs.push(0.5 + Math.cos(angle) * radius * 0.5, 0.5 + Math.sin(angle) * radius * 0.5);
    }
  }
  for (let segment = 0; segment < segments; segment += 1) {
    indices.push(0, 1 + segment, 1 + (segment + 1) % segments);
  }
  for (let ring = 1; ring < rings; ring += 1) {
    const inner = 1 + (ring - 1) * segments;
    const outer = 1 + ring * segments;
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      indices.push(inner + segment, outer + segment, inner + next);
      indices.push(inner + next, outer + segment, outer + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createLake(group, waterMaterial, bankMaterial) {
  const bank = new THREE.Mesh(new THREE.RingGeometry(1, 1.18, 64), bankMaterial);
  bank.name = 'Lake Mud Bank';
  bank.rotation.x = -Math.PI / 2;
  bank.scale.set(LAKE.radiusX, LAKE.radiusZ, 1);
  bank.position.set(LAKE.x, 0.022, LAKE.z);
  bank.receiveShadow = true;
  bank.userData.surfaceClass = 'mud';
  group.add(bank);

  const water = new THREE.Mesh(new THREE.CircleGeometry(1, 64), waterMaterial);
  water.name = 'Park Lake Water';
  water.rotation.x = -Math.PI / 2;
  water.scale.set(LAKE.radiusX, LAKE.radiusZ, 1);
  water.position.set(LAKE.x, WATER_Y, LAKE.z);
  water.renderOrder = 2;
  group.add(water);
}

function addFence(group, colliders, fenceMaterial) {
  const postHeight = 1.3;
  const post = (x, z) => addBox(group, null, `Fence Post ${x}:${z}`, [x, postHeight * 0.5, z], [0.16, postHeight, 0.16], fenceMaterial);
  for (let x = -PARK_HALF_X; x <= PARK_HALF_X; x += 3) {
    post(x, -PARK_HALF_Z);
    post(x, PARK_HALF_Z);
  }
  for (let z = -PARK_HALF_Z + 3; z < PARK_HALF_Z; z += 3) {
    post(-PARK_HALF_X, z);
    post(PARK_HALF_X, z);
  }
  const rail = (name, x, y, z, sx, sz) => addBox(group, null, name, [x, y, z], [sx, 0.1, sz], fenceMaterial);
  for (const y of [0.42, 0.92]) {
    rail(`North Fence Rail ${y}`, 0, y, PARK_HALF_Z, PARK_HALF_X * 2, 0.12);
    // South entry gate opening is 5 m wide.
    rail(`South Fence Rail Left ${y}`, -16.25, y, -PARK_HALF_Z, 27.5, 0.12);
    rail(`South Fence Rail Right ${y}`, 16.25, y, -PARK_HALF_Z, 27.5, 0.12);
    rail(`West Fence Rail ${y}`, -PARK_HALF_X, y, 0, 0.12, PARK_HALF_Z * 2);
    rail(`East Fence Rail ${y}`, PARK_HALF_X, y, 0, 0.12, PARK_HALF_Z * 2);
  }
  const wall = (name, minX, maxX, minZ, maxZ) => colliders.push({
    name,
    minX,
    maxX,
    minZ,
    maxZ,
    bottomY: 0,
    topY: postHeight,
    noGroundSnap: true,
  });
  wall('North Park Fence', -PARK_HALF_X, PARK_HALF_X, PARK_HALF_Z - 0.1, PARK_HALF_Z + 0.1);
  wall('West Park Fence', -PARK_HALF_X - 0.1, -PARK_HALF_X + 0.1, -PARK_HALF_Z, PARK_HALF_Z);
  wall('East Park Fence', PARK_HALF_X - 0.1, PARK_HALF_X + 0.1, -PARK_HALF_Z, PARK_HALF_Z);
  wall('South Park Fence Left', -PARK_HALF_X, -2.5, -PARK_HALF_Z - 0.1, -PARK_HALF_Z + 0.1);
  wall('South Park Fence Right', 2.5, PARK_HALF_X, -PARK_HALF_Z - 0.1, -PARK_HALF_Z + 0.1);
}

function addPlayStructure(group, colliders, walkable, materials) {
  const centerX = -9;
  const centerZ = -5.2;
  // Platform box: bottom near ground, top is the walkable deck.
  const platformSize = Object.freeze({ x: 3.2, y: 1.2, z: 3 });
  const platformTop = platformSize.y; // deck height (box bottom ~0)
  const platformCenterY = platformSize.y * 0.5;
  addBox(
    group,
    colliders,
    'Dog Platform',
    [centerX, platformCenterY, centerZ],
    [platformSize.x, platformSize.y, platformSize.z],
    materials.wood,
    { collider: true, surfaceClass: 'wood' },
  );
  // Analytic deck so snaps land on the top face, not only via collider steps.
  walkable.push({
    name: 'Dog Platform Deck',
    heightAt(px, pz) {
      if (Math.abs(px - centerX) > platformSize.x * 0.5 || Math.abs(pz - centerZ) > platformSize.z * 0.5) {
        return null;
      }
      return platformTop;
    },
  });

  // Ramps: slope length L, rise matches deck. Overlap high end into the box so
  // rotation foreshortening never leaves a gap (old layout stopped ~10cm short).
  const rampSlopeLen = 3.15;
  const rampWidth = 1.45;
  const rampOverlap = 0.28;
  const platformWest = centerX - platformSize.x * 0.5;
  const platformEast = centerX + platformSize.x * 0.5;
  addRampToHeight(group, walkable, 'West Dog Ramp', {
    highEndX: platformWest + rampOverlap,
    z: centerZ,
    slopeLength: rampSlopeLen,
    width: rampWidth,
    rise: platformTop,
    direction: 1,
    material: materials.wood,
  });
  addRampToHeight(group, walkable, 'East Dog Ramp', {
    highEndX: platformEast - rampOverlap,
    z: centerZ,
    slopeLength: rampSlopeLen,
    width: rampWidth,
    rise: platformTop,
    direction: -1,
    material: materials.wood,
  });

  // openEnded cylinder: outward normals only show the exterior with FrontSide.
  // materials.tunnel is DoubleSide so the interior PBR reads when running through.
  const tunnel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.75, 0.75, 3.8, 32, 1, true),
    materials.tunnel ?? materials.metal,
  );
  tunnel.name = 'Dog Agility Tunnel';
  tunnel.rotation.z = Math.PI / 2;
  tunnel.position.set(1.5, 0.78, -6.5);
  tunnel.castShadow = true;
  tunnel.receiveShadow = true;
  group.add(tunnel);

  // A-frame: two slopes meet at a shared peak with overlap so the ridge seals.
  const aPeakX = 16.55;
  const aPeakZ = -7.2;
  const aRise = 1.35;
  const aSlope = 3.15;
  const aWidth = 1.5;
  const aOverlap = 0.2;
  addRampToHeight(group, walkable, 'A Frame West', {
    highEndX: aPeakX + aOverlap * 0.5,
    z: aPeakZ,
    slopeLength: aSlope,
    width: aWidth,
    rise: aRise,
    direction: 1,
    material: materials.wood,
  });
  addRampToHeight(group, walkable, 'A Frame East', {
    highEndX: aPeakX - aOverlap * 0.5,
    z: aPeakZ,
    slopeLength: aSlope,
    width: aWidth,
    rise: aRise,
    direction: -1,
    material: materials.wood,
  });
}

/**
 * Place a board ramp whose high end sits at `highEndX` and low end on the ground.
 * `direction` +1 rises toward +X (west approach), -1 rises toward -X (east approach).
 * Walkable `heightAt` uses world-X span (horizontal projection), not slope length.
 */
function addRampToHeight(group, walkable, name, {
  highEndX,
  z,
  slopeLength,
  width,
  rise,
  direction,
  material: rampMaterial,
  thickness = 0.14,
}) {
  const dir = direction >= 0 ? 1 : -1;
  const angle = Math.atan2(rise, slopeLength);
  const horiz = slopeLength * Math.cos(angle);
  // Center of the slab: midway along the slope in world XZ and half-rise in Y.
  const centerX = highEndX - dir * (horiz * 0.5);
  const centerY = rise * 0.5;
  const lowEndX = highEndX - dir * horiz;

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(slopeLength, thickness, width), rampMaterial);
  mesh.name = name;
  mesh.position.set(centerX, centerY, z);
  mesh.rotation.z = dir * angle;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.surfaceClass = 'wood';
  group.add(mesh);

  const minX = Math.min(lowEndX, highEndX);
  const maxX = Math.max(lowEndX, highEndX);
  const halfW = width * 0.5;
  // Small padding so the walkable surface still reads under the deck overlap.
  const pad = 0.04;
  walkable.push({
    name,
    heightAt(px, pz) {
      if (px < minX - pad || px > maxX + pad || Math.abs(pz - z) > halfW) return null;
      const t = THREE.MathUtils.clamp((px - lowEndX) / (highEndX - lowEndX), 0, 1);
      return rise * t;
    },
  });
}

function addParkFurniture(group, colliders, materials) {
  for (const [x, z, yaw] of [[-23, -14, 0.15], [22, -14, -0.2], [24, 17, Math.PI]]) {
    const bench = new THREE.Group();
    bench.name = 'Park Bench';
    bench.position.set(x, 0, z);
    bench.rotation.y = yaw;
    addBox(bench, null, 'Bench Seat', [0, 0.52, 0], [2.2, 0.12, 0.48], materials.wood);
    addBox(bench, null, 'Bench Back', [0, 0.92, 0.2], [2.2, 0.7, 0.1], materials.wood);
    addBox(bench, null, 'Bench Leg L', [-0.75, 0.26, 0], [0.12, 0.52, 0.4], materials.metal);
    addBox(bench, null, 'Bench Leg R', [0.75, 0.26, 0], [0.12, 0.52, 0.4], materials.metal);
    group.add(bench);
    colliders.push({
      name: `Park Bench ${x}:${z}`,
      minX: x - 1.35,
      maxX: x + 1.35,
      minZ: z - 0.65,
      maxZ: z + 0.65,
      bottomY: 0,
      topY: 1.3,
      noGroundSnap: true,
    });
  }
}

function dogParkForestZones() {
  return [
    {
      id: 'dog-park-north-grove',
      type: 'forest',
      shape: 'rect',
      rect: { minX: -28, maxX: 28, minZ: 15, maxZ: 21 },
      props: { species: 'bald-cypress', density: 900, seed: 4107 },
    },
    {
      id: 'dog-park-east-grove',
      type: 'forest',
      shape: 'rect',
      rect: { minX: 24, maxX: 28, minZ: -8, maxZ: 13 },
      props: { species: 'pine', density: 720, seed: 8123 },
    },
  ];
}

function solidMaterial(color, roughness, metalness = 0.02) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function createFallbackParkTrees(zones, sampleHeight, cap) {
  const placements = scatterForestPlacements({
    zones,
    sampleHeight,
    archetypeCount: 1,
    cap,
  });
  const group = new THREE.Group();
  group.name = 'Dog Park Hero Trees';
  group.userData.noCollision = true;
  const trunkGeometry = new THREE.CylinderGeometry(0.28, 0.38, 5.5, 8);
  const crownGeometry = new THREE.ConeGeometry(2.1, 5.8, 9);
  const trunkMaterial = solidMaterial(0x5d412b, 1);
  const crownMaterial = solidMaterial(0x35633b, 0.98);
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, placements.length);
  const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, placements.length);
  trunks.name = 'Hero Tree Trunks';
  crowns.name = 'Hero Tree Crowns';
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotY);
    scale.setScalar(placement.scale);
    position.set(placement.x, placement.y + 2.75 * placement.scale, placement.z);
    matrix.compose(position, quaternion, scale);
    trunks.setMatrixAt(index, matrix);
    position.y = placement.y + 7.2 * placement.scale;
    matrix.compose(position, quaternion, scale);
    crowns.setMatrixAt(index, matrix);
  }
  trunks.castShadow = true;
  trunks.receiveShadow = true;
  crowns.castShadow = true;
  group.add(trunks, crowns);
  const colliders = placements.map((placement, index) => placementToTrunkCollider(placement, index, { trunkHeight: 10 }));
  return {
    group,
    count: placements.length,
    placements,
    colliders,
    setCameraPosition() {},
    updateEnvironment() {},
    updateAmbience() {},
    wakeAmbience() {},
    snapshot: () => ({
      forestTrees: placements.length,
      forestArchetypes: 1,
      forestFallback: 'hero-trees',
      forestTrunkColliders: colliders.length,
    }),
    dispose() {
      trunkGeometry.dispose();
      crownGeometry.dispose();
      trunkMaterial.dispose();
      crownMaterial.dispose();
      group.removeFromParent();
    },
  };
}

function sampleBaseGroundHeight(x, z) {
  const dx = (x - LAKE.x) / LAKE.radiusX;
  const dz = (z - LAKE.z) / LAKE.radiusZ;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= 1) return FLOOR_Y;
  return THREE.MathUtils.lerp(-0.48, -0.12, THREE.MathUtils.smoothstep(d, 0.35, 1));
}

function sampleLakeWater(x, z) {
  const dx = (x - LAKE.x) / LAKE.radiusX;
  const dz = (z - LAKE.z) / LAKE.radiusZ;
  const d = Math.sqrt(dx * dx + dz * dz);
  return {
    waterY: WATER_Y,
    weight: THREE.MathUtils.clamp((1 - d) / 0.18, 0, 1),
  };
}

function surfaceClassAt(x, z, zones) {
  // Authored paths/wallows override the analytic lake footprint at the shore.
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    const zone = zones[i];
    if (zone.type === 'rect') {
      if (Math.abs(x - zone.x) <= zone.halfX && Math.abs(z - zone.z) <= zone.halfZ) return zone.surfaceClass;
    } else {
      const dx = (x - zone.x) / zone.radiusX;
      const dz = (z - zone.z) / zone.radiusZ;
      if (dx * dx + dz * dz <= 1) return zone.surfaceClass;
    }
  }
  const water = sampleLakeWater(x, z);
  if (water.weight > 0) return 'water';
  return 'grass';
}
