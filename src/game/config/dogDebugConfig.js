/** Live dog controls shared by Studio, the park player, and park NPCs. */
export const dogDebugState = {
  // Per-leg CCD foot IK is OFF by default: retargeted clips read cleaner
  // without the solver fighting the authored leg poses. Root ground snap in
  // plantDogFeet still runs; flip this (debug panel) to re-enable leg IK.
  footIkEnabled: false,
  // Per-leg analytic IK for the PROCEDURAL gait (dogAnimation.js updateGait)
  // is ON by default — unlike footIkEnabled above, there is no retargeted
  // clip to fight here. Rollout escape hatch for breed/species outliers.
  proceduralLegIkEnabled: true,
  // Same analytic solver, applied on top of the retargeted CLIP pose
  // (dogAnimation.js applyPostClipOverlays, walk/trot only) for slope
  // ground-contact. Separate flag from footIkEnabled (the older Y-only CCD)
  // since this is a different solver/behavior-gate — on by default, but flip
  // off here if it visibly fights a specific clip's authored leg silhouette.
  clipLegIkEnabled: true,
};

export function setDogDebugField(key, value) {
  if (!(key in dogDebugState)) return false;
  if (key === 'footIkEnabled' || key === 'proceduralLegIkEnabled' || key === 'clipLegIkEnabled') {
    dogDebugState[key] = Boolean(value);
  } else {
    dogDebugState[key] = value;
  }
  return true;
}

export function snapshotDogDebug() {
  return {
    footIkEnabled: dogDebugState.footIkEnabled,
    proceduralLegIkEnabled: dogDebugState.proceduralLegIkEnabled,
    clipLegIkEnabled: dogDebugState.clipLegIkEnabled,
  };
}
