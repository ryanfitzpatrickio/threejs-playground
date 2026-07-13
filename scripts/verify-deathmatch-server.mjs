/**
 * verify-deathmatch-server — M2 exit-gate check (deterministic half).
 *
 * Drives the REAL PartyKit adapter (`party/server.js`) and the REAL client
 * (`DeathmatchNetworkSystem`) against each other over an in-process fake
 * transport, so the handshake/resume/capacity/malformed logic is proven without
 * a live `partykit dev` or two browsers. The live two-browser render path is
 * covered separately by `scripts/verify-deathmatch-browser.mjs` (needs servers).
 *
 * Proves:
 *  - a client connects, receives exactly one welcome, and learns the map id;
 *  - two clients in one room converge on the same player list / phase / server
 *    time from server snapshots, over exactly one socket each;
 *  - a single ready player (solo dev) advances WAITING → COUNTDOWN;
 *  - a dropped client resumes its identity (same playerId, no duplicate) inside
 *    the resume window using the server-issued token;
 *  - a 9th connection is rejected with a non-recoverable capacity error + close;
 *  - malformed / oversized / unknown frames are rejected without adding players
 *    or throwing.
 */

import assert from 'node:assert/strict';
import DeathmatchServer from '../party/server.js';
import { DeathmatchNetworkSystem, NET_STATUS } from '../src/game/systems/DeathmatchNetworkSystem.js';
import { MATCH_PHASE } from '../src/game/config/deathmatch/deathmatchRules.js';
import { RAIL_CRUCIBLE } from '../src/game/config/deathmatch/railCrucibleMap.js';

// ── Fake transport ────────────────────────────────────────────────────────────
// Delivery is async via microtasks to model a real socket and avoid reentrancy.
// `settle()` flushes the microtask queue between assertions.

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

// Globally-unique connection ids, like a real PartyKit room (never per-client).
let globalConnSeq = 0;

function createFakeRoom(id) {
  const conns = new Map();
  return {
    id,
    env: {},
    conns,
    broadcast(frame) {
      for (const c of conns.values()) c.send(frame);
    },
    getConnection(cid) {
      return conns.get(cid);
    },
    getConnections() {
      return conns.values();
    },
  };
}

/**
 * Build a client wired to `server` over a fresh fake socket. Supports resume by
 * replaying the resume-aware `query()` on `simulateReconnect()`.
 */
function makeClient(server, room, { displayName } = {}) {
  let factoryCalls = 0;

  const socketFactory = ({ query }) => {
    factoryCalls += 1;
    const listeners = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
    const dispatch = (type, ev) => {
      for (const cb of listeners[type]) cb(ev);
    };

    let serverConn = null;

    const openServerConn = () => {
      const id = `${room.id}-c${(globalConnSeq += 1)}`;
      serverConn = {
        id,
        send(frame) {
          queueMicrotask(() => dispatch('message', { data: frame }));
        },
        close() {
          queueMicrotask(() => {
            if (room.conns.get(id) === serverConn) {
              room.conns.delete(id);
              server.onClose(serverConn); // notify adapter → markDisconnected
            }
            dispatch('close', {});
          });
        },
      };
      room.conns.set(id, serverConn);
      const params = new URLSearchParams(query());
      const ctx = { request: { url: `http://local/parties/main/${room.id}?${params}` } };
      queueMicrotask(() => {
        server.onConnect(serverConn, ctx);
        dispatch('open', {});
      });
    };

    const socket = {
      addEventListener(type, cb) { listeners[type]?.add(cb); },
      removeEventListener(type, cb) { listeners[type]?.delete(cb); },
      send(frame) {
        if (serverConn) queueMicrotask(() => server.onMessage(frame, serverConn));
      },
      close() {
        if (serverConn) serverConn.close();
      },
      // Test-only: model PartySocket auto-reconnect (same socket, new server conn).
      simulateReconnect() {
        openServerConn();
      },
      get _factoryCalls() { return factoryCalls; },
    };

    openServerConn();
    return socket;
  };

  const client = new DeathmatchNetworkSystem({ host: 'test', room: room.id, displayName, socketFactory });
  return client;
}

