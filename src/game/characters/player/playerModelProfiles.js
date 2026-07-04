export const PLAYER_MODEL_IDS = Object.freeze({
  MIXAMO: 'mixamo',
  MESH2MOTION: 'mesh2motion',
});

export const PLAYER_MODEL_PROFILES = Object.freeze({
  [PLAYER_MODEL_IDS.MIXAMO]: Object.freeze({
    id: PLAYER_MODEL_IDS.MIXAMO,
    label: 'Climber',
    url: '/assets/models/climber.glb',
    format: 'glb',
    skeletonSource: 'mixamo',
  }),
  [PLAYER_MODEL_IDS.MESH2MOTION]: Object.freeze({
    id: PLAYER_MODEL_IDS.MESH2MOTION,
    label: 'Mesh2Motion Player',
    url: '/assets/models/playernew-mesh2motion.glb',
    format: 'glb',
    skeletonSource: 'mesh2motion',
  }),
});

export function getPlayerModelProfile(id) {
  return PLAYER_MODEL_PROFILES[id] ?? PLAYER_MODEL_PROFILES[PLAYER_MODEL_IDS.MIXAMO];
}
