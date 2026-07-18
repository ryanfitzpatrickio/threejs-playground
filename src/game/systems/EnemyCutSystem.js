import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  clipGeometryByPlane,
  clipGeometryPairByPlane,
  getPlaneInObjectSpace,
  isViableCutGeometry,
  planeCutsGeometry,
} from '../geometry/clipGeometryByPlane.js';
import { bakeSkinnedModelGeometry } from '../geometry/bakeSkinnedModelGeometry.js';
import { vertexKeyNum } from '../geometry/vertexKey.js';
import { createDynamicMeshColliderDesc } from '../physics/createDynamicMeshColliderDesc.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createJaggedMetalCapMaterial } from '../materials/createJaggedMetalCapMaterial.js';
import {
  applySeveranceFromProps,
  createSoldierLimbState,
  decideSoldierCutOutcome,
  mergeLimbLoss,
} from './soldierPartialCut.js';

const CUT_ARC_RADIUS = 8.5;
const CUT_ARC_HALF_HEIGHT = 3.5;
const CUT_ROTATE_SPEED = 2.2;
const CUT_PLANE_SIZE = CUT_ARC_RADIUS * 2.05;
const CUT_ARC_BAND_WIDTH = 0.13;
const CHUNK_SEPARATION = 0.32;
const PROP_MIN_HALF_EXTENT = 0.035;
const RAGDOLL_BASE_HEIGHT = 2.7;
const RAGDOLL_SIDE_MARGIN = 0.18;
const RAGDOLL_IMPULSE = 0.55;
const RAGDOLL_UPWARD_IMPULSE = 0.22;
const RAGDOLL_MAX_BODIES_PER_HALF = 9;
const MAX_MULTI_CUT_RIG_SHARDS = 4;
// A single bisect of the robot yields ~30 disconnected pieces (every armor plate
// and limb segment is its own connected component). 12 was far too low — the
// over-budget eviction fired on the first frame and, picking "oldest" with all
// pieces the same age, culled in array order and deleted the big torso halves.
// 24 fits a full robot cut; smallest-first eviction (below) keeps the important
// pieces if this is ever exceeded.
let MAX_CUT_PROPS = 24;
let MAX_DESTRUCTIBLE_CUT_PROPS = 40;
// Don't evict pieces the same frame they spawned — cross-cuts can add 4+ at once
// and the old smallest-first pass used to delete fresh shards immediately.
const PROP_EVICTION_MIN_AGE = 2;
// Below this vertex count, a disconnected component is a negligible stray shard
// — don't spawn a physics body for it. (isViableCutGeometry already drops <18.)
const MIN_COMPONENT_VERTS = 60;
// Soldier flesh meshes fracture into many tiny islands (buttons, straps, etc.).
// Only spin off large islands as their own props on rigid meshes.
const RIGID_MIN_COMPONENT_VERTS = 90;
const RIGID_MIN_COMPONENT_RATIO = 0.09;
const RIGID_MAX_COMPONENTS_PER_HALF = 4;
// Hull colliders are tighter to the mesh (no rolling) but cost more in
// narrowphase than the old spheres, so pieces live shorter and fade out at the
// end instead of popping. The fade also reads better than an instant vanish.
let STATIC_CUT_PROP_LIFETIME = 9;
let RIG_RAGDOLL_PROP_LIFETIME = 24;
const CUT_PROP_FADE_DURATION = 1.2;
// Absolute world-Y cleanup is wrong for office interiors (built at
// INTERIOR_BASE_Y = -1000). Fall cleanup is relative to each prop's spawn Y.
const CUT_PROP_FALL_DROP = 40;
const DEFAULT_COLLISION_GROUP = 0x0001;
const CUT_RAGDOLL_COLLISION_GROUP = 0x0002;
const CUT_RAGDOLL_WORLD_ONLY_GROUPS = (
  (CUT_RAGDOLL_COLLISION_GROUP << 16)
  | DEFAULT_COLLISION_GROUP
);
// Collider shape for cut pieces.
//   'hull'        convex hull of the mesh — tight, mesh-accurate. Flat pieces
//                 (plates, slabs) get flat colliders and stop rolling like balls.
//                 The hull is seeded with the mesh's per-axis extremes so it
//                 always spans the full extent and the mesh can't sink at rest.
//                 Heavier in narrowphase than spheres, so pieces fade out sooner
//                 (CUT_PROP_FADE_DURATION + shorter lifetimes) to compensate.
//   'compound'    stacked spheres along the longest axis — cheap, but chunky
//                 pieces roll like balls and flat pieces never lie flat.
//   'containment' one cuboid sized to the bbox — guaranteed no clip, but floats.
let CUT_COLLIDER_MODE = 'hull';

// How cut pieces deform. The joint smearing you see on robots is linear-blend
// skinning stretching across bones that move on a ragdoll — it is fundamental
// to skinning, so the only way to eliminate it is to not skin.
//   'squishy' — skinned ragdoll: halves ease apart on per-body trajectories
//     (smooth lerp along the cut normal) plus tip-over so corpses lay out.
//   'rigid'   — no ragdoll: every piece becomes a baked static chunk. Nothing
//               is skinned, so there is zero joint stretching. Best for robots.
//   'stiff'   — skinned ragdoll, but joints are damped hard and a torque spring
//               pulls each bone back toward its bind-relative orientation, so
//               articulation is subtle and stretching stays minimal. Robots
//               that should still bend a little rather than tumble as chunks.
// Resolved per-enemy by resolveCutStyle(enemy): flesh-and-bone humans (the
// soldier / mixamo rig) get 'squishy' loose, weighted ragdolls; the metal-robot
// creature rig stays 'rigid' so its cut pieces fall as baked static chunks.
const DEFAULT_CUT_STYLE = 'rigid';

// 'stiff' tuning (ignored unless an enemy resolves to the 'stiff' style). The torque spring
// is a PD controller toward bind-relative pose; it is applied per frame while a
// ragdoll is awake. These need eyeballing in-game — if the robot twitches,
// lower STIFF_SPRING_STIFFNESS (set it to 0 to fall back to damping-only).
const STIFF_ANGULAR_DAMPING = 0.95;
const STIFF_ANGVEL_SCALE = 0.35; // soften the spawn spin so stiff pieces don't fling
// Pose-spring gains are in ANGULAR-ACCELERATION units (rad/s² and 1/s) and are
// scaled by each body's mass at apply time, so the response is identical for a
// 0.075 m tail bone and a 0.2 m hip. An ABSOLUTE torque (the earlier values)
// exploded the integrator on these tiny low-inertia bodies and flung whole
// shards below the cleanup plane in one frame — i.e. pieces "vanished
// instantly." STIFF_MAX_ANGACCEL is a hard safety cap so it can never recur.
const STIFF_SPRING_STIFFNESS = 40; // angular-accel gain toward bind-relative pose (0 = off)
const STIFF_SPRING_DAMPING = 12; // ~critical damping for stiffness 40 (≈ 2·√40)
const STIFF_MAX_ANGACCEL = 300; // rad/s² hard cap so the spring can never explode
const STIFF_SPRING_DEAD_ZONE = 0.02; // rad; below this angle, skip (let it sleep)

// Clean-cut separation: pieces start at the seam, ease apart along the cut normal
// on per-piece trajectories (distance-weighted lerp), shared by soldier ragdolls
// and robot static chunks.
const CUT_SEPARATION_LERP_DURATION = 0.55;
// Separation is driven along the FULL cut normal (incl. its y component), so a
// horizontal cut (decapitation) actually lifts the head off along the normal
// instead of dropping it straight onto the body. Halved from 0.28 — the melee-cut
// impulse was sending pieces off too hard.
const CUT_SEPARATION_MAX = 0.05;
const CUT_SEPARATION_PUSH = 0.05;
const DESTRUCTIBLE_PROP_SEPARATION_MAX = 0.09;
const CUT_GRAVITY_SPLIT_DOWN = 0.21;
const CUT_GRAVITY_SPLIT_UPPER_EXTRA = 0.11;
const STATIC_CHUNK_LINEAR_DAMPING = 0.55;
const STATIC_CHUNK_ANGULAR_DAMPING = 0.82;
const STATIC_CHUNK_TIPOVER_ANGVEL = 1.4;

// Squishy soldier ragdoll — uses CUT_SEPARATION_* above plus tip-over.
const RAGDOLL_COLLIDER_FRICTION = 0.72;
const SQUISHY_TIPOVER_ANGVEL = 2.0;

// Squishy (soldier) ragdoll: no pose spring, heavy angular damping on limbs.
const SQUISHY_LINEAR_DAMPING = 0.78;
const SQUISHY_CORE_LINEAR_DAMPING = 0.42;
const SQUISHY_LEG_LINEAR_DAMPING = 0.82;
const SQUISHY_CORE_ANGULAR_DAMPING = 0.90;
const SQUISHY_LEG_ANGULAR_DAMPING = 0.98;
const SQUISHY_ARM_ANGULAR_DAMPING = 0.97;
const SQUISHY_DISTAL_ANGULAR_DAMPING = 0.99;
const SQUISHY_MAX_LIMB_ANGVEL = 3.2;
const SQUISHY_MAX_DISTAL_ANGVEL = 2.2;
const RAGDOLL_LIMB_COLLIDER_FRICTION = 0.88;

// Temporary cut-lifecycle instrumentation. Set true, cut once, read the
// [cut-debug] lines in the console. Default false: the per-cut / lifecycle /
// dispose console logging and the cyan "cut trigger" direct-cut debug plane
// are pure overhead in normal play. Flip to true only when debugging a cut.
const CUT_DEBUG = false;

const cameraRight = new THREE.Vector3();
const cameraUp = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
const aimCenter = new THREE.Vector3();
const aimTangent = new THREE.Vector3();
const aimNormal = new THREE.Vector3();
const targetCenter = new THREE.Vector3();
const arcOrigin = new THREE.Vector3();
const arcTargetPosition = new THREE.Vector3();
const guideMatrix = new THREE.Matrix4();
const targetBounds = new THREE.Box3();
const tempWorldPosition = new THREE.Vector3();
const tempWorldQuaternion = new THREE.Quaternion();
const tempWorldScale = new THREE.Vector3();
const tempPhysicsPosition = new THREE.Vector3();
const tempPhysicsQuaternion = new THREE.Quaternion();
const tempFollowerPosition = new THREE.Vector3();
const tempFollowerQuaternion = new THREE.Quaternion();
const tempBoneScale = new THREE.Vector3();
const tempParentInverse = new THREE.Matrix4();
const tempWorldMatrix = new THREE.Matrix4();
const tempLocalMatrix = new THREE.Matrix4();
const scratchCurrentQuat = new THREE.Quaternion();
const scratchParentQuat = new THREE.Quaternion();
const scratchTargetQuat = new THREE.Quaternion();
const scratchErrorQuat = new THREE.Quaternion();
const scratchAxis = new THREE.Vector3();
const scratchTorque = new THREE.Vector3();
const scratchPosed = new THREE.Vector3();
const scratchCapsuleDir = new THREE.Vector3();
const scratchCapsuleCenter = new THREE.Vector3();
const scratchCapsuleQuat = new THREE.Quaternion();
const scratchBindRel = new THREE.Quaternion();
const scratchSpawnRel = new THREE.Quaternion();
const scratchDeltaQuat = new THREE.Quaternion();
const scratchJointFrame = new THREE.Quaternion();
const scratchColliderLocalQuat = new THREE.Quaternion();
const scratchColliderOffset = new THREE.Vector3();
const scratchJointUp = new THREE.Vector3();
const scratchJointZ = new THREE.Vector3();
const scratchJointY = new THREE.Vector3();
const scratchJointMatrix = new THREE.Matrix4();
const scratchBoneLinearVel = new THREE.Vector3();
const scratchBoneAngularVel = new THREE.Vector3();
const scratchHingeAxisWorld = new THREE.Vector3();
const gunRegionTriangleMasks = new WeakMap();
const GUN_LIMB_REGIONS = ['head', 'armL', 'armR', 'legL', 'legR'];

// Per-archetype ragdoll/cut bone schemes. Each entry tells the cut system, for
// a given skeleton, which bones become ragdoll bodies and how to weight them,
// plus how to classify a bone into a body region (used to label cut chunks and
// to decide which pieces may become skinned ragdoll shards — see
// pieceCanUseRigShard, gated by each scheme's ragdollRegions). `creature` is the
// original quadruped/robot rig (enemy1); `mixamo` is the human soldier.
function normalizeMixamoBoneName(name) {
  // Blender's FBX import keeps the Mixamo namespace separator ("mixamorig:Hips");
  // three's FBXLoader strips it ("mixamorigHips"). Accept both by normalizing.
  return String(name).replace(/^mixamorig:?/, '').toLowerCase();
}

const BONE_SCHEMES = {
  creature: {
    // Original quadruped/robot rig (enemy1). Radii are tuned relative to the
    // modelHeight/2.7 radiusScale (absolute: false) and only the core/head
    // regions are allowed to ragdoll — its multi-jointed legs looked wrong as
    // skinned ragdolls, so they fall as baked static chunks. These three fields
    // just make explicit the behavior the generic code already assumed.
    absolute: false,
    maxBodiesPerHalf: RAGDOLL_MAX_BODIES_PER_HALF,
    ragdollRegions: new Set(['core', 'head']),
    pattern: /^(Hips|Spine_|Head$|Front_Leg_(Shoulder|Upper|Lower|Ankle|Foot)_[LR]$|Back_Leg_(Pelvis|Upper|Lower|Ankle|Foot|Foot_1)_[LR]$|Tail_(Base|Mid|Mid001|End)$)/,
    region(name = '') {
      if (name === 'Hips' || /^Spine_/.test(name)) return 'core';
      if (name === 'Head' || /^Head/.test(name) || /^Chin/.test(name) || /^Ear_/.test(name)) return 'head';
      if (/^Tail_/.test(name)) return 'tail';
      if (/^Front_Leg_.*_L$/.test(name)) return 'frontLeft';
      if (/^Front_Leg_.*_R$/.test(name)) return 'frontRight';
      if (/^Back_Leg_.*_L$/.test(name)) return 'backLeft';
      if (/^Back_Leg_.*_R$/.test(name)) return 'backRight';
      return 'accessory';
    },
    priority(name) {
      if (name === 'Hips') return 10;
      if (/^Spine_/.test(name)) return 9;
      if (name === 'Head') return 8;
      if (/(Shoulder|Pelvis|Upper)/.test(name)) return 7;
      if (/(Lower|Ankle)/.test(name)) return 6;
      if (/Foot/.test(name)) return 5;
      if (/Tail/.test(name)) return 4;
      return 1;
    },
    radius(name) {
      if (name === 'Hips') return 0.2;
      if (/^Spine_/.test(name)) return 0.18;
      if (name === 'Head') return 0.16;
      if (/(Shoulder|Pelvis|Upper)/.test(name)) return 0.135;
      if (/(Lower|Ankle)/.test(name)) return 0.105;
      if (/Foot/.test(name)) return 0.12;
      if (/Tail/.test(name)) return 0.075;
      return 0.1;
    },
    density(name) {
      if (name === 'Hips' || /^Spine_/.test(name)) return 1.35;
      if (/(Shoulder|Pelvis|Upper)/.test(name)) return 1.05;
      return 0.85;
    },
  },

  mixamo: {
    // Human soldier. Radii are ABSOLUTE render-space meters (the soldier is
    // normalized to a ~1.85 m human, so 0.10 ≈ a 10 cm collider) — they bypass
    // the robot's modelHeight/2.7 radiusScale, which would shrink a human-scale
    // rig by ~30 %. Limbs are proportioned like a person: thighs much thicker
    // than upper arms, forearms/shins thinner still. The creature scheme (copied
    // verbatim until now) gave arms and legs identical girth, so severed limbs
    // read as uniform sausages instead of a human's tapering arms and legs.
    absolute: true,
    maxBodiesPerHalf: 12,
    // The human ragdolls not just the torso/head but the limbs too — a waist cut
    // should leave legs that articulate at the knee, and a sliced arm should
    // ragdoll rather than fall as one stiff slab. The creature rig keeps the old
    // core/head-only gate (its quadruped legs looked wrong as ragdolls).
    ragdollRegions: new Set(['core', 'head', 'armL', 'armR', 'legL', 'legR']),
    pattern: /^mixamorig:?(Hips|Spine|Spine1|Spine2|Neck|Head|HeadTop_End|LeftShoulder|LeftArm|LeftForeArm|LeftHand|RightShoulder|RightArm|RightForeArm|RightHand|LeftUpLeg|LeftLeg|LeftFoot|LeftToeBase|LeftToe_End|RightUpLeg|RightLeg|RightFoot|RightToeBase|RightToe_End)$/,
    region(name = '') {
      const n = normalizeMixamoBoneName(name);
      if (n === 'hips' || n === 'spine' || n === 'spine1' || n === 'spine2') return 'core';
      if (n === 'neck' || n === 'head' || n === 'headtop_end') return 'head';
      if (n === 'leftshoulder' || n === 'leftarm' || n === 'leftforearm' || n === 'lefthand') return 'armL';
      if (n === 'rightshoulder' || n === 'rightarm' || n === 'rightforearm' || n === 'righthand') return 'armR';
      if (n === 'leftupleg' || n === 'leftleg' || n === 'leftfoot' || n === 'lefttoebase' || n === 'lefttoe_end') return 'legL';
      if (n === 'rightupleg' || n === 'rightleg' || n === 'rightfoot' || n === 'righttoebase' || n === 'righttoe_end') return 'legR';
      return 'accessory';
    },
    priority(name) {
      const n = normalizeMixamoBoneName(name);
      if (n === 'hips') return 10;
      if (n === 'spine' || n === 'spine1' || n === 'spine2') return 9;
      if (n === 'neck' || n === 'head' || n === 'headtop_end') return 8;
      if (n === 'leftshoulder' || n === 'leftarm' || n === 'rightshoulder' || n === 'rightarm' || n === 'leftupleg' || n === 'rightupleg') return 7;
      if (n === 'leftforearm' || n === 'rightforearm' || n === 'leftleg' || n === 'rightleg') return 6;
      if (n === 'lefthand' || n === 'righthand' || n === 'leftfoot' || n === 'rightfoot') return 5;
      if (n === 'lefttoebase' || n === 'righttoebase' || n === 'lefttoe_end' || n === 'righttoe_end') return 4;
      return 1;
    },
    colliderShape(name) {
      const n = normalizeMixamoBoneName(name);
      if (n === 'hips' || n === 'spine' || n === 'spine1' || n === 'spine2' || n === 'neck') return 'capsule';
      if (n === 'leftupleg' || n === 'rightupleg' || n === 'leftleg' || n === 'rightleg') return 'capsule';
      if (n === 'leftarm' || n === 'rightarm' || n === 'leftforearm' || n === 'rightforearm') return 'capsule';
      return 'ball';
    },
    simulateBone(name) {
      const n = normalizeMixamoBoneName(name);
      // Shoulders as bodies roll wildly on the spherical spine joint; skin them from
      // the torso instead. Head/feet as bodies: helmet pops off, feet pin upright.
      if (n === 'leftshoulder' || n === 'rightshoulder'
        || n === 'head' || n === 'headtop_end' || n === 'leftfoot' || n === 'rightfoot'
        || n === 'lefttoebase' || n === 'righttoebase') {
        return false;
      }
      return true;
    },
    radius(name) {
      const n = normalizeMixamoBoneName(name);
      if (n === 'hips') return 0.14;
      if (n === 'spine' || n === 'spine1' || n === 'spine2') return 0.14;
      if (n === 'neck') return 0.085;
      if (n === 'head') return 0.1;
      if (n === 'headtop_end') return 0.055;
      if (n === 'leftshoulder' || n === 'rightshoulder') return 0.05;
      if (n === 'leftarm' || n === 'rightarm') return 0.055;
      if (n === 'leftforearm' || n === 'rightforearm') return 0.045;
      if (n === 'leftupleg' || n === 'rightupleg') return 0.11;
      if (n === 'leftleg' || n === 'rightleg') return 0.065;
      if (n === 'leftfoot' || n === 'rightfoot') return 0.07;
      if (n === 'lefttoebase' || n === 'righttoebase') return 0.035;
      return 0.05;
    },
    density(name) {
      const n = normalizeMixamoBoneName(name);
      // Tuned for more realistic mass distribution on the soldier (mixamo rig).
      // Core/torso and upper legs carry more mass; distal limbs lighter.
      // Capsule colliders on the torso add volume; density bumps the felt weight.
      // See ragdoll_research.md for human anatomy notes.
      if (n === 'hips' || n === 'spine' || n === 'spine1' || n === 'spine2') return 2.0;
      if (n === 'leftupleg' || n === 'rightupleg') return 1.05;
      if (n === 'neck' || n === 'head' || n === 'headtop_end') return 1.05;
      if (n === 'leftleg' || n === 'rightleg') return 0.90;
      if (n === 'leftshoulder' || n === 'leftarm' || n === 'leftforearm'
        || n === 'rightshoulder' || n === 'rightarm' || n === 'rightforearm') return 0.80;
      return 0.75; // feet / toes
    },
  },
};

