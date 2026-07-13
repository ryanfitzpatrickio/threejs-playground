// Per-archetype enemy configuration. Pure data (no three.js import) so it is
// importable from pure-node verify scripts.
//
// `boneScheme` is the low-level skeletal-topology key consumed by
// EnemyCutSystem.BONE_SCHEMES (ragdoll bone tables). The three *capability
// profiles* layer on top and replace the old literal `archetype === 'soldier'`
// gates in EnemySystem / EnemyCutSystem:
//   rigProfile      — animation/posture rig behaviour (split-action maps, mixamo posture blend)
//   cutProfile      — cut/ragdoll feel ('mixamo-skinned' squishy vs 'creature-rigid' baked chunks)
//   limbLossProfile — survivable partial-cut system ('mixamo-humanoid' vs null)
// `boneScheme` and the profiles align today (mixamo rig -> skinned cut -> humanoid
// limb loss) but are decoupled so a future rig can reuse a bone table with a
// different cut feel.
//
// Stats (maxHealth, moveSpeedScale, attackDamageScale) live here, NOT in the GLB,
// so balance changes do not rebuild assets.

export const ENEMY_ARCHETYPES = {
  // --- existing archetypes (migrated from EnemySystem.js) ---
  soldier: {
    url: '/assets/models/soldier.glb',
    boneScheme: 'mixamo',
    rigProfile: 'mixamo',
    cutProfile: 'mixamo-skinned',
    limbLossProfile: 'mixamo-humanoid',
    targetHeight: 1.85,
    groundOffset: -0.05,
    collisionHeight: 1.7,
    collisionRadius: 0.42,
    orientationFixX: -Math.PI / 2,
    fixMaterials: true,
    maxHealth: 100,
    moveSpeedScale: 1,
    attackDamageScale: 1,
  },
  robot: {
    url: '/assets/models/enemy1.glb',
    boneScheme: 'creature',
    rigProfile: 'creature',
    cutProfile: 'creature-rigid',
    limbLossProfile: null,
    targetHeight: 4.2,
    groundOffset: -0.28,
    collisionHeight: 3.45,
    collisionRadius: 1.05,
    orientationFixX: 0,
    fixMaterials: false,
    maxHealth: 100,
    moveSpeedScale: 1,
    attackDamageScale: 1,
  },

  // Matrix Highway M5 — trailer / platform fighter (soldier rig, lighter + a bit
  // quicker so greybox fights on a small bed stay readable).
  highwayGangMember: {
    url: '/assets/models/soldier.glb',
    boneScheme: 'mixamo',
    rigProfile: 'mixamo',
    cutProfile: 'mixamo-skinned',
    limbLossProfile: 'mixamo-humanoid',
    targetHeight: 1.85,
    groundOffset: -0.05,
    collisionHeight: 1.7,
    collisionRadius: 0.42,
    orientationFixX: -Math.PI / 2,
    fixMaterials: true,
    maxHealth: 80,
    moveSpeedScale: 0.92,
    attackDamageScale: 0.95,
  },

  // --- Horde archetypes (stubs). Stats from docs/horde-mode-plan.md; the
  //     geometry-derived fields (orientationFixX / groundOffset / targetHeight)
  //     are placeholders until M2 tunes them against the baked GLBs. These are
  //     NOT exercised by M1's lifecycle verify (which uses mock enemies). ---
  cyclop: {
    url: '/assets/models/horde/cyclop.glb',
    // Decimated skinned mesh for HordeProxySystem pose baking (see build-horde-robots-glb.py --proxy).
    proxyUrl: '/assets/models/horde/cyclop-proxy.glb',
    boneScheme: 'mixamo',
    rigProfile: 'mixamo',
    cutProfile: 'mixamo-skinned',
    limbLossProfile: 'mixamo-humanoid',
    targetHeight: 2.2,
    groundOffset: 0, // TBD (M2)
    collisionHeight: 2.0,
    collisionRadius: 0.5,
    orientationFixX: 0, // TBD (M2, after Blender bake)
    fixMaterials: false,
    maxHealth: 180,
    moveSpeedScale: 0.82,
    attackDamageScale: 1.35,
  },
  tessy: {
    url: '/assets/models/horde/tessy.glb',
    proxyUrl: '/assets/models/horde/tessy-proxy.glb',
    boneScheme: 'mixamo',
    rigProfile: 'mixamo',
    cutProfile: 'mixamo-skinned',
    limbLossProfile: 'mixamo-humanoid',
    targetHeight: 2.2,
    groundOffset: 0, // TBD (M2)
    collisionHeight: 2.0,
    collisionRadius: 0.5,
    orientationFixX: 0, // TBD (M2)
    fixMaterials: false,
    maxHealth: 140,
    moveSpeedScale: 0.9,
    attackDamageScale: 1.15,
  },
  faceless: {
    url: '/assets/models/horde/faceless.glb',
    proxyUrl: '/assets/models/horde/faceless-proxy.glb',
    boneScheme: 'mixamo',
    rigProfile: 'mixamo',
    cutProfile: 'mixamo-skinned',
    limbLossProfile: 'mixamo-humanoid',
    targetHeight: 2.0,
    groundOffset: 0, // TBD (M2)
    collisionHeight: 1.8,
    collisionRadius: 0.45,
    orientationFixX: 0, // TBD (M2)
    fixMaterials: false,
    maxHealth: 100,
    moveSpeedScale: 1.0,
    attackDamageScale: 1.0,
  },
};

const DEFAULTS = {
  moveSpeedScale: 1,
  attackDamageScale: 1,
  limbLossProfile: null,
  fixMaterials: false,
};

export function getArchetype(id) {
  const cfg = ENEMY_ARCHETYPES[id];
  if (!cfg) {
    throw new Error(`[enemyArchetypes] unknown archetype id: '${id}'`);
  }
  return { ...DEFAULTS, ...cfg };
}
