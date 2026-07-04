// Regression for the rally dirt-dust rooster tail (TireEffects.DirtDustSystem).
//
// Guards the render path: CPU-simulated particle pool rendered as camera-facing
// billboards via an InstancedMesh whose per-instance matrix (position + camera
// rotation + age-grown scale) and per-instance color (baked brown→tan→pale
// ramp) are rewritten every frame through the InstancedMesh's own
// instanceMatrix + instanceColor (DynamicDrawUsage). This is the proven WebGPU
// dynamic-instancing path (createInfiniteCityLevel.js). An earlier pass used
// TSL storage() buffers rewritten from the CPU; under WebGPU those are meant
// for compute-shader writes and did not re-upload, so the GPU read the initial
// dead-state and nothing rendered — this asserts the live data now reaches the
// instance streams.
//
// Also guards the behavioural contract: emits on dirt/offroad, fully dies on
// asphalt, drift biases the plume sideways, and rear-wheel emission alternates.
//
// Run: node scripts/verify-rally-dust.mjs  (npm run verify:rally-dust)

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sanitizeWebGPUVertexBuffers } from '../src/game/geometry/prepareWebGPUGeometry.js';
import { createVehicleConfig } from '../src/game/config/vehicleConfig.js';
import { DirtDustSystem, MudLiquidSpraySystem } from '../src/game/vehicles/TireEffects.js';

let passed = 0;
const ok = (message) => { passed += 1; console.log(`  ✓ ${message}`); };

// Minimal stub vehicle: just the slices DirtDustSystem.update/_emit read. Rear
// axle is +Z (wheelAnchors[2,3].z > 0); identity orientation so _forward is +Z
// (backward) and _side is +X (car's right).
function makeVehicle({ rearSlip = 0.4 } = {}) {
  return {
    config: createVehicleConfig(),
    groundedFraction: 1,
    group: { quaternion: new THREE.Quaternion() },
    wheelAnchors: [
      new THREE.Vector3(-1, 0, -1),
      new THREE.Vector3(1, 0, -1),
      new THREE.Vector3(-1, 0, 1),
      new THREE.Vector3(1, 0, 1),
    ],
    wheelTelemetry: [
      { inContact: true, contactPoint: new THREE.Vector3(-1, 0, -1), slipRatio: 0, angularVelocity: 45 },
      { inContact: true, contactPoint: new THREE.Vector3(1, 0, -1), slipRatio: 0, angularVelocity: 45 },
      { inContact: true, contactPoint: new THREE.Vector3(-1, 0, 1.05), slipRatio: rearSlip, angularVelocity: 52 },
      { inContact: true, contactPoint: new THREE.Vector3(1, 0, 1.05), slipRatio: rearSlip, angularVelocity: 52 },
    ],
    linearVelocity: new THREE.Vector3(0, 0, -18),
  };
}

const DT = 1 / 60;

// Translation (x,y,z) baked into instance i's matrix — nonzero for live puffs,
// (0,0,0) for collapsed (dead) ones. This is the data the GPU actually sees.
function instanceTranslation(dust, i) {
  const a = dust.mesh.instanceMatrix.array;
  const o = i * 16;
  return [a[o + 12], a[o + 13], a[o + 14]];
}

// --- structural / WebGPU-safety checks -------------------------------------
{
  const group = new THREE.Group();
  const vehicle = makeVehicle();
  const dust = new DirtDustSystem(group, vehicle);
  const poolSize = vehicle.config.ground.dust.poolSize;

  assert.ok(dust.mesh instanceof THREE.InstancedMesh, 'dust renders as an InstancedMesh');
  assert.equal(dust.mesh.count, poolSize, 'mesh.count is the full pool, fixed from frame 1');
  assert.equal(dust.mesh.frustumCulled, false, 'dust is never frustum-culled');

  const mat = dust.mesh.material;
  assert.ok(mat.isMeshBasicMaterial, 'uses a plain MeshBasicMaterial (no TSL/storage)');
  assert.equal(mat.transparent, true);
  assert.equal(mat.depthWrite, false);
  assert.equal(mat.side, THREE.DoubleSide);
  assert.equal(mat.toneMapped, false);

  // Per-instance streams: right capacity, DynamicDrawUsage so the per-frame
  // rewrite reaches the GPU under WebGPU.
  assert.equal(dust.mesh.instanceMatrix.array.byteLength, poolSize * 16 * 4);
  assert.equal(dust.mesh.instanceColor.array.byteLength, poolSize * 3 * 4);
  assert.equal(dust.mesh.instanceMatrix.usage, THREE.DynamicDrawUsage);
  assert.equal(dust.mesh.instanceColor.usage, THREE.DynamicDrawUsage);

  // Every instance starts collapsed (scale 0) — invisible until emitted.
  for (let i = 0; i < poolSize; i += 1) {
    const [, y] = instanceTranslation(dust, i);
    assert.equal(y, 0, `instance ${i} starts collapsed`);
  }

  // The sanitizer must NOT strip a positive-capacity InstancedMesh.
  const result = sanitizeWebGPUVertexBuffers(group, { warn: () => {} });
  assert.deepEqual(result.removed, [], 'positive-capacity dust mesh is not stripped');
  assert.equal(dust.mesh.parent, group, 'dust mesh stays parented after sanitization');

  dust.dispose();
  assert.equal(dust.mesh.parent, null, 'dispose removes the mesh from its parent');
  ok('InstancedMesh + MeshBasicMaterial + dynamic instanceMatrix/instanceColor are WebGPU-safe');
}

