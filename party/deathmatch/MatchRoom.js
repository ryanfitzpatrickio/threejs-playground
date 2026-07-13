/**
 * MatchRoom — deathmatch room state + fixed-tick orchestrator (M0).
 *
 * PartyKit-free by design: all IO goes through an injected outbound buffer, and
 * time is passed in (`now`). The M2 `party/server.js` adapter wraps this class,
 * mapping `onConnect/onMessage/onClose` and the outbound buffer to PartySocket
 * sends. Node verifiers drive it directly with fake connections.
 *
 * Responsibilities: identity/capacity, resume, protocol validation + rate
 * limiting, message dispatch to the pure combat/movement/pickup modules, death
 * routing to the reducer, phase advancement, and snapshot/event emission.
 */

import {
  PROTOCOL_VERSION,
  SERVER_MSG,
  CLIENT_MSG,
  ERROR_CODE,
  validateClientMessage,
  isWithinSizeBudget,
  sanitizeDisplayName,
} from '../../src/game/net/deathmatchProtocol.js';
import { MATCH_PHASE, ROOM_CONFIG } from '../../src/game/config/deathmatch/deathmatchRules.js';
import {
  createMatchState,
  addPlayer,
  setReady,
  markDisconnected,
  resumePlayer,
  removePlayer,
  registerDeath,
  advancePhase,
} from './matchReducer.js';
import { resolveFire, resolveShotTime, startReload } from './combat.js';
import { applyMovementSample } from './movement.js';
import { requestPickup } from './pickups.js';

export class MatchRoom {
  constructor({ roomId = 'room', seed, config = ROOM_CONFIG, allowSoloStart = false } = {}) {
    this.state = createMatchState({ roomId, seed, config, allowSoloStart });
    this.config = config;
    /** connId → { playerId, inboundThisTick } */
    this.connections = new Map();
    /** Outbound messages: { to: connId | '*', msg }. Drain from the adapter. */
    this.outbound = [];
    this.tickIndex = 0;
    this._playerCounter = 0;
    this._tokenCounter = 0;
  }

  // ── Outbound plumbing ──────────────────────────────────────────────────────

  _send(to, msg) {
    // Bound per-connection backlog so a slow/silent client can't grow the queue.
    if (to !== '*') {
      let queued = 0;
      for (const item of this.outbound) if (item.to === to) queued += 1;
      if (queued >= this.config.maxOutboundQueue) return;
    }
    this.outbound.push({ to, msg });
  }

  _broadcast(msg) {
    this.outbound.push({ to: '*', msg });
  }

  _error(to, code, message, recoverable = true) {
    this._send(to, { v: PROTOCOL_VERSION, type: SERVER_MSG.ERROR, code, recoverable, message });
  }

  /** Stamp + broadcast a batch of unstamped `{ kind, payload }` reducer events. */
  _emit(events) {
    for (const ev of events) {
      this._broadcast({
        v: PROTOCOL_VERSION,
        type: SERVER_MSG.EVENT,
        seq: (this.state.eventSequence += 1),
        kind: ev.kind,
        payload: ev.payload,
      });
    }
  }

  /** Route death intents to the reducer and emit the resulting events. */
  _applyDeaths(deaths, now) {
    for (const intent of deaths) this._emit(registerDeath(this.state, intent, now));
  }

