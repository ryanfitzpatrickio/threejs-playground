/**
 * Discrete runtime debug controls migrated from the old Solid DebugPanel.
 * Wired through __DREAMFALL_DEBUG__ / GameRuntime — not TSL uniforms.
 */

import {
  registerShaderDebugFolder,
  registerShaderDebugParam,
} from './shaderDebugRegistry.js';
import {
  listCloudTypePresets,
  DEFAULT_CLOUD_TYPE,
  resolveCloudMode,
  CLOUD_MODES,
} from '../render/cloud/cloudConfig.js';
import { listPhotorealismPresets } from '../config/photorealismPresets.js';
import { getQualityPreset, getQualityLevel } from '../config/qualityPresets.js';
import { GAME_CONFIG } from '../config/gameConfig.js';
import {
  bumpGunDebugSocket,
  gunDebugSocket,
  listGunDebugOptions,
  logGunDebugSocket,
  resetGunDebugSocket,
  snapGunDebugSocketToAnchors,
} from '../weapons/gunDebugSocket.js';

/** Local overlay state (not always in snapshot). */
const overlayState = {
  collision: false,
  blade: false,
  worldZones: false,
};

function bridge() {
  return globalThis.__DREAMFALL_DEBUG__ ?? null;
}

function snap(runtime) {
  try {
    return runtime?.snapshot?.({ full: false }) ?? bridge()?.snapshot?.() ?? null;
  } catch {
    return null;
  }
}

function readCloudMode() {
  try {
    const value = localStorage.getItem('dreamfall:clouds');
    if (value === 'volumetric' || value === 'dome' || value === 'off') return value;
  } catch {
    /* ignore */
  }
  return resolveCloudMode(getQualityPreset(getQualityLevel()));
}

function setCloudModeAndReload(mode) {
  if (!CLOUD_MODES.includes(mode)) return;
  try {
    localStorage.setItem('dreamfall:clouds', mode);
  } catch {
    /* ignore */
  }
  location.reload();
}

function readSpectatorCrowd() {
  try {
    return localStorage.getItem('dreamfall:spectator-crowd') === 'true';
  } catch {
    return false;
  }
}

function setSpectatorCrowdAndReload(on) {
  try {
    localStorage.setItem('dreamfall:spectator-crowd', on ? 'true' : 'false');
  } catch {
    /* ignore */
  }
  location.reload();
}

/**
 * @param {object} [runtime] GameRuntime
 */
