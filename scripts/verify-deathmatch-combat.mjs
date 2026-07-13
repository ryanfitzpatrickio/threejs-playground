/**
 * verify-deathmatch-combat — M4 exit-gate check (node, no browser).
 *
 * Exercises MatchRoom + DeathmatchNetworkSystem clients over an in-process
 * fake transport (same pattern as verify-deathmatch-server / movement):
 *
 *  1. Accepted fire reduces victim health and returns SHOT_RESULT to shooter
 *  2. Rapid fire / bad origin rejected without state change
 *  3. Stale clientTime rejected
 *  4. Duplicate / non-monotonic shotSeq rejected
 *  5. Client cannot send a damage packet (no damage client message type)
 *  6. Frag attribution: one death, one frag, matching scores on both clients
 *  7. Respawn restores alive + health after delay
 *  8. Spawn protection blocks damage until window ends
 *  9. Combat adapter applies SHOT_RESULT + DEATH/RESPAWN presentation state
 * 10. Offline deathmatch (no network) does not intercept WeaponSystem
 * 11. Clock-offset rewind hits a history sample (not just current pose)
 *
 * Run: node scripts/verify-deathmatch-combat.mjs
 * Alias: npm run verify:deathmatch-combat
 */

import assert from 'node:assert/strict';
import { MatchRoom } from '../party/deathmatch/MatchRoom.js';
import { resolveFire, resolveShotTime } from '../party/deathmatch/combat.js';
import {
  ROOM_CONFIG,
  MATCH_PHASE,
  PLAYER_CAPSULE,
  WEAPON_BALANCE,
  WEAPON_IDS,
  HEALTH,
} from '../src/game/config/deathmatch/deathmatchRules.js';
import {
  PROTOCOL_VERSION,
  CLIENT_MSG,
  EVENT_KIND,
  validateClientMessage,
  ERROR_CODE,
} from '../src/game/net/deathmatchProtocol.js';
import { GUN_CATALOG } from '../src/game/weapons/gunProfile.js';
import { DeathmatchNetworkSystem } from '../src/game/systems/DeathmatchNetworkSystem.js';
import {
  buildFireMessage,
  buildReloadMessage,
  applyShotResult,
  loadoutFromRespawn,
  estimateCombatClientTime,
} from '../src/game/net/deathmatchCombatReplication.js';
import { DeathmatchRuntimeFeature } from '../src/game/runtime/features/deathmatch/DeathmatchRuntimeFeature.js';
import { DeathmatchCombatAdapter } from '../src/game/runtime/features/deathmatch/DeathmatchCombatAdapter.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

const V = PROTOCOL_VERSION;

const TEST_CONFIG = Object.freeze({
  ...ROOM_CONFIG,
  fragLimit: 20,
  countdownMs: 50,
  respawnDelayMs: 80,
  spawnProtectionMs: 40,
  intermissionMs: 100,
  matchDurationMs: 5_000_000,
  historyWindowMs: 500,
});

/** In-process MatchRoom ↔ DeathmatchNetworkSystem harness (no PartyKit/browser). */
function createCombatHarness({ seed = 0xC0FFEE } = {}) {
  let now = 10_000;
  const nowFn = () => now;
  const room = new MatchRoom({
    roomId: 'combat-test',
    seed,
    config: TEST_CONFIG,
    allowSoloStart: false,
  });

  /** @type {Map<string, DeathmatchNetworkSystem>} */
  const byConn = new Map();

  function flush() {
    const out = room.drainOutbound();
    for (const item of out) {
      const deliver = (client, msg) => {
        const frame = JSON.stringify(msg);
        // Direct ingest avoids needing open listeners for every flush.
        client._ingest?.(msg) ?? client.socket?.dispatch?.('message', { data: frame });
        // Prefer private ingest when available (always is on DeathmatchNetworkSystem).
        if (typeof client._ingest === 'function') {
          // already called above if we used optional chain wrong — call once:
        }
      };
      // Always use _ingest for determinism.
      if (item.to === '*') {
        for (const c of byConn.values()) c._ingest(item.msg);
      } else {
        const c = byConn.get(item.to);
        if (c) c._ingest(item.msg);
      }
    }
    return out;
  }

  function makeClient(displayName) {
    const connId = `conn-${displayName}`;
    const listeners = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
    const socket = {
      bufferedAmount: 0,
      addEventListener(type, cb) { listeners[type]?.add(cb); },
      removeEventListener(type, cb) { listeners[type]?.delete(cb); },
      send(frame) {
        const raw = typeof frame === 'string' ? frame : JSON.stringify(frame);
        room.message(connId, JSON.parse(raw), now);
        flush();
      },
      close() {
        room.disconnect(connId, now);
        flush();
        for (const cb of listeners.close) cb({});
      },
    };

    const client = new DeathmatchNetworkSystem({
      host: 'test',
      room: 'combat-test',
      displayName,
      now: nowFn,
      socketFactory: () => socket,
    });

    // Open: connect room then fire open so client starts ping etc.
    room.connect(connId, { displayName }, now);
    byConn.set(connId, client);
    client.socket = socket;
    client._bind(socket);
    // Manually run welcome path via flush before open.
    flush();
    // Simulate open after welcome is already ingested... welcome needs _onOpen?
    // Welcome is ingested via _ingest from flush. Status needs WELCOMED from _onWelcome.
    // flush already called _ingest which handles WELCOME. Good.
    // Ensure connect() path is not double-used: we set socket manually.
    client._welcomed = true;
    client.status = 'welcomed';
    // Re-read playerId from welcome if missing.
    if (!client.playerId) {
      // Welcome should have set it.
    }
    return { client, connId };
  }

  return {
    room,
    nowFn,
    get now() { return now; },
    setNow(t) { now = t; },
    advance(ms) { now += ms; },
    flush,
    makeClient,
    byConn,
  };
}

