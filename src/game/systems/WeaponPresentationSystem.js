import * as THREE from 'three';
import { createMuzzleFlashRenderer } from '../render/createMuzzleFlashRenderer.js';
import { createMuzzleBounceRenderer } from '../render/createMuzzleBounceRenderer.js';
import { createWeaponImpactRenderer } from '../render/createWeaponImpactRenderer.js';
import { createBulletDecalRenderer } from '../render/createBulletDecalRenderer.js';

/** Weapon self-illumination pulse: how long the emissive flash lasts and how
 * hard it boosts each gun material's emissiveIntensity at the trigger frame. */
const WEAPON_FLASH_TIME = 0.06;
const WEAPON_FLASH_BOOST = 2.4;

const DEFAULT_PRESENTATION = Object.freeze({
  muzzleFlash: { scale: 1, durationMs: 42, color: '#ffb15a', smoke: 0.35 },
  recoil: {
    cameraPitch: 0.018, cameraYaw: 0.004, weaponBack: 0.055, weaponPitch: 0.075,
    weaponYaw: 0.012, weaponRoll: 0.018, stiffness: 210, damping: 26, adsMultiplier: 0.72,
    maxAccumulation: 2.5,
  },
  shake: { amplitude: 0.35, durationMs: 75, frequency: 38 },
});

/** Presentation-only firearm effects. It never resolves hits or mutates ammo. */
export class WeaponPresentationSystem {
  constructor() {
    this.muzzleFlash = null;
    this.bounceRenderer = null;
    this.impactRenderer = null;
    this.decalRenderer = null;
    this.weapon = { back: 0, pitch: 0, yaw: 0, roll: 0, backVelocity: 0, pitchVelocity: 0, yawVelocity: 0, rollVelocity: 0, stiffness: 210, damping: 26 };
    // Weapon self-illumination: emissive pulse on the equipped gun's materials,
    // faking the muzzle light on the one object it mattered most for.
    this._weaponFlash = { root: null, mats: [], pulse: 0, color: new THREE.Color('#ffb15a') };
  }

  initialize(scene) {
    if (scene) {
      this.muzzleFlash = createMuzzleFlashRenderer(scene);
      this.bounceRenderer = createMuzzleBounceRenderer(scene);
      this.impactRenderer = createWeaponImpactRenderer(scene);
      this.decalRenderer = createBulletDecalRenderer(scene);
    }
  }

  presentShot({ gun, muzzlePosition, aimDirection, cameraSystem, gunRoot, ads = 0, bounce = null } = {}) {
    const profile = resolvePresentation(gun?.stats?.presentation);
    const multiplier = ads > 0.5 ? profile.recoil.adsMultiplier : 1;
    this.weapon.stiffness = Number(profile.recoil.stiffness) || 210;
    this.weapon.damping = Number(profile.recoil.damping) || 26;
    this.muzzleFlash?.spawn({
      position: muzzlePosition,
      direction: aimDirection,
      ...profile.muzzleFlash,
    });
    // Emissive pop on the gun (self-illumination) + a projected glow on the
    // nearest surface the shot pointed at (environment bounce) — both replace
    // the old dynamic muzzle light far more cheaply.
    this._pulseWeaponFlash(gunRoot, profile.muzzleFlash.color);
    if (bounce) {
      this.bounceRenderer?.spawn({
        point: bounce.point,
        normal: bounce.normal,
        distance: bounce.distance,
        color: profile.muzzleFlash.color,
        scale: profile.muzzleFlash.scale,
      });
    }
    cameraSystem?.addWeaponPresentationImpulse?.({
      pitch: profile.recoil.cameraPitch * multiplier,
      yaw: (Math.random() * 2 - 1) * profile.recoil.cameraYaw * multiplier,
      shake: profile.shake,
    });
    const cap = Math.max(0.1, profile.recoil.maxAccumulation);
    this.weapon.back = Math.min(cap * profile.recoil.weaponBack, this.weapon.back + profile.recoil.weaponBack * multiplier);
    this.weapon.pitch = Math.min(cap * profile.recoil.weaponPitch, this.weapon.pitch + profile.recoil.weaponPitch * multiplier);
    this.weapon.yaw = clamp(this.weapon.yaw + (Math.random() * 2 - 1) * profile.recoil.weaponYaw * multiplier, cap * profile.recoil.weaponYaw);
    this.weapon.roll = clamp(this.weapon.roll + (Math.random() * 2 - 1) * profile.recoil.weaponRoll * multiplier, cap * profile.recoil.weaponRoll);
    this._applyWeaponKick(gunRoot);
  }

