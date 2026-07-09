import {
  deleteEntry,
  readCollection,
  readState,
  writeEntry,
  writeState,
} from '../../store/fileStore.js';
import {
  DEFAULT_VEHICLE_CONFIG,
  applyLooseSurfaceTraction,
} from '../config/vehicleConfig.js';
import { chassisModeUsesAuthoredTexture, resolveChassisSurfaceMode, sanitizeChassisPartOverrides } from '../materials/createVehicleOverlayMaterials.js';
import { getChassisPartOverridesForBuild } from './chassisMeshParts.js';
import { resolveEngineProfile } from './engineProfiles.js';

let garageChassisOptionsOverride = null;

export function setGarageChassisOptionsOverride(options) {
  garageChassisOptionsOverride = options ? Object.freeze([...options]) : null;
}

export const GARAGE_VEHICLE_TYPES = Object.freeze([
  Object.freeze({ id: 'car', tab: 'cars', name: 'Car', description: 'Four-seat road and rally builds.' }),
  Object.freeze({ id: 'horse', tab: 'rideables', name: 'Horse', description: 'The existing living mount.' }),
  Object.freeze({ id: 'quad', tab: 'rideables', name: 'Quad bike', description: 'Single-rider AWD trail machine.' }),
]);

export const GARAGE_BUILDS_KEY = 'dreamfall:garage-builds:v1';
export const GARAGE_ACTIVE_KEY = 'dreamfall:garage-active:v1';

export const GARAGE_CHASSIS_SURFACE_MODES = Object.freeze([
  Object.freeze({
    id: 'metallic',
    name: 'Metallic paint',
    description: 'Procedural glossy car-paint shader.',
  }),
  Object.freeze({
    id: 'texture',
    name: 'Baked texture',
    description: 'Flat authored albedo without metallic response.',
  }),
  Object.freeze({
    id: 'mix',
    name: 'PBR mix',
    description: 'Authored maps with normal and roughness, plus rain response.',
  }),
  Object.freeze({
    id: 'camo',
    name: 'Obfuscation tape',
    description: 'Matte dazzle tape on body UVs — glass and lights stay clear.',
  }),
]);

export const GARAGE_FRAME_PRESETS = Object.freeze([
  Object.freeze({
    id: 'electric',
    name: 'Electric',
    description: 'Compact EV platform with instant torque and a low center of gravity.',
    frame: Object.freeze({
      frameWidth: 1.88, frameLength: 4.62, frameHeight: 0.78,
      wheelTrack: 1.68, wheelbase: 2.88, rideHeight: 0.78, offsetFromTires: -0.28,
    }),
    defaults: Object.freeze({
      chassisId: 'orange-car',
      chassisSurfaceMode: 'metallic',
      tireId: 'tesla-tire',
      engineProfile: 'electric',
      enginePower: 9.2,
      suspensionStiffness: 26,
      suspensionDamping: 13,
      traction: 0.62,
      hideEngine: true,
      wheelRadius: 0.42,
      wheelWidth: 0.28,
    }),
  }),
  Object.freeze({
    id: 'compact',
    name: 'Compact',
    description: 'Short wheelbase, narrow track, quick rotation.',
    frame: Object.freeze({
      frameWidth: 1.9, frameLength: 4.4, frameHeight: 0.82,
      wheelTrack: 1.72, wheelbase: 2.65, rideHeight: 0.82, offsetFromTires: -0.3,
    }),
  }),
  Object.freeze({
    id: 'rally',
    name: 'Rally',
    description: 'Raised AWD frame with soft long-travel suspension.',
    frame: Object.freeze({
      frameWidth: 1.92, frameLength: 4.48, frameHeight: 0.84,
      wheelTrack: 1.82, wheelbase: 2.62, rideHeight: 0.96, offsetFromTires: -0.24,
    }),
    defaults: Object.freeze({
      chassisId: 'subaru-rally',
      chassisSurfaceMode: 'mix',
      tireId: 'rally-wheel',
      engineProfile: 'boxer',
      enginePower: 8.6,
      suspensionStiffness: 20,
      suspensionDamping: 9,
      traction: 0.68,
    }),
  }),
  Object.freeze({
    id: 'street',
    name: 'Street',
    description: 'Balanced road frame with neutral proportions.',
    frame: Object.freeze({
      frameWidth: 2.08, frameLength: 5.1, frameHeight: 0.92,
      wheelTrack: 1.92, wheelbase: 3.1, rideHeight: 0.92, offsetFromTires: -0.36,
    }),
  }),
  Object.freeze({
    id: 'longtail',
    name: 'Longtail',
    description: 'Long, planted frame for high-speed builds.',
    frame: Object.freeze({
      frameWidth: 2.22, frameLength: 5.9, frameHeight: 0.98,
      wheelTrack: 2.04, wheelbase: 3.72, rideHeight: 0.96, offsetFromTires: -0.4,
    }),
  }),
]);

