/**
 * Rail Crucible — deathmatch arena level (M1).
 *
 * Builds render meshes, analytic AABB colliders, ground/blocking queries, a
 * warmup group, and a snapshot from the single pure descriptor in
 * `railCrucibleMap.js`. The PartyKit server consumes that same descriptor for
 * validation/hitscan, so the client geometry and the server hit model cannot
 * drift (see docs/multiplayer-deathmatch-partykit-plan.md §Rail Crucible).
 *
 * Visual language reuses the Horde trainyard PBR set (range concrete / metal /
 * wood / brick / rust) and industrial props — rails, ballast, freight shell,
 * foundry walls, crane truss — without importing the Horde level. Gameplay
 * colliders stay bound to the descriptor volumes; visual detail is free to
 * read richer as long as the coarse AABBs match.
 *
 * Reuses the createHordeModeLevel level contract: `{ group, colliders,
 * spawnPoint, getGroundHeightAt, getBlockingColliderAt, geometryIndex, warmup,
 * snapshot, dispose }`. Three tiers (undercroft / transfer floor / gantries)
 * are stacked floor slabs read from the descriptor's `validPlayerVolumes`.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { createMaterialWarmupGroup } from './createMaterialWarmupGroup.js';
import { getGroundHeightAt, getBlockingColliderAt } from './createBaseLevel.js';
import { RAIL_CRUCIBLE, getRampFloorCutouts } from '../config/deathmatch/railCrucibleMap.js';
import { PICKUP_KIND } from '../config/deathmatch/deathmatchRules.js';

/** Lowest floor plane; drives analytic ground fallback for out-of-collider queries. */
const BASE_HEIGHT = RAIL_CRUCIBLE.bounds.min[1];

const RANGE_TEXTURE_ROOT = '/assets/textures/range';
const WALL_TILE_M = 2.8;
const METAL_TILE_M = 1.85;
const WOOD_TILE_M = 1.4;
const GRAVEL_TILE_M = 3.2;
const BRICK_TILE_M = 2.4;

export const DEATHMATCH_ENVIRONMENT = {
  timeOfDay: 0.28, // sodium-lit dusk
  weather: 'clear',
  fogEnabled: true,
  fogDensity: 0.008,
  fogColor: 0x2a2f36,
  ambientBoost: 0.06,
};

/** Landmark accent colour per tier (readability aid, not gameplay). */
const TIER_ACCENT = { lower: 0x1f9e8f, mid: 0xd9863b, upper: 0xb648c8 };
const PICKUP_COLOR = {
  [PICKUP_KIND.WEAPON]: 0x39c6ff,
  [PICKUP_KIND.AMMO]: 0xf2d24b,
  [PICKUP_KIND.HEALTH]: 0x54d66a,
};

// ── Range / trainyard PBR ────────────────────────────────────────────────────

function loadRangeTexture(path, {
  repeatX = 1,
  repeatY = 1,
  srgb = false,
} = {}) {
  if (typeof document === 'undefined') return null;
  const texture = new THREE.TextureLoader().load(`${RANGE_TEXTURE_ROOT}/${path}`);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  return texture;
}

function loadRangePbrSet(folder) {
  return {
    map: loadRangeTexture(`${folder}/albedo.png`, { srgb: true }),
    normalMap: loadRangeTexture(`${folder}/normal.png`),
    roughnessMap: loadRangeTexture(`${folder}/roughness.png`),
    aoMap: loadRangeTexture(`${folder}/height.png`),
  };
}

function makePbrMaterial(pbr, {
  roughness = 0.88,
  metalness = 0.03,
  envMapIntensity = 0.5,
  normalScale = 1,
  aoMapIntensity = 0.7,
  color = 0xffffff,
  emissive = 0x000000,
  emissiveIntensity = 0,
} = {}) {
  return new THREE.MeshStandardMaterial({
    map: pbr.map,
    normalMap: pbr.normalMap,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    roughnessMap: pbr.roughnessMap,
    roughness,
    metalness,
    aoMap: pbr.aoMap,
    aoMapIntensity,
    color,
    envMapIntensity,
    emissive,
    emissiveIntensity,
  });
}

function makeEmissiveMaterial(color, intensity = 1.0) {
  return new THREE.MeshStandardMaterial({
    color: 0x101418,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.55,
    metalness: 0.15,
  });
}

const concretePbr = loadRangePbrSet('concrete');
const metalRoofPbr = loadRangePbrSet('metalroof');
const woodPbr = loadRangePbrSet('woodwall');
const brickPbr = loadRangePbrSet('brickwall');
const rustPbr = loadRangePbrSet('pillarmiddle');
const rustEndPbr = loadRangePbrSet('pillarend');

/** Mid / upper transfer slabs — warm grit concrete. */
const floorMat = makePbrMaterial(concretePbr, {
  roughness: 0.95,
  metalness: 0.02,
  normalScale: 1.35,
  aoMapIntensity: 0.85,
  color: 0x7a7468,
});
/** Undercroft service floor — cooler, wetter cast. */
const undercroftMat = makePbrMaterial(concretePbr, {
  roughness: 0.9,
  metalness: 0.04,
  normalScale: 1.2,
  aoMapIntensity: 0.9,
  color: 0x5a6268,
});
const wallMat = makePbrMaterial(metalRoofPbr, {
  roughness: 0.72,
  metalness: 0.55,
  normalScale: 1.15,
  color: 0xc8c2b4,
});
const railMat = makePbrMaterial(metalRoofPbr, {
  roughness: 0.42,
  metalness: 0.82,
  normalScale: 0.9,
  color: 0x9a9ea4,
});
const tieMat = makePbrMaterial(woodPbr, {
  roughness: 0.92,
  metalness: 0.02,
  color: 0x6a5640,
});
const rustMat = makePbrMaterial(rustPbr, {
  roughness: 0.78,
  metalness: 0.35,
  color: 0xb07048,
});
const rustEndMat = makePbrMaterial(rustEndPbr, {
  roughness: 0.7,
  metalness: 0.4,
  color: 0x8a5a38,
});
const brickMat = makePbrMaterial(brickPbr, {
  roughness: 0.9,
  metalness: 0.04,
  color: 0xc4b8a8,
});
const rampMat = makePbrMaterial(metalRoofPbr, {
  roughness: 0.55,
  metalness: 0.65,
  normalScale: 1.0,
  color: 0x6a7078,
});
// Ballast reuses floor grit (keeps static material/draw budget ≤ 12).
const ballastMat = floorMat;