function getBoneScheme(enemy) {
  return BONE_SCHEMES[enemy?.boneScheme] ?? BONE_SCHEMES.creature;
}

// Cut/ragdoll feel per enemy. The soldier is flesh and bone, so it gets a loose,
// weighted skinned ragdoll ('squishy'); the original metal robot (creature rig)
// stays 'rigid', falling apart into baked static chunks. Keyed off cutProfile
// (one of the capability fields EnemySystem stamps on each enemy).
function resolveCutStyle(enemy) {
  if (enemy?.isDestructibleProp) {
    return 'rigid';
  }
  if (enemy?.cutProfile === 'mixamo-skinned') {
    return 'squishy';
  }
  return DEFAULT_CUT_STYLE;
}

function resolveCutPieceLifetime(target) {
  if (target?.cutPieceLifetime != null) {
    return target.cutPieceLifetime;
  }
  return STATIC_CUT_PROP_LIFETIME;
}

function isDestructibleCutTarget(target) {
  return Boolean(target?.isDestructibleProp || target?.isCutPropChunk);
}

function resolveCutGeometryViabilityOptions(target) {
  if (isDestructibleCutTarget(target)) {
    return { minVertexCount: 6, minDimension: 0.016 };
  }
  return {};
}

function minCutPieceCount(target) {
  return isDestructibleCutTarget(target) ? 1 : 2;
}

function isSpawnedCutProp(prop) {
  return Boolean(prop?.mesh || prop?.root);
}

// Slash guide aligns with aimTangent (cos/sin of aim.angle in camera right/up).
// Horizontal when tangent is mostly camera-right; vertical when mostly camera-up.
function resolveAimSlashOrientation(angle) {
  return Math.abs(Math.sin(angle)) >= Math.abs(Math.cos(angle))
    ? 'vertical'
    : 'horizontal';
}

function resolveDisconnectedSplitOptions(enemy) {
  if (isDestructibleCutTarget(enemy)) {
    return {
      minComponentVerts: Math.max(resolveCutGeometryViabilityOptions(enemy).minVertexCount * 2, 12),
      minComponentRatio: 0,
      maxComponentsPerPiece: Infinity,
    };
  }

  // Flesh soldiers already bisect into skinned ragdoll halves on a single plane.
  // Further disconnected splitting on the hybrid fallback just fractures the mesh
  // and (with merge) was eating the main torso chunk — keep clean halves only.
  if (resolveCutStyle(enemy) === 'squishy') {
    return { skipSplit: true };
  }

  return {
    minComponentVerts: RIGID_MIN_COMPONENT_VERTS,
    minComponentRatio: RIGID_MIN_COMPONENT_RATIO,
    maxComponentsPerPiece: RIGID_MAX_COMPONENTS_PER_HALF,
  };
}

function pushCutPiece(nextPieces, piece, cut, geometry, sideSign) {
  nextPieces.push({
    geometry,
    sideSign,
    plane: cut.plane,
    constraints: [
      ...(piece.constraints ?? []),
      { plane: cut.plane, sideSign },
    ],
  });
}

function removeCutTarget({ target, physicsSystem, enemySystem, propSystem, cutSystem }) {
  physicsSystem?.removeEnemyCollider?.(target);
  if (target?.isCutPropChunk) {
    cutSystem?.removeRecuttableChunk?.(target.cutPropRef);
    return;
  }
  if (target?.isDestructibleProp) {
    propSystem?.removeProp?.(target);
    return;
  }
  enemySystem?.removeEnemy?.(target);
}

function buildCutChunkTarget(cutProp) {
  cutProp.mesh.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(cutProp.mesh);
  const size = bounds.getSize(new THREE.Vector3());
  return {
    id: `cut-chunk-${cutProp.mesh.uuid}`,
    isCutPropChunk: true,
    recuttable: true,
    isDestructibleProp: true,
    cutPropRef: cutProp,
    cutPieceLifetime: cutProp.cutPieceLifetime ?? cutProp.lifetime,
    model: cutProp.mesh,
    archetype: 'vehicleChunk',
    boneScheme: 'creature',
    rigProfile: 'creature',
    cutProfile: 'creature-rigid',
    limbLossProfile: null,
    collisionHeight: Math.max(size.y, 0.5),
    collisionRadius: Math.max(size.x, size.z) * 0.5,
    health: 1,
  };
}

function syncCutChunkTargetBounds(cutProp) {
  if (!cutProp?.cutTarget || !cutProp.mesh) {
    return;
  }

  cutProp.mesh.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(cutProp.mesh).getSize(new THREE.Vector3());
  cutProp.cutTarget.collisionHeight = Math.max(size.y, 0.5);
  cutProp.cutTarget.collisionRadius = Math.max(size.x, size.z) * 0.5;
}

// How long (seconds) the direct-cut debug plane (cyan "cut trigger plane") stays visible before fading.
// Only active when CUT_DEBUG.
const DIRECT_CUT_DEBUG_PLANE_LIFETIME = 1.5;
const DIRECT_CUT_DEBUG_PLANE_SIZE = 4.0;

export class EnemyCutSystem {
  constructor() {
    this.scene = null;
    this.state = 'idle';
    this.aim = {
      angle: Math.PI * 0.5,
    };
    this.cutPlane = new THREE.Plane();
    this.queuedCuts = [];
    this.props = [];
    this.lastResult = null;
    this.lastColliderType = null;
    this.justCut = false;
    this.cutCommitted = false;
    this.swingOrientation = null;
    this.lastArcTargetCount = 0;
    this.lastArcCutCount = 0;
    this.planeGuide = null;
    this.slashGuide = null;
    // Filled cyan plane (only when CUT_DEBUG). "cut trigger plane" for direct cuts.
    this.directCutDebugPlane = null;
    this._directCutDebugAge = 0;
    this._directCutDebugActive = false;
    this.capMaterial = new THREE.MeshStandardMaterial({
      color: 0xb84a3d,
      roughness: 0.74,
      metalness: 0.02,
    });
    this.propCapMaterial = null;
  }

