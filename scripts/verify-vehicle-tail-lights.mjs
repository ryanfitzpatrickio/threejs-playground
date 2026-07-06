#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  classifyVehicleOverlayMesh,
  isHiddenVehicleOverlayMesh,
  isVehicleTailLightMesh,
  updateVehicleTailLightEmissive,
  VEHICLE_OVERLAY_PART,
} from '../src/game/materials/createVehicleOverlayMaterials.js';

function fakeMesh(name, parentName = null) {
  const parent = parentName ? { name: parentName, parent: null, userData: {} } : null;
  return { name, parent, userData: { name }, isMesh: true };
}

assert.equal(isVehicleTailLightMesh(fakeMesh('left_tail_light')), true);
assert.equal(isVehicleTailLightMesh(fakeMesh('left tail light')), true);
assert.equal(isVehicleTailLightMesh(fakeMesh('Mesh_22', 'left_tail_light')), true);
assert.equal(isVehicleTailLightMesh(fakeMesh('tripo_part_0')), false);

assert.equal(
  classifyVehicleOverlayMesh(fakeMesh('left_tail_light')),
  VEHICLE_OVERLAY_PART.TAIL_LIGHT,
);
assert.equal(
  classifyVehicleOverlayMesh(fakeMesh('front_head_light_left')),
  VEHICLE_OVERLAY_PART.HEADLIGHT_LENS,
);

assert.equal(
  classifyVehicleOverlayMesh(fakeMesh('mesh_14', 'model_part14'), 'orange-car'),
  VEHICLE_OVERLAY_PART.CHASSIS,
);
assert.equal(
  classifyVehicleOverlayMesh(
    fakeMesh('mesh_11', 'model_part11'),
    'orange-car',
    { partOverrides: { model_part11: 'chassis' } },
  ),
  VEHICLE_OVERLAY_PART.CHASSIS,
);
assert.equal(
  classifyVehicleOverlayMesh(fakeMesh('mesh_12', 'model_part12'), 'orange-car'),
  VEHICLE_OVERLAY_PART.GLASS,
);
assert.equal(
  classifyVehicleOverlayMesh(fakeMesh('mesh_6', 'model_part6'), 'orange-car'),
  VEHICLE_OVERLAY_PART.WHEEL,
);
assert.equal(
  classifyVehicleOverlayMesh(fakeMesh('mesh_11', 'model_part11'), 'orange-car'),
  VEHICLE_OVERLAY_PART.DEBRIS,
);
assert.equal(
  classifyVehicleOverlayMesh(fakeMesh('mesh_2', 'model_part2'), 'orange-car'),
  VEHICLE_OVERLAY_PART.HEADLIGHT_LENS,
);
assert.equal(
  classifyVehicleOverlayMesh(fakeMesh('mesh_1', 'model_part1'), 'orange-car'),
  VEHICLE_OVERLAY_PART.TAIL_LIGHT,
);

assert.equal(
  classifyVehicleOverlayMesh(
    fakeMesh('mesh_12', 'model_part12'),
    'orange-car',
    { partOverrides: { model_part12: 'tailLight' } },
  ),
  VEHICLE_OVERLAY_PART.TAIL_LIGHT,
);
assert.equal(
  classifyVehicleOverlayMesh(
    fakeMesh('mesh_1', 'model_part1'),
    'orange-car',
    { partOverrides: { model_part1: 'windshield' } },
  ),
  VEHICLE_OVERLAY_PART.GLASS,
);
assert.equal(
  isHiddenVehicleOverlayMesh(
    fakeMesh('mesh_6', 'model_part6'),
    'orange-car',
    { model_part6: 'tire' },
  ),
  true,
);

const tailMat = new THREE.MeshStandardMaterial();
updateVehicleTailLightEmissive(tailMat, 0);
assert.equal(tailMat.emissiveIntensity, 0);
updateVehicleTailLightEmissive(tailMat, 1);
assert.ok(tailMat.emissiveIntensity > 10);
updateVehicleTailLightEmissive(tailMat, 0);
assert.equal(tailMat.emissiveIntensity, 0);

console.log('verify-vehicle-tail-lights: ok');
