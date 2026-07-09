// Guards the slip-angle tyre model (docs/vehicle-advanced-suspension-plan.md M1).
//
//   - Lateral envelope peaks near α_peak then falls (F6 recoverable limit)
//   - Load sensitivity lowers peak μ under heavy load
//   - Combined ellipse caps √(fx²+fy²) ≤ 1
//   - Surfaces reorder grip asphalt > dirt > mud
//   - resolveTyreGrip maps to controller frictionSlip / sideFrictionStiffness
//
// Pure-node math (no Rapier). Run: node scripts/verify-vehicle-tire-model.mjs
//   npm run verify:vehicle-tire

import assert from 'node:assert/strict';
import {
  combineFrictionEllipse,
  computeContactSlip,
  computeSlipAngle,
  computeSlipRatio,
  lateralEnvelope,
  loadSensitiveMu,
  longitudinalEnvelope,
  resolveTyreConfig,
  resolveTyreGrip,
  sineEnvelope,
} from '../src/game/vehicles/TyreModel.js';
import { DEFAULT_VEHICLE_CONFIG } from '../src/game/config/vehicleConfig.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- sine envelope peak + falloff
{
  const K = 10;
  const peakAlpha = Math.PI / (2 * K); // ~9°
  const atPeak = sineEnvelope(peakAlpha, K, 0.32);
  const before = sineEnvelope(peakAlpha * 0.4, K, 0.32);
  const after = sineEnvelope(peakAlpha * 1.8, K, 0.32);
  assert.ok(atPeak > before, 'envelope rises toward peak');
  assert.ok(atPeak > after, 'envelope falls past peak (F6)');
  assert.ok(after >= 0.32 - 1e-6, 'residual grip past peak stays recoverable');
  assert.ok(atPeak > 0.95, `peak near 1 (got ${atPeak})`);
  ok('lateral sine envelope peaks then falls with residual');
}

// ---------------------------------------------------------------- slip angle / ratio helpers
{
  const a = computeSlipAngle(10, 2, { vFloor: 2, blendBelow: 1.5 });
  assert.ok(Math.abs(a - Math.atan2(2, 10)) < 1e-6, 'α = atan2(vLat, vLong)');
  const parked = computeSlipAngle(0.1, 0.5, { vFloor: 2, blendBelow: 1.5 });
  assert.ok(Math.abs(parked) < Math.abs(Math.atan2(0.5, 2)), 'α blends down at low speed');
  const k = computeSlipRatio(12, 10, { vFloor: 2 });
  assert.ok(Math.abs(k - 0.2) < 1e-6, 'κ = (ωr − v) / v');
  ok('slip angle / slip ratio helpers');
}

// ---------------------------------------------------------------- load sensitivity
{
  const mu0 = 1.7;
  const Fz0 = 1000;
  const light = loadSensitiveMu(mu0, Fz0 * 0.6, Fz0, 0.15);
  const heavy = loadSensitiveMu(mu0, Fz0 * 1.8, Fz0, 0.15);
  assert.ok(light > mu0, 'light load raises peak μ');
  assert.ok(heavy < mu0, 'heavy load lowers peak μ');
  assert.ok(heavy > mu0 * 0.4, 'heavy load stays above floor');
  ok('load sensitivity lowers peak μ under load');
}

// ---------------------------------------------------------------- combined ellipse
{
  const inside = combineFrictionEllipse(0.5, 0.5, true);
  assert.ok(inside.ellipseUsage < 1, 'under limit usage < 1');
  assert.ok(Math.abs(inside.fxN - 0.5) < 1e-6 && Math.abs(inside.fyN - 0.5) < 1e-6);

  const outside = combineFrictionEllipse(0.9, 0.9, true);
  assert.equal(outside.ellipseUsage, 1, 'on-limit usage = 1');
  const r = Math.hypot(outside.fxN, outside.fyN);
  assert.ok(Math.abs(r - 1) < 1e-5, `ellipse scales to unit circle (r=${r})`);

  const off = combineFrictionEllipse(0.9, 0.9, false);
  assert.ok(off.fxN > 0.8 && off.fyN > 0.8, 'ellipse can be disabled');
  ok('combined friction ellipse caps Fx+Fy');
}

// ---------------------------------------------------------------- longitudinal / lateral envelopes
{
  const tyre = resolveTyreConfig();
  const midK = longitudinalEnvelope(0.12, tyre.long, tyre.residualMin);
  const highK = longitudinalEnvelope(1.5, tyre.long, tyre.residualMin);
  assert.ok(midK > 0.5, 'mid slip-ratio has substantial long grip');
  assert.ok(highK < midK, 'wheelspin long envelope falls past peak');
  assert.ok(highK >= tyre.residualMin - 1e-6, 'long residual floor held');
  // pureLat peaks near alphaPeak then falls (capability shape).
  const peakA = lateralEnvelope((tyre.lat.alphaPeakDeg ?? 14) * Math.PI / 180, tyre.lat, tyre.residualMin);
  const midA = lateralEnvelope(8 * Math.PI / 180, tyre.lat, tyre.residualMin);
  const highA = lateralEnvelope(35 * Math.PI / 180, tyre.lat, tyre.residualMin);
  assert.ok(peakA >= midA - 1e-6, 'pureLat near peak ≥ mid-α');
  assert.ok(peakA > highA, 'pureLat falls past peak');
  ok('long/lat envelopes shape κ and α');
}

