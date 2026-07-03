// Headless Rapier harness that exercises the REAL BaseVehicle suspension +
// VehicleSystem/BaseVehicle update loop
// against a real Rapier ground, to diagnose "the car keeps bouncing on the ground."
//
// It isolates four candidate causes and reports a vertical-bounce metric for each:
//   (A) Baseline settle at 60fps, stationary — should come to rest, not bounce.
//   (B) dt ceiling 0.05 (a frame hitch) — does the stiff spring jitter when
//       under-sampled by a big timestep?
//   (C) Downforce at speed — does 0.06*v^2 saturate the suspension clamp
//       (maxForceScale 14) and exhaust travel (maxTravel 0.32), grounding the
//       cuboid so Rapier launches it back up -> bounce above ~24-27 m/s?
//   (D) Analytic-vs-physics ground mismatch must not affect an already-spawned
//       body. Runtime grounding belongs exclusively to Rapier.
//
// Run: node scripts/verify-vehicle-suspension.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

// Headless canvas stub so BaseVehicle.buildMesh's tyre/rim CanvasTextures don't
// throw under node (no DOM). Recursive proxy: any 2d-context method returns the
// proxy (chained gradient calls work) and `data` yields a pixel buffer.
const _ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : _ctx2d),
  apply: () => _ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => _ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

await RAPIER.init();

function makePhysics(world) {
  return {
    RAPIER,
    world,
    getFreshBody: (handle) => world.bodies.get(handle),
  };
}

// Flat ground: a big fixed cuboid whose TOP face sits at topY. Restitution 0 so the
// only vertical restoring force is the vehicle's own suspension (what we're testing).
function makeFlatGround(world, topY = 0, half = 60) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, topY - 2, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(half, 2, half).setFriction(0.55).setRestitution(0),
    body,
  );
  return topY;
}

async function makeVehicle({ physics, scene, analyticY, throttle = 0 }) {
  // Offset analytic ground from physics to simulate a query mismatch (case D).
  const level = { getGroundHeightAt: () => analyticY };
  const vehicle = new BaseVehicle({ position: new THREE.Vector3(0, analyticY, 0) });
  vehicle.chassisOverlayOptions = null; // GLB overlay: visual-only; a repeat failed load never settles under node
  // VehicleSystem.spawnVehicle snaps spawn Y to analytic ground + clearance first.
  vehicle.spawnPosition.y = analyticY + vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });
  const controls = makeNeutralControls();
  controls.throttle = throttle;
  return { vehicle, level, controls };
}

// One VehicleSystem per-frame tick: apply forces -> step.
function tick({ vehicle, level, physics, world, controls, dt, clampSpeed = null }) {
  void level;
  vehicle.update({ dt, controls, physics });
  const body = physics.getFreshBody(vehicle.bodyHandle);
  if (clampSpeed != null) {
    // Hold a steady forward speed (forward = -Z) to strip out acceleration dynamics
    // and isolate steady-state suspension behavior under downforce.
    const v = body.linvel();
    body.setLinvel({ x: 0, y: v.y, z: -clampSpeed }, true);
  }
  world.step();
  const b = physics.getFreshBody(vehicle.bodyHandle);
  const t = b.translation();
  const v = b.linvel();
  // Pitch about body X (nose up/down) from the rotation quaternion, 'YXZ'.
  _q.set(b.rotation().x, b.rotation().y, b.rotation().z, b.rotation().w);
  _e.setFromQuaternion(_q, 'YXZ');
  return {
    x: t.x, y: t.y, z: t.z, vy: v.y,
    speed: Math.hypot(v.x, 0, v.z),
    pitch: _e.x,
    grounded: vehicle.grounded,
  };
}

