/**
 * Unified weapon loadout: great sword + gun catalog.
 * Hotkeys: 1 sword, 2 pistol, 3 random non-pistol gun; Z holsters / draws.
 */

import { GUN_CATALOG } from './gunProfile.js';

export const SWORD_WEAPON_ID = 'sword';

export const SWORD_WEAPON = Object.freeze({
  id: SWORD_WEAPON_ID,
  label: 'Great Sword',
  shortLabel: 'SWORD',
  kind: 'sword',
});

/** @type {ReadonlyArray<{ id: string, label: string, shortLabel?: string, kind: 'sword'|'rifle'|'pistol'|'shotgun'|string, glbUrl?: string, weaponKind?: string }>} */
export const WEAPON_CATALOG = Object.freeze([
  SWORD_WEAPON,
  ...GUN_CATALOG.map((g) => Object.freeze({
    ...g,
    shortLabel: (g.label || g.id).toUpperCase().slice(0, 12),
    kind: g.weaponKind || 'rifle',
  })),
]);

export const DEFAULT_WEAPON_ID = SWORD_WEAPON_ID;

export function findWeapon(id) {
  return WEAPON_CATALOG.find((w) => w.id === id) ?? null;
}

export function weaponIndex(id) {
  const idx = WEAPON_CATALOG.findIndex((w) => w.id === id);
  return idx >= 0 ? idx : 0;
}

export function isSwordWeaponId(id) {
  return id === SWORD_WEAPON_ID;
}

export function isGunWeaponId(id) {
  return Boolean(id && id !== SWORD_WEAPON_ID && findWeapon(id));
}
