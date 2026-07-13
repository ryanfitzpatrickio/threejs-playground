/**
 * DeathmatchNetworkSystem (M2/M3) — owns the single deathmatch socket.
 *
 * One instance owns exactly one socket for the lifetime of a room session. It
 * runs the connect → welcome → ready handshake, tracks the authoritative player
 * list / phase / server clock from snapshots, survives reconnects by replaying
 * the server-issued resume token, and exposes a combined "network ready" signal
 * the app crosses together with arena asset-load before entering play.
 *
 * M3 adds movement sample sending via `send`, a bounded event drain for
 * teleporter/jump-pad application, and helpers for local correction + remote
 * sample consumers. Combat (M4) continues to share this same socket.
 *
 * This class stays framework-agnostic (no Solid/Three) and takes an injectable
 * `socketFactory` so node verifiers can loopback against `party/server.js`.
 */

import { PartySocket } from 'partysocket';
import { PROTOCOL_VERSION, CLIENT_MSG, SERVER_MSG, EVENT_KIND } from '../net/deathmatchProtocol.js';

/** Public connection status surfaced to the lobby/room UI. */
export const NET_STATUS = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  WELCOMED: 'welcomed',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
  CLOSED: 'closed',
});

/** Default factory: a reconnecting PartySocket with resume-aware query. */
function defaultSocketFactory({ host, room, query }) {
  return new PartySocket({ host, room, party: 'main', query });
}