// Vertical-bounce metric over a sample window: peak-to-peak Y swing + count of
// vy sign changes (oscillation half-cycles). A settled chassis has ~0 swing and
// 0-1 sign changes; a bouncing one has large swing and many.
function bounceMetric(samples) {
  let signChanges = 0;
  let prevSign = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
    const sign = Math.sign(s.vy);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) signChanges += 1;
    if (sign !== 0) prevSign = sign;
  }
  return { swing: maxY - minY, signChanges, minY, maxY };
}

function report(label, samples, extra = '') {
  const m = bounceMetric(samples);
  const last = samples[samples.length - 1];
  console.log(
    `[${label}] swing=${m.swing.toFixed(3)}m osc=${m.signChanges} ` +
    `Y=[${m.minY.toFixed(2)},${m.maxY.toFixed(2)}] ` +
    `end(y=${last.y.toFixed(2)} vy=${last.vy.toFixed(2)} spd=${last.speed.toFixed(1)})` +
    (extra ? `  ${extra}` : ''),
  );
  return { ...m, last };
}

// ---------------------------------------------------------------------------
// (A) + (B) Stationary settle at 60fps and at the dt ceiling.
// ---------------------------------------------------------------------------
async function stationary({ dt, label }) {
  const world = new RAPIER.World(GRAVITY);
  world.numSolverIterations = 8;
  makeFlatGround(world, 0, 60);
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  const { vehicle, level, controls } = await makeVehicle({ physics, scene, analyticY: 0 });

  const samples = [];
  for (let i = 0; i < 240; i += 1) samples.push(tick({ vehicle, level, physics, world, controls, dt }));
  // Measure over the tail (after it should have settled).
  return report(label, samples.slice(-120));
}

// ---------------------------------------------------------------------------
// (C) Driving at full throttle: watch vertical bounce vs forward speed.
//     Downforce = 0.06*v^2 should saturate the suspension clamp (14) ~ v>=27.
// ---------------------------------------------------------------------------
async function driving({ dt, label }) {
  const world = new RAPIER.World(GRAVITY);
  world.numSolverIterations = 8;
  makeFlatGround(world, 0, 400); // big enough to stay on through top speed
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  const { vehicle, level, controls } = await makeVehicle({ physics, scene, analyticY: 0, throttle: 1 });

  const samples = [];
  // Sample windows by speed bucket so we can see WHERE the bounce starts.
  const buckets = { '<15': [], '15-22': [], '22-27': [], '>27': [] };
  for (let i = 0; i < 360; i += 1) {
    const s = tick({ vehicle, level, physics, world, controls, dt });
    samples.push(s);
    const sp = s.speed;
    const b = sp < 15 ? '<15' : sp < 22 ? '15-22' : sp < 27 ? '22-27' : '>27';
    buckets[b].push(s);
  }
  console.log(`[${label}] full-throttle drive, vertical bounce by speed bucket:`);
  for (const key of ['<15', '15-22', '22-27', '>27']) {
    if (buckets[key].length) report(`  spd ${key}`, buckets[key]);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// (E) Driving over a BUMPY Rapier heightfield (like real terrain: ~1m vertex
//     spacing, ~1.5m amplitude). The chassis cuboid floats only ~0.38m above the
//     surface at rest and the suspension (~1.9Hz) can't track 1m vertices at
//     speed, so terrain peaks may clip the cuboid -> collision impulse -> bounce.
// ---------------------------------------------------------------------------
function makeBumpyHeightfield(world, { cells = 96, span = 96, amplitude = 1.5 } = {}) {
  // Rapier wants (nrows+1)*(ncols+1) samples; nrows/ncols are SEGMENT counts.
  // Match PhysicsSystem.createTerrainHeightfield exactly (resolution=cells,
  // nrows=ncols=cells-1, column-major, Vector3 scale, FIX_INTERNAL_EDGES).
  const nrows = cells - 1;
  const ncols = cells - 1;
  const rowMajor = new Float32Array(cells * cells);
  const step = span / (cells - 1);
  const sampleH = (x, z) =>
    amplitude * (0.6 * Math.sin(x * 0.9) * Math.cos(z * 0.8) +
                 0.4 * Math.sin(x * 0.4 + 1.3) * Math.cos(z * 0.5 + 0.7));
  for (let j = 0; j < cells; j += 1) {
    for (let i = 0; i < cells; i += 1) {
      const x = -span * 0.5 + i * step;
      const z = -span * 0.5 + j * step;
      rowMajor[j * cells + i] = sampleH(x, z);
    }
  }
  // Transpose to column-major (Rapier convention: heights[i*cells + j]).
  const heights = new Float32Array(cells * cells);
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      heights[i * cells + j] = rowMajor[j * cells + i];
    }
  }
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  let flags = 0;
  if (RAPIER.HeightFieldFlags?.FIX_INTERNAL_EDGES != null) {
    flags = RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES;
  }
  const desc = RAPIER.ColliderDesc.heightfield(
    nrows,
    ncols,
    heights,
    new RAPIER.Vector3(span, 1, span),
    flags,
  )
    .setFriction(0.85)
    .setRestitution(0)
    .setContactSkin(0.012);
  world.createCollider(desc, body);
  // Analytic ground mirrors the heightfield exactly -> NO analytic/physics
  // mismatch here; any bounce is purely terrain-vs-cuboid/suspension.
  return { sampleH };
}