  update({ delta, camera, gunRoot } = {}) {
    const dt = Math.max(0, Number(delta) || 0);
    this.muzzleFlash?.update(dt, camera);
    this.bounceRenderer?.update(dt);
    this.impactRenderer?.update(dt);
    this.decalRenderer?.update(dt);
    this._updateWeaponFlash(dt);
    // A stable critically damped spring: direct trigger-frame displacement, then
    // quick, non-snapping return that naturally accumulates under automatic fire.
    const { stiffness, damping } = this.weapon;
    for (const key of ['back', 'pitch', 'yaw', 'roll']) {
      const velocityKey = `${key}Velocity`;
      this.weapon[velocityKey] += (-stiffness * this.weapon[key] - damping * this.weapon[velocityKey]) * dt;
      this.weapon[key] += this.weapon[velocityKey] * dt;
      if (Math.abs(this.weapon[key]) < 1e-5 && Math.abs(this.weapon[velocityKey]) < 1e-4) {
        this.weapon[key] = 0;
        this.weapon[velocityKey] = 0;
      }
    }
    this._applyWeaponKick(gunRoot);
  }

  presentImpact({ point, normal, incomingDirection, surfaceClass = 'generic', intensity = 1 } = {}) {
    this.impactRenderer?.spawn({ point, normal, incomingDirection, surfaceClass, intensity });
    this.decalRenderer?.spawn({ point, normal, surfaceClass, intensity });
  }

  /**
   * Cache the equipped gun's emissive-capable materials (re-caching when the
   * weapon swaps) and kick off a full-strength self-illumination pulse.
   */
  _pulseWeaponFlash(gunRoot, color) {
    const flash = this._weaponFlash;
    if (flash.root !== gunRoot) {
      this._restoreWeaponFlashMats();
      flash.root = gunRoot ?? null;
      if (gunRoot) {
        gunRoot.traverse((obj) => {
          if (!obj.isMesh) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) {
            if (!mat?.emissive || mat.userData?._muzzleFlashTracked) continue;
            mat.userData._muzzleFlashTracked = true;
            flash.mats.push({
              mat,
              baseIntensity: Number.isFinite(mat.emissiveIntensity) ? mat.emissiveIntensity : 1,
              baseEmissive: mat.emissive.clone(),
            });
          }
        });
      }
    }
    if (color) flash.color.set(color);
    flash.pulse = 1;
    // Apply on the trigger frame so the gun lights up the instant it fires,
    // matching the muzzle flash core (the decay then runs from update()).
    this._applyWeaponFlashLevel(1);
  }

  _updateWeaponFlash(dt) {
    const flash = this._weaponFlash;
    if (flash.pulse <= 0) return;
    flash.pulse = Math.max(0, flash.pulse - dt / WEAPON_FLASH_TIME);
    this._applyWeaponFlashLevel(flash.pulse);
  }

  _applyWeaponFlashLevel(p) {
    const flash = this._weaponFlash;
    for (const entry of flash.mats) {
      entry.mat.emissive.copy(entry.baseEmissive).lerp(flash.color, p);
      entry.mat.emissiveIntensity = entry.baseIntensity + p * WEAPON_FLASH_BOOST;
    }
  }

  _restoreWeaponFlashMats() {
    for (const entry of this._weaponFlash.mats) {
      entry.mat.emissive.copy(entry.baseEmissive);
      entry.mat.emissiveIntensity = entry.baseIntensity;
      if (entry.mat.userData) entry.mat.userData._muzzleFlashTracked = false;
    }
    this._weaponFlash.mats = [];
    this._weaponFlash.pulse = 0;
  }

  _applyWeaponKick(gunRoot) {
    if (!gunRoot) return;
    gunRoot.userData.weaponKickZ = this.weapon.back;
    gunRoot.userData.weaponKickPitch = this.weapon.pitch;
    gunRoot.userData.weaponKickYaw = this.weapon.yaw;
    gunRoot.userData.weaponKickRoll = this.weapon.roll;
  }

  snapshot() {
    return {
      weaponBack: Number(this.weapon.back.toFixed(4)),
      weaponPitch: Number(this.weapon.pitch.toFixed(4)),
      activeMuzzleFlashes: this.muzzleFlash?.slots.filter((slot) => slot.life > 0).length ?? 0,
      activeBounces: this.bounceRenderer?.slots.filter((slot) => slot.life > 0).length ?? 0,
      weaponFlashPulse: Number(this._weaponFlash.pulse.toFixed(3)),
      activeImpacts: this.impactRenderer?.slots.filter((slot) => slot.life > 0).length ?? 0,
      activeDecals: this.decalRenderer?.slots.filter((slot) => slot.life > 0).length ?? 0,
    };
  }

  dispose() {
    this._restoreWeaponFlashMats();
    this._weaponFlash.root = null;
    this.muzzleFlash?.dispose();
    this.bounceRenderer?.dispose();
    this.impactRenderer?.dispose();
    this.decalRenderer?.dispose();
    this.muzzleFlash = null;
    this.bounceRenderer = null;
    this.impactRenderer = null;
    this.decalRenderer = null;
  }
}

export function resolvePresentation(value = null) {
  return {
    muzzleFlash: { ...DEFAULT_PRESENTATION.muzzleFlash, ...(value?.muzzleFlash ?? {}) },
    recoil: { ...DEFAULT_PRESENTATION.recoil, ...(value?.recoil ?? {}) },
    shake: { ...DEFAULT_PRESENTATION.shake, ...(value?.shake ?? {}) },
  };
}

function clamp(value, maximum) {
  return Math.max(-maximum, Math.min(maximum, value));
}
