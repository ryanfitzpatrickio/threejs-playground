import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';
import { QuadBikeVehicle } from '../src/game/vehicles/QuadBikeVehicle.js';
import { prepareVehicleOverlayGeometry } from '../src/game/geometry/prepareVehicleOverlayGeometry.js';
import {
  createGarageBuild,
  createFallbackGarageChassisOption,
  deleteGarageBuild,
  getActiveGarageBuild,
  getGarageChassisOption,
  loadGarageBuilds,
  saveGarageBuild,
  sanitizeGarageBuild,
  setGarageChassisOptionsOverride,
  spawnVehicleOptions,
  vehicleOptionsFromGarageBuild,
} from '../src/game/vehicles/garageBuilds.js';
import { resolveEngineSounds, resolveExteriorIdleUrl } from '../src/game/vehicles/engineProfiles.js';
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
draft.chassisPartOverrides = {
  'muscle-2': { tripo_part_10: 'windshield', tripo_part_0: 'hide' },
};
const saved = saveGarageBuild(draft);

assert.equal(loadGarageBuilds().length, 1);
assert.equal(getActiveGarageBuild().id, saved.id);
assert.equal(getActiveGarageBuild().frame.wheelbase, 3.91);
assert.equal(getActiveGarageBuild().hideBackSeats, true);
assert.equal(getActiveGarageBuild().hideEngine, true);
assert.equal(getActiveGarageBuild().disableGlassDetection, true);
assert.equal(getActiveGarageBuild().chassisSurfaceMode, 'texture');
assert.deepEqual(
  getActiveGarageBuild().chassisPartOverrides['muscle-2'],
  { tripo_part_10: 'windshield', tripo_part_0: 'hide' },
);

const options = vehicleOptionsFromGarageBuild(getActiveGarageBuild());
assert.equal(options.hideEngine, true);
assert.equal(options.chassisOverlay.disableGlassDetection, true);
assert.equal(options.chassisOverlay.chassisSurfaceMode, 'texture');
assert.equal(options.chassisOverlay.useAuthoredTexture, true);
assert.deepEqual(options.chassisOverlay.partOverrides, { tripo_part_10: 'windshield', tripo_part_0: 'hide' });
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

const electricBuild = createGarageBuild('electric');
assert.equal(electricBuild.chassisId, 'orange-car');
assert.equal(electricBuild.chassisSurfaceMode, 'metallic');
assert.equal(electricBuild.wheels.tireId, 'tesla-tire');
assert.equal(electricBuild.performance.engineProfile, 'electric');
assert.equal(electricBuild.hideEngine, true);
const electricOptions = vehicleOptionsFromGarageBuild(electricBuild);
assert.equal(electricOptions.chassisOverlay.url, '/assets/models/orange-car.glb');
assert.equal(electricOptions.chassisOverlay.profileId, 'orange-car');
assert.equal(electricOptions.chassisOverlay.chassisSurfaceMode, 'metallic');
assert.equal(electricOptions.chassisOverlay.useAuthoredTexture, false);
assert.deepEqual(electricOptions.chassisOverlay.scale, [40, 45, 40]);
assert.equal(electricOptions.wheelVisual.url, '/assets/models/tesla-tire.glb');
assert.equal(electricOptions.config.engineProfile, 'electric');
assert.ok(resolveEngineSounds('electric')?.on_low?.source?.includes('/electric/on-low'));
assert.equal(resolveExteriorIdleUrl('electric'), '/audio/engine/electric/exterior-idle.mp3');
const electricVehicle = new BaseVehicle(electricOptions);
assert.equal(electricVehicle._engineIdle, 0);

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
assert.equal(sanitizeGarageBuild({ frame: { wheelAxleOffset: 0.24 } }).frame.wheelAxleOffset, 0.24);

const camoBuild = createGarageBuild('electric', { chassisSurfaceMode: 'camo' });
assert.equal(camoBuild.chassisSurfaceMode, 'camo');
const camoOptions = vehicleOptionsFromGarageBuild(camoBuild);
assert.equal(camoOptions.chassisOverlay.chassisSurfaceMode, 'camo');
assert.equal(camoOptions.chassisOverlay.useAuthoredTexture, false);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(
  existsSync(join(repoRoot, 'public/assets/textures/vehicles/obfuscation-tape-albedo.png')),
  'obfuscation tape albedo texture must exist',
);
for (const file of [
  'on-low.mp3',
  'on-high.mp3',
  'inverter-low.mp3',
  'inverter-high.mp3',
  'road-hiss.mp3',
  'regen.mp3',
  'throttle-punch.mp3',
  'exterior-idle.mp3',
]) {
  assert.ok(
    existsSync(join(repoRoot, 'public/audio/engine/electric', file)),
    `electric engine audio missing: ${file}`,
  );
}