  initialize(scene, qualityPreset = {}) {
    MAX_CUT_PROPS = qualityPreset.maxCutProps ?? 24;
    MAX_DESTRUCTIBLE_CUT_PROPS = qualityPreset.destructiblePropMaxCutProps ?? 40;
    STATIC_CUT_PROP_LIFETIME = qualityPreset.staticCutPropLifetime ?? 9;
    RIG_RAGDOLL_PROP_LIFETIME = qualityPreset.rigRagdollPropLifetime ?? 24;
    CUT_COLLIDER_MODE = qualityPreset.cutColliderMode ?? 'hull';
    this.propCapMaterial = createJaggedMetalCapMaterial();
    this.scene = scene;
    this.planeGuide = new THREE.Mesh(
      new THREE.PlaneGeometry(CUT_PLANE_SIZE, CUT_PLANE_SIZE),
      new THREE.MeshBasicMaterial({
        color: 0xf0c463,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.planeGuide.name = 'Enemy Cut Plane Guide';
    this.planeGuide.renderOrder = 40;
    this.planeGuide.visible = false;
    this.scene.add(this.planeGuide);

    this.slashGuide = new THREE.Mesh(
      new THREE.RingGeometry(
        CUT_ARC_RADIUS - CUT_ARC_BAND_WIDTH,
        CUT_ARC_RADIUS,
        96,
      ),
      new THREE.MeshBasicMaterial({
        color: 0xfff0a6,
        transparent: true,
        opacity: 0.62,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.slashGuide.name = 'Enemy Cut Slash Guide';
    this.slashGuide.renderOrder = 41;
    this.slashGuide.visible = false;
    this.scene.add(this.slashGuide);

    // --- direct-cut debug plane (cyan, filled) ---
    // Only created and shown when CUT_DEBUG is true. This is the "cut trigger plane"
    // cyan visual for direct sword cuts. See CUT_DEBUG comment.
    if (CUT_DEBUG) {
      this.directCutDebugPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(DIRECT_CUT_DEBUG_PLANE_SIZE, DIRECT_CUT_DEBUG_PLANE_SIZE),
        new THREE.MeshBasicMaterial({
          color: 0x00ffee,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      this.directCutDebugPlane.name = 'Direct Cut Debug Plane';
      this.directCutDebugPlane.renderOrder = 42;
      this.directCutDebugPlane.visible = false;
      this.scene.add(this.directCutDebugPlane);
    }
  }

  update({
    delta,
    input,
    character,
    camera,
    enemies,
    enemySystem,
    propSystem,
    physicsSystem,
  }) {
    if (!this.scene || !character || !camera) {
      return {
        active: false,
        consumeGameplay: false,
      };
    }

    this.updatePropLifetimes(delta, physicsSystem);

    if (this.state === 'idle' && input.cutModePressed) {
      this.enterCutMode({
        character,
        camera,
      });
    }

    if (this.state !== 'aiming' && this.state !== 'executing') {
      return {
        active: false,
        consumeGameplay: false,
      };
    }

    if (this.state === 'executing') {
      return {
        active: true,
        consumeGameplay: true,
      };
    }

    if (input.cutCancelPressed) {
      this.cancelCutMode();
      return {
        active: false,
        consumeGameplay: false,
      };
    }

    this.updateAim({ delta, input, character, camera });

    if (input.cutModeReleased) {
      if (this.beginCutSwing({
        character,
        enemies,
        enemySystem,
        propSystem,
        physicsSystem,
      })) {
        return {
          active: true,
          consumeGameplay: true,
          startSwing: true,
          orientation: this.swingOrientation,
        };
      }
      return {
        active: false,
        consumeGameplay: true,
      };
    }

    return {
      active: true,
      consumeGameplay: true,
    };
  }

  syncPhysicsProps(physics = null, alpha = 1) {
    for (const prop of this.props) {
      if (prop.type === 'rigRagdoll') {
        syncRagdollProp(prop, physics, alpha);
        continue;
      }

      if (!prop.body) {
        continue;
      }

      let t = null;
      let r = null;
      // Prefer fresh body ref via stored world or handle to prevent aliasing with many chunks.
      const w = prop.physicsWorld;
      if (w && typeof prop.body.handle === 'number') {
        try {
          const fresh = w.bodies.get(prop.body.handle);
          if (fresh) {
            t = fresh.translation();
            r = fresh.rotation();
          }
        } catch (e) {
          const msg = String(e.message || e);
          if (!msg.includes('aliasing')) throw e;
          // skip visual sync for this prop this frame
          continue;
        }
      }
      if (!t) {
        try {
          t = prop.body.translation();
          r = prop.body.rotation();
        } catch (e) {
          const msg = String(e.message || e);
          if (!msg.includes('aliasing')) throw e;
          continue;
        }
      }

      const sampled = physics?.sampleInterpolatedPose?.(prop.body, alpha, tempPhysicsPosition, tempPhysicsQuaternion);
      if (sampled) {
        prop.mesh.position.copy(sampled.position);
        prop.mesh.quaternion.copy(sampled.rotation);
      } else if (t && r) {
        prop.mesh.position.set(t.x, t.y, t.z);
        prop.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
    }
  }

  /** Count live articulated ragdoll props (for Horde detailed-death budget). */
  countDetailedRagdolls() {
    let count = 0;
    for (const prop of this.props) {
      if (prop.type === 'rigRagdoll') count += 1;
    }
    return count;
  }

  /**
   * Whether a new detailed ragdoll is allowed under the given cap.
   * Used by firearm death flush / mass-kill fallbacks in Horde mode.
   */
  canAffordDetailedRagdoll(max = Infinity) {
    if (!Number.isFinite(max)) return true;
    return this.countDetailedRagdolls() < Math.max(0, Math.floor(max));
  }

  /**
   * Evict oldest rigRagdoll props until at or under `max`. Returns removed count.
   */
  enforceDetailedRagdollBudget(max = Infinity) {
    if (!Number.isFinite(max)) return 0;
    const limit = Math.max(0, Math.floor(max));
    let removed = 0;
    while (this.countDetailedRagdolls() > limit) {
      let oldest = null;
      let oldestAge = -1;
      for (const prop of this.props) {
        if (prop.type !== 'rigRagdoll') continue;
        const age = prop.age ?? 0;
        if (age >= oldestAge) {
          oldestAge = age;
          oldest = prop;
        }
      }
      if (!oldest) break;
      const index = this.props.indexOf(oldest);
      if (index < 0) break;
      this.props.splice(index, 1);
      this.disposeCutProp(oldest);
      removed += 1;
    }
    return removed;
  }

  snapshot() {
    const stats = cutPropStats(this.props);

    return {
      state: this.state,
      target: null,
      props: this.props.length,
      staticProps: stats.staticProps,
      rigRagdollProps: stats.rigRagdollProps,
      ragdollBodies: stats.ragdollBodies,
      ragdollJoints: stats.ragdollJoints,
      ragdollFollowers: stats.ragdollFollowers,
      oldestPropAge: stats.oldestPropAge,
      staticRegions: stats.staticRegions,
      rigRegions: stats.rigRegions,
      propBudget: MAX_CUT_PROPS,
      destructiblePropBudget: MAX_DESTRUCTIBLE_CUT_PROPS,
      detailedRagdolls: this.countDetailedRagdolls(),
      recuttableProps: this.props.filter((prop) => prop.recuttable).length,
      queuedCuts: this.queuedCuts.length,
      arcRadius: CUT_ARC_RADIUS,
      arcTargets: this.lastArcTargetCount,
      arcCuts: this.lastArcCutCount,
      lastResult: this.lastResult,
      lastCutMs: this.lastCutMs ?? null,
      collider: this.lastColliderType,
      colliderMode: CUT_COLLIDER_MODE,
      cutStyle: null,
      aimAngle: Number(THREE.MathUtils.radToDeg(this.aim.angle).toFixed(1)),
      aimSlashOrientation: this.swingOrientation,
      cutCommitted: this.cutCommitted,
    };
  }

  getRecuttableChunkTargets() {
    const targets = [];

    for (const prop of this.props) {
      if (!prop.recuttable || prop.type !== 'staticChunk' || !prop.mesh?.visible) {
        continue;
      }

      if (!prop.cutTarget) {
        prop.cutTarget = buildCutChunkTarget(prop);
      } else {
        syncCutChunkTargetBounds(prop);
      }

      targets.push(prop.cutTarget);
    }

    return targets;
  }

  removeRecuttableChunk(cutProp) {
    if (!cutProp) {
      return false;
    }

    const index = this.props.indexOf(cutProp);
    if (index === -1) {
      return false;
    }

    cutProp.cutTarget = null;
    this.disposeCutProp(cutProp);
    this.props.splice(index, 1);
    return true;
  }

  dispose() {
    this.clearProps();
    this.planeGuide?.geometry?.dispose();
    disposeMaterial(this.planeGuide?.material);
    this.slashGuide?.geometry?.dispose();
    disposeMaterial(this.slashGuide?.material);
    this.planeGuide?.removeFromParent();
    this.slashGuide?.removeFromParent();
    this.directCutDebugPlane?.geometry?.dispose();
    disposeMaterial(this.directCutDebugPlane?.material);
    this.directCutDebugPlane?.removeFromParent();
    this.capMaterial.dispose();
    this.propCapMaterial?.dispose?.();
    this.propCapMaterial = null;
    this.scene = null;
    this.state = 'disposed';
  }

  enterCutMode({ character, camera }) {
    this.state = 'aiming';
    this.queuedCuts = [];
    this.aim.angle = Math.PI * 0.5;
    this.lastArcTargetCount = 0;
    this.lastArcCutCount = 0;
    this.lastResult = 'aiming';
    this.setGuideVisible(true);
    this.updateCutPlane(character, camera);
    return true;
  }

  cancelCutMode() {
    this.state = 'idle';
    this.queuedCuts = [];
    this.cutCommitted = false;
    this.swingOrientation = null;
    this.lastResult = 'cancelled';
    this.setGuideVisible(false);
  }

  // V release snapshots every target in the world-space radius and cuts all of
  // them immediately. The animation starts afterward as impact feedback; it no
  // longer gates the geometry operation on a later animation-frame trigger.
  beginCutSwing({ character, enemies, enemySystem, propSystem, physicsSystem }) {
    if (this.state !== 'aiming') {
      return false;
    }

    this.queueCurrentCut();
    this.swingOrientation = resolveAimSlashOrientation(this.aim.angle);
    this.state = 'executing';
    this.setGuideVisible(false);
    this.commitArcCuts({
      character,
      enemies,
      enemySystem,
      propSystem,
      physicsSystem,
    });
    return true;
  }

  finishCutSwing() {
    this.state = 'idle';
    this.queuedCuts = [];
    this.cutCommitted = false;
    this.swingOrientation = null;
    this.setGuideVisible(false);
  }

  commitArcCuts({ character, enemies, enemySystem, propSystem, physicsSystem }) {
    const targets = collectWorldArcTargets({ character, targets: enemies });
    const sourceCuts = this.queuedCuts;
    let cutCount = 0;
    let pieceCount = 0;

    this.lastArcTargetCount = targets.length;
    this.cutCommitted = true;

    for (const enemy of targets) {
      const center = getCutTargetCenter(enemy, targetCenter);
      const cuts = sourceCuts.map((cut) => ({
        ...cut,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(cut.normal, center),
      }));
      const result = this.commitTargetCuts({
        enemy,
        cuts,
        enemySystem,
        propSystem,
        physicsSystem,
      });
      if (!result) continue;
      cutCount += 1;
      pieceCount += result.props.length;
    }

    this.lastArcCutCount = cutCount;
    this.justCut = cutCount > 0;
    this.lastResult = cutCount > 0
      ? `arc-cut-${cutCount}-targets-${pieceCount}-pieces`
      : targets.length > 0
        ? `arc-cut-nonviable-${targets.length}-targets`
        : 'arc-miss';
    return cutCount;
  }

  commitTargetCuts({ enemy, cuts, enemySystem, propSystem, physicsSystem }) {
    const cutResult = this.executeCuts({ enemy, cuts, physicsSystem });
    if (!cutResult?.props?.length) return null;

    const { props, keepEnemy, outcome } = cutResult;
    if (keepEnemy) {
      if (outcome?.severedThisCut?.head) {
        enemySystem?.applySoldierHeadPartialDeath?.(enemy, outcome, physicsSystem);
      } else {
        enemySystem?.applySoldierPartialCut?.(enemy, outcome);
      }
    } else {
      enemySystem?.markDefeated?.(enemy, 'sword-cut');
      removeCutTarget({
        target: enemy,
        physicsSystem,
        enemySystem,
        propSystem,
        cutSystem: this,
      });
    }

    applyPlatformVelocityToCutProps(enemy, props);
    return cutResult;
  }

  updateAim({ delta, input, character, camera }) {
    if (input.moveX) {
      this.aim.angle += input.moveX * CUT_ROTATE_SPEED * delta;
    }

    this.updateCutPlane(character, camera);
  }

  updateCutPlane(character, camera) {
    if (!character?.group) {
      return;
    }

    resolveCameraBasis(camera);
    character.group.getWorldPosition(aimCenter);
    aimCenter.y += 1.25;
    aimTangent.copy(cameraRight)
      .multiplyScalar(Math.cos(this.aim.angle))
      .addScaledVector(cameraUp, Math.sin(this.aim.angle))
      .normalize();
    aimNormal.crossVectors(aimTangent, cameraForward).normalize();

    if (aimNormal.lengthSq() < 0.0001) {
      aimNormal.copy(cameraRight);
    }

    this.cutPlane.setFromNormalAndCoplanarPoint(aimNormal, aimCenter);
    this.positionGuide();
  }

  queueCurrentCut() {
    if (this.state !== 'aiming') {
      return false;
    }

    this.queuedCuts = [{
      plane: this.cutPlane.clone(),
      normal: this.cutPlane.normal.clone(),
      angle: this.aim.angle,
    }];
    return true;
  }

  // Shared core: bake the enemy's current pose, clip by each cut plane, split into
  // connected pieces, and spawn dynamic props (pushed into this.props + scene).
  // Returns the prop array, or null if the cut couldn't be performed (missing
  // system, bake failed, or geometry didn't split into viable pieces). Does NOT
  // remove the enemy or touch aim-mode state — callers own that.
  // Returns { props, keepEnemy, outcome? }. keepEnemy=true when a soldier survives
  // a partial (non-head) limb cut and keeps patrolling on a disability animation.
  // Head partial sets keepEnemy but we kill immediately after.
  //
  // Squishy single-plane cuts intentionally avoid the full posed bake until the
  // hybrid fallback: horde bots are ~43–49k verts / ~80k tris, and bake+CSG on
  // that density several times in one frame is a multi-hundred-ms hitch.
  executeCuts({ enemy, cuts, physicsSystem }) {
    if (!enemy || !physicsSystem?.world || !physicsSystem?.RAPIER) {
      return null;
    }

    // Per-stage timing (event-driven — only runs on a cut, so cheap to keep on).
    const t0 = performance.now();

    // Flesh-and-bone enemies, single clean plane: slice into TWO skinned ragdoll
    // halves, each clipped along the actual cut plane (capped face). This is the
    // proper "cut a person into two ragdolling halves" result. The hybrid path
    // below only ragdolls the one piece that classifies as core/head and bakes
    // everything else into rigid static chunks, and it re-derives shard geometry
    // from the cut constraints (so the slice reads wrong) — acceptable for an
    // armored robot of many plates, but wrong for a single fleshy mesh.
    if (resolveCutStyle(enemy) === 'squishy' && cuts.length === 1 && cuts[0]?.plane) {
      const partial = this.trySoldierPartialCut({
        enemy,
        plane: cuts[0].plane,
        physicsSystem,
        baked: null,
      });

      if (partial) {
        this.props.push(...partial.props);
        for (const prop of partial.props) {
          this.scene.add(prop.mesh);
        }

        const tSpawn = performance.now();
        this.lastCutMs = {
          total: Number((tSpawn - t0).toFixed(2)),
          bake: 0,
          clip: 0,
          split: 0,
          spawn: Number((tSpawn - t0).toFixed(2)),
          pieces: partial.props.length,
          vertices: estimateEnemyRenderVerts(enemy),
          path: partial.path ?? 'partial',
        };

        if (CUT_DEBUG) {
          console.log(`[cut-debug] === PARTIAL CUT pieces=${partial.props.length} reason=${partial.outcome?.reason} ===`);
        }

        return {
          props: partial.props,
          keepEnemy: true,
          outcome: partial.outcome,
        };
      }

      const ragdollProps = this.createSkinnedRagdollCutProps({
        enemy,
        plane: cuts[0].plane,
        sourceGeometry: null,
        physicsSystem,
      });

      if (ragdollProps) {
        this.props.push(...ragdollProps);
        for (const prop of ragdollProps) {
          if (prop.type === 'rigRagdoll') {
            this.scene.add(prop.root);
          } else if (prop.mesh) {
            this.scene.add(prop.mesh);
          }
        }

        const tSpawn = performance.now();
        const path = ragdollProps.every((prop) => prop.type === 'rigRagdoll')
          ? 'skinned-halves'
          : 'static-halves';
        this.lastCutMs = {
          total: Number((tSpawn - t0).toFixed(2)),
          bake: 0,
          clip: 0,
          split: 0,
          spawn: Number((tSpawn - t0).toFixed(2)),
          pieces: ragdollProps.length,
          vertices: estimateEnemyRenderVerts(enemy),
          path,
        };

        if (CUT_DEBUG) {
          console.log(`[cut-debug] === CUT (skinned halves) pieces=${ragdollProps.length} cutStyle=squishy ===`);
          ragdollProps.forEach((prop, index) => cutDebugLogProp(`#${index}`, prop));
        }

        return {
          props: ragdollProps,
          keepEnemy: false,
        };
      }
      // Not viable as a clean two-half cut (plane only grazes the mesh, etc.) —
      // fall through to the hybrid path with a posed bake.
    }

    const baked = bakeSkinnedModelGeometry(enemy.model);
    const sourceGeometry = baked?.geometry;
    const tBake = performance.now();
    if (!sourceGeometry) {
      return null;
    }

    const clipped = applyQueuedCuts({
      sourceGeometry,
      cuts,
      viabilityOptions: resolveCutGeometryViabilityOptions(enemy),
    });
    const tClip = performance.now();
    const pieces = splitDisconnectedCutPieces(clipped, resolveDisconnectedSplitOptions(enemy));
    const tSplit = performance.now();
    if (pieces.length < minCutPieceCount(enemy)) {
      disposePieces(pieces);
      return null;
    }

    const props = this.createHybridCutProps({ enemy, pieces, baked, physicsSystem })
      .filter(isSpawnedCutProp);
    const tSpawn = performance.now();
    if (!props.length) {
      return null;
    }
    this.props.push(...props);
    for (const prop of props) {
      if (prop.type === 'rigRagdoll') {
        this.scene.add(prop.root);
      } else {
        this.scene.add(prop.mesh);
      }
    }

    this.lastCutMs = {
      total: Number((tSpawn - t0).toFixed(2)),
      bake: Number((tBake - t0).toFixed(2)),
      clip: Number((tClip - tBake).toFixed(2)),
      split: Number((tSplit - tClip).toFixed(2)),
      spawn: Number((tSpawn - tSplit).toFixed(2)),
      pieces: props.length,
      vertices: baked?.vertexCount ?? null,
      path: 'hybrid',
    };

    if (CUT_DEBUG) {
      console.log(`[cut-debug] === CUT pieces=${props.length} cutStyle=${resolveCutStyle(enemy)} ===`);
      props.forEach((prop, index) => cutDebugLogProp(`#${index}`, prop));
    }

    return {
      props,
      keepEnemy: false,
    };
  }

  trySoldierPartialCut({ enemy, plane, physicsSystem, baked }) {
    if (!enemy?.model || enemy?.limbLossProfile !== 'mixamo-humanoid') {
      return null;
    }

    const limbLoss = enemy.limbLoss ?? createSoldierLimbState();
    const cutCount = enemy.cutCount ?? 0;
    let outcome = decideSoldierCutOutcome({ enemy, plane, limbLoss, cutCount });

    // Bone analysis already knows this cannot be a survivable partial (core
    // bisect, multi-region, cut limit). applySeveranceFromProps will not upgrade
    // these reasons — skip the full-mesh posed CSG probe that used to run on
    // every heavy swing and hitch horde frames for hundreds of ms.
    const blockedRagdollReasons = new Set(['core-bisect', 'cut-limit', 'too-many-limbs', 'multi-region']);
    if (outcome.mode === 'ragdoll' && blockedRagdollReasons.has(outcome.reason)) {
      return null;
    }

    // Lethal non-head partials must fall through to full ragdoll. Decide that
    // before any geometry work when bone analysis already classified a limb cut.
    if (
      (enemy.health ?? 1) <= 0
      && outcome.mode === 'partial'
      && outcome.locomotion !== 'head'
    ) {
      return null;
    }

    const highPoly = estimateEnemyRenderVerts(enemy) >= HIGH_POLY_CUT_VERT_THRESHOLD;

    // Dense horde meshes: fingertip CSG recovery is not worth a frame hitch.
    // Bone analysis already returned no-severance/fallback → full ragdoll.
    if (outcome.mode === 'ragdoll' && highPoly) {
      return null;
    }

    // Dense meshes: reuse the firearm region partition (skin-weight triangles,
    // no posed CSG). Exact plane caps matter less than staying under a frame on
    // 80k-tri bots. If region partition fails, fall through to full static/ragdoll
    // rather than running live-mesh CSG (that path is a multi-frame hitch).
    if (outcome.mode === 'partial' && highPoly) {
      const region = singleSeveredLimbRegion(outcome.severedThisCut);
      if (region) {
        const regionCut = this.tryRegionPartialCut({
          enemy,
          region,
          plane,
          physicsSystem,
          outcome,
        });
        if (regionCut) {
          return regionCut;
        }
      }
      return null;
    }

    // Clip the live mesh into kept/severed halves WITHOUT committing yet. We only
    // commit the kept half onto the live mesh (and spawn props) if this is actually
    // a survivable partial cut. Committing early — and creating props early — used
    // to run even when the outcome was a full ragdoll (core-bisect, etc.), which
    // (a) left the live mesh as a single half, so createSkinnedRagdollCutProps
    // cloned a half-mesh and rendered one ragdoll half completely flat, and
    // (b) leaked physics bodies for props that were never used.
    const clipResult = this.clipLiveSoldierMeshes(enemy, plane, outcome.keepSign);

    if (!clipResult.didKeepClip) {
      clipResult.disposeAll();
      return null;
    }

    const boneNames = baked?.boneNames ?? collectEnemyBoneNames(enemy.model);
    // Region-classify EVERY severed chunk, including tiny slivers. The bone-based
    // analysis in decideSoldierCutOutcome can't see a clip past the last limb bone
    // (there is no fingertip/toetip bone), so a small finger nick used to register
    // as "no severance" and the soldier got 1-shot KO'd by a full ragdoll. Any
    // chunk that is clearly hand/arm (or foot/leg) now counts as that limb lost.
    const severedCandidates = clipResult.entries.map((entry) => {
      const geometry = entry.severedGeometry;
      if (!geometry) {
        return { region: { primary: 'unknown', weights: {} }, viable: false };
      }
      return {
        region: classifyCutGeometryRegion(geometry, boneNames, enemy),
        viable: isViableCutGeometry(geometry),
      };
    });

    // Decide partial-ness from bones + severed-chunk regions BEFORE any commit/prop
    // creation (see the clipLiveSoldierMeshes comment above).
    outcome = applySeveranceFromProps(outcome, limbLoss, severedCandidates);

    // A lethal blow (soldier already at 0 HP) must kill: if the cut would otherwise
    // be a survivable partial (arm / leg / crawl), fall through to the full-ragdoll
    // path instead of leaving a dead-on-paper soldier patrolling disabled. The head
    // cut is the one animated death, so it survives this override.
    if (
      (enemy.health ?? 1) <= 0
      && outcome.mode === 'partial'
      && outcome.locomotion !== 'head'
    ) {
      clipResult.disposeAll();
      return null;
    }

    if (outcome.mode !== 'partial') {
      clipResult.disposeAll();
      return null;
    }

    // Survivable partial cut: now commit the kept halves onto the live mesh (the
    // enemy keeps patrolling missing the severed region) and spawn physics props
    // for the viable severed chunks.
    clipResult.commitKept();

    const bodyMaterial = cloneCutBodyMaterial(baked?.material ?? getEnemyPrimaryMaterial(enemy.model));
    const props = [];
    for (let index = 0; index < clipResult.entries.length; index += 1) {
      const geometry = clipResult.entries[index].severedGeometry;
      if (!geometry) {
        continue;
      }

      if (severedCandidates[index].viable) {
        props.push(this.createDynamicProp({
          geometry,
          sideSign: -outcome.keepSign,
          splitPlane: plane,
          region: severedCandidates[index].region,
          bodyMaterial,
          physicsSystem,
        }));
      } else {
        // Too small to be a prop, but it already contributed to the severance
        // decision above. Free it instead of leaking the clipped buffer.
        geometry.dispose();
      }
    }

    return { props, outcome, path: 'partial-csg' };
  }

  // Skin-weight region sever for high-poly partial sword cuts (same geometry path
  // as firearms). Caller has already decided the survivable outcome + region.
  tryRegionPartialCut({ enemy, region, plane, physicsSystem, outcome }) {
    if (!enemy?.model || !region || !plane || !physicsSystem?.world) {
      return null;
    }

    const props = [];
    const replacements = [];
    enemy.model.updateMatrixWorld(true);

    enemy.model.traverse((child) => {
      if (!child.isSkinnedMesh || !child.geometry || !child.skeleton) {
        return;
      }

      const pair = partitionSkinnedGeometryByRegion({
        geometry: child.geometry,
        mesh: child,
        enemy,
        region,
      });
      if (!pair) {
        return;
      }

      replacements.push({ child, geometry: pair.kept });
      const material = Array.isArray(child.material) ? child.material[0] : child.material;
      props.push(this.createDynamicProp({
        geometry: pair.severed,
        sideSign: -1,
        splitPlane: plane,
        region: { primary: region, weights: { [region]: 1 } },
        bodyMaterial: cloneCutBodyMaterial(material),
        physicsSystem,
        lifetime: resolveCutPieceLifetime(enemy),
        colliderMode: 'containment',
      }));
    });

    if (!props.length) {
      for (const replacement of replacements) replacement.geometry.dispose();
      return null;
    }

    for (const replacement of replacements) {
      if (replacement.child.userData.geometryOwned) {
        replacement.child.geometry.dispose();
      }
      replacement.child.geometry = replacement.geometry;
      replacement.child.userData.geometryOwned = true;
    }

    return { props, outcome, path: `partial-region-${region}` };
  }

  // Clips each live mesh by the plane into a kept half (keepSign side) and a
  // severed half (-keepSign side) WITHOUT mutating the mesh. The caller commits
  // the kept half (commitKept) only for a survivable partial cut, otherwise
  // discards everything (disposeAll) so the live mesh stays intact for the
  // full-ragdoll path.
  clipLiveSoldierMeshes(enemy, plane, keepSign) {
    const entries = [];
    let didKeepClip = false;

    enemy.model.updateMatrixWorld(true);
    enemy.model.traverse((child) => {
      if (!child.isSkinnedMesh && !child.isMesh) {
        return;
      }

      if (!child.geometry) {
        return;
      }

      const sourceGeometry = child.geometry;
      const keptGeometry = clipSkinnedGeometryByPosedPlane({
        geometry: sourceGeometry,
        mesh: child,
        worldPlane: plane,
        sideSign: keepSign,
      });
      const severedGeometry = clipSkinnedGeometryByPosedPlane({
        geometry: sourceGeometry,
        mesh: child,
        worldPlane: plane,
        sideSign: -keepSign,
        // The severed half becomes a STATIC physics prop (no skeleton), so bake the
        // posed world positions into it — otherwise it spawns at bind-space coords
        // (~world origin) and vanishes. The kept half stays bind-space (skinned).
        outputWorld: true,
      });

      // Return EVERY severed chunk — viability is decided by the caller. A tiny
      // fingertip/toe sliver is too small to spawn a physics body, but it still
      // proves the hand/foot was clipped, which must count as a limb loss (see
      // trySoldierPartialCut). Filtering it out here used to drop that evidence
      // and let a finger nick fall through to a full ragdoll KO.
      const keptViable = Boolean(keptGeometry) && isViableCutGeometry(keptGeometry);
      if (keptViable) {
        didKeepClip = true;
      }

      entries.push({ child, keptGeometry, keptViable, severedGeometry });
    });

    return {
      entries,
      didKeepClip,
      // Replace each mesh's geometry with its kept half (the enemy survives,
      // missing the severed region). Takes ownership of the kept geometries.
      commitKept() {
        for (const entry of entries) {
          if (!entry.keptViable || !entry.keptGeometry) {
            continue;
          }

          if (entry.child.userData.geometryOwned) {
            entry.child.geometry.dispose();
          }
          entry.child.geometry = entry.keptGeometry;
          entry.child.userData.geometryOwned = true;
        }
      },
      // Non-partial abort: free every clipped buffer and leave the live mesh intact.
      disposeAll() {
        for (const entry of entries) {
          entry.keptGeometry?.dispose();
          entry.severedGeometry?.dispose();
        }
      },
    };
  }

  // Entry point for real-time combat: apply a single cut plane derived from a
  // sword swing directly (no aim mode). The plane normal (oriented by the
  // caller from the swing) drives both the bisection and the piece impulse.
  // Partial limb (non-head) cuts keep the soldier alive on a disability animation;
  // head partial cut places the severance once then kills (removes) the enemy;
  // full bisects / over-limit cuts ragdoll and remove as before.
  applyDirectCut({ enemy, plane, physicsSystem, enemySystem, propSystem, cutSystem }) {
    if (!enemy) {
      return false;
    }

    if (CUT_DEBUG) {
      // --- Debug: show the cut plane in the scene as a filled cyan quad. ---
      this._showDirectCutDebugPlane(plane, enemy);
    }

    let cutResult = this.executeCuts({ enemy, cuts: [{ plane }], physicsSystem });

    // A lethal blow (soldier already at 0 HP) whose swing plane didn't produce a
    // clean cut would otherwise just remove the enemy (vanish). Force a vertical
    // bisection through the torso so the soldier dies via a ragdoll instead — a
    // dead soldier should always ragdoll unless it's the head animated death.
    if (!cutResult?.props?.length && (enemy.health ?? 1) <= 0 && !enemy.isDestructibleProp && !enemy.isCutPropChunk) {
      const pos = enemy.model.position;
      const yaw = enemy.model.rotation.y ?? 0;
      const fallbackPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
        new THREE.Vector3(pos.x, pos.y + (enemy.collisionHeight ?? 2) * 0.5, pos.z),
      );
      const retry = this.executeCuts({ enemy, cuts: [{ plane: fallbackPlane }], physicsSystem });
      if (retry?.props?.length) {
        cutResult = retry;
      }
    }

    if (!cutResult?.props?.length) {
      if (!isDestructibleCutTarget(enemy)) {
        physicsSystem?.removeEnemyCollider?.(enemy);
        removeCutTarget({
          target: enemy,
          physicsSystem,
          enemySystem,
          propSystem,
          cutSystem: this,
        });
      }
      this.lastResult = 'direct-cut-nonviable';
      return false;
    }

    const { props, keepEnemy, outcome } = cutResult;

    let didKeep = keepEnemy;
    if (keepEnemy) {
      if (outcome?.severedThisCut?.head) {
        enemySystem.applySoldierHeadPartialDeath(enemy, outcome, physicsSystem);
        didKeep = false;
      } else {
        enemySystem?.applySoldierPartialCut?.(enemy, outcome);
      }
    } else {
      enemySystem?.markDefeated?.(enemy, 'sword-cut');
      removeCutTarget({
        target: enemy,
        physicsSystem,
        enemySystem,
        propSystem,
        cutSystem: this,
      });
    }

    // M5: ragdoll pieces inherit moving-platform / trailer velocity.
    applyPlatformVelocityToCutProps(enemy, props);

    this.lastResult = didKeep
      ? `direct-partial-${outcome?.reason ?? 'limb'}-${props.length}`
      : `direct-cut-${props.length}-pieces`;
    return true;
  }

  // Firearms already resolve a specific anatomical region before reaching the
  // cut system. Do not run the sword's exact plane-CSG path here: on the 43k-
  // 49k vertex horde meshes it skins and clips the entire character several
  // times and can block one animation frame for close to a second. Partition
  // triangles by their authored skin weights instead, bake only the detached
  // region for its physics prop, and keep the remaining skinned mesh live.
  applyGunLimbSever({ enemy, region, plane, physicsSystem, enemySystem }) {
    if (
      !enemy?.model
      || enemy.limbLossProfile !== 'mixamo-humanoid'
      || !enemy.limbLoss?.[region]
      || !plane
      || (enemy.cutCount ?? 0) >= 2
    ) {
      return false;
    }

    const t0 = performance.now();
    const props = [];
    const replacements = [];
    enemy.model.updateMatrixWorld(true);

    enemy.model.traverse((child) => {
      if (!child.isSkinnedMesh || !child.geometry || !child.skeleton) {
        return;
      }

      const pair = partitionSkinnedGeometryByRegion({
        geometry: child.geometry,
        mesh: child,
        enemy,
        region,
      });
      if (!pair) {
        return;
      }

      replacements.push({ child, geometry: pair.kept });
      const material = Array.isArray(child.material) ? child.material[0] : child.material;
      props.push(this.createDynamicProp({
        geometry: pair.severed,
        sideSign: -1,
        splitPlane: plane,
        region: { primary: region, weights: { [region]: 1 } },
        bodyMaterial: cloneCutBodyMaterial(material),
        physicsSystem,
        lifetime: resolveCutPieceLifetime(enemy),
        colliderMode: 'containment',
      }));
    });

    if (!props.length) {
      for (const replacement of replacements) replacement.geometry.dispose();
      return false;
    }

    for (const replacement of replacements) {
      if (replacement.child.userData.geometryOwned) {
        replacement.child.geometry.dispose();
      }
      replacement.child.geometry = replacement.geometry;
      replacement.child.userData.geometryOwned = true;
    }
    for (const prop of props) {
      this.props.push(prop);
      this.scene.add(prop.mesh);
    }

    const severedThisCut = {
      head: region === 'head',
      armL: region === 'armL',
      armR: region === 'armR',
      legL: region === 'legL',
      legR: region === 'legR',
      core: false,
    };
    const nextLoss = mergeLimbLoss(enemy.limbLoss, severedThisCut);
    const outcome = {
      mode: 'partial',
      locomotion: region === 'head'
        ? 'head'
        : (!nextLoss.legL && !nextLoss.legR ? 'crawl' : 'limb'),
      keepSign: 1,
      severedThisCut,
      nextLoss,
      reason: region,
    };

    if (region === 'head') {
      enemySystem?.applySoldierHeadPartialDeath?.(enemy, outcome, physicsSystem);
    } else {
      enemySystem?.applySoldierPartialCut?.(enemy, outcome);
    }

    this.lastCutMs = {
      total: Number((performance.now() - t0).toFixed(2)),
      bake: 0,
      clip: 0,
      split: 0,
      spawn: 0,
      pieces: props.length,
      vertices: props.reduce(
        (sum, prop) => sum + (prop.mesh?.geometry?.getAttribute('position')?.count ?? 0),
        0,
      ),
      path: 'gun-region',
    };
    this.lastResult = `gun-partial-${region}-${props.length}`;
    return true;
  }

  // Build region masks while horde assets are still behind the loading screen.
  // CloneSkeleton instances share geometry, so the first instance of each
  // archetype warms all later instances without multiplying memory or work.
  prepareGunLimbSever(enemy) {
    if (!enemy?.model || enemy.limbLossProfile !== 'mixamo-humanoid') return;
    enemy.model.traverse((mesh) => {
      const geometry = mesh.geometry;
      const position = geometry?.getAttribute?.('position');
      if (!mesh.isSkinnedMesh || !position || !mesh.skeleton) return;
      const index = geometry.getIndex();
      const triangleCount = Math.floor((index?.count ?? position.count) / 3);
      for (const region of GUN_LIMB_REGIONS) {
        getGunRegionTriangleMask({
          geometry,
          mesh,
          enemy,
          region,
          index,
          triangleCount,
        });
      }
    });
  }

  // Convert a LIVE enemy into a full-body ragdoll and fling it along
  // `launchVelocity` (world-space m/s, ADDED to each body's spawn velocity). Used
  // when a vehicle runs an enemy down — they go limp and get launched up and over
  // the car. Unlike applyDirectCut there is NO sever plane: a "keep everything"
  // constraint builds one intact ragdoll from the whole skeleton (cheaper and less
  // gory than a bisection). Flesh-and-bone (squishy) enemies only. Returns true if a
  // ragdoll spawned (and the live enemy was removed).
  smashEnemyToRagdoll({ enemy, launchVelocity, physicsSystem, enemySystem, propSystem }) {
    if (!enemy?.model || !physicsSystem?.world || !physicsSystem?.RAPIER) {
      return false;
    }
    if (enemy.pendingCorpse || enemy.isDestructibleProp || enemy.isCutPropChunk) {
      return false;
    }
    // Only the squishy skinned-ragdoll path produces a clean whole-body ragdoll;
    // skip props/robots (they want the hybrid/stiff cut path, not a run-over).
    if (resolveCutStyle(enemy) !== 'squishy') {
      return false;
    }

    // A horizontal plane far below the feet, keeping everything above it = the whole
    // body (clipSkinnedGeometryByPosedPlane leaves the geometry intact; bones all
    // pass collectRagdollBones' side test).
    const keepPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1000);
    const modelSize = new THREE.Box3().setFromObject(enemy.model).getSize(new THREE.Vector3());
    const radiusScale = Number.isFinite(modelSize.y) && modelSize.y > 0
      ? Math.max(0.65, modelSize.y / RAGDOLL_BASE_HEIGHT)
      : 1;

    const prop = this.createSkinnedRagdollShard({
      enemy,
      constraints: [{ plane: keepPlane, sideSign: 1 }],
      impulsePlane: keepPlane,
      impulseSideSign: 1,
      physicsSystem,
      radiusScale,
      label: `${enemy.id}-runover-ragdoll`,
    });
    if (!prop) {
      return false;
    }

    this.props.push(prop);
    this.scene.add(prop.root);

    // Vehicle run-over is lethal — signal defeat before the target is torn down
    // (the fling + removeCutTarget below are the visual/collider cleanup).
    enemySystem?.markDefeated?.(enemy, 'vehicle-runover');

    // Fling: ADD the launch velocity to every ragdoll body so the whole limp body
    // arcs up and over together (the small natural spawn velocity stays as variation).
    // Compose with platform/trailer velocity when the enemy was riding one (M5).
    const platformVel = getEnemyPlatformVelocity(enemy);
    const composed = composeLaunchVelocity(launchVelocity, platformVel);
    if (composed) {
      for (const record of prop.ragdollBodies ?? []) {
        const v = record.body.linvel();
        record.body.setLinvel(
          { x: v.x + composed.x, y: v.y + composed.y, z: v.z + composed.z },
          true,
        );
      }
    }

    removeCutTarget({ target: enemy, physicsSystem, enemySystem, propSystem, cutSystem: this });
    this.lastResult = 'vehicle-runover-ragdoll';
    return true;
  }

  // Orient the directCutDebugPlane to match the sword-swing cut plane and
  // show it (only if CUT_DEBUG). It will auto-fade via _tickDirectCutDebugPlane().
  _showDirectCutDebugPlane(plane, enemy) {
    if (!CUT_DEBUG) {
      return;
    }
    const mesh = this.directCutDebugPlane;
    if (!mesh) {
      return;
    }

    // Position: mid-body of the enemy (same as buildCutPlane's contact point).
    const ep = enemy?.model?.position;
    if (ep) {
      mesh.position.set(
        ep.x,
        ep.y + (enemy.collisionHeight ?? 2) * 0.5,
        ep.z,
      );
    }

    // Orientation: the plane normal becomes the mesh's local Z (PlaneGeometry
    // faces +Z by default). Build a full basis so there is no gimbal flip.
    const n = plane.normal;
    const arbitraryUp = Math.abs(n.y) < 0.9
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    const tangent = new THREE.Vector3().crossVectors(arbitraryUp, n).normalize();
    const bitangent = new THREE.Vector3().crossVectors(n, tangent).normalize();
    const basis = new THREE.Matrix4().makeBasis(tangent, bitangent, n);
    mesh.quaternion.setFromRotationMatrix(basis);

    // Reset fade state.
    mesh.material.opacity = 0.55;
    mesh.visible = true;
    this._directCutDebugAge = 0;
    this._directCutDebugActive = true;
  }

  // Tick the auto-fade of the direct-cut debug plane (guarded by CUT_DEBUG).
  // Call this from updatePropLifetimes() (or any per-frame update path) so it doesn't
  // need its own update hook.
  _tickDirectCutDebugPlane(delta) {
    if (!CUT_DEBUG || !this._directCutDebugActive || !this.directCutDebugPlane) {
      return;
    }
    this._directCutDebugAge += delta;
    const t = Math.min(1, this._directCutDebugAge / DIRECT_CUT_DEBUG_PLANE_LIFETIME);
    this.directCutDebugPlane.material.opacity = 0.55 * (1 - t);
    if (t >= 1) {
      this.directCutDebugPlane.visible = false;
      this._directCutDebugActive = false;
    }
  }

  createHybridCutProps({
    enemy,
    pieces,
    baked,
    physicsSystem,
  }) {
    const modelBounds = new THREE.Box3().setFromObject(enemy.model);
    const modelSize = modelBounds.getSize(new THREE.Vector3());
    const radiusScale = Number.isFinite(modelSize.y) && modelSize.y > 0
      ? Math.max(0.65, modelSize.y / RAGDOLL_BASE_HEIGHT)
      : 1;
    let rigShardCount = 0;

    const props = pieces.map((piece, index) => {
      const region = classifyCutGeometryRegion(piece.geometry, baked.boneNames, enemy);

      if (
        rigShardCount < MAX_MULTI_CUT_RIG_SHARDS &&
        pieceCanUseRigShard(piece, region, enemy)
      ) {
        const rigProp = this.createSkinnedRagdollShard({
          enemy,
          constraints: piece.constraints ?? [],
          region,
          impulsePlane: piece.plane,
          impulseSideSign: piece.sideSign,
          physicsSystem,
          radiusScale,
          label: `${enemy.id}-multi-${index}-${region.primary}`,
        });

        if (rigProp) {
          piece.geometry.dispose();
          rigShardCount += 1;
          return rigProp;
        }
      }

      return this.createDynamicProp({
        geometry: piece.geometry,
        sideSign: piece.sideSign,
        splitPlane: piece.plane,
        region,
        bodyMaterial: cloneCutBodyMaterial(baked.material),
        physicsSystem,
        lifetime: resolveCutPieceLifetime(enemy),
        recuttable: Boolean(enemy.isDestructibleProp || enemy.isCutPropChunk),
        usePropCap: Boolean(enemy.isDestructibleProp || enemy.isCutPropChunk),
      });
    });

    if (rigShardCount > 0) {
      this.lastColliderType = rigShardCount === props.length
        ? 'skinnedRagdoll'
        : 'hybrid-ragdoll-static';
    }

    return props;
  }

  createDynamicProp({
    geometry,
    sideSign,
    splitPlane,
    region,
    bodyMaterial,
    physicsSystem,
    lifetime,
    recuttable = false,
    usePropCap = false,
    colliderMode = CUT_COLLIDER_MODE,
  }) {
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const plane = splitPlane ?? this.cutPlane;
    const position = center.clone();
    const spawnCenter = center.clone();
    const signedDist = Math.max(0.03, plane.distanceToPoint(spawnCenter) * sideSign);
    const distWeight = Math.min(1.75, 0.4 + signedDist * 0.85);
    const verticalRole = classifySquishyShardVerticalRole(spawnCenter, plane);
    const spawnLinvel = computeCutSeparationSpawnLinvel({
      plane,
      sideSign,
      distWeight,
      verticalRole,
    });
    const spawnAngvel = computeCutTipOverAngvel(plane, sideSign, STATIC_CHUNK_TIPOVER_ANGVEL);

    geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    // Clone both material slots so the prop fully owns them. The cap material is
    // shared by default (this.capMaterial) — if we faded/edited it in place we'd
    // affect every other cut piece. Owning it here lets the end-of-life fade
    // animate per piece, and lets us dispose it cleanly.
    const ownedBody = bodyMaterial ?? this.capMaterial.clone();
    const ownedCap = usePropCap
      ? cloneCutCapMaterial(this.propCapMaterial)
      : this.capMaterial.clone();
    const mesh = new THREE.Mesh(geometry, [ownedBody, ownedCap]);

    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(position);

    const { body, colliderType } = attachCutPropPhysics({
      physicsSystem,
      position,
      spawnLinvel,
      spawnAngvel,
      geometry,
      fallbackSize: size,
      colliderMode,
    });
    this.lastColliderType = colliderType;
    return {
      type: 'staticChunk',
      mesh,
      body,
      region,
      material: ownedBody,
      physicsWorld: physicsSystem.world,
      spawnCenter,
      cutSeparation: createCutSeparationState(
        plane,
        sideSign,
        usePropCap ? DESTRUCTIBLE_PROP_SEPARATION_MAX : CUT_SEPARATION_MAX,
      ),
      age: 0,
      lifetime: lifetime ?? STATIC_CUT_PROP_LIFETIME,
      cutPieceLifetime: lifetime ?? STATIC_CUT_PROP_LIFETIME,
      recuttable,
    };
  }

  createSkinnedRagdollCutProps({
    enemy,
    plane,
    sourceGeometry = null,
    physicsSystem,
  }) {
    if (!enemy?.model || !physicsSystem?.world || !physicsSystem?.RAPIER) {
      return null;
    }

    // Optional baked geometry is only a cheap intersection gate when present.
    // Do NOT full-pair-clip it for viability — that used to throw away two CSG
    // results and then re-clip the live skinned meshes twice more.
    if (sourceGeometry && !planeCutsGeometry(sourceGeometry, plane)) {
      return null;
    }

    enemy.model.updateMatrixWorld(true);
    const modelBounds = new THREE.Box3().setFromObject(enemy.model);
    if (!planeIntersectsBox(plane, modelBounds)) {
      return null;
    }

    // Pose-expand + clip each live mesh ONCE for both sides. Previously each
    // half re-ran toNonIndexed + applyBoneTransform over every vertex.
    // Always full-res + cut caps — the high-poly static/stride path looked
    // crushed (Swiss-cheese decimation). Perf wins stay in the clipper itself
    // (indexed single-pass, unique-vert pose, no throwaway bake/probe).
    const pairClips = precomputeSkinnedCutPairGeometries(enemy.model, plane, {
      includeCap: true,
      outputWorld: false,
    });
    const viabilityOptions = resolveCutGeometryViabilityOptions(enemy);
    const positiveViable = pairClips.positive.some(
      (geometry) => geometry && isViableCutGeometry(geometry, viabilityOptions),
    );
    const negativeViable = pairClips.negative.some(
      (geometry) => geometry && isViableCutGeometry(geometry, viabilityOptions),
    );

    if (!positiveViable && !negativeViable) {
      disposeGeometryList(pairClips.positive);
      disposeGeometryList(pairClips.negative);
      return null;
    }

    const modelSize = modelBounds.getSize(new THREE.Vector3());
    const radiusScale = Number.isFinite(modelSize.y) && modelSize.y > 0
      ? Math.max(0.65, modelSize.y / RAGDOLL_BASE_HEIGHT)
      : 1;

    const ragdollProps = [];
    if (positiveViable) {
      const positive = this.createSkinnedRagdollHalf({
        enemy,
        plane,
        sideSign: 1,
        physicsSystem,
        radiusScale,
        preclippedGeometries: pairClips.positive,
      });
      if (positive) {
        ragdollProps.push(positive);
      }
    }
    // Ownership moves into the shard (entries nulled); dispose any leftovers.
    disposeGeometryList(pairClips.positive);

    if (negativeViable) {
      const negative = this.createSkinnedRagdollHalf({
        enemy,
        plane,
        sideSign: -1,
        physicsSystem,
        radiusScale,
        preclippedGeometries: pairClips.negative,
      });
      if (negative) {
        ragdollProps.push(negative);
      }
    }
    disposeGeometryList(pairClips.negative);

    if (!ragdollProps.length) {
      return null;
    }

    this.lastColliderType = 'skinnedRagdoll';
    return ragdollProps;
  }

  createSkinnedRagdollHalf({
    enemy,
    plane,
    sideSign,
    physicsSystem,
    radiusScale,
    preclippedGeometries = null,
  }) {
    return this.createSkinnedRagdollShard({
      enemy,
      constraints: [{ plane, sideSign }],
      impulsePlane: plane,
      impulseSideSign: sideSign,
      physicsSystem,
      radiusScale,
      label: sideSign > 0 ? `${enemy.id}-positive-ragdoll-half` : `${enemy.id}-negative-ragdoll-half`,
      preclippedGeometries,
    });
  }

  createSkinnedRagdollShard({
    enemy,
    constraints,
    region = null,
    impulsePlane,
    impulseSideSign,
    physicsSystem,
    radiusScale,
    label,
    preclippedGeometries = null,
  }) {
    if (!constraints?.length && !preclippedGeometries) {
      return null;
    }

    const rigRoot = cloneSkeleton(enemy.model);
    const root = new THREE.Group();
    const ownedMaterials = [];
    const ownedGeometries = [];
    const clippedSkinnedMeshes = [];
    let meshIndex = 0;

    root.name = label;
    rigRoot.visible = true;
    rigRoot.updateMatrixWorld(true);
    rigRoot.traverse((child) => {
      if (!child.isMesh && !child.isSkinnedMesh) {
        return;
      }

      let clippedGeometry = null;

      if (preclippedGeometries) {
        // Traversal order matches precomputeSkinnedCutPairGeometries on the live
        // model. Ownership transfers into this shard.
        clippedGeometry = preclippedGeometries[meshIndex] ?? null;
        preclippedGeometries[meshIndex] = null;
        meshIndex += 1;
      } else {
        let currentGeometry = child.geometry;
        let ownsCurrentGeometry = false;

        for (const constraint of constraints) {
          // The shard's geometry must stay in BIND space so the skeleton can
          // deform it, but the player aims the cut at the POSED (animated) mesh.
          // clipSkinnedGeometryByPosedPlane keeps the geometry in bind space while
          // deciding each vertex by its current skinned world position, so the
          // slice lands where it was aimed. Static/unskinned meshes fall back to
          // the node-space clip (their geometry already matches matrixWorld).
          const nextGeometry = clipSkinnedGeometryByPosedPlane({
            geometry: currentGeometry,
            mesh: child,
            worldPlane: constraint.plane,
            sideSign: constraint.sideSign,
          });

          if (ownsCurrentGeometry) {
            currentGeometry.dispose();
          }

          if (!nextGeometry) {
            clippedGeometry = null;
            break;
          }

          clippedGeometry = nextGeometry;
          currentGeometry = nextGeometry;
          ownsCurrentGeometry = true;
        }
      }

      if (!clippedGeometry) {
        // This mesh contributed nothing to the shard. cloneSkeleton() shares
        // geometry AND materials by reference with every live enemy (and the
        // source asset), so we must drop those references here — otherwise the
        // shard's disposeObject3D() on cleanup would dispose the SHARED GPU
        // buffers and blank every other soldier still on screen. Kept meshes
        // (below) already swap in owned clipped geometry + cloned materials.
        child.geometry = undefined;
        child.material = undefined;
        child.visible = false;
        return;
      }

      child.geometry = clippedGeometry;
      child.visible = true;
      child.castShadow = true;
      child.receiveShadow = true;
      child.frustumCulled = false;
      child.material = cloneRigMaterials(child.material, ownedMaterials, {
        includeCap: clippedGeometry.groups.some((group) => group.materialIndex === 1),
      });
      ownedGeometries.push(clippedGeometry);

      if (child.isSkinnedMesh) {
        clippedSkinnedMeshes.push(child);
      }
    });

    const isSquishy = resolveCutStyle(enemy) === 'squishy';
    const bodyOffset = isSquishy
      ? new THREE.Vector3()
      : offsetForConstraints({
        constraints,
        impulsePlane,
        impulseSideSign,
      });

    rigRoot.position.add(bodyOffset);
    root.add(rigRoot);

    const ragdoll = this.createRigHalfRagdoll({
      rigRoot,
      plane: impulsePlane,
      sideSign: impulseSideSign,
      constraints,
      bodyOffset,
      physicsSystem,
      radiusScale,
      enemy,
    });

    if (!ragdoll.bodies.length) {
      if (CUT_DEBUG) {
        console.warn(`[cut-debug] shard "${label}" -> null (no ragdoll bodies); falls back to static`);
      }
      disposeObject3D(root);
      ownedMaterials.forEach((material) => disposeMaterial(material));
      ownedGeometries.forEach((geometry) => geometry.dispose());
      return null;
    }

    const ragdollFollowers = createSkinnedBoneFollowers({
      meshes: clippedSkinnedMeshes,
      records: ragdoll.bodies,
    });

    const ragdollDrivenOrder = buildRagdollDrivenOrder(ragdoll.bodies, ragdollFollowers);

    // Spawn reference for relative fall cleanup (office interiors live at y≈-1000).
    const spawnCenter = new THREE.Vector3();
    if (ragdoll.bodies[0]?.body?.translation) {
      try {
        const t = ragdoll.bodies[0].body.translation();
        spawnCenter.set(t.x, t.y, t.z);
      } catch {
        rigRoot.getWorldPosition(spawnCenter);
      }
    } else {
      rigRoot.getWorldPosition(spawnCenter);
    }

    return {
      type: 'rigRagdoll',
      cutStyle: resolveCutStyle(enemy),
      root,
      rigRoot,
      ragdollBodies: ragdoll.bodies,
      ragdollJoints: ragdoll.joints,
      ragdollFollowers,
      ragdollDrivenOrder,
      region,
      ownedMaterials,
      ownedGeometries,
      physicsWorld: physicsSystem.world,
      cutSeparation: isSquishy ? createCutSeparationState(impulsePlane, impulseSideSign) : null,
      spawnCenter,
      age: 0,
      lifetime: RIG_RAGDOLL_PROP_LIFETIME,
    };
  }

  createRigHalfRagdoll({
    rigRoot,
    plane,
    sideSign,
    constraints = null,
    bodyOffset,
    physicsSystem,
    radiusScale,
    enemy = null,
  }) {
    const scheme = getBoneScheme(enemy);
    const bones = collectRagdollBones({
      rigRoot,
      plane,
      sideSign,
      constraints,
      bodyOffset,
      enemy,
    });
    const isStiff = resolveCutStyle(enemy) === 'stiff';
    const isMixamoSquishy = !isStiff && enemy?.cutProfile === 'mixamo-skinned';
    const records = [];
    const recordByBone = new Map();
    const joints = [];
    const boneSet = new Set(bones);
    const shardVerticalRole = isMixamoSquishy
      ? classifySquishyShardVerticalRole(computeBonesCentroid(bones), plane)
      : null;

    const isShardRootBone = (bone) => {
      let parent = bone.parent;
      while (parent) {
        if (boneSet.has(parent)) {
          return false;
        }
        parent = parent.parent;
      }
      return true;
    };
    for (const bone of bones) {
      bone.getWorldPosition(tempWorldPosition);
      bone.getWorldQuaternion(tempWorldQuaternion);

      const radius = scheme.radius(bone.name) * (scheme.absolute ? 1 : radiusScale);
      const boneNameNorm = normalizeMixamoBoneName(bone.name);
      const isCoreBody = isMixamoSquishy && /^(hips|spine|spine1|spine2)$/.test(boneNameNorm);
      const squishyLimbKind = isMixamoSquishy ? classifyMixamoSquishyLimb(boneNameNorm) : null;
      const isShardRoot = isShardRootBone(bone);
      const spawnLinvel = computeRagdollSpawnLinvel({
        plane,
        sideSign,
        radiusScale,
        isStiff,
        isMixamoSquishy,
        bone,
        shardVerticalRole,
        isShardRoot,
      });
      const spawnAngvel = computeRagdollSpawnAngvel({
        plane,
        sideSign,
        isStiff,
        isMixamoSquishy,
        isShardRoot,
      });
      const body = physicsSystem.world.createRigidBody(
        physicsSystem.RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(tempWorldPosition.x, tempWorldPosition.y, tempWorldPosition.z)
          .setRotation({
            x: tempWorldQuaternion.x,
            y: tempWorldQuaternion.y,
            z: tempWorldQuaternion.z,
            w: tempWorldQuaternion.w,
          })
          .setLinvel(spawnLinvel.x, spawnLinvel.y, spawnLinvel.z)
          .setAngvel(spawnAngvel)
          .setLinearDamping(isStiff
            ? 0.70
            : (isCoreBody
              ? SQUISHY_CORE_LINEAR_DAMPING
              : (squishyLimbKind === 'leg' || squishyLimbKind === 'distalLeg'
                ? SQUISHY_LEG_LINEAR_DAMPING
                : SQUISHY_LINEAR_DAMPING)))
          .setAngularDamping(isStiff
            ? STIFF_ANGULAR_DAMPING
            : computeSquishyAngularDamping(squishyLimbKind, isCoreBody)),
      );

      physicsSystem.world.createCollider(
        buildRagdollColliderDesc({
          physicsSystem,
          scheme,
          bone,
          radius,
          bodyQuaternion: tempWorldQuaternion,
          isMixamoSquishy,
        }),
        body,
      );

      const record = {
        bone,
        body,
        radius,
        initialPosition: tempWorldPosition.clone(),
        initialQuaternion: tempWorldQuaternion.clone(),
      };

      records.push(record);
      recordByBone.set(bone, record);
    }

    for (const record of records) {
      const parentRecord = findNearestRagdollParent(record.bone, recordByBone);

      if (!parentRecord) {
        continue;
      }

      if (isStiff) {
        // Pose-spring anchor (stiff/robot style only).
        record.parentRecord = parentRecord;
        record.bindRelativeQuat = parentRecord.initialQuaternion
          .clone()
          .invert()
          .multiply(record.initialQuaternion);
      }

      const anchorWorld = record.initialPosition;
      const parentAnchor = worldPointToBodyLocal({
        point: anchorWorld,
        bodyPosition: parentRecord.initialPosition,
        bodyQuaternion: parentRecord.initialQuaternion,
      });
      const childAnchor = worldPointToBodyLocal({
        point: anchorWorld,
        bodyPosition: record.initialPosition,
        bodyQuaternion: record.initialQuaternion,
      });

      const jointData = physicsSystem.RAPIER.JointData.spherical(parentAnchor, childAnchor);
      const createdJoint = physicsSystem.world.createImpulseJoint(
        jointData,
        parentRecord.body,
        record.body,
        true,
      );

      joints.push(createdJoint);
    }

    return { bodies: records, joints };
  }

  clearProps() {
    for (const prop of this.props) {
      this.disposeCutProp(prop);
    }

    this.props = [];
  }

  updatePropLifetimes(delta, physicsSystem = null) {
    this._tickDirectCutDebugPlane(delta);
    if (!this.props.length) {
      return;
    }

    for (const prop of this.props) {
      if (prop.cutSeparation) {
        applyCutPieceSeparation(prop, delta, physicsSystem);
      }

      prop.age = (prop.age ?? 0) + delta;
      // Fade out over the final CUT_PROP_FADE_DURATION seconds so pieces dissolve
      // instead of popping. Graceful, and it overlaps the cleanup so the heavier
      // hull colliders are gone from broadphase by the time opacity hits zero.
      const lifetime = prop.lifetime ?? STATIC_CUT_PROP_LIFETIME;
      const remaining = lifetime - prop.age;
      if (remaining < CUT_PROP_FADE_DURATION) {
        applyCutPropFade(prop, Math.max(0, remaining / CUT_PROP_FADE_DURATION));
      }
    }

    if (CUT_DEBUG) {
      this._cutDebugAccum = (this._cutDebugAccum ?? 0) + delta;
      if (this._cutDebugAccum >= 0.5) {
        this._cutDebugAccum = 0;
        console.log('[cut-debug] alive=' + this.props.length, this.props.map((prop) => {
          const position = cutDebugPropPosition(prop);
          const height = position ? `y${position.y.toFixed(1)}` : 'y?';
          return `${prop.type === 'rigRagdoll' ? 'R' : 'S'}${prop.region?.primary?.[0] ?? '?'}${height}`;
        }).join(' '));
      }
    }

    // Expire in place, scanning backwards so splicing keeps indices valid. This
    // avoids reallocating the props array every frame in the common case where
    // nothing has expired yet (the previous .filter() built a fresh array each
    // tick for the prop's whole 14-24s lifetime).
    for (let index = this.props.length - 1; index >= 0; index -= 1) {
      const prop = this.props[index];

      let disposeReason = null;
      if (prop.age >= (prop.lifetime ?? STATIC_CUT_PROP_LIFETIME)) {
        disposeReason = 'lifetime';
      } else if (cutPropIsBelowCleanupY(prop)) {
        disposeReason = 'below-cleanup-y';
      }

      if (disposeReason) {
        if (CUT_DEBUG) {
          cutDebugLogDispose(disposeReason, prop);
        }
        this.disposeCutProp(prop);
        this.props.splice(index, 1);
      }
    }

    while (isOverCutPropBudget(this.props)) {
      const evictable = this.props.filter((prop) => (prop.age ?? 0) >= PROP_EVICTION_MIN_AGE);
      if (!evictable.length) {
        break;
      }

      const nonRecuttableStatic = evictable.filter(
        (prop) => prop.type !== 'rigRagdoll' && !prop.recuttable,
      );
      const staticPool = evictable.filter((prop) => prop.type !== 'rigRagdoll');
      const removalPool = nonRecuttableStatic.length > 0
        ? nonRecuttableStatic
        : (staticPool.length > 0 ? staticPool : evictable);
      // Evict the SMALLEST piece (fewest vertices), oldest as a tie-break — the
      // opposite of the old behavior. This guarantees the big/important pieces
      // (torso halves) survive the cap; only negligible shards get culled.
      const expendable = removalPool.reduce((best, prop) => {
        const verts = cutPropVertexCount(prop);
        const bestVerts = cutPropVertexCount(best);
        if (verts < bestVerts) {
          return prop;
        }
        if (verts === bestVerts && (prop.age ?? 0) > (best.age ?? 0)) {
          return prop;
        }
        return best;
      }, removalPool[0]);
      const index = this.props.indexOf(expendable);

      if (index === -1) {
        break;
      }

      this.props.splice(index, 1);
      if (CUT_DEBUG) {
        cutDebugLogDispose('over-budget', expendable);
      }
      this.disposeCutProp(expendable);
    }
  }

  disposeCutProp(prop) {
    if (prop.type === 'rigRagdoll') {
      this.disposeRigProp(prop);
      return;
    }

    prop.cutTarget = null;
    prop.mesh?.removeFromParent();
    prop.mesh?.geometry?.dispose();
    // Dispose every material on the mesh (body + cap). The prop owns all of them
    // now (createDynamicProp clones the cap per piece), so this frees both.
    const meshMaterials = prop.mesh?.material;
    if (Array.isArray(meshMaterials)) {
      meshMaterials.forEach((material) => material?.dispose?.());
    } else {
      meshMaterials?.dispose?.();
    }
    prop.physicsWorld?.removeRigidBody?.(prop.body);
  }

  disposeRigProp(prop) {
    prop.root?.removeFromParent();

    if (prop.physicsWorld) {
      for (const joint of prop.ragdollJoints ?? []) {
        prop.physicsWorld.removeImpulseJoint(joint, true);
      }

      for (const record of prop.ragdollBodies ?? []) {
        prop.physicsWorld.removeRigidBody(record.body);
      }
    }

    prop.ownedMaterials?.forEach((material) => disposeMaterial(material));
    prop.ownedGeometries?.forEach((geometry) => geometry.dispose());
    disposeObject3D(prop.root);
  }

  setGuideVisible(visible) {
    if (this.planeGuide) {
      this.planeGuide.visible = visible;
    }

    if (this.slashGuide) {
      this.slashGuide.visible = visible;
    }
  }

  positionGuide() {
    const guideUp = aimNormal.clone().cross(aimTangent).normalize();

    guideMatrix.makeBasis(aimTangent, guideUp, aimNormal);

    if (this.planeGuide) {
      this.planeGuide.position.copy(aimCenter);
      this.planeGuide.quaternion.setFromRotationMatrix(guideMatrix);
    }

    if (this.slashGuide) {
      this.slashGuide.position.copy(aimCenter);
      this.slashGuide.rotation.set(-Math.PI * 0.5, 0, 0);
    }
  }
}

export function collectWorldArcTargets({
  character,
  targets,
  radius = CUT_ARC_RADIUS,
  halfHeight = CUT_ARC_HALF_HEIGHT,
}) {
  const group = character?.group;

  if (!group) {
    return [];
  }

  const origin = group.getWorldPosition
    ? group.getWorldPosition(arcOrigin)
    : group.position;
  const matches = [];
  const seen = new Set();

  for (const target of targets ?? []) {
    if (
      !target?.model?.visible
      || target.defeated
      || target.pendingCorpse
      || seen.has(target)
    ) {
      continue;
    }

    const position = target.model.getWorldPosition
      ? target.model.getWorldPosition(arcTargetPosition)
      : target.model.position;
    if (!position) continue;
    const targetRadius = Math.max(0, target.collisionRadius ?? 0);
    const dx = position.x - origin.x;
    const dz = position.z - origin.z;
    if (dx * dx + dz * dz > (radius + targetRadius) ** 2) continue;
    if (Math.abs(position.y - origin.y) > halfHeight) continue;
    seen.add(target);
    matches.push(target);
  }

  return matches;
}

function getCutTargetCenter(target, out) {
  if (target?.model?.isObject3D) {
    targetBounds.setFromObject(target.model);
    if (targetBounds.isEmpty()) {
      target.model.getWorldPosition(out);
      out.y += (target.collisionHeight ?? 2.6) * 0.5;
    } else {
      targetBounds.getCenter(out);
    }
  } else if (target?.model?.position) {
    out.copy(target.model.position);
    out.y += (target.collisionHeight ?? 2.6) * 0.5;
  } else {
    out.set(0, 0, 0);
  }

  if (!Number.isFinite(out.x)) {
    out.copy(target.model.position);
    out.y += (target.collisionHeight ?? 2.6) * 0.5;
  }
  return out;
}

function applyQueuedCuts({ sourceGeometry, cuts, viabilityOptions = {} }) {
  let pieces = [{
    geometry: sourceGeometry,
    sideSign: 1,
    plane: cuts[0]?.plane ?? null,
    constraints: [],
  }];

  for (const cut of cuts) {
    const nextPieces = [];

    for (const piece of pieces) {
      if (!planeCutsGeometry(piece.geometry, cut.plane)) {
        nextPieces.push(piece);
        continue;
      }

      const halves = clipGeometryPairByPlane(piece.geometry, cut.plane);

      if (!halves) {
        nextPieces.push(piece);
        continue;
      }

      const positiveViable = halves.positive && isViableCutGeometry(halves.positive, viabilityOptions);
      const negativeViable = halves.negative && isViableCutGeometry(halves.negative, viabilityOptions);

      if (!positiveViable && !negativeViable) {
        halves.positive?.dispose();
        halves.negative?.dispose();
        nextPieces.push(piece);
        continue;
      }

      piece.geometry.dispose();

      if (positiveViable) {
        pushCutPiece(nextPieces, piece, cut, halves.positive, 1);
      } else {
        halves.positive?.dispose();
      }

      if (negativeViable) {
        pushCutPiece(nextPieces, piece, cut, halves.negative, -1);
      } else {
        halves.negative?.dispose();
      }
    }

    pieces = nextPieces;
  }

  return pieces;
}

function splitDisconnectedCutPieces(pieces, splitOptions = {}) {
  if (splitOptions.skipSplit) {
    return pieces;
  }

  const {
    minComponentVerts = MIN_COMPONENT_VERTS,
    minComponentRatio = 0,
    maxComponentsPerPiece = Infinity,
  } = splitOptions;
  const splitPieces = [];

  for (const piece of pieces) {
    const components = splitGeometryIntoConnectedComponents(piece.geometry);

    if (!components || components.length <= 1) {
      splitPieces.push(piece);
      continue;
    }

    piece.geometry.dispose();

    const ranked = components
      .map((geometry, index) => ({
        index,
        geometry,
        verts: geometry.getAttribute('position')?.count ?? 0,
      }))
      .sort((a, b) => b.verts - a.verts);

    const primaryEntry = ranked[0];
    const primaryVerts = primaryEntry.verts;
    const toSpawnSeparately = [];

    for (let rank = 1; rank < ranked.length; rank += 1) {
      const entry = ranked[rank];
      const passesSize = entry.verts >= minComponentVerts;
      const passesRatio = primaryVerts <= 0 || entry.verts / primaryVerts >= minComponentRatio;
      const slotsLeft = toSpawnSeparately.length < maxComponentsPerPiece - 1;

      if (passesSize && passesRatio && slotsLeft) {
        toSpawnSeparately.push(entry);
      } else {
        entry.geometry.dispose();
      }
    }

    splitPieces.push({
      ...piece,
      geometry: primaryEntry.geometry,
      forceStatic: false,
      componentIndex: primaryEntry.index,
      componentCount: ranked.length,
    });

    for (const entry of toSpawnSeparately) {
      splitPieces.push({
        ...piece,
        geometry: entry.geometry,
        forceStatic: true,
        componentIndex: entry.index,
        componentCount: ranked.length,
      });
    }
  }

  return splitPieces;
}

function splitGeometryIntoConnectedComponents(geometry) {
  const position = geometry?.getAttribute('position');

  if (!position || position.count < 6) {
    return null;
  }

  const triangleCount = Math.floor(position.count / 3);
  const vertexTriangles = new Map();
  const triangleKeys = [];

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const keys = [];

    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = triangleIndex * 3 + corner;
      const key = geometryVertexKey(position, vertexIndex);
      keys.push(key);

      if (!vertexTriangles.has(key)) {
        vertexTriangles.set(key, []);
      }

      vertexTriangles.get(key).push(triangleIndex);
    }

    triangleKeys.push(keys);
  }

  const visited = new Set();
  const components = [];

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    if (visited.has(triangleIndex)) {
      continue;
    }

    const stack = [triangleIndex];
    const component = [];
    visited.add(triangleIndex);

    while (stack.length) {
      const current = stack.pop();
      component.push(current);

      for (const key of triangleKeys[current]) {
        for (const neighbor of vertexTriangles.get(key) ?? []) {
          if (visited.has(neighbor)) {
            continue;
          }

          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }

    components.push(component.sort((a, b) => a - b));
  }

  if (components.length <= 1) {
    return null;
  }

  return components
    .map((component) => createGeometryFromTriangles(geometry, component))
    .filter(Boolean);
}

function createGeometryFromTriangles(source, triangles) {
  if (!triangles.length) {
    return null;
  }

  const target = new THREE.BufferGeometry();
  const attributes = Object.entries(source.attributes);
  const materialByTriangle = materialIndicesByTriangle(source);
  const attributeValues = new Map(attributes.map(([name]) => [name, []]));
  let currentMaterial = null;
  let groupStart = 0;
  let groupCount = 0;
  let outputVertexCount = 0;

  const flushGroup = () => {
    if (currentMaterial == null || groupCount <= 0) {
      return;
    }

    target.addGroup(groupStart, groupCount, currentMaterial);
  };

  for (const triangleIndex of triangles) {
    const materialIndex = materialByTriangle[triangleIndex] ?? 0;

    if (currentMaterial == null) {
      currentMaterial = materialIndex;
      groupStart = outputVertexCount;
      groupCount = 0;
    } else if (materialIndex !== currentMaterial) {
      flushGroup();
      currentMaterial = materialIndex;
      groupStart = outputVertexCount;
      groupCount = 0;
    }

    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = triangleIndex * 3 + corner;

      for (const [name, attribute] of attributes) {
        const values = attributeValues.get(name);

        for (let itemIndex = 0; itemIndex < attribute.itemSize; itemIndex += 1) {
          values.push(attribute.getComponent(vertexIndex, itemIndex));
        }
      }

      outputVertexCount += 1;
      groupCount += 1;
    }
  }

  flushGroup();

  for (const [name, attribute] of attributes) {
    const values = attributeValues.get(name);
    const ArrayType = attribute.array?.constructor ?? Float32Array;

    target.setAttribute(
      name,
      new THREE.BufferAttribute(new ArrayType(values), attribute.itemSize, attribute.normalized),
    );
  }

  target.computeBoundingBox();
  target.computeBoundingSphere();
  return target;
}

function materialIndicesByTriangle(geometry) {
  const triangleCount = Math.floor((geometry.getAttribute('position')?.count ?? 0) / 3);
  const materialIndices = new Array(triangleCount).fill(0);

  for (const group of geometry.groups ?? []) {
    const startTriangle = Math.floor(group.start / 3);
    const endTriangle = Math.floor((group.start + group.count) / 3);

    for (let index = startTriangle; index < endTriangle; index += 1) {
      materialIndices[index] = group.materialIndex ?? 0;
    }
  }

  return materialIndices;
}

function geometryVertexKey(position, index) {
  return vertexKeyNum(position.getX(index), position.getY(index), position.getZ(index));
}

function disposePieces(pieces) {
  for (const piece of pieces) {
    piece.geometry?.dispose();
  }
}

function cutPropStats(props) {
  let staticProps = 0;
  let rigRagdollProps = 0;
  let ragdollBodies = 0;
  let ragdollJoints = 0;
  let ragdollFollowers = 0;
  let oldestAge = 0;
  const staticRegions = {};
  const rigRegions = {};

  for (const prop of props) {
    oldestAge = Math.max(oldestAge, prop.age ?? 0);

    if (prop.type === 'rigRagdoll') {
      rigRagdollProps += 1;
      ragdollBodies += prop.ragdollBodies?.length ?? 0;
      ragdollJoints += prop.ragdollJoints?.length ?? 0;
      ragdollFollowers += prop.ragdollFollowers?.length ?? 0;
      const region = prop.region?.primary ?? 'unknown';
      rigRegions[region] = (rigRegions[region] ?? 0) + 1;
    } else {
      staticProps += 1;
      const region = prop.region?.primary ?? 'unknown';
      staticRegions[region] = (staticRegions[region] ?? 0) + 1;
    }
  }

  return {
    staticProps,
    rigRagdollProps,
    ragdollBodies,
    ragdollJoints,
    ragdollFollowers,
    oldestPropAge: Number(oldestAge.toFixed(2)),
    staticRegions,
    rigRegions,
  };
}

function classifyCutGeometryRegion(geometry, boneNames = [], enemy = null) {
  const skinIndex = geometry?.getAttribute('skinIndex');
  const skinWeight = geometry?.getAttribute('skinWeight');

  if (!skinIndex || !skinWeight || !boneNames.length) {
    return {
      primary: 'unknown',
      weights: {},
    };
  }

  const classifyRegion = getBoneScheme(enemy).region;
  const weights = {};
  const vertexCount = Math.min(skinIndex.count, skinWeight.count);

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = skinWeight.getComponent(vertexIndex, slot);

      if (!Number.isFinite(weight) || weight <= 0.00001) {
        continue;
      }

      const boneIndex = Math.round(skinIndex.getComponent(vertexIndex, slot));
      const region = classifyRegion(boneNames[boneIndex]);
      weights[region] = (weights[region] ?? 0) + weight;
    }
  }

  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);

  if (total <= 0.00001) {
    return {
      primary: 'unknown',
      weights: {},
    };
  }

  const normalized = Object.fromEntries(
    Object.entries(weights)
      .map(([region, weight]) => [region, Number((weight / total).toFixed(3))])
      .sort((left, right) => right[1] - left[1]),
  );
  const primary = Object.keys(normalized)[0] ?? 'unknown';

  return {
    primary,
    weights: normalized,
  };
}

// Horde full actors land ~43–49k verts. Above this, sword cuts prefer region
// partition for limb partials and skip throwaway CSG probes.
const HIGH_POLY_CUT_VERT_THRESHOLD = 28_000;

function estimateEnemyRenderVerts(enemy) {
  let count = 0;
  enemy?.model?.traverse?.((child) => {
    if (!child.isMesh && !child.isSkinnedMesh) return;
    const position = child.geometry?.getAttribute?.('position');
    if (position) count += position.count;
  });
  return count;
}

function singleSeveredLimbRegion(severedThisCut = {}) {
  const regions = ['head', 'armL', 'armR', 'legL', 'legR'];
  let found = null;
  for (const region of regions) {
    if (!severedThisCut[region]) continue;
    if (found) return null;
    found = region;
  }
  return found;
}

function collectEnemyBoneNames(model) {
  const names = [];
  model?.traverse?.((child) => {
    if (child.isSkinnedMesh && child.skeleton?.bones?.length && names.length === 0) {
      for (const bone of child.skeleton.bones) {
        names.push(bone.name);
      }
    }
  });
  return names;
}

function getEnemyPrimaryMaterial(model) {
  let material = null;
  model?.traverse?.((child) => {
    if (material || (!child.isMesh && !child.isSkinnedMesh)) return;
    material = Array.isArray(child.material) ? child.material[0] : child.material;
  });
  return material;
}

function disposeGeometryList(list) {
  if (!list) return;
  for (let index = 0; index < list.length; index += 1) {
    list[index]?.dispose?.();
    list[index] = null;
  }
}

function planeIntersectsBox(plane, box) {
  if (!plane || !box || box.isEmpty()) return false;
  // THREE.Plane does not expose intersectsBox in all builds we care about —
  // signed distances of the 8 corners crossing zero means intersection.
  let min = Infinity;
  let max = -Infinity;
  const { min: bmin, max: bmax } = box;
  for (let ix = 0; ix < 2; ix += 1) {
    for (let iy = 0; iy < 2; iy += 1) {
      for (let iz = 0; iz < 2; iz += 1) {
        const x = ix ? bmax.x : bmin.x;
        const y = iy ? bmax.y : bmin.y;
        const z = iz ? bmax.z : bmin.z;
        const d = plane.normal.x * x + plane.normal.y * y + plane.normal.z * z + plane.constant;
        if (d < min) min = d;
        if (d > max) max = d;
      }
    }
  }
  return min <= 0 && max >= 0;
}

// Pose-expand each live mesh once, then clip both sides. Caller owns the arrays.
function precomputeSkinnedCutPairGeometries(model, worldPlane, options = {}) {
  const positive = [];
  const negative = [];
  const outputWorld = Boolean(options.outputWorld);
  model.traverse((child) => {
    if (!child.isMesh && !child.isSkinnedMesh) return;
    if (!child.geometry) return;
    const pair = clipSkinnedGeometryPairByPosedPlane({
      geometry: child.geometry,
      mesh: child,
      worldPlane,
      includeCap: options.includeCap,
      outputWorld,
    });
    positive.push(pair?.positive ?? null);
    negative.push(pair?.negative ?? null);
  });
  return { positive, negative };
}

// Clip a skinned mesh's BIND-space geometry by a WORLD-space plane for BOTH
// sides, sharing the expensive bone-transform pass (unique verts only when indexed).
function clipSkinnedGeometryPairByPosedPlane({
  geometry,
  mesh,
  worldPlane,
  includeCap = true,
  outputWorld = false,
}) {
  const hasSkin = geometry.getAttribute('skinIndex') && geometry.getAttribute('skinWeight');

  if (!hasSkin || !mesh?.skeleton) {
    const localPlane = getPlaneInObjectSpace(worldPlane, mesh);
    return clipGeometryPairByPlane(geometry, localPlane, { includeCap });
  }

  const prepared = prepareSkinnedCutWorkingGeometry(geometry, mesh, { outputWorld });
  if (!prepared) return null;

  const { working } = prepared;
  const pair = clipGeometryPairByPlane(working, worldPlane, {
    includeCap,
    testPositionsAttribute: outputWorld ? undefined : 'cutTest',
    preserveSource: true,
  });
  working.dispose();
  return pair;
}

// Clip a skinned mesh's BIND-space geometry by a WORLD-space plane, deciding
// each vertex's side from its POSED (skinned) world position. This is the key to
// cutting an animated skinned ragdoll where the player aimed: the geometry that
// the skeleton deforms must remain in bind space, but a posed mesh's rendered
// surface is nowhere near its bind pose, so a plain node-space clip slices the
// wrong place. We tag each vertex with its posed world position and let the
// clipper test against that while interpolating the bind-space attributes.
function clipSkinnedGeometryByPosedPlane({
  geometry,
  mesh,
  worldPlane,
  sideSign,
  outputWorld = false,
  includeCap = true,
}) {
  const hasSkin = geometry.getAttribute('skinIndex') && geometry.getAttribute('skinWeight');

  if (!hasSkin || !mesh?.skeleton) {
    // Unskinned/static accessory: its bind geometry already matches matrixWorld,
    // so the original node-space clip is correct.
    const localPlane = getPlaneInObjectSpace(worldPlane, mesh);
    return clipGeometryByPlane(geometry, localPlane, sideSign, { includeCap });
  }

  const prepared = prepareSkinnedCutWorkingGeometry(geometry, mesh, { outputWorld });
  if (!prepared) return null;
  const { working } = prepared;

  if (outputWorld) {
    // Posed WORLD positions already written into `position` by prepare.
    const worldClipped = clipGeometryByPlane(working, worldPlane, sideSign, {
      includeCap,
      preserveSource: true,
    });
    working.dispose();
    worldClipped?.computeVertexNormals?.();
    return worldClipped;
  }

  const clipped = clipGeometryByPlane(working, worldPlane, sideSign, {
    includeCap,
    testPositionsAttribute: 'cutTest',
    preserveSource: true,
  });
  working.dispose();
  return clipped;
}

/**
 * Build an owned working geometry for CSG with posed world positions attached.
 * Keeps the index buffer when present so pair-clip can walk ~80k tris against
 * ~43k unique verts instead of expanding to ~240k corners first.
 */
function prepareSkinnedCutWorkingGeometry(geometry, mesh, { outputWorld = false } = {}) {
  const posedUnique = computePosedWorldPositions(geometry, mesh);
  if (!posedUnique) return null;

  // Clone keeps index + unique attrs. Never mutate the shared source geometry.
  const working = geometry.clone();

  if (outputWorld) {
    working.setAttribute('position', new THREE.Float32BufferAttribute(posedUnique, 3));
    working.deleteAttribute('cutTest');
  } else {
    working.setAttribute('cutTest', new THREE.Float32BufferAttribute(posedUnique, 3));
  }

  return { working };
}

// Posed world position of every vertex in `geometry` under `mesh`'s skeleton.
// Uses a throwaway probe so three's own skinning math drives it (the live mesh
// may already carry different/clipped geometry mid-loop).
function computePosedWorldPositions(geometry, mesh) {
  const position = geometry.getAttribute('position');
  if (!position) return null;

  const probe = new THREE.SkinnedMesh(geometry);
  probe.bindMode = mesh.bindMode;
  probe.bindMatrix.copy(mesh.bindMatrix);
  probe.bindMatrixInverse.copy(mesh.bindMatrixInverse);
  probe.skeleton = mesh.skeleton;
  mesh.skeleton.update();

  const out = new Float32Array(position.count * 3);

  for (let index = 0; index < position.count; index += 1) {
    scratchPosed.fromBufferAttribute(position, index);
    probe.applyBoneTransform(index, scratchPosed);
    scratchPosed.applyMatrix4(mesh.matrixWorld);
    out[index * 3] = scratchPosed.x;
    out[index * 3 + 1] = scratchPosed.y;
    out[index * 3 + 2] = scratchPosed.z;
  }

  return out;
}

// Fast firearm-only geometry partition. A sword needs an exact arbitrary plane
// and cap, but a gun sever has already selected a named rig region. Skin weights
// are therefore both more stable (independent of the current animation pose) and
// dramatically cheaper than skinning + CSG clipping the whole character twice.
function partitionSkinnedGeometryByRegion({ geometry, mesh, enemy, region }) {
  const position = geometry.getAttribute('position');
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  if (!position || !skinIndex || !skinWeight || !mesh?.skeleton) {
    return null;
  }

  const index = geometry.getIndex();
  const elementCount = index?.count ?? position.count;
  const triangleCount = Math.floor(elementCount / 3);
  const regionMask = getGunRegionTriangleMask({
    geometry,
    mesh,
    enemy,
    region,
    index,
    triangleCount,
  });
  const kept = [];
  const severed = [];
  const groups = geometry.groups?.length
    ? geometry.groups
    : [{ start: 0, count: elementCount, materialIndex: 0 }];
  let groupIndex = 0;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3;
    while (
      groupIndex + 1 < groups.length
      && offset >= groups[groupIndex].start + groups[groupIndex].count
    ) {
      groupIndex += 1;
    }

    const vertices = [
      index ? index.getX(offset) : offset,
      index ? index.getX(offset + 1) : offset + 1,
      index ? index.getX(offset + 2) : offset + 2,
    ];
    const entry = {
      vertices,
      materialIndex: groups[groupIndex]?.materialIndex ?? 0,
    };
    // Majority influence avoids pulling shoulder/hip torso triangles into the
    // detached prop while retaining blend-zone triangles on the live body.
    if (regionMask[triangle]) {
      severed.push(entry);
    } else {
      kept.push(entry);
    }
  }

  if (severed.length < 2 || kept.length < 2) {
    return null;
  }

  return {
    kept: buildRegionSubsetGeometry(geometry, mesh, kept, { outputWorld: false }),
    severed: buildRegionSubsetGeometry(geometry, mesh, severed, { outputWorld: true }),
  };
}

function getGunRegionTriangleMask({ geometry, mesh, enemy, region, index, triangleCount }) {
  let byRegion = gunRegionTriangleMasks.get(geometry);
  if (!byRegion) {
    byRegion = new Map();
    gunRegionTriangleMasks.set(geometry, byRegion);
  }
  const cached = byRegion.get(region);
  if (cached?.length === triangleCount) return cached;

  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const boneRegions = mesh.skeleton.bones.map((bone) => getBoneScheme(enemy).region(bone?.name ?? ''));
  const mask = new Uint8Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    let targetWeight = 0;
    let totalWeight = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const offset = triangle * 3 + corner;
      const vertex = index ? index.getX(offset) : offset;
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.getComponent(vertex, slot);
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const bone = Math.max(0, Math.round(skinIndex.getComponent(vertex, slot)));
        totalWeight += weight;
        if (boneRegions[bone] === region) targetWeight += weight;
      }
    }
    mask[triangle] = totalWeight > 0 && targetWeight / totalWeight >= 0.5 ? 1 : 0;
  }
  byRegion.set(region, mask);
  return mask;
}