const accentMats = {
  lower: makeEmissiveMaterial(TIER_ACCENT.lower, 0.95),
  mid: makeEmissiveMaterial(TIER_ACCENT.mid, 0.95),
  upper: makeEmissiveMaterial(TIER_ACCENT.upper, 0.95),
};

/** Static batches only — pickups stay dynamic and are not counted here. */
const STATIC_MATERIALS = [
  floorMat, undercroftMat, wallMat, railMat, tieMat, rustMat, rustEndMat,
  brickMat, rampMat, accentMats.lower, accentMats.mid, accentMats.upper,
];

// ── Geometry helpers ─────────────────────────────────────────────────────────

function ensureUv2(geometry) {
  if (!geometry.getAttribute('uv2') && geometry.getAttribute('uv')) {
    geometry.setAttribute('uv2', geometry.getAttribute('uv').clone());
  }
  return geometry;
}

/**
 * World-scale UVs on box faces so PBR maps tile by metres instead of stretching.
 */
function prepareBoxGeometry(sx, sy, sz, material, tileMeters = WALL_TILE_M) {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  if (!material?.map || !tileMeters || tileMeters <= 0) {
    return ensureUv2(geometry);
  }
  const uv = geometry.attributes.uv;
  const faces = [
    { w: sz, h: sy },
    { w: sz, h: sy },
    { w: sx, h: sz },
    { w: sx, h: sz },
    { w: sx, h: sy },
    { w: sx, h: sy },
  ];
  let vi = 0;
  for (const face of faces) {
    const uScale = face.w / tileMeters;
    const vScale = face.h / tileMeters;
    for (let k = 0; k < 4; k += 1) {
      const u = uv.getX(vi);
      const v = uv.getY(vi);
      uv.setXY(vi, u * uScale, v * vScale);
      vi += 1;
    }
  }
  uv.needsUpdate = true;
  return ensureUv2(geometry);
}

function addBox(group, {
  name,
  cx, cy, cz,
  sx, sy, sz,
  material,
  tileMeters = WALL_TILE_M,
  castShadow = true,
  receiveShadow = true,
  rotation = null,
}) {
  const mesh = new THREE.Mesh(prepareBoxGeometry(sx, sy, sz, material, tileMeters), material);
  mesh.name = name;
  mesh.position.set(cx, cy, cz);
  if (rotation) mesh.rotation.copy(rotation);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  group.add(mesh);
  return mesh;
}

/** Push an AABB analytic collider from a `{ min, max }` volume. */
function colliderFromVolume(colliders, name, min, max, surfaceClass = 'concrete') {
  colliders.push({
    name,
    minX: min[0], maxX: max[0],
    minZ: min[2], maxZ: max[2],
    bottomY: min[1], topY: max[1],
    surfaceClass,
  });
}

/**
 * Subtract an axis-aligned hole from a set of XZ rects. Used so tier floors open
 * over ramp shafts instead of sealing them into unclimbable boxes.
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}[]} rects
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} hole
 */
function subtractRect(rects, hole) {
  const out = [];
  for (const r of rects) {
    const ix0 = Math.max(r.minX, hole.minX);
    const ix1 = Math.min(r.maxX, hole.maxX);
    const iz0 = Math.max(r.minZ, hole.minZ);
    const iz1 = Math.min(r.maxZ, hole.maxZ);
    if (ix0 >= ix1 || iz0 >= iz1) {
      out.push(r);
      continue;
    }
    // West strip
    if (r.minX < ix0) out.push({ minX: r.minX, maxX: ix0, minZ: r.minZ, maxZ: r.maxZ });
    // East strip
    if (ix1 < r.maxX) out.push({ minX: ix1, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ });
    // South strip (between west/east cuts)
    if (r.minZ < iz0) out.push({ minX: ix0, maxX: ix1, minZ: r.minZ, maxZ: iz0 });
    // North strip
    if (iz1 < r.maxZ) out.push({ minX: ix0, maxX: ix1, minZ: iz1, maxZ: r.maxZ });
  }
  return out.filter((r) => (r.maxX - r.minX) > 0.05 && (r.maxZ - r.minZ) > 0.05);
}

/**
 * Build a walkable ramp: thin oriented Rapier deck (not a solid AABB volume) +
 * analytic surfaceHeightAt for character ground snap. Matches road-deck pattern
 * in createRoadworks so the climb is not a giant blocking box.
 */
function addRamp(group, colliders, { name, x, z0, z1, lowY, highY, width }) {
  const dz = z1 - z0;
  const dy = highY - lowY;
  const runLen = Math.hypot(dz, dy);
  const pitch = Math.atan2(dy, dz);
  const cx = x;
  const cy = (lowY + highY) / 2;
  const cz = (z0 + z1) / 2;
  const thickness = 0.3;
  const halfThick = thickness * 0.5;

  const deck = new THREE.Mesh(
    prepareBoxGeometry(width, thickness, runLen, rampMat, METAL_TILE_M),
    rampMat,
  );
  deck.name = name;
  deck.position.set(cx, cy, cz);
  deck.rotation.x = -pitch;
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(deck);

  // Side stringers for industrial stair read (visual only — no colliders).
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      prepareBoxGeometry(0.12, 0.45, runLen, railMat, METAL_TILE_M),
      railMat,
    );
    rail.name = `${name} rail ${side > 0 ? 'R' : 'L'}`;
    rail.position.set(cx + side * (width * 0.5 + 0.08), cy + 0.35, cz);
    rail.rotation.x = -pitch;
    rail.castShadow = true;
    group.add(rail);
  }

  // Step chevrons (visual only).
  const steps = 6;
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const sz = z0 + t * dz;
    const sy = lowY + t * dy + 0.08;
    addBox(group, {
      name: `${name} tread ${i}`,
      cx, cy: sy, cz: sz,
      sx: width * 0.92, sy: 0.06, sz: 0.14,
      material: rustEndMat,
      tileMeters: METAL_TILE_M,
      castShadow: false,
    });
  }

  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, 0, 0));
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  // Analytic AABB is a thin band at the high end (road-deck pattern) so
  // getBlockingColliderAt does not treat the whole shaft as a solid wall.
  // Rapier uses the oriented cuboid for real walkable collision.
  colliders.push({
    name,
    minX: cx - width / 2,
    maxX: cx + width / 2,
    minZ,
    maxZ,
    bottomY: highY - thickness,
    topY: highY,
    surfaceClass: 'metal',
    // Walkable deck: used for ground snap + oriented Rapier, not as a wall volume.
    blockMovement: false,
    surfaceHeightAt: (px, pz) => {
      if (px < cx - width / 2 - 0.15 || px > cx + width / 2 + 0.15) return -Infinity;
      if (pz < minZ - 0.15 || pz > maxZ + 0.15) return -Infinity;
      const t = Math.max(0, Math.min(1, (pz - z0) / dz));
      return lowY + t * dy;
    },
    center: { x: cx, y: cy, z: cz },
    halfExtents: { x: width * 0.5, y: halfThick, z: runLen * 0.5 },
    orientation: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
  });
}