  /** Drain and clear the outbound buffer (adapter/test entry point). */
  drainOutbound() {
    const out = this.outbound;
    this.outbound = [];
    return out;
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  /**
   * Attach a connection. Optionally resume a prior identity with `resumeToken`.
   * @returns {{ playerId: string }|{ error: string }}
   */
  connect(connId, { displayName, playerId: resumeId, resumeToken } = {}, now) {
    if (resumeId && resumeToken) {
      const res = resumePlayer(this.state, resumeId, connId, resumeToken, now);
      if (res.ok) {
        this.connections.set(connId, { playerId: resumeId, inboundThisTick: 0 });
        this._sendWelcome(connId, res.player, now);
        return { playerId: resumeId };
      }
    }

    const id = `p${(this._playerCounter += 1)}`;
    const token = `resume-${(this._tokenCounter += 1)}`;
    const { player, error, events } = addPlayer(
      this.state,
      { playerId: id, displayName: sanitizeDisplayName(displayName), connectionId: connId, resumeToken: token },
      now,
    );
    if (error) {
      this._playerCounter -= 1;
      this._tokenCounter -= 1;
      this._error(connId, ERROR_CODE.CAPACITY, 'room is full', false);
      return { error };
    }
    this.connections.set(connId, { playerId: id, inboundThisTick: 0 });
    this._sendWelcome(connId, player, now);
    this._emit(events);
    return { playerId: id };
  }

  _sendWelcome(connId, player, now) {
    this._send(connId, {
      v: PROTOCOL_VERSION,
      type: SERVER_MSG.WELCOME,
      playerId: player.playerId,
      resumeToken: player.resumeToken,
      serverTime: now,
      roomConfig: {
        capacity: this.config.capacity,
        fragLimit: this.config.fragLimit,
        matchDurationMs: this.config.matchDurationMs,
      },
      mapId: this.state.mapId,
      fullState: this._fullState(now),
    });
  }

  disconnect(connId, now) {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this._emit(markDisconnected(this.state, conn.playerId, now));
    this.connections.delete(connId);
  }

  /** Explicit leave to menu — remove immediately. */
  leave(connId, now) {
    const conn = this.connections.get(connId);
    if (!conn) return;
    this._emit(removePlayer(this.state, conn.playerId));
    this.connections.delete(connId);
  }

  // ── Inbound dispatch ───────────────────────────────────────────────────────

  /**
   * Handle one raw client message (already JSON-decoded, or the raw string).
   * Applies size, rate, protocol, and rule validation. Never throws.
   */
  message(connId, raw, now) {
    const conn = this.connections.get(connId);
    if (!conn) return;

    // Rate limit: silently drop once the per-tick budget is exceeded.
    conn.inboundThisTick += 1;
    if (conn.inboundThisTick > this.config.maxInboundPerTick) {
      if (conn.inboundThisTick === this.config.maxInboundPerTick + 1) {
        this._error(connId, ERROR_CODE.RATE_LIMITED, 'too many messages');
      }
      return;
    }

    let decoded = raw;
    if (typeof raw === 'string') {
      if (!isWithinSizeBudget(raw)) {
        this._error(connId, ERROR_CODE.TOO_LARGE, 'message too large');
        return;
      }
      try {
        decoded = JSON.parse(raw);
      } catch {
        this._error(connId, ERROR_CODE.BAD_SHAPE, 'invalid json');
        return;
      }
    }

    const result = validateClientMessage(decoded);
    if (!result.ok) {
      this._error(connId, result.code, result.message);
      return;
    }

    const player = this.state.players.get(conn.playerId);
    if (!player) return;
    this._dispatch(conn, player, result.type, result.message, now);
  }

  _dispatch(conn, player, type, msg, now) {
    switch (type) {
      case CLIENT_MSG.READY:
        this._emit(setReady(this.state, player.playerId, msg.ready));
        break;

      case CLIENT_MSG.PLAYER_STATE: {
        const { events, deaths } = applyMovementSample(this.state, player, msg, now);
        this._emit(events);
        this._applyDeaths(deaths, now);
        break;
      }

      case CLIENT_MSG.FIRE: {
        // Lag-comp: clamp clientTime into the history window (or reject stale).
        const shotTime = resolveShotTime(msg.clientTime, now);
        const { shotResult, events, deaths } = resolveFire(
          this.state,
          player,
          msg,
          now,
          shotTime,
        );
        this._send(this._connIdFor(player.playerId), {
          v: PROTOCOL_VERSION,
          type: SERVER_MSG.SHOT_RESULT,
          ...shotResult,
        });
        this._emit(events);
        this._applyDeaths(deaths, now);
        break;
      }

      case CLIENT_MSG.RELOAD:
        startReload(player, msg.weaponId, now);
        break;

      case CLIENT_MSG.PICKUP_REQUEST: {
        const { events } = requestPickup(this.state, player, msg.pickupId, now);
        this._emit(events);
        break;
      }

      case CLIENT_MSG.RESPAWN_READY:
        // Respawn timing is server-owned; acknowledge intent, spawn happens in tick.
        player.wantsRespawn = true;
        break;

      case CLIENT_MSG.PING:
        this._send(this._connIdFor(player.playerId), {
          v: PROTOCOL_VERSION,
          type: SERVER_MSG.PONG,
          nonce: msg.nonce,
          clientTime: msg.clientTime,
          serverTime: now,
        });
        break;

      default:
        break;
    }
  }

  _connIdFor(playerId) {
    for (const [connId, conn] of this.connections) if (conn.playerId === playerId) return connId;
    return '*';
  }

  // ── Fixed tick ─────────────────────────────────────────────────────────────

  /** Advance one server tick: reset rate budgets, step phases, emit snapshot. */
  tick(now) {
    for (const conn of this.connections.values()) conn.inboundThisTick = 0;
    this._emit(advancePhase(this.state, now));

    const running = this.state.phase === MATCH_PHASE.RUNNING;
    const everyN = running ? 1 : Math.round(this.config.tickHz / this.config.idleSnapshotHz);
    if (this.tickIndex % everyN === 0) this._broadcast(this._snapshot(now));
    this.tickIndex += 1;
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  _serializePlayer(p, full) {
    const base = {
      playerId: p.playerId,
      position: p.position,
      velocity: p.velocity,
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      alive: p.alive,
      connected: p.connected,
      currentWeapon: p.currentWeapon,
      frags: p.frags,
      deaths: p.deaths,
      lifeSeq: p.lifeSeq,
      spawnProtectedUntil: p.spawnProtectedUntil,
      locomotionState: p.locomotionState,
      animation: p.animation ?? null,
    };
    if (full) {
      base.displayName = p.displayName;
      base.ready = p.ready;
      base.weapons = p.weapons;
    }
    return base;
  }

  _fullState(now) {
    return {
      roomId: this.state.roomId,
      roundId: this.state.roundId,
      mapId: this.state.mapId,
      phase: this.state.phase,
      phaseEndsAt: this.state.phaseEndsAt,
      serverTime: now,
      fragLimit: this.state.fragLimit,
      players: [...this.state.players.values()].map((p) => this._serializePlayer(p, true)),
      pickups: [...this.state.pickups.values()].map((pk) => ({ id: pk.id, available: pk.available, availableAt: pk.availableAt })),
    };
  }

  _snapshot(now) {
    return {
      v: PROTOCOL_VERSION,
      type: SERVER_MSG.SNAPSHOT,
      serverTime: now,
      tick: this.tickIndex,
      phase: this.state.phase,
      phaseEndsAt: this.state.phaseEndsAt,
      roundId: this.state.roundId,
      players: [...this.state.players.values()].map((p) => this._serializePlayer(p, false)),
      pickupDelta: [...this.state.pickups.values()].map((pk) => ({ id: pk.id, available: pk.available, availableAt: pk.availableAt })),
    };
  }
}
