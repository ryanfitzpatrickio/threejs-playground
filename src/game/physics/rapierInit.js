import RAPIER from '@dimforge/rapier3d-compat';

/** Shared Rapier WASM init promise — safe to await from multiple systems. */
let _initPromise = null;

/**
 * @returns {Promise<typeof RAPIER>}
 */
export function ensureRapier() {
  if (!_initPromise) {
    _initPromise = RAPIER.init().then(() => RAPIER);
  }
  return _initPromise;
}

export { RAPIER };