// ── Landmark builders ────────────────────────────────────────────────────────

function buildPerimeterWalls(group) {
  const b = RAIL_CRUCIBLE.bounds;
  const wallTop = b.max[1];
  const wallBot = b.min[1];
  const h = wallTop - wallBot;
  const cy = (wallTop + wallBot) / 2;
  const t = 2; // matches solid wall thickness (34-32)*2 sides → 2m

  // Outer shell (solid match) + inner corrugated face plates + vertical ribs.
  const walls = [
    { id: 'n', cx: 0, cz: 33, sx: 68, sz: t },
    { id: 's', cx: 0, cz: -33, sx: 68, sz: t },
    { id: 'e', cx: 33, cz: 0, sx: t, sz: 68 },
    { id: 'w', cx: -33, cz: 0, sx: t, sz: 68 },
  ];
  for (const w of walls) {
    addBox(group, {
      name: `Foundry Wall ${w.id}`,
      cx: w.cx, cy, cz: w.cz,
      sx: w.sx, sy: h, sz: w.sz,
      material: wallMat,
      tileMeters: METAL_TILE_M,
    });
    // Brick skirt at the base for foundry read.
    addBox(group, {
      name: `Foundry Skirt ${w.id}`,
      cx: w.cx, cy: wallBot + 1.1, cz: w.cz,
      sx: w.sx + 0.2, sy: 2.2, sz: w.sz + 0.2,
      material: brickMat,
      tileMeters: BRICK_TILE_M,
    });
  }

  // Vertical stiffener ribs on long faces (visual only).
  for (const face of [
    { axis: 'z', fixed: 32.2, span: 30, count: 9 },
    { axis: 'z', fixed: -32.2, span: 30, count: 9 },
    { axis: 'x', fixed: 32.2, span: 30, count: 9 },
    { axis: 'x', fixed: -32.2, span: 30, count: 9 },
  ]) {
    for (let i = 0; i < face.count; i += 1) {
      const tNorm = (i + 0.5) / face.count;
      const along = -face.span + tNorm * face.span * 2;
      if (face.axis === 'z') {
        addBox(group, {
          name: `Wall rib z${face.fixed}_${i}`,
          cx: along, cy: cy + 1, cz: face.fixed,
          sx: 0.28, sy: h * 0.75, sz: 0.22,
          material: rustEndMat,
          tileMeters: METAL_TILE_M,
          castShadow: false,
        });
      } else {
        addBox(group, {
          name: `Wall rib x${face.fixed}_${i}`,
          cx: face.fixed, cy: cy + 1, cz: along,
          sx: 0.22, sy: h * 0.75, sz: 0.28,
          material: rustEndMat,
          tileMeters: METAL_TILE_M,
          castShadow: false,
        });
      }
    }
  }

  // Cap beam along the top of the perimeter.
  for (const w of walls) {
    addBox(group, {
      name: `Wall cap ${w.id}`,
      cx: w.cx, cy: wallTop - 0.25, cz: w.cz,
      sx: w.sx + 0.4, sy: 0.5, sz: w.sz + 0.4,
      material: rustMat,
      tileMeters: METAL_TILE_M,
    });
  }
}

function buildTierFloors(group, colliders) {
  for (const vol of RAIL_CRUCIBLE.validPlayerVolumes) {
    const floorY = vol.min[1];
    const isLower = vol.id.includes('lower');
    const isUpper = vol.id.includes('upper') || vol.id.includes('bridge');
    const mat = isLower ? undercroftMat : floorMat;
    const tile = isLower ? GRAVEL_TILE_M * 0.85 : GRAVEL_TILE_M;

    // Start from the volume footprint, then open ramp approach shafts so a
    // higher slab does not seal over the climb (still leaves a landing lip).
    let rects = [{
      minX: vol.min[0],
      maxX: vol.max[0],
      minZ: vol.min[2],
      maxZ: vol.max[2],
    }];
    if (!isLower) {
      for (const hole of getRampFloorCutouts(floorY)) {
        rects = subtractRect(rects, hole);
      }
    }

    let piece = 0;
    for (const r of rects) {
      const sx = r.maxX - r.minX;
      const sz = r.maxZ - r.minZ;
      const cx = (r.minX + r.maxX) / 2;
      const cz = (r.minZ + r.maxZ) / 2;
      addBox(group, {
        name: `Floor ${vol.id}_${piece}`,
        cx, cy: floorY - 0.1, cz,
        sx, sy: 0.2, sz,
        material: mat,
        tileMeters: tile,
      });
      colliderFromVolume(
        colliders,
        `Floor ${vol.id}_${piece}`,
        [r.minX, floorY - 0.2, r.minZ],
        [r.maxX, floorY, r.maxZ],
        'concrete',
      );
      piece += 1;
    }

    // Tier accent strip along the volume's -z edge for a colour landmark.
    const tier = isLower ? 'lower' : isUpper ? 'upper' : 'mid';
    const fullSx = vol.max[0] - vol.min[0];
    addBox(group, {
      name: `Accent ${vol.id}`,
      cx: (vol.min[0] + vol.max[0]) / 2,
      cy: floorY + 0.03,
      cz: vol.min[2] + 0.18,
      sx: Math.max(1, fullSx * 0.88),
      sy: 0.06,
      sz: 0.18,
      material: accentMats[tier],
      tileMeters: 1,
      castShadow: false,
    });
  }
}

