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
import { resolveChassisSurfaceMode } from '../materials/createVehicleOverlayMaterials.js';
import { resolveEngineProfile } from './engineProfiles.js';

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
]);

export const GARAGE_FRAME_PRESETS = Object.freeze([
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
]);

export const GARAGE_TIRE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'default', name: 'Classic', description: 'Generated all-purpose tire and rim.', url: null }),
  Object.freeze({ id: 'center', name: 'Center', description: 'Authored directional performance tire.', url: '/assets/models/tire-center.glb' }),
  Object.freeze({ id: 'rally-wheel', name: 'Rally Wheel', description: 'Authored rally tire and wheel assembly.', url: '/assets/models/tire-rally-wheel.glb' }),
]);

export const GARAGE_ENGINE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'bac', name: 'BAC Mono', description: 'High-rev V8 layers from the original engine-audio pack.' }),
  Object.freeze({ id: 'boxer', name: 'Boxer', description: 'Flat-six on/off load with boxer one-shot accents.' }),
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
    presetId: preset.id,
    chassisId: defaults.chassisId ?? 'bare',
    chassisSurfaceMode: defaults.chassisSurfaceMode ?? 'metallic',
    hideBackSeats: false,
    hideEngine: false,
    frame: { ...preset.frame },
    wheels: { ...GARAGE_DEFAULT_WHEELS, tireId: defaults.tireId ?? GARAGE_DEFAULT_WHEELS.tireId },
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

export function getGarageChassisOption(id) {
  return GARAGE_CHASSIS_OPTIONS.find((option) => option.id === id) ?? GARAGE_CHASSIS_OPTIONS[0];
}

export function getGarageTireOption(id) {
  return GARAGE_TIRE_OPTIONS.find((option) => option.id === id) ?? GARAGE_TIRE_OPTIONS[0];
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
          useAuthoredTexture: clean.chassisSurfaceMode !== 'metallic',
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
        powerOversteer: 0.56,
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
    presetId: preset.id,
    chassisId: getGarageChassisOption(value.chassisId).id,
    hideBackSeats: value.hideBackSeats === true,
    hideEngine: value.hideEngine === true,
    disableGlassDetection: value.disableGlassDetection === true,
    chassisSurfaceMode: resolveChassisSurfaceMode(value),
    useAuthoredTexture: resolveChassisSurfaceMode(value) !== 'metallic',
    frame: {
      frameWidth: finite(frame.frameWidth, preset.frame.frameWidth, 1.6, 2.6),
      frameLength: finite(frame.frameLength, preset.frame.frameLength, 3.8, 6.4),
      frameHeight: finite(frame.frameHeight, preset.frame.frameHeight, 0.65, 1.25),
      wheelTrack: finite(frame.wheelTrack, preset.frame.wheelTrack, 1.5, 2.35),
      wheelbase: finite(frame.wheelbase, preset.frame.wheelbase, 2.3, 4.2),
      rideHeight: finite(frame.rideHeight, preset.frame.rideHeight, 0.65, 1.25),
      offsetFromTires: finite(frame.offsetFromTires, preset.frame.offsetFromTires, -0.65, 0.1),
    },
    wheels: {
      tireId: getGarageTireOption(wheels.tireId).id,
      radius: finite(wheels.radius, GARAGE_DEFAULT_WHEELS.radius, 0.25, 0.62),
      width: finite(wheels.width, GARAGE_DEFAULT_WHEELS.width, 0.18, 0.52),
      inset: finite(wheels.inset, GARAGE_DEFAULT_WHEELS.inset, 0, 0.35),
    },
    chassisTransform: {
      position: sanitizeVector(chassisTransform.position, GARAGE_DEFAULT_CHASSIS_TRANSFORM.position, -2, 2),
      rotationDegrees: sanitizeVector(chassisTransform.rotationDegrees, GARAGE_DEFAULT_CHASSIS_TRANSFORM.rotationDegrees, -360, 360),
      scale: sanitizeVector(chassisTransform.scale, GARAGE_DEFAULT_CHASSIS_TRANSFORM.scale, 0.5, 12),
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
