// AR0 regression for the procedural reload timeline in BaseGun
// (docs/advanced-reload-system-plan.md). The old reload was binary
// (reloadStart → wait reloadTime → reloadComplete). This asserts the normalized
// timeline: phase events fire in order at their reloadPhaseTiming thresholds,
// the magazine refills exactly once (at seat by default), a second reload
// trigger mid-reload is a no-op, and cancel restores idle without ammo loss.
//
// Pure node, no Three. Run: node scripts/verify-reload-timeline.mjs

import assert from 'node:assert/strict';
import { BaseGun, GUN_STATE, GUN_RELOAD_PHASE, normalizeReloadPhaseTiming } from '../src/game/weapons/BaseGun.js';
import { Pistol } from '../src/game/weapons/Pistol.js';

/** Tick a gun in small steps up to `t` normalized progress, collecting events. */
function runReload(gun, { steps = 240, cancelAt = null } = {}) {
  const duration = gun.reloadDuration || gun.stats.reloadTime;
  const dt = duration / steps;
  const fired = [];
  const phaseAtProgress = {};
  for (let i = 0; i <= steps + 2; i += 1) {
    if (!gun.isReloading) break;
    const cancel = cancelAt != null && gun.reloadProgress >= cancelAt;
    const { events } = gun.update({ dt, cancelReload: cancel });
    for (const e of events) {
      if (!phaseAtProgress[e]) phaseAtProgress[e] = gun.reloadProgress;
      fired.push(e);
    }
    if (cancel) break;
  }
  return { fired, phaseAtProgress };
}

// --- Rifle: phase events fire in order at their thresholds; refill once ---
{
  const gun = new BaseGun({ weaponKind: 'rifle', id: 'modern-ar15' });
  gun.ammoInMag = 3;
  gun.reserveAmmo = 60;
  assert.ok(gun.reloadPhaseTiming, 'rifle has phase timing');
  assert.equal(gun.reloadRefillAt, 'seat', 'rifle refills at seat by default');

  assert.equal(gun.beginReload(), true, 'reload starts');
  assert.equal(gun.state, GUN_STATE.reloading);
  assert.equal(gun.reloadProgress, 0);
  assert.equal(gun.reloadPhase, GUN_RELOAD_PHASE.reach, 'starts in the reach phase');

  const { fired, phaseAtProgress } = runReload(gun);

  const timing = gun.reloadPhaseTiming;
  const expectOrder = ['mag_release', 'mag_drop', 'mag_spawn', 'mag_seat', 'charge'];
  const firedPhases = fired.filter((e) => expectOrder.includes(e));
  // mag_drop and mag_spawn share a threshold; both must appear, drop before spawn.
  assert.deepEqual(firedPhases, expectOrder, `phases fire once, in order (got ${firedPhases})`);
  for (const phase of expectOrder) {
    assert.ok(phaseAtProgress[phase] >= timing[phase] - 1e-6,
      `${phase} fired at/after its threshold ${timing[phase]}`);
    assert.ok(phaseAtProgress[phase] <= timing[phase] + 0.05,
      `${phase} fired close to its threshold`);
  }
  assert.ok(fired.includes('reloadComplete'), 'reload completes');
  assert.equal(gun.state, GUN_STATE.idle, 'back to idle');
  assert.equal(gun.ammoInMag, gun.stats.magazineSize, 'magazine refilled to full');
  assert.equal(gun.reserveAmmo, 60 - (gun.stats.magazineSize - 3), 'reserve debited by exactly the rounds loaded');
}

// --- Tactical reload: full magazine may still run the presentation cycle ---
{
  const gun = new BaseGun({ weaponKind: 'rifle', id: 'modern-ar15' });
  gun.ammoInMag = gun.stats.magazineSize;
  gun.reserveAmmo = gun.stats.magazineSize;
  const reserveBefore = gun.reserveAmmo;
  assert.equal(gun.beginReload(), true, 'full magazine can start a tactical reload');
  const { fired } = runReload(gun);
  assert.ok(fired.includes('mag_spawn') && fired.includes('mag_seat'), 'full reload still runs the magazine cycle');
  assert.equal(gun.ammoInMag, gun.stats.magazineSize, 'full magazine remains full');
  assert.equal(gun.reserveAmmo, reserveBefore, 'full tactical reload consumes no rounds');
}

// --- Ammo refills exactly once, at the seat threshold (not at complete) ---
{
  const gun = new BaseGun({ weaponKind: 'rifle', id: 'modern-ar15' });
  gun.ammoInMag = 0;
  gun.reserveAmmo = 30;
  gun.beginReload();
  const seatT = gun.reloadPhaseTiming.mag_seat;
  const dt = gun.reloadDuration / 200;
  let refilledProgress = null;
  let prevAmmo = gun.ammoInMag;
  while (gun.isReloading) {
    gun.update({ dt });
    if (refilledProgress == null && gun.ammoInMag > prevAmmo) refilledProgress = gun.reloadProgress;
    prevAmmo = gun.ammoInMag;
  }
  assert.ok(refilledProgress != null, 'ammo was refilled during the reload');
  assert.ok(Math.abs(refilledProgress - seatT) < 0.05, `refill happens at the seat phase (~${seatT})`);
  assert.equal(gun.ammoInMag, gun.stats.magazineSize);
  assert.equal(gun.reserveAmmo, 30 - gun.stats.magazineSize);
}