/** Broken rail crossing on the mid transfer floor. */
function buildTransferRails(group) {
  const y = 0.08;
  // Two crossing axes of ballast + ties + rails, interrupted by the turntable pit.
  const segments = [
    // East–west, west of turntable
    { cx: -18, cz: 0, sx: 20, sz: 3.4, yaw: 0 },
    // East–west, east of turntable
    { cx: 18, cz: 0, sx: 20, sz: 3.4, yaw: 0 },
    // North–south, south of turntable
    { cx: 0, cz: -18, sx: 3.4, sz: 20, yaw: 0 },
    // North–south, north of turntable
    { cx: 0, cz: 18, sx: 3.4, sz: 20, yaw: 0 },
    // Diagonal spur near shotgun bay
    { cx: 14, cz: 14, sx: 12, sz: 2.8, yaw: Math.PI * 0.25 },
  ];

  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    const root = new THREE.Group();
    root.name = `Rail Seg ${i}`;
    root.position.set(s.cx, 0, s.cz);
    root.rotation.y = s.yaw;
    group.add(root);

    const ballast = new THREE.Mesh(
      prepareBoxGeometry(s.sx, 0.16, s.sz, ballastMat, GRAVEL_TILE_M),
      ballastMat,
    );
    ballast.position.y = y;
    ballast.receiveShadow = true;
    root.add(ballast);

    const along = s.sx;
    const gauge = 1.435;
    const tieSpacing = 0.62;
    const tieCount = Math.max(3, Math.floor(along / tieSpacing));
    for (let t = 0; t < tieCount; t += 1) {
      const tx = -along * 0.5 + 0.4 + t * tieSpacing;
      const tie = new THREE.Mesh(
        prepareBoxGeometry(0.22, 0.12, s.sz * 0.72, tieMat, WOOD_TILE_M),
        tieMat,
      );
      tie.position.set(tx, y + 0.1, 0);
      root.add(tie);
    }
    for (const side of [-1, 1]) {
      const railZ = side * (gauge * 0.5);
      const web = new THREE.Mesh(
        prepareBoxGeometry(along * 0.96, 0.1, 0.08, railMat, METAL_TILE_M),
        railMat,
      );
      web.position.set(0, y + 0.16, railZ);
      root.add(web);
      const head = new THREE.Mesh(
        prepareBoxGeometry(along * 0.96, 0.07, 0.13, railMat, METAL_TILE_M),
        railMat,
      );
      head.position.set(0, y + 0.24, railZ);
      root.add(head);
    }
  }
}

/** Central turntable machinery — visual shell matching solid volume. */
function buildTurntable(group) {
  const solid = RAIL_CRUCIBLE.solidVolumes.find((s) => s.id === 'turntable-machinery');
  if (!solid) return;
  const cx = (solid.min[0] + solid.max[0]) / 2;
  const cz = (solid.min[2] + solid.max[2]) / 2;
  const cy = (solid.min[1] + solid.max[1]) / 2;
  const sx = solid.max[0] - solid.min[0];
  const sy = solid.max[1] - solid.min[1];
  const sz = solid.max[2] - solid.min[2];

  // Core block (matches collider envelope).
  addBox(group, {
    name: 'Turntable Core',
    cx, cy, cz, sx, sy, sz,
    material: rustMat,
    tileMeters: METAL_TILE_M,
  });

  // Ring deck
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(7.2, 7.2, 0.35, 28),
    rustEndMat,
  );
  ring.name = 'Turntable Ring';
  ring.position.set(cx, solid.max[1] + 0.1, cz);
  ring.castShadow = true;
  ring.receiveShadow = true;
  ensureUv2(ring.geometry);
  group.add(ring);

  // Hub + radial spokes
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(1.1, 1.4, 1.2, 16),
    railMat,
  );
  hub.position.set(cx, solid.max[1] + 0.7, cz);
  hub.castShadow = true;
  group.add(hub);

  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    const spoke = new THREE.Mesh(
      prepareBoxGeometry(5.8, 0.18, 0.35, railMat, METAL_TILE_M),
      railMat,
    );
    spoke.position.set(cx + Math.cos(a) * 3.2, solid.max[1] + 0.25, cz + Math.sin(a) * 3.2);
    spoke.rotation.y = -a;
    spoke.castShadow = true;
    group.add(spoke);
  }

  // Drive housings at cardinal points
  for (const [dx, dz] of [[5.5, 0], [-5.5, 0], [0, 5.5], [0, -5.5]]) {
    addBox(group, {
      name: `Turntable Drive ${dx}_${dz}`,
      cx: cx + dx, cy: solid.max[1] + 0.55, cz: cz + dz,
      sx: 1.6, sy: 1.1, sz: 1.2,
      material: rustEndMat,
      tileMeters: METAL_TILE_M,
    });
  }
}

/** Half boxcar cover on the mid floor. */
function buildHalfBoxcar(group) {
  const solid = RAIL_CRUCIBLE.solidVolumes.find((s) => s.id === 'half-boxcar');
  if (!solid) return;
  const cx = (solid.min[0] + solid.max[0]) / 2;
  const cz = (solid.min[2] + solid.max[2]) / 2;
  const floorY = solid.min[1];
  const L = solid.max[0] - solid.min[0];
  const W = solid.max[2] - solid.min[2];
  const H = solid.max[1] - solid.min[1];
  const deck = floorY + 0.35;

  // Deck / floor
  addBox(group, {
    name: 'Boxcar Deck',
    cx, cy: deck, cz,
    sx: L * 0.98, sy: 0.16, sz: W * 0.96,
    material: rustMat,
    tileMeters: METAL_TILE_M,
  });
  // Shell body matching solid envelope
  addBox(group, {
    name: 'Boxcar Body',
    cx, cy: floorY + H * 0.5, cz,
    sx: L, sy: H, sz: W,
    material: rustMat,
    tileMeters: METAL_TILE_M,
  });
  // Roof
  addBox(group, {
    name: 'Boxcar Roof',
    cx, cy: solid.max[1] + 0.1, cz,
    sx: L + 0.25, sy: 0.18, sz: W + 0.2,
    material: wallMat,
    tileMeters: METAL_TILE_M,
  });
  // Roofwalk
  addBox(group, {
    name: 'Boxcar Roofwalk',
    cx, cy: solid.max[1] + 0.24, cz,
    sx: L * 0.85, sy: 0.05, sz: 0.36,
    material: tieMat,
    tileMeters: WOOD_TILE_M,
    castShadow: false,
  });
  // Side ribs
  const ribCount = 6;
  for (let i = 0; i < ribCount; i += 1) {
    const t = (i + 0.5) / ribCount;
    const rx = solid.min[0] + t * L;
    for (const side of [-1, 1]) {
      addBox(group, {
        name: `Boxcar Rib ${i}_${side}`,
        cx: rx, cy: floorY + H * 0.5, cz: cz + side * (W * 0.5 + 0.04),
        sx: 0.1, sy: H * 0.9, sz: 0.08,
        material: rustEndMat,
        tileMeters: METAL_TILE_M,
        castShadow: false,
      });
    }
  }
  // Undercarriage sill
  addBox(group, {
    name: 'Boxcar Sill',
    cx, cy: floorY + 0.18, cz,
    sx: L * 0.96, sy: 0.28, sz: W * 0.7,
    material: rustEndMat,
    tileMeters: METAL_TILE_M,
  });
  // Bogie suggestion
  for (const end of [-1, 1]) {
    addBox(group, {
      name: `Boxcar Bogie ${end}`,
      cx: cx + end * L * 0.28, cy: floorY + 0.22, cz,
      sx: 1.4, sy: 0.45, sz: W * 0.85,
      material: railMat,
      tileMeters: METAL_TILE_M,
    });
  }
}

