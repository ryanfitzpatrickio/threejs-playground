/**
 * Deathmatch match reducer — pure phase/score/death/respawn/reset transitions.
 *
 * PartyKit-free and deterministic given its inputs (including the `now` passed
 * in and the round seed). MatchRoom owns IO and stamps sequence numbers; the
 * functions here return unstamped `{ kind, payload }` events. Spawn selection is
 * seeded so verifiers reproduce it exactly (see plan §Authored data).
 */

import {
  MATCH_PHASE,
  ROOM_CONFIG,
  HEALTH,
  STARTING_WEAPON,
  SPAWN_SELECTION,
  createStartingInventory,
} from '../../src/game/config/deathmatch/deathmatchRules.js';
import { RAIL_CRUCIBLE } from '../../src/game/config/deathmatch/railCrucibleMap.js';
import { distance } from '../../src/game/net/deathmatchGeometry.js';
import { playerCapsule, isSightBlocked, tickReloads, DEATH_CAUSE } from './combat.js';
import { createPickupState, resetPickups, tickPickups } from './pickups.js';

/** Mix a base seed with a round number → uint32. */
function roundSeedFor(baseSeed, roundNumber) {
  return (Math.imul((baseSeed >>> 0) ^ (roundNumber * 0x9e3779b9), 0x85ebca6b) >>> 0) || 1;
}

function mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createMatchState({ roomId, seed = 0x524c4331, mapId = RAIL_CRUCIBLE.id, config = ROOM_CONFIG, allowSoloStart = false } = {}) {
  return {
    roomId: roomId ?? 'room',
    mapId,
    config,
    baseSeed: seed >>> 0,
    roundNumber: 1,
    roundId: 'round-1',
    roundSeed: roundSeedFor(seed, 1),
    phase: MATCH_PHASE.WAITING,
    phaseEndsAt: 0,
    matchStartedAt: 0,
    matchEndsAt: 0,
    fragLimit: config.fragLimit,
    players: new Map(),
    pickups: createPickupState(),
    eventSequence: 0,
    spawnCounter: 0,
    allowSoloStart,
    winnerId: null,
  };
}

export function createPlayerState({ playerId, displayName, connectionId, resumeToken }) {
  return {
    playerId,
    displayName,
    connectionId,
    resumeToken,
    connected: true,
    disconnectedAt: null,
    ready: false,
    spectator: false,
    alive: false,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    health: 0,
    weapons: {},
    currentWeapon: STARTING_WEAPON,
    fire: { nextFireAt: 0, lastShotSeq: -1 },
    reload: { active: false, weaponId: null, endsAt: 0 },
    frags: 0,
    deaths: 0,
    lastInputSeq: -1,
    lastSampleAt: 0,
    spawnProtectedUntil: 0,
    respawnAt: null,
    lifeSeq: 0,
    history: [],
    lastAttackerId: null,
    lastAttackerAt: 0,
    locomotionState: 'idle',
    movementFlags: 0,
    animation: null,
  };
}

/** Count connected, non-spectator players. */
export function connectedCount(state) {
  let n = 0;
  for (const p of state.players.values()) if (p.connected && !p.spectator) n += 1;
  return n;
}

function readyCount(state) {
  let n = 0;
  for (const p of state.players.values()) if (p.connected && !p.spectator && p.ready) n += 1;
  return n;
}

// ── Membership ───────────────────────────────────────────────────────────────

/** Add a player. Returns `{ player, events }` or `{ error }` when at capacity. */
export function addPlayer(state, opts, now) {
  if (connectedCount(state) >= state.config.capacity) {
    return { error: 'capacity', events: [] };
  }
  const player = createPlayerState(opts);
  // Late joiners during an active round spawn at the next safe opportunity.
  // Lobby does not place bodies — remotes only appear once spawnPlayer sets alive.
  if (state.phase === MATCH_PHASE.RUNNING) {
    player.respawnAt = now + state.config.respawnDelayMs;
  }
  state.players.set(player.playerId, player);
  return { player, events: [{ kind: 'player_join', payload: { playerId: player.playerId, displayName: player.displayName } }] };
}

export function setReady(state, playerId, ready) {
  const player = state.players.get(playerId);
  if (!player) return [];
  player.ready = !!ready;
  return [];
}

/** Mark a player disconnected; their body becomes non-targetable immediately. */
export function markDisconnected(state, playerId, now) {
  const player = state.players.get(playerId);
  if (!player) return [];
  player.connected = false;
  player.disconnectedAt = now;
  player.alive = false;
  player.ready = false;
  return [];
}

/** Restore a disconnected player within the resume window. */
export function resumePlayer(state, playerId, connectionId, resumeToken, now) {
  const player = state.players.get(playerId);
  if (!player || player.connected) return { ok: false };
  if (player.resumeToken !== resumeToken) return { ok: false };
  if (now - player.disconnectedAt > state.config.resumeWindowMs) return { ok: false };
  player.connected = true;
  player.connectionId = connectionId;
  player.disconnectedAt = null;
  if (state.phase === MATCH_PHASE.RUNNING && !player.alive && player.respawnAt === null) {
    player.respawnAt = now + state.config.respawnDelayMs;
  }
  return { ok: true, player };
}

