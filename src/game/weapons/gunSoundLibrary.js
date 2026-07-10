/**
 * Curated gun interaction sounds available to runtime profiles and Gunsmith.
 *
 * Keep gameplay fire on single-shot recordings. Burst/spray source recordings
 * do not stay synchronized with BaseGun's per-round fire-rate state machine.
 */

const RIFLE_AUDIO_ROOT = '/assets/audio/weapons/rifles';
const PISTOL_AUDIO_ROOT = '/assets/audio/weapons/pistols';
const SHOTGUN_AUDIO_ROOT = '/assets/audio/weapons/shotguns';
const ORIGINAL_PACK = "Snake's Authentic Gun Sounds";
const SECOND_PACK = "Snake's SECOND Authentic Gun Sounds";

export const GUN_SOUND_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'gunfire', label: 'Gunshots' }),
  Object.freeze({ id: 'reload', label: 'Reload sequences' }),
  Object.freeze({ id: 'mechanical', label: 'Cycling & controls' }),
]);

export const GUN_SOUND_INTERACTIONS = Object.freeze([
  Object.freeze({
    id: 'fire',
    label: 'Fire',
    group: 'Shooting',
    categories: Object.freeze(['gunfire']),
  }),
  Object.freeze({
    id: 'reloadStart',
    label: 'Reload',
    group: 'Reloading',
    categories: Object.freeze(['reload']),
  }),
  Object.freeze({
    id: 'reloadComplete',
    label: 'Reload complete',
    group: 'Reloading',
    categories: Object.freeze(['reload', 'mechanical']),
  }),
  Object.freeze({
    id: 'pump',
    label: 'Pump action',
    group: 'Mechanics',
    categories: Object.freeze(['mechanical']),
  }),
  Object.freeze({
    id: 'dryFire',
    label: 'Dry fire',
    group: 'Mechanics',
    categories: Object.freeze(['mechanical']),
  }),
]);

export const GUN_SOUND_LIBRARY = Object.freeze([
  sound('snake-556-single-full', '5.56 single — full', 'gunfire', '556-single-full.mp3', 0.56, 12, ['fire']),
  sound('snake-556-single-isolated', '5.56 single — isolated', 'gunfire', '556-single-isolated.mp3', 0.62, 12, ['fire']),
  sound('snake-308-single-full', '.308 single — full', 'gunfire', '308-single-full.mp3', 0.54, 12, ['fire']),
  sound('snake-308-single-isolated', '.308 single — isolated', 'gunfire', '308-single-isolated.mp3', 0.58, 12, ['fire']),
  sound('snake-762x39-single-full', '7.62×39 single — full', 'gunfire', '762x39-single-full.mp3', 0.54, 12, ['fire']),
  sound('snake-762x39-single-isolated', '7.62×39 single — isolated', 'gunfire', '762x39-single-isolated.mp3', 0.6, 12, ['fire']),
  sound('snake-762x54r-single-full', '7.62×54R single — full', 'gunfire', '762x54r-single-full.mp3', 0.5, 12, ['fire']),
  sound('snake-762x54r-single-isolated', '7.62×54R single — isolated', 'gunfire', '762x54r-single-isolated.mp3', 0.56, 12, ['fire']),
  sound('snake-9mm-single-full', '9 mm single — full', 'gunfire', '9mm-single-full.mp3', 0.56, 12, ['fire'], PISTOL_AUDIO_ROOT, SECOND_PACK),
  sound('snake-9mm-single-isolated', '9 mm single — isolated', 'gunfire', '9mm-single-isolated.mp3', 0.6, 12, ['fire'], PISTOL_AUDIO_ROOT, SECOND_PACK),
  sound('snake-20g-single-full', '20 gauge single — full', 'gunfire', '20g-single-full.mp3', 0.52, 4, ['fire'], SHOTGUN_AUDIO_ROOT, SECOND_PACK),
  sound('snake-20g-single-isolated', '20 gauge single — isolated', 'gunfire', '20g-single-isolated.mp3', 0.56, 4, ['fire'], SHOTGUN_AUDIO_ROOT, SECOND_PACK),

  sound('snake-ar-reload-full', 'AR reload — full', 'reload', 'ar-reload-full.mp3', 0.78, 2, ['reloadStart']),
  sound('snake-ar-reload-part-1', 'AR reload — part 1', 'reload', 'ar-reload-part-1.mp3', 0.78, 2, ['reloadStart']),
  sound('snake-ar-reload-part-2', 'AR reload — part 2', 'reload', 'ar-reload-part-2.mp3', 0.78, 2, ['reloadStart', 'reloadComplete']),
  sound('snake-ak-reload-full', 'AK reload — full', 'reload', 'ak-reload-full.mp3', 0.76, 2, ['reloadStart']),
  sound('snake-308-magazine-full', '.308 magazine — full', 'reload', '308-magazine-full.mp3', 0.76, 2, ['reloadStart']),
  sound('snake-9mm-pistol-reload', '9 mm pistol reload', 'reload', '9mm-pistol-reload.mp3', 0.8, 2, ['reloadStart'], PISTOL_AUDIO_ROOT, SECOND_PACK),
  sound('snake-pump-shell-load', 'Pump shotgun shell load', 'reload', 'pump-shell-load.mp3', 0.82, 3, ['reloadStart'], SHOTGUN_AUDIO_ROOT, SECOND_PACK),

  sound('snake-ar-charging-handle', 'AR charging handle', 'mechanical', 'ar-charging-handle.mp3', 0.82, 3, ['reloadComplete']),
  sound('snake-ar-bolt-release', 'AR bolt release', 'mechanical', 'ar-bolt-release.mp3', 0.82, 3, ['reloadComplete']),
  sound('snake-ak-rack', 'AK rack', 'mechanical', 'ak-rack.mp3', 0.8, 3, ['reloadComplete']),
  sound('snake-308-bolt-cycle', '.308 bolt cycle', 'mechanical', '308-bolt-cycle.mp3', 0.8, 3, ['reloadComplete']),
  sound('snake-mosin-bolt-cycle', 'Mosin bolt cycle', 'mechanical', 'mosin-bolt-cycle.mp3', 0.8, 3, ['reloadComplete']),
  sound('snake-9mm-pistol-slide-release', '9 mm pistol slide release', 'mechanical', '9mm-pistol-slide-release.mp3', 0.82, 3, ['reloadComplete'], PISTOL_AUDIO_ROOT, SECOND_PACK),
  sound('snake-9mm-pistol-dry-fire', '9 mm pistol dry fire', 'mechanical', '9mm-pistol-dry-fire.mp3', 0.72, 4, ['dryFire'], PISTOL_AUDIO_ROOT, SECOND_PACK),
  sound('snake-pump-cycle', 'Pump shotgun cycle', 'mechanical', 'pump-cycle.mp3', 0.8, 3, ['reloadComplete', 'pump'], SHOTGUN_AUDIO_ROOT, ORIGINAL_PACK),
]);

