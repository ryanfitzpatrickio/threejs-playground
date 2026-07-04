import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MaraAnimationController, prepareClip, trimClipEnd, trimClipStart } from './MaraAnimationController.js';
import { MARA_ANIMATION_MANIFEST, MARA_MODEL_URL } from './maraAnimationManifest.js';
import { flattenObjectForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import { resolveSourceAnimation } from '../player/sourceSkeletons.js';

const TARGET_CHARACTER_HEIGHT = 1.72;
const _normalizeVec = new THREE.Vector3();
const HANG_ROOT_ANIMATION_STATES = new Set([
  'bracedHangAttach',
  'bracedHangDrop',
  'bracedHangHopLeft',
  'bracedHangHopRight',
  'bracedHangHopUp',
  'bracedHangShimmyLeft',
  'bracedHangShimmyRight',
  'bracedHangShimmyAlt',
  'bracedHangToCrouch',
  'dropToFreeHang',
  'freeHangIdleAlt',
  'freeHangIdleAlt2',
  'hanging',
  'freeHangHopLeft',
  'freeHangHopLeftAlt',
  'freeHangHopRight',
  'freeHangHopRightAlt',
  'freeHangClimb',
  'freeHangDrop',
  'idleToBracedHang',
  'jumpFromWall',
  'leftShimmy',
  'rightShimmy',
  'movingWhileHanging',
  'standToFreeHang',
]);
const HANG_ROOT_MOTION_STATES = new Set([
  'bracedHangHopLeft',
  'bracedHangHopRight',
  'bracedHangHopUp',
  'bracedHangShimmyLeft',
  'bracedHangShimmyRight',
  'bracedHangShimmyAlt',
  'freeHangHopLeft',
  'freeHangHopLeftAlt',
  'freeHangHopRight',
  'freeHangHopRightAlt',
  'leftShimmy',
  'rightShimmy',
  'movingWhileHanging',
]);
const HANG_VERTICAL_ROOT_MOTION_STATES = new Set([
  'bracedHangHopUp',
]);
const CLIMB_ROOT_MOTION_STATES = new Set([
  'bracedHangToCrouch',
  'bracedHangToCrouchDown',
  'freeHangClimb',
  'freeHangClimbDown',
]);
const VAULT_ROOT_MOTION_STATES = new Set([
  'idleSmallVault',
  'runVault',
  'runButtVault',
  'runFancyVault',
]);
const HORSE_RIDER_ARM_PREFIXES = [
  'mixamorigLeftShoulder',
  'mixamorigLeftArm',
  'mixamorigLeftForeArm',
  'mixamorigLeftHand',
  'mixamorigRightShoulder',
  'mixamorigRightArm',
  'mixamorigRightForeArm',
  'mixamorigRightHand',
];
const HORSE_RIDER_STABLE_POSE_PREFIXES = [
  ...HORSE_RIDER_ARM_PREFIXES,
  'mixamorigLeftUpLeg',
  'mixamorigLeftLeg',
  'mixamorigLeftFoot',
  'mixamorigLeftToeBase',
  'mixamorigRightUpLeg',
  'mixamorigRightLeg',
  'mixamorigRightFoot',
  'mixamorigRightToeBase',
];
const HORSE_ANIMATION_MANIFEST = {
  getOnHorse: {
    url: '/assets/animation-packs/horse/get-on-horse.fbx',
    loop: false,
    fadeIn: 0.12,
    timeScale: 2, // play 2x as fast
    rootPosition: 'locked',
    useBakedClip: false,
    trackOverrideSourceState: 'ridingHorse',
    trackOverrideBonePrefixes: HORSE_RIDER_ARM_PREFIXES,
  },
  ridingHorse: {
    url: '/assets/animation-packs/horse/riding.fbx',
    loop: true,
    fadeIn: 0.18,
    rootPosition: 'locked',
    useBakedClip: false,
    allowedBonePrefixes: HORSE_RIDER_STABLE_POSE_PREFIXES,
  },
  getOffHorse: {
    url: '/assets/animation-packs/horse/get-off-horse.fbx',
    loop: false,
    fadeIn: 0.12,
    timeScale: 2, // play 2x as fast
    rootPosition: 'locked',
    useBakedClip: false,
    trackOverrideSourceState: 'ridingHorse',
    trackOverrideBonePrefixes: HORSE_RIDER_ARM_PREFIXES,
  },
};

export async function createMaraFbxModel({
  modelUrl = MARA_MODEL_URL,
  modelId = 'mixamo',
  skeletonSource = 'mixamo',
} = {}) {
  const isGlb = modelUrl.toLowerCase().endsWith('.glb') || modelUrl.toLowerCase().endsWith('.gltf');
  const baseLoader = isGlb ? createGltfLoader() : new FBXLoader();
  const fbxLoader = new FBXLoader(); // always used for animation clip FBXs

  const group = new THREE.Group();
  group.name = isGlb ? 'Mara Vey GLB Character' : 'Mara Vey FBX Character';

  let loaded = await baseLoader.loadAsync(assetUrl(modelUrl));
  // GLTFLoader returns { scene, ... }; FBXLoader returns the root object directly
  let object = isGlb ? (loaded.scene || loaded) : loaded;
  object.name = isGlb ? 'Mara Climber GLB' : 'Mara Climber FBX';

  // Make sure world matrices + skeleton are ready as early as possible for GLB skinned models.
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    if (child.isSkinnedMesh && child.skeleton) {
      child.skeleton.update();
    }
  });

  object.traverse(prepareRenderable);

  // De-interleave + de-quantize attributes into WebGPU-safe formats. Tripo /
  // gltf-transform produce interleaved, normalized, quantized attributes that
  // make the WebGPU backend synthesize an invalid `unorm32x4` vertex format,
  // so GPUDevice.createRenderPipeline throws and the mesh renders broken /
  // spiky. WebGLRenderer handles the same data fine. Must run before any
  // bounding-box / bind-pose work that reads the geometry. See prepareWebGPUGeometry.js.
  flattenObjectForWebGPU(object);

  if (isGlb) {
    // climber.glb is a Tripo mesh rigged onto a Mixamo skeleton, then FBX→GLB
    // converted. That conversion leaves a residual +90° X rotation (and a 0.01
    // cm→m scale) on both the Armature and SkinnedMesh nodes — FBXLoader baked
    // these away for the old .fbx path, the GLB does not. Counter-rotate so the
    // character stands upright. The game only rotates `group` for facing (never
    // `object`), so this is stable; rotating the common ancestor preserves skinning.
    object.rotation.x = -Math.PI / 2;
  }
  object.updateMatrixWorld(true);

  const rootBindPosition = object.getObjectByName('mixamorigHips')?.position.clone() ?? new THREE.Vector3();
  const targetBindRotations = collectBindRotations(object);
  const targetNames = collectTargetNames(object);

  const modelScale = normalizeCharacterObject(object);

  // IMPORTANT: do NOT call skeleton.calculateInverses() here. A properly
  // exported GLB already ships correct inverse-bind matrices, and three's
  // SkinnedMesh keeps a frozen `bindMatrix` from load time. Recomputing the
  // inverse-binds from the *post-rotation/normalize* bone matrices makes them
  // inconsistent with that frozen bindMatrix, which is exactly what was
  // collapsing/deforming the mesh (it rendered lying down / wrong scale). The
  // mesh skins correctly with the authored inverse-binds as long as we only add
  // parent transforms (rotation + uniform scale) above the skeleton root, which
  // normalizeCharacterObject does. Just refresh the skeleton's bone matrices.
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    if (child.isSkinnedMesh && child.skeleton) {
      child.skeleton.update();
    }
  });

  group.add(object);
  group.updateMatrixWorld(true);

  // Root motion is sampled from the mixamorigHips.position track (expressed in
  // the animation's local bone units) and applied as a WORLD-space translation.
  // The correct conversion factor is the world scale of the hips bone's PARENT
  // frame, not the bare normalize scale: a GLB exported from Blender keeps the
  // armature's intrinsic unit scale (e.g. 0.01 for cm→m) ABOVE the skeleton, so
  // modelScale alone is ~100× too large and the player teleports. Deriving it
  // from the hierarchy is correct for both the FBX and GLB pipelines.
  const rootMotionScale = computeRootMotionScale(object) ?? modelScale;

  const mixer = new THREE.AnimationMixer(object);

  // Load core animations first for instant start.
  const { coreClips, loadRest } = await loadAnimationClipsPartial({
    loader: fbxLoader,
    rootBindPosition,
    targetBindRotations,
    targetNames,
    modelScale: rootMotionScale,
    skeletonSource,
  });

  const animationController = new MaraAnimationController({
    mixer,
    clips: coreClips,
    modelRoot: object,
    skeletonSource,
  });
  animationController.start();

  // Stream the remaining animations in the background without blocking startup.
  loadRest().then((restClips) => {
    if (restClips && restClips.size > 0) {
      animationController.addClips(restClips);
    }
  }).catch((e) => console.warn('Failed to load some animation clips', e));

  return {
    group,
    velocity: new THREE.Vector3(),
    animationController,
    source: isGlb ? 'glb' : 'fbx',
    modelId,
    skeletonSource,
  };
}