function buildRegionSubsetGeometry(source, mesh, triangles, { outputWorld }) {
  const result = new THREE.BufferGeometry();
  const vertexCount = triangles.length * 3;
  const sourceAttributes = Object.entries(source.attributes);

  // The live skinned half can retain the source vertex table and draw only the
  // kept triangle indices. Typed-array clone/slice happens in native code and is
  // substantially cheaper than expanding every kept vertex in JavaScript.
  if (!outputWorld) {
    for (const [name, attribute] of sourceAttributes) {
      if (name !== 'cutTest') result.setAttribute(name, attribute.clone());
    }
    for (const [name, attributes] of Object.entries(source.morphAttributes ?? {})) {
      result.morphAttributes[name] = attributes.map((attribute) => attribute.clone());
    }
    result.morphTargetsRelative = source.morphTargetsRelative;
    const IndexArray = source.getAttribute('position').count > 65535 ? Uint32Array : Uint16Array;
    const indices = new IndexArray(vertexCount);
    let write = 0;
    for (const triangle of triangles) {
      indices[write++] = triangle.vertices[0];
      indices[write++] = triangle.vertices[1];
      indices[write++] = triangle.vertices[2];
    }
    result.setIndex(new THREE.BufferAttribute(indices, 1));
    addRegionSubsetGroups(result, triangles, vertexCount);
    result.boundingBox = source.boundingBox?.clone() ?? null;
    result.boundingSphere = source.boundingSphere?.clone() ?? null;
    return result;
  }

  for (const [name, attribute] of sourceAttributes) {
    if (outputWorld && (name === 'skinIndex' || name === 'skinWeight' || name === 'cutTest')) {
      continue;
    }
    const ArrayType = attribute.array?.constructor ?? Float32Array;
    const values = new ArrayType(vertexCount * attribute.itemSize);
    let write = 0;
    for (const triangle of triangles) {
      for (const vertex of triangle.vertices) {
        for (let component = 0; component < attribute.itemSize; component += 1) {
          values[write++] = attribute.getComponent(vertex, component);
        }
      }
    }
    result.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized));
  }

  if (outputWorld) {
    const positions = result.getAttribute('position');
    let write = 0;
    for (const triangle of triangles) {
      for (const vertex of triangle.vertices) {
        scratchPosed.fromBufferAttribute(source.getAttribute('position'), vertex);
        mesh.applyBoneTransform(vertex, scratchPosed);
        scratchPosed.applyMatrix4(mesh.matrixWorld);
        positions.setXYZ(write, scratchPosed.x, scratchPosed.y, scratchPosed.z);
        write += 1;
      }
    }
    result.computeVertexNormals();
  }

  addRegionSubsetGroups(result, triangles, vertexCount);
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

