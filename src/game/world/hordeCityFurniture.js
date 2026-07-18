/**
 * City-generator street furniture (TSL instanced props) for the Horde arena.
 *
 * Reuses Bench / Trashcan / Streetlight / Hydrant / StreetTree generators so
 * the mall concourse and train yard pick up the same procedural materials as
 * the infinite city without reconstructing geometry by hand.
 *
 * Placement keeps the center combat lanes open: props hug storefronts, yard
 * edges, and shed corners. InstancedMeshes are skipped by static merge.
 */

import * as THREE from 'three';
import { BenchGenerator } from '../../three-addons/generators/city/BenchGenerator.js';
import { TrashcanGenerator } from '../../three-addons/generators/city/TrashcanGenerator.js';
import { StreetlightGenerator } from '../../three-addons/generators/city/StreetlightGenerator.js';
import { HydrantGenerator } from '../../three-addons/generators/city/HydrantGenerator.js';
import { StreetTreeGenerator } from '../../three-addons/generators/city/StreetTreeGenerator.js';
import { CarGenerator } from '../../three-addons/generators/city/CarGenerator.js';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Placement: +Z is the "facing" direction of the canonical furniture model
 * (bench seat toward +Z, streetlight arm toward +Z, hydrant pumper toward +Z).
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} yaw  radians; 0 = face +Z
 * @param {number} [uniformScale=1]
 */
function placementMatrix(x, y, z, yaw, uniformScale = 1) {
  _pos.set(x, y, z);
  _euler.set(0, yaw, 0);
  _quat.setFromEuler(_euler);
  _scale.setScalar(uniformScale);
  return _mat.compose(_pos, _quat, _scale).clone();
}

/**
 * @param {object} opts
 * @param {THREE.Group} opts.group
 * @param {object[]} opts.colliders
 * @param {number} opts.floorY
 * @param {number} opts.mallCenterX
 * @param {number} opts.mallHalf
 * @param {number} opts.mallStorefrontHalf
 * @param {number} opts.mallRingW
 * @param {number} opts.shippingHalfW
 * @param {number} [opts.legHalfW]
 * @param {object} [opts.leg]  west winding-leg layout constants
 * @param {number} opts.yardHalf
 * @param {number[]} opts.trackZs
 * @param {THREE.Material[]} [opts.materials]  append generator materials for warmup
 */