async function bumpyDrive({ dt, label, config = {}, amplitude = 1.5, throttle = 1 }) {
  const world = new RAPIER.World(GRAVITY);
  world.numSolverIterations = 8;
  const { sampleH } = makeBumpyHeightfield(world, { amplitude });
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  // Analytic = exact heightfield sample at the body center (no mismatch).
  const level = { getGroundHeightAt: (pos) => sampleH(pos.x, pos.z) };
  const surfaceY = sampleH(0, 0);
  const vehicle = new BaseVehicle({ position: new THREE.Vector3(0, surfaceY, 0), config });
  vehicle.chassisOverlayOptions = null;
  // Spawn AT the surface + clearance (no drop-in artifact) so we measure driving
  // bounce, not the fall from a high spawn.
  vehicle.spawnPosition.y = surfaceY + vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });
  const controls = makeNeutralControls();
  controls.throttle = throttle;

  const samples = [];
  const buckets = { '<5': [], '5-8': [], '>8': [] };
  let maxSpeed = 0;
  for (let i = 0; i < 420; i += 1) {
    const s = tick({ vehicle, level, physics, world, controls, dt });
    samples.push(s);
    if (s.speed > maxSpeed) maxSpeed = s.speed;
    const b = s.speed < 5 ? '<5' : s.speed < 8 ? '5-8' : '>8';
    buckets[b].push(s);
  }
  // Bounce discriminator: gap = bodyY - terrainYUnderCar. A smooth-following
  // chassis holds a near-constant gap (~ride height ~0.83-0.92); a bouncing one's
  // gap swings wildly (launches above the surface or dips into it). Raw body-Y
  // swing is misleading — it legitimately includes rising/falling with the
  // hills. Airborne fraction catches launch-off-peaks a small gap swing can hide.
  let gapMin = Infinity, gapMax = -Infinity, gapSumSq = 0, airborne = 0;
  for (const s of samples) {
    const terrainY = sampleH(s.x, s.z);
    const gap = s.y - terrainY;
    if (gap < gapMin) gapMin = gap;
    if (gap > gapMax) gapMax = gap;
    gapSumSq += gap * gap;
    if (!s.grounded) airborne += 1;
  }
  const gapRms = Math.sqrt(gapSumSq / samples.length);
  const gapSwing = gapMax - gapMin;
  const airborneFrac = airborne / samples.length;
  const dist = Math.abs(samples[samples.length - 1].z - samples[0].z);

  const susp = vehicle.config.ground.suspension;
  const zeta = (susp.damping / Math.sqrt(susp.stiffness)).toFixed(2);
  console.log(
    `[${label}] amp=${amplitude} (zeta~${zeta})  ` +
    `maxSpeed=${maxSpeed.toFixed(1)} dist=${dist.toFixed(0)}m  |  ` +
    `BOUNCE: gapSwing=${gapSwing.toFixed(3)}m gapRms=${gapRms.toFixed(2)} ` +
    `airborne=${(airborneFrac * 100).toFixed(0)}%`,
  );
  return { buckets, maxSpeed, gapSwing, gapRms, airborneFrac, dist };
}

