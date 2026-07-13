/**
 * Bounded deathmatch snapshot for HUD / debug (M3).
 * No socket objects, resume tokens, or unbounded sample history.
 */

export function buildDeathmatchRuntimeSnapshot(feature) {
  if (!feature) return null;
  const net = feature._network;
  const remotes = feature._host?.remotePlayerSystem;
  const combat = feature.combat?.snapshot?.() ?? null;
  return {
    mode: 'deathmatch',
    active: feature._active,
    networkReady: Boolean(net?.isNetworkReady?.()),
    playerId: net?.playerId ?? null,
    phase: net?.phase ?? null,
    roundId: net?.roundId ?? null,
    mapId: net?.mapId ?? null,
    sampleSeq: feature._sampleSeq,
    lastSampleAt: feature._lastSampleAt,
    correctionsApplied: feature._stats.correctionsApplied,
    hardSnaps: feature._stats.hardSnaps,
    softCorrects: feature._stats.softCorrects,
    teleportsApplied: feature._stats.teleportsApplied,
    jumpPadsApplied: feature._stats.jumpPadsApplied,
    samplesSent: feature._stats.samplesSent,
    // M4 combat (bounded — no pending shot maps or VFX handles).
    combat: combat
      ? {
          health: combat.health,
          ammo: combat.ammo,
          reserve: combat.reserve,
          weaponId: combat.weaponId,
          alive: combat.alive,
          lifeSeq: combat.lifeSeq,
          spawnProtectedUntil: combat.spawnProtectedUntil,
          shotSeq: combat.shotSeq,
          lastHitMarker: combat.lastHitMarker,
          lastDeath: combat.lastDeath,
          stats: combat.stats,
        }
      : null,
    remotes: remotes?.snapshot?.() ?? null,
  };
}

/** Attach snapshot() onto the feature instance. */
export function attachDeathmatchRuntimeSnapshot(feature) {
  feature.snapshot = function deathmatchSnapshot() {
    return buildDeathmatchRuntimeSnapshot(this);
  };
}
