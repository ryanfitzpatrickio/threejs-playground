import {
  deleteEntry,
  readCollection,
  readState,
  writeEntry,
  writeState,
} from '../../store/fileStore.js';

export const GARAGE_BUILDS_KEY = 'dreamfall:garage-builds:v1';
export const GARAGE_ACTIVE_KEY = 'dreamfall:garage-active:v1';

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
]);

export const GARAGE_TIRE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'default', name: 'Classic', description: 'Generated all-purpose tire and rim.', url: null }),
  Object.freeze({ id: 'center', name: 'Center', description: 'Authored directional performance tire.', url: '/assets/models/tire-center.glb' }),
]);

export const GARAGE_DEFAULT_PERFORMANCE = Object.freeze({
  enginePower: 7.5,
  maxSteerYawRate: 0.75,
  highSpeedSteerYawRate: 0.42,
  suspensionStiffness: 24,
  suspensionDamping: 12,
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
  return sanitizeGarageBuild({
    id: createBuildId(),
    name: `${preset.name} Build`,
    presetId: preset.id,
    chassisId: 'bare',
    frame: { ...preset.frame },
    wheels: { ...GARAGE_DEFAULT_WHEELS },
    chassisTransform: cloneChassisTransform(GARAGE_DEFAULT_CHASSIS_TRANSFORM),
    performance: { ...GARAGE_DEFAULT_PERFORMANCE },
    updatedAt: Date.now(),
    ...overrides,
  });
}

export function getGarageFramePreset(id) {
  return GARAGE_FRAME_PRESETS.find((preset) => preset.id === id) ?? GARAGE_FRAME_PRESETS[1];
}

export function getGarageChassisOption(id) {
  return GARAGE_CHASSIS_OPTIONS.find((option) => option.id === id) ?? GARAGE_CHASSIS_OPTIONS[0];
}

export function getGarageTireOption(id) {
  return GARAGE_TIRE_OPTIONS.find((option) => option.id === id) ?? GARAGE_TIRE_OPTIONS[0];
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
    const next = { ...state };
    delete next.activeGarageBuildId;
    writeState(next);
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
  return {
    name: clean.name,
    chassisOverlay: getGarageChassisOption(clean.chassisId).url
      ? {
          url: getGarageChassisOption(clean.chassisId).url,
          ...cloneChassisTransform(clean.chassisTransform),
        }
      : false,
    frameParameters: clean.frame,
    wheelVisual: getGarageTireOption(clean.wheels.tireId).url
      ? { url: getGarageTireOption(clean.wheels.tireId).url }
      : null,
    config: {
      body: {
        size: [clean.frame.frameWidth, clean.frame.frameHeight, clean.frame.frameLength],
      },
      ground: {
        enginePower: clean.performance.enginePower,
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
      enginePower: finite(performance.enginePower, GARAGE_DEFAULT_PERFORMANCE.enginePower, 4, 14),
      maxSteerYawRate: finite(performance.maxSteerYawRate, GARAGE_DEFAULT_PERFORMANCE.maxSteerYawRate, 0.45, 1.1),
      highSpeedSteerYawRate: finite(performance.highSpeedSteerYawRate, GARAGE_DEFAULT_PERFORMANCE.highSpeedSteerYawRate, 0.25, 0.7),
      suspensionStiffness: finite(performance.suspensionStiffness, GARAGE_DEFAULT_PERFORMANCE.suspensionStiffness, 16, 36),
      suspensionDamping: finite(performance.suspensionDamping, GARAGE_DEFAULT_PERFORMANCE.suspensionDamping, 7, 16),
    },
    updatedAt: finite(value.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
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