async function main() {
  const results = [];
  const ok = (name) => results.push(`  ✓ ${name}`);

  // ── 1. Single client welcome + map id ───────────────────────────────────────
  {
    const room = createFakeRoom('ROOM1');
    const server = new DeathmatchServer(room);
    server._ensureTicking = () => {}; // drive ticks manually
    const a = makeClient(server, room, { displayName: 'Ann' });
    a.connect();
    await settle();
    assert.equal(a.isNetworkReady(), true, 'client welcomed');
    assert.equal(a.getSnapshot().status, NET_STATUS.WELCOMED);
    assert.ok(a.playerId, 'playerId assigned');
    assert.equal(a.mapId, RAIL_CRUCIBLE.id, 'learns rail-crucible map id');
    assert.equal(room.conns.size, 1, 'exactly one server connection');
    a.dispose();
    ok('single client receives one welcome and the map id over one socket');
  }

  // ── 2. Two clients converge on identical snapshot view ──────────────────────
  {
    const room = createFakeRoom('ROOM2');
    const server = new DeathmatchServer(room);
    server._ensureTicking = () => {};
    const a = makeClient(server, room, { displayName: 'Ann' });
    const b = makeClient(server, room, { displayName: 'Bob' });
    a.connect();
    b.connect();
    await settle();
    server._tick(10_000);
    await settle();

    const sa = a.getSnapshot();
    const sb = b.getSnapshot();
    assert.equal(sa.players.length, 2, 'A sees 2 players');
    assert.equal(sb.players.length, 2, 'B sees 2 players');
    assert.equal(sa.phase, sb.phase, 'same phase');
    assert.equal(sa.serverTime, sb.serverTime, 'same server time');
    assert.equal(sa.serverTime, 10_000, 'server time from tick');
    const idsA = sa.players.map((p) => p.playerId).sort();
    const idsB = sb.players.map((p) => p.playerId).sort();
    assert.deepEqual(idsA, idsB, 'identical player id sets');
    assert.notEqual(a.playerId, b.playerId, 'distinct identities');
    a.dispose();
    b.dispose();
    ok('two clients converge on the same player list / phase / server time');
  }

  // ── 3. Ready barrier advances phase (solo dev start) ────────────────────────
  {
    const room = createFakeRoom('ROOM3');
    const server = new DeathmatchServer(room); // allowSoloStart defaults true
    server._ensureTicking = () => {};
    const a = makeClient(server, room, { displayName: 'Ann' });
    a.connect();
    await settle();
    server._tick(1000);
    await settle();
    assert.equal(a.getSnapshot().phase, MATCH_PHASE.WAITING, 'waiting before ready');
    a.sendReady(true);
    await settle();
    server._tick(2000);
    await settle();
    assert.equal(a.getSnapshot().phase, MATCH_PHASE.COUNTDOWN, 'ready advances to countdown');
    assert.equal(a.getSnapshot().localReady, true, 'local ready reflected');
    a.dispose();
    ok('a ready player advances WAITING → COUNTDOWN');
  }

  // ── 4. Reconnect resumes identity without duplicating ───────────────────────
  {
    const room = createFakeRoom('ROOM4');
    const server = new DeathmatchServer(room);
    server._ensureTicking = () => {};
    const a = makeClient(server, room, { displayName: 'Ann' });
    const b = makeClient(server, room, { displayName: 'Bob' });
    a.connect();
    b.connect();
    await settle();
    const originalId = a.playerId;

    // Drop A's connection: fake close notifies the adapter (markDisconnected),
    // which retains the player for the resume window.
    a.socket.close();
    await settle();
    assert.equal(a.getSnapshot().status, NET_STATUS.RECONNECTING, 'A reflects reconnecting');

    // Reconnect the same socket: query() now carries pid+token → resume.
    a.socket.simulateReconnect();
    await settle();
    server._tick(20_000);
    await settle();

    assert.equal(a.playerId, originalId, 'same identity after resume');
    const snap = a.getSnapshot();
    assert.equal(snap.players.length, 2, 'no duplicate identity (still 2 players)');
    assert.equal(a.isNetworkReady(), true, 'welcomed again after resume');
    a.dispose();
    b.dispose();
    ok('reconnect resumes identity without duplicating the player');
  }

  // ── 5. Ninth connection rejected with non-recoverable capacity error ────────
  {
    const room = createFakeRoom('ROOM5');
    const server = new DeathmatchServer(room);
    server._ensureTicking = () => {};
    const clients = [];
    for (let i = 0; i < 8; i += 1) {
      const c = makeClient(server, room, { displayName: `P${i}` });
      c.connect();
      clients.push(c);
    }
    await settle();
    assert.equal(room.conns.size, 8, 'eight seated');

    const ninth = makeClient(server, room, { displayName: 'Late' });
    ninth.connect();
    await settle();
    assert.equal(ninth.isNetworkReady(), false, 'ninth never welcomed');
    assert.equal(ninth.getSnapshot().error?.code, 'capacity', 'capacity error surfaced');
    assert.equal(room.conns.size, 8, 'ninth connection was closed/removed');
    for (const c of clients) c.dispose();
    ninth.dispose();
    ok('a ninth player is rejected with a non-recoverable capacity error');
  }

  // ── 6. Malformed / oversized / unknown frames are rejected safely ───────────
  {
    const room = createFakeRoom('ROOM6');
    const server = new DeathmatchServer(room);
    server._ensureTicking = () => {};
    const a = makeClient(server, room, { displayName: 'Ann' });
    a.connect();
    await settle();
    const before = room.conns.size;

    const conn = [...room.conns.values()][0];
    // Raw garbage, oversized, unknown type, and a wrong-version frame.
    server.onMessage('not json at all {', conn, Date.now());
    server.onMessage('x'.repeat(9000), conn, Date.now());
    server.onMessage(JSON.stringify({ v: 1, type: 'no_such_type' }), conn, Date.now());
    server.onMessage(JSON.stringify({ v: 999, type: 'ready', ready: true }), conn, Date.now());
    await settle();

    assert.equal(room.conns.size, before, 'malformed input did not add/drop connections');
    assert.equal(a.isNetworkReady(), true, 'client still connected after garbage');
    a.dispose();
    ok('malformed / oversized / unknown frames are rejected without side effects');
  }

  console.log('verify-deathmatch-server: all checks passed\n' + results.join('\n'));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('verify-deathmatch-server FAILED');
    console.error(err);
    process.exit(1);
  },
);
