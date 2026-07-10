export const PLAYER_MODEL_IDS = Object.freeze({
  // Default body: Mixamo-compatible T-pose mesh driven by external Mixamo clips.
  PLAYER: 'player',
  // Previous Mara/climber body (Tripo mesh on Mixamo skeleton). Kept for A/B.
  CLIMBER: 'climber',
  // Legacy query alias (?playerModel=mixamo) → climber.
  MIXAMO: 'mixamo',
  MESH2MOTION: 'mesh2motion',
});

const CLIMBER_PROFILE = Object.freeze({
  id: PLAYER_MODEL_IDS.CLIMBER,
  label: 'Climber (Mara)',
  url: '/assets/models/climber.glb',
  format: 'glb',
  skeletonSource: 'mixamo',
  // Tripo FBX→GLB left a residual +90° X on armature/mesh; counter-rotate at load.
  standUpright: true,
});

export const PLAYER_MODEL_PROFILES = Object.freeze({
  [PLAYER_MODEL_IDS.PLAYER]: Object.freeze({
    id: PLAYER_MODEL_IDS.PLAYER,
    label: 'Player',
    url: '/assets/models/newplayerv3.glb',
    format: 'glb',
    skeletonSource: 'mixamo',
    // Mixamo GLB: Armature +90° with hips rest −90° cancel at rest, but clips
    // overwrite hips and leave the body face-down. −90° after normalize fixes it.
    standUpright: true,
    standUprightAfterNormalize: true,
  }),
  [PLAYER_MODEL_IDS.CLIMBER]: CLIMBER_PROFILE,
  // Back-compat for ?playerModel=mixamo and older bookmarks.
  [PLAYER_MODEL_IDS.MIXAMO]: Object.freeze({
    ...CLIMBER_PROFILE,
    id: PLAYER_MODEL_IDS.MIXAMO,
  }),
  [PLAYER_MODEL_IDS.MESH2MOTION]: Object.freeze({
    id: PLAYER_MODEL_IDS.MESH2MOTION,
    label: 'Mesh2Motion Player',
    url: '/assets/models/playernew-mesh2motion.glb',
    format: 'glb',
    skeletonSource: 'mesh2motion',
    standUpright: false,
  }),
});

export function getPlayerModelProfile(id) {
  return PLAYER_MODEL_PROFILES[id] ?? PLAYER_MODEL_PROFILES[PLAYER_MODEL_IDS.PLAYER];
}