/** Upper signal room (sentinel overlook). */
function buildSignalRoom(group) {
  const solid = RAIL_CRUCIBLE.solidVolumes.find((s) => s.id === 'signal-room');
  if (!solid) return;
  const cx = (solid.min[0] + solid.max[0]) / 2;
  const cz = (solid.min[2] + solid.max[2]) / 2;
  const cy = (solid.min[1] + solid.max[1]) / 2;
  const sx = solid.max[0] - solid.min[0];
  const sy = solid.max[1] - solid.min[1];
  const sz = solid.max[2] - solid.min[2];

  addBox(group, {
    name: 'Signal Room Body',
    cx, cy, cz, sx, sy, sz,
    material: brickMat,
    tileMeters: BRICK_TILE_M,
  });
  // Metal roof overhang
  addBox(group, {
    name: 'Signal Room Roof',
    cx, cy: solid.max[1] + 0.14, cz,
    sx: sx + 0.6, sy: 0.28, sz: sz + 0.6,
    material: wallMat,
    tileMeters: METAL_TILE_M,
  });
  // Window light bands (tier landmark)
  for (const face of [
    { cx: solid.min[0] - 0.05, cz, sx: 0.12, sz: sz * 0.55 },
    { cx: solid.max[0] + 0.05, cz, sx: 0.12, sz: sz * 0.55 },
    { cx, cz: solid.min[2] - 0.05, sx: sx * 0.55, sz: 0.12 },
  ]) {
    addBox(group, {
      name: 'Signal Window',
      cx: face.cx, cy: solid.min[1] + sy * 0.55, cz: face.cz,
      sx: face.sx, sy: 1.1, sz: face.sz,
      material: accentMats.upper,
      tileMeters: 1,
      castShadow: false,
    });
  }
  // Antenna / mast
  addBox(group, {
    name: 'Signal Mast',
    cx: cx + 1.5, cy: solid.max[1] + 1.6, cz: cz - 1.2,
    sx: 0.12, sy: 3.0, sz: 0.12,
    material: railMat,
    tileMeters: METAL_TILE_M,
    castShadow: false,
  });
  addBox(group, {
    name: 'Signal Dish',
    cx: cx + 1.5, cy: solid.max[1] + 3.0, cz: cz - 1.2,
    sx: 0.8, sy: 0.12, sz: 0.8,
    material: rustEndMat,
    tileMeters: METAL_TILE_M,
    castShadow: false,
  });
}

/** Overhead crane bridge spanning the upper mid line. */
function buildCraneBridge(group) {
  const crane = RAIL_CRUCIBLE.shotOccluders.find((o) => o.id === 'occ-crane-bridge');
  if (!crane) return;
  const cx = (crane.min[0] + crane.max[0]) / 2;
  const cy = (crane.min[1] + crane.max[1]) / 2;
  const cz = (crane.min[2] + crane.max[2]) / 2;
  const sx = crane.max[0] - crane.min[0];
  const sy = crane.max[1] - crane.min[1];
  const sz = crane.max[2] - crane.min[2];

  // Main beam (matches occluder / collider envelope)
  addBox(group, {
    name: 'Crane Beam',
    cx, cy, cz, sx, sy, sz,
    material: wallMat,
    tileMeters: METAL_TILE_M,
  });

  // Truss lattice (visual)
  const bay = 4;
  const bays = Math.floor(sx / bay);
  for (let i = 0; i < bays; i += 1) {
    const x = crane.min[0] + (i + 0.5) * bay;
    // Vertical posts
    for (const side of [-1, 1]) {
      addBox(group, {
        name: `Crane post ${i}_${side}`,
        cx: x, cy, cz: cz + side * (sz * 0.55 + 0.08),
        sx: 0.16, sy: sy + 0.4, sz: 0.16,
        material: railMat,
        tileMeters: METAL_TILE_M,
        castShadow: false,
      });
    }
    // Diagonal
    const diag = new THREE.Mesh(
      prepareBoxGeometry(bay * 0.9, 0.12, 0.12, railMat, METAL_TILE_M),
      railMat,
    );
    diag.position.set(x, cy + 0.3, cz);
    diag.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.45;
    group.add(diag);
  }

  // Trolley carriage at centre
  addBox(group, {
    name: 'Crane Trolley',
    cx: 0, cy: cy - 0.55, cz,
    sx: 2.4, sy: 0.7, sz: sz + 0.6,
    material: rustMat,
    tileMeters: METAL_TILE_M,
  });
  // Hook block
  addBox(group, {
    name: 'Crane Hook',
    cx: 0, cy: cy - 1.6, cz,
    sx: 0.45, sy: 1.1, sz: 0.45,
    material: rustEndMat,
    tileMeters: METAL_TILE_M,
  });

  // Support towers sit just off the bridge walkway (z=±3.6) so the upper
  // catwalk stays clear — visuals only, no colliders.
  for (const end of [-1, 1]) {
    const tx = end * 23;
    for (const side of [-1, 1]) {
      const tz = side * 3.6;
      addBox(group, {
        name: `Crane Tower ${end}_${side}`,
        cx: tx, cy: 7.5, cz: tz,
        sx: 1.2, sy: 9, sz: 1.2,
        material: rustMat,
        tileMeters: METAL_TILE_M,
      });
      for (const y of [4, 7, 10]) {
        addBox(group, {
          name: `Crane Brace ${end}_${side}_${y}`,
          cx: tx, cy: y, cz: tz,
          sx: 1.6, sy: 0.18, sz: 1.6,
          material: railMat,
          tileMeters: METAL_TILE_M,
          castShadow: false,
        });
      }
    }
  }
}

