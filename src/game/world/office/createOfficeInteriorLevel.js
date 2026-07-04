// createOfficeInteriorLevel.js — P0 placeholder interior (docs/office-interior-wfc-plan.md).
//
// A single box room sized to a building footprint: floor, ceiling, four walls
// with a door gap on the entry facade, plus an exit trigger volume just inside
// the door. Returns the same level interface the runtime already consumes
// (group, colliders, getGroundHeightAt/getBlockingColliderAt, spawnPoint,
// dispose), so LevelSystem can swap it in like any other level. P1 replaces the
// box with a WFC-filled plate; the interface stays put.

import * as THREE from 'three';
import { disposeObject3D } from '../../utils/disposeObject3D.js';
import { getGroundHeightAt, getBlockingColliderAt } from '../createBaseLevel.js';
import { generateOfficeLayout } from './generateOfficeLayout.js';
import { getOfficeWallMaterial } from './officeWallMaterial.js';

// Which world axis+direction each facade's door faces INTO the room. Matches
// buildingEntry.js facade ids.
const FACADE_INWARD = {
  NX: { x: 1, z: 0 },
  PX: { x: -1, z: 0 },
  NZ: { x: 0, z: 1 },
  PZ: { x: 0, z: -1 },
};

function boxCollider(name, minX, maxX, minZ, maxZ, bottomY, topY) {
  return { name, minX, maxX, minZ, maxZ, bottomY, topY };
}

// Shared across every interior so WebGPU compiles these pipelines ONCE, not per
// room — the per-entry material compile was the hitch that motivated persisting
// interiors instead of rebuilding them. (Geometry still varies per footprint.)
const FLOOR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x9a9a9e, roughness: 0.85, metalness: 0.0 });
const CEIL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xf0f0f2, roughness: 0.95, metalness: 0.0 });
const WALL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xcdcdd2, roughness: 0.9, metalness: 0.0 });

// Per-zone floor tints + furniture (shared → compile once). Visual only.
const ZONE_FLOOR_MATERIALS = {
  open: new THREE.MeshStandardMaterial({ color: 0x55606e, roughness: 0.95, metalness: 0.0 }),     // carpet
  corridor: new THREE.MeshStandardMaterial({ color: 0xb9b9bd, roughness: 0.6, metalness: 0.0 }),  // polished
  meeting: new THREE.MeshStandardMaterial({ color: 0x8a745a, roughness: 0.8, metalness: 0.0 }),   // wood
  office: new THREE.MeshStandardMaterial({ color: 0x7d6b52, roughness: 0.82, metalness: 0.0 }),   // wood
};
const DESK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x6d5a42, roughness: 0.7, metalness: 0.05 });
const MONITOR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.35, metalness: 0.2 });
const TABLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x3c3c44, roughness: 0.5, metalness: 0.15 });
const PLANT_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.85, metalness: 0.0 });

// Glass meeting-room partitions (see the real furnished room behind) + emissive
// recessed ceiling panels. Shared → compile once.
const GLASS_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x9fc4d4, roughness: 0.06, metalness: 0.0,
  transparent: true, opacity: 0.24, depthWrite: false, side: THREE.DoubleSide,
});
const CEILING_PANEL_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xffffff, emissive: 0xfff4e0, emissiveIntensity: 1.4, roughness: 1.0, metalness: 0.0,
});

const DESK_GEOMETRY = new THREE.BoxGeometry(1.2, 0.74, 0.62);
const MONITOR_GEOMETRY = new THREE.BoxGeometry(0.55, 0.34, 0.05);
const TABLE_GEOMETRY = new THREE.BoxGeometry(1.9, 0.74, 1.05);
const PLANT_GEOMETRY = new THREE.BoxGeometry(0.4, 0.95, 0.4);