const head = (pos) => [pos[0], pos[1] + PLAYER_CAPSULE.headHeight, pos[2]];

// ═══════════════════════════════════════════════════════════════════════════
// Pure unit: resolveShotTime / message builders / loadout
// ═══════════════════════════════════════════════════════════════════════════

{
  const now = 50_000;
  assert.equal(resolveShotTime(now - 100, now), now - 100);
  assert.equal(resolveShotTime(now + 10, now), now); // clamp future to now
  assert.equal(resolveShotTime(now - 10_000, now), null); // outside skew
  assert.equal(resolveShotTime(NaN, now), null);

  const fire = buildFireMessage({
    shotSeq: 3,
    clientTime: now,
    weaponId: 'midnight-glock',
    origin: [1, 2, 3],
    direction: [0, 0, 1],
  });
  assert.equal(fire.type, CLIENT_MSG.FIRE);
  assert.equal(fire.shotSeq, 3);
  const v = validateClientMessage({ v: V, ...fire });
  assert.equal(v.ok, true);

  const reload = buildReloadMessage({ actionSeq: 1, weaponId: 'midnight-glock' });
  assert.equal(validateClientMessage({ v: V, ...reload }).ok, true);

  // No client "damage" message type exists.
  const dmg = validateClientMessage({
    v: V,
    type: 'damage',
    victimId: 'p2',
    amount: 999,
  });
  assert.equal(dmg.ok, false);
  assert.equal(dmg.code, ERROR_CODE.UNKNOWN_TYPE);

  const loadout = loadoutFromRespawn({
    playerId: 'p1',
    health: 100,
    lifeSeq: 2,
    currentWeapon: 'midnight-glock',
    weapons: { 'midnight-glock': { ammo: 15, reserve: 45 } },
    position: [1, 0, 2],
    yaw: 0.5,
    spawnProtectedUntil: now + 1000,
  });
  assert.equal(loadout.health, 100);
  assert.equal(loadout.weapons['midnight-glock'].ammo, 15);
  assert.equal(loadout.weapons['midnight-glock'].reserve, 45);

  // Server-stamped ammo preferred over inventing starting inventory.
  const stamped = loadoutFromRespawn({
    currentWeapon: 'midnight-glock',
    weapons: { 'midnight-glock': { ammo: 7, reserve: 20 } },
    health: 100,
    lifeSeq: 3,
  });
  assert.equal(stamped.weapons['midnight-glock'].ammo, 7);

  const applied = applyShotResult({ accepted: true, hitPlayerId: 'p2', authoritativeAmmo: 12, damage: 18, hitKind: 'body', shotSeq: 1 });
  assert.equal(applied.accepted, true);
  assert.equal(applied.hit, true);
  assert.equal(applied.ammo, 12);

  ok('pure helpers: shot time clamp, fire/reload builders, no damage type, loadout, shot result');
}

