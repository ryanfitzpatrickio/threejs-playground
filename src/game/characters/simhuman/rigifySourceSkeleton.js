import * as THREE from 'three';
import {
  RIGIFY_HEAD_BONE,
  RIGIFY_HIP_BONE,
  toRuntimeRigifyBoneName,
} from './rigifySkeleton.js';

export const RIGIFY_ANIMATION_MANIFEST_URL = '/assets/animations-rigify/manifest.json';

/** Body alias → retargeted clip pack (manifest URL). Missing packs fall back to human5. */
export const RIGIFY_ANIMATION_PACKS = Object.freeze({
  human5: '/assets/animations-rigify/manifest.json',
  default: '/assets/animations-rigify/manifest.json',
  male: '/assets/animations-rigify-ubc-male/manifest.json',
  'ubc-male': '/assets/animations-rigify-ubc-male/manifest.json',
  superhero_male: '/assets/animations-rigify-ubc-male/manifest.json',
  female: '/assets/animations-rigify-ubc-female/manifest.json',
  'ubc-female': '/assets/animations-rigify-ubc-female/manifest.json',
  superhero_female: '/assets/animations-rigify-ubc-female/manifest.json',
});

export function resolveRigifyAnimationManifestUrl(bodyAlias = null) {
  if (!bodyAlias) return RIGIFY_ANIMATION_MANIFEST_URL;
  const key = String(bodyAlias).trim();
  return RIGIFY_ANIMATION_PACKS[key] ?? RIGIFY_ANIMATION_MANIFEST_URL;
}

const ROUTES = Object.freeze({
  idle: Object.freeze({ clip: 'idle', loop: true, fadeIn: 0.2 }),
  walk: Object.freeze({ clip: 'walking', loop: true, fadeIn: 0.16 }),
  jog: Object.freeze({ clip: 'running', loop: true, fadeIn: 0.14 }),
  turnLeft: Object.freeze({ clip: 'left turn', loop: false, fadeIn: 0.12 }),
  turnRight: Object.freeze({ clip: 'right turn', loop: false, fadeIn: 0.12 }),
});

// Profile-shaped description kept separate from player/sourceSkeletons.js: sim
// clips are already retargeted offline and should never enter the Mixamo player
// routing path.
export const RIGIFY_SOURCE_SKELETON = Object.freeze({
  id: 'rigify',
  animationLibrary: 'retargeted',
  bones: Object.freeze({
    hips: RIGIFY_HIP_BONE,
    spine: toRuntimeRigifyBoneName('DEF-spine.001'),
    chest: toRuntimeRigifyBoneName('DEF-spine.003'),
    neck: toRuntimeRigifyBoneName('DEF-spine.005'),
    head: RIGIFY_HEAD_BONE,
    leftHand: toRuntimeRigifyBoneName('DEF-hand.L'),
    rightHand: toRuntimeRigifyBoneName('DEF-hand.R'),
    leftFoot: toRuntimeRigifyBoneName('DEF-foot.L'),
    rightFoot: toRuntimeRigifyBoneName('DEF-foot.R'),
  }),
  resolveAnimation(action) {
    return ROUTES[action] ?? null;
  },
});

export function listRigifyAnimationActions() {
  return Object.keys(ROUTES);
}

/**
 * Load the generated JSON clips into the Map shape MaraAnimationController accepts.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string|null} [options.manifestUrl] absolute pack manifest URL
 * @param {string|null} [options.bodyAlias] body alias (male/female/human5) → pack
 * @param {boolean} [options.fallbackToDefault] if pack 404, load human5 pack
 */
export async function loadRigifyAnimationClips({
  fetchImpl = globalThis.fetch,
  manifestUrl = null,
  bodyAlias = null,
  fallbackToDefault = true,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to load Rigify animations');
  }

  const primary = manifestUrl ?? resolveRigifyAnimationManifestUrl(bodyAlias);
  let resolvedManifestUrl = primary;
  let manifestResponse = await fetchImpl(primary);
  if (!manifestResponse.ok && fallbackToDefault && primary !== RIGIFY_ANIMATION_MANIFEST_URL) {
    console.warn(
      `[simhuman] animation pack missing (${primary} → ${manifestResponse.status}); `
      + 'falling back to human5 pack + arm-space adapter',
    );
    resolvedManifestUrl = RIGIFY_ANIMATION_MANIFEST_URL;
    manifestResponse = await fetchImpl(resolvedManifestUrl);
  }
  if (!manifestResponse.ok) {
    throw new Error(`Rigify manifest load failed: ${manifestResponse.status}`);
  }
  const manifest = await manifestResponse.json();
  const byName = new Map((manifest.animations ?? []).map((entry) => [entry.name, entry]));
  const clips = new Map();

  await Promise.all(Object.entries(ROUTES).map(async ([action, route]) => {
    const entry = byName.get(route.clip);
    if (!entry?.clipUrl) throw new Error(`Rigify manifest is missing clip: ${route.clip}`);
    const response = await fetchImpl(entry.clipUrl);
    if (!response.ok) throw new Error(`Rigify clip load failed (${action}): ${response.status}`);
    clips.set(action, {
      ...route,
      clip: THREE.AnimationClip.parse(await response.json()),
    });
  }));

  clips.manifestUrl = resolvedManifestUrl;
  clips.usedFallback = resolvedManifestUrl !== primary;
  return clips;
}
