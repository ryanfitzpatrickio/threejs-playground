/**
 * PartyKit server adapter for deathmatch (M2).
 *
 * Thin transport shim over the PartyKit-free `MatchRoom` orchestrator. PartyKit
 * instantiates one instance of this class per room (`new DeathmatchServer(room)`)
 * and calls `onStart/onConnect/onMessage/onClose`. This adapter:
 *
 *   - reads identity/resume params from the connection query string,
 *   - forwards raw frames to `MatchRoom` (which owns all validation + rules),
 *   - drives a fixed 20 Hz tick while any connection is present, and
 *   - drains `MatchRoom`'s outbound buffer to `conn.send` / `room.broadcast`.
 *
 * All game logic lives in `party/deathmatch/*`; this file has no rules of its
 * own so it stays trivially correct and node-testable with a fake room (see
 * `scripts/verify-deathmatch-server.mjs`). Time is `Date.now()`; the client
 * derives its clock offset from `welcome.serverTime` and pong round-trips.
 */

import { MatchRoom } from './deathmatch/MatchRoom.js';
import { ROOM_CONFIG } from '../src/game/config/deathmatch/deathmatchRules.js';

const TICK_MS = Math.max(1, Math.round(1000 / ROOM_CONFIG.tickHz));

/** Pull identity/resume fields out of a connection request URL. */
function readHandshake(ctx) {
  try {
    const url = new URL(ctx?.request?.url ?? 'http://local/');
    const q = url.searchParams;
    return {
      displayName: q.get('name') ?? undefined,
      playerId: q.get('pid') ?? undefined,
      resumeToken: q.get('token') ?? undefined,
    };
  } catch {
    return {};
  }
}

export default class DeathmatchServer {
  /** @param {any} room PartyKit Party (or a compatible fake in tests). */
  constructor(room) {
    this.room = room;
    // Solo start is allowed in dev; production hosts should require 2 players.
    const allowSoloStart = readAllowSolo(room);
    this.match = new MatchRoom({ roomId: room?.id ?? 'room', allowSoloStart });
    this._timer = null;
  }

  // ── Tick scheduling ─────────────────────────────────────────────────────────

  _ensureTicking() {
    if (this._timer != null) return;
    this._timer = setInterval(() => {
      try {
        this._tick();
      } catch (err) {
        console.error('[deathmatch] tick error', err);
      }
    }, TICK_MS);
  }

  _stopTickingIfEmpty() {
    if (this._timer == null) return;
    if (this.match.connections.size > 0) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /** One server tick: advance the match then flush outbound. Exposed for tests. */
  _tick(now = Date.now()) {
    this.match.tick(now);
    this._flush();
  }

  /** Drain MatchRoom's outbound buffer onto the transport. */
  _flush() {
    for (const { to, msg } of this.match.drainOutbound()) {
      const frame = JSON.stringify(msg);
      if (to === '*') {
        this.room.broadcast(frame);
      } else {
        const conn = this.room.getConnection?.(to);
        conn?.send(frame);
      }
    }
  }

  // ── PartyKit lifecycle ──────────────────────────────────────────────────────

  onStart() {
    // Nothing persisted yet; state is in-memory per live room.
  }

  onConnect(conn, ctx) {
    const now = Date.now();
    const result = this.match.connect(conn.id, readHandshake(ctx), now);
    this._flush();
    if (result?.error) {
      // Capacity/other rejection: the error frame is already flushed; close.
      conn.close(4000, result.error);
      return;
    }
    this._ensureTicking();
  }

  onMessage(message, sender) {
    this.match.message(sender.id, message, Date.now());
    this._flush();
  }

  onClose(conn) {
    this.match.disconnect(conn.id, Date.now());
    this._flush();
    this._stopTickingIfEmpty();
  }

  onError(conn) {
    // Treat a socket error like a disconnect; resume window covers reconnects.
    this.match.disconnect(conn.id, Date.now());
    this._flush();
    this._stopTickingIfEmpty();
  }
}

/** Dev hosts allow a solo round; PARTYKIT_SOLO=0 forces the 2-player minimum. */
function readAllowSolo(room) {
  const env = room?.env ?? {};
  if (env.PARTYKIT_SOLO === '0' || env.PARTYKIT_SOLO === 'false') return false;
  // Default: allow solo so a single dev browser can drive the arena.
  return true;
}