export const GARAGE_CHASSIS_OPTIONS = Object.freeze([
  Object.freeze({ id: 'bare', name: 'Bare Frame', description: 'Exposed frame, engine, seats, and running gear.', url: null }),
  Object.freeze({ id: 'muscle-1', name: 'Muscle Mk I', description: 'Original full muscle-car body shell.', url: '/assets/models/muscle-chasis.glb' }),
  Object.freeze({ id: 'muscle-2', name: 'Muscle Mk II', description: 'Refined lightweight muscle-car shell.', url: '/assets/models/muscle-chasis-2.glb' }),
  Object.freeze({
    id: 'subaru-rally',
    name: 'Subaru Rally',
    description: 'Compact multi-part rally-car body shell.',
    url: '/assets/models/subaru-rally-chassis.glb',
    defaultTransform: Object.freeze({
      position: Object.freeze([0, -0.1, 0.05]),
      rotationDegrees: Object.freeze([0, 180, 0]),
      scale: Object.freeze([5.1, 3.8, 5.1]),
    }),
  }),
  Object.freeze({
    id: 'orange-car',
    name: 'Orange EV',
    description: 'Meshy Orange Thunder roadster — segmented shell with per-part materials.',
    url: '/assets/models/orange-car.glb',
    defaultTransform: Object.freeze({
      position: Object.freeze([0, -0.08, 0.02]),
      rotationDegrees: Object.freeze([0, 180, 0]),
      scale: Object.freeze([40, 45, 40]),
    }),
  }),
]);

export const GARAGE_TIRE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'default', name: 'Classic', description: 'Generated all-purpose tire and rim.', vehicleTypes: ['car', 'quad'], url: null }),
  Object.freeze({ id: 'center', name: 'Center', description: 'Authored directional performance tire.', vehicleTypes: ['car', 'quad'], url: '/assets/models/tire-center.glb' }),
  Object.freeze({ id: 'rally-wheel', name: 'Rally Wheel', description: 'Authored rally tire and wheel assembly.', vehicleTypes: ['car', 'quad'], url: '/assets/models/tire-rally-wheel.glb' }),
  Object.freeze({ id: 'tesla-tire', name: 'Tesla Wheel', description: 'Authored EV wheel and tire assembly.', vehicleTypes: ['car', 'quad'], url: '/assets/models/tesla-tire.glb' }),
  Object.freeze({ id: 'quad-tire', name: 'Knobby ATV', description: 'Aggressive knobby off-road tire and rim.', vehicleTypes: ['quad'], url: '/assets/models/quad-tire.glb' }),
  Object.freeze({ id: 'quad-model', name: 'Model tires', description: 'Built-in tires from the quad-bike mesh (can wobble).', vehicleTypes: ['quad'], url: null }),
]);

export const GARAGE_ENGINE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'bac', name: 'BAC Mono', description: 'High-rev V8 layers from markeasting/engine-audio (https://github.com/markeasting/engine-audio).' }),
  Object.freeze({ id: 'boxer', name: 'Boxer', description: 'Flat-six on/off load with boxer one-shot accents.' }),
  Object.freeze({ id: 'quad', name: 'Quad Bike', description: 'ATV engine with dedicated idle loop + layered on/off load samples.' }),
  Object.freeze({ id: 'electric', name: 'Electric', description: 'Layered EV motor, inverter, road hiss, regen, and throttle punch samples.' }),
]);

export const GARAGE_DEFAULT_PERFORMANCE = Object.freeze({
  enginePower: 7.5,
  maxSteerYawRate: 0.75,
  highSpeedSteerYawRate: 0.42,
  suspensionStiffness: 24,
  suspensionDamping: 12,
  traction: 0.55,
});

export const GARAGE_DEFAULT_WHEELS = Object.freeze({
  tireId: 'default',
  radius: 0.38,
  width: 0.3,
  inset: 0.12,
});

export const GARAGE_QUAD_DEFAULT_WHEELS = Object.freeze({
  tireId: 'quad-tire',
  radius: 0.35,
  width: 0.27,
  inset: 0,
});

