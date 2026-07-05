// createOfficeInteriorLevel.js — office interior with WFC layout + P3 dressing
// (docs/office-interior-wfc-plan.md, docs/office-interior-p3-plan.md).

import * as THREE from 'three';
import { RectAreaLightNode } from 'three/webgpu';
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '../../utils/disposeObject3D.js';
import { getGroundHeightAt, getBlockingColliderAt } from '../createBaseLevel.js';
import {
  generateOfficeLayout,
  floorSeed,
  STORY_HEIGHT,
} from './generateOfficeLayout.js';
import { getOfficeFeatureWallMaterial, getOfficeWallMaterial } from './officeWallMaterial.js';
import { createInteriorMappingMaterial } from './interiorMappingMaterial.js';
import {
  placeOfficeFurniture,
  cellHash,
  getDeskGeometry,
  getDeskVariantGeometry,
  getMonitorGeometry,
  getTableGeometry,
  getPlantGeometry,
  getTaskChairGeometry,
  getMeetingChairGeometry,
  getSofaGeometry,
  getCoffeeTableGeometry,
  OFFICE_FLOOR_FINISH_OFFSET,
} from './officeFurniture.js';
import { createOfficeSignage } from './officeSignage.js';
import { addPartitionDoors } from './officePartitionDoors.js';
import { addWallTrimSegment } from './officeWallTrim.js';
import { addLobbyColumns } from './officeLobbyColumns.js';
import { addBlobShadowInstanced } from './officeContactShadows.js';
import { getOfficeAccentHex, getOfficeFabricTint } from './officePalette.js';
import { getOfficeFurnitureMaterials } from './officeFurnitureMaterials.js';
import { placeOfficeProps, getOfficePropGeometries, getOfficePropMaterials } from './officeProps.js';
import {
  addElevatorVisuals,
  elevatorLobbySpawn,
  elevatorSpawnYaw,
  elevatorTriggerAabb,
} from './officeElevator.js';
import {
  OFFICE_PERIMETER_WINDOW,
  perimeterWindowCenterY,
  perimeterWindowHeight,
} from './officeInteriorConfig.js';
import { getOfficeZoneFloorMaterials } from './officeCarpetMaterials.js';
import { getOfficeCeilingMaterial } from './officeContemporaryMaterials.js';
import { getOfficeAluminumMaterial, getOfficeDoorMaterial, getOfficeGlassMaterial } from './officeGlassMaterial.js';
import { createOfficeLightBudget, getOfficeLightStripMaterial } from './officeLighting.js';

const _imMatCache = new Map();
function getInteriorMappingMaterialForWindow(wallHeight, carpet = 'grey', mode = 'interior') {
  const winH = perimeterWindowHeight(wallHeight);
  const { width, roomDepth } = OFFICE_PERIMETER_WINDOW;
  const key = `${mode}|${width}|${winH}|${roomDepth}|${carpet}`;
  if (!_imMatCache.has(key)) {
    _imMatCache.set(key, createInteriorMappingMaterial({ width, height: winH, depth: roomDepth, carpet, mode }));
  }
  return _imMatCache.get(key);
}

const FACADE_INWARD = {
  NX: { x: 1, z: 0 },
  PX: { x: -1, z: 0 },
  NZ: { x: 0, z: 1 },
  PZ: { x: 0, z: -1 },
};

function boxCollider(name, minX, maxX, minZ, maxZ, bottomY, topY) {
  return { name, minX, maxX, minZ, maxZ, bottomY, topY };
}

const FLOOR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x3c3c42, roughness: 0.94, metalness: 0.0 });
const CEIL_MATERIAL = getOfficeCeilingMaterial();
const WALL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xdcdde2, roughness: 0.9, metalness: 0.0 });

const DESK_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x6d5a42, roughness: 0.7, metalness: 0.05 });
const MONITOR_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x1a1a22, roughness: 0.35, metalness: 0.2,
  emissive: 0x3a6a8a, emissiveIntensity: 1.1,
});
const TABLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x3c3c44, roughness: 0.5, metalness: 0.15 });
const TASK_CHAIR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.75, metalness: 0.1, vertexColors: true });
const MEETING_CHAIR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x5a5a62, roughness: 0.7, metalness: 0.08, vertexColors: true });
const SOFA_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 0.88, metalness: 0.0, vertexColors: true });
const PLANT_FOLIAGE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.85, metalness: 0.0, vertexColors: true });
const COFFEE_TABLE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.65, metalness: 0.05 });

const GLASS_MATERIAL = getOfficeGlassMaterial();
const GLASS_FRAME_MATERIAL = getOfficeAluminumMaterial();
const PERIMETER_DOOR_MATERIAL = getOfficeDoorMaterial();
const TROFFER_FRAME_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.72, metalness: 0.4 });
const CEILING_PANEL_MATERIAL = getOfficeLightStripMaterial();

let _ltcReady = false;
function ensureRectAreaLightLTC() {
  if (_ltcReady) return;
  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
  _ltcReady = true;
}