export class DeathmatchNetworkSystem {
  /**
   * @param {object} opts
   * @param {string} opts.host PartyKit host (e.g. `127.0.0.1:1999`)
   * @param {string} opts.room room id (normalized room code)
   * @param {string} [opts.displayName]
   * @param {(cfg:{host:string,room:string,query:()=>object})=>object} [opts.socketFactory]
   * @param {() => number} [opts.now]
   */
  constructor({ host, room, displayName = 'Player', socketFactory = defaultSocketFactory, now = Date.now } = {}) {
    this.host = host;
    this.room = room;
    this.displayName = displayName;
    this._socketFactory = socketFactory;
    this._now = now;

    /** @type {any} */
    this.socket = null;
    this._disposed = false;
    this._listeners = new Set();

    // Server-issued identity, replayed on reconnect for resume.
    this._resume = { playerId: null, token: null };

    // Authoritative view, replaced from welcome/snapshots.
    this.status = NET_STATUS.IDLE;
    this.playerId = null;
    this.roomId = room;
    this.mapId = null;
    this.phase = null;
    this.phaseEndsAt = 0;
    this.roundId = null;
    this.serverTime = 0;
    this.clockOffsetMs = 0;
    this.fragLimit = 0;
    this.matchDurationMs = 0;
    this.capacity = 0;
    /** @type {object[]} */
    this.players = [];
    /** @type {object[]} */
    this.pickups = [];
    this.lastError = null;
    /** Ring of recent server events for kill feed / toasts (bounded). */
    this.recentEvents = [];
    /** Monotonic cursor into `recentEvents` for feature consumers (M3). */
    this._eventCursor = 0;
    /**
     * Bounded queue of SHOT_RESULT messages for the combat adapter (M4).
     * Shooter-only; drained each frame so UI/ammo corrections stay in order.
     */
    this._shotResults = [];
    this._shotResultCursor = 0;
    /** Last snapshot tick seen (for diagnostics). */
    this.lastSnapshotTick = -1;
    /** Snapshot generation bumped on every snapshot/welcome full-state apply. */
    this.snapshotGeneration = 0;

    this._welcomed = false;
    this._localReady = false;
    this._pingNonce = 0;
    this._pingTimer = null;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Open the socket and begin the handshake. Idempotent. */
  connect() {
    if (this.socket || this._disposed) return;
    this._setStatus(NET_STATUS.CONNECTING);
    const query = () => {
      const q = { name: this.displayName };
      if (this._resume.playerId && this._resume.token) {
        q.pid = this._resume.playerId;
        q.token = this._resume.token;
      }
      return q;
    };
    this.socket = this._socketFactory({ host: this.host, room: this.room, query });
    this._bind(this.socket);
  }

  _bind(socket) {
    socket.addEventListener('open', this._onOpen);
    socket.addEventListener('message', this._onMessage);
    socket.addEventListener('close', this._onClose);
    socket.addEventListener('error', this._onError);
  }

  _onOpen = () => {
    // Connected; awaiting welcome. A prior welcome means this is a reconnect.
    if (!this._welcomed) this._setStatus(NET_STATUS.CONNECTING);
    else this._setStatus(NET_STATUS.RECONNECTING);
    // Re-assert local ready state after a reconnect so the barrier survives it.
    if (this._welcomed && this._localReady) this.sendReady(true);
    this._startPing();
  };

  _onMessage = (ev) => {
    let msg;
    try {
      msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    } catch {
      return;
    }
    if (!msg || msg.v !== PROTOCOL_VERSION) return;
    this._ingest(msg);
  };

  _onClose = () => {
    if (this._disposed) return;
    // PartySocket auto-reconnects; reflect that unless we never welcomed.
    this._setStatus(this._welcomed ? NET_STATUS.RECONNECTING : NET_STATUS.CLOSED);
    this._stopPing();
  };

  _onError = (ev) => {
    this.lastError = { code: 'socket', message: String(ev?.message ?? 'socket error') };
    if (!this._welcomed) this._setStatus(NET_STATUS.ERROR);
    this._emit();
  };

  // ── Inbound routing ─────────────────────────────────────────────────────────

  _ingest(msg) {
    switch (msg.type) {
      case SERVER_MSG.WELCOME:
        this._onWelcome(msg);
        break;
      case SERVER_MSG.SNAPSHOT:
        this._onSnapshot(msg);
        break;
      case SERVER_MSG.EVENT:
        this._onEvent(msg);
        break;
      case SERVER_MSG.PONG:
        this._onPong(msg);
        break;
      case SERVER_MSG.ERROR:
        this.lastError = { code: msg.code, message: msg.message };
        if (msg.recoverable === false) this.close();
        this._emit();
        break;
      case SERVER_MSG.SHOT_RESULT:
        this._onShotResult(msg);
        break;
      default:
        break;
    }
  }

  _onWelcome(msg) {
    this._welcomed = true;
    this.playerId = msg.playerId;
    this._resume = { playerId: msg.playerId, token: msg.resumeToken };
    this.mapId = msg.mapId;
    this.capacity = msg.roomConfig?.capacity ?? 0;
    this.fragLimit = msg.roomConfig?.fragLimit ?? 0;
    this.matchDurationMs = msg.roomConfig?.matchDurationMs ?? 0;
    this._applyServerClock(msg.serverTime);
    this._applyFullState(msg.fullState);
    this._setStatus(NET_STATUS.WELCOMED);
  }

  _onSnapshot(msg) {
    this.phase = msg.phase;
    this.phaseEndsAt = msg.phaseEndsAt;
    this.roundId = msg.roundId;
    this.lastSnapshotTick = typeof msg.tick === 'number' ? msg.tick : this.lastSnapshotTick;
    this.snapshotGeneration += 1;
    this._applyServerClock(msg.serverTime);
    if (Array.isArray(msg.players)) this.players = msg.players;
    if (Array.isArray(msg.pickupDelta)) this._mergePickups(msg.pickupDelta);
    this._emit();
  }

  _onEvent(msg) {
    // Keep a bounded tail for kill feed / join toasts (rendered later).
    this.recentEvents.push({ seq: msg.seq, kind: msg.kind, payload: msg.payload });
    if (this.recentEvents.length > 64) {
      this.recentEvents.shift();
      // Ring shift slides unread indices left — keep the drain cursor in sync.
      if (this._eventCursor > 0) this._eventCursor -= 1;
    }

    // Phase transitions arrive as authoritative events ahead of the next idle
    // snapshot — apply them immediately so the lobby/HUD stays responsive.
    const p = msg.payload;
    switch (msg.kind) {
      case EVENT_KIND.PHASE_CHANGE:
        if (typeof p?.phase === 'string') this.phase = p.phase;
        if (typeof p?.phaseEndsAt === 'number') this.phaseEndsAt = p.phaseEndsAt;
        break;
      case EVENT_KIND.COUNTDOWN:
        if (typeof p?.endsAt === 'number') this.phaseEndsAt = p.endsAt;
        break;
      case EVENT_KIND.ROUND_RESULT:
        this.winnerId = p?.winnerId ?? null;
        this.standings = Array.isArray(p?.standings) ? p.standings : [];
        break;
      default:
        break;
    }
    this._emit();
  }

  _onPong(msg) {
    // Round-trip clock estimate: server time at reply ≈ midpoint of RTT.
    const rtt = Math.max(0, this._now() - msg.clientTime);
    this.clockOffsetMs = msg.serverTime + rtt / 2 - this._now();
    this._emit();
  }

  _onShotResult(msg) {
    // Keep a bounded ring so a stalled consumer cannot grow memory forever.
    this._shotResults.push({
      shotSeq: msg.shotSeq,
      accepted: Boolean(msg.accepted),
      reason: msg.reason ?? null,
      hitPlayerId: msg.hitPlayerId ?? null,
      hitKind: msg.hitKind ?? null,
      damage: typeof msg.damage === 'number' ? msg.damage : 0,
      authoritativeAmmo: typeof msg.authoritativeAmmo === 'number' ? msg.authoritativeAmmo : null,
    });
    if (this._shotResults.length > 64) {
      this._shotResults.shift();
      if (this._shotResultCursor > 0) this._shotResultCursor -= 1;
    }
    this._emit();
  }

  _applyFullState(full) {
    if (!full) return;
    this.roomId = full.roomId ?? this.roomId;
    this.roundId = full.roundId ?? this.roundId;
    this.mapId = full.mapId ?? this.mapId;
    this.phase = full.phase ?? this.phase;
    this.phaseEndsAt = full.phaseEndsAt ?? this.phaseEndsAt;
    this.fragLimit = full.fragLimit ?? this.fragLimit;
    if (Array.isArray(full.players)) this.players = full.players;
    if (Array.isArray(full.pickups)) this.pickups = full.pickups;
    this.snapshotGeneration += 1;
  }

  _mergePickups(delta) {
    const byId = new Map(this.pickups.map((p) => [p.id, p]));
    for (const d of delta) byId.set(d.id, d);
    this.pickups = [...byId.values()];
  }

  _applyServerClock(serverTime) {
    if (typeof serverTime !== 'number') return;
    this.serverTime = serverTime;
    // Coarse offset until a pong refines it (welcome has no RTT to subtract).
    if (this.clockOffsetMs === 0) this.clockOffsetMs = serverTime - this._now();
  }

  // ── Outbound ────────────────────────────────────────────────────────────────

  /**
   * Outbound backpressure threshold (bytes). When the socket is congested,
   * high-frequency `player_state` samples are dropped so only newer samples
   * land once the buffer drains (coalesce-by-skip).
   */
  static OUTBOUND_BUFFER_SOFT_LIMIT = 8192;

  /** Send a protocol message (version stamped). No-op when not open. */
  send(msg) {
    if (!this.socket || this._disposed) return false;
    // Under backpressure, skip movement samples rather than queue stale poses.
    if (msg?.type === CLIENT_MSG.PLAYER_STATE) {
      const buffered = Number(this.socket.bufferedAmount) || 0;
      if (buffered > DeathmatchNetworkSystem.OUTBOUND_BUFFER_SOFT_LIMIT) {
        return false;
      }
    }
    try {
      this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }));
      return true;
    } catch {
      return false;
    }
  }

  /** Toggle lobby ready state; re-asserted automatically across reconnects. */
  sendReady(ready) {
    this._localReady = !!ready;
    return this.send({ type: CLIENT_MSG.READY, ready: !!ready });
  }

  _startPing() {
    if (this._pingTimer || typeof setInterval !== 'function') return;
    this._pingTimer = setInterval(() => {
      this.send({ type: CLIENT_MSG.PING, nonce: (this._pingNonce += 1), clientTime: this._now() });
    }, 2000);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  /** Best-effort leave to menu: does not wait for the network. */
  leaveAndDispose() {
    this.send({ type: CLIENT_MSG.READY, ready: false });
    this.dispose();
  }

  close() {
    this._stopPing();
    if (this.socket) {
      try {
        this.socket.close();
      } catch { /* ignore */ }
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._stopPing();
    if (this.socket) {
      try {
        this.socket.removeEventListener?.('open', this._onOpen);
        this.socket.removeEventListener?.('message', this._onMessage);
        this.socket.removeEventListener?.('close', this._onClose);
        this.socket.removeEventListener?.('error', this._onError);
        this.socket.close();
      } catch { /* ignore */ }
    }
    this.socket = null;
    this._listeners.clear();
  }

  // ── Observation ─────────────────────────────────────────────────────────────

  /** True once the server has welcomed us — the network half of the barrier. */
  isNetworkReady() {
    return this._welcomed;
  }

  /**
   * Estimated current server time using the refined clock offset (pong RTT).
   * Falls back to the last stamped serverTime when no offset is available.
   */
  estimateServerTime(nowMs = this._now()) {
    if (this.clockOffsetMs !== 0) return nowMs + this.clockOffsetMs;
    return this.serverTime || nowMs;
  }

  /** Authoritative self entry from the latest snapshot, or null. */
  getLocalPlayer() {
    if (!this.playerId) return null;
    return this.players.find((p) => p.playerId === this.playerId) ?? null;
  }

  /**
   * Drain unread server events since the last call. Bounded by the ring.
   * Used by the runtime feature for teleport / join / leave application.
   * @returns {object[]}
   */
  drainEvents() {
    if (this._eventCursor > this.recentEvents.length) {
      this._eventCursor = this.recentEvents.length;
    }
    if (this._eventCursor === this.recentEvents.length) return [];
    const out = this.recentEvents.slice(this._eventCursor);
    this._eventCursor = this.recentEvents.length;
    return out;
  }

  /**
   * Drain unread SHOT_RESULT messages since the last call (M4 combat adapter).
   * @returns {object[]}
   */
  drainShotResults() {
    if (this._shotResultCursor > this._shotResults.length) {
      this._shotResultCursor = this._shotResults.length;
    }
    if (this._shotResultCursor === this._shotResults.length) return [];
    const out = this._shotResults.slice(this._shotResultCursor);
    this._shotResultCursor = this._shotResults.length;
    return out;
  }

  /**
   * Discard unread SHOT_RESULTs without applying them (M4 life transition).
   * Call on local DEATH/RESPAWN so previous-life results cannot clobber new-life ammo
   * after the combat adapter resets its shotSeq watermark.
   * @returns {number} number of results discarded
   */
  discardPendingShotResults() {
    if (this._shotResultCursor > this._shotResults.length) {
      this._shotResultCursor = this._shotResults.length;
    }
    const n = this._shotResults.length - this._shotResultCursor;
    this._shotResultCursor = this._shotResults.length;
    return n;
  }

  /** Immutable-ish view for UI. */
  getSnapshot() {
    return {
      status: this.status,
      playerId: this.playerId,
      roomId: this.roomId,
      mapId: this.mapId,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      roundId: this.roundId,
      serverTime: this.serverTime,
      clockOffsetMs: this.clockOffsetMs,
      capacity: this.capacity,
      fragLimit: this.fragLimit,
      players: this.players,
      pickups: this.pickups,
      localReady: this._localReady,
      error: this.lastError,
      snapshotGeneration: this.snapshotGeneration,
      lastSnapshotTick: this.lastSnapshotTick,
    };
  }

  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _setStatus(status) {
    this.status = status;
    this._emit();
  }

  _emit() {
    const snap = this.getSnapshot();
    for (const cb of this._listeners) {
      try {
        cb(snap);
      } catch { /* listener errors never break the socket */ }
    }
  }
}
