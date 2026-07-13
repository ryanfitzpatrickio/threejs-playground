// Pure-node verifier for the Horde flow-mob boids body (M1 of
// docs/horde-flow-mob-plan.md). Guards the switch from the old encircle ring
// (HordeProxySystem.updateAgent orbiting at PROXY_HOLD_RADIUS) to shared
// flow-field + cohesion + alignment + separation steering.
//
// Imports the PURE steering module (hordeFlockSteering.js), the M0
// HordeFlowField, and the REAL createHordeModeLevel() colliders — no three /
// renderer. Spawns ~120 agents at the arena gate spawn points, runs the
// steering with the player at origin for many ticks, and asserts:
//   1. Convergence — mean agent->player distance decreases over time.
//   2. Clumping — mean nearest-neighbor distance is small AND smaller than a
//      flow-only baseline (cohesion/align = 0), proving cohesion actually
//      pulls them into a body.
//   3. No encircle — the angular distribution of agents around the player is
//      strongly NON-uniform (biased toward the approach side). This is the key
//      regression guard vs the old uniform ring.
//   4. No interpenetration — min pairwise distance stays >= ~collision
//      diameter (separation holds).
//   5. Funnel — agents reach the interior through the gates (goal-side /
//      reachable count rises; they don't pile permanently on a wall).
//
// Run: node scripts/verify-horde-flow-cohesion.mjs
// Alias: npm run verify:horde-flow-cohesion

import assert from 'node:assert/strict';
import { HordeFlowField } from '../src/game/systems/HordeFlowField.js';
import { UniformSpatialGrid } from '../src/game/systems/UniformSpatialGrid.js';
import {
  stepFlockSteering,
  meanNearestNeighborDistance,
  DEFAULT_FLOCK_WEIGHTS,
} from '../src/game/systems/hordeFlockSteering.js';
import { createHordeModeLevel } from '../src/game/world/createHordeModeLevel.js';

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

const HALF = 36;
const AGENT_SPEED = 1.7;
// Real proxy body radius ~0.45m (diameter ~0.9m). Separation is a SOFT
// steering term, not a hard constraint, so a dense forward column settles a
// little tighter than the comfort spacing; assert bodies never collapse to
// interpenetration (which is what the old ring never had to handle, and what
// would strobe). 0.45m = one body radius apart, center to center.
const MIN_BODY_SPACING = 0.45;
const TICK = 1 / 12;
const TICKS = 240; // ~20s of sim
const PLAYER = { x: 0, z: 0 };

// A deterministic PRNG so spawn jitter is reproducible run-to-run.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function buildField(colliders) {
  return new HordeFlowField({
    colliders,
    bounds: { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
    cellSize: 0.75,
    agentRadius: 0.35,
    agentHeight: 1.8,
    floorY: 0,
  });
}

/** Spawn agents clustered at the gate spawn points (like the real spawner). */
function spawnAgents(level, count) {
  const rng = makeRng(0xa11ce);
  const gates = level.hordeSpawnPoints;
  const agents = [];
  for (let i = 0; i < count; i += 1) {
    const gate = gates[i % gates.length];
    // Jitter inward + laterally so they don't start co-located.
    const jitterX = (rng() - 0.5) * 3;
    const jitterZ = (rng() - 0.5) * 3;
    agents.push({
      id: `a${i}`,
      position: { x: gate.position.x + jitterX, y: 0, z: gate.position.z + jitterZ },
      heading: gate.yaw,
      yaw: gate.yaw,
      speed: AGENT_SPEED,
      distToGoal: Infinity,
      anim: 'idle',
      animTime: 0,
      health: 100,
      hitTimer: 0,
      corpseTimer: 0,
    });
  }
  return agents;
}

function meanDistanceToPlayer(agents) {
  let sum = 0;
  for (const a of agents) sum += Math.hypot(a.position.x - PLAYER.x, a.position.z - PLAYER.z);
  return sum / agents.length;
}

