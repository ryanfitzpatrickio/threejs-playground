/**
 * Live reload-path debug tweaks (hand IK along the magazine-change track).
 * Consumed by FirstPersonWeaponSystem + reloadIkDirector every frame while
 * reloading (or scrub-previewing). Register controls under the "Reload" folder.
 *
 * Defaults fit live 2026-07-11 (AR reload hand path).
 */

function cloneVec3(src, fallback = [0, 0, 0]) {
  return [
    Number(src?.[0]) || fallback[0] || 0,
    Number(src?.[1]) || fallback[1] || 0,
    Number(src?.[2]) || fallback[2] || 0,
  ];
}

/** Authored defaults — reset + cold boot share this table. */
export const RELOAD_DEBUG_DEFAULTS = Object.freeze({
  enabled: true,
  scrubEnabled: false,
  scrubT: 0.26,
  pinProgress: true,
  // Body-local meters after the path sample (+X left, +Y up, +Z forward).
  // Converted to world using character body yaw so turn direction does not flip the fudge.
  handPosition: Object.freeze([0.015, -0.075, -0.03]),
  // Extra Euler XYZ ° on the left palm while on the reload path (support-local).
  handRotationDeg: Object.freeze([-86, 78.5, 0]),
  // Body-local waypoint offsets (same axes as handPosition).
  restOffset: Object.freeze([0, 0, 0]),
  socketOffset: Object.freeze([0.015, -0.055, -0.045]),
  extractOffset: Object.freeze([-0.015, -0.025, -0.025]),
  beltOffset: Object.freeze([0, 0, 0]),
  // Extra downward pull (m) on the extract waypoint — always world −Y.
  extractDrop: 0.035,
  // Fresh magazine pose while riding the left hand (belt → seat), live-fit.
  magCarryPosition: Object.freeze([-0.085, 0.01, 0.06]),
  magCarryRotationDeg: Object.freeze([0, 0, 0]),
});

/**
 * @typedef {{
 *  enabled: boolean,
 *  scrubEnabled: boolean,
 *  scrubT: number,
 *  pinProgress: boolean,
 *  handPosition: [number, number, number],
 *  handRotationDeg: [number, number, number],
 *  restOffset: [number, number, number],
 *  socketOffset: [number, number, number],
 *  extractOffset: [number, number, number],
 *  beltOffset: [number, number, number],
 *  extractDrop: number,
 *  magCarryPosition: [number, number, number],
 *  magCarryRotationDeg: [number, number, number],
 *  revision: number,
 * }} ReloadDebugSocket
 */

/** @type {ReloadDebugSocket} */
export const reloadDebugSocket = {
  enabled: RELOAD_DEBUG_DEFAULTS.enabled,
  scrubEnabled: RELOAD_DEBUG_DEFAULTS.scrubEnabled,
  scrubT: RELOAD_DEBUG_DEFAULTS.scrubT,
  pinProgress: RELOAD_DEBUG_DEFAULTS.pinProgress,
  handPosition: cloneVec3(RELOAD_DEBUG_DEFAULTS.handPosition),
  handRotationDeg: cloneVec3(RELOAD_DEBUG_DEFAULTS.handRotationDeg),
  restOffset: cloneVec3(RELOAD_DEBUG_DEFAULTS.restOffset),
  socketOffset: cloneVec3(RELOAD_DEBUG_DEFAULTS.socketOffset),
  extractOffset: cloneVec3(RELOAD_DEBUG_DEFAULTS.extractOffset),
  beltOffset: cloneVec3(RELOAD_DEBUG_DEFAULTS.beltOffset),
  extractDrop: RELOAD_DEBUG_DEFAULTS.extractDrop,
  magCarryPosition: cloneVec3(RELOAD_DEBUG_DEFAULTS.magCarryPosition),
  magCarryRotationDeg: cloneVec3(RELOAD_DEBUG_DEFAULTS.magCarryRotationDeg),
  revision: 0,
};

export function bumpReloadDebugSocket() {
  reloadDebugSocket.revision += 1;
  return reloadDebugSocket.revision;
}