// --- Double-trigger mid-reload is a no-op (no extra ammo, no restart) ---
{
  const gun = new BaseGun({ weaponKind: 'rifle', id: 'modern-ar15' });
  gun.ammoInMag = 5;
  gun.reserveAmmo = 30;
  gun.beginReload();
  gun.update({ dt: gun.reloadDuration * 0.25 });
  const midProgress = gun.reloadProgress;
  assert.equal(gun.beginReload(), false, 'cannot begin a second reload while reloading');
  // reloadPressed through update must also not restart the timeline.
  gun.update({ dt: 0, reloadPressed: true });
  assert.ok(gun.reloadProgress >= midProgress, 'timeline did not reset');
  assert.equal(gun.reserveAmmo, 30, 'no ammo consumed by the ignored re-trigger');
}

// --- Cancel before seat: rolls back to idle, keeps the partial magazine ---
{
  const gun = new BaseGun({ weaponKind: 'rifle', id: 'modern-ar15' });
  gun.ammoInMag = 7;
  gun.reserveAmmo = 30;
  gun.beginReload();
  runReload(gun, { cancelAt: 0.5 }); // cancel before mag_seat (0.82)
  assert.equal(gun.state, GUN_STATE.idle, 'cancel returns to idle');
  assert.equal(gun.isReloading, false);
  assert.equal(gun.ammoInMag, 7, 'partial magazine preserved (no refill on early cancel)');
  assert.equal(gun.reserveAmmo, 30, 'no reserve spent on early cancel');
  assert.equal(gun.reloadProgress, 0, 'timeline reset');
  // Gun is immediately usable again.
  assert.equal(gun.beginReload(), true, 'can reload again after cancel');
}

// --- Cancel after seat: ammo already loaded, finishes cleanly ---
{
  const gun = new BaseGun({ weaponKind: 'rifle', id: 'modern-ar15' });
  gun.ammoInMag = 0;
  gun.reserveAmmo = 30;
  gun.beginReload();
  runReload(gun, { cancelAt: 0.9 }); // past mag_seat
  assert.equal(gun.state, GUN_STATE.idle);
  assert.equal(gun.ammoInMag, gun.stats.magazineSize, 'seated mag is kept on late cancel');
  assert.equal(gun.reserveAmmo, 30 - gun.stats.magazineSize);
}

// --- Pistol uses its own tighter windows ---
{
  const gun = new Pistol({ id: 'midnight-glock' });
  gun.ammoInMag = 2;
  gun.reserveAmmo = 34;
  assert.ok(gun.reloadPhaseTiming.mag_seat < 0.82, 'pistol seats earlier than the rifle');
  gun.beginReload();
  const { fired } = runReload(gun);
  assert.deepEqual(
    fired.filter((e) => ['mag_release', 'mag_seat'].includes(e)),
    ['mag_release', 'mag_seat'],
    'pistol still fires phases in order',
  );
  assert.equal(gun.ammoInMag, gun.stats.magazineSize);
  assert.equal(gun.slideLocked, false, 'pistol slide released on reload');
}

// --- Explicit per-gun timing override merges over the kind default ---
{
  // The constructor resolves reloadPhaseTiming from the merged stats, so a
  // partial override keeps the kind default for the phases it omits.
  const gun = new BaseGun({
    weaponKind: 'rifle',
    id: 'custom',
    stats: { reloadPhaseTiming: { mag_seat: 0.6 } },
  });
  assert.equal(gun.reloadPhaseTiming.mag_seat, 0.6, 'override applied');
  assert.equal(gun.reloadPhaseTiming.mag_release, 0.14, 'unspecified phases keep the kind default');
  // The exported normalizer is also directly usable (Gunsmith / profile path).
  const merged = normalizeReloadPhaseTiming({ charge: 1.2, bogus: 5 }, 'rifle');
  assert.equal(merged.charge, 1, 'out-of-range timing clamped to [0,1]');
  assert.equal(merged.mag_seat, 0.82, 'unspecified phases keep the kind default');
}

// --- Shotgun (no phase timing) keeps the plain start/complete path ---
{
  const gun = new BaseGun({ weaponKind: 'shotgun', id: 'tactical-shotgun' });
  assert.equal(gun.reloadPhaseTiming, null, 'shotgun has no mag phase timing');
  assert.equal(gun.reloadRefillAt, 'complete', 'shotgun refills at complete');
  gun.ammoInMag = 0;
  gun.reserveAmmo = 12;
  gun.beginReload();
  const { fired } = runReload(gun);
  assert.ok(!fired.some((e) => e.startsWith('mag_')), 'no mag phase events for the shotgun');
  assert.ok(fired.includes('reloadComplete'));
  assert.ok(gun.ammoInMag > 0, 'shotgun still refills');
}

console.log('verify-reload-timeline: all checks passed');