async function loadAnimationClipsPartial({
  loader,
  rootBindPosition,
  targetBindRotations,
  targetNames,
  modelScale,
  skeletonSource = 'mixamo',
}) {
  const canonicalManifest = { ...MARA_ANIMATION_MANIFEST, ...HORSE_ANIMATION_MANIFEST };
  const manifest = Object.fromEntries(
    Object.keys(canonicalManifest)
      .map((state) => [state, resolveSourceAnimation(skeletonSource, state, canonicalManifest)])
      .filter(([, entry]) => entry),
  );

  const CORE_STATES = new Set([
    'idle', 'jog', 'sprint', 'runningSlide',
    'mudIdle', 'mudWalk', 'mudRun', 'mudStandingJump', 'mudRunJump',
    'armedIdle', 'armedJog', 'armedSprint',
    'drawSword', 'sheatheSword',
    'lightSlash1', 'lightSlash2', 'lightSlash3', 'heavyAttack',
    'aimCutVertical', 'aimCutHorizontal',
    'armedHitBackward', 'armedHitThrown',
    'teleGrab', 'teleHold', 'teleThrow',
    'armedTeleGrab', 'armedTeleHold', 'armedTeleThrow',
    'jumpBig', 'landRoll', 'frontFlip', 'frontTwistFlip', 'aerialEvade',
    'wingsuitCoast', 'wingsuitDive',
  ]);

  const coreEntries = Object.entries(manifest).filter(([state]) => CORE_STATES.has(state));
  const restEntries = Object.entries(manifest).filter(([state]) => !CORE_STATES.has(state));

  const coreClips = new Map();

  await Promise.all(
    coreEntries.map(async ([state, entry]) => {
      const retargetedClip = await loadRetargetedClip({ entry, state });

      if (retargetedClip) {
        const clipped = trimClipStart(trimClipEnd(retargetedClip, entry.endAt), entry.startAt);
        coreClips.set(state, {
          clip: clipped,
          loop: entry.loop,
          pingPong: entry.pingPong === true,
          fadeIn: entry.fadeIn,
          timeScale: entry.timeScale,
          reversed: entry.reversed === true,
          transitions: entry.transitions,
        });
        return;
      }

      const source = await loader.loadAsync(assetUrl(entry.url));
      const clip = source.animations[0];

      if (!clip) {
        throw new Error(`No FBX animation clip found for ${state}: ${entry.url}`);
      }

      coreClips.set(state, {
        clip: prepareClip({
          clip,
          state,
          rootBindPosition,
          sourceBindRotations: collectBindRotations(source),
          targetBindRotations,
          targetNames,
          retargetQuaternionTracks: entry.retarget !== false,
          rootPosition: rootPositionModeFor({ state, entry }),
          maskedBonePrefixes: entry.maskedBonePrefixes,
          allowedBonePrefixes: entry.allowedBonePrefixes,
          endAt: entry.endAt,
          startAt: entry.startAt,
          rootMotion: rootMotionFor({ state, entry }),
          rootMotionScale: modelScale,
        }),
        loop: entry.loop,
        pingPong: entry.pingPong === true,
        fadeIn: entry.fadeIn,
        timeScale: entry.timeScale,
        reversed: entry.reversed === true,
        transitions: entry.transitions,
      });
    }),
  );

  const loadRest = async () => {
    const restClips = new Map();
    await Promise.all(
      restEntries.map(async ([state, entry]) => {
        const retargetedClip = await loadRetargetedClip({ entry, state });

        if (retargetedClip) {
          const clipped = trimClipStart(trimClipEnd(retargetedClip, entry.endAt), entry.startAt);
          restClips.set(state, {
            clip: clipped,
            loop: entry.loop,
            pingPong: entry.pingPong === true,
            fadeIn: entry.fadeIn,
            timeScale: entry.timeScale,
            reversed: entry.reversed === true,
            transitions: entry.transitions,
          });
          return;
        }

        const source = await loader.loadAsync(assetUrl(entry.url));
        const clip = source.animations[0];
        if (!clip) return;

        restClips.set(state, {
          clip: prepareClip({
            clip,
            state,
            rootBindPosition,
            sourceBindRotations: collectBindRotations(source),
            targetBindRotations,
            targetNames,
            retargetQuaternionTracks: entry.retarget !== false,
            rootPosition: rootPositionModeFor({ state, entry }),
            maskedBonePrefixes: entry.maskedBonePrefixes,
            allowedBonePrefixes: entry.allowedBonePrefixes,
            endAt: entry.endAt,
            startAt: entry.startAt,
            rootMotion: rootMotionFor({ state, entry }),
            rootMotionScale: modelScale,
          }),
          loop: entry.loop,
          pingPong: entry.pingPong === true,
          fadeIn: entry.fadeIn,
          timeScale: entry.timeScale,
          reversed: entry.reversed === true,
          transitions: entry.transitions,
        });
      }),
    );
    applyClipTrackOverrides({ clips: restClips, manifest: Object.fromEntries(restEntries) });
    return restClips;
  };

  applyClipTrackOverrides({ clips: coreClips, manifest: Object.fromEntries(coreEntries) });

  return { coreClips, loadRest };
}