/**
 * Catwalk handrails on the *outer* perimeter of upper gantries only.
 * Inner edges stay open so players can drop to mid and so ramp landings are not
 * fenced shut. Visual-only (no colliders).
 */
function buildGantryRailings(group) {
  const outerRails = [
    // North catwalk outer (-Z)
    { minX: -24, maxX: 24, z: -23.85, along: 'x' },
    // South catwalk outer (+Z)
    { minX: -24, maxX: 24, z: 23.85, along: 'x' },
    // West catwalk outer (-X)
    { minZ: -24, maxZ: 24, x: -23.85, along: 'z' },
    // East catwalk outer (+X) — leave a gap where the mid→upper ramp lands
    { minZ: -24, maxZ: 1.5, x: 23.85, along: 'z' },
    { minZ: 14.8, maxZ: 24, x: 23.85, along: 'z' },
  ];
  const floorY = 6;
  const railH = 1.05;
  for (let i = 0; i < outerRails.length; i += 1) {
    const r = outerRails[i];
    if (r.along === 'x') {
      const sx = r.maxX - r.minX;
      const cx = (r.minX + r.maxX) / 2;
      addBox(group, {
        name: `Gantry rail ${i}`,
        cx, cy: floorY + railH, cz: r.z,
        sx, sy: 0.08, sz: 0.08,
        material: railMat,
        tileMeters: METAL_TILE_M,
        castShadow: false,
      });
      addBox(group, {
        name: `Gantry kick ${i}`,
        cx, cy: floorY + 0.12, cz: r.z,
        sx, sy: 0.1, sz: 0.08,
        material: rustEndMat,
        tileMeters: METAL_TILE_M,
        castShadow: false,
      });
    } else {
      const sz = r.maxZ - r.minZ;
      if (sz < 0.5) continue;
      const cz = (r.minZ + r.maxZ) / 2;
      addBox(group, {
        name: `Gantry rail ${i}`,
        cx: r.x, cy: floorY + railH, cz,
        sx: 0.08, sy: 0.08, sz,
        material: railMat,
        tileMeters: METAL_TILE_M,
        castShadow: false,
      });
      addBox(group, {
        name: `Gantry kick ${i}`,
        cx: r.x, cy: floorY + 0.12, cz,
        sx: 0.08, sy: 0.1, sz,
        material: rustEndMat,
        tileMeters: METAL_TILE_M,
        castShadow: false,
      });
    }
  }
}

/** Sodium work lights + tier colour fixtures. */
function buildLightingProps(group) {
  const poles = [
    { x: -20, z: -20, tier: 'lower', y: -4 },
    { x: 20, z: -20, tier: 'lower', y: -4 },
    { x: -20, z: 20, tier: 'lower', y: -4 },
    { x: 20, z: 20, tier: 'lower', y: -4 },
    { x: -26, z: 0, tier: 'mid', y: 0 },
    { x: 26, z: 0, tier: 'mid', y: 0 },
    { x: 0, z: -26, tier: 'mid', y: 0 },
    { x: 0, z: 26, tier: 'mid', y: 0 },
    { x: -18, z: -18, tier: 'upper', y: 6 },
    { x: 18, z: -18, tier: 'upper', y: 6 },
    { x: -18, z: 18, tier: 'upper', y: 6 },
    { x: 10, z: 18, tier: 'upper', y: 6 },
  ];
  for (const p of poles) {
    const h = p.tier === 'upper' ? 3.2 : 5.5;
    addBox(group, {
      name: `Light pole ${p.x}_${p.z}`,
      cx: p.x, cy: p.y + h * 0.5, cz: p.z,
      sx: 0.18, sy: h, sz: 0.18,
      material: railMat,
      tileMeters: METAL_TILE_M,
      castShadow: false,
    });
    // Sodium lamp head
    addBox(group, {
      name: `Lamp head ${p.x}_${p.z}`,
      cx: p.x, cy: p.y + h + 0.12, cz: p.z,
      sx: 0.85, sy: 0.18, sz: 0.45,
      material: rustEndMat,
      tileMeters: METAL_TILE_M,
      castShadow: false,
    });
    // Tier-coloured underglow
    addBox(group, {
      name: `Lamp glow ${p.x}_${p.z}`,
      cx: p.x, cy: p.y + h - 0.05, cz: p.z,
      sx: 0.55, sy: 0.08, sz: 0.28,
      material: accentMats[p.tier],
      tileMeters: 1,
      castShadow: false,
    });
  }
}

/** Undercroft pillars + drain channel dressing. */
function buildUndercroftDetails(group) {
  // Support pillars under mid floor openings around turntable
  const pillars = [
    [-10, -10], [10, -10], [-10, 10], [10, 10],
    [-18, 0], [18, 0], [0, -18], [0, 18],
  ];
  for (const [px, pz] of pillars) {
    addBox(group, {
      name: `Undercroft pillar ${px}_${pz}`,
      cx: px, cy: -2, cz: pz,
      sx: 1.1, sy: 4, sz: 1.1,
      material: concreteLikePillar(),
      tileMeters: WALL_TILE_M,
    });
  }

  // Drain channel running undercroft N–S (visual)
  addBox(group, {
    name: 'Drain channel',
    cx: 0, cy: -3.92, cz: 0,
    sx: 2.4, sy: 0.18, sz: 40,
    material: undercroftMat,
    tileMeters: GRAVEL_TILE_M,
    castShadow: false,
  });
  addBox(group, {
    name: 'Drain grate',
    cx: 0, cy: -3.78, cz: 0,
    sx: 1.6, sy: 0.06, sz: 38,
    material: railMat,
    tileMeters: METAL_TILE_M,
    castShadow: false,
  });
}

/** Pillar material alias — reuses undercroft concrete (keeps batch count down). */
function concreteLikePillar() {
  return undercroftMat;
}