// --- emits on dirt, fully dies on asphalt ----------------------------------
{
  const group = new THREE.Group();
  const dust = new DirtDustSystem(group, makeVehicle());
  const vehicle = makeVehicle();
  const cam = { quaternion: new THREE.Quaternion() };

  for (let i = 0; i < 60; i += 1) {
    dust.update({ dt: DT, surface: 'dirt', speed: 30, intensity: 1, vehicle, camera: cam });
  }
  const live = dust.snapshot();
  assert.ok(live.activeParticles > 0, 'dust is emitting on dirt at speed');
  assert.ok(live.opacityMax > 0, 'active dust puffs have positive opacity');

  // Live data must reach instanceMatrix: at least one active instance has a
  // nonzero (above-ground) translation matching its simulated particle.
  let liveInstances = 0;
  for (let i = 0; i < dust.max; i += 1) {
    if (dust.particles[i].life > 0) {
      const [tx, ty, tz] = instanceTranslation(dust, i);
      const p = dust.particles[i];
      if (Math.abs(tx - p.x) < 0.01 && Math.abs(ty - p.y) < 0.01 && Math.abs(tz - p.z) < 0.01) {
        liveInstances += 1;
      }
    }
  }
  assert.ok(liveInstances > 0, 'active particles write live positions into instanceMatrix');
  ok(`dirt plume is alive and GPU-bound (${live.activeParticles}/${live.poolSize}, ${liveInstances} live matrices)`);

  // Long enough that even a max-life (2.05s) particle emitted on the last dirt
  // frame has died (60 dirt frames = 1s; 150 asphalt frames = 2.5s → t=3.5s).
  for (let i = 0; i < 150; i += 1) {
    dust.update({ dt: DT, surface: 'asphalt', speed: 30, intensity: 1, vehicle, camera: cam });
  }
  const dead = dust.snapshot();
  assert.equal(dead.activeParticles, 0, 'no dust on asphalt');
  for (let i = 0; i < dust.max; i += 1) {
    const [, y] = instanceTranslation(dust, i);
    assert.equal(y, 0, `instance ${i} collapsed after death`);
  }
  ok('plume fully dies off on asphalt (surface gate + collapse to scale 0)');

  dust.dispose();
}

// --- drift fans the plume sideways -----------------------------------------
{
  const run = (lateralSpeed) => {
    const dust = new DirtDustSystem(new THREE.Group(), makeVehicle());
    const vehicle = makeVehicle();
    const cam = { quaternion: new THREE.Quaternion() };
    // Pin rear contacts to x=0 so the car's track width (±1m) doesn't dominate
    // the measurement — we're probing the drift fan, not the wheel positions.
    vehicle.wheelTelemetry[2].contactPoint.x = 0;
    vehicle.wheelTelemetry[3].contactPoint.x = 0;
    for (let i = 0; i < 250; i += 1) {
      dust.update({
        dt: DT, surface: 'dirt', speed: 30, intensity: 0.6, vehicle,
        lateralSpeed, lateralSign: 1, camera: cam,
      });
    }
    const xs = [];
    for (let i = 0; i < dust.max; i += 1) {
      if (dust.particles[i].life > 0) xs.push(dust.particles[i].x);
    }
    dust.dispose();
    return xs;
  };

  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const stddev = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };

  const xs0 = run(0);
  const xsDrift = run(12);
  assert.ok(xsDrift.length > 8, 'drift run produced active particles');

  const mean0 = mean(xs0);
  const meanDrift = mean(xsDrift);
  assert.ok(
    Math.abs(mean0) < 0.4,
    `no-drift plume is centered (mean x ${mean0.toFixed(2)})`,
  );
  assert.ok(
    meanDrift > 0.5,
    `drift plume biases along the slide (mean x ${meanDrift.toFixed(2)})`,
  );
  assert.ok(
    stddev(xsDrift) > stddev(xs0),
    'drift widens the plume (wider cone when sliding)',
  );
  ok(`drift fans the plume sideways (centered @0 vs mean ${meanDrift.toFixed(2)}m, wider spread @lateralSpeed 12)`);
}