// Keep old name for any remaining direct calls (none expected now).
async function loadAnimationClips(args) {
  const { coreClips } = await loadAnimationClipsPartial(args);
  return coreClips;
}

function applyClipTrackOverrides({ clips, manifest }) {
  for (const [state, entry] of Object.entries(manifest)) {
    if (!entry.trackOverrideSourceState || !entry.trackOverrideBonePrefixes?.length) {
      continue;
    }

    const targetEntry = clips.get(state);
    const sourceEntry = clips.get(entry.trackOverrideSourceState);
    const targetClip = targetEntry?.clip;
    const sourceClip = sourceEntry?.clip;

    if (!targetClip || !sourceClip) {
      continue;
    }

    targetClip.tracks = [
      ...targetClip.tracks.filter((track) => !trackMatchesPrefixes(track, entry.trackOverrideBonePrefixes)),
      ...sourceClip.tracks
        .filter((track) => trackMatchesPrefixes(track, entry.trackOverrideBonePrefixes))
        .map((track) => track.clone()),
    ];
    targetClip.optimize();
  }
}

function trackMatchesPrefixes(track, prefixes) {
  const [targetName] = track.name.split('.');
  return prefixes.some((prefix) => targetName.startsWith(prefix));
}

function rootPositionModeFor({ state, entry }) {
  if (
    HANG_ROOT_MOTION_STATES.has(state) ||
    CLIMB_ROOT_MOTION_STATES.has(state) ||
    VAULT_ROOT_MOTION_STATES.has(state)
  ) {
    return 'locked';
  }

  if (HANG_ROOT_ANIMATION_STATES.has(state)) {
    return 'animated';
  }

  return entry.rootPosition;
}

