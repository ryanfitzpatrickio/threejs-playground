/**
 * Mutable horde playground controls (debug pane + GameRuntime).
 * Not the M3 wave loop — freeform spawn / behavior tweaks for combat testing.
 */

import {
  HORDE_DEFAULT_ENEMY_COUNT,
  listHordeSpectaclePresetIds,
} from './hordePerformanceConfig.js';

export const HORDE_ARCHETYPES = Object.freeze(['faceless', 'tessy', 'cyclop', 'mixed']);

/** Live UI state. GameRuntime reads this when spawning / applying mods. */
export const hordeDebugState = {
  /** How many bots the next "Spawn" action creates. */
  spawnCount: 6,
  /** faceless | tessy | cyclop | mixed */
  archetype: 'mixed',
  /** Boot smoke count (also ?hordeCount=). 0 = none until you spawn from the panel. */
  bootCount: 0,
  /**
   * M6 spectacle density preset id (default | stretch | spectacle | heavy | extreme).
   * Applied by "Fill to preset" / applyHordeSpectaclePreset.
   */
  spectaclePreset: 'default',

  // --- Behavior modifiers (apply to live + future spawns) ---
  /** 0 = frozen in place (still face/animate lightly). */
  speedScale: 1,
  /** Bite damage multiplier. */
  damageScale: 1,
  /** Max HP multiplier at spawn; "Apply health" also scales live HP. */
  healthScale: 1,
  /** Chase / activate distance multiplier. */
  chaseRangeScale: 1,
  /** Melee reach multiplier. */
  attackRangeScale: 1,
  /** Cooldown multiplier (<1 = attack faster). */
  attackCooldownScale: 1,
  /** No chase / attack — idle / patrol only. */
  passive: false,
  /** Zero speed and no AI state changes. */
  frozen: false,
  /** Ignore damage / cuts that would kill (still stagger). Optional testing. */
  invulnerable: false,
};

export function getHordeDebugState() {
  return hordeDebugState;
}

export function setHordeDebugField(key, value) {
  if (!(key in hordeDebugState)) return false;
  hordeDebugState[key] = value;
  return true;
}

/**
 * Snapshot for HUD / debug monitors.
 */
export function snapshotHordeDebug(extra = {}) {
  return {
    spawnCount: hordeDebugState.spawnCount,
    archetype: hordeDebugState.archetype,
    bootCount: hordeDebugState.bootCount,
    spectaclePreset: hordeDebugState.spectaclePreset,
    defaultGate: HORDE_DEFAULT_ENEMY_COUNT,
    spectaclePresetIds: listHordeSpectaclePresetIds(),
    speedScale: hordeDebugState.speedScale,
    damageScale: hordeDebugState.damageScale,
    healthScale: hordeDebugState.healthScale,
    chaseRangeScale: hordeDebugState.chaseRangeScale,
    attackRangeScale: hordeDebugState.attackRangeScale,
    attackCooldownScale: hordeDebugState.attackCooldownScale,
    passive: hordeDebugState.passive,
    frozen: hordeDebugState.frozen,
    invulnerable: hordeDebugState.invulnerable,
    ...extra,
  };
}
