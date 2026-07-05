const COMFORT_STORAGE_KEY = 'dreamfall:camera-comfort';
const FEEL_STORAGE_KEY = 'dreamfall:camera-feel';

export const CAMERA_FEEL_ORDER = ['comfort', 'default', 'cinematic'];

function readUrlComfortOverride() {
  if (typeof window === 'undefined') {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get('comfort');
  if (value === '0' || value === 'false') {
    return false;
  }
  if (value === '1' || value === 'true') {
    return true;
  }
  return null;
}

/** Master comfort switch — default ON. `?comfort=0|1` overrides localStorage. */
export function getComfortEnabled() {
  const fromUrl = readUrlComfortOverride();
  if (fromUrl !== null) {
    return fromUrl;
  }
  try {
    const stored = localStorage.getItem(COMFORT_STORAGE_KEY);
    if (stored === '0' || stored === 'false') {
      return false;
    }
    if (stored === '1' || stored === 'true') {
      return true;
    }
  } catch {
    // localStorage unavailable (sandboxed iframe, private mode, etc.)
  }
  return true;
}

export function setComfortEnabled(enabled) {
  try {
    localStorage.setItem(COMFORT_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore persistence failures
  }
}

export function getCameraFeel() {
  try {
    const stored = localStorage.getItem(FEEL_STORAGE_KEY);
    if (CAMERA_FEEL_ORDER.includes(stored)) {
      return stored;
    }
  } catch {
    // ignore
  }
  return 'comfort';
}

export function setCameraFeel(feel) {
  const normalized = CAMERA_FEEL_ORDER.includes(feel) ? feel : 'comfort';
  try {
    localStorage.setItem(FEEL_STORAGE_KEY, normalized);
  } catch {
    // ignore
  }
  return normalized;
}

export function cycleCameraFeel(current = getCameraFeel()) {
  const index = CAMERA_FEEL_ORDER.indexOf(current);
  const next = CAMERA_FEEL_ORDER[(index + 1) % CAMERA_FEEL_ORDER.length];
  return setCameraFeel(next);
}

export function formatCameraFeel(feel) {
  switch (feel) {
    case 'default':
      return 'Default';
    case 'cinematic':
      return 'Cinematic';
    default:
      return 'Comfort';
  }
}

const ON_FOOT_FP_KEY = 'dreamfall:on-foot-first-person';

/** Optional on-foot first person outdoors (always on inside office interiors). */
export function getOnFootFirstPerson() {
  try {
    const stored = localStorage.getItem(ON_FOOT_FP_KEY);
    if (stored === '1' || stored === 'true') return true;
    if (stored === '0' || stored === 'false') return false;
  } catch {
    // ignore
  }
  return false;
}

export function setOnFootFirstPerson(enabled) {
  try {
    localStorage.setItem(ON_FOOT_FP_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}
