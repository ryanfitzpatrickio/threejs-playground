/**
 * Per-kind gun stat tables (modernized from dust-and-bullets weapons.js profiles).
 * Subclasses + per-gun profile overrides layer on top of these defaults.
 */

export const GUN_FIRE_MODES = Object.freeze({
  auto: 'auto',
  semi: 'semi',
  pump: 'pump',
});

/** Kind-level defaults. Per-gun profiles override via statOverrides. */
export const GUN_KIND_DEFAULTS = Object.freeze({
  rifle: Object.freeze({
    weaponKind: 'rifle',
    animationPack: 'rifle',
    fireMode: GUN_FIRE_MODES.auto,
    damage: 22,
    fireRate: 9.5, // rounds per second
    spread: 0.022,
    adsSpreadMul: 0.45,
    magazineSize: 30,
    reserveMags: 4,
    reloadTime: 1.5,
    // Normalized reload phase breakpoints (t ∈ [0,1] over reloadTime), consumed
    // by the procedural reload (docs/advanced-reload-system-plan.md, AR0).
    // Drop/spawn early so the spent clip clears the well before the hand is far
    // down the belt path (live-fit 2026-07-11).
    reloadPhaseTiming: { mag_release: 0.10, mag_drop: 0.22, mag_spawn: 0.22, mag_seat: 0.62, charge: 0.93 },
    pellets: 1,
    recoil: 0.028,
    presentation: {
      muzzleFlash: { scale: 1, durationMs: 38, color: '#ffb15a', smoke: 0.32 },
      recoil: { cameraPitch: 0.017, cameraYaw: 0.004, weaponBack: 0.052, weaponPitch: 0.07, weaponYaw: 0.01, weaponRoll: 0.014, stiffness: 210, damping: 26, adsMultiplier: 0.72, maxAccumulation: 2.5 },
      shake: { amplitude: 0.28, durationMs: 68, frequency: 38 },
    },
    adsFov: 48,
    range: 120,
  }),
  pistol: Object.freeze({
    weaponKind: 'pistol',
    animationPack: 'pistol',
    fireMode: GUN_FIRE_MODES.semi,
    damage: 18,
    fireRate: 5.5,
    spread: 0.034,
    adsSpreadMul: 0.55,
    magazineSize: 15,
    reserveMags: 5,
    reloadTime: 1.45,
    // Pistol mag change is tighter/faster than a rifle; drop early like the rifle.
    reloadPhaseTiming: { mag_release: 0.10, mag_drop: 0.22, mag_spawn: 0.22, mag_seat: 0.80, charge: 0.90 },
    pellets: 1,
    recoil: 0.032,
    presentation: {
      muzzleFlash: { scale: 0.78, durationMs: 34, color: '#ffd08a', smoke: 0.22 },
      recoil: { cameraPitch: 0.02, cameraYaw: 0.005, weaponBack: 0.06, weaponPitch: 0.082, weaponYaw: 0.014, weaponRoll: 0.02, stiffness: 230, damping: 28, adsMultiplier: 0.7, maxAccumulation: 2.2 },
      shake: { amplitude: 0.24, durationMs: 58, frequency: 42 },
    },
    adsFov: 58,
    range: 55,
  }),
  shotgun: Object.freeze({
    weaponKind: 'shotgun',
    animationPack: 'rifle',
    fireMode: GUN_FIRE_MODES.pump,
    damage: 9,
    fireRate: 1.35,
    spread: 0.16,
    adsSpreadMul: 0.7,
    magazineSize: 6,
    reserveMags: 4,
    reloadTime: 0.55, // per-shell pump cycle time for state machine ticks
    pellets: 8,
    recoil: 0.055,
    presentation: {
      muzzleFlash: { scale: 1.65, durationMs: 45, color: '#ff9a42', smoke: 0.58 },
      recoil: { cameraPitch: 0.045, cameraYaw: 0.009, weaponBack: 0.105, weaponPitch: 0.14, weaponYaw: 0.022, weaponRoll: 0.03, stiffness: 160, damping: 22, adsMultiplier: 0.76, maxAccumulation: 1.7 },
      shake: { amplitude: 0.58, durationMs: 105, frequency: 31 },
    },
    adsFov: 52,
    range: 35,
    pumpRequired: true,
  }),
});

/** Optional per-catalog-id overrides (seeded stubs; Gunsmith can refine). */
export const GUN_ID_OVERRIDES = Object.freeze({
  'modern-ar15': { damage: 22, fireRate: 10, magazineSize: 30 },
  'desert-ar15': { damage: 23, fireRate: 9.2, magazineSize: 30 },
  'desert-scar': { damage: 26, fireRate: 7.5, magazineSize: 20, spread: 0.018 },
  ak47: { damage: 28, fireRate: 8.2, magazineSize: 30, spread: 0.03, recoil: 0.038 },
  'folding-stock-ar': { damage: 21, fireRate: 10.5, magazineSize: 30 },
  'obsidian-carbine': { damage: 20, fireRate: 11, magazineSize: 30, spread: 0.026 },
  'olive-bullpup': { damage: 24, fireRate: 9, magazineSize: 30, spread: 0.02 },
  'midnight-glock': { damage: 17, fireRate: 6.2, magazineSize: 17 },
  'tactical-shotgun': { damage: 10, fireRate: 1.2, pellets: 9, magazineSize: 7 },
  'desert-sentinel': {
    damage: 38,
    fireRate: 3.2,
    magazineSize: 10,
    spread: 0.012,
    fireMode: GUN_FIRE_MODES.semi,
    adsFov: 36,
  },
});

/**
 * Resolve final stats for a gun instance.
 * @param {{weaponKind?:string, statsId?:string, id?:string, statOverrides?:object}} profileOrOpts
 */
export function resolveGunStats(profileOrOpts = {}) {
  const kind = profileOrOpts.weaponKind
    || GUN_KIND_DEFAULTS[profileOrOpts.statsId]?.weaponKind
    || 'rifle';
  const base = GUN_KIND_DEFAULTS[kind] || GUN_KIND_DEFAULTS.rifle;
  const idKey = profileOrOpts.id || profileOrOpts.statsId || null;
  const idOverrides = (idKey && GUN_ID_OVERRIDES[idKey]) || {};
  const profileOverrides = profileOrOpts.statOverrides || {};
  const presentation = {
    ...(base.presentation ?? {}),
    ...(idOverrides.presentation ?? {}),
    ...(profileOverrides.presentation ?? {}),
    muzzleFlash: { ...(base.presentation?.muzzleFlash ?? {}), ...(idOverrides.presentation?.muzzleFlash ?? {}), ...(profileOverrides.presentation?.muzzleFlash ?? {}) },
    recoil: { ...(base.presentation?.recoil ?? {}), ...(idOverrides.presentation?.recoil ?? {}), ...(profileOverrides.presentation?.recoil ?? {}) },
    shake: { ...(base.presentation?.shake ?? {}), ...(idOverrides.presentation?.shake ?? {}), ...(profileOverrides.presentation?.shake ?? {}) },
  };

  return {
    ...base,
    ...idOverrides,
    ...profileOverrides,
    weaponKind: kind,
    presentation,
  };
}

export function listGunKindIds() {
  return Object.keys(GUN_KIND_DEFAULTS);
}