const SOUND_BY_ID = new Map(GUN_SOUND_LIBRARY.map((entry) => [entry.id, entry]));

const EMPTY_ASSIGNMENTS = Object.freeze(Object.fromEntries(
  GUN_SOUND_INTERACTIONS.map((interaction) => [interaction.id, '']),
));

const DEFAULT_ASSIGNMENTS_BY_GUN = Object.freeze({
  'modern-ar15': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-556-single-isolated',
    reloadStart: 'snake-ar-reload-full',
    reloadComplete: 'snake-ar-bolt-release',
  }),
  'desert-ar15': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-556-single-full',
    reloadStart: 'snake-ar-reload-full',
    reloadComplete: 'snake-ar-bolt-release',
  }),
  'desert-scar': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-308-single-full',
    reloadStart: 'snake-308-magazine-full',
    reloadComplete: 'snake-308-bolt-cycle',
  }),
  ak47: Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-762x39-single-full',
    reloadStart: 'snake-ak-reload-full',
    reloadComplete: 'snake-ak-rack',
  }),
  'folding-stock-ar': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-556-single-isolated',
    reloadStart: 'snake-ar-reload-full',
    reloadComplete: 'snake-ar-charging-handle',
  }),
  'obsidian-carbine': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-556-single-isolated',
    reloadStart: 'snake-ar-reload-full',
    reloadComplete: 'snake-ar-bolt-release',
  }),
  'olive-bullpup': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-556-single-full',
    reloadStart: 'snake-ar-reload-full',
    reloadComplete: 'snake-ar-charging-handle',
  }),
  'midnight-glock': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-9mm-single-full',
    reloadStart: 'snake-9mm-pistol-reload',
    reloadComplete: 'snake-9mm-pistol-slide-release',
    dryFire: 'snake-9mm-pistol-dry-fire',
  }),
  'tactical-shotgun': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-20g-single-full',
    reloadStart: 'snake-pump-shell-load',
    reloadComplete: 'snake-pump-cycle',
    pump: 'snake-pump-cycle',
  }),
  'desert-sentinel': Object.freeze({
    ...EMPTY_ASSIGNMENTS,
    fire: 'snake-762x54r-single-full',
    reloadStart: 'snake-308-magazine-full',
    reloadComplete: 'snake-mosin-bolt-cycle',
  }),
});

export function getGunSound(soundId) {
  return SOUND_BY_ID.get(soundId) ?? null;
}

export function getGunSoundsForInteraction(interactionId) {
  const interaction = GUN_SOUND_INTERACTIONS.find((entry) => entry.id === interactionId);
  if (!interaction) return [];
  return GUN_SOUND_LIBRARY.filter((soundEntry) => (
    interaction.categories.includes(soundEntry.category)
    && soundEntry.interactions.includes(interactionId)
  ));
}

export function defaultGunSoundAssignments(gunId) {
  return {
    ...EMPTY_ASSIGNMENTS,
    ...(DEFAULT_ASSIGNMENTS_BY_GUN[gunId] || {}),
  };
}

export function normalizeGunSoundAssignments(raw, gunId) {
  const defaults = defaultGunSoundAssignments(gunId);
  if (!raw || typeof raw !== 'object') return defaults;

  const normalized = { ...defaults };
  for (const interaction of GUN_SOUND_INTERACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(raw, interaction.id)) continue;
    const value = typeof raw[interaction.id] === 'string' ? raw[interaction.id] : '';
    const compatible = value && getGunSoundsForInteraction(interaction.id)
      .some((soundEntry) => soundEntry.id === value);
    normalized[interaction.id] = compatible ? value : '';
  }
  return normalized;
}

function sound(
  id,
  label,
  category,
  fileName,
  volume,
  maxVoices,
  interactions,
  audioRoot = RIFLE_AUDIO_ROOT,
  source = ORIGINAL_PACK,
) {
  return Object.freeze({
    id,
    label,
    category,
    url: `${audioRoot}/${fileName}`,
    volume,
    maxVoices,
    interactions: Object.freeze([...interactions]),
    source,
  });
}