// Meshy shells use tiny source units and are enlarged by their overlay transform.
// Generated UVs must still span the texture instead of sampling one white texel.
const tinyShell = new THREE.BoxGeometry(0.04, 0.025, 0.1).deleteAttribute('uv');
tinyShell.setAttribute('color', new THREE.Uint8BufferAttribute(
  new Uint8Array(tinyShell.getAttribute('position').count * 3).fill(255),
  3,
  true,
));
const preparedTinyShell = prepareVehicleOverlayGeometry(tinyShell);
const preparedUv = preparedTinyShell.getAttribute('uv');
let minU = Infinity;
let maxU = -Infinity;
for (let index = 0; index < preparedUv.count; index += 1) {
  minU = Math.min(minU, preparedUv.getX(index));
  maxU = Math.max(maxU, preparedUv.getX(index));
}
assert.equal(preparedTinyShell.getAttribute('color'), undefined);
assert.ok(maxU - minU >= 0.39, `generated Meshy UVs should span the albedo (got ${maxU - minU})`);
preparedTinyShell.dispose();

const quadBuild = sanitizeGarageBuild({
  vehicleType: 'quad',
  name: 'Trail Quad',
  paintId: 'sand',
  frame: { rideHeight: 0.74, offsetFromTires: -0.08 },
  wheels: { tireId: 'tesla-tire', radius: 0.36, width: 0.28 },
});
assert.equal(quadBuild.frame.rideHeight, 0.74);
assert.equal(quadBuild.frame.offsetFromTires, -0.08);
assert.equal(quadBuild.wheels.tireId, 'tesla-tire');
assert.equal(quadBuild.wheels.radius, 0.36);
const quadOptions = vehicleOptionsFromGarageBuild(quadBuild);
assert.equal(quadOptions.vehicleKind, 'quad');
assert.equal(quadOptions.paintId, 'sand');
assert.equal(quadOptions.wheelVisual.url, '/assets/models/tesla-tire.glb');
assert.equal(quadOptions.useEmbeddedModelTires, false);
assert.equal(quadOptions.frameParameters.rideHeight, quadBuild.frame.rideHeight);
assert.equal(quadOptions.frameParameters.offsetFromTires, quadBuild.frame.offsetFromTires);
assert.equal(quadOptions.config.ground.wheelRadius, 0.36);
assert.equal(quadOptions.config.ground.rayCast.wheelRadius, 0.36);
const quadVehicle = new QuadBikeVehicle(quadOptions);
assert.equal(quadVehicle.wheelVisualOptions.url, '/assets/models/tesla-tire.glb');
const quadDefaultBuild = sanitizeGarageBuild({ vehicleType: 'quad' });
assert.equal(quadDefaultBuild.wheels.tireId, 'quad-tire');
const quadDefaultOptions = vehicleOptionsFromGarageBuild(quadDefaultBuild);
assert.equal(quadDefaultOptions.wheelVisual.url, '/assets/models/quad-tire.glb');
const bareQuad = new QuadBikeVehicle();
assert.equal(bareQuad.wheelVisualOptions.url, '/assets/models/quad-tire.glb');
const modelTireQuad = vehicleOptionsFromGarageBuild(sanitizeGarageBuild({
  vehicleType: 'quad',
  wheels: { tireId: 'quad-model' },
}));
assert.equal(modelTireQuad.wheelVisual, null);
assert.equal(modelTireQuad.useEmbeddedModelTires, true);

setGarageChassisOptionsOverride(null);
const bodyshopBuild = saveGarageBuild(createGarageBuild('street', {
  name: 'Custom Shell',
  chassisId: 'orange-ev-mk2',
}));
assert.equal(bodyshopBuild.chassisId, 'orange-ev-mk2');
assert.equal(getActiveGarageBuild().chassisId, 'orange-ev-mk2');
const bodyshopOptions = vehicleOptionsFromGarageBuild(getActiveGarageBuild());
assert.equal(bodyshopOptions.chassisOverlay.profileId, 'orange-ev-mk2');
assert.equal(bodyshopOptions.chassisOverlay.url, '/assets/models/orange-ev-mk2.glb');
assert.deepEqual(createFallbackGarageChassisOption('orange-ev-mk2'), {
  id: 'orange-ev-mk2',
  name: 'orange-ev-mk2',
  description: 'Authored chassis.',
  url: '/assets/models/orange-ev-mk2.glb',
  defaultTransform: null,
  source: 'bodyshop',
});
assert.equal(getGarageChassisOption('orange-ev-mk2').url, '/assets/models/orange-ev-mk2.glb');
assert.equal(spawnVehicleOptions('city').chassisOverlay.profileId, 'orange-ev-mk2');
deleteGarageBuild(bodyshopBuild.id);

console.log('Garage persistence and vehicle conversion checks passed.');