function rootMotionFor({ state, entry }) {
  if (HANG_ROOT_MOTION_STATES.has(state)) {
    return {
      horizontal: true,
      vertical: HANG_VERTICAL_ROOT_MOTION_STATES.has(state),
      movementScale: 1,
      blend: 1,
      drive: 'hang',
    };
  }

  if (CLIMB_ROOT_MOTION_STATES.has(state)) {
    return {
      horizontal: true,
      vertical: true,
      movementScale: 1,
      blend: 1,
      drive: 'climb',
    };
  }

  if (VAULT_ROOT_MOTION_STATES.has(state)) {
    return {
      horizontal: true,
      vertical: true,
      movementScale: 1,
      blend: 1,
      drive: 'vault',
    };
  }

  return entry.rootMotion;
}

async function loadRetargetedClip({ entry, state }) {
  if (entry.useBakedClip === false) {
    return null;
  }

  const response = await fetch(assetUrl(retargetedClipUrlFor(entry.url)));

  if (!response.ok) {
    return null;
  }

  const clipJson = await response.json();
  const clip = THREE.AnimationClip.parse(clipJson);
  clip.name = state;

  return clip;
}

export function collectBindRotations(object) {
  const rotations = new Map();

  object.traverse((child) => {
    if (child.name && child.isBone) {
      rotations.set(child.name, child.quaternion.clone().normalize());
    }
  });

  return rotations;
}

