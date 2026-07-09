/**
 * Debug look presets for noon / clear weather. Merged over the active quality
 * tier's `environment` block (see GameRuntime._applyPhotorealismRuntime).
 */

const STORAGE_KEY = 'dreamfall:photorealism-preset';

export const PHOTOREALISM_PRESET_IDS = Object.freeze([
  'physical-noon',
  'broadcast-aces',
  'crisp-desert-rally',
]);

/** @type {Record<string, { label: string, environment: object }>} */
export const PHOTOREALISM_PRESETS = Object.freeze({
  'physical-noon': {
    label: 'Physical Noon',
    environment: {
      toneMapping: 'AgX',
      exposure: 1.3,
      timeOfDay: 0.5,
      weather: 'clear',
      sunIntensity: 5.5,
      sunColor: 0xfff6e8,
      hemisphereIntensity: 0.3,
      hemisphereGroundColor: 0x776653,
      environmentIntensity: 0.55,
      environmentMapSize: 256,
      aerialPerspective: true,
      aerialStart: 600,
      aerialEnd: 3000,
      aerialMaxOpacity: 0.2,
      aerialHazeColor: [0.58, 0.60, 0.63],
      bloom: true,
      bloomStrength: 0.03,
      bloomThreshold: 2.6,
      saturation: 1.0,
      vibrance: 0.0,
    },
  },
  'broadcast-aces': {
    label: 'Broadcast ACES',
    environment: {
      toneMapping: 'ACESFilmic',
      exposure: 0.95,
      timeOfDay: 0.5,
      weather: 'clear',
      sunIntensity: 5.0,
      sunColor: 0xffedd0,
      hemisphereIntensity: 0.4,
      hemisphereGroundColor: 0x7d6a54,
      environmentIntensity: 0.5,
      environmentMapSize: 256,
      aerialPerspective: true,
      aerialStart: 500,
      aerialEnd: 2200,
      aerialMaxOpacity: 0.26,
      aerialHazeColor: [0.60, 0.61, 0.63],
      bloom: true,
      bloomStrength: 0.07,
      bloomRadius: 0.18,
      bloomThreshold: 1.6,
      saturation: 1.08,
      vibrance: 0.07,
    },
  },
  'crisp-desert-rally': {
    label: 'Crisp Desert Rally',
    environment: {
      toneMapping: 'ACESFilmic',
      exposure: 1.05,
      timeOfDay: 0.5,
      weather: 'clear',
      sunIntensity: 6.5,
      sunColor: 0xffe8c2,
      hemisphereIntensity: 0.22,
      hemisphereGroundColor: 0x8a6f50,
      environmentIntensity: 0.35,
      aerialPerspective: true,
      aerialStart: 900,
      aerialEnd: 4000,
      aerialMaxOpacity: 0.14,
      aerialHazeColor: [0.72, 0.65, 0.54],
      bloom: false,
      saturation: 1.12,
      vibrance: 0.1,
    },
  },
});

export function listPhotorealismPresets() {
  return PHOTOREALISM_PRESET_IDS.map((id) => ({
    id,
    label: PHOTOREALISM_PRESETS[id].label,
  }));
}

/** @returns {string | null} */
export function getPhotorealismPresetId() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return PHOTOREALISM_PRESET_IDS.includes(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** @param {string | null | undefined} presetId */
export function setPhotorealismPresetId(presetId) {
  try {
    if (presetId && PHOTOREALISM_PRESET_IDS.includes(presetId)) {
      localStorage.setItem(STORAGE_KEY, presetId);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore write failures.
  }
  return presetId && PHOTOREALISM_PRESET_IDS.includes(presetId) ? presetId : null;
}

/** @param {object} baseEnvironment */
export function mergePhotorealismEnvironment(baseEnvironment, presetId) {
  const preset = PHOTOREALISM_PRESETS[presetId];
  if (!preset) return { ...baseEnvironment };
  return { ...baseEnvironment, ...preset.environment };
}

export function normalizeAerialHazeColor(value, fallback = [0.58, 0.60, 0.62]) {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return [
    Number(value[0]) || fallback[0],
    Number(value[1]) || fallback[1],
    Number(value[2]) || fallback[2],
  ];
}