// Deterministic per-cell hash in [0,1) for furniture placement variety.
function cellHash(seed, x, z) {
  let h = (seed | 0) ^ Math.imul(x + 1, 374761393) ^ Math.imul(z + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * @param {object} opts
 * @param {number} opts.width  interior width (X), metres
 * @param {number} opts.depth  interior depth (Z), metres
 * @param {'NX'|'PX'|'NZ'|'PZ'} [opts.doorFacade='NZ'] which wall carries the door
 * @param {{x,y,z}} [opts.origin]  room-centre floor position in world space
 */
export function createOfficeInteriorLevel({
  width = 16,
  depth = 16,
  doorFacade = 'NZ',
  origin = { x: 0, y: 0, z: 0 },
  wallHeight = 3.2,
  wallThickness = 0.3,
  doorWidth = 2.4,
  seed = 1,
} = {}) {
  const group = new THREE.Group();
  group.name = 'Office Interior';

  const halfW = Math.max(width, doorWidth + 2) * 0.5;
  const halfD = Math.max(depth, doorWidth + 2) * 0.5;
  const floorY = origin.y;
  const ceilY = floorY + wallHeight;
  const minX = origin.x - halfW;
  const maxX = origin.x + halfW;
  const minZ = origin.z - halfD;
  const maxZ = origin.z + halfD;

  const colliders = [];
  const buildOnly = typeof document === 'undefined';

  // Placeholder PBR (P2 swaps in POM walls); materials are shared module-level
  // singletons so the pipeline compiles once across all interiors.
  const floorMat = FLOOR_MATERIAL;
  const ceilMat = CEIL_MATERIAL;
  // Ultra: parallax-occlusion paneled walls; otherwise plain. When POM is on,
  // each wall geometry needs tangents (it marches in tangent space).
  const pomWall = buildOnly ? null : getOfficeWallMaterial();
  const wallMat = pomWall ?? WALL_MATERIAL;
  const pomWalls = pomWall != null;

  // Floor + ceiling.
  const floor = new THREE.Mesh(new THREE.BoxGeometry(width, 0.4, depth), floorMat);
  floor.position.set(origin.x, floorY - 0.2, origin.z);
  floor.receiveShadow = true;
  floor.name = 'Office Floor';
  group.add(floor);
  colliders.push(boxCollider('office-floor', minX, maxX, minZ, maxZ, floorY - 0.4, floorY));

  const ceil = new THREE.Mesh(new THREE.BoxGeometry(width, 0.2, depth), ceilMat);
  ceil.position.set(origin.x, ceilY + 0.1, origin.z);
  ceil.name = 'Office Ceiling';
  group.add(ceil);

  // Four walls. The door facade is split into two segments leaving a centred gap.
  const t = wallThickness;
  const wallMidY = floorY + wallHeight * 0.5;

  const addWallBox = (name, cx, cz, sx, sz, mat = wallMat, pom = pomWalls) => {
    const geom = new THREE.BoxGeometry(sx, wallHeight, sz);
    if (pom) geom.computeTangents();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, wallMidY, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    group.add(mesh);
    colliders.push(boxCollider(name, cx - sx / 2, cx + sx / 2, cz - sz / 2, cz + sz / 2, floorY, ceilY));
  };

  // For each of the four sides, either a solid wall or two segments with a gap.
  const sides = [
    { facade: 'NZ', horizontal: true, cz: minZ + t / 2, cx: origin.x, span: width, sz: t },
    { facade: 'PZ', horizontal: true, cz: maxZ - t / 2, cx: origin.x, span: width, sz: t },
    { facade: 'NX', horizontal: false, cx: minX + t / 2, cz: origin.z, span: depth, sz: t },
    { facade: 'PX', horizontal: false, cx: maxX - t / 2, cz: origin.z, span: depth, sz: t },
  ];

  for (const side of sides) {
    const name = `Office Wall ${side.facade}`;
    if (side.facade !== doorFacade) {
      if (side.horizontal) addWallBox(name, side.cx, side.cz, side.span, t);
      else addWallBox(name, side.cx, side.cz, t, side.span);
      continue;
    }
    // Door gap: two segments either side of a centred opening.
    const segLen = Math.max((side.span - doorWidth) / 2, 0.2);
    if (side.horizontal) {
      addWallBox(`${name} A`, side.cx - (doorWidth / 2 + segLen / 2), side.cz, segLen, t);
      addWallBox(`${name} B`, side.cx + (doorWidth / 2 + segLen / 2), side.cz, segLen, t);
    } else {
      addWallBox(`${name} A`, side.cx, side.cz - (doorWidth / 2 + segLen / 2), t, segLen);
      addWallBox(`${name} B`, side.cx, side.cz + (doorWidth / 2 + segLen / 2), t, segLen);
    }
  }

  // Interior partition walls from the WFC floor plan (rooms off corridors).
  // Meeting rooms get glass partitions (see the real furnished room behind);
  // office rooms stay solid (POM on ultra). Both still carry colliders.
  const layout = generateOfficeLayout({ width, depth, doorFacade, seed });
  layout.walls.forEach((w, i) => {
    const glass = w.zone === 'meeting' && !buildOnly;
    addWallBox(
      `Office Partition ${i}`,
      origin.x + w.cx,
      origin.z + w.cz,
      w.sx,
      w.sz,
      glass ? GLASS_MATERIAL : wallMat,
      glass ? false : pomWalls,
    );
  });

  if (!buildOnly) {
    // Per-zone floor tint + furniture, instanced per type (shared materials
    // compile once). Visual only — no colliders. Deterministic by seed.
    const cw = layout.cellW;
    const cd = layout.cellD;
    const originMinX = origin.x - width / 2;
    const originMinZ = origin.z - depth / 2;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();

    const tileGeom = new THREE.BoxGeometry(cw * 0.98, 0.05, cd * 0.98);
    const zoneMatrices = { open: [], corridor: [], meeting: [], office: [] };
    const deskMatrices = [];
    const monitorMatrices = [];
    const tableMatrices = [];
    const plantMatrices = [];
    const ceilingMatrices = [];

    for (let gx = 0; gx < layout.cols; gx += 1) {
      for (let gz = 0; gz < layout.rows; gz += 1) {
        const zone = layout.zones[gx][gz];
        const cx = originMinX + (gx + 0.5) * cw;
        const cz = originMinZ + (gz + 0.5) * cd;
        (zoneMatrices[zone] ?? zoneMatrices.open).push(
          m.compose(p.set(cx, floorY + 0.03, cz), q, s).clone(),
        );
        // Recessed emissive ceiling panel per cell.
        ceilingMatrices.push(m.compose(p.set(cx, ceilY - 0.06, cz), q, s).clone());

        const h = cellHash(seed, gx, gz);
        if ((zone === 'open' || zone === 'office') && h < 0.7) {
          deskMatrices.push(m.compose(p.set(cx, floorY + 0.37, cz), q, s).clone());
          monitorMatrices.push(m.compose(p.set(cx, floorY + 0.92, cz - 0.22), q, s).clone());
        } else if (zone === 'meeting' && h < 0.5) {
          tableMatrices.push(m.compose(p.set(cx, floorY + 0.37, cz), q, s).clone());
        } else if ((zone === 'open' || zone === 'corridor') && h > 0.9) {
          plantMatrices.push(m.compose(p.set(cx, floorY + 0.48, cz), q, s).clone());
        }
      }
    }

    const addInstanced = (geom, mat, matrices, name) => {
      if (matrices.length === 0) return;
      const inst = new THREE.InstancedMesh(geom, mat, matrices.length);
      for (let i = 0; i < matrices.length; i += 1) inst.setMatrixAt(i, matrices[i]);
      inst.instanceMatrix.needsUpdate = true;
      inst.receiveShadow = true;
      inst.name = name;
      group.add(inst);
    };
    for (const zone of Object.keys(zoneMatrices)) {
      addInstanced(tileGeom, ZONE_FLOOR_MATERIALS[zone], zoneMatrices[zone], `Office Floor ${zone}`);
    }
    addInstanced(DESK_GEOMETRY, DESK_MATERIAL, deskMatrices, 'Office Desks');
    addInstanced(MONITOR_GEOMETRY, MONITOR_MATERIAL, monitorMatrices, 'Office Monitors');
    addInstanced(TABLE_GEOMETRY, TABLE_MATERIAL, tableMatrices, 'Office Tables');
    addInstanced(PLANT_GEOMETRY, PLANT_MATERIAL, plantMatrices, 'Office Plants');
    const panelGeom = new THREE.BoxGeometry(cw * 0.62, 0.08, cd * 0.62);
    addInstanced(panelGeom, CEILING_PANEL_MATERIAL, ceilingMatrices, 'Office Ceiling Panels');

    // The interior's own lights — outdoor sun/sky/hemisphere are suppressed while
    // inside (GameRuntime._suppressOutdoorLighting), so these do all the work. The
    // hemisphere gives an even fill; the point light adds a warm centre highlight;
    // the emissive ceiling panels carry the look (and bloom on ultra).
    const ambient = new THREE.HemisphereLight(0xf4f6ff, 0x3a3a42, 1.25);
    group.add(ambient);
    const lamp = new THREE.PointLight(0xfff4e0, 1.0, Math.max(width, depth) * 1.6);
    lamp.position.set(origin.x, ceilY - 0.3, origin.z);
    group.add(lamp);
  }

  // Spawn + exit trigger: just inside the door, offset inward.
  const inward = FACADE_INWARD[doorFacade] ?? FACADE_INWARD.NZ;
  const doorEdgeX = doorFacade === 'NX' ? minX : doorFacade === 'PX' ? maxX : origin.x;
  const doorEdgeZ = doorFacade === 'NZ' ? minZ : doorFacade === 'PZ' ? maxZ : origin.z;
  const spawnPoint = new THREE.Vector3(
    doorEdgeX + inward.x * 1.6,
    floorY,
    doorEdgeZ + inward.z * 1.6,
  );
  // Exit-prompt zone at the doorway (pure AABB, XZ-tested by the runtime). It runs
  // from just OUTSIDE the wall (-0.5 along inward) to a bit past the spawn (2.2
  // along inward, so you spawn already inside the zone and see the prompt), and
  // spreads across the doorway. Built with min/max so it is correct for BOTH
  // positive and negative inward normals (PZ/PX doors have inward = -1, which the
  // old formula collapsed to a zero-width, un-enterable box).
  const doorOutside = -0.5;
  const doorInside = 2.2;
  const doorHalf = doorWidth / 2 + 0.8;
  const ax0 = doorEdgeX + inward.x * doorOutside;
  const ax1 = doorEdgeX + inward.x * doorInside;
  const az0 = doorEdgeZ + inward.z * doorOutside;
  const az1 = doorEdgeZ + inward.z * doorInside;
  const lateralX = inward.x === 0 ? doorHalf : 0; // door faces Z → spread across X
  const lateralZ = inward.z === 0 ? doorHalf : 0; // door faces X → spread across Z
  const exitTrigger = {
    minX: Math.min(ax0, ax1) - lateralX,
    maxX: Math.max(ax0, ax1) + lateralX,
    minZ: Math.min(az0, az1) - lateralZ,
    maxZ: Math.max(az0, az1) + lateralZ,
  };

  return {
    name: 'Office Interior',
    group,
    colliders,
    colliderIndex: null,
    ledges: [],
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    geometryIndex: null,
    terrainChunks: null,
    spawnPoint,
    exitTrigger,
    doorFacade,
    interiorBounds: { minX, maxX, minZ, maxZ, floorY, ceilY },
    updateStreaming: () => null,

    getGroundHeightAt: (position, radius = 0.28, options = {}) => getGroundHeightAt({
      position,
      radius,
      maxStepUp: options.maxStepUp,
      maxSnapDown: options.maxSnapDown,
      requiredInset: options.requiredInset,
      colliders,
      baseHeight: floorY,
    }),

    getBlockingColliderAt: ({ position, radius, feetY, height, stepHeight }) => getBlockingColliderAt({
      position,
      radius,
      feetY,
      height,
      stepHeight,
      colliders,
    }),

    dispose: () => {
      disposeObject3D(group);
    },
  };
}
