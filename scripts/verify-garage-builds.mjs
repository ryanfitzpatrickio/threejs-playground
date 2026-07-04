import assert from 'node:assert/strict';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';
import {
  createGarageBuild,
  deleteGarageBuild,
  getActiveGarageBuild,
  loadGarageBuilds,
  saveGarageBuild,
  spawnVehicleOptions,
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
draft.hideBackSeats = true;
draft.hideEngine = true;
draft.disableGlassDetection = true;
draft.chassisSurfaceMode = 'texture';
const saved = saveGarageBuild(draft);

assert.equal(loadGarageBuilds().length, 1);
assert.equal(getActiveGarageBuild().id, saved.id);
assert.equal(getActiveGarageBuild().frame.wheelbase, 3.91);
assert.equal(getActiveGarageBuild().hideBackSeats, true);
assert.equal(getActiveGarageBuild().hideEngine, true);
assert.equal(getActiveGarageBuild().disableGlassDetection, true);
assert.equal(getActiveGarageBuild().chassisSurfaceMode, 'texture');

const options = vehicleOptionsFromGarageBuild(getActiveGarageBuild());
assert.equal(options.hideEngine, true);
assert.equal(options.chassisOverlay.disableGlassDetection, true);
assert.equal(options.chassisOverlay.chassisSurfaceMode, 'texture');
assert.equal(options.chassisOverlay.useAuthoredTexture, true);
const vehicle = new BaseVehicle(options);
assert.equal(vehicle.name, 'Night Runner');
assert.equal(vehicle.getFrameParameters().wheelbase, 3.91);
assert.equal(vehicle.config.ground.enginePower, 8.4);
assert.equal(vehicle.config.ground.wheelRadius, 0.5);
assert.equal(vehicle.config.ground.wheelWidth, 0.42);
assert.deepEqual(vehicle.chassisOverlayOptions.position, [0.1, -0.22, 0.08]);
assert.equal(vehicle.config.ground.rayCast.maxSteerYawRate, 0.82);
assert.equal(options.chassisOverlay.url, '/assets/models/muscle-chasis-2.glb');
assert.deepEqual(vehicle.config.seats.map((seat) => seat.name), ['driver', 'front-passenger']);
assert.equal(vehicle.occupants.length, 2);

const rallySpawn = spawnVehicleOptions('rally');
assert.equal(rallySpawn.name, 'Night Runner');
assert.equal(rallySpawn.chassisOverlay.profileId, 'muscle-2');
assert.equal(rallySpawn.config.ground.driveLayout, 'awd');
assert.equal(rallySpawn.config.ground.enginePower, 8.4);
assert.equal(rallySpawn.config.ground.traction, 0.55);

const highTractionBuild = createGarageBuild('rally', { performance: { traction: 0.92 } });
const highTractionOptions = vehicleOptionsFromGarageBuild(highTractionBuild);
assert.equal(highTractionOptions.config.ground.traction, 0.92);
const highTractionVehicle = new BaseVehicle(highTractionOptions);
highTractionVehicle.setGroundSurface('mud');
highTractionVehicle._updateSurfaceTuning(1);
const lowTractionVehicle = new BaseVehicle(vehicleOptionsFromGarageBuild(
  createGarageBuild('rally', { performance: { traction: 0.4 } }),
));
lowTractionVehicle.setGroundSurface('mud');
lowTractionVehicle._updateSurfaceTuning(1);
assert.ok(highTractionVehicle.surfaceTuning.frictionSlip > lowTractionVehicle.surfaceTuning.frictionSlip);
assert.ok(
  highTractionVehicle.surfaceTuning.rollingResistanceScale
  < lowTractionVehicle.surfaceTuning.rollingResistanceScale,
);

const citySpawn = spawnVehicleOptions('city');
assert.equal(citySpawn.chassisOverlay.profileId, 'muscle-2');
assert.notEqual(citySpawn.config.ground.driveLayout, 'awd');

const fourSeatVehicle = new BaseVehicle(vehicleOptionsFromGarageBuild(createGarageBuild('street')));
assert.equal(fourSeatVehicle.config.seats.length, 4);
assert.equal(fourSeatVehicle.occupants.length, 4);

assert.equal(deleteGarageBuild(saved.id).length, 0);
assert.equal(getActiveGarageBuild(), null);

const rallyBuild = createGarageBuild('rally');
assert.equal(rallyBuild.chassisSurfaceMode, 'mix');
assert.equal(vehicleOptionsFromGarageBuild(rallyBuild).chassisOverlay.chassisSurfaceMode, 'mix');

console.log('Garage persistence and vehicle conversion checks passed.');