// ---------------------------------------------------------------- resolveTyreGrip controller mapping
{
  const weight = 1400;
  const Fz0 = weight * 0.25;
  const atPeak = resolveTyreGrip({
    alpha: 10 * Math.PI / 180, // below default α_peak (14°)
    kappa: 0.05,
    Fz: Fz0,
    weight,
    baseFrictionSlip: 2,
    baseSideFriction: 0.9,
  });
  const pastPeak = resolveTyreGrip({
    alpha: 32 * Math.PI / 180, // well past α_peak
    kappa: 0.05,
    Fz: Fz0,
    weight,
    baseFrictionSlip: 2,
    baseSideFriction: 0.9,
  });
  assert.ok(atPeak.sideFrictionStiffness > pastPeak.sideFrictionStiffness,
    'side friction falls past α peak');
  assert.ok(atPeak.frictionSlip > 0.5 && atPeak.sideFrictionStiffness > 0.2,
    'controller scalars are positive and usable');
  // Linear region keeps near-full side friction (controller coefficient model).
  assert.ok(atPeak.sideFrictionStiffness > 0.85 * 0.9,
    'below α_peak side friction stays near base');

  // Wheelspin kills lateral via combined-slip cut.
  const spin = resolveTyreGrip({
    alpha: 10 * Math.PI / 180,
    kappa: 1.2,
    Fz: Fz0,
    weight,
    baseFrictionSlip: 2,
    baseSideFriction: 0.9,
  });
  assert.ok(spin.sideFrictionStiffness < atPeak.sideFrictionStiffness * 0.95,
    'high κ reduces lateral grip (ellipse)');
  assert.ok(spin.ellipseUsage >= atPeak.ellipseUsage - 1e-6, 'spin raises ellipse usage');
  ok('resolveTyreGrip maps envelope → controller scalars');
}

// ---------------------------------------------------------------- surface order asphalt > dirt > mud
{
  const s = DEFAULT_VEHICLE_CONFIG.ground.surfaces;
  assert.ok(s.asphalt.mu0Lat > s.dirt.mu0Lat && s.dirt.mu0Lat > s.mud.mu0Lat,
    'mu0Lat asphalt > dirt > mud');
  assert.ok(s.asphalt.mu0Long > s.dirt.mu0Long && s.dirt.mu0Long > s.mud.mu0Long,
    'mu0Long asphalt > dirt > mud');
  assert.ok(s.asphalt.Klat > s.dirt.Klat && s.dirt.Klat > s.mud.Klat,
    'Klat asphalt > dirt > mud (dirt/mud peak later)');

  const weight = 1400;
  const Fz = weight * 0.25;
  const grip = (surf) => resolveTyreGrip({
    alpha: 6 * Math.PI / 180,
    kappa: 0.08,
    Fz,
    weight,
    mu0Long: surf.mu0Long,
    mu0Lat: surf.mu0Lat,
    Klat: surf.Klat,
    Klong: surf.Klong,
    baseFrictionSlip: surf.frictionSlip,
    baseSideFriction: surf.sideFrictionStiffness,
  });
  const gA = grip(s.asphalt);
  const gD = grip(s.dirt);
  const gM = grip(s.mud);
  assert.ok(gA.sideFrictionStiffness > gD.sideFrictionStiffness,
    'asphalt side grip > dirt');
  assert.ok(gD.sideFrictionStiffness > gM.sideFrictionStiffness,
    'dirt side grip > mud');
  ok('surfaces reorder grip asphalt > dirt > mud');
}

// ---------------------------------------------------------------- config wiring
{
  assert.equal(DEFAULT_VEHICLE_CONFIG.ground.handlingModel, 'controller-slip');
  assert.ok(DEFAULT_VEHICLE_CONFIG.ground.tyre, 'ground.tyre config present');
  assert.ok(DEFAULT_VEHICLE_CONFIG.ground.tyre.combinedEllipse);
  assert.equal(DEFAULT_VEHICLE_CONFIG.ground.tyre.kLoad, 0.15, 'kLoad aligned with module default');
  ok('vehicleConfig exposes tyre + handlingModel');
}