/** Remove players whose resume window has expired. Returns leave events. */
export function pruneDisconnected(state, now) {
  const events = [];
  for (const [id, p] of state.players) {
    if (!p.connected && p.disconnectedAt !== null && now - p.disconnectedAt > state.config.resumeWindowMs) {
      state.players.delete(id);
      events.push({ kind: 'player_leave', payload: { playerId: id } });
    }
  }
  return events;
}

/** Explicitly remove a player (leave to menu). */
export function removePlayer(state, playerId) {
  if (!state.players.has(playerId)) return [];
  state.players.delete(playerId);
  return [{ kind: 'player_leave', payload: { playerId } }];
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Choose a spawn for `forPlayerId`. Distance dominates; visible points are
 * penalized; a farthest-point fallback always returns something. Deterministic
 * via the round seed + spawn counter.
 */
export function selectSpawn(state, forPlayerId, now) {
  const spawns = RAIL_CRUCIBLE.playerSpawns;
  const opponents = [];
  for (const [id, p] of state.players) {
    if (id === forPlayerId || !p.connected || !p.alive) continue;
    opponents.push(playerCapsule(p.position).headCenter);
  }

  const rng = mulberry32(roundSeedFor(state.roundSeed, state.spawnCounter));
  state.spawnCounter += 1;

  let best = null;
  let fallback = null;
  for (const spawn of spawns) {
    const head = playerCapsule(spawn.position).headCenter;
    let minDist = Infinity;
    let visible = 0;
    let tooClose = false;
    for (const oppHead of opponents) {
      const d = distance(head, oppHead);
      if (d < minDist) minDist = d;
      if (d < SPAWN_SELECTION.safetyRadiusM) tooClose = true;
      if (!isSightBlocked(head, oppHead)) visible += 1;
    }
    // Fallback tracks the farthest-from-opponents point regardless of safety.
    const fbScore = minDist + rng() * 0.001;
    if (fallback === null || fbScore > fallback.score) fallback = { spawn, score: fbScore };
    if (tooClose) continue;
    const score = minDist - SPAWN_SELECTION.visiblePenalty * visible + rng() * 0.001;
    if (best === null || score > best.score) best = { spawn, score };
  }

  return (best ?? fallback).spawn;
}

/** Spawn (or respawn) a player with the starting loadout at a safe point. */
export function spawnPlayer(state, player, now) {
  const spawn = selectSpawn(state, player.playerId, now);
  player.position = [spawn.position[0], spawn.position[1], spawn.position[2]];
  player.yaw = spawn.yaw;
  player.velocity = [0, 0, 0];
  player.alive = true;
  player.spectator = false;
  player.health = HEALTH.spawn;
  player.weapons = createStartingInventory();
  player.currentWeapon = STARTING_WEAPON;
  player.animation = null;
  player.fire = { nextFireAt: 0, lastShotSeq: -1 };
  player.reload = { active: false, weaponId: null, endsAt: 0 };
  player.spawnProtectedUntil = now + state.config.spawnProtectionMs;
  player.respawnAt = null;
  player.lifeSeq += 1;
  player.lastAttackerId = null;
  player.history = [{ t: now, position: [...player.position] }];
  // Snapshot weapons for the client (ammo/reserve) so presentation does not invent loadout.
  const weapons = {};
  for (const [id, inv] of Object.entries(player.weapons)) {
    weapons[id] = { ammo: inv.ammo, reserve: inv.reserve };
  }
  return [{
    kind: 'respawn',
    payload: {
      playerId: player.playerId,
      position: player.position,
      yaw: player.yaw,
      health: player.health,
      lifeSeq: player.lifeSeq,
      currentWeapon: player.currentWeapon,
      weapons,
      spawnProtectedUntil: player.spawnProtectedUntil,
    },
  }];
}

// ── Death and scoring ────────────────────────────────────────────────────────

/** Finalize a death intent (from combat or movement). Idempotent per life. */
export function registerDeath(state, intent, now) {
  const victim = state.players.get(intent.victimId);
  if (!victim || !victim.alive) return []; // already dead this life → dedupe
  victim.alive = false;
  victim.health = 0;
  victim.deaths += 1;
  victim.reload = { active: false, weaponId: null, endsAt: 0 };
  victim.respawnAt = now + state.config.respawnDelayMs;

  const attacker = intent.attackerId ? state.players.get(intent.attackerId) : null;
  const isFrag = intent.cause === DEATH_CAUSE.KILL && attacker && intent.attackerId !== intent.victimId;
  if (isFrag) {
    attacker.frags += 1;
  } else {
    victim.frags -= 1; // suicide / world death; display floors at 0, state may go negative
  }

  return [{
    kind: 'death',
    payload: {
      victimId: intent.victimId,
      attackerId: isFrag ? intent.attackerId : null,
      cause: intent.cause,
      weaponId: intent.weaponId ?? null,
    },
  }];
}

/** Frags/deaths sorted for the scoreboard. */
export function computeStandings(state) {
  return [...state.players.values()]
    .map((p) => ({ playerId: p.playerId, displayName: p.displayName, frags: p.frags, deaths: p.deaths }))
    .sort((a, b) => b.frags - a.frags || a.deaths - b.deaths || a.playerId.localeCompare(b.playerId));
}

// ── Phase machine ────────────────────────────────────────────────────────────

function eligibleToStart(state) {
  const ready = readyCount(state);
  if (state.allowSoloStart) return ready >= 1;
  return ready >= state.config.minPlayersToStart;
}

function beginCountdown(state, now) {
  state.phase = MATCH_PHASE.COUNTDOWN;
  state.phaseEndsAt = now + state.config.countdownMs;
  return [
    { kind: 'phase_change', payload: { phase: state.phase, phaseEndsAt: state.phaseEndsAt } },
    { kind: 'countdown', payload: { endsAt: state.phaseEndsAt } },
  ];
}

function startRunning(state, now) {
  state.phase = MATCH_PHASE.RUNNING;
  state.matchStartedAt = now;
  state.matchEndsAt = now + state.config.matchDurationMs;
  state.winnerId = null;
  resetPickups(state);
  const events = [{ kind: 'phase_change', payload: { phase: state.phase, phaseEndsAt: state.matchEndsAt } }];
  for (const p of state.players.values()) {
    if (!p.connected) continue;
    p.frags = 0;
    p.deaths = 0;
    p.respawnAt = null;
    events.push(...spawnPlayer(state, p, now));
  }
  return events;
}

function fragLeader(state) {
  let leader = null;
  for (const p of state.players.values()) {
    if (leader === null || p.frags > leader.frags) leader = p;
  }
  return leader;
}

function endMatch(state, now, reason) {
  state.phase = MATCH_PHASE.INTERMISSION;
  state.phaseEndsAt = now + state.config.intermissionMs;
  const standings = computeStandings(state);
  state.winnerId = standings.length > 0 && standings[0].frags > 0 ? standings[0].playerId : (standings[0]?.playerId ?? null);
  for (const p of state.players.values()) p.alive = false;
  return [
    { kind: 'phase_change', payload: { phase: state.phase, phaseEndsAt: state.phaseEndsAt } },
    { kind: 'round_result', payload: { reason, winnerId: state.winnerId, standings } },
  ];
}

function resetRound(state, now) {
  state.roundNumber += 1;
  state.roundId = `round-${state.roundNumber}`;
  state.roundSeed = roundSeedFor(state.baseSeed, state.roundNumber);
  state.spawnCounter = 0;
  state.phase = MATCH_PHASE.WAITING;
  state.phaseEndsAt = 0;
  state.matchStartedAt = 0;
  state.matchEndsAt = 0;
  state.winnerId = null;
  resetPickups(state);
  for (const p of state.players.values()) {
    p.alive = false;
    p.health = 0;
    p.frags = 0;
    p.deaths = 0;
    p.weapons = {};
    p.currentWeapon = STARTING_WEAPON;
    p.animation = null;
    p.fire = { nextFireAt: 0, lastShotSeq: -1 };
    p.reload = { active: false, weaponId: null, endsAt: 0 };
    p.respawnAt = null;
    p.spawnProtectedUntil = 0;
    p.lastAttackerId = null;
    p.history = [];
  }
  return [{ kind: 'phase_change', payload: { phase: state.phase, phaseEndsAt: 0 } }];
}

function tickRespawns(state, now) {
  const events = [];
  for (const p of state.players.values()) {
    if (p.connected && !p.alive && p.respawnAt !== null && now >= p.respawnAt) {
      events.push(...spawnPlayer(state, p, now));
    }
  }
  return events;
}

/**
 * Advance the match one server tick. Returns unstamped events. Death intents
 * from combat/movement must already have been applied (via registerDeath) so
 * the win check sees current scores.
 */
export function advancePhase(state, now) {
  const events = [];
  events.push(...pruneDisconnected(state, now));

  switch (state.phase) {
    case MATCH_PHASE.WAITING:
      if (eligibleToStart(state)) events.push(...beginCountdown(state, now));
      break;

    case MATCH_PHASE.COUNTDOWN:
      if (!eligibleToStart(state)) {
        state.phase = MATCH_PHASE.WAITING;
        state.phaseEndsAt = 0;
        events.push({ kind: 'phase_change', payload: { phase: state.phase, phaseEndsAt: 0 } });
      } else if (now >= state.phaseEndsAt) {
        events.push(...startRunning(state, now));
      }
      break;

    case MATCH_PHASE.RUNNING: {
      events.push(...tickReloads(state, now));
      events.push(...tickPickups(state, now));
      events.push(...tickRespawns(state, now));
      const leader = fragLeader(state);
      if (leader && leader.frags >= state.fragLimit) {
        events.push(...endMatch(state, now, 'frag_limit'));
      } else if (now >= state.matchEndsAt) {
        events.push(...endMatch(state, now, 'time_limit'));
      }
      break;
    }

    case MATCH_PHASE.INTERMISSION:
      if (now >= state.phaseEndsAt) events.push(...resetRound(state, now));
      break;

    default:
      break;
  }

  return events;
}
