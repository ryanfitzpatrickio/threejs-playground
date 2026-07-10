/**
 * Player ability loadout — equip one at a time (like a gun), activate with F.
 */

export const ABILITY_CATALOG = Object.freeze([
  Object.freeze({
    id: 'swing',
    label: 'Grapple Swing',
    shortLabel: 'SWING',
    description: 'Fire grappling hooks (F / middle-click). Hold Alt to aim. Holster weapons with Z for free hands.',
  }),
  Object.freeze({
    id: 'wingsuit',
    label: 'Wingsuit',
    shortLabel: 'GLIDE',
    description: 'Deploy / retract the wingsuit in the air (F). Double-tap Space also works while equipped.',
  }),
]);

export const DEFAULT_ABILITY_ID = ABILITY_CATALOG[0]?.id ?? 'swing';

export function findAbility(id) {
  return ABILITY_CATALOG.find((a) => a.id === id) ?? null;
}

export function abilityIndex(id) {
  const idx = ABILITY_CATALOG.findIndex((a) => a.id === id);
  return idx >= 0 ? idx : 0;
}