export const GARAGE_QUAD_DEFAULT_FRAME = Object.freeze({
  frameWidth: 1.34,
  frameLength: 1.58,
  frameHeight: 0.62,
  wheelTrack: 1.34,
  wheelbase: 1.36,
  rideHeight: 0.69,
  offsetFromTires: 0,
  wheelAxleOffset: 0,
});

export const GARAGE_DEFAULT_CHASSIS_TRANSFORM = Object.freeze({
  position: Object.freeze([0, -0.1, 0.05]),
  rotationDegrees: Object.freeze([0, 180, 0]),
  scale: Object.freeze([6.3, 6.3, 6.3]),
});

export function createGarageBuild(presetId = 'street', overrides = {}) {
  const preset = getGarageFramePreset(presetId);
  const defaults = preset.defaults ?? {};
  const defaultChassisTransform = getGarageChassisOption(defaults.chassisId)?.defaultTransform
    ?? GARAGE_DEFAULT_CHASSIS_TRANSFORM;
  return sanitizeGarageBuild({
    id: createBuildId(),
    name: `${preset.name} Build`,
    vehicleType: 'car',
    paintId: 'forest',
    presetId: preset.id,
    chassisId: defaults.chassisId ?? 'bare',
    chassisSurfaceMode: defaults.chassisSurfaceMode ?? 'metallic',
    hideBackSeats: false,
    hideEngine: defaults.hideEngine === true,
    frame: { ...preset.frame },
    wheels: {
      ...GARAGE_DEFAULT_WHEELS,
      tireId: defaults.tireId ?? GARAGE_DEFAULT_WHEELS.tireId,
      radius: defaults.wheelRadius ?? GARAGE_DEFAULT_WHEELS.radius,
      width: defaults.wheelWidth ?? GARAGE_DEFAULT_WHEELS.width,
    },
    chassisTransform: cloneChassisTransform(defaultChassisTransform),
    performance: {
      ...GARAGE_DEFAULT_PERFORMANCE,
      engineProfile: defaults.engineProfile,
      enginePower: defaults.enginePower ?? GARAGE_DEFAULT_PERFORMANCE.enginePower,
      suspensionStiffness: defaults.suspensionStiffness ?? GARAGE_DEFAULT_PERFORMANCE.suspensionStiffness,
      suspensionDamping: defaults.suspensionDamping ?? GARAGE_DEFAULT_PERFORMANCE.suspensionDamping,
      traction: defaults.traction ?? GARAGE_DEFAULT_PERFORMANCE.traction,
    },
    updatedAt: Date.now(),
    ...overrides,
  });
}

export function getGarageFramePreset(id) {
  return GARAGE_FRAME_PRESETS.find((preset) => preset.id === id)
    ?? GARAGE_FRAME_PRESETS.find((preset) => preset.id === 'street')
    ?? GARAGE_FRAME_PRESETS[0];
}

export function isKnownGarageChassisId(id) {
  const clean = String(id || '').trim();
  if (!clean) return false;
  const options = garageChassisOptionsOverride ?? GARAGE_CHASSIS_OPTIONS;
  return options.some((option) => option.id === clean);
}

export function createFallbackGarageChassisOption(id) {
  const clean = String(id || '').trim();
  if (!clean || clean === 'bare') return null;
  if (!/^[a-z0-9_-]+$/.test(clean)) return null;
  return Object.freeze({
    id: clean,
    name: clean,
    description: 'Authored chassis.',
    url: `/assets/models/${clean}.glb`,
    defaultTransform: null,
    source: 'bodyshop',
  });
}

export function getGarageChassisOption(id) {
  const options = garageChassisOptionsOverride ?? GARAGE_CHASSIS_OPTIONS;
  const found = options.find((option) => option.id === id);
  if (found) return found;
  return createFallbackGarageChassisOption(id) ?? GARAGE_CHASSIS_OPTIONS[0];
}

function resolveGarageChassisId(id) {
  const raw = String(id || '').trim();
  if (!raw) return 'bare';
  if (isKnownGarageChassisId(raw)) return raw;
  if (createFallbackGarageChassisOption(raw)) return raw;
  return getGarageChassisOption(raw).id;
}

export function getGarageTireOption(id) {
  return GARAGE_TIRE_OPTIONS.find((option) => option.id === id) ?? GARAGE_TIRE_OPTIONS[0];
}

