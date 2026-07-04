import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';

// Keep in sync with VehicleSystem SPAWN_EXTRA_CLEARANCE.
const SPAWN_EXTRA_CLEARANCE = 0.15;

class SpawnProbeVehicle extends BaseVehicle {
  async spawn() {
    this.spawnedAt = this.spawnPosition.clone();
    this.group = new THREE.Group();
    this.group.position.copy(this.spawnPosition);
    this.status = 'ready';
    return this;
  }
}

const system = new VehicleSystem();
system.initialize({
  physics: { world: {} },
  scene: new THREE.Scene(),
  level: { getGroundHeightAt: () => 7.25 },
});

const vehicle = new SpawnProbeVehicle({
  position: new THREE.Vector3(4, -100, 9),
  config: {
    body: { size: [2.4, 4, 5] },
    // Legacy spring-clearance formula under test (the raycast controller, now the
    // default, computes ride height from its own rayCast params).
    ground: { useRayCastController: false, suspension: { restLength: 0.6 } },
  },
});
await system.spawnVehicle({ vehicle });

// The raycast spring carries the car (the wheel-collider balls are recessed
// hard-stops), so spawn clearance = bodyHalfHeight + the SETTLED ride height
// (restLength - weight sag) + contactSkin. Sag is mass-normalised: the four wheels
// share the load, so sag = g / (wheelCount * stiffness).
const susp = vehicle.config.ground.suspension;
const wheelCount = vehicle.config.ground.wheels?.length ?? 4;
const sag = Math.min(susp.restLength, 9.81 / (wheelCount * susp.stiffness));
const expectedY = 7.25 + 2 + (susp.restLength - sag) + vehicle.config.body.contactSkin + SPAWN_EXTRA_CLEARANCE;
assert.ok(Math.abs(vehicle.spawnedAt.y - expectedY) < 1e-9);
assert.ok(
  vehicle.spawnedAt.y - vehicle.config.body.size[1] * 0.5 > 7.25,
  'vehicle collider started intersecting the ground',
);

const explicitAirborneY = 20;
const unsnapped = new SpawnProbeVehicle({ position: new THREE.Vector3(0, explicitAirborneY, 0) });
await system.spawnVehicle({ vehicle: unsnapped, snapToGround: false });
assert.equal(unsnapped.spawnedAt.y, explicitAirborneY);

console.log('vehicle spawn regression passed');