function addRegionSubsetGroups(result, triangles, vertexCount) {
  let groupStart = 0;
  let activeMaterial = triangles[0]?.materialIndex ?? 0;
  for (let triangle = 0; triangle < triangles.length; triangle += 1) {
    const material = triangles[triangle].materialIndex;
    if (material !== activeMaterial) {
      result.addGroup(groupStart, triangle * 3 - groupStart, activeMaterial);
      groupStart = triangle * 3;
      activeMaterial = material;
    }
  }
  result.addGroup(groupStart, vertexCount - groupStart, activeMaterial);
}

function pieceCanUseRigShard(piece, region, enemy = null) {
  const cutStyle = resolveCutStyle(enemy);

  if (cutStyle === 'rigid') {
    // Robots/armored foes: never skin. Fall through to baked static chunks so
    // joints can't smear. (The smearing is LBS across moving ragdoll bones.)
    return false;
  }

  if (piece?.forceStatic) {
    return false;
  }

  if (!piece?.constraints?.length || !region || region.primary === 'unknown') {
    return false;
  }

  // Which body regions are allowed to become skinned ragdoll shards is now
  // per-scheme: the creature rig keeps the old core/head-only gate, while the
  // human mixamo rig also ragdolls its limbs (so legs/arms articulate).
  const allowed = getBoneScheme(enemy).ragdollRegions;
  if (!allowed || !allowed.has(region.primary)) {
    return false;
  }

  return (region.weights?.[region.primary] ?? 0) >= 0.22;
}

