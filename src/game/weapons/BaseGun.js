/**
 * BaseGun — shared ammo / fire-rate / reload / ADS state machine for all kinds.
 *
 * Subclasses only override config defaults and kind-specific hooks (pump cycle,
 * slide lock, etc.). Visual articulation (M7) and hitscan (M5) plug into hooks.
 */

import { GUN_FIRE_MODES, resolveGunStats } from './gunConfig.js';
import { findAnchor, normalizeAnchorList } from './gunAnchors.js';
import { normalizeProfile } from './gunProfile.js';

export const GUN_STATE = Object.freeze({
  idle: 'idle',
  firing: 'firing',
  reloading: 'reloading',
  inspecting: 'inspecting',
});

export class BaseGun {
  /**
   * @param {object} options
   * @param {object} [options.profile] gun profile (anchors/parts/stats)
   * @param {object} [options.stats] explicit stats (else resolved from profile)
   * @param {object|null} [options.root] optional THREE root once loaded
   */
  constructor(options = {}) {
    const profile = options.profile ? normalizeProfile(options.profile) : null;
    this.profile = profile;
    this.id = profile?.id || options.id || 'gun';
    this.label = profile?.label || options.label || this.id;
    this.weaponKind = profile?.weaponKind || options.weaponKind || 'rifle';
    this.stats = resolveGunStats({
      ...(profile || {}),
      weaponKind: this.weaponKind,
      id: this.id,
      statOverrides: options.statOverrides || profile?.statOverrides,
    });
    if (options.stats) {
      this.stats = { ...this.stats, ...options.stats };
    }

    this.root = options.root ?? null;
    this.anchors = normalizeAnchorList(profile?.anchors);
    this.parts = profile?.parts ? [...profile.parts] : [];

    this.state = GUN_STATE.idle;
    this.ammoInMag = this.stats.magazineSize;
    this.reserveAmmo = this.stats.magazineSize * (this.stats.reserveMags ?? 3);
    this.fireCooldown = 0;
    this.reloadTimer = 0;
    this.ads = 0; // 0..1 blend
    this.adsTarget = 0;
    this.needsPump = false; // shotgun: must cycle between shots
    this.dryFire = false;
    this._lastShotTime = -Infinity;
    this.shotsFired = 0;
  }

  get fireMode() {
    return this.stats.fireMode || GUN_FIRE_MODES.semi;
  }

  get isEmpty() {
    return this.ammoInMag <= 0;
  }

  get isReloading() {
    return this.state === GUN_STATE.reloading;
  }

  get canFire() {
    if (this.isReloading) return false;
    if (this.state === GUN_STATE.inspecting) return false;
    if (this.fireCooldown > 0) return false;
    if (this.needsPump) return false;
    if (this.ammoInMag <= 0) return false;
    return true;
  }

  getAnchor(name) {
    return findAnchor(this.anchors, name);
  }

  /**
   * Frame tick. dt in seconds.
   * @param {{dt:number, fireHeld?:boolean, firePressed?:boolean, reloadPressed?:boolean, adsHeld?:boolean}} input
   * @returns {{shot:null|object, events:string[]}}
   */
  update(input = {}) {
    const dt = Math.max(0, Number(input.dt) || 0);
    const events = [];

    if (this.fireCooldown > 0) {
      this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    }

    // ADS blend
    this.adsTarget = input.adsHeld ? 1 : 0;
    const adsSpeed = 10;
    const adsAlpha = 1 - Math.exp(-adsSpeed * dt);
    this.ads += (this.adsTarget - this.ads) * adsAlpha;

    if (this.state === GUN_STATE.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this._finishReload();
        events.push('reloadComplete');
      }
      return { shot: null, events };
    }

    if (input.reloadPressed) {
      if (this.beginReload()) {
        events.push('reloadStart');
      }
      return { shot: null, events };
    }