// ---------------------------------------------------------------- handbrakeScale / Fz / contact slip / null-safe
{
  const weight = 1400;
  const Fz0 = weight * 0.25;
  const full = resolveTyreGrip({
    alpha: 0.1, kappa: 0.05, Fz: Fz0, weight,
    baseFrictionSlip: 2, baseSideFriction: 0.9, handbrakeScale: 1,
  });
  const hb = resolveTyreGrip({
    alpha: 0.1, kappa: 0.05, Fz: Fz0, weight,
    baseFrictionSlip: 2, baseSideFriction: 0.9, handbrakeScale: 0.1,
  });
  assert.ok(hb.frictionSlip < full.frictionSlip * 0.2, 'handbrakeScale cuts long grip');
  assert.ok(hb.sideFrictionStiffness < full.sideFrictionStiffness * 0.2, 'handbrakeScale cuts lat grip');

  const latOnly = resolveTyreGrip({
    alpha: 0.1, kappa: 0.05, Fz: Fz0, weight,
    baseFrictionSlip: 2, baseSideFriction: 0.9, handbrakeScale: 1, latScale: 1.4,
  });
  assert.ok(latOnly.sideFrictionStiffness > full.sideFrictionStiffness * 1.2,
    'latScale boosts side only');
  assert.ok(Math.abs(latOnly.frictionSlip - full.frictionSlip) < 1e-6,
    'latScale does not change long friction');

  const zeroFz = resolveTyreGrip({
    alpha: 0.1, kappa: 0.05, Fz: 0, weight,
    baseFrictionSlip: 2, baseSideFriction: 0.9,
  });
  assert.ok(zeroFz.frictionSlip > 0 && zeroFz.sideFrictionStiffness > 0, 'Fz=0 still returns grip');
  assert.equal(zeroFz.Fz, 0);

  // Surface mu0 must change absolute grip (vs asphalt muRef).
  const dirt = resolveTyreGrip({
    alpha: 0.1, kappa: 0.05, Fz: Fz0, weight,
    mu0Long: 1.0, mu0Lat: 0.95,
    baseFrictionSlip: 2, baseSideFriction: 0.9,
  });
  assert.ok(dirt.sideFrictionStiffness < full.sideFrictionStiffness,
    'lower mu0Lat lowers side friction vs asphalt ref');

  assert.doesNotThrow(() => resolveTyreConfig(null));
  assert.doesNotThrow(() => resolveTyreGrip({ tyre: null }));

  const slip = computeContactSlip({
    contactVel: { x: 1, y: 0, z: -10 },
    wheelForward: { x: 0, y: 0, z: -1 },
    wheelLateral: { x: 1, y: 0, z: 0 },
    angularVelocity: 26,
    wheelRadius: 0.38,
  });
  assert.ok(Number.isFinite(slip.alpha) && Number.isFinite(slip.kappa));
  assert.ok(Math.abs(slip.vLong - 10) < 1e-6, 'vLong along forward');
  assert.ok(Math.abs(slip.vLat - 1) < 1e-6, 'vLat along lateral');
  ok('handbrakeScale, latScale, Fz=0, mu0, contact slip, null-safe');
}

// ---------------------------------------------------------------- available-grip semantics note
{
  // Below peak α, available side friction stays near base (not sin(α)→0).
  const low = resolveTyreGrip({
    alpha: 0.02, kappa: 0, Fz: 350, weight: 1400,
    baseFrictionSlip: 2, baseSideFriction: 0.9,
  });
  assert.ok(low.sideFrictionStiffness > 0.8, 'low-α keeps available side grip');
  ok('available-grip semantics (Tier A controller mapping)');
}

// ---------------------------------------------------------------- κ blend preserves standstill wheelspin (issue 51)
{
  // Launch spin: vLong≈0, ωr large → finite κ (must not be zeroed by crawl blend).
  const launch = computeSlipRatio(12, 0.2, { vFloor: 2, blendBelow: 1.5 });
  assert.ok(Math.abs(launch) > 0.5, `standstill wheelspin κ finite (got ${launch})`);
  // Crawl noise: both v and wheel surface small → damped.
  const crawl = computeSlipRatio(0.3, 0.2, { vFloor: 2, blendBelow: 1.5 });
  const rawCrawl = (0.3 - 0.2) / 2;
  assert.ok(Math.abs(crawl) < Math.abs(rawCrawl), 'crawl κ damped when both speeds low');
  ok('κ blend keeps launch wheelspin, damps crawl noise');
}

// ---------------------------------------------------------------- no double-count surface (mu path alone)
{
  const weight = 1400;
  const Fz = weight * 0.25;
  // Same asphalt controller base; only mu0 changes (as BaseVehicle now does).
  const asphalt = resolveTyreGrip({
    alpha: 0.1, kappa: 0.05, Fz, weight,
    mu0Long: 1.6, mu0Lat: 1.7,
    baseFrictionSlip: 2, baseSideFriction: 0.9,
  });
  const mud = resolveTyreGrip({
    alpha: 0.1, kappa: 0.05, Fz, weight,
    mu0Long: 0.5, mu0Lat: 0.42,
    baseFrictionSlip: 2, baseSideFriction: 0.9,
  });
  const ratio = mud.sideFrictionStiffness / asphalt.sideFrictionStiffness;
  assert.ok(ratio > 0.2 && ratio < 0.45,
    `mud/asphalt side ratio via mu only ~0.25–0.4 (got ${ratio.toFixed(2)}, not double-counted ~0.06)`);
  ok('surface grip via mu/muRef only (no double-count)');
}

console.log(`\nverify-vehicle-tire-model: ${passed} checks passed`);