// ---------------------------------------------------------------------------
// (D) Analytic ground ABOVE the physics surface: after spawn, the analytic query
//     must never reposition the body or fight Rapier's physical contact surface.
// ---------------------------------------------------------------------------
async function mismatch({ dt, analyticOffset, label }) {
  const world = new RAPIER.World(GRAVITY);
  world.numSolverIterations = 8;
  makeFlatGround(world, 0, 60);
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  const { vehicle, level, controls } = await makeVehicle({ physics, scene, analyticY: analyticOffset });

  const samples = [];
  for (let i = 0; i < 240; i += 1) samples.push(tick({ vehicle, level, physics, world, controls, dt }));
  return report(label, samples.slice(-120), `(analytic is ${analyticOffset}m above physics ground)`);
}

console.log('--- vehicle suspension bounce diagnostic ---\n');
const a = await stationary({ dt: 1 / 60, label: 'A 60fps stationary' });
const b = await stationary({ dt: 0.05, label: 'B dt-ceiling stationary' });
console.log();
await driving({ dt: 1 / 60, label: 'C 60fps driving (flat)' });
console.log();

// (F) WHY does the car bob on FLAT ground while driving? Isolate the cause.
//   F1 steady speed (velocity clamped, no throttle) — pure steady-state: if this
//      bobs, downforce / suspension ringing is to blame.
//   F2 same with downforce OFF — if F1 bob disappears, downforce is the cause.
//   F3 full throttle (accelerating) — adds weight-transfer pitch + speed ramp.
async function flatBob({ label, config = {}, throttle = 0, clampSpeed = null, steps = 240 }) {
  const world = new RAPIER.World(GRAVITY);
  world.numSolverIterations = 8;
  makeFlatGround(world, 0, 400);
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  const level = { getGroundHeightAt: () => 0 };
  const vehicle = new BaseVehicle({ position: new THREE.Vector3(0, 0, 0), config });
  vehicle.chassisOverlayOptions = null;
  vehicle.spawnPosition.y = vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });
  const controls = makeNeutralControls();
  controls.throttle = throttle;

  const samples = [];
  for (let i = 0; i < steps; i += 1) {
    samples.push(tick({ vehicle, level, physics, world, controls, dt: 1 / 60, clampSpeed }));
  }
  // Report vertical + pitch swing, and a downsampled time series so the shape is visible.
  let yMin = Infinity, yMax = -Infinity, pMin = Infinity, pMax = -Infinity;
  for (const s of samples) {
    if (s.y < yMin) yMin = s.y; if (s.y > yMax) yMax = s.y;
    if (s.pitch < pMin) pMin = s.pitch; if (s.pitch > pMax) pMax = s.pitch;
  }
  const end = samples[samples.length - 1];
  const ts = samples.filter((_, i) => i % 20 === 0)
    .map((s) => `y=${s.y.toFixed(2)}`).join(' ');
  console.log(
    `[${label}] ySwing=${(yMax - yMin).toFixed(3)}m pitchSwing=${THREE.MathUtils.radToDeg(pMax - pMin).toFixed(2)}deg ` +
    `end(y=${end.y.toFixed(2)} vy=${end.vy.toFixed(2)} spd=${end.speed.toFixed(1)})`,
  );
  console.log(`    y every 20 frames: ${ts}`);
  return { ySwing: yMax - yMin, pitchSwing: pMax - pMin };
}

