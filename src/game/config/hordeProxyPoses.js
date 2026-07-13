// Baked / low-poly pose catalog for HordeProxySystem (M2).
// Clip names match the retargeted Horde GLB contract (verify-horde-assets.mjs).
//
// Keep frames within one clip per anim family so pose-bucket swaps do not strobe
// (e.g. Walk → Run looked like flashing when agents hop InstancedMeshes).

export const HORDE_PROXY_POSE_CATALOG = Object.freeze([
  { key: 'idle_0', anim: 'idle', clipName: 'Idle Alert', sampleTime: 0 },
  { key: 'idle_1', anim: 'idle', clipName: 'Idle Alert', sampleTime: 1.0 },
  { key: 'advance_0', anim: 'advance', clipName: 'Walk', sampleTime: 0 },
  { key: 'advance_1', anim: 'advance', clipName: 'Walk', sampleTime: 0.33 },
  { key: 'advance_2', anim: 'advance', clipName: 'Walk', sampleTime: 0.66 },
  { key: 'attack_0', anim: 'attack', clipName: 'Bite', sampleTime: 0.15 },
  { key: 'attack_1', anim: 'attack', clipName: 'Bite', sampleTime: 0.45 },
  { key: 'attack_2', anim: 'attack', clipName: 'Bite', sampleTime: 0.75 },
  { key: 'hit_0', anim: 'hit', clipName: 'Idle Alert', sampleTime: 0 },
  { key: 'fallen_0', anim: 'fallen', clipName: 'Crawl Forward', sampleTime: 0.45 },
]);

export const HORDE_PROXY_ANIMS = Object.freeze(['idle', 'advance', 'attack', 'hit', 'fallen']);

/** Seconds between pose-frame hops within an anim (bucket swaps). */
export const HORDE_PROXY_POSE_HOLD = 0.18;

/** Pose keys grouped by anim for phase cycling. */
export const HORDE_PROXY_POSE_KEYS_BY_ANIM = Object.freeze(
  HORDE_PROXY_ANIMS.reduce((map, anim) => {
    map[anim] = HORDE_PROXY_POSE_CATALOG.filter((entry) => entry.anim === anim).map((entry) => entry.key);
    return map;
  }, {}),
);

export function meshKeyFor(archetype, poseKey) {
  return `${archetype}:${poseKey}`;
}

/**
 * @param {string} anim
 * @param {number} phaseTime cumulative seconds spent in this anim
 */
export function resolvePoseKey(anim, phaseTime = 0) {
  const keys = HORDE_PROXY_POSE_KEYS_BY_ANIM[anim] ?? HORDE_PROXY_POSE_KEYS_BY_ANIM.idle;
  if (!keys?.length) return 'idle_0';
  const frame = Math.floor(Math.max(0, phaseTime) / HORDE_PROXY_POSE_HOLD);
  return keys[frame % keys.length];
}