// ═══════════════════════════════════════════════════════════════════════════
// MatchRoom two-player combat through the network client
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = createCombatHarness();
  const { client: a } = h.makeClient('Ada');
  const { client: b } = h.makeClient('Boris');
  // Idle snapshot converges player lists after both have joined.
  h.room.tick(h.now);
  h.flush();

  assert.ok(a.playerId, 'A welcomed');
  assert.ok(b.playerId, 'B welcomed');
  assert.equal(a.players.length, 2);
  assert.equal(b.players.length, 2);

  // Ready → countdown → running.
  a.sendReady(true);
  b.sendReady(true);
  h.room.tick(h.now);
  h.flush();
  assert.equal(h.room.state.phase, MATCH_PHASE.COUNTDOWN);

  h.advance(TEST_CONFIG.countdownMs + 1);
  h.room.tick(h.now);
  h.flush();
  assert.equal(h.room.state.phase, MATCH_PHASE.RUNNING);
  assert.equal(a.phase, MATCH_PHASE.RUNNING);
  assert.equal(b.phase, MATCH_PHASE.RUNNING);

  const pA = h.room.state.players.get(a.playerId);
  const pB = h.room.state.players.get(b.playerId);
  assert.equal(pA.alive && pB.alive, true);

  // Stage clear sightline, clear protection, full ammo.
  pA.position = [20, 0, -10];
  pB.position = [20, 0, 10];
  pA.spawnProtectedUntil = 0;
  pB.spawnProtectedUntil = 0;
  pA.weapons['midnight-glock'].ammo = 15;
  pA.fire.nextFireAt = 0;
  pA.fire.lastShotSeq = -1;
  pB.history = [];

  // ── Bad origin rejected ──
  a.send(buildFireMessage({
    shotSeq: 1,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: [0, 0, 0],
    direction: [0, 0, 1],
  }));
  let results = a.drainShotResults();
  assert.equal(results.length, 1);
  assert.equal(results[0].accepted, false);
  assert.equal(results[0].reason, 'origin_offset');
  assert.equal(pA.weapons['midnight-glock'].ammo, 15, 'rejected origin consumes no ammo');
  assert.equal(pB.health, HEALTH.spawn);

  // ── Accepted body shot ──
  a.send(buildFireMessage({
    shotSeq: 2,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results.length, 1);
  assert.equal(results[0].accepted, true);
  assert.equal(results[0].hitPlayerId, b.playerId);
  assert.equal(pA.weapons['midnight-glock'].ammo, 14);
  assert.equal(pB.health, HEALTH.spawn - WEAPON_BALANCE['midnight-glock'].damage);

  // B should have seen a damage event.
  const dmgEvents = b.recentEvents.filter((e) => e.kind === EVENT_KIND.DAMAGE);
  assert.ok(dmgEvents.length >= 1, 'B receives damage event');
  assert.equal(dmgEvents[dmgEvents.length - 1].payload.victimId, b.playerId);

  // ── Rapid fire rejected ──
  a.send(buildFireMessage({
    shotSeq: 3,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results[0].accepted, false);
  assert.equal(results[0].reason, 'cadence');
  assert.equal(pA.weapons['midnight-glock'].ammo, 14, 'cadence reject keeps ammo');

  // ── Stale clientTime rejected ──
  h.advance(WEAPON_BALANCE['midnight-glock'].fireIntervalMs + 1);
  pA.fire.nextFireAt = 0;
  const ammoBeforeStale = pA.weapons['midnight-glock'].ammo;
  a.send(buildFireMessage({
    shotSeq: 4,
    clientTime: h.now - MOVEMENT_SKEW_TOO_LARGE(),
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results[0].accepted, false);
  assert.equal(results[0].reason, 'stale_time');
  assert.equal(pA.weapons['midnight-glock'].ammo, ammoBeforeStale, 'stale_time consumes no ammo');

  // ── Duplicate shotSeq rejected ──
  pA.fire.nextFireAt = 0;
  pA.fire.lastShotSeq = 10;
  const ammoBeforeSeq = pA.weapons['midnight-glock'].ammo;
  a.send(buildFireMessage({
    shotSeq: 10,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results[0].accepted, false);
  assert.equal(results[0].reason, 'shot_seq');
  assert.equal(pA.weapons['midnight-glock'].ammo, ammoBeforeSeq, 'shot_seq reject consumes no ammo');

  ok('accepted/rejected shots: origin, cadence, stale_time, shot_seq; damage event delivered');

  // ── Frag attribution ──
  pB.health = WEAPON_BALANCE['midnight-glock'].damage; // lethal body shot
  pB.alive = true;
  pA.fire.nextFireAt = 0;
  pA.fire.lastShotSeq = 20;
  a.drainShotResults();
  a.drainEvents();
  b.drainEvents();

  a.send(buildFireMessage({
    shotSeq: 21,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results[0].accepted, true);
  assert.equal(pB.alive, false);
  assert.equal(pA.frags, 1);
  assert.equal(pB.deaths, 1);

  // Both clients see the death event and matching scores via snapshots.
  h.room.tick(h.now);
  h.flush();
  const deathA = a.recentEvents.filter((e) => e.kind === EVENT_KIND.DEATH);
  const deathB = b.recentEvents.filter((e) => e.kind === EVENT_KIND.DEATH);
  assert.ok(deathA.length >= 1 && deathB.length >= 1, 'both clients see death');
  assert.equal(deathA[deathA.length - 1].payload.attackerId, a.playerId);
  assert.equal(deathA[deathA.length - 1].payload.victimId, b.playerId);

  const snapA = a.players.find((p) => p.playerId === a.playerId);
  const snapBVictim = a.players.find((p) => p.playerId === b.playerId);
  const snapBSelf = b.players.find((p) => p.playerId === b.playerId);
  assert.equal(snapA.frags, 1);
  assert.equal(snapBVictim.deaths, 1);
  assert.equal(snapBSelf.alive, false);
  assert.equal(snapBSelf.deaths, 1);

  ok('frag attribution: one death/frag, matching scores on both clients');

  // ── Respawn restores health/alive ──
  const lifeBefore = pB.lifeSeq;
  h.advance(TEST_CONFIG.respawnDelayMs + 1);
  h.room.tick(h.now);
  h.flush();
  assert.equal(pB.alive, true);
  assert.equal(pB.health, HEALTH.spawn);
  assert.equal(pB.lifeSeq, lifeBefore + 1);
  const respawnEvents = b.recentEvents.filter((e) => e.kind === EVENT_KIND.RESPAWN);
  assert.ok(respawnEvents.some((e) => e.payload.playerId === b.playerId));
  const bAfter = b.players.find((p) => p.playerId === b.playerId);
  assert.equal(bAfter.alive, true);
  assert.equal(bAfter.health, HEALTH.spawn);

  ok('respawn restores alive + full health + lifeSeq on server and clients');

  // ── Spawn protection blocks damage ──
  pB.position = [20, 0, 10];
  pA.position = [20, 0, -10];
  pA.spawnProtectedUntil = 0;
  pB.spawnProtectedUntil = h.now + 10_000; // long protection
  pB.health = 100;
  pA.fire.nextFireAt = 0;
  pA.fire.lastShotSeq = 30;
  a.send(buildFireMessage({
    shotSeq: 31,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results[0].accepted, true, 'shot accepted for ammo');
  assert.equal(results[0].hitPlayerId, null, 'protected target not hit');
  assert.equal(pB.health, 100, 'protected player takes no damage');
  assert.equal(pB.alive, true);

  ok('spawn protection: accepted shot deals no damage to protected target');

  // ── Dead cannot fire (server) ──
  pB.alive = false;
  pB.health = 0;
  pA.fire.nextFireAt = 0;
  pA.fire.lastShotSeq = 40;
  // Actually fire AS B who is dead
  b.send(buildFireMessage({
    shotSeq: 1,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pB.position),
    direction: [0, 0, -1],
  }));
  const deadResults = b.drainShotResults();
  assert.equal(deadResults.length, 1);
  assert.equal(deadResults[0].accepted, false);
  assert.equal(deadResults[0].reason, 'dead');
  ok('dead player fire rejected with reason dead');

  // ── Spawn protect expiry → damage resumes (time-advance, not force-clear) ──
  pB.alive = true;
  pB.connected = true;
  pB.health = 100;
  pB.position = [20, 0, 10];
  pB.history = [];
  const protectUntil = h.now + 200;
  pB.spawnProtectedUntil = protectUntil;
  pA.alive = true;
  pA.position = [20, 0, -10];
  pA.spawnProtectedUntil = 0;
  pA.currentWeapon = 'midnight-glock';
  pA.fire.nextFireAt = 0;
  pA.fire.lastShotSeq = 50;
  pA.weapons['midnight-glock'].ammo = 15;
  pA.reload = { active: false, weaponId: null, endsAt: 0 };
  // Still protected → no damage.
  a.send(buildFireMessage({
    shotSeq: 51,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results[0].accepted, true);
  assert.equal(results[0].hitPlayerId, null, 'still protected before expiry');
  assert.equal(pB.health, 100);
  // Advance past protection window.
  h.setNow(protectUntil + 1);
  pA.fire.nextFireAt = 0;
  pA.weapons['midnight-glock'].ammo = 15;
  a.send(buildFireMessage({
    shotSeq: 52,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results[0].accepted, true, `expected accept got ${results[0]?.reason}`);
  assert.equal(results[0].hitPlayerId, b.playerId, 'damage resumes after protect expiry');
  assert.equal(pB.health, 100 - WEAPON_BALANCE['midnight-glock'].damage);
  ok('spawn protect expiry allows damage again');

  // ── Rejected SHOT_RESULT carries authoritativeAmmo ──
  pA.fire.nextFireAt = h.now + 10_000; // force cadence reject
  a.send(buildFireMessage({
    shotSeq: 53,
    clientTime: h.now,
    weaponId: 'midnight-glock',
    origin: head(pA.position),
    direction: [0, 0, 1],
  }));
  results = a.drainShotResults();
  assert.equal(results[0].accepted, false);
  assert.equal(results[0].reason, 'cadence');
  assert.equal(results[0].authoritativeAmmo, pA.weapons['midnight-glock'].ammo);
  ok('rejected SHOT_RESULT reports authoritativeAmmo');
}

function MOVEMENT_SKEW_TOO_LARGE() {
  return ROOM_CONFIG.historyWindowMs + MOVEMENT_MAX_SKEW() + 1000;
}
function MOVEMENT_MAX_SKEW() {
  // Keep in sync with deathmatchRules MOVEMENT.maxTimestampSkewMs
  return 1500;
}

// ═══════════════════════════════════════════════════════════════════════════
// Combat adapter presentation state (feature harness, no Three scene required)
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = createCombatHarness({ seed: 0xBEEF });
  const { client: a } = h.makeClient('Ada');
  const { client: b } = h.makeClient('Boris');
  h.flush();

  a.sendReady(true);
  b.sendReady(true);
  h.room.tick(h.now);
  h.advance(TEST_CONFIG.countdownMs + 1);
  h.room.tick(h.now);
  h.flush();

  // Minimal host for the feature.
  const character = {
    group: {
      position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      visible: true,
    },
    velocity: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    yaw: 0,
    health: 100,
    grounded: true,
  };
  const makeWeaponMock = () => ({
    setCombatInterceptor(fn) { this._ci = fn; },
    setReloadInterceptor(fn) { this._ri = fn; },
    setCombatFireGate(fn) { this._gate = fn; },
    _ci: null,
    _ri: null,
    _gate: null,
  });

  const host = {
    levelMode: 'deathmatch',
    networkSystem: a,
    weaponSystem: makeWeaponMock(),
    firstPersonWeaponSystem: null,
    remotePlayerSystem: {
      setLocalPlayerId() {},
      flashHit() { this.flashed = true; },
      flashed: false,
      ingestPlayers() {},
      update() {},
      attach() {},
      puppets: new Map(),
      snapshot: () => ({ puppetCount: 0 }),
    },
    sceneSystem: { scene: null },
    physicsSystem: { syncCharacterBody() {} },
    cameraSystem: { yaw: 0 },
    characterSystem: { player: character },
  };

  const feature = new DeathmatchRuntimeFeature(host);
  feature.setNetworkSystem(a);
  assert.ok(feature.combat instanceof DeathmatchCombatAdapter);
  assert.equal(typeof host.weaponSystem._ci, 'function', 'interceptor installed when network bound');
  assert.equal(typeof host.weaponSystem._gate, 'function', 'fire gate installed');
  assert.equal(host.weaponSystem._gate(), false, 'alive+running: fire not suppressed');

  // Stage kill.
  const pA = h.room.state.players.get(a.playerId);
  const pB = h.room.state.players.get(b.playerId);
  pA.position = [20, 0, -10];
  pB.position = [20, 0, 10];
  pA.spawnProtectedUntil = 0;
  pB.spawnProtectedUntil = 0;
  pB.health = 18;
  pA.fire.nextFireAt = 0;
  pA.fire.lastShotSeq = -1;
  pB.history = [];

  // Fire via interceptor (as WeaponSystem would).
  const intercepted = host.weaponSystem._ci({
    origin: head(pA.position),
    direction: [0, 0, 1],
    weaponId: 'midnight-glock',
  });
  assert.equal(intercepted, true);
  assert.equal(feature.combat.stats.firesSent, 1);

  // Drain into adapter.
  feature.applyAuthoritative({ character, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(feature.combat.stats.accepted, 1);
  assert.equal(feature.combat.stats.hitsConfirmed, 1);
  assert.ok(feature.combat.lastHitMarker?.hitPlayerId === b.playerId);
  assert.equal(feature.combat.authoritativeAmmo, 14, 'SHOT_RESULT ammo applied');

  // Late/out-of-order SHOT_RESULT with older shotSeq is ignored.
  a._shotResults.push({
    shotSeq: 1, // same as first fire (already applied)
    accepted: true,
    authoritativeAmmo: 0,
    hitPlayerId: null,
    hitKind: null,
    damage: 0,
    reason: null,
  });
  a._shotResultCursor = a._shotResults.length - 1;
  feature.applyAuthoritative({ character, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(feature.combat.authoritativeAmmo, 14, 'stale SHOT_RESULT does not clobber ammo');
  assert.ok(feature.combat.stats.shotResultsIgnored >= 1);

  // Death events for B's feature.
  const hostB = {
    ...host,
    networkSystem: b,
    weaponSystem: makeWeaponMock(),
    remotePlayerSystem: host.remotePlayerSystem,
  };
  const featureB = new DeathmatchRuntimeFeature(hostB);
  featureB.setNetworkSystem(b);
  const charB = {
    group: {
      position: { x: 20, y: 0, z: 10, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      visible: true,
    },
    velocity: { x: 0, y: 0, z: 0, set() {} },
    yaw: 0,
    health: 18,
  };
  featureB.applyAuthoritative({ character: charB, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(featureB.combat.localAlive, false);
  assert.equal(featureB.combat.authoritativeHealth, 0);
  assert.equal(charB.group.visible, false, 'local body hidden on death');
  assert.ok(featureB.combat.stats.deaths >= 1, 'observed at least one death event');
  assert.equal(hostB.weaponSystem._gate(), true, 'dead: fire gate suppresses mag burn');

  // Adapter does not send FIRE while localAlive is false.
  const firesBefore = featureB.combat.stats.firesSent;
  hostB.weaponSystem._ci({
    origin: head([20, 0, 10]),
    direction: [0, 0, -1],
    weaponId: 'midnight-glock',
  });
  assert.equal(featureB.combat.stats.firesSent, firesBefore, 'dead adapter does not send FIRE');

  // Sticky death: inject stale snapshot with alive:true same lifeSeq — must stay dead.
  const lifeAtDeath = featureB.combat.lifeSeq;
  const stalePlayers = b.players.map((p) => (
    p.playerId === b.playerId
      ? { ...p, alive: true, health: 100, lifeSeq: lifeAtDeath }
      : p
  ));
  b.players = stalePlayers;
  // Do not advance snapshotGeneration — same gen as pre-death.
  featureB.applyAuthoritative({ character: charB, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(featureB.combat.localAlive, false, 'sticky death ignores stale alive snapshot');
  assert.equal(featureB.combat.authoritativeHealth, 0);
  assert.equal(charB.group.visible, false);

  // Match-start RESPAWN is also drained on first apply.
  const respawnsAtDeath = featureB.combat.stats.respawns;
  assert.ok(respawnsAtDeath >= 1, 'match-start respawn counted');

  // Respawn B after delay.
  h.advance(TEST_CONFIG.respawnDelayMs + 1);
  h.room.tick(h.now);
  h.flush();
  featureB.applyAuthoritative({ character: charB, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(featureB.combat.localAlive, true);
  assert.equal(featureB.combat.authoritativeHealth, HEALTH.spawn);
  assert.equal(charB.group.visible, true);
  assert.equal(featureB.combat.stats.respawns, respawnsAtDeath + 1, 'post-death respawn increments once');
  assert.ok(featureB.combat.spawnProtectedUntil > 0);
  assert.ok(featureB.combat.authoritativeAmmo != null, 'respawn applies server weapons ammo');
  assert.equal(hostB.weaponSystem._gate(), false, 'respawned: fire gate open');

  // Sticky respawn: inject older life snapshot with alive:false — must stay alive.
  const lifeAfter = featureB.combat.lifeSeq;
  b.players = b.players.map((p) => (
    p.playerId === b.playerId
      ? { ...p, alive: false, health: 0, lifeSeq: lifeAfter - 1 }
      : p
  ));
  featureB.applyAuthoritative({ character: charB, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(featureB.combat.localAlive, true, 'sticky respawn ignores older-life dead snapshot');
  assert.equal(featureB.combat.lifeSeq, lifeAfter);

  // Sticky-alive must not adopt health 0 from a same-life dead-looking snap.
  const healthAfterRespawn = featureB.combat.authoritativeHealth;
  b.players = b.players.map((p) => (
    p.playerId === b.playerId
      ? { ...p, alive: false, health: 0, lifeSeq: lifeAfter }
      : p
  ));
  b.snapshotGeneration = (b.snapshotGeneration || 1) + 5; // gen advanced
  featureB.applyAuthoritative({ character: charB, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(featureB.combat.localAlive, true);
  assert.equal(
    featureB.combat.authoritativeHealth,
    healthAfterRespawn,
    'sticky-alive ignores health<=0 from dead snap',
  );

  // Previous-life SHOT_RESULT queued then RESPAWN must discard — not clobber new ammo.
  // Simulate: A fires (result pending), then we inject a previous-life result after B respawned.
  // Use feature A: queue a late result after simulating life transition discard path.
  feature.combat.authoritativeAmmo = 15;
  feature.combat.shotSeq = 0;
  feature.combat._lastAppliedShotSeq = -1;
  a._shotResults.push({
    shotSeq: 99,
    accepted: true,
    authoritativeAmmo: 1, // would clobber if applied
    hitPlayerId: null,
    hitKind: null,
    damage: 0,
    reason: null,
  });
  // Cursor behind so drain would see it — but discardPending on respawn path:
  a._shotResultCursor = a._shotResults.length - 1;
  const discarded = a.discardPendingShotResults();
  assert.equal(discarded, 1);
  feature.combat._lastAppliedShotSeq = -1;
  feature.combat.shotSeq = 0;
  feature.applyAuthoritative({ character, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(feature.combat.authoritativeAmmo, 15, 'discarded previous-life result does not apply');

  // Full path: wasDead RESPAWN discards pending results before watermark reset.
  feature.combat.localAlive = false;
  feature.combat._deadLifeSeq = feature.combat.lifeSeq;
  feature.combat._aliveLifeSeq = null;
  a._shotResults.push({
    shotSeq: 7,
    accepted: true,
    authoritativeAmmo: 2,
    hitPlayerId: null,
    hitKind: null,
    damage: 0,
    reason: null,
  });
  a._shotResultCursor = a._shotResults.length - 1;
  feature.combat.handleEvent(
    {
      kind: EVENT_KIND.RESPAWN,
      payload: {
        playerId: a.playerId,
        position: [1, 0, 1],
        yaw: 0,
        health: 100,
        lifeSeq: feature.combat.lifeSeq + 1,
        currentWeapon: 'midnight-glock',
        weapons: { 'midnight-glock': { ammo: 15, reserve: 45 } },
        spawnProtectedUntil: h.now + 1000,
      },
    },
    { character, physics: host.physicsSystem, weaponSystem: host.weaponSystem },
  );
  assert.equal(feature.combat.authoritativeAmmo, 15);
  assert.equal(feature.combat._lastAppliedShotSeq, -1);
  // Pending result was discarded — tick must not apply ammo 2.
  feature.applyAuthoritative({ character, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(feature.combat.authoritativeAmmo, 15, 'wasDead RESPAWN discards previous-life SHOT_RESULT queue');

  // Already-alive RESPAWN (late match-start) must NOT discard pending SHOT_RESULTS
  // and must NOT reset shotSeq / _lastAppliedShotSeq watermark.
  feature.combat.localAlive = true;
  feature.combat._deadLifeSeq = null;
  feature.combat._aliveLifeSeq = feature.combat.lifeSeq;
  feature.combat.shotSeq = 5;
  feature.combat._lastAppliedShotSeq = 4;
  feature.combat.authoritativeAmmo = 12;
  a._shotResults.push({
    shotSeq: 5,
    accepted: true,
    authoritativeAmmo: 11,
    hitPlayerId: null,
    hitKind: null,
    damage: 0,
    reason: null,
  });
  a._shotResultCursor = a._shotResults.length - 1;
  const pendingBefore = a._shotResults.length - a._shotResultCursor;
  assert.equal(pendingBefore, 1, 'one pending SHOT_RESULT before alive RESPAWN');
  const lifeBeforeAliveRespawn = feature.combat.lifeSeq;
  feature.combat.handleEvent(
    {
      kind: EVENT_KIND.RESPAWN,
      payload: {
        playerId: a.playerId,
        position: [2, 0, 2],
        yaw: 0.1,
        health: 100,
        // Same or lower life would be odd; use same lifeSeq to model a redundant
        // already-alive event (match-start re-delivery).
        lifeSeq: lifeBeforeAliveRespawn,
        currentWeapon: 'midnight-glock',
        weapons: { 'midnight-glock': { ammo: 15, reserve: 45 } },
        spawnProtectedUntil: h.now + 500,
      },
    },
    { character, physics: host.physicsSystem, weaponSystem: host.weaponSystem },
  );
  assert.equal(feature.combat.localAlive, true);
  assert.equal(feature.combat.shotSeq, 5, 'already-alive RESPAWN must not reset shotSeq');
  assert.equal(feature.combat._lastAppliedShotSeq, 4, 'already-alive RESPAWN must not reset watermark');
  assert.equal(
    a._shotResults.length - a._shotResultCursor,
    1,
    'already-alive RESPAWN must not discard pending SHOT_RESULTS',
  );
  // Tick drains the pending result and applies ammo 11.
  feature.applyAuthoritative({ character, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(feature.combat.authoritativeAmmo, 11, 'pending SHOT_RESULT still applies after already-alive RESPAWN');
  assert.equal(feature.combat._lastAppliedShotSeq, 5);

  // Health sticky: DAMAGE then same/older gen snap with higher health must not raise health.
  feature.combat.authoritativeHealth = 80;
  feature.combat._healthStickyUntilGen = a.snapshotGeneration || 0;
  feature.combat._aliveLifeSeq = feature.combat.lifeSeq;
  feature.combat.localAlive = true;
  a.players = a.players.map((p) => (
    p.playerId === a.playerId
      ? { ...p, alive: true, health: 100, lifeSeq: feature.combat.lifeSeq }
      : p
  ));
  // Same generation as sticky → keep 80.
  feature.combat._syncFromSnapshot(a, character, host.weaponSystem, null);
  assert.equal(feature.combat.authoritativeHealth, 80, 'health sticky holds until gen advances');
  // Advance gen → may take snap health.
  a.snapshotGeneration = (a.snapshotGeneration || 0) + 1;
  feature.combat._syncFromSnapshot(a, character, host.weaponSystem, null);
  assert.equal(feature.combat.authoritativeHealth, 100, 'health updates after gen advances');

  // Dead freezes velocity (sticky death so snapshot cannot revive mid-tick).
  feature.combat.localAlive = false;
  feature.combat._aliveLifeSeq = null;
  feature.combat._deadLifeSeq = feature.combat.lifeSeq;
  character.velocity.set(5, 1, 3);
  character.verticalVelocity = 4;
  feature.combat.tick({ character, physics: host.physicsSystem, weaponSystem: host.weaponSystem, nowMs: h.now });
  assert.equal(character.velocity.x, 0);
  assert.equal(character.verticalVelocity, 0);

  // Snapshot exposes combat without sockets.
  const snap = feature.snapshot();
  assert.equal(snap.mode, 'deathmatch');
  assert.ok(snap.combat);
  assert.equal(typeof snap.combat.health, 'number');

  ok('combat adapter: interceptor, sticky death/respawn, discard previous-life shots, health sticky, freeze');
}

// ═══════════════════════════════════════════════════════════════════════════
// Offline deathmatch: no network → interceptor not installed / no-op
// ═══════════════════════════════════════════════════════════════════════════

{
  const weaponSystem = {
    setCombatInterceptor(fn) { this._ci = fn; },
    setReloadInterceptor(fn) { this._ri = fn; },
    setCombatFireGate(fn) { this._gate = fn; },
    _ci: 'unset',
    _ri: 'unset',
    _gate: 'unset',
  };
  const host = {
    levelMode: 'deathmatch',
    networkSystem: null,
    weaponSystem,
    remotePlayerSystem: null,
    sceneSystem: { scene: null },
  };
  const feature = new DeathmatchRuntimeFeature(host);
  feature.setNetworkSystem(null);
  assert.equal(weaponSystem._ci, null, 'clear interceptor when no network');
  assert.equal(weaponSystem._gate, null, 'clear fire gate when no network');
  // Offline apply is a no-op.
  feature.applyAuthoritative({ character: null, physics: null });
  assert.equal(feature.combat.stats.firesSent, 0);
  ok('offline deathmatch leaves combat adapter idle (no network intercept)');
}

// ═══════════════════════════════════════════════════════════════════════════
// Lag-comp: history rewind hits prior pose; current pose off-ray misses
// ═══════════════════════════════════════════════════════════════════════════

{
  const room = new MatchRoom({
    roomId: 'rewind',
    seed: 1,
    config: TEST_CONFIG,
    allowSoloStart: true,
  });
  let now = 20_000;
  room.connect('c1', { displayName: 'A' }, now);
  room.connect('c2', { displayName: 'B' }, now);
  room.message('c1', { v: V, type: CLIENT_MSG.READY, ready: true }, now);
  room.tick(now);
  now += TEST_CONFIG.countdownMs + 1;
  room.tick(now);
  room.drainOutbound();

  const a = room.state.players.get('p1');
  const b = room.state.players.get('p2');
  // Clear sightline on x=20. Historical B is on the +z ray; current B is
  // laterally offset so a ray along +z at x=20 cannot hit the live capsule.
  a.position = [20, 0, -10];
  a.spawnProtectedUntil = 0;
  a.weapons['midnight-glock'].ammo = 15;
  a.fire = { nextFireAt: 0, lastShotSeq: -1 };
  b.position = [40, 0, 10]; // OFF the +z ray from A (x=20)
  b.spawnProtectedUntil = 0;
  b.health = 50;
  const past = now - 100;
  b.history = [
    { t: past - 50, position: [20, 0, 10] },
    { t: past, position: [20, 0, 10] },
    { t: now, position: [40, 0, 10] },
  ];

  const origin = head(a.position);
  const dir = [0, 0, 1];

  // Past clientTime → rewind hits historical capsule on the ray.
  const pastMsg = {
    shotSeq: 1,
    clientTime: past,
    weaponId: 'midnight-glock',
    origin,
    direction: dir,
  };
  const pastTime = resolveShotTime(pastMsg.clientTime, now);
  assert.equal(pastTime, past);
  const pastHit = resolveFire(room.state, a, pastMsg, now, pastTime);
  assert.equal(pastHit.shotResult.accepted, true);
  assert.equal(pastHit.shotResult.hitPlayerId, 'p2', 'rewind hits historical capsule on ray');

  // Restore ammo/gates and try the same ray at clientTime=now → must miss.
  a.weapons['midnight-glock'].ammo = 15;
  a.fire = { nextFireAt: 0, lastShotSeq: 1 };
  b.health = 50;
  b.alive = true;
  const nowMsg = {
    shotSeq: 2,
    clientTime: now,
    weaponId: 'midnight-glock',
    origin,
    direction: dir,
  };
  const nowHit = resolveFire(room.state, a, nowMsg, now, now);
  assert.equal(nowHit.shotResult.accepted, true, 'shot itself is valid');
  assert.equal(nowHit.shotResult.hitPlayerId, null, 'current off-ray pose is a miss (not false-green)');
  ok('lag-comp: past-time hit + now-time miss with off-ray current pose');
}

// ═══════════════════════════════════════════════════════════════════════════
// reload_complete applies server ammo to combat adapter
// ═══════════════════════════════════════════════════════════════════════════

{
  const h = createCombatHarness({ seed: 0x10ad01 });
  const { client: a } = h.makeClient('Ada');
  const { client: b } = h.makeClient('Boris');
  h.room.tick(h.now);
  h.flush();
  a.sendReady(true);
  b.sendReady(true);
  h.room.tick(h.now);
  h.advance(TEST_CONFIG.countdownMs + 1);
  h.room.tick(h.now);
  h.flush();

  const pA = h.room.state.players.get(a.playerId);
  pA.weapons['midnight-glock'].ammo = 0;
  pA.weapons['midnight-glock'].reserve = 30;
  pA.reload = { active: true, weaponId: 'midnight-glock', endsAt: h.now + 10 };
  h.advance(20);
  h.room.tick(h.now);
  h.flush();

  const host = {
    levelMode: 'deathmatch',
    networkSystem: a,
    weaponSystem: {
      setCombatInterceptor(fn) { this._ci = fn; },
      setReloadInterceptor(fn) { this._ri = fn; },
      setCombatFireGate(fn) { this._gate = fn; },
    },
    remotePlayerSystem: {
      setLocalPlayerId() {}, flashHit() {}, ingestPlayers() {}, update() {}, attach() {},
      puppets: new Map(), snapshot: () => ({ puppetCount: 0 }),
    },
    sceneSystem: { scene: null },
    physicsSystem: { syncCharacterBody() {} },
    cameraSystem: { yaw: 0 },
  };
  const feature = new DeathmatchRuntimeFeature(host);
  feature.setNetworkSystem(a);
  const character = {
    group: { position: { x: 0, y: 0, z: 0, set() {} }, visible: true },
    velocity: { set() {} },
    health: 100,
  };
  feature.applyAuthoritative({ character, physics: host.physicsSystem, nowMs: h.now });
  assert.equal(feature.combat.authoritativeAmmo, WEAPON_BALANCE['midnight-glock'].magazineSize);
  assert.ok(
    a.recentEvents.some((e) => e.kind === 'reload_complete'),
    'reload_complete event observed',
  );
  ok('reload_complete applies server ammo to combat adapter');
}

// ═══════════════════════════════════════════════════════════════════════════
// estimateCombatClientTime uses wall offset (not performance.now domain)
// ═══════════════════════════════════════════════════════════════════════════

{
  assert.equal(estimateCombatClientTime(1000, 250), 1250);
  assert.equal(estimateCombatClientTime(1000, 0), 1000);
  ok('combat clientTime uses wall-clock + clockOffsetMs');
}

// ═══════════════════════════════════════════════════════════════════════════
// WEAPON_BALANCE ids exist in client gun catalog (shared id contract)
// ═══════════════════════════════════════════════════════════════════════════

{
  const catalogIds = new Set(GUN_CATALOG.map((g) => g.id));
  for (const id of WEAPON_IDS) {
    assert.ok(catalogIds.has(id), `server weapon ${id} missing from GUN_CATALOG`);
    assert.ok(WEAPON_BALANCE[id]?.magazineSize > 0, `${id} has magazineSize`);
  }
  // EVENT_KIND includes reload_complete
  assert.equal(EVENT_KIND.RELOAD_COMPLETE, 'reload_complete');
  ok('WEAPON_BALANCE ids present in client catalog; RELOAD_COMPLETE on EVENT_KIND');
}

console.log(`\nverify-deathmatch-combat: ${passed} checks passed`);
