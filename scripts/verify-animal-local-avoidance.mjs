/**
 * Guards park local avoidance (ORCA-lite) + velocity→gait mapping.
 *
 * Run: node scripts/verify-animal-local-avoidance.mjs
 */
import assert from 'node:assert/strict';
import {
  solveLocalAvoidance,
  gaitFromSpeed,
  preferredVelocity,
} from '../src/game/characters/dog/animalLocalAvoidance.js';
import { DogParkCrowd } from '../src/game/runtime/features/dogPark/DogParkCrowd.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

{
  const idle = gaitFromSpeed(0);
  assert.equal(idle.moving, false);
  assert.equal(idle.gait, 'idle');
  const walk = gaitFromSpeed(1.0);
  assert.equal(walk.moving, true);
  assert.equal(walk.sprint, false);
  const trot = gaitFromSpeed(2.5);
  assert.equal(trot.sprint, true);
  ok('gaitFromSpeed idle/walk/trot bands');
}

{
  const p = preferredVelocity(0, 1, 3);
  assert.ok(Math.abs(p.vx) < 1e-6);
  assert.ok(Math.abs(p.vz - 3) < 1e-6);
  const zero = preferredVelocity(0, 0, 5);
  assert.equal(zero.vx, 0);
  assert.equal(zero.vz, 0);
  ok('preferredVelocity from direction');
}

{
  // Head-on: two agents walking into each other should get lateral separation.
  const agents = [
    {
      id: 'a', x: 0, z: 0, preferredVx: 0, preferredVz: 2, radius: 0.4, maxSpeed: 2, priority: 1,
    },
    {
      id: 'b', x: 0, z: 2.2, preferredVx: 0, preferredVz: -2, radius: 0.4, maxSpeed: 2, priority: 1,
    },
  ];
  const result = solveLocalAvoidance(agents, 1 / 60);
  const va = result.get('a');
  const vb = result.get('b');
  assert.ok(va && vb, 'both results');
  // Relative lateral components should open a gap (not pure head-on).
  assert.ok(Math.abs(va.vx) + Math.abs(vb.vx) > 0.05, `expected lateral dodge (va.x=${va.vx} vb.x=${vb.vx})`);
  ok('head-on pair produces lateral dodge');
}

{
  // Shared group: chase pair ignores each other.
  const agents = [
    {
      id: 's', x: 0, z: 0, preferredVx: 0, preferredVz: 3, radius: 0.3, maxSpeed: 3, priority: 1, group: 'chase',
    },
    {
      id: 'd', x: 0, z: 1.5, preferredVx: 0, preferredVz: 3, radius: 0.4, maxSpeed: 3, priority: 1, group: 'chase',
    },
  ];
  const result = solveLocalAvoidance(agents, 1 / 60);
  const vs = result.get('s');
  // Preferred was pure +z; same-group should not force a big lateral correction.
  assert.ok(Math.abs(vs.vx) < 0.15, `group ignore leaked lateral ${vs.vx}`);
  assert.ok(vs.vz > 2.5, 'still mostly along preferred');
  ok('shared group skips mutual avoidance');
}

{
  // High-priority player: low-priority agent yields more.
  const agents = [
    {
      id: 'player', x: 0, z: 0, preferredVx: 0, preferredVz: 0, radius: 0.35, maxSpeed: 4, priority: 3.2,
    },
    {
      id: 'npc', x: 0.5, z: 0.5, preferredVx: -1.5, preferredVz: -1.5, radius: 0.35, maxSpeed: 2, priority: 1,
    },
  ];
  const result = solveLocalAvoidance(agents, 1 / 60);
  const npc = result.get('npc');
  // NPC was aiming into the player — safe speed should drop or deflect.
  assert.ok(npc.speed < 2.1);
  ok('player priority forces npc yield');
}

{
  const crowd = new DogParkCrowd();
  crowd.begin();
  crowd.register({
    id: 'player-dog', x: 0, z: 0, dirX: 0, dirZ: 1, speed: 2, radius: 0.34, maxSpeed: 4, priority: 3,
  });
  crowd.register({
    id: 'chase-dog', x: 0.2, z: 1.0, dirX: 0, dirZ: -2, speed: 2.5, radius: 0.4, maxSpeed: 3, priority: 1, group: 'chase',
  });
  crowd.solve(1 / 60);
  const m = crowd.getMotion('chase-dog');
  assert.ok(m);
  assert.ok(Number.isFinite(m.dirX) && Number.isFinite(m.dirZ));
  assert.equal(crowd.snapshot().agents, 2);
  ok('DogParkCrowd register/solve/getMotion');
}

console.log(`\n${passed} passed`);