export function resetReloadDebugSocket() {
  reloadDebugSocket.enabled = RELOAD_DEBUG_DEFAULTS.enabled;
  reloadDebugSocket.scrubEnabled = RELOAD_DEBUG_DEFAULTS.scrubEnabled;
  reloadDebugSocket.scrubT = RELOAD_DEBUG_DEFAULTS.scrubT;
  reloadDebugSocket.pinProgress = RELOAD_DEBUG_DEFAULTS.pinProgress;
  reloadDebugSocket.handPosition = cloneVec3(RELOAD_DEBUG_DEFAULTS.handPosition);
  reloadDebugSocket.handRotationDeg = cloneVec3(RELOAD_DEBUG_DEFAULTS.handRotationDeg);
  reloadDebugSocket.restOffset = cloneVec3(RELOAD_DEBUG_DEFAULTS.restOffset);
  reloadDebugSocket.socketOffset = cloneVec3(RELOAD_DEBUG_DEFAULTS.socketOffset);
  reloadDebugSocket.extractOffset = cloneVec3(RELOAD_DEBUG_DEFAULTS.extractOffset);
  reloadDebugSocket.beltOffset = cloneVec3(RELOAD_DEBUG_DEFAULTS.beltOffset);
  reloadDebugSocket.extractDrop = RELOAD_DEBUG_DEFAULTS.extractDrop;
  reloadDebugSocket.magCarryPosition = cloneVec3(RELOAD_DEBUG_DEFAULTS.magCarryPosition);
  reloadDebugSocket.magCarryRotationDeg = cloneVec3(RELOAD_DEBUG_DEFAULTS.magCarryRotationDeg);
  bumpReloadDebugSocket();
  return reloadDebugSocket;
}

/** Snapshot for console / paste into defaults. */
export function logReloadDebugSocket() {
  const s = {
    handPosition: cloneVec3(reloadDebugSocket.handPosition),
    handRotationDeg: cloneVec3(reloadDebugSocket.handRotationDeg),
    restOffset: cloneVec3(reloadDebugSocket.restOffset),
    socketOffset: cloneVec3(reloadDebugSocket.socketOffset),
    extractOffset: cloneVec3(reloadDebugSocket.extractOffset),
    beltOffset: cloneVec3(reloadDebugSocket.beltOffset),
    extractDrop: reloadDebugSocket.extractDrop,
    magCarryPosition: cloneVec3(reloadDebugSocket.magCarryPosition),
    magCarryRotationDeg: cloneVec3(reloadDebugSocket.magCarryRotationDeg),
    scrubT: reloadDebugSocket.scrubT,
  };
  console.info('[reload-debug]', s);
  try {
    console.info('[reload-debug] json', JSON.stringify(s, null, 2));
  } catch {
    /* ignore */
  }
  return s;
}

/**
 * Effective normalized t for the left-hand path this frame.
 * @param {number} liveProgress gun.reloadProgress when reloading
 * @param {boolean} isReloading
 */
export function resolveReloadDebugProgress(liveProgress, isReloading) {
  if (reloadDebugSocket.scrubEnabled) {
    const t = Number(reloadDebugSocket.scrubT);
    return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  }
  if (!isReloading) return null;
  const t = Number(liveProgress);
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

/** Whether the gun timer should freeze at scrubT this frame. */
export function reloadDebugShouldPinProgress(isReloading) {
  return Boolean(
    reloadDebugSocket.scrubEnabled
    && reloadDebugSocket.pinProgress
    && isReloading,
  );
}

/** Path options consumed by sampleReloadLeftHand. */
export function getReloadDebugPathOptions() {
  if (!reloadDebugSocket.enabled) {
    return {
      restOffset: null,
      socketOffset: null,
      extractOffset: null,
      beltOffset: null,
      extractDrop: RELOAD_DEBUG_DEFAULTS.extractDrop,
      handPosition: null,
    };
  }
  return {
    restOffset: reloadDebugSocket.restOffset,
    socketOffset: reloadDebugSocket.socketOffset,
    extractOffset: reloadDebugSocket.extractOffset,
    beltOffset: reloadDebugSocket.beltOffset,
    extractDrop: Number.isFinite(reloadDebugSocket.extractDrop)
      ? reloadDebugSocket.extractDrop
      : RELOAD_DEBUG_DEFAULTS.extractDrop,
    handPosition: reloadDebugSocket.handPosition,
  };
}
