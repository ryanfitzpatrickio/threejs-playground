#!/usr/bin/env node
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  classifyVehicleOverlayMesh,
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

const tailMat = new THREE.MeshStandardMaterial();
updateVehicleTailLightEmissive(tailMat, 0);
assert.equal(tailMat.emissiveIntensity, 0);
updateVehicleTailLightEmissive(tailMat, 1);
assert.ok(tailMat.emissiveIntensity > 10);
updateVehicleTailLightEmissive(tailMat, 0);
assert.equal(tailMat.emissiveIntensity, 0);

console.log('verify-vehicle-tail-lights: ok');