export function addHordeCityFurniture({
  group,
  colliders,
  floorY,
  mallCenterX,
  mallHalf,
  mallStorefrontHalf,
  shippingHalfW,
  legHalfW = 0,
  leg = null,
  yardHalf,
  trackZs,
  materials = null,
}) {
  const benchGen = new BenchGenerator();
  const trashGen = new TrashcanGenerator();
  const lightGen = new StreetlightGenerator({ height: 8.2, reach: 2.1, radius: 0.09 });
  const hydrantGen = new HydrantGenerator();
  // Slightly shorter, sparser canopy for a scrappier yard tree.
  const treeGen = new StreetTreeGenerator({ trunkHeight: 2.2, trunkRadius: 0.15 });
  const carGen = new CarGenerator();

  const benches = [];
  const trashcans = [];
  const streetlights = [];
  const hydrants = [];
  const trees = [];
  /** @type {{ matrix: THREE.Matrix4, color: number }[]} */
  const cars = [];

  // ── Mall: benches along the four retail faces, facing the glass ──────────
  // Storefronts sit at ±mallStorefrontHalf; aisle sits slightly inward.
  const aisleInset = 2.15;
  const faceHalf = mallStorefrontHalf - aisleInset;
  const bayStep = 7.2;

  // North face (store glass faces -Z → bench faces +Z toward glass)
  for (let x = mallCenterX - faceHalf + 2.4; x <= mallCenterX + faceHalf - 2.4; x += bayStep) {
    benches.push(placementMatrix(x, floorY, mallStorefrontHalf - aisleInset, 0));
  }
  // South face (glass faces +Z → bench faces -Z)
  for (let x = mallCenterX - faceHalf + 2.4; x <= mallCenterX + faceHalf - 2.4; x += bayStep) {
    benches.push(placementMatrix(x, floorY, -mallStorefrontHalf + aisleInset, Math.PI));
  }
  // West face (glass faces +X → bench faces -X; skip the winding-leg mouth)
  for (let z = -faceHalf + 2.4; z <= faceHalf - 2.4; z += bayStep) {
    if (Math.abs(z) < legHalfW + 2.5) continue;
    benches.push(placementMatrix(mallCenterX - mallStorefrontHalf + aisleInset, floorY, z, -Math.PI * 0.5));
  }
  // East face (skip shipping portal gap)
  for (let z = -faceHalf + 2.4; z <= faceHalf - 2.4; z += bayStep) {
    if (Math.abs(z) < shippingHalfW + 2.5) continue;
    benches.push(placementMatrix(mallCenterX + mallStorefrontHalf - aisleInset, floorY, z, Math.PI * 0.5));
  }

  // ── Winding leg: benches alternate sides along the gallery, offset off the
  // shop glass so the mob lane through the bends stays open. ────────────────
  if (leg) {
    const inset = 1.6;
    let side = 1;
    // Leg A (east–west, z = 0 corridor).
    for (let x = mallCenterX - mallHalf - 5.5; x >= leg.aX1 + 3.5; x -= 9.2) {
      benches.push(placementMatrix(x, floorY, side * (legHalfW - inset), side > 0 ? 0 : Math.PI));
      side *= -1;
    }
    // Leg B (north–south bend corridor).
    side = -1;
    const bMid = (leg.bX + leg.aX1) * 0.5;
    for (let z = legHalfW + 2; z <= leg.cZ - legHalfW - 2.5; z += 8.3) {
      benches.push(placementMatrix(bMid + side * (legHalfW - inset), floorY, z, side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5));
      side *= -1;
    }
    // Leg C (east–west, z = leg.cZ corridor).
    side = 1;
    for (let x = leg.bX - 7; x >= leg.cX1 + 6.5; x -= 9.5) {
      benches.push(placementMatrix(x, floorY, leg.cZ + side * (legHalfW - inset), side > 0 ? 0 : Math.PI));
      side *= -1;
    }
  }

  // A few atrium-edge benches facing the aquarium centerpiece
  const atriumR = 9.5;
  for (const [dx, dz, yaw] of [
    [atriumR, 0, -Math.PI * 0.5],
    [-atriumR, 0, Math.PI * 0.5],
    [0, atriumR, Math.PI],
    [0, -atriumR, 0],
  ]) {
    benches.push(placementMatrix(mallCenterX + dx, floorY, dz, yaw));
  }

  // Trashcans near storefront corners + shipping portal mouth
  const trashSpots = [
    [mallCenterX + mallStorefrontHalf - 1.4, mallStorefrontHalf - 1.4],
    [mallCenterX + mallStorefrontHalf - 1.4, -mallStorefrontHalf + 1.4],
    [mallCenterX - mallStorefrontHalf + 1.4, mallStorefrontHalf - 1.4],
    [mallCenterX - mallStorefrontHalf + 1.4, -mallStorefrontHalf + 1.4],
    [mallCenterX + mallHalf - 1.6, shippingHalfW + 1.8],
    [mallCenterX + mallHalf - 1.6, -shippingHalfW - 1.8],
    [mallCenterX, mallStorefrontHalf - aisleInset - 1.1],
    [mallCenterX, -mallStorefrontHalf + aisleInset + 1.1],
  ];
  if (leg) {
    // Winding-leg mouths and bend pockets.
    trashSpots.push(
      [mallCenterX - mallHalf - 2.2, legHalfW - 1.1],
      [leg.bX + 1.5, legHalfW + 3.7],
      [leg.cX1 + 3.5, leg.cZ + legHalfW - 1.1],
      [leg.foodCx + 6, leg.foodCz - leg.foodHalf + 5.5],
    );
  }
  let trashYaw = 0.35;
  for (const [x, z] of trashSpots) {
    trashcans.push(placementMatrix(x, floorY, z, trashYaw));
    trashYaw += 1.1;
  }

  // ── Yard: streetlights on aisles between tracks (replace crude poles read) ─
  const poleXs = [-22, 0, 22];
  for (const z of trackZs) {
    // Offset lights into the aisle between rakes so arms reach over the track.
    const zAisle = z + (z >= 0 ? -2.6 : 2.6);
    for (const x of poleXs) {
      // Arm toward track centerline (+Z or -Z depending on side of track).
      const yaw = z >= 0 ? Math.PI : 0;
      streetlights.push(placementMatrix(x, floorY, zAisle, yaw));
    }
  }
  // Extra perimeter flood poles along east/west yard walls
  for (const x of [-yardHalf + 3.5, yardHalf - 3.5]) {
    for (const z of [-18, 0, 18]) {
      const yaw = x < 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      streetlights.push(placementMatrix(x, floorY, z, yaw));
    }
  }

  // Hydrants near yard gates (perimeter midpoints) and mall–yard junction
  const hydrantSpots = [
    [0, -yardHalf + 2.2, 0],
    [0, yardHalf - 2.2, Math.PI],
    [-yardHalf + 2.2, 0, Math.PI * 0.5],
    [yardHalf - 2.2, 0, -Math.PI * 0.5],
    [mallCenterX + mallHalf + 2.0, shippingHalfW + 2.4, -Math.PI * 0.5],
    [mallCenterX + mallHalf + 2.0, -shippingHalfW - 2.4, -Math.PI * 0.5],
  ];
  for (const [x, z, yaw] of hydrantSpots) {
    hydrants.push(placementMatrix(x, floorY, z, yaw));
  }

  // Scrappy trees outside the perimeter corners + one pair by mall west wall
  const treeSpots = [
    [-yardHalf - 2.8, -yardHalf - 2.4, 0.9],
    [yardHalf + 2.8, -yardHalf - 2.4, 1.05],
    [-yardHalf - 2.8, yardHalf + 2.4, 0.95],
    [yardHalf + 2.8, yardHalf + 2.4, 1.1],
    [mallCenterX - mallHalf - 2.6, 10, 0.85],
    [mallCenterX - mallHalf - 2.6, -10, 0.9],
    // Near utility sheds
    [-yardHalf + 9.5, -yardHalf + 9.5, 0.8],
    [yardHalf - 9.5, yardHalf - 9.5, 0.85],
  ];
  let treeYaw = 0.2;
  for (const [x, z, s] of treeSpots) {
    trees.push(placementMatrix(x, floorY, z, treeYaw, s));
    treeYaw += 0.85;
  }

  // Yard trashcans by sheds / pallet piles
  for (const [x, z, yaw] of [
    [-yardHalf + 8.5, -yardHalf + 4.2, 0.4],
    [yardHalf - 8.5, yardHalf - 4.2, 1.7],
    [-18, 6.8, 2.3],
    [14, -6.8, 0.9],
  ]) {
    trashcans.push(placementMatrix(x, floorY, z, yaw));
  }

  // Yard benches against the perimeter (rest spots, light cover)
  for (const [x, z, yaw] of [
    [-yardHalf + 2.8, -12, Math.PI * 0.5],
    [-yardHalf + 2.8, 12, Math.PI * 0.5],
    [yardHalf - 2.8, -12, -Math.PI * 0.5],
    [yardHalf - 2.8, 12, -Math.PI * 0.5],
  ]) {
    benches.push(placementMatrix(x, floorY, z, yaw));
  }

  // Abandoned cars — yard corners + mall shipping apron (leave aisles clear).
  // Dusty / industrial paint set, not city taxi colors.
  const carPalette = [0x4a5058, 0x6a3a32, 0x3d4a3a, 0x2c3038, 0x5c5348];
  const carSpots = [
    [-yardHalf + 7.5, -yardHalf + 12.5, Math.PI * 0.5, 0],
    [-yardHalf + 7.5, -yardHalf + 16.2, Math.PI * 0.52, 1],
    [yardHalf - 8.0, yardHalf - 13.0, -Math.PI * 0.48, 2],
    [yardHalf - 12.5, -yardHalf + 6.0, Math.PI * 0.08, 3],
    [mallCenterX + mallHalf + 6.5, shippingHalfW + 6.0, Math.PI * 0.5, 4],
    [mallCenterX + mallHalf + 6.5, -shippingHalfW - 6.0, Math.PI * 0.5, 0],
    [-14, yardHalf - 4.5, Math.PI, 1],
    [18, -yardHalf + 4.5, 0, 2],
  ];
  for (const [x, z, yaw, colorIdx] of carSpots) {
    cars.push({
      matrix: placementMatrix(x, floorY, z, yaw),
      color: carPalette[colorIdx % carPalette.length],
    });
  }

  /** @type {{ mesh: THREE.Object3D, count: number }[]} */
  const built = [];

  const addBuilt = (mesh, count, name) => {
    if (!mesh || count <= 0) return;
    mesh.name = name;
    mesh.userData.hordeCityFurniture = true;
    // Keep instanced draw separate; disable cast to match yard shadow budget.
    mesh.traverse?.((child) => {
      if (child.isMesh || child.isInstancedMesh) {
        child.castShadow = false;
        child.receiveShadow = true;
        if (materials && child.material) materials.push(child.material);
      }
    });
    if (mesh.isMesh || mesh.isInstancedMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      if (materials && mesh.material) materials.push(mesh.material);
    }
    group.add(mesh);
    built.push({ mesh, count });
  };

  if (benches.length) {
    addBuilt(benchGen.build(benches), benches.length, 'Horde City Benches');
    for (const m of benches) {
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      pushFurnitureCollider(colliders, {
        name: 'Horde Bench',
        cx: p.x,
        cy: floorY + 0.35,
        cz: p.z,
        sx: 1.9,
        sy: 0.7,
        sz: 0.7,
        surfaceClass: 'wood',
      });
    }
  }
  if (trashcans.length) {
    addBuilt(trashGen.build(trashcans), trashcans.length, 'Horde City Trashcans');
    for (const m of trashcans) {
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      pushFurnitureCollider(colliders, {
        name: 'Horde Trashcan',
        cx: p.x,
        cy: floorY + 0.4,
        cz: p.z,
        sx: 0.6,
        sy: 0.85,
        sz: 0.6,
        surfaceClass: 'metal',
      });
    }
  }
  if (streetlights.length) {
    addBuilt(lightGen.build(streetlights), streetlights.length, 'Horde City Streetlights');
  }
  if (hydrants.length) {
    addBuilt(hydrantGen.build(hydrants), hydrants.length, 'Horde City Hydrants');
    for (const m of hydrants) {
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      pushFurnitureCollider(colliders, {
        name: 'Horde Hydrant',
        cx: p.x,
        cy: floorY + 0.4,
        cz: p.z,
        sx: 0.42,
        sy: 0.85,
        sz: 0.42,
        surfaceClass: 'metal',
      });
    }
  }
  if (trees.length) {
    addBuilt(treeGen.build(trees), trees.length, 'Horde City Trees');
    for (const m of trees) {
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      const s = new THREE.Vector3().setFromMatrixScale(m).x;
      pushFurnitureCollider(colliders, {
        name: 'Horde Tree Trunk',
        cx: p.x,
        cy: floorY + 0.9,
        cz: p.z,
        sx: 0.45 * s,
        sy: 1.8,
        sz: 0.45 * s,
        surfaceClass: 'wood',
        noGroundSnap: true,
      });
    }
  }
  if (cars.length) {
    const carGroup = carGen.build(cars);
    // Count instanced children as draw calls.
    let carDraws = 0;
    carGroup.traverse((c) => { if (c.isInstancedMesh) carDraws += 1; });
    addBuilt(carGroup, cars.length, 'Horde City Abandoned Cars');
    for (const car of cars) {
      const p = new THREE.Vector3().setFromMatrixPosition(car.matrix);
      // Approximate sedan footprint as cover collider.
      pushFurnitureCollider(colliders, {
        name: 'Horde Parked Car',
        cx: p.x,
        cy: floorY + 0.7,
        cz: p.z,
        sx: 2.2,
        sy: 1.45,
        sz: 4.6,
        surfaceClass: 'metal',
      });
    }
    // Override built count for cars to use instanced draw count in snapshot.
    const last = built[built.length - 1];
    if (last) last.count = carDraws;
  }

  // Snapshot drawCalls = number of GPU instances batches (not prop count).
  let drawCalls = 0;
  for (const entry of built) {
    if (entry.mesh.isInstancedMesh) drawCalls += 1;
    else if (entry.mesh.isGroup) {
      entry.mesh.traverse((c) => { if (c.isInstancedMesh) drawCalls += 1; });
    } else drawCalls += 1;
  }

  return {
    benches: benches.length,
    trashcans: trashcans.length,
    streetlights: streetlights.length,
    hydrants: hydrants.length,
    trees: trees.length,
    cars: cars.length,
    drawCalls,
    dispose: () => {
      benchGen.dispose();
      trashGen.dispose();
      lightGen.dispose();
      hydrantGen.dispose();
      treeGen.dispose();
      carGen.dispose();
    },
  };
}

function pushFurnitureCollider(colliders, {
  name,
  cx,
  cy,
  cz,
  sx,
  sy,
  sz,
  surfaceClass = 'concrete',
  noGroundSnap = false,
}) {
  if (!colliders) return;
  colliders.push({
    name,
    minX: cx - sx * 0.5,
    maxX: cx + sx * 0.5,
    minZ: cz - sz * 0.5,
    maxZ: cz + sz * 0.5,
    bottomY: cy - sy * 0.5,
    topY: cy + sy * 0.5,
    surfaceClass,
    ...(noGroundSnap ? { noGroundSnap: true } : {}),
  });
}