// --- mud profile: darker, heavier, shorter-lived clods ---------------------
// (docs/rally-mud-tread-plan.md §8 / M4). The DirtDustSystem swaps to the mud
// config on `surface: 'mud'` — same pool/emit path, different look.
{
  const dust = new DirtDustSystem(new THREE.Group(), makeVehicle());
  const vehicle = makeVehicle();
  const cam = { quaternion: new THREE.Quaternion() };
  const base = dust.baseCfg;

  assert.ok(dust.mudCfg, 'a mud dust profile is configured');
  assert.ok(dust.mudCfg.color.fresh[0] < base.color.fresh[0], 'mud clods are darker than dirt dust');
  assert.ok(dust.mudCfg.life.max < base.life.max, 'mud clods are shorter-lived');
  assert.ok(dust.mudCfg.gravity > base.gravity && dust.mudCfg.buoyancy < base.buoyancy,
    'mud clods are heavier (more gravity, less buoyancy → ballistic, not billowing)');

  for (let i = 0; i < 60; i += 1) {
    dust.update({ dt: DT, surface: 'mud', speed: 24, intensity: 1, vehicle, camera: cam });
  }
  assert.equal(dust.cfg, dust.mudCfg, 'on mud, the system runs the mud profile');
  const live = dust.snapshot();
  assert.ok(live.activeParticles > 0, 'mud emits spray (loose-surface gate includes mud)');
  // Every live particle's maxLife falls in the (shorter) mud life band.
  for (let i = 0; i < dust.max; i += 1) {
    const p = dust.particles[i];
    if (p.life > 0) {
      assert.ok(p.maxLife <= dust.mudCfg.life.max + 1e-6, 'live clod uses the mud life band');
    }
  }

  // Back on dirt, it swaps back to the base profile.
  dust.update({ dt: DT, surface: 'dirt', speed: 24, intensity: 1, vehicle, camera: cam });
  assert.equal(dust.cfg, dust.baseCfg, 'off mud, the system restores the dirt profile');
  dust.dispose();
  ok(`mud swaps to darker/heavier/shorter clods (${live.activeParticles} active) and reverts on dirt`);
}

// --- acceleration mud spray: all wheels + wheel-tangential throw ----------
{
  const vehicle = makeVehicle({ rearSlip: 0.8 });
  const spray = new MudLiquidSpraySystem(new THREE.Group(), vehicle);
  const cam = { quaternion: new THREE.Quaternion() };

  for (let i = 0; i < 90; i += 1) {
    spray.update({ dt: DT, surface: 'mud', speed: 18, throttle: 1, vehicle, camera: cam });
  }
  const snapshot = spray.snapshot();
  assert.ok(snapshot.activeParticles > 0, 'liquid mud spray is active under acceleration');
  assert.ok(snapshot.emittedByWheel.every((count) => count > 0),
    `acceleration emits from all four wheel contacts (${snapshot.emittedByWheel.join(', ')})`);
  assert.ok(spray.particles.some((particle) => particle.sheet && particle.width > spray.cfg.size.widthMax),
    'liquid layer includes broad translucent splash sheets among the fine streaks');
  assert.ok(snapshot.fragmentsSpawned > 0, 'cohesive sheets break into inherited-momentum droplets');

  const frontLeft = { wheel: vehicle.wheelTelemetry[0], wheelIndex: 0, anchor: vehicle.wheelAnchors[0] };
  const meanThrow = (angularVelocity) => {
    const throws = [];
    frontLeft.wheel.angularVelocity = angularVelocity;
    for (let i = 0; i < 32; i += 1) {
      spray._emit(frontLeft, vehicle, 4, 1);
      const particle = spray.particles[(spray.cursor - 1 + spray.max) % spray.max];
      throws.push(Math.hypot(particle.vx, particle.vz));
    }
    return throws.reduce((sum, value) => sum + value, 0) / throws.length;
  };
  const slowThrow = meanThrow(5);
  const fastThrow = meanThrow(80);
  assert.ok(fastThrow > slowThrow + 2,
    `higher wheel angular speed produces stronger tangential rearward throw (${fastThrow.toFixed(2)} > ${slowThrow.toFixed(2)})`);

  frontLeft.wheel.angularVelocity = 80;
  spray._emit(frontLeft, vehicle, 4, 1);
  const fast = spray.particles[(spray.cursor - 1 + spray.max) % spray.max];
  assert.ok(fast.vx < 0, 'left-front spray fires outward, away from the lower body/fender');
  const frontYaws = [];
  const frontElevations = [];
  for (let i = 0; i < 32; i += 1) {
    spray._emit(frontLeft, vehicle, 4, 1);
    const particle = spray.particles[(spray.cursor - 1 + spray.max) % spray.max];
    const throwSpeed = Math.hypot(particle.vx, particle.vz);
    frontYaws.push(THREE.MathUtils.radToDeg(Math.atan2(Math.abs(particle.vx), particle.vz)));
    frontElevations.push(THREE.MathUtils.radToDeg(Math.atan2(particle.vy, throwSpeed)));
  }
  const frontYawMean = frontYaws.reduce((sum, yaw) => sum + yaw, 0) / frontYaws.length;
  const frontElevationMean = frontElevations.reduce((sum, el) => sum + el, 0) / frontElevations.length;
  assert.ok(frontYawMean > 30 && frontYawMean < 58,
    `front spray is approximately 45° back/out (${frontYawMean.toFixed(1)}° mean)`);
  assert.ok(frontElevationMean < 16,
    `front spray stays mostly flat to the ground (${frontElevationMean.toFixed(1)}° mean)`);
  assert.ok(fast.floorY >= 0.3 && fast.y > fast.floorY + 0.05,
    'spray is born above the raised visual mud deck, not inside the physics contact plane');

  const rearLeft = { wheel: vehicle.wheelTelemetry[2], wheelIndex: 2, anchor: vehicle.wheelAnchors[2] };
  rearLeft.wheel.angularVelocity = 80;
  const rearYaws = [];
  for (let i = 0; i < 48; i += 1) {
    spray._emit(rearLeft, vehicle, 4, 1);
    const rear = spray.particles[(spray.cursor - 1 + spray.max) % spray.max];
    rearYaws.push(THREE.MathUtils.radToDeg(Math.atan2(Math.abs(rear.vx), rear.vz)));
  }
  const rearYawSpread = Math.max(...rearYaws) - Math.min(...rearYaws);
  const rearYawMean = rearYaws.reduce((sum, yaw) => sum + yaw, 0) / rearYaws.length;
  assert.ok(rearYawSpread > 10,
    `rear spray fans out across particles (${rearYawSpread.toFixed(1)}° spread)`);
  assert.ok(rearYawMean < 28,
    `rear spray mean stays broadly backward (${rearYawMean.toFixed(1)}° mean)`);
  spray.dispose();
  ok('mud acceleration sprays liquid from every wheel with angular-speed-driven throw');
}

