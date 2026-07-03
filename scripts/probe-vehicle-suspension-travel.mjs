// Verifies the per-wheel suspension travel feature on the REAL car:
//  (1) Flat-ground settle: comes to rest at the spring ride height without bounce.
//  (2) Bumpy terrain: the four wheels' visual suspension lengths diverge (each
//      wheel travels independently) while the chassis stays relatively level.
//
// Run: node scripts/probe-vehicle-suspension-travel.mjs

// Headless canvas stub for the tyre/rim CanvasTextures.
const ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : ctx2d),
  apply: () => ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const dt = 1 / 60;
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

await RAPIER.init();
const scene = new THREE.Scene();

function flatGround(world) {
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 2, 200).setFriction(0.7).setRestitution(0), b);
}

// Rippled heightfield centred on origin: small bumps that vary across both the
// wheelbase (Z) and track (X) so all four wheels see different ground.
function bumpyGround(world, { size = 60, n = 120, amp = 0.11 } = {}) {
  const heights = new Float32Array((n + 1) * (n + 1));
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= n; j += 1) {
      const x = (i / n - 0.5) * size;
      const z = (j / n - 0.5) * size;
      heights[i * (n + 1) + j] = amp * (Math.sin(x * 0.9) + Math.sin(z * 0.7) + 0.6 * Math.sin(x * 0.4 + z * 0.5));
    }
  }
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(n, n, heights, { x: size, y: 1, z: size }).setFriction(0.7),
    b,
  );
}

async function makeCar(world, x = 0, z = 0) {
  const phys = { RAPIER, world, getFreshBody: (h) => world.bodies.get(h) };
  const veh = new BaseVehicle({
    position: new THREE.Vector3(x, 0, z),
    chassisOverlay: false,
  });
  // Sample ground under spawn so we start at the right height (flat=0 here).
  veh.spawnPosition.y = veh.getGroundSpawnClearance() + 0.05;
  await veh.spawn({ scene, physics: phys });
  veh.status = 'ready';
  return { veh, phys };
}

function poseOf(veh, phys) {
  const b = phys.getFreshBody(veh.bodyHandle);
  const t = b.translation();
  _q.set(b.rotation().x, b.rotation().y, b.rotation().z, b.rotation().w);
  _e.setFromQuaternion(_q, 'YXZ');
  return {
    y: t.y,
    pitchDeg: THREE.MathUtils.radToDeg(_e.x),
    rollDeg: THREE.MathUtils.radToDeg(_e.z),
    susp: veh.wheelSuspLen.map((v) => (v == null ? NaN : v)),
  };
}

const fmt = (n, w = 6, d = 3) => Number(n).toFixed(d).padStart(w);

// ---- (1) flat settle -------------------------------------------------------
{
  const world = new RAPIER.World(GRAVITY);
  flatGround(world);
  const { veh, phys } = await makeCar(world);
  const controls = makeNeutralControls();
  console.log('FLAT SETTLE (no throttle) — expect Y to converge, no bounce; susp ~equal');
  console.log('  t      Y     pitch   roll   suspFL  suspFR  suspRL  suspRR');
  let prevY = null;
  let maxBounce = 0;
  for (let i = 0; i <= 60 * 2; i += 1) {
    veh.update({ dt, controls, physics: phys });
    world.step();
    const p = poseOf(veh, phys);
    if (prevY != null && p.y > prevY + 1e-4) maxBounce = Math.max(maxBounce, p.y - prevY);
    prevY = p.y;
    if (i % 20 === 0) {
      console.log(`${fmt(i * dt, 5, 2)} ${fmt(p.y)} ${fmt(p.pitchDeg, 6, 2)} ${fmt(p.rollDeg, 6, 2)}  ` +
        p.susp.map((s) => fmt(s)).join(' '));
    }
  }
  console.log(`  -> max upward bounce between frames after settle: ${maxBounce.toFixed(4)} m\n`);
}

// ---- (2) bumpy drive -------------------------------------------------------
{
  const world = new RAPIER.World(GRAVITY);
  bumpyGround(world);
  const { veh, phys } = await makeCar(world, 0, 18);
  const controls = makeNeutralControls();
  console.log('BUMPY DRIVE (throttle 0.6 forward) — expect the 4 susp lengths to DIVERGE');
  console.log('  t      Y     pitch   roll   suspFL  suspFR  suspRL  suspRR   spread');
  let maxSpread = 0;
  for (let i = 0; i <= 60 * 5; i += 1) {
    controls.throttle = 0.6;
    veh.update({ dt, controls, physics: phys });
    world.step();
    const p = poseOf(veh, phys);
    const valid = p.susp.filter((s) => Number.isFinite(s));
    const spread = valid.length ? Math.max(...valid) - Math.min(...valid) : 0;
    if (i > 60) maxSpread = Math.max(maxSpread, spread); // ignore spawn transient
    if (i % 20 === 0) {
      console.log(`${fmt(i * dt, 5, 2)} ${fmt(p.y)} ${fmt(p.pitchDeg, 6, 2)} ${fmt(p.rollDeg, 6, 2)}  ` +
        p.susp.map((s) => fmt(s)).join(' ') + `  ${fmt(spread)}`);
    }
  }
  console.log(`  -> max per-wheel travel spread while driving: ${maxSpread.toFixed(3)} m`);
}
