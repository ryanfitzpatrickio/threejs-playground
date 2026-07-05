const SPECTATOR_CROWD_STORAGE_KEY = 'dreamfall:spectator-crowd';

/** Animated rally spectator GLB flipbook — opt-in via Render Debug (P panel). */
export function isSpectatorCrowdEnabled() {
  try {
    return localStorage.getItem(SPECTATOR_CROWD_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setSpectatorCrowdEnabled(enabled) {
  try {
    localStorage.setItem(SPECTATOR_CROWD_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore write failures (sandboxed iframe, etc.).
  }
  return Boolean(enabled);
}