function createCutSeparationState(plane, sideSign, maxSep = CUT_SEPARATION_MAX) {
  return {
    planeNormal: plane.normal.clone(),
    planeConstant: plane.constant,
    sideSign,
    duration: CUT_SEPARATION_LERP_DURATION,
    maxSep,
    elapsed: 0,
    lastEased: 0,
  };
}

function computeCutSeparationWeight(planeNormal, planeConstant, sideSign, point) {
  const signedDist = Math.max(0.03, planeDistanceToPoint(planeNormal, planeConstant, point) * sideSign);
  return Math.min(1.75, 0.4 + signedDist * 0.85);
}

function computeCutSeparationSpawnLinvel({
  plane,
  sideSign,
  distWeight,
  verticalRole,
  radiusScale = 1,
  includeDown = true,
}) {
  const sep = CUT_SEPARATION_PUSH * radiusScale * distWeight;
  let down = 0;

  if (includeDown) {
    down = verticalRole === 'upper'
      ? (CUT_GRAVITY_SPLIT_DOWN + CUT_GRAVITY_SPLIT_UPPER_EXTRA) * radiusScale
      : CUT_GRAVITY_SPLIT_DOWN * 0.5 * radiusScale;
  }

  return {
    x: plane.normal.x * sideSign * sep,
    y: plane.normal.y * sideSign * sep - down,
    z: plane.normal.z * sideSign * sep,
  };
}