export function getGarageTireOptionsForVehicleType(vehicleType = 'car') {
  return GARAGE_TIRE_OPTIONS.filter((option) => (
    !option.vehicleTypes || option.vehicleTypes.includes(vehicleType)
  ));
}

export function getGarageEngineOption(id) {
  return GARAGE_ENGINE_OPTIONS.find((option) => option.id === id) ?? GARAGE_ENGINE_OPTIONS[0];
}

export function loadGarageBuilds() {
  try {
    const all = readCollection('garage');
    return Object.values(all)
      .map(sanitizeGarageBuild)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

export function saveGarageBuild(build) {
  const saved = sanitizeGarageBuild({ ...build, updatedAt: Date.now() });
  writeEntry('garage', saved.id, saved, { debounce: false });
  writeState({ ...readState(), activeGarageBuildId: saved.id });
  return saved;
}

export function deleteGarageBuild(id) {
  deleteEntry('garage', id);
  const state = readState();
  if (state.activeGarageBuildId === id) {
    writeState({ activeGarageBuildId: undefined });
  }
  return loadGarageBuilds();
}

export function setActiveGarageBuild(id) {
  writeState({ ...readState(), activeGarageBuildId: id });
}

export function getActiveGarageBuild() {
  const builds = loadGarageBuilds();
  const activeId = readState().activeGarageBuildId;
  return builds.find((entry) => entry.id === activeId) ?? builds[0] ?? null;
}

export function vehicleOptionsFromGarageBuild(build) {
  if (!build) return {};
  const clean = sanitizeGarageBuild(build);
  if (clean.vehicleType === 'quad') {
    const tire = getGarageTireOption(clean.wheels.tireId);
    const useEmbeddedModelTires = tire.id === 'quad-model';
    return {
      vehicleKind: 'quad',
      name: clean.name,
      paintId: clean.paintId,
      wheelVisual: !useEmbeddedModelTires && tire.url ? { url: tire.url } : null,
      useEmbeddedModelTires,
      partOverrides: getChassisPartOverridesForBuild(clean, 'quad-bike'),
      frameParameters: {
        ...GARAGE_QUAD_DEFAULT_FRAME,
        rideHeight: clean.frame.rideHeight,
        offsetFromTires: clean.frame.offsetFromTires,
      },
      config: {
        ground: {
          enginePower: clean.performance.enginePower,
          traction: clean.performance.traction,
          wheelRadius: clean.wheels.radius,
          wheelWidth: clean.wheels.width,
          rayCast: {
            wheelRadius: clean.wheels.radius,
            suspensionStiffness: clean.performance.suspensionStiffness,
            suspensionCompression: clean.performance.suspensionDamping,
            suspensionRelaxation: clean.performance.suspensionDamping,
            maxSteerYawRate: clean.performance.maxSteerYawRate,
            highSpeedSteerYawRate: clean.performance.highSpeedSteerYawRate,
          },
        },
      },
    };
  }
  if (clean.vehicleType === 'horse') return { vehicleKind: 'horse', name: clean.name };
  const chassis = getGarageChassisOption(clean.chassisId);
  return {
    name: clean.name,
    hideEngine: clean.hideEngine === true,
    chassisOverlay: chassis.url
      ? {
          url: chassis.url,
          profileId: chassis.id,
          disableGlassDetection: clean.disableGlassDetection === true,
          chassisSurfaceMode: clean.chassisSurfaceMode,
          useAuthoredTexture: chassisModeUsesAuthoredTexture(clean.chassisSurfaceMode),
          partOverrides: getChassisPartOverridesForBuild(clean),
          ...cloneChassisTransform(clean.chassisTransform),
        }
      : false,
    frameParameters: clean.frame,
    wheelVisual: getGarageTireOption(clean.wheels.tireId).url
      ? { url: getGarageTireOption(clean.wheels.tireId).url }
      : null,
    config: {
      engineProfile: clean.performance.engineProfile,
      ...(clean.hideBackSeats ? { seats: createTwoSeatLayout() } : {}),
      body: {
        size: [clean.frame.frameWidth, clean.frame.frameHeight, clean.frame.frameLength],
      },
      ground: {
        enginePower: clean.performance.enginePower,
        traction: clean.performance.traction,
        wheelRadius: clean.wheels.radius,
        wheelWidth: clean.wheels.width,
        wheelInset: clean.wheels.inset,
        rayCast: {
          wheelRadius: clean.wheels.radius,
          maxSteerYawRate: clean.performance.maxSteerYawRate,
          highSpeedSteerYawRate: clean.performance.highSpeedSteerYawRate,
          suspensionStiffness: clean.performance.suspensionStiffness,
          suspensionCompression: clean.performance.suspensionDamping,
          suspensionRelaxation: clean.performance.suspensionDamping,
        },
      },
    },
  };
}

export function rallyVehicleOptions() {
  const options = vehicleOptionsFromGarageBuild(createGarageBuild('rally', {
    id: 'builtin-rally',
    name: 'Pine Ridge Rally Car',
  }));
  return applyRallyGroundTuning(options);
}

/** Rally stage handling layered onto a garage build (AWD, long travel, etc.). */
export function applyRallyGroundTuning(options) {
  return {
    ...options,
    config: {
      ...options.config,
      ground: {
        ...options.config?.ground,
        driveLayout: 'awd',
        maxSpeed: 61,
        // powerOversteer is inert under controller-slip (tyre/load/diff own OS).
        rollingResistance: 0.56,
        rayCast: {
          ...options.config?.ground?.rayCast,
          suspensionRestLength: 0.5,
          maxSuspensionTravel: 0.52,
          suspensionStiffness: options.config?.ground?.rayCast?.suspensionStiffness ?? 20,
          suspensionCompression: options.config?.ground?.rayCast?.suspensionCompression ?? 9,
          suspensionRelaxation: options.config?.ground?.rayCast?.suspensionRelaxation ?? 9,
        },
        // Rally stage: denser/longer rooster tail — still one InstancedMesh draw.
        dust: {
          poolSize: 2400,
          textureSize: 128,
          emitAllWheelsAbove: 0.32,
          emitRate: {
            base: 16,
            perSpeed: 1.2,
            speedCap: 42,
            perIntensity: 42,
            driftBoost: 26,
            driftThreshold: 2.2,
            maxPerFrame: 20,
            burstAtIntensity: 0.48,
            burstParticles: 3,
          },
          life: { min: 1.15, max: 3.1 },
          size: { baseMin: 0.65, baseMax: 1.55, ageGrow: 2.35 },
          buoyancy: 1.1,
          gravity: 0.48,
          drag: 0.58,
          turbulence: 0.28,
          color: {
            fresh: [0.38, 0.26, 0.15],
            mid: [0.70, 0.56, 0.38],
            old: [0.88, 0.82, 0.74],
          },
          drift: {
            fanScale: 0.22,
            coneWiden: 1.65,
            smoothstart: 1.6,
            smoothend: 9,
          },
          spin: {
            roostScale: 0.055,
            upBias: 0.75,
          },
          opacity: { peak: 1.0, fadePow: 1.25 },
        },
      },
    },
  };
}

/**
 * Spawn options for the playable car: the active saved garage build when one is
 * set, otherwise rally falls back to the built-in stage car.
 */
export function spawnVehicleOptions(levelMode = 'city') {
  const build = getActiveGarageBuild();
  if (build) {
    const options = vehicleOptionsFromGarageBuild(build);
    return levelMode === 'rally' ? applyRallyGroundTuning(options) : options;
  }
  if (levelMode === 'rally') return rallyVehicleOptions();
  return {};
}

export function sanitizeGarageBuild(value = {}) {
  const preset = getGarageFramePreset(value.presetId);
  const frame = value.frame ?? {};
  const performance = value.performance ?? {};
  const wheels = value.wheels ?? {};
  const chassisTransform = value.chassisTransform ?? {};
  return {
    id: String(value.id || createBuildId()).slice(0, 80),
    name: String(value.name || `${preset.name} Build`).trim().slice(0, 48) || 'Untitled Build',
    vehicleType: GARAGE_VEHICLE_TYPES.some((entry) => entry.id === value.vehicleType)
      ? value.vehicleType
      : 'car',
    paintId: ['forest', 'rally-red', 'sand', 'black'].includes(value.paintId)
      ? value.paintId
      : 'forest',
    presetId: preset.id,
    chassisId: resolveGarageChassisId(value.chassisId),
    hideBackSeats: value.hideBackSeats === true,
    hideEngine: value.hideEngine === true,
    disableGlassDetection: value.disableGlassDetection === true,
    chassisPartOverrides: sanitizeChassisPartOverrides(value.chassisPartOverrides),
    chassisSurfaceMode: resolveChassisSurfaceMode(value),
    useAuthoredTexture: chassisModeUsesAuthoredTexture(resolveChassisSurfaceMode(value)),
    frame: (() => {
      const isQuad = value.vehicleType === 'quad';
      const frameDefaults = isQuad ? GARAGE_QUAD_DEFAULT_FRAME : preset.frame;
      return {
        frameWidth: finite(frame.frameWidth, frameDefaults.frameWidth, 1.6, 2.6),
        frameLength: finite(frame.frameLength, frameDefaults.frameLength, 3.8, 6.4),
        frameHeight: finite(frame.frameHeight, frameDefaults.frameHeight, 0.65, 1.25),
        wheelTrack: finite(frame.wheelTrack, frameDefaults.wheelTrack, 1.5, 2.35),
        wheelbase: finite(frame.wheelbase, frameDefaults.wheelbase, 2.3, 4.2),
        rideHeight: finite(
          frame.rideHeight,
          frameDefaults.rideHeight,
          isQuad ? 0.45 : 0.65,
          isQuad ? 1.05 : 1.25,
        ),
        offsetFromTires: finite(
          frame.offsetFromTires,
          frameDefaults.offsetFromTires,
          -0.65,
          isQuad ? 0.35 : 0.1,
        ),
        wheelAxleOffset: finite(frame.wheelAxleOffset, frameDefaults.wheelAxleOffset ?? 0, -0.55, 0.55),
      };
    })(),
    wheels: (() => {
      const wheelDefaults = value.vehicleType === 'quad'
        ? GARAGE_QUAD_DEFAULT_WHEELS
        : GARAGE_DEFAULT_WHEELS;
      const tireOptions = getGarageTireOptionsForVehicleType(
        value.vehicleType === 'quad' ? 'quad' : 'car',
      );
      const tireId = tireOptions.some((option) => option.id === wheels.tireId)
        ? wheels.tireId
        : wheelDefaults.tireId;
      return {
        tireId: getGarageTireOption(tireId).id,
        radius: finite(wheels.radius, wheelDefaults.radius, 0.25, 0.62),
        width: finite(wheels.width, wheelDefaults.width, 0.18, 0.52),
        inset: finite(wheels.inset, wheelDefaults.inset, 0, 0.35),
      };
    })(),
    chassisTransform: {
      position: sanitizeVector(chassisTransform.position, GARAGE_DEFAULT_CHASSIS_TRANSFORM.position, -2, 2),
      rotationDegrees: sanitizeVector(chassisTransform.rotationDegrees, GARAGE_DEFAULT_CHASSIS_TRANSFORM.rotationDegrees, -360, 360),
      scale: sanitizeVector(chassisTransform.scale, GARAGE_DEFAULT_CHASSIS_TRANSFORM.scale, 0.5, 50),
    },
    performance: {
      engineProfile: resolveEngineProfile(performance.engineProfile),
      enginePower: finite(performance.enginePower, GARAGE_DEFAULT_PERFORMANCE.enginePower, 4, 14),
      maxSteerYawRate: finite(performance.maxSteerYawRate, GARAGE_DEFAULT_PERFORMANCE.maxSteerYawRate, 0.45, 1.1),
      highSpeedSteerYawRate: finite(performance.highSpeedSteerYawRate, GARAGE_DEFAULT_PERFORMANCE.highSpeedSteerYawRate, 0.25, 0.7),
      suspensionStiffness: finite(performance.suspensionStiffness, GARAGE_DEFAULT_PERFORMANCE.suspensionStiffness, 16, 36),
      suspensionDamping: finite(performance.suspensionDamping, GARAGE_DEFAULT_PERFORMANCE.suspensionDamping, 7, 16),
      traction: finite(performance.traction, GARAGE_DEFAULT_PERFORMANCE.traction, 0.4, 1),
    },
    updatedAt: finite(value.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
}

function createTwoSeatLayout() {
  return DEFAULT_VEHICLE_CONFIG.seats.slice(0, 2).map((seat) => ({
    ...seat,
    offset: [...seat.offset],
    ...(seat.handGrip
      ? { handGrip: { ...seat.handGrip, offset: [...seat.handGrip.offset] } }
      : {}),
  }));
}

function finite(value, fallback, min, max) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback));
}

function sanitizeVector(value, fallback, min, max) {
  return [0, 1, 2].map((index) => finite(
    Array.isArray(value) ? value[index] : value?.[['x', 'y', 'z'][index]],
    fallback[index],
    min,
    max,
  ));
}

function cloneChassisTransform(value) {
  return {
    position: [...value.position],
    rotationDegrees: [...value.rotationDegrees],
    scale: [...value.scale],
  };
}

function createBuildId() {
  return `build-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