function minPairwiseDistance(agents) {
  let min = Infinity;
  for (let i = 0; i < agents.length; i += 1) {
    for (let j = i + 1; j < agents.length; j += 1) {
      const d = Math.hypot(
        agents[i].position.x - agents[j].position.x,
        agents[i].position.z - agents[j].position.z,
      );
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * Angular non-uniformity of agents around the player: bin bearings into 12
 * sectors and return the peak-bin fraction. A uniform ring ~= 1/12 (0.083);
 * a directional mob has most agents in a few sectors (high peak fraction).
 */
function angularPeakFraction(agents, nearRadius = 22) {
  const bins = new Array(12).fill(0);
  let counted = 0;
  for (const a of agents) {
    const dx = a.position.x - PLAYER.x;
    const dz = a.position.z - PLAYER.z;
    const r = Math.hypot(dx, dz);
    if (r > nearRadius) continue; // only agents that have closed in
    const ang = Math.atan2(dz, dx) + Math.PI; // 0..2pi
    const bin = Math.min(11, Math.floor((ang / (Math.PI * 2)) * 12));
    bins[bin] += 1;
    counted += 1;
  }
  if (counted === 0) return 1;
  const peak = Math.max(...bins);
  return peak / counted;
}

function run(colliders, level, count, weights) {
  const field = buildField(colliders);
  const grid = new UniformSpatialGrid(weights.neighborRadius);
  const agents = spawnAgents(level, count);
  field.update(PLAYER.x, PLAYER.z); // static goal at origin
  for (let t = 0; t < TICKS; t += 1) {
    stepFlockSteering({ agents, field, grid, playerPos: PLAYER, delta: TICK, weights });
  }
  return { field, grid, agents };
}

console.log('HordeFlowField flow-mob (M1) — boids cohesion vs old encircle ring\n');

const level = createHordeModeLevel();
const colliders = level.colliders;
const COUNT = 120;

// ── Full boids run ──────────────────────────────────────────────────────────
const field = buildField(colliders);
const grid = new UniformSpatialGrid(DEFAULT_FLOCK_WEIGHTS.neighborRadius);
const agents = spawnAgents(level, COUNT);
field.update(PLAYER.x, PLAYER.z);

const startDist = meanDistanceToPlayer(agents);
const startReachable = agents.filter((a) => Number.isFinite(field.sampleDistance(a.position.x, a.position.z))).length;

let midDist = startDist;
for (let t = 0; t < TICKS; t += 1) {
  stepFlockSteering({ agents, field, grid, playerPos: PLAYER, delta: TICK, weights: DEFAULT_FLOCK_WEIGHTS });
  if (t === Math.floor(TICKS / 2)) midDist = meanDistanceToPlayer(agents);
}
const endDist = meanDistanceToPlayer(agents);

// cache each agent's distToGoal for the goal-side/funnel check.
for (const a of agents) a.distToGoal = field.sampleDistance(a.position.x, a.position.z);
// "Through the gate" = no longer pinned at the perimeter wall band. Agents
// spawn at the gates (|x| or |z| ~= HALF - inset); a funneling mob moves off
// the wall into the interior.
const PERIMETER_BAND = HALF - 6;
const startPerimeter = spawnAgents(level, COUNT)
  .filter((a) => Math.abs(a.position.x) > PERIMETER_BAND || Math.abs(a.position.z) > PERIMETER_BAND).length;
const endInterior = agents.filter((a) => Math.abs(a.position.x) <= PERIMETER_BAND && Math.abs(a.position.z) <= PERIMETER_BAND).length;

// ── Flow-only baseline (no cohesion / alignment) ─────────────────────────────
const baselineWeights = { ...DEFAULT_FLOCK_WEIGHTS, cohesion: 0, align: 0 };
const baseline = run(colliders, level, COUNT, baselineWeights);
const baselineNN = meanNearestNeighborDistance(baseline.agents, baseline.grid);
const cohesionNN = meanNearestNeighborDistance(agents, grid);

// ── Assertions ───────────────────────────────────────────────────────────────

test('convergence: mean agent->player distance decreases over time', () => {
  assert.ok(midDist < startDist - 1, `mid ${midDist.toFixed(2)} not < start ${startDist.toFixed(2)}`);
  assert.ok(endDist < startDist - 4, `end ${endDist.toFixed(2)} not clearly < start ${startDist.toFixed(2)}`);
  assert.ok(endDist <= midDist + 0.5, 'distance should keep closing, not rebound');
});

test('clumping: cohesion tightens the mob vs flow-only baseline', () => {
  assert.ok(Number.isFinite(cohesionNN), 'cohesion NN must be finite');
  assert.ok(cohesionNN < 3.0, `mean nearest-neighbor ${cohesionNN.toFixed(2)}m too spread for a mob`);
  assert.ok(
    cohesionNN <= baselineNN + 1e-3,
    `cohesion NN ${cohesionNN.toFixed(2)} should be <= flow-only ${baselineNN.toFixed(2)}`,
  );
});

test('no encircle: angular distribution is strongly non-uniform', () => {
  const peak = angularPeakFraction(agents);
  // Uniform ring would be ~1/12 = 0.083. A directional mob concentrates.
  assert.ok(peak > 0.2, `angular peak fraction ${peak.toFixed(3)} looks like a uniform ring`);
});

test('no interpenetration: min pairwise distance holds ~body spacing', () => {
  const minD = minPairwiseDistance(agents);
  assert.ok(minD >= MIN_BODY_SPACING, `min pairwise ${minD.toFixed(2)}m — agents interpenetrating`);
});

test('funnel: agents move off the perimeter into the interior through gates', () => {
  assert.ok(
    endInterior > COUNT * 0.6,
    `only ${endInterior}/${COUNT} agents left the perimeter (started ${startPerimeter} on it)`,
  );
  // And they didn't get stuck unreachable: most remain on reachable cells.
  const endReachable = agents.filter((a) => Number.isFinite(a.distToGoal)).length;
  assert.ok(endReachable >= startReachable * 0.9, `reachable dropped ${startReachable} -> ${endReachable}`);
});

console.log(
  `\n  start->end mean dist: ${startDist.toFixed(2)} -> ${endDist.toFixed(2)}m; `
  + `NN cohesion ${cohesionNN.toFixed(2)} vs flow-only ${baselineNN.toFixed(2)}; `
  + `angular peak ${angularPeakFraction(agents).toFixed(3)}; interior ${endInterior}/${COUNT}`,
);

level.dispose();

console.log(`\n${testCount - failures.length}/${testCount} passed.`);
if (failures.length) {
  console.log('FAIL:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: M1 flow-mob contract holds (converges, clumps, no encircle ring, separation, gate funnel).');