console.log('--- flat-ground driving bob diagnosis ---');
const flatSteady = await flatBob({ label: 'F1 steady 8m/s', clampSpeed: 8 });
await flatBob({ label: 'F2 steady 8m/s NO downforce', config: { ground: { downforce: 0 } }, clampSpeed: 8 });
const flatThrottle = await flatBob({ label: 'F3 full throttle', throttle: 1 });
await flatBob({ label: 'F4 full throttle NO downforce', config: { ground: { downforce: 0 } }, throttle: 1 });
console.log();

// (F-top) Flat-ground TOP SPEED: wheels ON vs OFF. Confirms the friction-0 wheel
//     colliders don't cap speed on flat ground (no sliding-drag pathology) — any
//     off-road slowdown is then just the cost of physically climbing bumps.
async function flatTopSpeed({ label, config = {} }) {
  const world = new RAPIER.World(GRAVITY);
  world.numSolverIterations = 8;
  makeFlatGround(world, 0, 800);
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  const level = { getGroundHeightAt: () => 0 };
  const vehicle = new BaseVehicle({ position: new THREE.Vector3(0, 0, 0), config });
  vehicle.chassisOverlayOptions = null;
  vehicle.spawnPosition.y = vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });
  const controls = makeNeutralControls();
  controls.throttle = 1;
  let maxSpeed = 0;
  for (let i = 0; i < 900; i += 1) { // 15s — long enough to approach the cap
    const s = tick({ vehicle, level, physics, world, controls, dt: 1 / 60 });
    if (s.speed > maxSpeed) maxSpeed = s.speed;
  }
  console.log(`[${label}] flat full-throttle top speed over 15s: ${maxSpeed.toFixed(1)} m/s`);
  return maxSpeed;
}
console.log('--- flat top-speed A/B (drag pathology check) ---');
const topOff = await flatTopSpeed({ label: 'TOP wheels OFF', config: { ground: { wheelColliders: false } } });
const topOn = await flatTopSpeed({ label: 'TOP wheels ON', config: {} });
console.log(`    => ON/OFF = ${(topOn / topOff).toFixed(2)}x  (1.0 = no drag penalty)\n`);

// (G) Terrain-roughness sweep with raised clearance: at what amplitude does the box
//     stop catching? Calibrates how much the physics terrain must be smoothed.
console.log('--- terrain amplitude sweep (raised clearance, fric 0.2) ---');
for (const amp of [0.25, 0.5, 0.75, 1.0]) {
  await bumpyDrive({
    dt: 1 / 60,
    label: `G amp=${amp}`,
    amplitude: amp,
    config: { body: { friction: 0.2 }, ground: { suspension: { restLength: 0.7, maxTravel: 0.4 } } },
  });
}
console.log();

// (H) VARIABLE dt. The real game steps with a clamped-but-variable dt (hitches to
//     0.05). A stiff spring (ω_n ~11.7) under variable dt is a classic jitter
//     source a fixed-dt harness misses. Steady speed on FLAT ground, hitching dt.
async function variableDtFlat({ label, config = {} }) {
  const world = new RAPIER.World(GRAVITY);
  world.numSolverIterations = 8;
  makeFlatGround(world, 0, 400);
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  const level = { getGroundHeightAt: () => 0 };
  const vehicle = new BaseVehicle({ position: new THREE.Vector3(0, 0, 0), config });
  vehicle.chassisOverlayOptions = null;
  vehicle.spawnPosition.y = vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });
  const controls = makeNeutralControls();
  controls.throttle = 0;

  // Simulate frame hitches: mostly 1/60 with periodic spikes to 0.05.
  const dtPattern = [1 / 60, 1 / 60, 1 / 60, 0.05, 1 / 60, 1 / 30, 1 / 60, 1 / 60, 0.04, 1 / 60];
  const samples = [];
  for (let i = 0; i < 300; i += 1) {
    samples.push(tick({ vehicle, level, physics, world, controls, dt: dtPattern[i % dtPattern.length], clampSpeed: 8 }));
  }
  let yMin = Infinity, yMax = -Infinity, vyMax = 0;
  for (const s of samples) {
    if (s.y < yMin) yMin = s.y; if (s.y > yMax) yMax = s.y;
    if (Math.abs(s.vy) > vyMax) vyMax = Math.abs(s.vy);
  }
  console.log(
    `[${label}] VARIABLE dt steady 8m/s flat: ySwing=${(yMax - yMin).toFixed(4)}m max|vy|=${vyMax.toFixed(3)}`,
  );
}
console.log('--- variable-dt jitter test (flat, steady 8m/s) ---');
await variableDtFlat({ label: 'H current' });
await variableDtFlat({ label: 'H softer k=16', config: { ground: { suspension: { stiffness: 16, damping: 3.2 } } } });
console.log();