function computeCutTipOverAngvel(plane, sideSign, angvelScale) {
  scratchCapsuleDir.set(plane.normal.x * sideSign, 0, plane.normal.z * sideSign);

  if (scratchCapsuleDir.lengthSq() < 1e-6) {
    scratchCapsuleDir.set(sideSign, 0, 0);
  } else {
    scratchCapsuleDir.normalize();
  }

  scratchAxis.crossVectors(scratchJointUp.set(0, 1, 0), scratchCapsuleDir);

  if (scratchAxis.lengthSq() < 1e-6) {
    scratchAxis.set(0, 0, sideSign);
  } else {
    scratchAxis.normalize();
  }

  scratchAxis.multiplyScalar(angvelScale);
  return { x: scratchAxis.x, y: scratchAxis.y, z: scratchAxis.z };
}

function applyCutPieceSeparation(prop, delta, physicsSystem = null) {
  const sep = prop.cutSeparation;

  if (!sep || sep.elapsed >= sep.duration) {
    return;
  }

  sep.elapsed += delta;
  const eased = smoothstep01(sep.elapsed / sep.duration);
  const deltaEase = eased - sep.lastEased;
  sep.lastEased = eased;

  if (deltaEase <= 1e-6) {
    return;
  }

  const invDt = 1 / Math.max(delta, 1 / 240);
  const bodies = [];

  if (prop.type === 'rigRagdoll') {
    for (const record of prop.ragdollBodies ?? []) {
      bodies.push({
        body: record.body,
        getPoint: () => {
          record.bone.getWorldPosition(scratchPosed);
          return scratchPosed;
        },
      });
    }
  } else if (prop.type === 'staticChunk' && prop.body) {
    bodies.push({
      body: prop.body,
      getPoint: () => {
        if (prop.spawnCenter) return prop.spawnCenter;
        // safe read for point if possible
        const w = physicsSystem?.world || prop.physicsWorld;
        if (w && typeof prop.body.handle === 'number') {
          try {
            const f = w.bodies.get(prop.body.handle);
            if (f) {
              const tt = f.translation();
              return { x: tt.x, y: tt.y, z: tt.z };
            }
          } catch {}
        }
        try { return prop.body.translation(); } catch { return prop.spawnCenter || { x: 0, y: 0, z: 0 }; }
      },
    });
  }

  const world = physicsSystem?.world || prop.physicsWorld;

  for (const entry of bodies) {
    const point = entry.getPoint();
    const distWeight = computeCutSeparationWeight(
      sep.planeNormal,
      sep.planeConstant,
      sep.sideSign,
      point,
    );
    const pushVel = sep.maxSep * deltaEase * distWeight * invDt;
    // Use fresh + scalar copy + try/catch to avoid aliasing when many chunks (incl. during tele grab/throw).
    let lv;
    let opBody = entry.body;
    if (world && entry.body && typeof entry.body.handle === 'number') {
      try {
        const fresh = world.bodies.get(entry.body.handle);
        if (fresh) {
          opBody = fresh;
          lv = fresh.linvel();
        }
      } catch (e) {
        const msg = String(e.message || e);
        if (!msg.includes('aliasing')) throw e;
        continue;
      }
    }
    if (!lv) {
      try {
        lv = entry.body.linvel();
        opBody = entry.body;
      } catch (e) {
        const msg = String(e.message || e);
        if (!msg.includes('aliasing')) throw e;
        continue;
      }
    }

    const vx = lv.x;
    const vy = lv.y;
    const vz = lv.z;

    try {
      opBody.setLinvel({
        x: vx + sep.planeNormal.x * sep.sideSign * pushVel,
        y: vy + sep.planeNormal.y * sep.sideSign * pushVel,
        z: vz + sep.planeNormal.z * sep.sideSign * pushVel,
      }, true);
    } catch (e) {
      const msg = String(e.message || e);
      if (!msg.includes('aliasing')) throw e;
    }
  }
}

function smoothstep01(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function planeDistanceToPoint(planeNormal, planeConstant, point) {
  return planeNormal.x * point.x
    + planeNormal.y * point.y
    + planeNormal.z * point.z
    + planeConstant;
}

function computeSquishySeparationWeight(plane, sideSign, bone) {
  bone.getWorldPosition(scratchPosed);
  return computeCutSeparationWeight(plane.normal, plane.constant, sideSign, scratchPosed);
}

function computeSquishyBodySpawnLinvel({
  plane,
  sideSign,
  bone,
  radiusScale,
  shardVerticalRole,
  isShardRoot,
}) {
  const distWeight = computeSquishySeparationWeight(plane, sideSign, bone);

  return computeCutSeparationSpawnLinvel({
    plane,
    sideSign,
    distWeight,
    verticalRole: shardVerticalRole,
    radiusScale,
    includeDown: isShardRoot,
  });
}

function computeSquishyTipOverAngvel(plane, sideSign) {
  return computeCutTipOverAngvel(plane, sideSign, SQUISHY_TIPOVER_ANGVEL);
}

function offsetForConstraints({
  constraints,
  impulsePlane,
  impulseSideSign,
}) {
  const offset = new THREE.Vector3();

  for (const constraint of constraints ?? []) {
    offset.addScaledVector(constraint.plane.normal, constraint.sideSign);
  }

  if (offset.lengthSq() <= 0.000001 && impulsePlane) {
    offset.addScaledVector(impulsePlane.normal, impulseSideSign ?? 1);
  }

  if (offset.lengthSq() <= 0.000001) {
    offset.set(1, 0, 0);
  }

  return offset.normalize().multiplyScalar(CHUNK_SEPARATION);
}

function cutPropSpawnY(prop) {
  if (Number.isFinite(prop?.spawnCenter?.y)) return prop.spawnCenter.y;
  if (Number.isFinite(prop?.mesh?.position?.y)) return prop.mesh.position.y;
  if (Number.isFinite(prop?.root?.position?.y)) return prop.root.position.y;
  return 0;
}

function cutPropIsBelowCleanupY(prop) {
  // Dropped far below where the piece was spawned (void / fell through floor).
  // Must be relative — office WFC interiors are at INTERIOR_BASE_Y (-1000).
  const floor = cutPropSpawnY(prop) - CUT_PROP_FALL_DROP;

  if (prop.type === 'rigRagdoll') {
    return (prop.ragdollBodies ?? []).every((record) => {
      try {
        const w = prop.physicsWorld;
        let t;
        if (w && record.body?.handle != null) {
          try { const f = w.bodies.get(record.body.handle); if (f) t = f.translation(); } catch {}
        }
        if (!t) t = record.body?.translation?.();
        return t ? t.y < floor : false;
      } catch {
        return false;
      }
    });
  }

  try {
    const w = prop.physicsWorld;
    let t;
    if (w && prop.body?.handle != null) {
      try { const f = w.bodies.get(prop.body.handle); if (f) t = f.translation(); } catch {}
    }
    if (!t) t = prop.body?.translation?.();
    return t ? t.y < floor : false;
  } catch {
    return false;
  }
}

function syncRagdollProp(prop, physics = null, alpha = 1) {
  // A settled (sleeping) ragdoll isn't moving, so its skeleton already matches
  // the last solved pose — skip the per-frame bone solve entirely. Ragdolls live
  // RIG_RAGDOLL_PROP_LIFETIME seconds, so this is the dominant steady-state cost
  // and skipping it while at rest is output-identical (nothing moved).
  if (ragdollIsAtRest(prop)) {
    return;
  }

  if (prop.cutStyle === 'stiff') {
    applyStiffPoseSpring(prop);
  } else {
    dampSquishyLimbSpin(prop);
  }

  // ragdollDrivenOrder is built once at shard creation: depth-sorted (parents
  // before children, so world->local conversion sees an up-to-date parent) and
  // tagged body/follower. Iterating it here avoids a per-frame allocation of
  // Vector3/Quaternion per bone, the .clone()s, the array build, and the sort
  // with getBoneDepth walks in the comparator.
  const order = prop.ragdollDrivenOrder;

  if (!order) {
    return;
  }

  for (const entry of order) {
    if (entry.kind === 'body') {
      const sampled = physics?.sampleInterpolatedPose?.(
        entry.record.body, alpha, tempPhysicsPosition, tempPhysicsQuaternion,
      );
      if (!sampled) {
        const translation = entry.record.body.translation();
        const rotation = entry.record.body.rotation();
        tempPhysicsPosition.set(translation.x, translation.y, translation.z);
        tempPhysicsQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      }
      setBoneWorldTransform({
        bone: entry.bone,
        position: tempPhysicsPosition,
        quaternion: tempPhysicsQuaternion,
      });
    } else {
      const sampled = physics?.sampleInterpolatedPose?.(
        entry.follower.record.body, alpha, tempPhysicsPosition, tempPhysicsQuaternion,
      );
      if (!sampled) {
        const translation = entry.follower.record.body.translation();
        const rotation = entry.follower.record.body.rotation();
        tempPhysicsPosition.set(translation.x, translation.y, translation.z);
        tempPhysicsQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      }
      tempFollowerPosition.copy(entry.follower.localPosition)
        .applyQuaternion(tempPhysicsQuaternion)
        .add(tempPhysicsPosition);
      tempFollowerQuaternion.copy(tempPhysicsQuaternion).multiply(entry.follower.localQuaternion);
      setBoneWorldTransform({
        bone: entry.bone,
        position: tempFollowerPosition,
        quaternion: tempFollowerQuaternion,
      });
    }
  }

  prop.rigRoot?.updateMatrixWorld(true);
}

// A ragdoll is "at rest" only when every physics body has gone to sleep. We
// never skip while any body is awake, so the visible pose stays correct; the
// skip just stops re-driving a skeleton that isn't moving.
function ragdollIsAtRest(prop) {
  const bodies = prop.ragdollBodies;

  if (!bodies?.length) {
    return true;
  }

  for (const record of bodies) {
    if (typeof record.body?.isSleeping === 'function') {
      if (!record.body.isSleeping()) {
        return false;
      }
    } else if (typeof record.body?.isMoving === 'function') {
      if (record.body.isMoving()) {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

// 'stiff' pose spring: a PD controller that, each frame while the ragdoll is
// awake, applies a torque pulling every bone back toward the orientation it had
// at bind time *relative to its simulated parent*. As the parent tumbles the
// child follows rigidly, so the corpse holds its shape (minimizing the LBS
// smear) while still allowing some articulation. Torque is applied with
// wakeUp=false so a settled body can still go to sleep and hit the rest-skip.
// (Only used for stiff/robot style.)
function applyStiffPoseSpring(prop) {
  if (!STIFF_SPRING_STIFFNESS) {
    return;
  }

  for (const record of prop.ragdollBodies ?? []) {
    const parent = record.parentRecord;
    const bindRelative = record.bindRelativeQuat;

    if (!parent || !bindRelative) {
      continue;
    }

    const body = record.body;
    const rotation = body.rotation();
    scratchCurrentQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);

    const parentRotation = parent.body.rotation();
    scratchParentQuat.set(parentRotation.x, parentRotation.y, parentRotation.z, parentRotation.w);

    // target world orientation = parent's current world orientation composed
    // with the bind-time relative offset.
    scratchTargetQuat.copy(scratchParentQuat).multiply(bindRelative);

    // error = target * inverse(current), normalized to the shortest arc.
    scratchErrorQuat.copy(scratchCurrentQuat).invert().premultiply(scratchTargetQuat);
    if (scratchErrorQuat.w < 0) {
      // Three r184 Quaternion has no .negate(); flip signs manually for shortest arc.
      scratchErrorQuat.x = -scratchErrorQuat.x;
      scratchErrorQuat.y = -scratchErrorQuat.y;
      scratchErrorQuat.z = -scratchErrorQuat.z;
      scratchErrorQuat.w = -scratchErrorQuat.w;
    }

    const halfW = Math.min(Math.abs(scratchErrorQuat.w), 1);
    const angle = 2 * Math.acos(halfW);

    if (angle < STIFF_SPRING_DEAD_ZONE) {
      continue;
    }

    const sinHalf = Math.sqrt(Math.max(0, 1 - halfW * halfW));

    if (sinHalf <= 1e-4) {
      continue;
    }

    scratchAxis.set(
      scratchErrorQuat.x / sinHalf,
      scratchErrorQuat.y / sinHalf,
      scratchErrorQuat.z / sinHalf,
    );

    const angvel = body.angvel();
    // PD in angular-ACCELERATION space (torque/mass); multiplied by mass below so
    // the gain stays bone-size-independent instead of over-driving tiny bones.
    let accelX = (STIFF_SPRING_STIFFNESS * angle * scratchAxis.x) - (STIFF_SPRING_DAMPING * angvel.x);
    let accelY = (STIFF_SPRING_STIFFNESS * angle * scratchAxis.y) - (STIFF_SPRING_DAMPING * angvel.y);
    let accelZ = (STIFF_SPRING_STIFFNESS * angle * scratchAxis.z) - (STIFF_SPRING_DAMPING * angvel.z);

    // Hard cap the angular acceleration so the spring can never explode the
    // integrator (the original failure mode that made shards vanish).
    const accelMag = Math.sqrt((accelX * accelX) + (accelY * accelY) + (accelZ * accelZ));
    if (accelMag > STIFF_MAX_ANGACCEL) {
      const accelScale = STIFF_MAX_ANGACCEL / accelMag;
      accelX *= accelScale;
      accelY *= accelScale;
      accelZ *= accelScale;
    }

    const mass = body.mass() || 1;
    scratchTorque.set(accelX * mass, accelY * mass, accelZ * mass);

    body.addTorque(scratchTorque, false);
  }
}

// --- Ragdoll joint helpers (for soldier squishy cut-ragdolls) -----------------

function classifyMixamoSquishyLimb(boneNameNorm) {
  if (/^(leftupleg|rightupleg)$/.test(boneNameNorm)) return 'leg';
  if (/^(leftleg|rightleg)$/.test(boneNameNorm)) return 'distalLeg';
  if (/^(leftarm|rightarm)$/.test(boneNameNorm)) return 'arm';
  if (/^(leftforearm|rightforearm)$/.test(boneNameNorm)) return 'distalArm';
  return null;
}

function computeSquishyAngularDamping(limbKind, isCoreBody) {
  if (isCoreBody) {
    return SQUISHY_CORE_ANGULAR_DAMPING;
  }

  switch (limbKind) {
    case 'leg':
      return SQUISHY_LEG_ANGULAR_DAMPING;
    case 'distalLeg':
    case 'distalArm':
      return SQUISHY_DISTAL_ANGULAR_DAMPING;
    case 'arm':
      return SQUISHY_ARM_ANGULAR_DAMPING;
    default:
      return SQUISHY_ARM_ANGULAR_DAMPING;
  }
}

function dampSquishyLimbSpin(prop) {
  for (const record of prop.ragdollBodies ?? []) {
    const limbKind = classifyMixamoSquishyLimb(normalizeMixamoBoneName(record.bone.name));

    if (!limbKind) {
      continue;
    }

    const maxAngvel = (limbKind === 'distalLeg' || limbKind === 'distalArm')
      ? SQUISHY_MAX_DISTAL_ANGVEL
      : SQUISHY_MAX_LIMB_ANGVEL;
    // Copy scalars to avoid potential aliasing on read-then-mutate for high-chunk-count scenarios
    const av = record.body.angvel();
    const ax = av.x;
    const ay = av.y;
    const az = av.z;
    const mag = Math.hypot(ax, ay, az);

    if (mag <= maxAngvel) {
      continue;
    }

    const scale = maxAngvel / mag;
    record.body.setAngvel({
      x: ax * scale,
      y: ay * scale,
      z: az * scale,
    }, false);
  }
}

function computeBonesCentroid(bones) {
  scratchPosed.set(0, 0, 0);

  if (!bones?.length) {
    return scratchPosed.clone();
  }

  for (const bone of bones) {
    bone.getWorldPosition(scratchCapsuleCenter);
    scratchPosed.add(scratchCapsuleCenter);
  }

  return scratchPosed.multiplyScalar(1 / bones.length).clone();
}

function classifySquishyShardVerticalRole(centroid, plane) {
  if (Math.abs(plane.normal.y) > 0.2) {
    const planeY = -(plane.normal.x * centroid.x
      + plane.normal.z * centroid.z
      + plane.constant) / plane.normal.y;
    return centroid.y > planeY ? 'upper' : 'lower';
  }

  return centroid.y > 1.0 ? 'upper' : 'lower';
}

function computeRagdollSpawnLinvel({
  plane,
  sideSign,
  radiusScale,
  isStiff,
  isMixamoSquishy,
  bone,
  shardVerticalRole,
  isShardRoot,
}) {
  if (isMixamoSquishy) {
    return computeSquishyBodySpawnLinvel({
      plane,
      sideSign,
      bone,
      radiusScale,
      shardVerticalRole,
      isShardRoot,
    });
  }

  return {
    x: plane.normal.x * sideSign * RAGDOLL_IMPULSE * radiusScale,
    y: RAGDOLL_UPWARD_IMPULSE * radiusScale,
    z: plane.normal.z * sideSign * RAGDOLL_IMPULSE * radiusScale,
  };
}

function computeRagdollSpawnAngvel({
  plane,
  sideSign,
  isStiff,
  isMixamoSquishy,
  isShardRoot,
}) {
  if (isMixamoSquishy) {
    return isShardRoot
      ? computeSquishyTipOverAngvel(plane, sideSign)
      : { x: 0, y: 0, z: 0 };
  }

  const baseScale = STIFF_ANGVEL_SCALE;
  return {
    x: (0.12 + Math.abs(plane.normal.z) * 0.35) * baseScale,
    y: sideSign * 0.35 * baseScale,
    z: (-0.12 - Math.abs(plane.normal.x) * 0.35) * baseScale,
  };
}

function buildRagdollColliderDesc({
  physicsSystem,
  scheme,
  bone,
  radius,
  bodyQuaternion,
  isMixamoSquishy,
}) {
  const density = scheme.density(bone.name);
  const boneNameNorm = normalizeMixamoBoneName(bone.name);
  const isLimbCollider = isMixamoSquishy && classifyMixamoSquishyLimb(boneNameNorm) !== null;
  const friction = isLimbCollider ? RAGDOLL_LIMB_COLLIDER_FRICTION : RAGDOLL_COLLIDER_FRICTION;
  const shape = isMixamoSquishy && typeof scheme.colliderShape === 'function'
    ? scheme.colliderShape(bone.name)
    : 'ball';

  if (shape === 'capsule') {
    const childBone = bone.children?.find((child) => child.isBone);
    bone.getWorldPosition(tempWorldPosition);

    if (childBone) {
      childBone.getWorldPosition(scratchPosed);
    } else {
      scratchPosed.copy(tempWorldPosition).add(
        scratchCapsuleDir.set(0, radius * 3, 0).applyQuaternion(bodyQuaternion),
      );
    }

    const segmentLength = tempWorldPosition.distanceTo(scratchPosed);
    const halfHeight = Math.max(0.02, (segmentLength - radius * 2) * 0.5);
    scratchCapsuleCenter.copy(tempWorldPosition).lerp(scratchPosed, 0.5);
    scratchCapsuleDir.copy(scratchPosed).sub(tempWorldPosition);

    if (scratchCapsuleDir.lengthSq() < 1e-8) {
      scratchCapsuleDir.set(0, 1, 0);
    } else {
      scratchCapsuleDir.normalize();
    }

    scratchCapsuleQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), scratchCapsuleDir);
    scratchColliderLocalQuat.copy(bodyQuaternion).invert().multiply(scratchCapsuleQuat);
    scratchColliderOffset.copy(scratchCapsuleCenter).sub(tempWorldPosition)
      .applyQuaternion(scratchBindRel.copy(bodyQuaternion).invert());

    return physicsSystem.RAPIER.ColliderDesc.capsule(halfHeight, radius)
      .setTranslation(
        scratchColliderOffset.x,
        scratchColliderOffset.y,
        scratchColliderOffset.z,
      )
      .setRotation({
        x: scratchColliderLocalQuat.x,
        y: scratchColliderLocalQuat.y,
        z: scratchColliderLocalQuat.z,
        w: scratchColliderLocalQuat.w,
      })
      .setDensity(density)
      .setFriction(friction)
      .setRestitution(0)
      .setCollisionGroups(CUT_RAGDOLL_WORLD_ONLY_GROUPS);
  }

  return physicsSystem.RAPIER.ColliderDesc.ball(radius)
    .setDensity(density)
    .setFriction(friction)
    .setRestitution(0)
    .setCollisionGroups(CUT_RAGDOLL_WORLD_ONLY_GROUPS);
}

function cloneRigMaterials(material, ownedMaterials, { includeCap = false } = {}) {
  const primary = Array.isArray(material)
    ? material[0]
    : material;

  if (includeCap) {
    return [
      cloneRigMaterial(primary, ownedMaterials),
      cloneCutSocketMaterial(primary, ownedMaterials),
    ];
  }

  if (Array.isArray(material)) {
    return material.map((entry) => cloneRigMaterial(entry, ownedMaterials));
  }

  return cloneRigMaterial(material, ownedMaterials);
}

function cloneRigMaterial(material, ownedMaterials) {
  const clone = material?.clone?.() ?? new THREE.MeshStandardMaterial({ color: 0x4f786c });

  if ('skinning' in clone) {
    clone.skinning = true;
  }

  clone.needsUpdate = true;
  ownedMaterials.push(clone);
  return clone;
}

function cloneCutSocketMaterial(material, ownedMaterials) {
  const clone = material?.clone?.() ?? new THREE.MeshStandardMaterial({ color: 0x353b38 });

  if ('skinning' in clone) {
    clone.skinning = true;
  }

  if (clone.map) {
    clone.map = clone.map.clone();
    clone.map.wrapS = THREE.RepeatWrapping;
    clone.map.wrapT = THREE.RepeatWrapping;
    clone.map.repeat.set(3.3, 2.1);
    clone.map.offset.set(0.37, 0.19);
    clone.map.rotation = Math.PI * 0.31;
    clone.map.center.set(0.5, 0.5);
    clone.map.needsUpdate = true;
  }

  if ('color' in clone) {
    clone.color.multiplyScalar(0.72);
    clone.color.offsetHSL(0.03, -0.12, -0.06);
  }

  if ('metalness' in clone) {
    clone.metalness = Math.max(clone.metalness ?? 0, 0.38);
  }

  if ('roughness' in clone) {
    clone.roughness = Math.min(Math.max(clone.roughness ?? 0.5, 0.42), 0.68);
  }

  clone.name = `${material?.name ?? 'cut'} socket`;
  clone.needsUpdate = true;
  ownedMaterials.push(clone);
  return clone;
}

function createSkinnedBoneFollowers({ meshes, records }) {
  if (!meshes?.length || !records?.length) {
    return [];
  }

  const simulatedBones = new Set(records.map((record) => record.bone));
  const recordByBone = new Map(records.map((record) => [record.bone, record]));
  const usedBones = new Set();

  for (const mesh of meshes) {
    const skinIndex = mesh.geometry?.getAttribute('skinIndex');
    const skinWeight = mesh.geometry?.getAttribute('skinWeight');
    const bones = mesh.skeleton?.bones ?? [];

    if (!skinIndex || !skinWeight || !bones.length) {
      continue;
    }

    const vertexCount = Math.min(skinIndex.count, skinWeight.count);

    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.getComponent(vertexIndex, slot);

        if (!Number.isFinite(weight) || weight <= 0.00001) {
          continue;
        }

        const bone = bones[Math.round(skinIndex.getComponent(vertexIndex, slot))];

        if (bone && !simulatedBones.has(bone)) {
          usedBones.add(bone);
        }
      }
    }
  }

  const followers = [];

  for (const bone of usedBones) {
    const record = findNearestRagdollParent(bone, recordByBone)
      ?? findNearestRagdollRecord(bone, records);

    if (!record) {
      continue;
    }

    bone.getWorldPosition(tempWorldPosition);
    bone.getWorldQuaternion(tempWorldQuaternion);
    followers.push({
      bone,
      record,
      localPosition: worldPointToBodyLocal({
        point: tempWorldPosition,
        bodyPosition: record.initialPosition,
        bodyQuaternion: record.initialQuaternion,
      }),
      localQuaternion: record.initialQuaternion.clone().invert().multiply(tempWorldQuaternion),
    });
  }

  return followers;
}

