/**
 * Ordered frame phase/step manifest.
 *
 * The pipeline executes these phases in order. Step IDs are stable contracts for
 * characterization tests and future per-step registration. New systems register
 * here (or via a feature's exported steps) — never in GameRuntime.js.
 *
 * Hot path: the plan is static; RuntimeFramePipeline builds/calls once-resolved
 * handlers. No per-frame sorting or dependency-graph resolution.
 *
 * @see docs/game-runtime-modularization-plan.md
 */

/** @typedef {{ id: string, phase: string, description: string }} FrameStep */

export const FRAME_PHASES = [
  'frame-gates',
  'world-streaming',
  'time-and-input',
  'actors',
  'locomotion',
  'animation',
  'pre-physics',
  'physics',
  'post-physics',
  'camera-and-weapons',
  'environment',
  'render-and-publish',
];

/** @type {FrameStep[]} */
export const FRAME_STEPS = [
  { id: 'visibility-render-cap', phase: 'frame-gates', description: 'Tab visibility + 60fps render cap' },
  { id: 'delta-clamp', phase: 'frame-gates', description: 'Frame delta clamp' },
  { id: 'loading-prewarm-gate', phase: 'frame-gates', description: 'Loading / prewarm early paths' },
  { id: 'photo-mode-early', phase: 'frame-gates', description: 'Photo mode free-fly early return' },
  { id: 'interior-interaction-early', phase: 'frame-gates', description: 'Interior door/elevator early path' },

  { id: 'weather-update', phase: 'world-streaming', description: 'Weather system tick' },
  { id: 'forest-ambience', phase: 'world-streaming', description: 'Forest environment / ambience' },
  { id: 'collision-debug', phase: 'world-streaming', description: 'Collision debug visualization' },
  { id: 'streaming-changes', phase: 'world-streaming', description: 'Level streaming + collider drain' },
  { id: 'shadow-light-follow', phase: 'world-streaming', description: 'Shadow/light follow player' },
  { id: 'bvh-warmup', phase: 'world-streaming', description: 'BVH warmup budget' },

  { id: 'crowd-cut-input', phase: 'time-and-input', description: 'Crowd / cut input routing' },
  { id: 'car-leap-bullet-time', phase: 'time-and-input', description: 'Car-leap bullet time scale' },
  { id: 'physics-begin-frame', phase: 'time-and-input', description: 'PhysicsSystem.beginFrame planning' },
  { id: 'loadout-hijack-ability', phase: 'time-and-input', description: 'Loadout / hijack / ability routing' },
  { id: 'deathmatch-net-apply', phase: 'time-and-input', description: 'Deathmatch corrections / teleport events' },
  { id: 'sim-picking', phase: 'time-and-input', description: 'Sims selection and click-to-move routing' },
  { id: 'dog-park-input', phase: 'time-and-input', description: 'Dog avatar input routing' },

  { id: 'horse-level-presim', phase: 'actors', description: 'Horse / level / mode pre-sim' },
  { id: 'player-damage', phase: 'actors', description: 'Player damage system' },
  { id: 'horde-proxies-queue', phase: 'actors', description: 'Horde proxy update + spawn queue' },
  { id: 'enemy-update', phase: 'actors', description: 'Enemy system update' },
  { id: 'collider-sync', phase: 'actors', description: 'Enemy/prop collider sync' },
  { id: 'sim-actors', phase: 'actors', description: 'Sim steering and animation state' },
  { id: 'dog-park-controller', phase: 'actors', description: 'Dog kinematic controller and procedural pose' },

  { id: 'car-leap', phase: 'locomotion', description: 'Car leap system' },
  { id: 'vehicles', phase: 'locomotion', description: 'VehicleSystem update' },
  { id: 'run-over-damage', phase: 'locomotion', description: 'Vehicle run-over + damage' },
  { id: 'mount', phase: 'locomotion', description: 'Mount system' },
  { id: 'carry-item', phase: 'locomotion', description: 'Carry pickup / drop (E)' },
  { id: 'fp-gating', phase: 'locomotion', description: 'First-person gating' },
  { id: 'traversal-router', phase: 'locomotion', description: 'Traversal router' },
  { id: 'combat-input', phase: 'locomotion', description: 'Combat input processing' },
  { id: 'movement-traversal-chain', phase: 'locomotion', description: 'Movement + traversal override chain' },
  { id: 'deathmatch-sample-send', phase: 'locomotion', description: 'Deathmatch local player_state sample' },

  { id: 'fp-locomotion', phase: 'animation', description: 'FP locomotion' },
  { id: 'animation-state', phase: 'animation', description: 'Animation state system' },
  { id: 'spine-weapon-ik', phase: 'animation', description: 'Spine / weapon / hand IK' },
  { id: 'carry-item-attach', phase: 'animation', description: 'Carried item attach + hand IK' },
  { id: 'wingsuit-visuals', phase: 'animation', description: 'Wingsuit visuals' },
  { id: 'jacket-cloth', phase: 'animation', description: 'Jacket / cloth sim' },
  { id: 'sim-garments', phase: 'animation', description: 'Per-sim XPBD garment simulation' },
  { id: 'deathmatch-remote-puppets', phase: 'animation', description: 'Deathmatch remote puppet interpolation' },

  { id: 'telekinesis', phase: 'pre-physics', description: 'Telekinesis resolution' },
  { id: 'combat-resolution', phase: 'pre-physics', description: 'Combat resolution' },
  { id: 'rope-hand-align', phase: 'pre-physics', description: 'Rope hand alignment' },

  { id: 'physics-step-planned', phase: 'physics', description: 'Fixed steps via stepPlanned' },
  { id: 'platform-carry-close', phase: 'physics', description: 'Platform carry window close' },

  { id: 'vehicle-interp-mud', phase: 'post-physics', description: 'Vehicle visual poses + mud' },
  { id: 'cut-props', phase: 'post-physics', description: 'Cut props sync' },
  { id: 'thrown-impacts', phase: 'post-physics', description: 'Thrown impact resolution' },
  { id: 'rope-hook-visuals', phase: 'post-physics', description: 'Rope / hook visuals' },

  { id: 'camera', phase: 'camera-and-weapons', description: 'Camera system (before hitscan)' },
  { id: 'sim-camera', phase: 'camera-and-weapons', description: 'RTS orbit, pan, and zoom camera' },
  { id: 'dog-park-camera', phase: 'camera-and-weapons', description: 'Dog-scale third-person chase camera' },
  { id: 'fp-post-camera', phase: 'camera-and-weapons', description: 'FP post-camera' },
  { id: 'propane-tanks', phase: 'camera-and-weapons', description: 'Propane fuses, chain reactions, damage, and FX' },
  { id: 'hitscan-weapons', phase: 'camera-and-weapons', description: 'Hitscan weapon update' },
  { id: 'shooting-range', phase: 'camera-and-weapons', description: 'Shooting range system' },
  { id: 'aquarium-breach', phase: 'camera-and-weapons', description: 'Aquarium breach drain + water jets' },

  { id: 'resize', phase: 'environment', description: 'Renderer resize' },
  { id: 'building-prompt', phase: 'environment', description: 'Building entry prompt' },
  { id: 'sky-terrain-uniforms', phase: 'environment', description: 'Sky / environment / terrain uniforms' },
  { id: 'spectator-crowd', phase: 'environment', description: 'Spectator crowd' },

  { id: 'render', phase: 'render-and-publish', description: 'RendererSystem.render' },
  { id: 'after-render', phase: 'render-and-publish', description: 'After-render callbacks' },
  { id: 'timings-diagnostics', phase: 'render-and-publish', description: 'Frame timings / diagnostics' },
  { id: 'snapshot-emit', phase: 'render-and-publish', description: 'Snapshot cadence emission' },
];

/**
 * Validate plan integrity at startup. Throws on duplicate IDs or unknown phases.
 * @param {FrameStep[]} [steps]
 */
export function validateFramePlan(steps = FRAME_STEPS) {
  const phaseSet = new Set(FRAME_PHASES);
  const seen = new Set();
  for (const step of steps) {
    if (!phaseSet.has(step.phase)) {
      throw new Error(`[frame-plan] unknown phase "${step.phase}" for step "${step.id}"`);
    }
    if (seen.has(step.id)) {
      throw new Error(`[frame-plan] duplicate step id "${step.id}"`);
    }
    seen.add(step.id);
  }
  return true;
}

/** Stable ordered list of step IDs (for characterization tests). */
export function frameStepIdList(steps = FRAME_STEPS) {
  return steps.map((s) => s.id);
}