// (E) Wheel-collider bounce A/B — LEGACY model only (useRayCastController:false).
//     The TRUE bounce metric is gapSwing (bodyY - terrainYUnderCar) + airborne
//     fraction, NOT raw body-Y swing (which legitimately includes rising/falling
//     with the hills). In the legacy model the flat chassis box launches off
//     terrain peaks (a normal impulse, not friction); round wheel colliders roll
//     over the same peaks without launching. The default model is now the raycast
//     controller (no rigid wheels at all — no launch by construction), so this A/B
//     only makes sense pinned to the legacy path.
console.log('--- wheel-collider bounce A/B (box-only vs wheels, LEGACY) ---');
const abResults = {};
for (const amp of [0.5, 1.0]) {
  const off = await bumpyDrive({ dt: 1 / 60, label: `amp=${amp} BOX-only`, config: { ground: { useRayCastController: false, wheelColliders: false } }, amplitude: amp });
  const on = await bumpyDrive({ dt: 1 / 60, label: `amp=${amp} WHEELS`, config: { ground: { useRayCastController: false } }, amplitude: amp });
  abResults[amp] = { off, on };
  console.log(
    `    amp=${amp}  BOX: gapSwing=${off.gapSwing.toFixed(2)} air=${(off.airborneFrac * 100).toFixed(0)}% spd=${off.maxSpeed.toFixed(1)}  |  ` +
    `WHEELS: gapSwing=${on.gapSwing.toFixed(2)} air=${(on.airborneFrac * 100).toFixed(0)}% spd=${on.maxSpeed.toFixed(1)}`,
  );
}
const parkedRough = await bumpyDrive({
  dt: 1 / 60,
  label: 'amp=0.5 PARKED',
  amplitude: 0.5,
  throttle: 0,
});
console.log();
const d0 = await mismatch({ dt: 1 / 60, analyticOffset: 0, label: 'D offset=0 (control)' });
const d8 = await mismatch({ dt: 1 / 60, analyticOffset: 0.8, label: 'D offset=0.8 (clamp mismatch)' });

console.log('\n--- assertions ---');
// Baseline: a stationary car at 60fps MUST settle (this is the regression guard).
assert.ok(a.swing < 0.05,
  `(A) stationary car did not settle at 60fps: swing ${a.swing.toFixed(3)}m`);
assert.ok(a.signChanges <= 2,
  `(A) stationary car is oscillating at 60fps: ${a.signChanges} vy sign changes`);
console.log('baseline settle (A): PASS');

assert.ok(d0.swing < 0.05 && d8.swing < 0.05,
  `(D) analytic ground mismatch affected runtime physics: control=${d0.swing.toFixed(3)} mismatch=${d8.swing.toFixed(3)}`);
assert.ok(Math.abs(d0.last.y - d8.last.y) < 0.02,
  `(D) mismatched analytic query changed settled height: ${d0.last.y.toFixed(3)} vs ${d8.last.y.toFixed(3)}`);
