import { GAME_CONFIG } from '../../config/gameConfig.js';

/** Master switch for jacket/cloth experiments (sim, editor UI, per-frame cost). */
export function isJacketExperimentsEnabled() {
  return GAME_CONFIG.character.jacketExperiments === true;
}

/** Whether the in-game cloth collider editor button/panel should appear. */
export function isJacketClothUiEnabled() {
  return isJacketExperimentsEnabled();
}

/**
 * Active jacket mode: "cloth" | "procedural" | "off".
 * `?jacket=cloth|procedural|off` overrides config for quick experiments.
 * When `jacketExperiments` is false, defaults to "off" unless the URL override is set.
 */
export function resolveJacketMode() {
  if (typeof window !== 'undefined') {
    const requested = new URLSearchParams(window.location.search).get('jacket');
    if (requested === 'procedural' || requested === 'cloth' || requested === 'off') {
      return requested;
    }
  }
  if (!isJacketExperimentsEnabled()) {
    return 'off';
  }
  return GAME_CONFIG.character.jacket ?? 'cloth';
}
