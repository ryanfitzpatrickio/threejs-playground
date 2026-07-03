// Verifies M3: the trackside barrier WALLS physically contain a vehicle.
//
// createTracksideLayers emits per-segment oriented-box colliders for wall bands.
// PhysicsSystem builds each as a fixed Rapier cuboid (ColliderDesc.cuboid(he)
// .setTranslation(center).setRotation(orientation)). This re-creates that exact
// build in a headless Rapier world, then launches a CCD-enabled dynamic chassis
// straight at the barrier and asserts it never tunnels past the wall — the same
// failure mode (thin obstacle + fast body) the bridge-seam CCD test guards.
//
// Run: node scripts/verify-trackside-wall-containment.mjs

import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';

const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { createTracksideLayers } = await import('../src/game/world/createTracksideLayers.js');
const { TRACK_CROSS_SECTIONS } = await import('../src/game/world/trackCrossSection.js');

await RAPIER.init();

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// Straight road along x, centerline z=0, flat terrain. Left-side walls face +z.
const sampleHeight = () => 0;
const profile = buildRoadProfile({
  roads: [{ points: [{ x: -60, z: 0 }, { x: 0, z: 0 }, { x: 60, z: 0 }], width: 10, trackStyle: 'urbanCircuit' }],
  sampleHeight, smoothRadius: 2, maxGrade: Infinity,
});
const built = profile.roads[0];
const half = built.half;
const bands = TRACK_CROSS_SECTIONS.urbanCircuit.bands;
const curb = bands.find((b) => b.kind === 'curb');
const shoulder = bands.find((b) => b.kind === 'shoulder');
const wall = bands.find((b) => b.kind === 'wall');
const wallInnerZ = half + curb.width + shoulder.width + wall.gap; // +z inner face
const wallOuterZ = wallInnerZ + wall.thickness;

const layers = createTracksideLayers({ profile, sampleHeight });
const wallColliders = layers.colliders;
assert.ok(wallColliders.length > 0, 'walls produced colliders');

// ---- Build the Rapier world exactly as PhysicsSystem does for oriented boxes.
const world = new RAPIER.World({ x: 0, y: 0, z: 0 }); // no gravity: isolate the wall test
for (const c of wallColliders) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(c.halfExtents.x, c.halfExtents.y, c.halfExtents.z)
      .setTranslation(c.center.x, c.center.y, c.center.z)
      .setRotation(c.orientation)
      .setFriction(0.55).setRestitution(0),
    body,
  );
}
ok(`built ${wallColliders.length} wall colliders into a headless Rapier world`);

// ---- Launch a dynamic chassis from inside the track straight at the +z barrier.
const CHASSIS_HALF = [1.0, 0.4, 1.0];
const startZ = wallInnerZ - 3;            // a few metres shy of the wall
const wallMidY = 0.5;                      // wall spans ~0..1; aim at mid-height
const desc = RAPIER.RigidBodyDesc.dynamic()
  .setTranslation(0, wallMidY, startZ)
  .setLinvel(0, 0, 28)                     // fast, toward the wall (+z)
  .setLinearDamping(0.05)
  .setCcdEnabled(true);                    // same CCD the vehicle uses
const chassis = world.createRigidBody(desc);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF).setDensity(40).setFriction(0.55).setRestitution(0),
  chassis,
);

let maxZ = startZ;
for (let step = 0; step < 240; step += 1) {
  world.step();
  maxZ = Math.max(maxZ, chassis.translation().z);
}
const finalZ = chassis.translation().z;

// The chassis must be stopped by the wall, not pass through it. Its FAR face is
// center.z + half-depth; that must never reach the wall's outer face (tunnelled).
const chassisFarMax = maxZ + CHASSIS_HALF[2];
assert.ok(chassisFarMax < wallOuterZ, `chassis never tunnels past wall (far face max ${chassisFarMax.toFixed(2)} < outer ${wallOuterZ.toFixed(2)})`);
ok(`chassis contained: far face peaked at ${chassisFarMax.toFixed(2)}m, wall outer at ${wallOuterZ.toFixed(2)}m`);

// And it actually advanced toward and engaged the wall (not stuck at spawn).
assert.ok(maxZ > startZ + 1, 'chassis advanced toward the wall');
assert.ok(finalZ < wallInnerZ, `chassis came to rest inside the barrier (z=${finalZ.toFixed(2)} < inner ${wallInnerZ.toFixed(2)})`);
ok('chassis advanced, hit the barrier, and stayed inside it');

layers.dispose();
console.log(`\nAll ${passed} wall-containment checks passed.`);
