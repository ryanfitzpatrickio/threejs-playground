#!/usr/bin/env node
/**
 * M5/M6: pure unit checks for hitscan, damage regions, BaseGun fire path.
 * No browser / WebGPU required.
 *
 * Usage: node scripts/verify-weapon-fire.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGun } from '../src/game/weapons/createGun.js';
import { GUN_CATALOG, createCatalogStubProfile } from '../src/game/weapons/gunProfile.js';
import { WeaponSystem } from '../src/game/systems/WeaponSystem.js';
import {
  applySpread,
  bodyRegionMultiplier,
  buildPelletDirections,
  computeBulletDamage,
  HEADSHOT_MULTIPLIER,
  raycastEnemies,
  resolvePelletHit,
} from '../src/game/weapons/weaponHitscan.js';

// --- Spread stays near forward for tiny angles ---
{
  const f = { x: 0, y: 0, z: -1 };
  const d = applySpread(f, 0, () => 0.5);
  assert.ok(Math.abs(d.z + 1) < 1e-6);
  const dirs = buildPelletDirections(f, 8, 0.15, () => 0.25);
  assert.equal(dirs.length, 8);
  for (const dir of dirs) {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    assert.ok(Math.abs(len - 1) < 1e-5, 'pellet dirs unit length');
  }
}

// --- Body region multipliers ---
{
  const feet = 0;
  const h = 2;
  assert.equal(bodyRegionMultiplier(1.0, feet, h), 1); // torso
  assert.ok(bodyRegionMultiplier(1.7, feet, h) >= HEADSHOT_MULTIPLIER * 0.99);
  assert.ok(bodyRegionMultiplier(0.1, feet, h) < 1);
  assert.equal(computeBulletDamage(20, 1.8, 0, 2), Math.round(20 * HEADSHOT_MULTIPLIER));
}

// --- Enemy cylinder raycast ---
{
  const enemy = {
    id: 'e1',
    health: 100,
    collisionHeight: 1.8,
    collisionRadius: 0.35,
    model: { position: { x: 0, y: 0, z: -5 } },
  };
  const hit = raycastEnemies(
    { x: 0, y: 1.2, z: 0 },
    { x: 0, y: 0, z: -1 },
    50,
    [enemy],
  );
  assert.ok(hit, 'should hit standing enemy');
  assert.equal(hit.enemy.id, 'e1');
  assert.ok(hit.distance > 4 && hit.distance < 6);
  assert.ok(hit.region === 'body' || hit.region === 'head' || hit.region === 'limb');

  const miss = raycastEnemies(
    { x: 0, y: 1.2, z: 0 },
    { x: 1, y: 0, z: 0 },
    50,
    [enemy],
  );
  assert.equal(miss, null);

  const dead = { ...enemy, health: 0 };
  assert.equal(
    raycastEnemies({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -1 }, 50, [dead]),
    null,
  );
}

// --- resolvePelletHit enemy damage ---
{
  const enemy = {
    id: 'e2',
    health: 100,
    collisionHeight: 1.8,
    collisionRadius: 0.4,
    model: { position: { x: 0, y: 0, z: -8 } },
  };
  const result = resolvePelletHit({
    origin: { x: 0, y: 1.5, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    range: 100,
    enemies: [enemy],
    physics: null,
    baseDamage: 23,
  });
  assert.equal(result.kind, 'enemy');
  assert.ok(result.damage >= 1);
  assert.equal(result.enemy.id, 'e2');
}

// --- BaseGun auto fire empties mag, reload refills ---
{
  const gun = createGun('rifle', { id: 'desert-ar15' });
  gun.stats.fireRate = 20;
  gun.stats.magazineSize = 5;
  gun.ammoInMag = 5;
  gun.reserveAmmo = 10;
  let shots = 0;
  for (let i = 0; i < 12; i += 1) {
    const { shot } = gun.update({ dt: 0.06, fireHeld: true, firePressed: i === 0 });
    if (shot) shots += 1;
  }
  assert.equal(gun.ammoInMag, 0);
  assert.ok(shots >= 5);
  gun.update({ dt: 0.01, reloadPressed: true });
  assert.equal(gun.isReloading, true);
  gun.update({ dt: gun.stats.reloadTime + 0.05 });
  assert.ok(gun.ammoInMag > 0);
}

// --- ADS tightens spread in tryFire ---
{
  const gun = createGun('rifle');
  gun.ammoInMag = 10;
  gun.ads = 0;
  const hip = gun.tryFire();
  gun.fireCooldown = 0;
  gun.ads = 1;
  const ads = gun.tryFire();
  assert.ok(ads.spread < hip.spread, 'ADS spread should be tighter');
}

// --- Simulated kill path (damage accumulate) ---
{
  const enemy = {
    id: 'e3',
    health: 40,
    maxHealth: 100,
    collisionHeight: 1.8,
    collisionRadius: 0.35,
    model: { position: { x: 0, y: 0, z: -4 } },
    staggerTimer: 0,
  };
  let kills = 0;
  for (let i = 0; i < 5 && enemy.health > 0; i += 1) {
    const hit = resolvePelletHit({
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      range: 50,
      enemies: [enemy],
      baseDamage: 23,
    });
    assert.equal(hit.kind, 'enemy');
    enemy.health = Math.max(0, enemy.health - hit.damage);
    if (enemy.health <= 0) kills += 1;
  }
  assert.equal(kills, 1);
  assert.equal(enemy.health, 0);
}

// --- Live tracers keep their start vertex attached to the muzzle anchor ---
{
  const scene = new THREE.Scene();
  const weaponSystem = new WeaponSystem();
  weaponSystem.initialize(scene);
  const gunRoot = new THREE.Group();
  const muzzle = new THREE.Object3D();
  gunRoot.add(muzzle);
  scene.add(gunRoot);
  muzzle.position.set(0.2, 1.1, -0.4);
  scene.updateMatrixWorld(true);

  weaponSystem._spawnTracer(
    new THREE.Vector3(0.2, 1.1, -0.4),
    new THREE.Vector3(0, 1, -20),
    muzzle,
  );
  muzzle.position.set(0.35, 1.2, -0.55);
  weaponSystem._tickEffects(0.01);

  const start = weaponSystem._tracers[0].pos.array;
  assert.ok(Math.abs(start[0] - 0.35) < 1e-6);
  assert.ok(Math.abs(start[1] - 1.2) < 1e-6);
  assert.ok(Math.abs(start[2] + 0.55) < 1e-6);
  weaponSystem.dispose();
}

// --- Pump events route through the per-gun sound assignment ---
{
  const shotgunEntry = GUN_CATALOG.find((entry) => entry.id === 'tactical-shotgun');
  const gun = createGun(createCatalogStubProfile(shotgunEntry));
  gun.needsPump = true;
  gun.fireCooldown = 0;

  const weaponSystem = new WeaponSystem();
  weaponSystem.equip('tactical-shotgun');
  weaponSystem.holstered = false;
  const played = [];
  weaponSystem._playGunSound = (_gun, interaction) => {
    played.push(interaction);
    return true;
  };
  weaponSystem.update({
    delta: 0.016,
    input: {},
    cameraSystem: { setWeaponAds() {} },
    firstPersonWeaponSystem: {
      active: true,
      visibleWeapon: true,
      equippedGunId: 'tactical-shotgun',
      gunView: { gun, root: new THREE.Group() },
    },
  });
  assert.deepEqual(played, ['pump']);
  weaponSystem.dispose();
}

console.log('verify-weapon-fire: all checks passed');