function createTrofferFrameGeometry(width, depth) {
  const border = 0.045;
  const height = 0.055;
  const parts = [
    new THREE.BoxGeometry(width + border * 2, height, border),
    new THREE.BoxGeometry(width + border * 2, height, border),
    new THREE.BoxGeometry(border, height, depth),
    new THREE.BoxGeometry(border, height, depth),
  ];
  parts[0].translate(0, 0, -(depth + border) * 0.5);
  parts[1].translate(0, 0, (depth + border) * 0.5);
  parts[2].translate(-(width + border) * 0.5, 0, 0);
  parts[3].translate((width + border) * 0.5, 0, 0);
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  return merged;
}

function addPerimeterWindowBay({
  floorGroup,
  x,
  z,
  floorY,
  windowY,
  rotationY,
  windowWidth,
  windowHeight,
  seedValue,
  wallHeight,
  featureMaterial,
}) {
  const root = new THREE.Group();
  root.name = 'Office Perimeter Window Bay';
  root.position.set(x, floorY, z);
  root.rotation.y = rotationY;
  const frameDepth = 0.055;
  const rail = 0.045;
  const windowCenterY = windowY - floorY;
  const frameParts = [];
  const addBox = (name, width, height, depth, px, py, pz, material) => {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    if (material?.isNodeMaterial) geometry.computeTangents();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  const addFramePart = (width, height, depth, px, py, pz) => {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    geometry.translate(px, py, pz);
    frameParts.push(geometry);
  };

  addFramePart(windowWidth + rail * 2, rail, frameDepth, 0, windowCenterY - windowHeight * 0.5, 0.025);
  addFramePart(windowWidth + rail * 2, rail, frameDepth, 0, windowCenterY + windowHeight * 0.5, 0.025);
  addFramePart(rail, windowHeight, frameDepth, -windowWidth * 0.5, windowCenterY, 0.025);
  addFramePart(rail, windowHeight, frameDepth, windowWidth * 0.5, windowCenterY, 0.025);

  const side = seedValue < 0.5 ? -1 : 1;
  const doorW = 0.82;
  const doorH = Math.min(2.08, wallHeight - 0.34);
  const doorX = side * (windowWidth * 0.5 + 0.14 + doorW * 0.5);
  addBox('Office Perimeter Decorative Door', doorW, doorH, 0.06, doorX, doorH * 0.5, 0.035, PERIMETER_DOOR_MATERIAL);
  addFramePart(doorW + 0.1, 0.055, 0.075, doorX, doorH + 0.025, 0.02);
  addFramePart(0.055, doorH, 0.075, doorX - doorW * 0.5 - 0.027, doorH * 0.5, 0.02);
  addFramePart(0.055, doorH, 0.075, doorX + doorW * 0.5 + 0.027, doorH * 0.5, 0.02);
  const frameGeometry = mergeGeometries(frameParts, false);
  for (const part of frameParts) part.dispose();
  if (GLASS_FRAME_MATERIAL?.isNodeMaterial) frameGeometry.computeTangents();
  const frame = new THREE.Mesh(frameGeometry, GLASS_FRAME_MATERIAL);
  frame.name = 'Office Perimeter Window and Door Frame';
  frame.castShadow = true;
  frame.receiveShadow = true;
  root.add(frame);

  const pillarX = doorX + side * (doorW * 0.5 + 0.16);
  addBox('Office Perimeter Feature Pillar', 0.23, wallHeight - 0.1, 0.16, pillarX, wallHeight * 0.5, 0.015, featureMaterial);

  if (seedValue > 0.36) {
    const plant = new THREE.Mesh(getPlantGeometry(), PLANT_FOLIAGE_MATERIAL);
    plant.name = 'Office Perimeter Bay Plant';
    plant.scale.setScalar(0.68);
    plant.position.set(pillarX, OFFICE_FLOOR_FINISH_OFFSET, 0.48);
    plant.castShadow = true;
    root.add(plant);
  }
  floorGroup.add(root);
  return root;
}

function buildOfficeFloor({
  floorIndex,
  width,
  depth,
  doorFacade,
  origin,
  wallHeight = STORY_HEIGHT,
  wallThickness = 0.3,
  doorWidth = 2.4,
  seed,
  floorCount = 1,
  buildOnly,
  pomWall,
  wallMat,
  pomWalls,
  featureWallMat,
  featurePomWalls,
  accentHex,
  group,
}) {
  const floorY = origin.y + floorIndex * STORY_HEIGHT;
  const ceilY = floorY + wallHeight;
  const halfW = Math.max(width, doorWidth + 2) * 0.5;
  const halfD = Math.max(depth, doorWidth + 2) * 0.5;
  const minX = origin.x - halfW;
  const maxX = origin.x + halfW;
  const minZ = origin.z - halfD;
  const maxZ = origin.z + halfD;
  const floorGroup = new THREE.Group();
  floorGroup.name = `Office Floor ${floorIndex}`;
  floorGroup.visible = floorIndex === 0;
  group.add(floorGroup);
  const footprintArea = width * depth;
  const coveLightBudget = createOfficeLightBudget(Math.max(10, Math.min(32, Math.round(footprintArea / 18))));

  const colliders = [];
  const doors = [];
  const floorSeedVal = floorSeed(seed, floorIndex);
  const layout = generateOfficeLayout({
    width, depth, doorFacade,
    seed: floorSeedVal,
    buildingSeed: seed,
    floorIndex,
  });

  const floor = new THREE.Mesh(new THREE.BoxGeometry(width, 0.4, depth), FLOOR_MATERIAL);
  floor.position.set(origin.x, floorY - 0.2, origin.z);
  floor.receiveShadow = true;
  floor.name = `Office Slab ${floorIndex}`;
  floorGroup.add(floor);
  colliders.push(boxCollider(`office-floor-${floorIndex}`, minX, maxX, minZ, maxZ, floorY - 0.4, floorY));

  const ceilGeometry = new THREE.BoxGeometry(width, 0.2, depth);
  if (CEIL_MATERIAL?.isNodeMaterial) ceilGeometry.computeTangents();
  const ceil = new THREE.Mesh(ceilGeometry, CEIL_MATERIAL);
  ceil.position.set(origin.x, ceilY + 0.1, origin.z);
  floorGroup.add(ceil);

  const t = wallThickness;
  const wallMidY = floorY + wallHeight * 0.5;

  const addWallBox = (name, cx, cz, sx, sz, mat = wallMat, pom = pomWalls, trim = true, perimeterCove = false) => {
    const geom = new THREE.BoxGeometry(sx, wallHeight, sz);
    if (pom) geom.computeTangents();
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, wallMidY, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    floorGroup.add(mesh);
    colliders.push(boxCollider(name, cx - sx / 2, cx + sx / 2, cz - sz / 2, cz + sz / 2, floorY, ceilY));
    if (!buildOnly && mat === GLASS_MATERIAL) {
      const alongX = sx >= sz;
      const span = alongX ? sx : sz;
      const depth = Math.max(0.035, Math.min(sx, sz) + 0.025);
      const rail = (length, height, y, offset = 0) => {
        const g = alongX
          ? new THREE.BoxGeometry(length, height, depth)
          : new THREE.BoxGeometry(depth, height, length);
        const frame = new THREE.Mesh(g, GLASS_FRAME_MATERIAL);
        frame.position.set(cx + (alongX ? offset : 0), y, cz + (alongX ? 0 : offset));
        frame.castShadow = true;
        frame.name = 'Office Glass Aluminum Frame';
        floorGroup.add(frame);
      };
      rail(span + 0.035, 0.032, floorY + 0.016);
      rail(span + 0.035, 0.032, ceilY - 0.016);
      rail(0.032, wallHeight, wallMidY, -span * 0.5);
      rail(0.032, wallHeight, wallMidY, span * 0.5);
    }
    if (!buildOnly && trim && mat !== GLASS_MATERIAL) {
      addWallTrimSegment(
        floorGroup,
        cx,
        cz,
        sx,
        sz,
        floorY,
        wallHeight,
        perimeterCove ? coveLightBudget : null,
        perimeterCove,
      );
    }
    return mesh;
  };

  const sides = [
    { facade: 'NZ', horizontal: true, cz: minZ + t / 2, cx: origin.x, span: width, sz: t },
    { facade: 'PZ', horizontal: true, cz: maxZ - t / 2, cx: origin.x, span: width, sz: t },
    { facade: 'NX', horizontal: false, cx: minX + t / 2, cz: origin.z, span: depth, sz: t },
    { facade: 'PX', horizontal: false, cx: maxX - t / 2, cz: origin.z, span: depth, sz: t },
  ];

  for (const side of sides) {
    const name = `Office Wall ${side.facade} F${floorIndex}`;
    const hasDoor = floorIndex === 0 && side.facade === doorFacade;
    if (!hasDoor) {
      if (side.horizontal) addWallBox(name, side.cx, side.cz, side.span, t, wallMat, pomWalls, true, true);
      else addWallBox(name, side.cx, side.cz, t, side.span, wallMat, pomWalls, true, true);
      continue;
    }
    const segLen = Math.max((side.span - doorWidth) / 2, 0.2);
    if (side.horizontal) {
      addWallBox(`${name} A`, side.cx - (doorWidth / 2 + segLen / 2), side.cz, segLen, t, wallMat, pomWalls, true, true);
      addWallBox(`${name} B`, side.cx + (doorWidth / 2 + segLen / 2), side.cz, segLen, t, wallMat, pomWalls, true, true);
    } else {
      addWallBox(`${name} A`, side.cx, side.cz - (doorWidth / 2 + segLen / 2), t, segLen, wallMat, pomWalls, true, true);
      addWallBox(`${name} B`, side.cx, side.cz + (doorWidth / 2 + segLen / 2), t, segLen, wallMat, pomWalls, true, true);
    }
  }

  let featureWallPlaced = false;
  layout.walls.forEach((w, i) => {
    const elevShell = w.zone === 'elevator' && layout.elevatorCell && !buildOnly;
    const glass = w.zone === 'meeting' && !buildOnly;
    const wx = origin.x + w.cx;
    const wz = origin.z + w.cz;
    if (elevShell) {
      colliders.push(boxCollider(
        `Office Elevator Shell F${floorIndex}-${i}`,
        wx - w.sx / 2, wx + w.sx / 2,
        wz - w.sz / 2, wz + w.sz / 2,
        floorY, ceilY,
      ));
      return;
    }
    const feature = w.zone === 'office' && !featureWallPlaced && featureWallMat;
    if (feature) featureWallPlaced = true;
    const partitionMesh = addWallBox(
      `Office Partition F${floorIndex}-${i}`,
      wx,
      wz,
      w.sx,
      w.sz,
      glass ? GLASS_MATERIAL : (feature || wallMat),
      glass ? false : (feature ? featurePomWalls : pomWalls),
      !glass,
    );
    if (glass && partitionMesh) partitionMesh.renderOrder = 5;
    if (feature && partitionMesh) partitionMesh.userData.officeFeatureWall = true;
  });

  const rectLightGroup = new THREE.Group();
  rectLightGroup.name = `Office RectLights F${floorIndex}`;
  rectLightGroup.visible = floorIndex === 0;
  floorGroup.add(rectLightGroup);

  const originMinX = origin.x - width / 2;
  const originMinZ = origin.z - depth / 2;
  const { cellW: cw, cellD: cd } = layout;

  if (!buildOnly) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();

    const tileGeom = new THREE.BoxGeometry(cw, 0.05, cd);
    const zoneFloorMaterials = getOfficeZoneFloorMaterials({ cellW: cw, cellD: cd });
    if (Object.values(zoneFloorMaterials).some((material) => material?.isNodeMaterial)) {
      tileGeom.computeTangents();
    }
    const zoneMatrices = { open: [], corridor: [], meeting: [], office: [], elevator: [] };
    const ceilingMatrices = [];
    const lightPositions = [];

    for (let gx = 0; gx < layout.cols; gx += 1) {
      for (let gz = 0; gz < layout.rows; gz += 1) {
        const zone = layout.zones[gx][gz];
        const cx = originMinX + (gx + 0.5) * cw;
        const cz = originMinZ + (gz + 0.5) * cd;
        (zoneMatrices[zone] ?? zoneMatrices.open).push(
          m.compose(p.set(cx, floorY + 0.03, cz), q, s).clone(),
        );
        ceilingMatrices.push(m.compose(p.set(cx, ceilY - 0.023, cz), q, s).clone());
        if (gx % 2 === 0 && gz % 2 === 0) {
          lightPositions.push({ x: cx, z: cz, zone });
        }
      }
    }

    const addInstanced = (geom, mat, matrices, name, { castShadow = false, colors = null } = {}) => {
      if (matrices.length === 0) return null;
      const inst = new THREE.InstancedMesh(geom, mat, matrices.length);
      for (let i = 0; i < matrices.length; i += 1) {
        inst.setMatrixAt(i, matrices[i]);
        if (colors?.[i]) inst.setColorAt(i, colors[i]);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.receiveShadow = true;
      inst.castShadow = castShadow;
      inst.name = name;
      floorGroup.add(inst);
      return inst;
    };

    for (const zone of Object.keys(zoneMatrices)) {
      addInstanced(tileGeom, zoneFloorMaterials[zone] ?? zoneFloorMaterials.open, zoneMatrices[zone], `Office Floor ${zone} F${floorIndex}`);
    }

    const inward = FACADE_INWARD[doorFacade] ?? FACADE_INWARD.NZ;
    const doorEdgeX = doorFacade === 'NX' ? minX : doorFacade === 'PX' ? maxX : origin.x;
    const doorEdgeZ = doorFacade === 'NZ' ? minZ : doorFacade === 'PZ' ? maxZ : origin.z;
    const doorOutside = -0.5;
    const doorInside = 2.2;
    const doorHalf = doorWidth / 2 + 0.8;
    const ax0 = doorEdgeX + inward.x * doorOutside;
    const ax1 = doorEdgeX + inward.x * doorInside;
    const az0 = doorEdgeZ + inward.z * doorOutside;
    const az1 = doorEdgeZ + inward.z * doorInside;
    const lateralX = inward.x === 0 ? doorHalf : 0;
    const lateralZ = inward.z === 0 ? doorHalf : 0;
    const exitTrigger = floorIndex === 0 ? {
      minX: Math.min(ax0, ax1) - lateralX,
      maxX: Math.max(ax0, ax1) + lateralX,
      minZ: Math.min(az0, az1) - lateralZ,
      maxZ: Math.max(az0, az1) + lateralZ,
    } : null;

    const furniture = placeOfficeFurniture({
      layout,
      seed: floorSeedVal,
      originMinX,
      originMinZ,
      floorY,
      cw,
      cd,
      exitTrigger,
      entryCell: layout.entryCell,
    });
    colliders.push(...furniture.colliders);

    const furnMats = getOfficeFurnitureMaterials(false);
    const deskMat = furnMats.desk ?? DESK_MATERIAL;
    const tableMat = furnMats.table ?? TABLE_MATERIAL;
    const coffeeMat = furnMats.coffee ?? COFFEE_TABLE_MATERIAL;
    const monitorMat = furnMats.monitor ?? MONITOR_MATERIAL;

    const deskGeom = getDeskGeometry();
    const deskVarGeom = getDeskVariantGeometry();
    const tableGeom = getTableGeometry();
    const coffeeGeom = getCoffeeTableGeometry();
    for (const g of [deskGeom, deskVarGeom, tableGeom, coffeeGeom]) {
      const needsTangents = deskMat?.isNodeMaterial || tableMat?.isNodeMaterial;
      if (needsTangents && g.index && g.getAttribute('position')
        && g.getAttribute('normal') && g.getAttribute('uv')) {
        g.computeTangents();
      }
    }

    addInstanced(deskGeom, deskMat, furniture.deskPlainMatrices, `Office Desks F${floorIndex}`, { castShadow: true });
    addInstanced(deskVarGeom, deskMat, furniture.deskVariantMatrices, `Office Desks Variant F${floorIndex}`, { castShadow: true });
    addInstanced(getMonitorGeometry(), monitorMat, furniture.monitorMatrices, `Office Monitors F${floorIndex}`, { castShadow: true });
    addInstanced(tableGeom, tableMat, furniture.tableMatrices, `Office Tables F${floorIndex}`, { castShadow: true });
    addInstanced(getPlantGeometry(), PLANT_FOLIAGE_MATERIAL, furniture.plantMatrices, `Office Plants F${floorIndex}`, {
      castShadow: true,
      colors: furniture.plantMatrices.map((_, i) => {
        const tc = furniture.tintCells.filter((t) => t.kind === 'plant')[i];
        return tc ? getOfficeFabricTint(floorSeedVal, tc.gx, tc.gz, accentHex) : new THREE.Color(0x3f7a3a);
      }),
    });
    addInstanced(getTaskChairGeometry(), TASK_CHAIR_MATERIAL, furniture.taskChairMatrices, `Office Task Chairs F${floorIndex}`, {
      castShadow: true,
      colors: furniture.taskChairMatrices.map((_, i) => {
        const tc = furniture.tintCells.filter((t) => t.kind === 'taskChair')[i];
        return tc ? getOfficeFabricTint(floorSeedVal, tc.gx, tc.gz, accentHex) : new THREE.Color(0x4a4a52);
      }),
    });
    addInstanced(getMeetingChairGeometry(), MEETING_CHAIR_MATERIAL, furniture.meetingChairMatrices, `Office Meeting Chairs F${floorIndex}`, {
      castShadow: true,
      colors: furniture.meetingChairMatrices.map((_, i) => {
        const tc = furniture.tintCells.filter((t) => t.kind === 'meetingChair')[i];
        return tc ? getOfficeFabricTint(floorSeedVal, tc.gx + (tc.index ?? 0), tc.gz, accentHex) : new THREE.Color(0x5a5a62);
      }),
    });
    addInstanced(getSofaGeometry(2), SOFA_MATERIAL, furniture.sofa2Matrices, `Office Sofas F${floorIndex}`, {
      castShadow: true,
      colors: furniture.sofa2Matrices.map((_, i) => {
        const tc = furniture.tintCells.filter((t) => t.kind === 'sofa2')[i];
        return tc ? getOfficeFabricTint(floorSeedVal, tc.gx, tc.gz, accentHex) : new THREE.Color(0x4a5568);
      }),
    });
    addInstanced(getSofaGeometry(3), SOFA_MATERIAL, furniture.sofa3Matrices, `Office Sofas 3 F${floorIndex}`, {
      castShadow: true,
      colors: furniture.sofa3Matrices.map((_, i) => {
        const tc = furniture.tintCells.filter((t) => t.kind === 'sofa3')[i];
        return tc ? getOfficeFabricTint(floorSeedVal, tc.gx, tc.gz, accentHex) : new THREE.Color(0x4a5568);
      }),
    });
    addInstanced(coffeeGeom, coffeeMat, furniture.coffeeTableMatrices, `Office Coffee Tables F${floorIndex}`, { castShadow: true });

    addBlobShadowInstanced(floorGroup, furniture.blobEntries, floorY, `Office Blob Shadows F${floorIndex}`);

    const trofferKeys = new Set(lightPositions.map((lp) => {
      const gx = Math.round((lp.x - originMinX) / cw - 0.5);
      const gz = Math.round((lp.z - originMinZ) / cd - 0.5);
      return `${gx},${gz}`;
    }));
    const props = placeOfficeProps({
      layout,
      seed: floorSeedVal,
      originMinX,
      originMinZ,
      floorY,
      ceilY,
      cw,
      cd,
      trofferKeys,
      accentHex,
    });
    const propGeoms = getOfficePropGeometries();
    const propMats = getOfficePropMaterials({ buildOnly: false, pomWall });
    addInstanced(propGeoms.vent, propMats.vent, props.ventMatrices, `Office Ceiling Vents F${floorIndex}`);
    addInstanced(propGeoms.sprinkler, propMats.sprinkler, props.sprinklerMatrices, `Office Sprinklers F${floorIndex}`);
    addInstanced(propGeoms.detector, propMats.detector, props.detectorMatrices, `Office Detectors F${floorIndex}`);
    addInstanced(propGeoms.tvBody, propMats.tvBody, props.tvBodyMatrices, `Office TVs F${floorIndex}`, { castShadow: true });
    addInstanced(propGeoms.whiteboard, propMats.whiteboard, props.whiteboardMatrices, `Office Whiteboards F${floorIndex}`);
    addInstanced(propGeoms.artFrame, propMats.artFrame, props.artFrameMatrices, `Office Art Frames F${floorIndex}`, { castShadow: true });
    if (props.artPlateEntries.length > 0) {
      addInstanced(
        propGeoms.artPlate,
        propMats.artPlate,
        props.artPlateEntries.map((e) => e.matrix),
        `Office Art Plates F${floorIndex}`,
        { colors: props.artPlateEntries.map((e) => e.color) },
      );
    }
    addInstanced(propGeoms.clock, propMats.clock, props.clockMatrices, `Office Clock F${floorIndex}`);

    const ceilingTileGeom = new THREE.BoxGeometry(cw - 0.035, 0.045, cd - 0.035);
    if (CEIL_MATERIAL?.isNodeMaterial) ceilingTileGeom.computeTangents();
    addInstanced(ceilingTileGeom, CEIL_MATERIAL, ceilingMatrices, `Office Acoustic Ceiling Tiles F${floorIndex}`);

    const trofferMatrices = lightPositions.map((lp) => (
      m.compose(p.set(lp.x, ceilY - 0.045, lp.z), q, s).clone()
    ));
    const trofferW = Math.min(cw * 0.72, 1.2);
    const trofferD = Math.min(cd * 0.45, 0.6);
    addInstanced(createTrofferFrameGeometry(trofferW, trofferD), TROFFER_FRAME_MATERIAL, trofferMatrices, `Office Recessed Troffer Frames F${floorIndex}`);
    const diffuserMatrices = lightPositions.map((lp) => (
      m.compose(p.set(lp.x, ceilY - 0.026, lp.z), q, s).clone()
    ));
    addInstanced(new THREE.BoxGeometry(trofferW, 0.025, trofferD), CEILING_PANEL_MATERIAL, diffuserMatrices, `Office Recessed Troffer Diffusers F${floorIndex}`);

    if (floorIndex === 0) {
      const ambient = new THREE.HemisphereLight(0xfff1dc, 0x626972, 0.68);
      floorGroup.add(ambient);
    }

    ensureRectAreaLightLTC();
    const maxAreaLights = Math.max(6, Math.min(20, Math.round(footprintArea / 40)));
    const areaStride = Math.max(1, Math.ceil(lightPositions.length / maxAreaLights));
    const fluxComp = Math.sqrt(areaStride);
    const aw = Math.min(cw, cd) * 0.9;
    for (let i = 0; i < lightPositions.length; i += areaStride) {
      const lp = lightPositions[i];
      let color = 0xfff2d8;
      let intensity = 4.8 * fluxComp;
      if (lp.zone === 'meeting') {
        color = 0xffe9c8;
        intensity *= 0.8;
      } else if (lp.zone === 'corridor') {
        intensity *= 1.05;
      }
      const rect = new THREE.RectAreaLight(color, intensity, aw, aw);
      rect.position.set(lp.x, ceilY - 0.12, lp.z);
      rect.lookAt(lp.x, floorY, lp.z);
      rectLightGroup.add(rect);
    }

    const winW = OFFICE_PERIMETER_WINDOW.width;
    const winH = perimeterWindowHeight(wallHeight);
    const winMat = getInteriorMappingMaterialForWindow(wallHeight, 'grey', 'interior');
    const winGeom = new THREE.PlaneGeometry(winW, winH);
    winGeom.computeTangents();
    const winY = perimeterWindowCenterY(floorY, wallHeight);
    const inset = wallThickness + 0.03;
    const winSides = [
      { facade: 'NZ', axis: 'z', wall: minZ, dir: 1, rotY: 0, lo: minX, hi: maxX },
      { facade: 'PZ', axis: 'z', wall: maxZ, dir: -1, rotY: Math.PI, lo: minX, hi: maxX },
      { facade: 'NX', axis: 'x', wall: minX, dir: 1, rotY: Math.PI / 2, lo: minZ, hi: maxZ },
      { facade: 'PX', axis: 'x', wall: maxX, dir: -1, rotY: -Math.PI / 2, lo: minZ, hi: maxZ },
    ].filter((side) => floorIndex > 0 || side.facade !== doorFacade);
    const winSpacing = 4.2;
    let winIdx = 0;
    for (const side of winSides) {
      const wallPos = side.wall + side.dir * inset;
      const inward = FACADE_INWARD[side.facade] ?? FACADE_INWARD.NZ;
      const facadeCx = side.axis === 'z' ? origin.x : origin.x;
      const facadeCz = side.axis === 'z' ? wallPos : origin.z;
      const facadeTargetX = facadeCx + inward.x * 3;
      const facadeTargetZ = facadeCz + inward.z * 3;
      const facadeY = floorY + wallHeight * 0.55;
      if (coveLightBudget.used < coveLightBudget.maxLights) {
        const span = side.hi - side.lo;
        const facadeLight = new THREE.RectAreaLight(0xdfe8ff, 2.4, span * 0.85, winH * 1.1);
        if (side.axis === 'z') {
          facadeLight.position.set(origin.x, facadeY, wallPos + inward.z * 0.15);
        } else {
          facadeLight.position.set(wallPos + inward.x * 0.15, facadeY, origin.z);
        }
        facadeLight.lookAt(facadeTargetX, floorY + 1.2, facadeTargetZ);
        coveLightBudget.add(facadeLight, floorGroup);
      }
      for (let a = side.lo + winSpacing * 0.6; a < side.hi - 0.8; a += winSpacing) {
        const g = winGeom.clone();
        const roomSeed = cellHash(floorSeedVal, winIdx * 7 + 3, winIdx * 13 + 5);
        g.setAttribute('aRoomSeed', new THREE.BufferAttribute(new Float32Array(4).fill(roomSeed), 1));
        const win = new THREE.Mesh(g, winMat);
        if (side.axis === 'z') win.position.set(a, winY, wallPos);
        else win.position.set(wallPos, winY, a);
        win.rotation.y = side.rotY;
        win.name = 'Office Window';
        floorGroup.add(win);
        addPerimeterWindowBay({
          floorGroup,
          x: side.axis === 'z' ? a : wallPos,
          z: side.axis === 'z' ? wallPos : a,
          floorY,
          windowY: winY,
          rotationY: side.rotY,
          windowWidth: winW,
          windowHeight: winH,
          seedValue: roomSeed,
          wallHeight,
          featureMaterial: featureWallMat,
        });
        winIdx += 1;
      }
    }

    addLobbyColumns({
      floorGroup,
      layout,
      originMinX,
      originMinZ,
      floorY,
      wallHeight,
      cw,
      cd,
      lightBudget: coveLightBudget,
      accentHex,
    });

    addPartitionDoors({
      floorGroup,
      layout,
      originMinX,
      originMinZ,
      floorY,
      wallHeight,
      cw,
      cd,
      lightBudget: coveLightBudget,
      doors,
      colliders,
    });

    const signage = createOfficeSignage({
      layout,
      seed: floorSeedVal,
      originMinX,
      originMinZ,
      floorY,
      wallHeight,
      floorIndex,
      doorFacade,
      origin,
      halfW,
      halfD,
      wallThickness,
      cw,
      cd,
      accentHex,
    });
    if (signage.plates) floorGroup.add(signage.plates);
    if (signage.exitSign) floorGroup.add(signage.exitSign);

    addElevatorVisuals({
      floorGroup,
      layout,
      originMinX,
      originMinZ,
      floorY,
      floorIndex,
      floorCount,
      cw,
      cd,
      wallHeight,
      wallThickness: t,
      shellMaterial: wallMat,
      pomMeshes: pomWalls,
      buildOnly,
      lightBudget: coveLightBudget,
    });
  }

  const elevatorTrigger = floorCount > 1
    ? elevatorTriggerAabb(layout, originMinX, originMinZ, cw, cd)
    : null;
  const elevatorSpawn = floorCount > 1
    ? elevatorLobbySpawn(layout, originMinX, originMinZ, cw, cd, floorY)
    : null;
  const elevSpawnYaw = floorCount > 1 ? elevatorSpawnYaw(layout) : 0;

  let exitTrigger = null;
  if (floorIndex === 0) {
    const inward = FACADE_INWARD[doorFacade] ?? FACADE_INWARD.NZ;
    const doorEdgeX = doorFacade === 'NX' ? minX : doorFacade === 'PX' ? maxX : origin.x;
    const doorEdgeZ = doorFacade === 'NZ' ? minZ : doorFacade === 'PZ' ? maxZ : origin.z;
    const doorOutside = -0.5;
    const doorInside = 2.2;
    const doorHalf = doorWidth / 2 + 0.8;
    const ax0 = doorEdgeX + inward.x * doorOutside;
    const ax1 = doorEdgeX + inward.x * doorInside;
    const az0 = doorEdgeZ + inward.z * doorOutside;
    const az1 = doorEdgeZ + inward.z * doorInside;
    const lateralX = inward.x === 0 ? doorHalf : 0;
    const lateralZ = inward.z === 0 ? doorHalf : 0;
    exitTrigger = {
      minX: Math.min(ax0, ax1) - lateralX,
      maxX: Math.max(ax0, ax1) + lateralX,
      minZ: Math.min(az0, az1) - lateralZ,
      maxZ: Math.max(az0, az1) + lateralZ,
    };
  }

  return {
    floorGroup,
    colliders,
    layout,
    rectLightGroup,
    exitTrigger,
    elevatorTrigger,
    elevatorSpawn,
    elevatorSpawnYaw: elevSpawnYaw,
    floorY,
    ceilY,
    doors,
  };
}

export function createOfficeInteriorLevel({
  width = 16,
  depth = 16,
  doorFacade = 'NZ',
  origin = { x: 0, y: 0, z: 0 },
  wallHeight = STORY_HEIGHT,
  wallThickness = 0.3,
  doorWidth = 2.4,
  seed = 1,
  floorCount = 1,
} = {}) {
  const group = new THREE.Group();
  group.name = 'Office Interior';

  const halfW = Math.max(width, doorWidth + 2) * 0.5;
  const halfD = Math.max(depth, doorWidth + 2) * 0.5;
  const minX = origin.x - halfW;
  const maxX = origin.x + halfW;
  const minZ = origin.z - halfD;
  const maxZ = origin.z + halfD;

  const colliders = [];
  const buildOnly = typeof document === 'undefined';
  const accentHex = getOfficeAccentHex(seed);
  const pomWall = buildOnly ? null : getOfficeWallMaterial();
  const featurePomWall = buildOnly ? null : getOfficeFeatureWallMaterial(accentHex);
  const wallMat = pomWall ?? WALL_MATERIAL;
  const featureWallMat = featurePomWall ?? new THREE.MeshStandardMaterial({
    color: accentHex, roughness: 0.58, metalness: 0.06,
  });
  const pomWalls = pomWall != null;
  const featurePomWalls = featurePomWall != null;

  const builtFloors = new Map();
  const rectLightGroups = [];
  const elevatorTriggers = [];
  const elevatorSpawns = [];
  const elevatorSpawnYaws = [];
  const doorsByFloor = [];
  let spawnPoint = null;
  let spawnYaw = 0;
  let exitTrigger = null;
  let currentFloor = 0;

  const registerFloor = (floorIndex, built) => {
    builtFloors.set(floorIndex, built);
    rectLightGroups[floorIndex] = built.rectLightGroup;
    elevatorTriggers[floorIndex] = built.elevatorTrigger;
    elevatorSpawns[floorIndex] = built.elevatorSpawn;
    elevatorSpawnYaws[floorIndex] = built.elevatorSpawnYaw;
    doorsByFloor[floorIndex] = built.doors ?? [];
    colliders.push(...built.colliders);
    if (floorIndex === 0) {
      const inward = FACADE_INWARD[doorFacade] ?? FACADE_INWARD.NZ;
      const doorEdgeX = doorFacade === 'NX' ? minX : doorFacade === 'PX' ? maxX : origin.x;
      const doorEdgeZ = doorFacade === 'NZ' ? minZ : doorFacade === 'PZ' ? maxZ : origin.z;
      spawnPoint = new THREE.Vector3(
        doorEdgeX + inward.x * 1.6,
        built.floorY,
        doorEdgeZ + inward.z * 1.6,
      );
      spawnYaw = Math.atan2(inward.x, inward.z);
      exitTrigger = built.exitTrigger;
    }
  };

  const buildFloor = (floorIndex) => {
    if (builtFloors.has(floorIndex)) return [];
    const built = buildOfficeFloor({
      floorIndex,
      width,
      depth,
      doorFacade,
      origin,
      wallHeight,
      wallThickness,
      doorWidth,
      seed,
      floorCount,
      buildOnly,
      pomWall,
      wallMat,
      pomWalls,
      featureWallMat,
      featurePomWalls,
      accentHex,
      group,
    });
    registerFloor(floorIndex, built);
    return built.colliders;
  };

  buildFloor(0);

  const setActiveFloor = (floorIndex) => {
    currentFloor = floorIndex;
    for (const [fi, built] of builtFloors) {
      built.floorGroup.visible = fi === floorIndex;
    }
    for (let i = 0; i < rectLightGroups.length; i += 1) {
      if (rectLightGroups[i]) rectLightGroups[i].visible = i === floorIndex;
    }
    return currentFloor;
  };

  const updateDoors = (delta) => {
    const speed = Math.PI * 2.4;
    for (const door of doorsByFloor[currentFloor] ?? []) {
      const diff = door.targetAngle - door.angle;
      if (Math.abs(diff) < 0.002) {
        door.angle = door.targetAngle;
      } else {
        door.angle += Math.sign(diff) * Math.min(Math.abs(diff), speed * delta);
      }
      door.pivot.rotation.y = door.angle;
      if (!door.open && door.angle === 0) {
        door.collider.disabled = false;
        door.collider.rapierCollider?.setEnabled(true);
      }
    }
  };

  const getNearbyDoor = (position, range = 1.65) => {
    let nearest = null;
    let nearestDistance = range;
    for (const door of doorsByFloor[currentFloor] ?? []) {
      const distance = Math.hypot(position.x - door.x, position.z - door.z);
      if (distance < nearestDistance) {
        nearest = door;
        nearestDistance = distance;
      }
    }
    return nearest ? { door: nearest, distance: nearestDistance } : null;
  };

  const toggleDoor = (door, position = null) => {
    if (!door) return false;
    door.open = !door.open;
    if (door.open) {
      // Swing away from the player's side of the doorway.
      const nx = Math.sin(door.yaw);
      const nz = Math.cos(door.yaw);
      const side = position ? Math.sign((position.x - door.x) * nx + (position.z - door.z) * nz) || 1 : 1;
      door.targetAngle = -side * Math.PI * 0.5;
      door.collider.disabled = true;
      door.collider.rapierCollider?.setEnabled(false);
    } else {
      door.targetAngle = 0;
      // Collision re-enables only once the leaf reaches the closed frame.
      door.collider.disabled = true;
      door.collider.rapierCollider?.setEnabled(false);
    }
    return true;
  };

  const floor0 = builtFloors.get(0);
  const topCeilY = origin.y + (floorCount - 1) * STORY_HEIGHT + wallHeight;

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
    spawnYaw,
    exitTrigger,
    doorFacade,
    floorCount,
    currentFloor,
    builtFloors,
    elevatorTriggers,
    elevatorSpawns,
    elevatorSpawnYaws,
    doorsByFloor,
    buildFloor,
    setActiveFloor,
    updateDoors,
    getNearbyDoor,
    toggleDoor,
    interiorBounds: { minX, maxX, minZ, maxZ, floorY: floor0.floorY, ceilY: topCeilY },

    getGroundHeightAt: (position, radius = 0.28, options = {}) => getGroundHeightAt({
      position,
      radius,
      maxStepUp: options.maxStepUp,
      maxSnapDown: options.maxSnapDown,
      requiredInset: options.requiredInset,
      colliders,
      baseHeight: floor0.floorY,
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

export { STORY_HEIGHT, floorSeed };
