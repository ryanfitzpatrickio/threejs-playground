/**
 * BaseGun — shared ammo / fire-rate / reload / ADS state machine for all kinds.
 *
 * Subclasses only override config defaults and kind-specific hooks (pump cycle,
 * slide lock, etc.). Visual articulation (M7) and hitscan (M5) plug into hooks.
 */

import { GUN_FIRE_MODES, GUN_KIND_DEFAULTS, resolveGunStats } from './gunConfig.js';
import { findAnchor, normalizeAnchorList } from './gunAnchors.js';
import { normalizeProfile } from './gunProfile.js';
import {
  reloadDebugShouldPinProgress,
  reloadDebugSocket,
} from './reloadDebugSocket.js';

export const GUN_STATE = Object.freeze({
  idle: 'idle',
  firing: 'firing',
  reloading: 'reloading',
  inspecting: 'inspecting',
});

/**
 * Discrete reload phases (docs/advanced-reload-system-plan.md, AR0). `reach` is
 * the implicit span before the first event; the rest are one-shot events fired
 * as normalized reload progress crosses their `reloadPhaseTiming` threshold.
 */
export const GUN_RELOAD_PHASE = Object.freeze({
  reach: 'reach',
  mag_release: 'mag_release',
  mag_drop: 'mag_drop',
  mag_spawn: 'mag_spawn',
  mag_seat: 'mag_seat',
  charge: 'charge',
});

/** Event order — also the order phases fire and the "current phase" precedence. */
const RELOAD_PHASE_ORDER = Object.freeze([
  GUN_RELOAD_PHASE.mag_release,
  GUN_RELOAD_PHASE.mag_drop,
  GUN_RELOAD_PHASE.mag_spawn,
  GUN_RELOAD_PHASE.mag_seat,
  GUN_RELOAD_PHASE.charge,
]);

/**
 * Merge a kind's default phase timing with an explicit override, clamped to
 * [0,1] and restricted to known phases. Returns null when no timing applies
 * (e.g. shotgun's per-shell reload, which keeps the plain start/complete path).
 */
