#!/usr/bin/env node
/**
 * M1: instantiate each gun subclass, tick fire → empty → reload → fire.
 * Assert fire-rate cooldown, pump shotgun cycle, pellets > 1.
 */
import assert from 'node:assert/strict';
import { createGun } from '../src/game/weapons/createGun.js';
import { GUN_FIRE_MODES } from '../src/game/weapons/gunConfig.js';
import { GUN_CATALOG, createCatalogStubProfile } from '../src/game/weapons/gunProfile.js';
import { Rifle } from '../src/game/weapons/Rifle.js';
import { Pistol } from '../src/game/weapons/Pistol.js';
import { Shotgun } from '../src/game/weapons/Shotgun.js';

// --- Kind constructors ---
const rifle = new Rifle({ id: 'test-rifle' });
assert.equal(rifle.weaponKind, 'rifle');
assert.equal(rifle.fireMode, GUN_FIRE_MODES.auto);
assert.equal(rifle.ammoInMag, rifle.stats.magazineSize);

const pistol = new Pistol({ id: 'test-pistol' });
assert.equal(pistol.fireMode, GUN_FIRE_MODES.semi);

const shotgun = new Shotgun({ id: 'test-shotgun' });
assert.equal(shotgun.fireMode, GUN_FIRE_MODES.pump);
assert.ok(shotgun.stats.pellets > 1, 'shotgun pellets must be > 1');

// --- Auto rifle fire until empty ---
{
  const gun = createGun('rifle', { id: 'spray' });
  gun.stats.fireRate = 10; // 0.1s cooldown
  gun.stats.magazineSize = 5;
  gun.ammoInMag = 5;
  gun.reserveAmmo = 10;

  let shots = 0;
  // Fire pressed once per semi-equivalent frame with enough dt for cooldown.
  for (let i = 0; i < 20; i += 1) {
    const { shot } = gun.update({ dt: 0.11, fireHeld: true, firePressed: i === 0 });
    if (shot) shots += 1;
  }
  // First press + held auto: should empty mag
  assert.equal(gun.ammoInMag, 0, 'rifle should empty mag under auto fire');
  assert.ok(shots >= 5, `expected ≥5 shots, got ${shots}`);

  // Dry fire event
  const dry = gun.update({ dt: 0.1, firePressed: true });
  assert.ok(dry.events.includes('dryFire'));

  // Reload
  const reloadStart = gun.update({ dt: 0.01, reloadPressed: true });
  assert.ok(reloadStart.events.includes('reloadStart'));
  assert.equal(gun.isReloading, true);
  // Cannot fire while reloading
  assert.equal(gun.tryFire(), null);

  gun.update({ dt: gun.stats.reloadTime + 0.05 });
  assert.equal(gun.isReloading, false);
  assert.ok(gun.ammoInMag > 0, 'mag refilled');
  const after = gun.update({ dt: 0.2, firePressed: true });
  assert.ok(after.shot, 'fires after reload');
}

// --- Semi pistol: only on press, not hold ---
{
  const gun = createGun('pistol');
  gun.stats.fireRate = 20;
  gun.ammoInMag = 3;
  let shots = 0;
  gun.update({ dt: 0.1, fireHeld: true, firePressed: false });
  assert.equal(gun.shotsFired, 0);
  for (let i = 0; i < 3; i += 1) {
    const { shot } = gun.update({ dt: 0.1, firePressed: true });
    if (shot) shots += 1;
  }
  assert.equal(shots, 3);
  assert.equal(gun.slideLocked, true);
}

// --- Pump shotgun requires cycle ---
{
  const gun = createGun('shotgun');
  gun.stats.fireRate = 10;
  gun.ammoInMag = 3;
  const first = gun.update({ dt: 0.05, firePressed: true });
  assert.ok(first.shot);
  assert.ok(first.shot.pellets > 1);
  assert.equal(gun.needsPump, true);
  // Immediate second press blocked
  const blocked = gun.tryFire();
  assert.equal(blocked, null);
  // After shot cooldown, auto-pump in Shotgun.update (sets a short pump cooldown).
  gun.update({ dt: 0.5, fireHeld: false });
  assert.equal(gun.needsPump, false);
  // Wait out the pump cycle cooldown, then fire again.
  gun.update({ dt: 0.4, fireHeld: false });
  const second = gun.update({ dt: 0.05, firePressed: true });
  assert.ok(second.shot, 'fires after pump cycle');
}

// --- Catalog stubs instantiate ---
for (const entry of GUN_CATALOG) {
  const profile = createCatalogStubProfile(entry, ['mesh_a', 'mesh_b']);
  const gun = createGun(profile);
  assert.equal(gun.weaponKind, entry.weaponKind);
  assert.ok(gun.stats.magazineSize >= 1);
  assert.ok(gun.getAnchor('muzzle'));
  assert.ok(gun.getAnchor('grip_mount'));
}

// --- Cooldown honors fireRate ---
{
  const gun = createGun('rifle');
  gun.stats.fireRate = 2; // 0.5s
  gun.ammoInMag = 10;
  const a = gun.tryFire();
  assert.ok(a);
  assert.ok(Math.abs(gun.fireCooldown - 0.5) < 1e-6);
  assert.equal(gun.tryFire(), null);
  gun.update({ dt: 0.49 });
  assert.equal(gun.tryFire(), null);
  gun.update({ dt: 0.02 });
  assert.ok(gun.tryFire());
}

console.log('verify-gun-classes: all checks passed');