    let shot = null;
    const wantsFire = this.fireMode === GUN_FIRE_MODES.auto
      ? Boolean(input.fireHeld || input.firePressed)
      : Boolean(input.firePressed);

    if (wantsFire) {
      shot = this.tryFire();
      if (shot) {
        events.push('shot');
        this.state = GUN_STATE.firing;
      } else if (this.ammoInMag <= 0 && input.firePressed) {
        this.dryFire = true;
        events.push('dryFire');
      }
    } else if (this.state === GUN_STATE.firing && this.fireCooldown <= 0) {
      this.state = GUN_STATE.idle;
    }

    // Pump shotgun: cycle between shots when empty of needsPump
    if (this.needsPump && input.firePressed === false && input.pumpPressed) {
      this.cyclePump();
      events.push('pump');
    }

    return { shot, events };
  }

  /**
   * Attempt a single shot (or pellet group). Returns shot descriptor or null.
   */
  tryFire() {
    if (!this.canFire) return null;

    const pellets = Math.max(1, this.stats.pellets || 1);
    const baseSpread = this.stats.spread || 0.02;
    const spread = baseSpread * (this.ads > 0.5 ? (this.stats.adsSpreadMul ?? 0.5) : 1);
    const fireRate = Math.max(0.05, this.stats.fireRate || 1);
    this.fireCooldown = 1 / fireRate;
    this.ammoInMag -= 1;
    this.shotsFired += 1;
    this.dryFire = false;

    if (this.stats.pumpRequired || this.fireMode === GUN_FIRE_MODES.pump) {
      this.needsPump = true;
    }

    return {
      damage: this.stats.damage,
      pellets,
      spread,
      recoil: this.stats.recoil || 0.03,
      range: this.stats.range || 100,
      originAnchor: 'muzzle',
      time: performanceNow(),
    };
  }

  /** Shotgun: clear the pump gate so the next shot can fire. */
  cyclePump() {
    if (!this.needsPump) return false;
    this.needsPump = false;
    // brief pump animation window — fire gated until cooldown also clears
    this.fireCooldown = Math.max(this.fireCooldown, 0.35);
    return true;
  }

  beginReload() {
    if (this.isReloading) return false;
    if (this.ammoInMag >= this.stats.magazineSize) return false;
    if (this.reserveAmmo <= 0) return false;

    this.state = GUN_STATE.reloading;
    this.reloadTimer = Math.max(0.1, this.stats.reloadTime || 1.5);
    this.needsPump = false;
    return true;
  }

  _finishReload() {
    const room = this.stats.magazineSize - this.ammoInMag;
    const take = Math.min(room, this.reserveAmmo);
    this.ammoInMag += take;
    this.reserveAmmo -= take;
    this.reloadTimer = 0;
    this.state = GUN_STATE.idle;
    this.needsPump = false;
  }

  /** Force-complete reload (tests / animation events). */
  completeReload() {
    if (!this.isReloading) return false;
    this._finishReload();
    return true;
  }

  setInspecting(active) {
    if (active) {
      if (this.isReloading) return;
      this.state = GUN_STATE.inspecting;
    } else if (this.state === GUN_STATE.inspecting) {
      this.state = GUN_STATE.idle;
    }
  }

  /** Snapshot for HUD / debug. */
  snapshot() {
    return {
      id: this.id,
      label: this.label,
      weaponKind: this.weaponKind,
      state: this.state,
      fireMode: this.fireMode,
      ammoInMag: this.ammoInMag,
      magazineSize: this.stats.magazineSize,
      reserveAmmo: this.reserveAmmo,
      fireCooldown: Number(this.fireCooldown.toFixed(3)),
      ads: Number(this.ads.toFixed(3)),
      needsPump: this.needsPump,
      canFire: this.canFire,
      shotsFired: this.shotsFired,
    };
  }

  dispose() {
    this.root = null;
  }
}

function performanceNow() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}