export function normalizeReloadPhaseTiming(value, kind = 'rifle') {
  const base = GUN_KIND_DEFAULTS[kind]?.reloadPhaseTiming ?? null;
  const explicit = value && typeof value === 'object' ? value : null;
  if (!base && !explicit) return null;
  const merged = { ...(base ?? {}), ...(explicit ?? {}) };
  const out = {};
  for (const phase of RELOAD_PHASE_ORDER) {
    const t = Number(merged[phase]);
    if (Number.isFinite(t)) out[phase] = Math.min(1, Math.max(0, t));
  }
  return Object.keys(out).length ? out : null;
}

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
      statOverrides: {
        ...(profile?.statOverrides ?? {}),
        ...(options.statOverrides ?? {}),
        ...(profile?.presentation ? { presentation: profile.presentation } : {}),
      },
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
    // Normalized reload timeline (AR0). Progress 0..1 over reloadDuration;
    // phase events fire once each as thresholds are crossed.
    this.reloadDuration = 0;
    this.reloadElapsed = 0;
    this.reloadProgress = 0;
    this.reloadPhaseTiming = normalizeReloadPhaseTiming(this.stats.reloadPhaseTiming, this.weaponKind);
    /** Refill the magazine at 'seat' (tactical) or 'complete' (animation end). */
    this.reloadRefillAt = this.stats.reloadRefillAt
      ?? (this.reloadPhaseTiming ? 'seat' : 'complete');
    this._reloadPhasesFired = new Set();
    this._ammoRefilled = false;
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

  /** Current discrete reload phase (or null when not reloading). */
  get reloadPhase() {
    if (!this.isReloading) return null;
    const timing = this.reloadPhaseTiming;
    if (!timing) return GUN_RELOAD_PHASE.reach;
    let current = GUN_RELOAD_PHASE.reach;
    for (const phase of RELOAD_PHASE_ORDER) {
      const t = timing[phase];
      if (t != null && this.reloadProgress >= t) current = phase;
    }
    return current;
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
      // Interrupt (sprint / traversal / explicit cancel) leaves a clean state;
      // the visual rollback is a later milestone's concern.
      if (input.cancelReload) {
        this.cancelReload();
        events.push('reloadCancel');
        return { shot: null, events };
      }

      const duration = this.reloadDuration || Math.max(0.1, this.stats.reloadTime || 1.5);
      // Debug scrub: freeze timeline at scrubT so hand path + mag phases stay
      // locked while fitting offsets (see reloadDebugSocket / Reload pane).
      if (reloadDebugShouldPinProgress(true)) {
        const pin = Math.min(1, Math.max(0, Number(reloadDebugSocket.scrubT) || 0));
        this.reloadProgress = pin;
        this.reloadElapsed = pin * duration;
        this.reloadTimer = Math.max(0, duration - this.reloadElapsed);
      } else {
        this.reloadElapsed += dt;
        this.reloadProgress = duration > 0 ? Math.min(1, this.reloadElapsed / duration) : 1;
        this.reloadTimer = Math.max(0, duration - this.reloadElapsed);
      }

      // One-shot phase events as their thresholds are crossed (in order).
      const timing = this.reloadPhaseTiming;
      if (timing) {
        for (const phase of RELOAD_PHASE_ORDER) {
          const t = timing[phase];
          if (t == null || this._reloadPhasesFired.has(phase)) continue;
          if (this.reloadProgress >= t) {
            this._reloadPhasesFired.add(phase);
            events.push(phase);
          }
        }
        // Tactical refill happens the moment the fresh mag seats.
        if (this.reloadRefillAt === 'seat' && !this._ammoRefilled
          && timing.mag_seat != null && this.reloadProgress >= timing.mag_seat) {
          this._refillMag();
        }
      }

      // Never auto-complete while debug-pinned (scrub holds the pose).
      if (this.reloadProgress >= 1 && !reloadDebugShouldPinProgress(true)) {
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
    if (this.reserveAmmo <= 0) return false;

    // Tactical reloads are still useful at a full magazine: they run the
    // authored hand/magazine presentation cycle but `_refillMag` sees zero
    // room, so no rounds are created, lost, or consumed.

    this.state = GUN_STATE.reloading;
    this.reloadDuration = Math.max(0.1, this.stats.reloadTime || 1.5);
    this.reloadElapsed = 0;
    this.reloadProgress = 0;
    this.reloadTimer = this.reloadDuration;
    this._reloadPhasesFired.clear();
    this._ammoRefilled = false;
    this.needsPump = false;
    return true;
  }

  /** Move rounds from reserve into the magazine (once per reload). */
  _refillMag() {
    if (this._ammoRefilled) return;
    const room = this.stats.magazineSize - this.ammoInMag;
    const take = Math.min(room, this.reserveAmmo);
    this.ammoInMag += take;
    this.reserveAmmo -= take;
    this._ammoRefilled = true;
  }

  _finishReload() {
    this._refillMag();
    this.reloadTimer = 0;
    this.reloadElapsed = this.reloadDuration;
    this.reloadProgress = 1;
    this.state = GUN_STATE.idle;
    this.needsPump = false;
  }

  /**
   * Abort an in-progress reload. If the fresh mag has already seated (ammo
   * refilled), finish cleanly; otherwise roll back to idle with no ammo change
   * — the player keeps the partial magazine, nothing is lost or double-counted.
   */
  cancelReload() {
    if (!this.isReloading) return false;
    if (this._ammoRefilled) {
      this._finishReload();
    } else {
      this.state = GUN_STATE.idle;
      this.reloadTimer = 0;
      this.reloadElapsed = 0;
      this.reloadProgress = 0;
      this.needsPump = false;
    }
    this._reloadPhasesFired.clear();
    return true;
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
      reloadProgress: Number(this.reloadProgress.toFixed(3)),
      reloadPhase: this.reloadPhase,
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
