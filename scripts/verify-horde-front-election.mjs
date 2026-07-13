// Pure-node verifier for Horde M2 "front election" (docs/horde-flow-mob-plan.md).
//
// Guards the switch from euclidean election to FLOW distance-to-goal ranking:
//   1. Promotion picks the FRONT (lowest distToGoal), not the euclidean-nearest
//      proxy — a proxy that is straight-line close but behind a wall (long path)
//      must lose to one further in straight line but with a shorter flow path.
//   2. Demotion picks the REAR (highest flow distToGoal among full actors),
//      via a threaded getFlowDistanceAt sampler, with the safety guards intact
//      (attackers / recent promotions / slot-holders never demote).
//   3. Front-arc: with the horde front-arc enabled, claimed attack-slot angles
//      cluster inside the approach cone; disabling it (non-horde) restores the
//      full 360° ring. This is the guard that soldier/normal encirclement is
//      untouched.
//
// Run: node scripts/verify-horde-front-election.mjs
// Alias: npm run verify:horde-front-election

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HordeFlowField } from '../src/game/systems/HordeFlowField.js';
import { HordeProxySystem } from '../src/game/systems/HordeProxySystem.js';
import { EnemySystem } from '../src/game/systems/EnemySystem.js';

// Headless canvas stub (same pattern as verify-horde-lifecycle.mjs) so the
// three / gltf import chain doesn't throw under node.
const _ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : _ctx2d),
  apply: () => _ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => _ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