export function registerRuntimeDebug(runtime = null) {
  registerShaderDebugFolder('Runtime', { expanded: true });
  registerShaderDebugFolder('First Person', { expanded: true });
  registerShaderDebugFolder('Third Person', { expanded: true });
  registerShaderDebugFolder('Sunglasses Socket', { expanded: true });
  registerShaderDebugFolder('Guns', { expanded: true });
  registerShaderDebugFolder('Look', { expanded: false });
  registerShaderDebugFolder('Weather Control', { expanded: true });
  registerShaderDebugFolder('Cloud Mode', { expanded: false });
  registerShaderDebugFolder('Rally', { expanded: false });
  registerShaderDebugFolder('Overlays', { expanded: false });

  // --- Runtime lighting / fog / shadows ---
  registerShaderDebugParam({
    id: 'runtime.clusteredLighting',
    label: 'Clustered lighting',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => snap(runtime)?.renderer?.lightingMode === 'clustered',
    set: (v) => {
      bridge()?.setLightMode?.(v ? 'clustered' : 'hemisphere');
    },
  });

  registerShaderDebugParam({
    id: 'runtime.heightFog',
    label: 'Height fog (volumetric)',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.renderer?.fogEnabled),
    set: (v) => {
      bridge()?.setFog?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.distanceFog',
    label: 'Distance fog (scene)',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => snap(runtime)?.scene?.sceneFogEnabled ?? true,
    set: (v) => {
      bridge()?.setSceneFog?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.shadows',
    label: 'Shadows',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.renderer?.shadows),
    set: (v) => {
      bridge()?.setShadows?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.streetLights',
    label: 'Street lights',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.scene?.streetLightsVisible),
    set: (v) => {
      bridge()?.setStreetLights?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.sun',
    label: 'Sun (directional)',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => snap(runtime)?.scene?.sunUserEnabled ?? true,
    set: (v) => {
      bridge()?.setSun?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.hemisphere',
    label: 'Hemisphere light',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => snap(runtime)?.scene?.hemisphereVisible ?? true,
    set: (v) => {
      bridge()?.setHemisphere?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.headlights',
    label: 'Xenon headlights',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.vehicles?.headlightsEnabled),
    set: (v) => {
      bridge()?.setHeadlights?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.renderCap60',
    label: 'Cap render to 60 fps',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.timing?.renderCap60),
    set: (v) => {
      bridge()?.setRenderCap60?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.timingHud',
    label: 'Timing HUD',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.timing?.showHud),
    set: (v) => {
      bridge()?.setTimingHud?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.sampleAllocation',
    label: 'Sample allocation (3s → console)',
    folder: 'Runtime',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const b = bridge();
      if (!b?.startAllocationSample) return;
      b.startAllocationSample(3000);
      globalThis.setTimeout(() => {
        console.info('[dreamfall] allocation sample', b.allocationSampleReport?.());
      }, 3200);
    },
  });

  // --- First person (on-foot eye mount + FOV). Mutates GAME_CONFIG.camera live. ---
  registerShaderDebugParam({
    id: 'runtime.fpEnabled',
    label: 'On-foot first person',
    folder: 'First Person',
    type: 'bool',
    pinPolicy: 'allow',
    help: 'Toggle on-foot FP view (interiors force FP regardless).',
    get: () => Boolean(snap(runtime)?.camera?.onFootFirstPersonPreference
      ?? gameRuntime()?.cameraSystem?.onFootFirstPerson),
    set: (v) => {
      // Prefer the live GameRuntime (same as gun-debug equip) — not the slim bridge.
      gameRuntime()?.setOnFootFirstPersonEnabled?.(Boolean(v));
    },
  });

  registerCameraFloat({
    id: 'runtime.fpFov',
    key: 'onFootFirstPersonFov',
    label: 'FOV °',
    folder: 'First Person',
    min: 40,
    max: 110,
    step: 0.5,
    help: 'Hip FOV while on foot in first person (ADS still blends to the gun adsFov).',
  });

  registerCameraFloat({
    id: 'runtime.fpEyeHeight',
    key: 'onFootEyeHeight',
    label: 'Eye height (head mount Y)',
    folder: 'First Person',
    min: 0.8,
    max: 2.4,
    step: 0.005,
    help: 'Vertical offset of the eye from character feet (main head-mount height).',
  });

  registerCameraFloat({
    id: 'runtime.fpEyeForward',
    key: 'onFootEyeForward',
    label: 'Eye forward (head mount Z)',
    folder: 'First Person',
    min: -0.4,
    max: 0.6,
    step: 0.005,
    help: 'Horizontal push along look yaw from the character origin (positive = ahead of neck).',
  });

  registerCameraFloat({
    id: 'runtime.fpEyePush',
    key: 'onFootFirstPersonEyePush',
    label: 'Eye push (extra forward)',
    folder: 'First Person',
    min: -0.3,
    max: 0.8,
    step: 0.005,
    help: 'Extra forward bias scaled by look pitch (keeps the camera out of the chest).',
  });

  registerCameraFloat({
    id: 'runtime.fpEyeLift',
    key: 'onFootFirstPersonEyeLift',
    label: 'Eye lift (extra Y)',
    folder: 'First Person',
    min: -0.3,
    max: 0.4,
    step: 0.005,
    help: 'Constant extra vertical lift on top of eye height.',
  });

  registerCameraFloat({
    id: 'runtime.fpPitchHinge',
    key: 'onFootFirstPersonPitchHingeHeight',
    label: 'Pitch hinge height',
    folder: 'First Person',
    min: 0,
    max: 0.4,
    step: 0.005,
    help: 'How much looking up/down pivots the eye vertically around the neck.',
  });

  registerCameraFloat({
    id: 'runtime.fpLookDownPush',
    key: 'onFootFirstPersonEyePushLookDown',
    label: 'Look-down push',
    folder: 'First Person',
    min: 0,
    max: 1.5,
    step: 0.01,
    help: 'Extra forward push when looking down (usually keep near 0).',
  });

  registerCameraFloat({
    id: 'runtime.fpLookDownLift',
    key: 'onFootFirstPersonEyeLiftLookDown',
    label: 'Look-down lift',
    folder: 'First Person',
    min: -0.2,
    max: 0.4,
    step: 0.005,
    help: 'Extra Y lift when looking down.',
  });

  registerCameraFloat({
    id: 'runtime.fpSmoothing',
    key: 'onFootFirstPersonSmoothing',
    label: 'Position smoothing',
    folder: 'First Person',
    min: 4,
    max: 60,
    step: 0.5,
    help: 'How tightly the eye tracks the head mount (higher = snappier).',
  });

  registerCameraFloat({
    id: 'runtime.fpMotionLeadScale',
    key: 'onFootFirstPersonMotionLeadScale',
    label: 'Motion lead scale',
    folder: 'First Person',
    min: 0,
    max: 3,
    step: 0.05,
    help: 'Predicts forward velocity so sprint does not lag the eye behind the neck.',
  });

  registerCameraFloat({
    id: 'runtime.fpMotionLeadMax',
    key: 'onFootFirstPersonMotionLeadMax',
    label: 'Motion lead max (m)',
    folder: 'First Person',
    min: 0,
    max: 1,
    step: 0.01,
    help: 'Cap on motion lead distance.',
  });

  registerCameraFloat({
    id: 'runtime.fpMotionFramingPush',
    key: 'onFootFirstPersonMotionFramingPush',
    label: 'Motion framing push',
    folder: 'First Person',
    min: 0,
    max: 0.3,
    step: 0.005,
    help: 'Extra forward composition while moving so the gun sits lower in frame.',
  });

  registerCameraFloat({
    id: 'runtime.fpMinPitch',
    key: 'onFootFirstPersonMinPitch',
    label: 'Min pitch (look up)',
    folder: 'First Person',
    min: -1.55,
    max: 0,
    step: 0.01,
    help: 'Most negative look pitch in radians (~−1.36 ≈ −78°).',
  });

  registerCameraFloat({
    id: 'runtime.fpMaxPitch',
    key: 'onFootFirstPersonMaxPitch',
    label: 'Max pitch (look down)',
    folder: 'First Person',
    min: 0,
    max: 1.55,
    step: 0.01,
    help: 'Most positive look pitch in radians.',
  });

  registerCameraFloat({
    id: 'runtime.fpMaxNeckYaw',
    key: 'onFootFirstPersonMaxNeckYaw',
    label: 'Max neck yaw',
    folder: 'First Person',
    min: 0.1,
    max: Math.PI,
    step: 0.01,
    help: 'Camera–body yaw offset before the torso auto-turns (radians).',
  });

  registerCameraFloat({
    id: 'runtime.fpStraightenSmoothing',
    key: 'onFootFirstPersonStraightenSmoothing',
    label: 'Body straighten rate',
    folder: 'First Person',
    min: 1,
    max: 40,
    step: 0.5,
    help: 'How fast the body snaps onto look yaw when moving forward.',
  });

  registerShaderDebugParam({
    id: 'runtime.fpLogCamera',
    label: 'Log first-person camera values',
    folder: 'First Person',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const c = GAME_CONFIG.camera;
      console.info('[camera] first person', {
        onFootFirstPersonFov: c.onFootFirstPersonFov,
        onFootEyeHeight: c.onFootEyeHeight,
        onFootEyeForward: c.onFootEyeForward,
        onFootFirstPersonEyePush: c.onFootFirstPersonEyePush,
        onFootFirstPersonEyeLift: c.onFootFirstPersonEyeLift,
        onFootFirstPersonPitchHingeHeight: c.onFootFirstPersonPitchHingeHeight,
        onFootFirstPersonEyePushLookDown: c.onFootFirstPersonEyePushLookDown,
        onFootFirstPersonEyeLiftLookDown: c.onFootFirstPersonEyeLiftLookDown,
        onFootFirstPersonSmoothing: c.onFootFirstPersonSmoothing,
        onFootFirstPersonMotionLeadScale: c.onFootFirstPersonMotionLeadScale,
        onFootFirstPersonMotionLeadMax: c.onFootFirstPersonMotionLeadMax,
        onFootFirstPersonMotionFramingPush: c.onFootFirstPersonMotionFramingPush,
        onFootFirstPersonMinPitch: c.onFootFirstPersonMinPitch,
        onFootFirstPersonMaxPitch: c.onFootFirstPersonMaxPitch,
        onFootFirstPersonMaxNeckYaw: c.onFootFirstPersonMaxNeckYaw,
        onFootFirstPersonStraightenSmoothing: c.onFootFirstPersonStraightenSmoothing,
      });
    },
  });

  // --- Third person (orbit camera + mesh/capsule offsets) ---
  registerCameraFloat({
    id: 'runtime.tpFov',
    key: 'thirdPersonFov',
    label: 'FOV °',
    folder: 'Third Person',
    min: 30,
    max: 100,
    step: 0.5,
    help: 'On-foot third-person field of view.',
  });

  registerCameraFloat({
    id: 'runtime.tpFollowDistance',
    key: 'followDistance',
    label: 'Follow distance',
    folder: 'Third Person',
    min: 1.5,
    max: 20,
    step: 0.05,
    help: 'Default orbit distance (also updates the live camera distance).',
    onSet: (n) => {
      const cam = gameRuntime()?.cameraSystem;
      if (!cam) return;
      const min = Number(GAME_CONFIG.camera.minDistance) || 1;
      const max = Number(GAME_CONFIG.camera.maxDistance) || 20;
      cam.distance = Math.min(max, Math.max(min, n));
    },
  });

  registerCameraFloat({
    id: 'runtime.tpFollowHeight',
    key: 'followHeight',
    label: 'Follow height',
    folder: 'Third Person',
    min: 0.2,
    max: 6,
    step: 0.02,
    help: 'Orbit camera height above the follow target.',
  });

  registerCameraFloat({
    id: 'runtime.tpLookHeight',
    key: 'lookHeight',
    label: 'Look-at height',
    folder: 'Third Person',
    min: 0,
    max: 2.5,
    step: 0.02,
    help: 'Where the camera aims above the character origin (chest / head framing).',
  });

  registerCameraFloat({
    id: 'runtime.tpMinDistance',
    key: 'minDistance',
    label: 'Min zoom distance',
    folder: 'Third Person',
    min: 0.5,
    max: 12,
    step: 0.05,
  });

  registerCameraFloat({
    id: 'runtime.tpMaxDistance',
    key: 'maxDistance',
    label: 'Max zoom distance',
    folder: 'Third Person',
    min: 2,
    max: 30,
    step: 0.05,
  });

  registerCameraFloat({
    id: 'runtime.tpMinPitch',
    key: 'minPitch',
    label: 'Min pitch',
    folder: 'Third Person',
    min: -1.2,
    max: 0.2,
    step: 0.01,
    help: 'Orbit look-up clamp (radians).',
  });

  registerCameraFloat({
    id: 'runtime.tpMaxPitch',
    key: 'maxPitch',
    label: 'Max pitch',
    folder: 'Third Person',
    min: 0,
    max: 1.2,
    step: 0.01,
    help: 'Orbit look-down clamp (radians).',
  });

  registerCameraFloat({
    id: 'runtime.tpLookSensitivity',
    key: 'lookSensitivity',
    label: 'Look sensitivity',
    folder: 'Third Person',
    min: 0.0005,
    max: 0.01,
    step: 0.0001,
    help: 'Shared mouse-look scale for third and first person orbit input.',
  });

  registerCameraFloat({
    id: 'runtime.tpZoomStep',
    key: 'zoomStep',
    label: 'Zoom step',
    folder: 'Third Person',
    min: 0.1,
    max: 2,
    step: 0.05,
  });

  registerCameraFloat({
    id: 'runtime.tpSmoothing',
    key: 'smoothing',
    label: 'Position smoothing',
    folder: 'Third Person',
    min: 1,
    max: 30,
    step: 0.25,
    help: 'How tightly the orbit camera follows the desired mount.',
  });

  registerCameraFloat({
    id: 'runtime.tpTargetSmoothing',
    key: 'targetSmoothing',
    label: 'Target smoothing',
    folder: 'Third Person',
    min: 1,
    max: 40,
    step: 0.25,
    help: 'How tightly the follow target tracks the character.',
  });

  registerCameraFloat({
    id: 'runtime.tpMaxTargetLag',
    key: 'maxTargetLag',
    label: 'Max target lag (m)',
    folder: 'Third Person',
    min: 0.5,
    max: 20,
    step: 0.1,
  });

  registerShaderDebugParam({
    id: 'runtime.playerMeshOffset',
    label: 'Mesh offset height',
    folder: 'Third Person',
    type: 'float',
    min: -0.5,
    max: 0.5,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Visual model Y vs physics feet. Negative lowers the mesh (stops floating feet). Applies every frame.',
    get: () => {
      const n = Number(GAME_CONFIG.character.playerGroundOffset);
      return Number.isFinite(n) ? n : 0;
    },
    set: (v) => {
      const n = Number(v);
      GAME_CONFIG.character.playerGroundOffset = Number.isFinite(n) ? n : 0;
      applyPlayerMeshOffsetNow();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.playerColliderOffset',
    label: 'Collider offset height',
    folder: 'Third Person',
    type: 'float',
    min: -0.5,
    max: 0.5,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Physics capsule Y vs mesh feet. Positive raises the capsule (feet sink); negative lowers it. Turn on Collision overlays to see the capsule.',
    get: () => {
      const n = Number(GAME_CONFIG.character.playerColliderOffset);
      return Number.isFinite(n) ? n : 0;
    },
    set: (v) => {
      const n = Number(v);
      GAME_CONFIG.character.playerColliderOffset = Number.isFinite(n) ? n : 0;
      applyPlayerColliderOffsetNow();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.tpLogCamera',
    label: 'Log third-person camera values',
    folder: 'Third Person',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const c = GAME_CONFIG.camera;
      const cam = gameRuntime()?.cameraSystem;
      console.info('[camera] third person', {
        thirdPersonFov: c.thirdPersonFov,
        followDistance: c.followDistance,
        liveDistance: cam?.distance,
        followHeight: c.followHeight,
        lookHeight: c.lookHeight,
        minDistance: c.minDistance,
        maxDistance: c.maxDistance,
        minPitch: c.minPitch,
        maxPitch: c.maxPitch,
        lookSensitivity: c.lookSensitivity,
        zoomStep: c.zoomStep,
        smoothing: c.smoothing,
        targetSmoothing: c.targetSmoothing,
        maxTargetLag: c.maxTargetLag,
        playerGroundOffset: GAME_CONFIG.character.playerGroundOffset,
        playerColliderOffset: GAME_CONFIG.character.playerColliderOffset,
      });
    },
  });

  // --- Default-player sunglasses socket (live attachment fitting) ---
  // The debug registry survives game/runtime restarts. Resolve the live runtime
  // for every read/write instead of retaining the instance captured at mount.
  const sunglassesGroup = () => (
    globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__
      ?? runtime
  )?.characterSystem?.character?.sunglasses?.group ?? null;
  registerShaderDebugParam({
    id: 'runtime.sunglassesPosition',
    label: 'Position',
    folder: 'Sunglasses Socket',
    type: 'vec3',
    min: -30,
    max: 30,
    step: 0.1,
    pinPolicy: 'allow',
    help: 'Head-bone local position. X moves sideways, Y moves vertically, Z moves forward/back.',
    get: () => {
      const p = sunglassesGroup()?.position;
      return p ? [p.x, p.y, p.z] : [-0.4, 10.2, 6.2];
    },
    set: ([x, y, z]) => {
      sunglassesGroup()?.position.set(Number(x), Number(y), Number(z));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.sunglassesRotation',
    label: 'Rotation °',
    folder: 'Sunglasses Socket',
    type: 'vec3',
    min: -180,
    max: 180,
    step: 0.5,
    pinPolicy: 'allow',
    help: 'Head-bone local Euler rotation in degrees.',
    get: () => {
      const r = sunglassesGroup()?.rotation;
      return r
        ? [r.x, r.y, r.z].map((value) => value * 180 / Math.PI)
        : [10.5, 0, 0];
    },
    set: ([x, y, z]) => {
      sunglassesGroup()?.rotation.set(
        Number(x) * Math.PI / 180,
        Number(y) * Math.PI / 180,
        Number(z) * Math.PI / 180,
      );
    },
  });

  registerShaderDebugParam({
    id: 'runtime.sunglassesScale',
    label: 'Scale multiplier',
    folder: 'Sunglasses Socket',
    type: 'float',
    min: 0.5,
    max: 1.5,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Multiplier relative to the inherited-scale-cancelled 0.15 m frame width.',
    get: () => {
      const group = sunglassesGroup();
      const base = group?.userData.socketBaseScale;
      return group && Number.isFinite(base) && base > 0 ? group.scale.x / base : 1;
    },
    set: (value) => {
      const group = sunglassesGroup();
      const base = group?.userData.socketBaseScale;
      if (group && Number.isFinite(base) && base > 0) group.scale.setScalar(base * Number(value));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.resetSunglassesSocket',
    label: 'Reset sunglasses socket',
    folder: 'Sunglasses Socket',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const group = sunglassesGroup();
      if (!group) return;
      group.position.set(-0.4, 10.2, 6.2);
      group.rotation.set(10.5 * Math.PI / 180, 0, 0);
      const base = group.userData.socketBaseScale;
      if (Number.isFinite(base) && base > 0) group.scale.setScalar(base);
    },
  });

  registerShaderDebugParam({
    id: 'runtime.logSunglassesSocket',
    label: 'Log sunglasses values',
    folder: 'Sunglasses Socket',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const group = sunglassesGroup();
      if (!group) return;
      const base = group.userData.socketBaseScale;
      console.info('[sunglasses] socket', {
        position: group.position.toArray(),
        rotationDegrees: group.rotation.toArray().slice(0, 3).map((value) => value * 180 / Math.PI),
        scaleMultiplier: Number.isFinite(base) && base > 0 ? group.scale.x / base : 1,
      });
    },
  });

  // --- Guns (live hand + gun socket fitting) ---
  // Resolve live runtime each call so values survive play-session remounts.
  const fpWeapons = () => (
    globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__
      ?? runtime
  )?.firstPersonWeaponSystem ?? null;

  const relayoutGun = () => {
    bumpGunDebugSocket();
    fpWeapons()?.handIk?.layoutGunInHand?.({ force: true });
  };

  registerShaderDebugParam({
    id: 'runtime.gunSelect',
    label: 'Gun',
    folder: 'Guns',
    type: 'enum',
    options: listGunDebugOptions(),
    pinPolicy: 'allow',
    help: 'Catalog weapon to equip. Press Equip selected gun after changing.',
    get: () => {
      const live = fpWeapons()?.equippedGunId;
      return live || gunDebugSocket.selectedGunId;
    },
    set: (v) => {
      if (typeof v === 'string' && v) gunDebugSocket.selectedGunId = v;
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunEquip',
    label: 'Equip selected gun',
    folder: 'Guns',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Equip the selected catalog gun now (forces on-foot first person if needed).',
    action: () => {
      const id = gunDebugSocket.selectedGunId;
      const rt = globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__ ?? runtime;
      if (!rt?.firstPersonWeaponSystem) {
        console.warn('[gun-debug] no firstPersonWeaponSystem (start a play session first)');
        return;
      }
      // Ensure FP is on so the weapon is visible / stance active.
      rt.setOnFootFirstPersonEnabled?.(true);
      // Unified loadout: put the gun in the weapon list and draw it (Z holsters).
      if (typeof rt.equipWeapon === 'function') {
        void Promise.resolve(rt.equipWeapon(id, { draw: true })).then(() => {
          relayoutGun();
          console.info('[gun-debug] equipped', id);
        });
        return;
      }
      void rt.equipGun?.(id).then?.(() => {
        relayoutGun();
        console.info('[gun-debug] equipped', id);
      });
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunHandPosition',
    label: 'Gun body offset (m)',
    folder: 'Guns',
    type: 'vec3',
    min: -0.5,
    max: 0.5,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Base gun position in chest/body space (meters). +X = left, +Y = up, +Z = forward. Both hands IK to follow it.',
    get: () => [...gunDebugSocket.handPosition],
    set: ([x, y, z]) => {
      gunDebugSocket.handPosition = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      relayoutGun();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunHandRotation',
    label: 'Gun body rotation °',
    folder: 'Guns',
    type: 'vec3',
    min: -180,
    max: 180,
    step: 0.5,
    pinPolicy: 'allow',
    help: 'Base gun orientation in body space (Euler XYZ °). Muzzle is gun −Z; ~[0,180,0] points it forward.',
    get: () => [...gunDebugSocket.handRotationDeg],
    set: ([x, y, z]) => {
      gunDebugSocket.handRotationDeg = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      relayoutGun();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunPosition',
    label: 'Gun offset (m)',
    folder: 'Guns',
    type: 'vec3',
    min: -0.5,
    max: 0.5,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Extra gun-local offset on top of the body pose (meters). Moves the mesh relative to itself.',
    get: () => [...gunDebugSocket.gunPosition],
    set: ([x, y, z]) => {
      gunDebugSocket.gunPosition = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      relayoutGun();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunRotation',
    label: 'Gun rotation °',
    folder: 'Guns',
    type: 'vec3',
    min: -180,
    max: 180,
    step: 0.5,
    pinPolicy: 'allow',
    help: 'Extra gun-local Euler XYZ degrees after grip snap.',
    get: () => [...gunDebugSocket.gunRotationDeg],
    set: ([x, y, z]) => {
      gunDebugSocket.gunRotationDeg = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      relayoutGun();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunScale',
    label: 'Gun scale',
    folder: 'Guns',
    type: 'float',
    min: 0.25,
    max: 2.5,
    step: 0.01,
    pinPolicy: 'allow',
    help: 'Multiplier on top of inherited-scale cancel (1 = real-world meters).',
    get: () => gunDebugSocket.gunScale,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.gunScale = Number.isFinite(n) && n > 1e-4 ? n : 1;
      relayoutGun();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.leftIkEnabled',
    label: 'Left hand IK',
    folder: 'Guns',
    type: 'bool',
    pinPolicy: 'allow',
    help: 'Pull the left arm onto left_hand_ik_target (support / handguard).',
    get: () => gunDebugSocket.leftIkEnabled,
    set: (v) => {
      gunDebugSocket.leftIkEnabled = Boolean(v);
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.leftIkPosition',
    label: 'Left IK offset (m)',
    folder: 'Guns',
    type: 'vec3',
    min: -0.25,
    max: 0.25,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Offset of the left-hand target relative to left_hand_ik_target (gun-local meters). Position is mostly good — small tweaks only.',
    get: () => [...gunDebugSocket.leftIkPosition],
    set: ([x, y, z]) => {
      gunDebugSocket.leftIkPosition = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      bumpGunDebugSocket();
      fpWeapons()?.handIk?.layoutGunInHand?.({ force: true });
    },
  });

  registerShaderDebugParam({
    id: 'runtime.leftIkRotation',
    label: 'Left IK rotation °',
    folder: 'Guns',
    type: 'vec3',
    min: -180,
    max: 180,
    step: 0.5,
    pinPolicy: 'allow',
    help: 'Extra Euler XYZ degrees on the left-hand target orientation (palm/wrist). Primary control for left-hand twist.',
    get: () => [...gunDebugSocket.leftIkRotationDeg],
    set: ([x, y, z]) => {
      gunDebugSocket.leftIkRotationDeg = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      bumpGunDebugSocket();
      fpWeapons()?.handIk?.layoutGunInHand?.({ force: true });
    },
  });

  registerShaderDebugParam({
    id: 'runtime.leftIkHandBlend',
    label: 'Left hand rot blend',
    folder: 'Guns',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    pinPolicy: 'allow',
    help: '0 = keep animated wrist, any value >0 hard-locks palm to support + Left IK rotation (no soft slerp — walk clips cannot residual-twist the hand).',
    get: () => gunDebugSocket.leftIkHandBlend,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.leftIkHandBlend = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.leftIkElbowPole',
    label: 'Left elbow pole',
    folder: 'Guns',
    type: 'vec3',
    min: -2,
    max: 2,
    step: 0.05,
    pinPolicy: 'allow',
    help: 'Body-local direction the left elbow points (X left/right, Y up/down, Z forward/back). Default ≈ left + down + slightly forward. Primary control for elbow plane.',
    get: () => [...gunDebugSocket.leftIkElbowPole],
    set: ([x, y, z]) => {
      gunDebugSocket.leftIkElbowPole = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.leftIkElbowSwing',
    label: 'Left elbow swing °',
    folder: 'Guns',
    type: 'float',
    min: -180,
    max: 180,
    step: 1,
    pinPolicy: 'allow',
    help: 'Rotate the elbow around the shoulder→hand axis (degrees). Fast way to roll the elbow up/down/out without rewriting the pole vector.',
    get: () => gunDebugSocket.leftIkElbowSwingDeg,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.leftIkElbowSwingDeg = Number.isFinite(n) ? n : 0;
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.leftIkElbowBend',
    label: 'Left elbow bend °',
    folder: 'Guns',
    type: 'float',
    min: 0,
    max: 170,
    step: 1,
    pinPolicy: 'allow',
    help: 'Preferred interior elbow angle (0 = auto from grip distance). ~90 = right angle, ~140–160 = nearly straight. Only shortens reach when it increases bend; hand still aims at support.',
    get: () => gunDebugSocket.leftIkElbowBendDeg,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.leftIkElbowBendDeg = Number.isFinite(n)
        ? Math.max(0, Math.min(170, n))
        : 0;
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rightIkEnabled',
    label: 'Right hand IK',
    folder: 'Guns',
    type: 'bool',
    pinPolicy: 'allow',
    help: 'Pull the right (dominant) arm onto grip_mount so the trigger hand follows the gun.',
    get: () => gunDebugSocket.rightIkEnabled,
    set: (v) => {
      gunDebugSocket.rightIkEnabled = Boolean(v);
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rightIkPosition',
    label: 'Right IK offset (m)',
    folder: 'Guns',
    type: 'vec3',
    min: -0.25,
    max: 0.25,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Offset of the right-hand target relative to grip_mount (gun-local meters).',
    get: () => [...gunDebugSocket.rightIkPosition],
    set: ([x, y, z]) => {
      gunDebugSocket.rightIkPosition = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      bumpGunDebugSocket();
      fpWeapons()?.handIk?.layoutGunInHand?.({ force: true });
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rightIkRotation',
    label: 'Right IK rotation °',
    folder: 'Guns',
    type: 'vec3',
    min: -180,
    max: 180,
    step: 0.5,
    pinPolicy: 'allow',
    help: 'Extra Euler XYZ degrees on the right-hand target orientation (palm/wrist). Primary control for right-hand twist.',
    get: () => [...gunDebugSocket.rightIkRotationDeg],
    set: ([x, y, z]) => {
      gunDebugSocket.rightIkRotationDeg = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      bumpGunDebugSocket();
      fpWeapons()?.handIk?.layoutGunInHand?.({ force: true });
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rightIkHandBlend',
    label: 'Right hand rot blend',
    folder: 'Guns',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    pinPolicy: 'allow',
    help: '0 = keep animated wrist, any value >0 hard-locks palm to grip + Right IK rotation (no soft slerp).',
    get: () => gunDebugSocket.rightIkHandBlend,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.rightIkHandBlend = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rightIkElbowPole',
    label: 'Right elbow pole',
    folder: 'Guns',
    type: 'vec3',
    min: -2,
    max: 2,
    step: 0.05,
    pinPolicy: 'allow',
    help: 'Body-local direction the right elbow points (X left/right, Y up/down, Z forward/back). Default ≈ right + down + slightly forward.',
    get: () => [...gunDebugSocket.rightIkElbowPole],
    set: ([x, y, z]) => {
      gunDebugSocket.rightIkElbowPole = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rightIkElbowSwing',
    label: 'Right elbow swing °',
    folder: 'Guns',
    type: 'float',
    min: -180,
    max: 180,
    step: 1,
    pinPolicy: 'allow',
    help: 'Rotate the right elbow around the shoulder→hand axis (degrees).',
    get: () => gunDebugSocket.rightIkElbowSwingDeg,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.rightIkElbowSwingDeg = Number.isFinite(n) ? n : 0;
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rightIkElbowBend',
    label: 'Right elbow bend °',
    folder: 'Guns',
    type: 'float',
    min: 0,
    max: 170,
    step: 1,
    pinPolicy: 'allow',
    help: 'Preferred interior right-elbow angle (0 = auto from grip distance). ~90 = right angle, ~140–160 = nearly straight.',
    get: () => gunDebugSocket.rightIkElbowBendDeg,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.rightIkElbowBendDeg = Number.isFinite(n)
        ? Math.max(0, Math.min(170, n))
        : 0;
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.aimPitchGun',
    label: 'Aim pitch → gun',
    folder: 'Guns',
    type: 'float',
    min: -1.5,
    max: 1.5,
    step: 0.05,
    pinPolicy: 'allow',
    help: 'Multiplier on camera look-pitch tilting the gun holder (muzzle up/down). 1 = full follow, negative flips direction, 0 = level.',
    get: () => gunDebugSocket.aimPitchGun,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.aimPitchGun = Number.isFinite(n) ? n : 0;
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.aimPitchSpine',
    label: 'Aim pitch → spine',
    folder: 'Guns',
    type: 'float',
    min: -1.5,
    max: 1.5,
    step: 0.05,
    pinPolicy: 'allow',
    help: 'Multiplier on camera look-pitch bending the torso toward the aim. ~0.6 leans partway, negative flips direction, 0 = no bend.',
    get: () => gunDebugSocket.aimPitchSpine,
    set: (v) => {
      const n = Number(v);
      gunDebugSocket.aimPitchSpine = Number.isFinite(n) ? n : 0;
      bumpGunDebugSocket();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunSnapToAnchors',
    label: 'Snap to anchors (override)',
    folder: 'Guns',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Zero all gun-local + hand-IK fudge so grip/support sit on Gunsmith anchors (grip_mount / left_hand_ik_target). Keeps body hold, scale, elbow poles, aim pitch. Then tune palms and Log gun socket for defaults.',
    action: () => {
      const fp = fpWeapons();
      const ik = fp?.handIk;
      const view = fp?.gunView;
      const anchors = view?.anchors ?? {};
      const grip = anchors.grip_mount;
      const support = anchors.left_hand_ik_target;
      if (!view?.root) {
        console.warn('[gun-debug] snap-to-anchors: equip a gun first');
        return;
      }
      snapGunDebugSocketToAnchors();
      ik?.layoutGunInHand?.({ force: true });
      const snap = logGunDebugSocket();
      const report = {
        gunId: view.id ?? gunDebugSocket.selectedGunId,
        grip_mount: grip
          ? { position: grip.position.toArray(), name: grip.name }
          : null,
        left_hand_ik_target: support
          ? { position: support.position.toArray(), name: support.name }
          : null,
        socket: snap,
      };
      if (!grip || !support) {
        console.warn(
          '[gun-debug] snap-to-anchors: missing anchors (check Gunsmith profile)',
          report,
        );
      } else {
        console.info(
          '[gun-debug] snap-to-anchors: hands on authored anchors (offsets cleared)',
          report,
        );
      }
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunResetSocket',
    label: 'Reset gun socket',
    folder: 'Guns',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Reload catalog defaults for the selected gun (undoes live fit / snap-to-anchors).',
    action: () => {
      resetGunDebugSocket();
      fpWeapons()?.handIk?.layoutGunInHand?.({ force: true });
      console.info('[gun-debug] socket reset');
    },
  });

  registerShaderDebugParam({
    id: 'runtime.gunLogSocket',
    label: 'Log gun socket',
    folder: 'Guns',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Print current hand/gun/left-IK offsets to the console for pasting into source defaults.',
    action: () => {
      logGunDebugSocket();
    },
  });

  // --- Look preset ---
  const lookOptions = {
    'Quality default': '',
    ...Object.fromEntries(listPhotorealismPresets().map((p) => [p.label, p.id])),
  };
  registerShaderDebugParam({
    id: 'runtime.photorealismPreset',
    label: 'Look preset',
    folder: 'Look',
    type: 'enum',
    options: lookOptions,
    pinPolicy: 'allow',
    get: () => snap(runtime)?.photorealismPreset ?? '',
    set: (v) => {
      bridge()?.setPhotorealismPreset?.(v || null);
    },
  });

  // --- Weather ---
  registerShaderDebugParam({
    id: 'runtime.weather',
    label: 'Weather',
    folder: 'Weather Control',
    type: 'enum',
    options: {
      Clear: 'clear',
      Overcast: 'overcast',
      Fog: 'fog',
      Rain: 'rain',
    },
    pinPolicy: 'allow',
    get: () => snap(runtime)?.renderer?.weather ?? 'clear',
    set: (v) => {
      bridge()?.setWeather?.(v);
    },
  });

  // --- Cloud mode (reload) + type + TOD ---
  registerShaderDebugParam({
    id: 'runtime.cloudMode',
    label: 'Cloud mode (reload)',
    folder: 'Cloud Mode',
    type: 'enum',
    options: {
      Volumetric: 'volumetric',
      Dome: 'dome',
      Off: 'off',
    },
    pinPolicy: 'allow',
    help: 'Writes localStorage and reloads the page.',
    get: () => readCloudMode(),
    set: (v) => {
      setCloudModeAndReload(v);
    },
  });

  const cloudTypeOptions = Object.fromEntries(
    listCloudTypePresets().map((p) => [p.label, p.id]),
  );
  registerShaderDebugParam({
    id: 'runtime.cloudType',
    label: 'Cloud type',
    folder: 'Cloud Mode',
    type: 'enum',
    options: cloudTypeOptions,
    pinPolicy: 'allow',
    help: 'Volumetric only. Clears shape/lighting/wind pins then applies preset.',
    get: () => {
      const rt = runtime ?? globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__;
      return rt?.sceneSystem?.skySystem?.provider?.cloudType
        ?? snap(runtime)?.scene?.sky?.cloudType
        ?? DEFAULT_CLOUD_TYPE;
    },
    set: (v) => {
      bridge()?.setCloudPreset?.(v);
    },
  });

  registerShaderDebugParam({
    id: 'runtime.timeOfDay',
    label: 'Time of day',
    folder: 'Cloud Mode',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.001,
    pinPolicy: 'allow',
    help: '0–1 day cycle (disables dynamic day while scrubbing).',
    get: () => snap(runtime)?.scene?.sky?.timeOfDay ?? 0.72,
    set: (v) => {
      bridge()?.setTimeOfDay?.(Number(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.timeOfDayClock',
    label: 'Clock',
    folder: 'Cloud Mode',
    type: 'monitor',
    pinPolicy: 'monitor',
    get: () => formatTimeOfDay(snap(runtime)?.scene?.sky?.timeOfDay ?? 0.72),
  });

  // --- Rally ---
  registerShaderDebugParam({
    id: 'runtime.rallyCinematic',
    label: 'Toggle rally cinematic demo',
    folder: 'Rally',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      bridge()?.toggleRallyCinematicDemo?.();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rallyCinematicState',
    label: 'Rally cinematic',
    folder: 'Rally',
    type: 'monitor',
    pinPolicy: 'monitor',
    get: () => (snap(runtime)?.rallyCinematic?.active ? 'active' : 'idle'),
  });

  registerShaderDebugParam({
    id: 'runtime.spectatorCrowd',
    label: 'Spectator crowd GLB (reload)',
    folder: 'Rally',
    type: 'bool',
    pinPolicy: 'allow',
    help: 'Writes localStorage and reloads.',
    get: () => readSpectatorCrowd(),
    set: (v) => {
      setSpectatorCrowdAndReload(Boolean(v));
    },
  });

  // --- Overlays ---
  registerShaderDebugParam({
    id: 'runtime.collisionDebug',
    label: 'Collision overlays',
    folder: 'Overlays',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => overlayState.collision,
    set: (v) => {
      overlayState.collision = Boolean(v);
      bridge()?.setCollisionDebugVisible?.(overlayState.collision);
    },
  });

  registerShaderDebugParam({
    id: 'runtime.bladeDebug',
    label: 'Blade trace',
    folder: 'Overlays',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => overlayState.blade,
    set: (v) => {
      overlayState.blade = Boolean(v);
      bridge()?.setBladeDebug?.(overlayState.blade);
    },
  });

  registerShaderDebugParam({
    id: 'runtime.worldZones',
    label: 'World zone overlay',
    folder: 'Overlays',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => overlayState.worldZones,
    set: (v) => {
      overlayState.worldZones = Boolean(v);
      bridge()?.setWorldZoneOverlay?.(overlayState.worldZones);
    },
  });
}

function formatTimeOfDay(timeOfDay) {
  const wrapped = ((Number(timeOfDay) % 1) + 1) % 1;
  const totalMinutes = Math.round(wrapped * 24 * 60) % (24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function gameRuntime() {
  return globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__ ?? null;
}

/**
 * Register a float slider that reads/writes GAME_CONFIG.camera[key] live.
 * CameraSystem samples these every frame, so orbit / FP eye update immediately.
 *
 * @param {{
 *   id: string,
 *   key: string,
 *   label: string,
 *   folder: string,
 *   min: number,
 *   max: number,
 *   step?: number,
 *   help?: string,
 *   onSet?: (n: number) => void,
 * }} opts
 */
function registerCameraFloat({
  id,
  key,
  label,
  folder,
  min,
  max,
  step = 0.01,
  help,
  onSet = null,
}) {
  registerShaderDebugParam({
    id,
    label,
    folder,
    type: 'float',
    min,
    max,
    step,
    pinPolicy: 'allow',
    help,
    get: () => {
      const n = Number(GAME_CONFIG.camera?.[key]);
      return Number.isFinite(n) ? n : min;
    },
    set: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      GAME_CONFIG.camera[key] = n;
      onSet?.(n);
    },
  });
}

/** Push mesh Y immediately so the slider is visible without waiting a frame. */
function applyPlayerMeshOffsetNow() {
  const controller = gameRuntime()?.characterSystem?.character?.animationController;
  controller?.applyModelVisualOffset?.();
}

/** Reposition the kinematic capsule immediately when collider offset changes. */
function applyPlayerColliderOffsetNow() {
  const rt = gameRuntime();
  const character = rt?.characterSystem?.character;
  if (!character || !rt?.physicsSystem?.syncCharacterBody) {
    return;
  }
  rt.physicsSystem.syncCharacterBody(character);
}
