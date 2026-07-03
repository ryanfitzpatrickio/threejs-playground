// Headless Rapier regression for the chassis-vs-thin-deck tunneling fix.
//
// Bug: the vehicle chassis (a dynamic cuboid) had no CCD, so at speed / under a
// frame hitch it could translate past a thin bridge deck collider (DECK_THICK
// 0.6 m) in one world.step() and fall through. Fix: setCcdEnabled(true) on the
// chassis body (BaseVehicle.spawn).
//
// This harness proves three things with a minimal Rapier world (no scene / no
// full BaseVehicle spawn, which would need a PhysicsSystem):
//   (A) Realistic 0.6 m deck + driving speed: a CCD chassis comes to REST on the
//       deck instead of tunneling (the user-facing guarantee).
//   (B) Sensitivity control: a fast chassis WITHOUT CCD punches through a thin
//       deck — i.e. the harness can actually observe tunneling.
//   (C) The same thin-deck + speed WITH CCD is caught — CCD is what prevents it.
//
// Run: node scripts/verify-vehicle-bridge-seam.mjs

import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';

const DT = 0.05; // GameRuntime clamps the frame dt to this ceiling
const DECK_TOP = 5.0;
const DECK_THICK = 0.6; // createRoadworks DECK_THICK
// config.body.size [2.0, 0.9, 4.2] -> half extents
const CHASSIS_HALF = [1.0, 0.45, 2.1];
const DENSITY = 18; // config.body.density
const GRAVITY = { x: 0, y: -9.81, z: 0 };

await RAPIER.init();

function makeDeck(world, halfHeight) {
  // Fixed slab whose TOP face sits at DECK_TOP (a bridge deck segment).
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, DECK_TOP - halfHeight, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(4, halfHeight, 4).setFriction(0.55).setRestitution(0),
    body,
  );
}

function makeChassis(world, { ccd, y, vy }) {
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, y, 0)
    .setLinearDamping(0.08)
    .setAngularDamping(0.9)
    .setCcdEnabled(ccd)
    .setCanSleep(false);
  if (vy) desc.setLinvel(0, vy, 0);
  const body = world.createRigidBody(desc);
  assert.equal(body.isCcdEnabled(), ccd, `chassis CCD state mismatch (ccd=${ccd})`);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF).setDensity(DENSITY).setFriction(0.55).setRestitution(0),
    body,
  );
  return body;
}

function run({ ccd, deckHalfHeight, startY, startVy, steps }) {
  const world = new RAPIER.World(GRAVITY);
  world.numSolverIterations = 8;
  makeDeck(world, deckHalfHeight);
  const chassis = makeChassis(world, { ccd, y: startY, vy: startVy });
  let minY = Infinity;
  let finalY = null;
  for (let i = 0; i < steps; i += 1) {
    world.step();
    const ty = chassis.translation().y;
    if (ty < minY) minY = ty;
    finalY = ty;
  }
  return { minY, finalY };
}

const deckBottom = DECK_TOP - DECK_THICK;

// (A) Realistic deck + driving speed with CCD: must rest on the deck, not tunnel.
const rest = run({ ccd: true, deckHalfHeight: DECK_THICK / 2, startY: DECK_TOP + 3, startVy: -45, steps: 120 });
assert.ok(rest.minY > deckBottom,
  `(A) CCD chassis fell through the deck: minY ${rest.minY.toFixed(2)} <= deck bottom ${deckBottom}`);
assert.ok(rest.finalY > DECK_TOP - 0.2 && rest.finalY < DECK_TOP + 1.0,
  `(A) CCD chassis did not come to rest on the deck: finalY ${rest.finalY.toFixed(2)}`);

// (B) Sensitivity control: fast chassis WITHOUT CCD tunnels a thin deck.
const bladeHalf = 0.05;
const tunneled = run({ ccd: false, deckHalfHeight: bladeHalf, startY: DECK_TOP + 2, startVy: -80, steps: 40 });
assert.ok(tunneled.minY < DECK_TOP - 0.5,
  `(B) control (CCD off) did not tunnel as expected: minY ${tunneled.minY.toFixed(2)} (harness not sensitive)`);

// (C) Same thin-deck + speed WITH CCD is caught.
const caught = run({ ccd: true, deckHalfHeight: bladeHalf, startY: DECK_TOP + 2, startVy: -80, steps: 40 });
assert.ok(caught.minY > DECK_TOP - DECK_THICK,
  `(C) CCD failed to prevent tunneling of the thin deck: minY ${caught.minY.toFixed(2)}`);

console.log('vehicle bridge-seam CCD regression passed');
console.log(`  (A) realistic deck, CCD on  : minY=${rest.minY.toFixed(2)} finalY=${rest.finalY.toFixed(2)} (deck ${deckBottom}-${DECK_TOP})`);
console.log(`  (B) thin blade,  CCD off : minY=${tunneled.minY.toFixed(2)} (tunneled)`);
console.log(`  (C) thin blade,  CCD on  : minY=${caught.minY.toFixed(2)} (caught)`);
