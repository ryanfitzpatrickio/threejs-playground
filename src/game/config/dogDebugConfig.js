/** Live dog controls shared by Studio, the park player, and park NPCs. */
export const dogDebugState = {
  footIkEnabled: true,
};

export function setDogDebugField(key, value) {
  if (!(key in dogDebugState)) return false;
  if (key === 'footIkEnabled') dogDebugState[key] = Boolean(value);
  else dogDebugState[key] = value;
  return true;
}

export function snapshotDogDebug() {
  return {
    footIkEnabled: dogDebugState.footIkEnabled,
  };
}
