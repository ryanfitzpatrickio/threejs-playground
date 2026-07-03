import assert from 'node:assert/strict';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';
import {
  createGarageBuild,
  deleteGarageBuild,
  getActiveGarageBuild,
  loadGarageBuilds,
  saveGarageBuild,
  vehicleOptionsFromGarageBuild,
} from '../src/game/vehicles/garageBuilds.js';
import { __seedFileStoreForTests } from '../src/store/fileStore.js';

__seedFileStoreForTests();

const draft = createGarageBuild('longtail');
draft.name = 'Night Runner';
draft.chassisId = 'muscle-2';
draft.frame.wheelbase = 3.91;
draft.wheels.radius = 0.5;
draft.wheels.width = 0.42;
draft.chassisTransform.position = [0.1, -0.22, 0.08];
draft.performance.enginePower = 8.4;
draft.performance.maxSteerYawRate = 0.82;
const saved = saveGarageBuild(draft);

assert.equal(loadGarageBuilds().length, 1);
assert.equal(getActiveGarageBuild().id, saved.id);
assert.equal(getActiveGarageBuild().frame.wheelbase, 3.91);

const options = vehicleOptionsFromGarageBuild(getActiveGarageBuild());
const vehicle = new BaseVehicle(options);
assert.equal(vehicle.name, 'Night Runner');
assert.equal(vehicle.getFrameParameters().wheelbase, 3.91);
assert.equal(vehicle.config.ground.enginePower, 8.4);
assert.equal(vehicle.config.ground.wheelRadius, 0.5);
assert.equal(vehicle.config.ground.wheelWidth, 0.42);
assert.deepEqual(vehicle.chassisOverlayOptions.position, [0.1, -0.22, 0.08]);
assert.equal(vehicle.config.ground.rayCast.maxSteerYawRate, 0.82);
assert.equal(options.chassisOverlay.url, '/assets/models/muscle-chasis-2.glb');

assert.equal(deleteGarageBuild(saved.id).length, 0);
assert.equal(getActiveGarageBuild(), null);
console.log('Garage persistence and vehicle conversion checks passed.');