// --- speed response: more droplets, but finer and shorter-lived ------------
{
  const run = (speed) => {
    const vehicle = makeVehicle();
    vehicle.linearVelocity.z = -speed;
    const spray = new MudLiquidSpraySystem(new THREE.Group(), vehicle);
    for (let i = 0; i < 120; i += 1) {
      spray.update({ dt: DT, surface: 'mud', speed, throttle: 1, vehicle });
    }
    const emitted = spray.snapshot().emittedByWheel.reduce((sum, count) => sum + count, 0);
    // Compare primary spray particles; breakup children intentionally use a
    // separate short fragment lifetime independent of road speed.
    const live = spray.particles.filter((p) => p.life > 0 && !p.fragment);
    const meanWidth = live.reduce((sum, p) => sum + p.width, 0) / Math.max(1, live.length);
    const meanLife = live.reduce((sum, p) => sum + p.maxLife, 0) / Math.max(1, live.length);
    spray.dispose();
    return { emitted, meanWidth, meanLife };
  };
  const slow = run(5);
  const fast = run(42);
  assert.ok(fast.emitted > slow.emitted * 1.5,
    `fast driving emits more droplets (${fast.emitted} > ${slow.emitted})`);
  assert.ok(fast.meanWidth < slow.meanWidth * 0.82,
    `fast spray is thinner (${fast.meanWidth.toFixed(3)}m < ${slow.meanWidth.toFixed(3)}m)`);
  assert.ok(fast.meanLife < slow.meanLife * 0.7, 'fast spray clears sooner instead of obscuring the road');
  ok('speed increases mud volume while thinning and shortening each droplet');
}

// --- liquid gate: mud + acceleration only ---------------------------------
{
  const vehicle = makeVehicle();
  const spray = new MudLiquidSpraySystem(new THREE.Group(), vehicle);
  for (let i = 0; i < 90; i += 1) {
    spray.update({ dt: DT, surface: 'mud', speed: 20, throttle: 0, vehicle });
    spray.update({ dt: DT, surface: 'asphalt', speed: 20, throttle: 1, vehicle });
  }
  assert.equal(spray.snapshot().emittedByWheel.reduce((sum, count) => sum + count, 0), 0,
    'coasting on mud and accelerating on asphalt emit no liquid mud spray');
  spray.dispose();
  ok('liquid spray is gated to acceleration on mud');
}

console.log(`\nAll ${passed} rally-dust checks passed.`);