/** Yard crates / drums near contested pickups (visual cover cues, no colliders). */
function buildYardProps(group) {
  const clusters = [
    { x: 10, y: 0, z: 8, n: 3 },
    { x: -14, y: -4, z: 8, n: 2 },
    { x: 0, y: 6, z: -18, n: 2 },
    { x: -8, y: 0, z: 18, n: 3 },
  ];
  let di = 0;
  for (const c of clusters) {
    for (let i = 0; i < c.n; i += 1) {
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, 0.95, 10),
        i % 2 === 0 ? rustEndMat : rustMat,
      );
      drum.name = `Drum ${di++}`;
      drum.position.set(c.x + (i % 2) * 0.7, c.y + 0.48, c.z + Math.floor(i / 2) * 0.7);
      drum.castShadow = true;
      ensureUv2(drum.geometry);
      group.add(drum);
    }
  }
  // Pallet stacks
  for (const [px, py, pz] of [[-16, 0, 14], [16, 0, -14], [6, -4, -16]]) {
    addBox(group, {
      name: `Pallets ${px}_${pz}`,
      cx: px, cy: py + 0.55, cz: pz,
      sx: 1.35, sy: 1.1, sz: 1.15,
      material: tieMat,
      tileMeters: WOOD_TILE_M,
    });
  }
}

// ── Static merge ─────────────────────────────────────────────────────────────

/**
 * Merge all static opaque meshes by material into a handful of draws.
 * Colliders are independent AABB data and stay valid after the visual tree collapses.
 */