export function collectTargetNames(object) {
  const names = new Set();

  object.traverse((child) => {
    if (child.name) {
      names.add(child.name);
    }
  });

  return names;
}

export function normalizeCharacterObject(object) {
  // For a skinned character the rendered height is the skeleton's bone extent,
  // NOT the mesh geometry's bind box: climber.glb's mesh geometry is oriented
  // inconsistently with its skeleton after FBX→GLB conversion (its tall axis is
  // local Z while the skeleton is upright), so the bind box gives the wrong
  // height and over-scales. Bone world positions are the trustworthy measure.
  const box = new THREE.Box3();
  object.updateMatrixWorld(true);

  const bones = new Set();
  object.traverse((child) => {
    if (child.isSkinnedMesh && child.skeleton) {
      for (const bone of child.skeleton.bones) bones.add(bone);
    }
  });

  let usedBones = false;
  for (const bone of bones) {
    bone.updateMatrixWorld();
    box.expandByPoint(_normalizeVec.setFromMatrixPosition(bone.matrixWorld));
    usedBones = true;
  }

  if (!usedBones) {
    box.setFromObject(object);
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = TARGET_CHARACTER_HEIGHT / size.y;

  object.scale.setScalar(scale);
  object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);

  return scale;
}

const _rootMotionScalePos = new THREE.Vector3();
const _rootMotionScaleQuat = new THREE.Quaternion();
const _rootMotionScaleVec = new THREE.Vector3();

// World-space uniform scale of the hips bone's parent frame. The hips position
// track is authored in that frame, so this is the factor that converts sampled
// root motion into world units. Works for FBX (parent scale == modelScale) and
// GLB (parent scale == modelScale * armature unit scale).
function computeRootMotionScale(object) {
  const hips = object.getObjectByName('mixamorigHips');
  if (!hips?.parent) {
    return null;
  }

  object.updateMatrixWorld(true);
  hips.parent.matrixWorld.decompose(_rootMotionScalePos, _rootMotionScaleQuat, _rootMotionScaleVec);
  const scale =
    (Math.abs(_rootMotionScaleVec.x) + Math.abs(_rootMotionScaleVec.y) + Math.abs(_rootMotionScaleVec.z)) / 3;

  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

export function prepareRenderable(child) {
  if (!child.isMesh && !child.isSkinnedMesh) {
    return;
  }

  child.castShadow = true;
  child.receiveShadow = true;
  child.frustumCulled = false;

  const materials = Array.isArray(child.material) ? child.material : [child.material];
  for (const material of materials) {
    if (!material) {
      continue;
    }

    // Force dielectric (non-metal) shading to match the environment.
    // All city/terrain materials use metalness=0 (explicit metalnessNode or default).
    // Tripo GLBs commonly export spurious metalness (or metallicRoughness maps)
    // on cloth/skin/gear. With no scene.environment/IBL, metalness suppresses
    // diffuse and (combined with the roughness floor) makes the character
    // much darker than the lit environment under the same Hemisphere+Directional lights.
    material.metalness = 0;
    if (material.metalnessMap) {
      material.metalnessMap = null;
    }

    material.roughness = Math.max(material.roughness ?? 0.6, 0.68);

    if (material.map) {
      material.map.colorSpace = THREE.SRGBColorSpace;
    }

    // Tripo-exported materials ship with alphaMode BLEND (transparent=true,
    // depthWrite=false, DoubleSide) even for fully opaque characters, which
    // renders the mesh see-through with self-sorting artifacts. Force opaque
    // when there's no real alpha so the body writes depth and draws solid.
    if ((material.opacity ?? 1) >= 1) {
      material.transparent = false;
      material.depthWrite = true;
    }

    material.needsUpdate = true;
  }
}

function assetUrl(path) {
  return encodeURI(path);
}

function retargetedClipUrlFor(animationUrl) {
  const fileName = animationUrl.split('/').pop()?.replace(/\.fbx$/i, '') ?? 'animation';
  const slug = fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `/assets/animations-retargeted/${slug || 'animation'}.json`;
}