const failures = [];
let testCount = 0;
function test(name, fn) {
  testCount += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

console.log('Horde front election (M2) — flow-distance promotion/demotion + front-arc\n');

// ── 1. Promotion picks the front (low distToGoal), not euclidean-nearest ─────
test('promotion elects lowest distToGoal, not straight-line nearest', () => {
  // Arena with a long wall (x in [-8, 8]) at z=0 leaving a gap on the far -x/+x
  // ends only. Goal (player) at south (z=-4). A proxy just NORTH of the wall
  // near x=0 is euclidean-close but must path around the wall (high distToGoal);
  // a proxy already SOUTH of the wall is further in straight line but low
  // distToGoal (short flow path).
  const colliders = [
    { name: 'wall', minX: -8, maxX: 8, minZ: -0.3, maxZ: 0.3, bottomY: 0, topY: 2.5 },
    { name: 'floor', minX: -14, maxX: 14, minZ: -14, maxZ: 14, bottomY: -0.2, topY: 0 },
  ];
  const field = new HordeFlowField({
    colliders,
    bounds: { minX: -14, maxX: 14, minZ: -14, maxZ: 14 },
    cellSize: 0.5,
    agentRadius: 0.35,
    agentHeight: 1.8,
    floorY: 0,
  });
  const player = { x: 0, y: 0, z: -4 };
  field.update(player.x, player.z);

  const proxy = new HordeProxySystem();
  proxy.flowField = field;
  // Two candidates, both within the euclidean promote band (18m):
  //   A: north of the wall, near the axis — euclidean-close, long flow path.
  //   B: south of the wall — further straight-line, short flow path.
  const A = { x: 0.5, y: 0, z: 2.0 };
  const B = { x: 6.0, y: 0, z: -6.0 };
  proxy.agents = [
    { id: 'A', position: A, health: 100, anim: 'advance', distToGoal: field.sampleDistance(A.x, A.z) },
    { id: 'B', position: B, health: 100, anim: 'advance', distToGoal: field.sampleDistance(B.x, B.z) },
  ];

  const euclidA = Math.hypot(A.x - player.x, A.z - player.z);
  const euclidB = Math.hypot(B.x - player.x, B.z - player.z);
  assert.ok(euclidA < euclidB, `setup: A (${euclidA.toFixed(2)}) should be euclidean-closer than B (${euclidB.toFixed(2)})`);
  assert.ok(
    proxy.agents[0].distToGoal > proxy.agents[1].distToGoal,
    `setup: A flow ${proxy.agents[0].distToGoal} should exceed B flow ${proxy.agents[1].distToGoal} (A is behind the wall)`,
  );

  const idx = proxy._frontmostPromotableIndex(player);
  assert.equal(proxy.agents[idx].id, 'B', 'promotion should elect the frontmost (low distToGoal) proxy B, not euclidean-nearest A');
});

// ── 2. Demotion picks the rear (highest flow distToGoal), guards intact ──────
test('demotion elects highest flow distToGoal; guards keep attackers/slots full', () => {
  const es = new EnemySystem();
  const player = new THREE.Vector3(0, 0, 0);
  es.lastPlayerPosition = player.clone();

  // Flow distance sampler keyed to XZ: define a synthetic path-distance field
  // where distance grows with |x| but a "near" actor sitting at large x is
  // actually behind a detour (highest flow), and a far-x actor is close in flow.
  const NOW = 1e12 + 1000;
  const flowByX = new Map();
  function makeActor(id, x, { attacker = false, freshPromote = false, slotHeld = false } = {}) {
    const model = new THREE.Object3D();
    model.position.set(x, 0, 0);
    return {
      id,
      archetype: 'soldier',
      model,
      health: 100,
      maxHealth: 100,
      baseMaxHealth: 100,
      defeated: false,
      pendingCorpse: false,
      staggerTimer: 0,
      knockbackVelocity: null,
      state: attacker ? 'attack' : 'chase',
      cutCount: 0,
      splitAnimationActive: false,
      limbLoss: null,
      playerSlotIndex: slotHeld ? 0 : null,
      // freshPromote → promoted right now (within min-residence, must stay full).
      hordePromotedAt: freshPromote ? NOW : 0,
    };
  }

  // rear (highest flow) is the actor we WANT demoted; give it a modest
  // euclidean distance so a euclidean-only ranker would NOT pick it.
  const rear = makeActor('rear', 5); flowByX.set(5, 40); // huge flow (behind cover)
  const midEuclidFar = makeActor('far', 12); flowByX.set(12, 14); // furthest euclidean, small flow
  const near = makeActor('near', 3); flowByX.set(3, 8);
  const attacker = makeActor('attacker', 20, { attacker: true }); flowByX.set(20, 99);
  const fresh = makeActor('fresh', 22, { freshPromote: true }); flowByX.set(22, 98);
  const slotHolder = makeActor('slot', 25, { slotHeld: true }); flowByX.set(25, 97);
  es.enemies = [near, midEuclidFar, rear, attacker, fresh, slotHolder];

  const getFlowDistanceAt = (pos) => flowByX.get(pos.x) ?? Math.abs(pos.x);
  // Explicit large `now` so the min-residence guard (now - promotedAt) treats
  // promotedAt=0 actors as long-resident and the freshPromote (promotedAt=NOW)
  // actor as too-recent. Without this, performance.now() at process start can
  // be below minResidenceMs and reject everything.
  const opts = { now: NOW, minResidenceMs: 750, demotionRadius: 0 };

  // Sanity: a euclidean furthest finder would pick the guarded 'slot'/'fresh'
  // (x=22/25) or 'far' (x=12) among the SAFE ones — assert flow ranking differs.
  const euclid = es.findFurthestDemotableHordeActor(player, opts);
  assert.equal(euclid?.id, 'far', 'euclidean furthest SAFE actor should be "far" (x=12)');

  const rearmost = es.findRearmostDemotableHordeActor(player, {
    ...opts,
    getFlowDistanceAt,
  });
  assert.equal(rearmost?.id, 'rear', 'flow-rank demotion should elect "rear" (flow 40), not euclidean "far"');
  assert.notEqual(rearmost?.id, 'attacker', 'attackers must never demote');
  assert.notEqual(rearmost?.id, 'fresh', 'recently-promoted actors must never demote');
  assert.notEqual(rearmost?.id, 'slot', 'slot-holding actors must never demote');
});

// ── 3. Front-arc restricts slots to the approach cone (horde only) ───────────
test('front-arc clusters claimed slots in the approach cone; disabling restores 360°', () => {
  const player = new THREE.Vector3(0, 0, 0);

  function claimAngles(system, count, spawnAngleSpread) {
    system.lastPlayerPosition = player.clone();
    const angles = [];
    for (let i = 0; i < count; i += 1) {
      // Spread the enemies themselves around the ring so their OWN bearing does
      // not pre-bias the result — the arc must come from the front-arc setting.
      const a = (i / count) * spawnAngleSpread - spawnAngleSpread / 2;
      const model = new THREE.Object3D();
      model.position.set(Math.cos(a) * 6, 0, Math.sin(a) * 6);
      model.rotation.y = a;
      const enemy = { id: `e${i}`, model, playerSlotIndex: null };
      system.enemies.push(enemy);
      system.ensurePlayerSlotCapacity();
      const slot = system.checkoutPlayerSlot(enemy);
      if (slot) angles.push(slot.angle);
    }
    return angles;
  }

  // Front-arc ON, bearing pointing +x (0 rad). The cone at slot radius fits a
  // limited number of non-overlapping slots — that space limit is expected.
  const horde = new EnemySystem();
  horde.setHordeFrontArc({ enabled: true, bearing: 0 });
  const arcAngles = claimAngles(horde, 12, Math.PI * 2);
  assert.ok(arcAngles.length >= 4, `expected several slots claimed in the cone, got ${arcAngles.length}`);
  const HALF = (80 * Math.PI) / 180;
  for (const ang of arcAngles) {
    // shortest angular delta to 0
    let d = Math.atan2(Math.sin(ang - 0), Math.cos(ang - 0));
    assert.ok(Math.abs(d) <= HALF + 1e-6, `slot angle ${ang.toFixed(2)} outside front cone (|Δ|=${Math.abs(d).toFixed(2)} > ${HALF.toFixed(2)})`);
  }
  // And they genuinely cluster (angular spread << full ring).
  const spread = Math.max(...arcAngles) - Math.min(...arcAngles);
  assert.ok(spread <= 2 * HALF + 1e-6, `front-arc slots span ${spread.toFixed(2)} rad, should be <= cone ${(2 * HALF).toFixed(2)}`);

  // Front-arc OFF (default) — normal encirclement should reach beyond the cone.
  const normal = new EnemySystem();
  normal.setHordeFrontArc({ enabled: false });
  const ringAngles = claimAngles(normal, 16, Math.PI * 2);
  const maxDelta = Math.max(...ringAngles.map((a) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))));
  assert.ok(maxDelta > HALF, `non-horde ring should use angles beyond the front cone; max |Δ| was ${maxDelta.toFixed(2)}`);
});

console.log(`\n${testCount - failures.length}/${testCount} passed.`);
if (failures.length) {
  console.log('FAIL:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: M2 front election holds (flow-front promotion, flow-rear demotion, horde-gated front-arc).');