function mergeStaticArenaGeometry(root) {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  /** @type {Map<string, { material: THREE.Material, geometries: THREE.BufferGeometry[], sources: THREE.Mesh[] }>} */
  const batches = new Map();

  root.traverse((object) => {
    if (!object.isMesh || object.isSkinnedMesh || object.isInstancedMesh) return;
    if (!object.geometry?.isBufferGeometry) return;
    if (Array.isArray(object.material) || !object.material) return;
    if (object.userData?.noStaticMerge) return;

    const key = object.material.uuid;
    let batch = batches.get(key);
    if (!batch) {
      batch = { material: object.material, geometries: [], sources: [] };
      batches.set(key, batch);
    }

    relative.multiplyMatrices(rootInverse, object.matrixWorld);
    const geometry = object.geometry.clone();
    if (geometry.morphAttributes) geometry.morphAttributes = {};
    geometry.applyMatrix4(relative);
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'uv2') {
        geometry.deleteAttribute(name);
      }
    }
    if (!geometry.getAttribute('normal') && geometry.getAttribute('position')) {
      geometry.computeVertexNormals();
    }
    batch.geometries.push(geometry);
    batch.sources.push(object);
  });

  for (const batch of batches.values()) {
    if (batch.geometries.length < 2) continue;
    const common = new Set(Object.keys(batch.geometries[0].attributes));
    for (let i = 1; i < batch.geometries.length; i += 1) {
      const names = new Set(Object.keys(batch.geometries[i].attributes));
      for (const name of [...common]) {
        if (!names.has(name)) common.delete(name);
      }
    }
    if (!common.has('position')) common.add('position');
    for (const geometry of batch.geometries) {
      for (const name of Object.keys(geometry.attributes)) {
        if (!common.has(name)) geometry.deleteAttribute(name);
      }
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    }
  }

  const mergedMeshes = [];
  const consumed = new Set();

  for (const batch of batches.values()) {
    let geometry = null;
    try {
      geometry = batch.geometries.length === 1
        ? batch.geometries[0]
        : mergeGeometries(batch.geometries, false);
    } catch (err) {
      console.warn('[RailCrucible] merge failed for material batch, keeping individuals', err);
      for (const g of batch.geometries) g.dispose?.();
      continue;
    }
    if (!geometry) {
      for (const g of batch.geometries) g.dispose?.();
      continue;
    }
    if (batch.geometries.length > 1) {
      for (const g of batch.geometries) g.dispose?.();
    }

    const mesh = new THREE.Mesh(geometry, batch.material);
    mesh.name = `Crucible Static Batch ${mergedMeshes.length + 1}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.static = true;
    mesh.frustumCulled = true;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    mergedMeshes.push(mesh);
    for (const source of batch.sources) consumed.add(source);
  }

  const disposedGeo = new Set();
  for (const mesh of consumed) {
    mesh.removeFromParent();
    if (mesh.geometry && !disposedGeo.has(mesh.geometry)) {
      disposedGeo.add(mesh.geometry);
      mesh.geometry.dispose?.();
    }
  }
  for (const mesh of mergedMeshes) root.add(mesh);

  // Drop empty groups left after merge.
  const groups = [];
  root.traverse((object) => {
    if (object.isGroup && object !== root) groups.push(object);
  });
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (g.children.length === 0) g.removeFromParent();
  }

  return { batches: mergedMeshes.length, sourceMeshes: consumed.size };
}

// ── Level factory ────────────────────────────────────────────────────────────

/**
 * @param {object} [_qualityPreset]
 */
export function createDeathmatchArenaLevel(_qualityPreset = {}) {
  const group = new THREE.Group();
  group.name = 'Rail Crucible';
  const colliders = [];

  // Floors from walkable volumes (render + ground colliders).
  buildTierFloors(group, colliders);

  // Perimeter solids → colliders from descriptor, visuals richer.
  for (const solid of RAIL_CRUCIBLE.solidVolumes) {
    const surface = solid.id.startsWith('wall') ? 'metal' : 'rust';
    colliderFromVolume(colliders, `Solid ${solid.id}`, solid.min, solid.max, surface);
  }
  // Crane bridge is an occluder that also acts as a solid for movement.
  const crane = RAIL_CRUCIBLE.shotOccluders.find((o) => o.id === 'occ-crane-bridge');
  if (crane) {
    colliderFromVolume(colliders, 'Solid crane-bridge', crane.min, crane.max, 'metal');
  }

  buildPerimeterWalls(group);
  buildTransferRails(group);
  buildTurntable(group);
  buildHalfBoxcar(group);
  buildSignalRoom(group);
  buildCraneBridge(group);
  buildGantryRailings(group);
  buildLightingProps(group);
  buildUndercroftDetails(group);
  buildYardProps(group);

  // Vertical connectors: authored ramps (jump pad + teleporter from descriptor).
  for (const ramp of RAIL_CRUCIBLE.ramps ?? []) {
    addRamp(group, colliders, {
      name: `Ramp ${ramp.id}`,
      x: ramp.x,
      z0: ramp.z0,
      z1: ramp.z1,
      lowY: ramp.lowY,
      highY: ramp.highY,
      width: ramp.width,
    });
  }

  const staticGeometry = mergeStaticArenaGeometry(group);

  // ── Dynamic markers: pickups, jump pads, teleporters ──────────────────────
  const pickupMarkers = [];
  const pickupGeo = new THREE.BoxGeometry(0.5, 1.0, 0.5);
  for (const spec of RAIL_CRUCIBLE.pickupSpawns) {
    const color = PICKUP_COLOR[spec.kind] ?? 0xffffff;
    const mat = makeEmissiveMaterial(color, 1.15);
    const mesh = new THREE.Mesh(pickupGeo, mat);
    mesh.name = `Pickup ${spec.id}`;
    mesh.position.set(spec.position[0], spec.position[1] + 0.9, spec.position[2]);
    mesh.userData.skipLevelRaycast = true;
    mesh.userData.noStaticMerge = true;
    mesh.userData.pickupId = spec.id;
    group.add(mesh);
    pickupMarkers.push({ mesh, material: mat, baseY: mesh.position.y, kind: spec.kind });
  }

  const padGeo = new THREE.BoxGeometry(1, 0.12, 1);
  for (const pad of RAIL_CRUCIBLE.jumpPads) {
    const mat = makeEmissiveMaterial(0x3aa0ff, 1.45);
    const mesh = new THREE.Mesh(padGeo, mat);
    const cx = (pad.bounds.min[0] + pad.bounds.max[0]) / 2;
    const cz = (pad.bounds.min[2] + pad.bounds.max[2]) / 2;
    mesh.position.set(cx, pad.bounds.min[1] + 0.06, cz);
    mesh.scale.set(pad.bounds.max[0] - pad.bounds.min[0], 1, pad.bounds.max[2] - pad.bounds.min[2]);
    mesh.name = `JumpPad ${pad.id}`;
    mesh.userData.skipLevelRaycast = true;
    mesh.userData.noStaticMerge = true;
    group.add(mesh);
    // Ring frame for readability
    const frame = new THREE.Mesh(
      prepareBoxGeometry(
        (pad.bounds.max[0] - pad.bounds.min[0]) + 0.3,
        0.08,
        (pad.bounds.max[2] - pad.bounds.min[2]) + 0.3,
        railMat,
        METAL_TILE_M,
      ),
      railMat,
    );
    frame.position.set(cx, pad.bounds.min[1] + 0.02, cz);
    frame.userData.noStaticMerge = true;
    group.add(frame);
  }
  for (const tp of RAIL_CRUCIBLE.teleporters) {
    const mat = makeEmissiveMaterial(0x9a4bff, 1.45);
    const mesh = new THREE.Mesh(padGeo, mat);
    const cx = (tp.bounds.min[0] + tp.bounds.max[0]) / 2;
    const cz = (tp.bounds.min[2] + tp.bounds.max[2]) / 2;
    mesh.position.set(cx, tp.bounds.min[1] + 0.06, cz);
    mesh.scale.set(tp.bounds.max[0] - tp.bounds.min[0], 1, tp.bounds.max[2] - tp.bounds.min[2]);
    mesh.name = `Teleporter ${tp.id}`;
    mesh.userData.skipLevelRaycast = true;
    mesh.userData.noStaticMerge = true;
    group.add(mesh);
  }

  const geometryIndex = createLevelGeometryIndex(group);

  // Dev-solo spawn: a mid-tier point that faces the arena centre.
  const devSpawn = RAIL_CRUCIBLE.playerSpawns.find((s) => s.id === 'spawn-m3') ?? RAIL_CRUCIBLE.playerSpawns[0];
  const spawnPoint = new THREE.Vector3(devSpawn.position[0], devSpawn.position[1], devSpawn.position[2]);

  const clock = { t: 0 };

  return {
    name: 'Rail Crucible',
    group,
    colliders,
    ledges: [],
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    geometryIndex,
    spawnPoint,
    spawnYaw: devSpawn.yaw,
    arenaMapId: RAIL_CRUCIBLE.id,
    deathmatchEnvironment: { ...DEATHMATCH_ENVIRONMENT },
    isNearFieldReady: () => true,
    createPipelineWarmupGroup: () => createMaterialWarmupGroup(STATIC_MATERIALS, 'Crucible Pipeline Warmup'),
    getGroundHeightAt: (position, radius = 0.28, options = {}) => getGroundHeightAt({
      position,
      radius,
      maxStepUp: options.maxStepUp,
      maxSnapDown: options.maxSnapDown,
      requiredInset: options.requiredInset,
      colliders,
      baseHeight: BASE_HEIGHT,
    }),
    getBlockingColliderAt: ({ position, radius, feetY, height, stepHeight }) => getBlockingColliderAt({
      position,
      radius,
      feetY,
      height,
      stepHeight,
      // Skip walkable decks (ramps): their AABBs would otherwise act as walls.
      colliders: colliders.filter((c) => c.blockMovement !== false),
    }),
    getRoadSurfaceAt: () => null,
    findNearestRoadPoint: () => null,
    updateStreaming: () => null,
    /** Bob/spin the pickup pylons for readability (visual only). */
    update: ({ delta = 0 } = {}) => {
      clock.t += delta;
      for (const marker of pickupMarkers) {
        marker.mesh.position.y = marker.baseY + Math.sin(clock.t * 2 + marker.baseY) * 0.12;
        marker.mesh.rotation.y = clock.t * 1.2;
      }
    },
    /** Toggle a pickup pylon's visibility from an authoritative availability. */
    setPickupAvailable: (pickupId, available) => {
      for (const marker of pickupMarkers) {
        if (marker.mesh.userData.pickupId === pickupId) marker.mesh.visible = available !== false;
      }
    },
    snapshot: () => ({
      mode: 'deathmatch',
      arena: RAIL_CRUCIBLE.id,
      revision: RAIL_CRUCIBLE.revision,
      spawns: RAIL_CRUCIBLE.playerSpawns.length,
      pickups: RAIL_CRUCIBLE.pickupSpawns.length,
      connectors: 2 + RAIL_CRUCIBLE.jumpPads.length + RAIL_CRUCIBLE.teleporters.length,
      tiers: 3,
      colliders: colliders.length,
      drawCalls: staticGeometry.batches,
      materialBatches: staticGeometry.batches,
      sourceMeshes: staticGeometry.sourceMeshes,
    }),
    dispose: () => {
      disposeObject3D(group);
      pickupGeo.dispose();
      padGeo.dispose();
    },
  };
}
