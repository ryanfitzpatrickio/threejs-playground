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
    reloadTime: 2.1,
    pellets: 1,
    recoil: 0.028,
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
    pellets: 1,
    recoil: 0.032,
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

  return {
    ...base,
    ...idOverrides,
    ...profileOverrides,
    weaponKind: kind,
  };
}

export function listGunKindIds() {
  return Object.keys(GUN_KIND_DEFAULTS);
}