console.log('runtime analytic/physics isolation (D): PASS');

// Flat-ground smoothness. The default ground model is now the Rapier raycast
// vehicle controller (raycast wheels + integrated suspension, no rigid wheel
// colliders). Steady cruising must be near-flat (a true ringing regression would
// blow past this); hard acceleration to ~40 m/s shows realistic weight-transfer
// pitch/squat, so the accel ceilings are looser than the steady one. (The legacy
// weight-bearing-spring model's tighter ~1.2deg ceiling was specific to that
// model; the controller's ~1.4deg under full throttle is expected and fine.)
assert.ok(flatSteady.ySwing < 0.07,
  `(F) steady flat driving bounces too much: ${flatSteady.ySwing.toFixed(3)}m swing`);
assert.ok(flatThrottle.ySwing < 0.14,
  `(F) accelerating on flat ground bounces too much: ${flatThrottle.ySwing.toFixed(3)}m swing`);
// Launch squat: full-throttle 0→150 mph with the raycast controller's strong engine
// transfers weight to the rear and pitches ~2deg (a realistic muscle-car launch; the
// steady ride above is flat at ~3 cm). Ceiling is set to allow that while still
// catching a true ringing/instability regression (which blows well past this).
assert.ok(THREE.MathUtils.radToDeg(flatThrottle.pitchSwing) < 2.3,
  `(F) accelerating on flat ground pitches too much: ${THREE.MathUtils.radToDeg(flatThrottle.pitchSwing).toFixed(2)}deg`);
console.log('flat driving smoothness (F): PASS');

assert.ok(parkedRough.dist < 0.5,
  `(P) parked vehicle crept ${parkedRough.dist.toFixed(2)}m on rough ground`);
assert.ok(parkedRough.maxSpeed < 1,
  `(P) parked vehicle kept rocking/sliding at ${parkedRough.maxSpeed.toFixed(2)}m/s`);
console.log('rough-ground parked stability (P): PASS');

// Wheel colliders still REDUCE the terrain-launch bounce vs a bare box, but no
// longer ELIMINATE it: the recessed balls are now hard-stops and the spring (not a
// rigid round ball) is the primary contact, so the car can launch off sharp peaks
// on rough terrain. This is a DELIBERATE trade for visible per-wheel suspension
// travel (the spring must carry the car for the wheels to move independently). The
// old <2% airborne guarantee no longer holds; we only require the recessed balls to
// still beat box-only contact. To restore launch elimination, give up the visible
// travel (raise wheelColliderRadius back to wheelRadius so the balls carry the car).
// The chassis collider is now a roundCuboid (rounded edges deflect over peaks
// instead of catching them), so box-only contact can match the wheels at 0%
// airborne — require wheels to be no WORSE, not strictly better.
assert.ok(abResults[0.5].on.airborneFrac <= abResults[0.5].off.airborneFrac,
  `(E) wheel colliders made launch worse: on ${(abResults[0.5].on.airborneFrac * 100).toFixed(0)}% vs off ${(abResults[0.5].off.airborneFrac * 100).toFixed(0)}%`);
console.log(`wheel-collider launch reduction (E): box ${(abResults[0.5].off.airborneFrac * 100).toFixed(0)}% -> wheels ${(abResults[0.5].on.airborneFrac * 100).toFixed(0)}% airborne (spring-carry trade)  PASS`);

// And they must not introduce bounce on flat ground (the "everywhere, even flat"
// case): a steady-speed flat drive stays grounded and smooth.
assert.ok(topOn >= topOff * 0.8,
  `(F-top) wheel colliders crippled flat top speed: on ${topOn.toFixed(1)} vs off ${topOff.toFixed(1)}`);
console.log(`flat top-speed preserved (F-top): on/off = ${(topOn / topOff).toFixed(2)}x  PASS`);