function collectRagdollBones({
  rigRoot,
  plane,
  sideSign,
  constraints = null,
  bodyOffset,
  enemy = null,
}) {
  const candidates = [];
  const scheme = getBoneScheme(enemy);
  const maxBodies = scheme.maxBodiesPerHalf ?? RAGDOLL_MAX_BODIES_PER_HALF;

  rigRoot.updateMatrixWorld(true);
  rigRoot.traverse((object) => {
    if (!object.isBone || !scheme.pattern.test(object.name)) {
      return;
    }

    if (typeof scheme.simulateBone === 'function' && !scheme.simulateBone(object.name)) {
      return;
    }

    object.getWorldPosition(tempWorldPosition);
    const unoffsetPosition = tempWorldPosition.clone().sub(bodyOffset);
    const signedDistance = constraints?.length
      ? Math.min(...constraints.map((constraint) => (
        constraint.plane.distanceToPoint(unoffsetPosition) * constraint.sideSign
      )))
      : plane.distanceToPoint(unoffsetPosition) * sideSign;

    candidates.push({
      bone: object,
      signedDistance,
      priority: scheme.priority(object.name),
    });
  });

  const selected = candidates
    .filter((entry) => entry.signedDistance >= -RAGDOLL_SIDE_MARGIN)
    .sort((a, b) => b.priority - a.priority || b.signedDistance - a.signedDistance)
    .slice(0, maxBodies)
    .map((entry) => entry.bone);

  if (selected.length >= 3) {
    return selected;
  }

  return candidates
    .sort((a, b) => b.signedDistance - a.signedDistance)
    .slice(0, Math.min(6, maxBodies))
    .map((entry) => entry.bone);
}

function findNearestRagdollParent(bone, recordByBone) {
  let current = bone.parent;

  while (current) {
    const record = recordByBone.get(current);

    if (record) {
      return record;
    }

    current = current.parent;
  }

  return null;
}

function findNearestRagdollRecord(bone, records) {
  bone.getWorldPosition(tempWorldPosition);
  let nearest = null;
  let nearestDistance = Infinity;

  for (const record of records) {
    const distance = tempWorldPosition.distanceToSquared(record.initialPosition);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = record;
    }
  }

  return nearest;
}

function getBoneDepth(bone) {
  let depth = 0;
  let current = bone?.parent;

  while (current) {
    depth += 1;
    current = current.parent;
  }

  return depth;
}

// One-time, depth-sorted list of every bone this shard drives each frame
// (physics bodies first, then followers). Parents sort before children so the
// world->local conversion in setBoneWorldTransform always sees a parent whose
// matrixWorld was already updated this frame.
function buildRagdollDrivenOrder(bodies, followers) {
  const order = [];

  for (const record of bodies ?? []) {
    order.push({ kind: 'body', bone: record.bone, record });
  }

  for (const follower of followers ?? []) {
    order.push({ kind: 'follower', bone: follower.bone, follower });
  }

  order.sort((a, b) => getBoneDepth(a.bone) - getBoneDepth(b.bone));
  return order;
}

function worldPointToBodyLocal({
  point,
  bodyPosition,
  bodyQuaternion,
}) {
  return point.clone()
    .sub(bodyPosition)
    .applyQuaternion(bodyQuaternion.clone().invert());
}

function setBoneWorldTransform({ bone, position, quaternion }) {
  const parent = bone.parent;

  parent?.updateMatrixWorld(true);
  bone.updateMatrixWorld(true);
  tempBoneScale.copy(bone.scale);
  bone.matrixWorld.decompose(tempWorldPosition, tempWorldQuaternion, tempWorldScale);
  tempWorldMatrix.compose(position, quaternion, tempWorldScale);

  if (parent) {
    tempParentInverse.copy(parent.matrixWorld).invert();
    tempLocalMatrix.multiplyMatrices(tempParentInverse, tempWorldMatrix);
  } else {
    tempLocalMatrix.copy(tempWorldMatrix);
  }

  tempLocalMatrix.decompose(bone.position, bone.quaternion, tempWorldScale);
  bone.scale.copy(tempBoneScale);
  bone.updateMatrixWorld(true);
}

function resolveCameraBasis(camera) {
  camera.updateMatrixWorld(true);
  camera.getWorldDirection(cameraForward).normalize();
  cameraForward.y = 0;
  if (cameraForward.lengthSq() < 0.0001) {
    cameraForward.set(0, 0, -1);
  } else {
    cameraForward.normalize();
  }
  cameraUp.set(0, 1, 0);
  cameraRight.crossVectors(cameraForward, cameraUp).normalize();
}

function cloneCutBodyMaterial(material) {
  if (!material || typeof material.clone !== 'function') {
    return null;
  }

  const clone = material.clone();

  if ('skinning' in clone) {
    clone.skinning = false;
  }

  clone.needsUpdate = true;
  return clone;
}

function cloneCutCapMaterial(material) {
  if (material && typeof material.clone === 'function') {
    const clone = material.clone();
    clone.needsUpdate = true;
    return clone;
  }

  return createJaggedMetalCapMaterial();
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function attachCutPropPhysics({
  physicsSystem,
  position,
  spawnLinvel,
  spawnAngvel,
  geometry,
  fallbackSize,
  colliderMode,
}) {
  const world = physicsSystem?.world;
  const RAPIER = physicsSystem?.RAPIER;

  if (!world || !RAPIER) {
    return { body: null, colliderType: 'none' };
  }

  if (
    !Number.isFinite(position.x)
    || !Number.isFinite(position.y)
    || !Number.isFinite(position.z)
  ) {
    return { body: null, colliderType: 'none' };
  }

  let body = null;
  try {
    body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setLinvel(
          finiteOrZero(spawnLinvel?.x),
          finiteOrZero(spawnLinvel?.y),
          finiteOrZero(spawnLinvel?.z),
        )
        .setAngvel({
          x: finiteOrZero(spawnAngvel?.x),
          y: finiteOrZero(spawnAngvel?.y),
          z: finiteOrZero(spawnAngvel?.z),
        })
        .setLinearDamping(STATIC_CHUNK_LINEAR_DAMPING)
        .setAngularDamping(STATIC_CHUNK_ANGULAR_DAMPING),
    );
  } catch (error) {
    console.warn('Cut prop rigid body creation failed.', error);
    return { body: null, colliderType: 'none' };
  }

  if (!body) {
    return { body: null, colliderType: 'none' };
  }

  const attachFallbackBall = () => {
    world.createCollider(
      RAPIER.ColliderDesc.ball(Math.max(PROP_MIN_HALF_EXTENT, 0.06))
        .setDensity(1.35)
        .setFriction(0.82)
        .setRestitution(0.08),
      body,
    );
    return { body, colliderType: 'fallback-ball' };
  };

  try {
    const colliderResult = createDynamicMeshColliderDesc({
      RAPIER,
      geometry,
      fallbackSize,
      minHalfExtent: PROP_MIN_HALF_EXTENT,
      mode: colliderMode,
    });
    const descs = (colliderResult?.descs ?? []).filter(Boolean);

    if (!descs.length) {
      return attachFallbackBall();
    }

    for (const baseDesc of descs) {
      const colliderDesc = baseDesc
        .setDensity(1.35)
        .setFriction(0.82)
        .setRestitution(0.08);
      world.createCollider(colliderDesc, body);
    }

    return { body, colliderType: colliderResult.type ?? 'unknown' };
  } catch (error) {
    console.warn('Cut prop collider creation failed; using fallback sphere.', error);
    try {
      return attachFallbackBall();
    } catch (fallbackError) {
      console.warn('Cut prop fallback collider failed; dropping physics.', fallbackError);
      try {
        world.removeRigidBody(body);
      } catch {}
      return { body: null, colliderType: 'none' };
    }
  }
}

function disposeMaterial(material) {
  if (Array.isArray(material)) {
    material.forEach((entry) => entry?.dispose?.());
    return;
  }

  material?.dispose?.();
}

// Ramp a prop's material opacity toward zero during its final fade window.
// `opacity` is the remaining fraction (1 → 0). Captures each material's base
// opacity on first contact so materials that ship with opacity < 1 still fade
// correctly. Static chunks own a 2-slot array [body, cap]; ragdoll shards have
// many materials across their skeleton, so we traverse.
function applyCutPropFade(prop, opacity) {
  const fadeMaterial = (material) => {
    if (!material) {
      return;
    }
    if (material.__cutFadeBaseOpacity === undefined) {
      material.__cutFadeBaseOpacity = Number.isFinite(material.opacity)
        ? material.opacity
        : 1;
    }
    material.transparent = true;
    material.opacity = material.__cutFadeBaseOpacity * opacity;
    material.needsUpdate = true;
  };

  if (prop.type === 'rigRagdoll') {
    prop.root?.traverse?.((child) => {
      if (!child.isMesh && !child.isSkinnedMesh) {
        return;
      }
      const material = child.material;
      if (Array.isArray(material)) {
        material.forEach(fadeMaterial);
      } else {
        fadeMaterial(material);
      }
    });
    return;
  }

  const material = prop.mesh?.material;
  if (Array.isArray(material)) {
    material.forEach(fadeMaterial);
  } else {
    fadeMaterial(material);
  }
}

function cutDebugCountVisibleMeshes(root) {
  let count = 0;
  root?.traverse?.((child) => {
    if ((child.isMesh || child.isSkinnedMesh) && child.visible) {
      count += 1;
    }
  });
  return count;
}

// Vertex count drives smallest-first eviction: rigRagdoll shards are treated as
// maximally important (never prefer them for removal); static chunks by verts.
function cutPropVertexCount(prop) {
  if (prop.type === 'rigRagdoll') {
    return Infinity;
  }
  return prop.mesh?.geometry?.getAttribute?.('position')?.count ?? 0;
}

function countCutPropsByKind(props) {
  const recuttable = props.filter((prop) => prop.recuttable).length;
  return {
    recuttable,
    standard: props.length - recuttable,
    total: props.length,
  };
}

function isOverCutPropBudget(props) {
  const { recuttable, standard } = countCutPropsByKind(props);
  return standard > MAX_CUT_PROPS || recuttable > MAX_DESTRUCTIBLE_CUT_PROPS;
}

function cutDebugPropPosition(prop) {
  try {
    if (prop.type === 'rigRagdoll') {
      const record = prop.ragdollBodies?.[0];
      return record ? record.body.translation() : null;
    }
    return prop.body?.translation?.() ?? null;
  } catch {
    return null;
  }
}

function cutDebugLogProp(label, prop) {
  const position = cutDebugPropPosition(prop);
  const height = position ? `pos=(${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})` : 'pos=?';

  if (prop.type === 'rigRagdoll') {
    console.log(`[cut-debug] ${label} RIG region=${prop.region?.primary} bodies=${prop.ragdollBodies?.length ?? 0} visibleMeshes=${cutDebugCountVisibleMeshes(prop.root)} inScene=${Boolean(prop.root?.parent)} ${height}`);
  } else {
    const verts = prop.mesh?.geometry?.getAttribute?.('position')?.count ?? 0;
    console.log(`[cut-debug] ${label} STATIC region=${prop.region?.primary} verts=${verts} inScene=${Boolean(prop.mesh?.parent)} visible=${prop.mesh?.visible} ${height}`);
  }
}

function cutDebugLogDispose(reason, prop) {
  const position = cutDebugPropPosition(prop);
  const height = position ? `pos=(${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})` : 'pos=?';
  console.warn(`[cut-debug] DISPOSE reason=${reason} type=${prop.type} region=${prop.region?.primary} ${height} age=${(prop.age ?? 0).toFixed(2)}`);
}

/** M5: platform / trailer world velocity cached on the enemy while riding. */
export function getEnemyPlatformVelocity(enemy) {
  if (!enemy) return null;
  const pv = enemy.platformVelocity;
  if (pv && (Math.abs(pv.x) + Math.abs(pv.y) + Math.abs(pv.z) > 1e-6)) {
    return { x: pv.x, y: pv.y, z: pv.z };
  }
  const lp = enemy.platformSupport?.lastPointVelocity;
  if (lp && (Math.abs(lp.x) + Math.abs(lp.y) + Math.abs(lp.z) > 1e-6)) {
    return { x: lp.x, y: lp.y, z: lp.z };
  }
  return null;
}

export function composeLaunchVelocity(base, platformVel) {
  if (!base && !platformVel) return null;
  return {
    x: (base?.x ?? 0) + (platformVel?.x ?? 0),
    y: (base?.y ?? 0) + (platformVel?.y ?? 0),
    z: (base?.z ?? 0) + (platformVel?.z ?? 0),
  };
}

function applyPlatformVelocityToCutProps(enemy, props) {
  const pv = getEnemyPlatformVelocity(enemy);
  if (!pv || !props?.length) return;
  for (const prop of props) {
    for (const record of prop.ragdollBodies ?? []) {
      try {
        const v = record.body.linvel();
        record.body.setLinvel(
          { x: v.x + pv.x, y: v.y + pv.y, z: v.z + pv.z },
          true,
        );
      } catch {
        // ignore transient aliasing
      }
    }
  }
}
