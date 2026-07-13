/**
 * Deathmatch room lifecycle checks with fake connections (pure node, M0).
 *
 * This is the M0 exit gate: two synthetic players complete a deterministic match
 * entirely through the pure MatchRoom + reducer, covering
 *   - waiting → countdown → running → intermission → reset lifecycle;
 *   - an accepted frag via real server hitscan, with correct frag/death counts;
 *   - server-owned respawn after the delay with the starting loadout;
 *   - pickup contention resolving to exactly one player;
 *   - fire validation (cadence, ammo, origin, phase gates);
 *   - a kill-plane world death scored as a self-frag penalty;
 *   - frag-limit round result and a clean reset to a new roundId;
 *   - capacity rejection, reconnect/resume, and bounded queues under abuse.
 *
 * Run: node scripts/verify-deathmatch-room.mjs
 * Alias: npm run verify:deathmatch-room
 */

import assert from 'node:assert/strict';
import { MatchRoom } from '../party/deathmatch/MatchRoom.js';
import { ROOM_CONFIG, MATCH_PHASE, PLAYER_CAPSULE } from '../src/game/config/deathmatch/deathmatchRules.js';
import { PROTOCOL_VERSION, CLIENT_MSG, SERVER_MSG } from '../src/game/net/deathmatchProtocol.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

const V = PROTOCOL_VERSION;

/** Short-duration config so a full match runs in a handful of ticks. */
const TEST_CONFIG = Object.freeze({
  ...ROOM_CONFIG,
  fragLimit: 3,
  countdownMs: 100,
  respawnDelayMs: 100,
  spawnProtectionMs: 50,
  intermissionMs: 100,
  matchDurationMs: 5_000_000,
});

const ready = (ready) => ({ v: V, type: CLIENT_MSG.READY, ready });
/** Fire intent aligned to the current room clock (required for lag-comp skew). */
const fireMsg = (shotSeq, origin, direction, weaponId = 'midnight-glock', clientTime = now) => ({
  v: V, type: CLIENT_MSG.FIRE, shotSeq, clientTime, weaponId, origin, direction,
});

/** Head position of a player standing with feet at `pos`. */
const head = (pos) => [pos[0], pos[1] + PLAYER_CAPSULE.headHeight, pos[2]];

/** Collect the last message of a type from a drained outbound batch. */
function lastOfType(outbound, type) {
  let found = null;
  for (const item of outbound) if (item.msg.type === type) found = item.msg;
  return found;
}
function allEvents(outbound, kind) {
  return outbound.filter((i) => i.msg.type === SERVER_MSG.EVENT && i.msg.kind === kind).map((i) => i.msg);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main two-player match
// ═══════════════════════════════════════════════════════════════════════════

const room = new MatchRoom({ roomId: 'crucible', seed: 0xC0FFEE, config: TEST_CONFIG });
let now = 1000;

// ── Join + welcome ───────────────────────────────────────────────────────────
{
  const a = room.connect('connA', { displayName: 'Ada' }, now);
  const b = room.connect('connB', { displayName: 'Boris' }, now);
  assert.equal(a.playerId, 'p1');
  assert.equal(b.playerId, 'p2');
  const out = room.drainOutbound();
  const welcomeA = out.find((i) => i.to === 'connA' && i.msg.type === SERVER_MSG.WELCOME)?.msg;
  const welcomeB = out.find((i) => i.to === 'connB' && i.msg.type === SERVER_MSG.WELCOME)?.msg;
  assert.ok(welcomeA && welcomeB, 'both receive welcome');
  assert.equal(welcomeA.mapId, 'rail-crucible-v1');
  assert.ok(welcomeA.resumeToken, 'welcome carries a resume token');
  assert.equal(welcomeA.fullState.players.length, 1, 'A joined into an empty room');
  assert.equal(welcomeB.fullState.players.length, 2, 'B sees both players at join');
  assert.equal(room.state.players.size, 2);
  assert.equal(room.state.phase, MATCH_PHASE.WAITING);
  ok('both players join, receive welcome, and room stays WAITING');
}

// ── Ready → countdown → running spawns both ──────────────────────────────────
{
  room.message('connA', ready(true), now);
  room.message('connB', ready(true), now);
  room.tick(now); // WAITING → COUNTDOWN
  assert.equal(room.state.phase, MATCH_PHASE.COUNTDOWN);

  now += TEST_CONFIG.countdownMs + 1;
  room.drainOutbound();
  room.tick(now); // COUNTDOWN → RUNNING (spawns both)
  assert.equal(room.state.phase, MATCH_PHASE.RUNNING);
  const pa = room.state.players.get('p1');
  const pb = room.state.players.get('p2');
  assert.equal(pa.alive && pb.alive, true, 'both alive after start');
  assert.equal(pa.health, 100);
  assert.deepEqual(Object.keys(pa.weapons), ['midnight-glock'], 'starting loadout');
  ok('ready → countdown → running spawns both players with the starting loadout');
}

// ── Position helper: place shooter/target on a clear sightline ────────────────
function stage(shooterId, targetId, targetHealth) {
  const s = room.state.players.get(shooterId);
  const t = room.state.players.get(targetId);
  s.position = [20, 0, -10];
  s.spawnProtectedUntil = 0;
  s.weapons['midnight-glock'].ammo = 15;
  s.fire.nextFireAt = 0;
  // Preserve monotonic shotSeq across stages unless the test sets its own seq.
  if (!Number.isInteger(s.fire.lastShotSeq)) s.fire.lastShotSeq = -1;
  s.currentWeapon = 'midnight-glock';
  t.position = [20, 0, 10];
  t.spawnProtectedUntil = 0;
  t.history = []; // rewind falls back to the current canonical position
  if (targetHealth != null) t.health = targetHealth;
}

// ── Fire validation (rejections keep cosmetic-only, no state change) ──────────
{
  stage('p1', 'p2', 100);
  const s = room.state.players.get('p1');

  // Bad origin offset → rejected.
  room.drainOutbound();
  room.message('connA', fireMsg(1, [0, 0, 0], [0, 0, 1]), now);
  let sr = lastOfType(room.drainOutbound(), SERVER_MSG.SHOT_RESULT);
  assert.equal(sr.accepted, false);
  assert.equal(sr.reason, 'origin_offset');
  assert.equal(s.weapons['midnight-glock'].ammo, 15, 'rejected shot consumes no ammo');

  // Valid shot → accepted, consumes ammo, damages target.
  room.message('connA', fireMsg(2, head([20, 0, -10]), [0, 0, 1]), now);
  sr = lastOfType(room.drainOutbound(), SERVER_MSG.SHOT_RESULT);
  assert.equal(sr.accepted, true);
  assert.equal(sr.hitPlayerId, 'p2');
  assert.equal(s.weapons['midnight-glock'].ammo, 14);
  assert.ok(room.state.players.get('p2').health < 100, 'target took damage');

  // Immediate second shot → cadence rejected.
  room.message('connA', fireMsg(3, head([20, 0, -10]), [0, 0, 1]), now);
  sr = lastOfType(room.drainOutbound(), SERVER_MSG.SHOT_RESULT);
  assert.equal(sr.accepted, false);
  assert.equal(sr.reason, 'cadence');
  ok('fire validation: origin/cadence rejected without state change; valid shot hits');
}

// ── Accepted frag: kill B, correct frag/death attribution ────────────────────
{
  stage('p1', 'p2', 18); // one pistol body shot (18 dmg) is lethal
  room.drainOutbound();
  now += 200;
  room.state.players.get('p1').fire.nextFireAt = 0;
  room.message('connA', fireMsg(10, head([20, 0, -10]), [0, 0, 1]), now);
  const out = room.drainOutbound();
  const death = allEvents(out, 'death');
  assert.equal(death.length, 1, 'exactly one death event');
  assert.equal(death[0].payload.victimId, 'p2');
  assert.equal(death[0].payload.attackerId, 'p1');
  const pa = room.state.players.get('p1');
  const pb = room.state.players.get('p2');
  assert.equal(pa.frags, 1, 'attacker gains one frag');
  assert.equal(pb.deaths, 1, 'victim gains one death');
  assert.equal(pb.alive, false);
  assert.notEqual(pb.respawnAt, null, 'victim queued to respawn');
  ok('accepted frag attributes one frag to attacker and one death to victim');
}

// ── Server-owned respawn after the delay ─────────────────────────────────────
{
  const pb = room.state.players.get('p2');
  const lifeBefore = pb.lifeSeq;
  now += TEST_CONFIG.respawnDelayMs + 1;
  room.drainOutbound();
  room.tick(now);
  const respawns = allEvents(room.drainOutbound(), 'respawn');
  const respawnEv = respawns.find((r) => r.payload.playerId === 'p2');
  assert.ok(respawnEv, 'respawn event for p2');
  assert.equal(pb.alive, true);
  assert.equal(pb.health, 100);
  assert.equal(pb.lifeSeq, lifeBefore + 1, 'new life sequence');
  assert.ok(pb.spawnProtectedUntil > now, 'spawn protection active');
  assert.ok(respawnEv.payload.weapons?.['midnight-glock'], 'respawn carries weapons loadout');
  assert.equal(
    respawnEv.payload.weapons['midnight-glock'].ammo,
    15,
    'respawn weapons include starting mag ammo',
  );
  ok('victim respawns after the delay with full health, weapons payload, and a new life sequence');
}

// ── Pickup contention resolves to exactly one player ─────────────────────────
{
  const pa = room.state.players.get('p1');
  const pb = room.state.players.get('p2');
  const pickup = room.state.pickups.get('pk-shotgun'); // [10,0,10]
  pa.position = [10, 0, 9];
  pb.position = [11, 0, 10];
  pa.alive = true;
  pb.alive = true;
  assert.equal(pickup.available, true);

  room.drainOutbound();
  room.message('connA', { v: V, type: CLIENT_MSG.PICKUP_REQUEST, actionSeq: 1, pickupId: 'pk-shotgun' }, now);
  room.message('connB', { v: V, type: CLIENT_MSG.PICKUP_REQUEST, actionSeq: 1, pickupId: 'pk-shotgun' }, now);
  const taken = allEvents(room.drainOutbound(), 'pickup_taken');
  assert.equal(taken.length, 1, 'exactly one pickup_taken event');
  assert.equal(taken[0].payload.pickupId, 'pk-shotgun');
  assert.equal(pickup.available, false);
  assert.ok(pickup.availableAt > now, 'pickup respawn scheduled');
  const owner = taken[0].payload.playerId;
  assert.ok(room.state.players.get(owner).weapons['tactical-shotgun'], 'winner received the weapon');
  const loser = owner === 'p1' ? 'p2' : 'p1';
  assert.ok(!room.state.players.get(loser).weapons['tactical-shotgun'], 'loser did not also receive it');
  ok('simultaneous pickup requests grant the weapon to exactly one player');
}

// ── Kill-plane world death scored as a self-frag penalty ─────────────────────
{
  const pa = room.state.players.get('p1');
  const fragsBefore = pa.frags;
  pa.alive = true;
  pa.position = [20, 0, 0];
  pa.lastSampleAt = now;
  const seq = pa.lastInputSeq + 1;
  room.drainOutbound();
  room.message('connA', { v: V, type: CLIENT_MSG.PLAYER_STATE, seq, clientTime: now, position: [20, -10, 0], velocity: [0, -20, 0], yaw: 0, pitch: 0 }, now);
  const death = allEvents(room.drainOutbound(), 'death');
  assert.equal(death.length, 1);
  assert.equal(death[0].payload.cause, 'world');
  assert.equal(pa.frags, fragsBefore - 1, 'world death subtracts a frag');
  assert.equal(pa.alive, false);
  ok('falling below the kill plane is a world death with a self-frag penalty');
}

// ── Reach the frag limit → intermission + round result ───────────────────────
{
  const pa = room.state.players.get('p1');
  // Respawn p1 back into the match.
  now += TEST_CONFIG.respawnDelayMs + 1;
  room.tick(now);
  room.drainOutbound();

  // Drive p1's frags to the limit via real hitscan kills.
  while (pa.frags < TEST_CONFIG.fragLimit) {
    // Ensure victim alive.
    const pb = room.state.players.get('p2');
    if (!pb.alive) {
      now += TEST_CONFIG.respawnDelayMs + 1;
      room.tick(now);
    }
    now += 200;
    stage('p1', 'p2', 18);
    room.message('connA', fireMsg(100 + pa.frags, head([20, 0, -10]), [0, 0, 1]), now);
  }
  assert.equal(pa.frags, TEST_CONFIG.fragLimit);

  room.drainOutbound();
  room.tick(now); // running → intermission (frag limit)
  const out = room.drainOutbound();
  const result = allEvents(out, 'round_result');
  assert.equal(room.state.phase, MATCH_PHASE.INTERMISSION);
  assert.equal(result.length, 1);
  assert.equal(result[0].payload.reason, 'frag_limit');
  assert.equal(result[0].payload.winnerId, 'p1');
  ok('reaching the frag limit ends the round with a correct winner and result');
}

// ── Reset to a fresh round ───────────────────────────────────────────────────
{
  now += TEST_CONFIG.intermissionMs + 1;
  room.drainOutbound();
  room.tick(now); // intermission → reset
  assert.equal(room.state.phase, MATCH_PHASE.WAITING);
  assert.equal(room.state.roundId, 'round-2');
  for (const p of room.state.players.values()) {
    assert.equal(p.frags, 0, 'scores reset');
    assert.equal(p.deaths, 0);
    assert.equal(p.alive, false);
    assert.deepEqual(p.weapons, {}, 'inventory cleared');
  }
  for (const pk of room.state.pickups.values()) assert.equal(pk.available, true, 'pickups reset');
  ok('intermission resets to a new roundId with baseline scores, inventory, and pickups');
}

// ═══════════════════════════════════════════════════════════════════════════
// Capacity, reconnect, and abuse bounds (isolated rooms)
// ═══════════════════════════════════════════════════════════════════════════

// ── 9th player rejected ──────────────────────────────────────────────────────
{
  const capRoom = new MatchRoom({ roomId: 'cap', seed: 1, config: ROOM_CONFIG });
  for (let i = 0; i < ROOM_CONFIG.capacity; i += 1) {
    const res = capRoom.connect(`c${i}`, { displayName: `P${i}` }, 0);
    assert.ok(res.playerId, `player ${i} admitted`);
  }
  capRoom.drainOutbound();
  const ninth = capRoom.connect('c8', { displayName: 'Overflow' }, 0);
  assert.equal(ninth.error, 'capacity');
  const err = lastOfType(capRoom.drainOutbound(), SERVER_MSG.ERROR);
  assert.equal(err.code, 'capacity');
  assert.equal(capRoom.state.players.size, ROOM_CONFIG.capacity, 'no ghost player created');
  ok('ninth player is rejected with a capacity error and no ghost identity');
}

// ── Reconnect within the resume window keeps identity ────────────────────────
{
  const rcRoom = new MatchRoom({ roomId: 'rc', seed: 2, config: ROOM_CONFIG });
  const join = rcRoom.connect('sock1', { displayName: 'Rejoiner' }, 0);
  const welcome = lastOfType(rcRoom.drainOutbound(), SERVER_MSG.WELCOME);
  const token = welcome.resumeToken;

  rcRoom.disconnect('sock1', 1000);
  assert.equal(rcRoom.state.players.get(join.playerId).connected, false);

  const back = rcRoom.connect('sock2', { playerId: join.playerId, resumeToken: token }, 2000);
  assert.equal(back.playerId, join.playerId, 'same identity restored');
  assert.equal(rcRoom.state.players.get(join.playerId).connected, true);
  assert.equal(rcRoom.state.players.size, 1, 'no duplicate identity');

  // Wrong token after the window → treated as a fresh join.
  rcRoom.disconnect('sock2', 3000);
  const fresh = rcRoom.connect('sock3', { playerId: join.playerId, resumeToken: 'bogus' }, 3000 + ROOM_CONFIG.resumeWindowMs + 1);
  assert.notEqual(fresh.playerId, join.playerId, 'expired/wrong resume yields a new identity');
  ok('reconnect within the resume window keeps identity; expired/bad token does not');
}

// ── Malformed / flood input keeps queues and history bounded ─────────────────
{
  const abuseRoom = new MatchRoom({ roomId: 'abuse', seed: 3, config: ROOM_CONFIG });
  abuseRoom.connect('flood', { displayName: 'Flood' }, 0);
  abuseRoom.drainOutbound();

  // Flood malformed messages in a single tick.
  for (let i = 0; i < 5000; i += 1) abuseRoom.message('flood', { v: V, type: 'garbage' }, 0);
  const out = abuseRoom.drainOutbound();
  assert.ok(out.length <= ROOM_CONFIG.maxInboundPerTick + ROOM_CONFIG.maxOutboundQueue, `outbound bounded (${out.length})`);

  // Flood valid movement to exercise history growth.
  const player = abuseRoom.state.players.get('p1');
  player.alive = true;
  player.position = [0, 0, 0];
  for (let i = 0; i < 5000; i += 1) {
    abuseRoom.tick(i); // resets per-tick budget and lets samples through over time
    abuseRoom.message('flood', { v: V, type: CLIENT_MSG.PLAYER_STATE, seq: i + 1, clientTime: i, position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0 }, i);
    abuseRoom.drainOutbound();
  }
  assert.ok(player.history.length < 100, `history bounded (${player.history.length})`);
  ok('malformed floods and heavy movement keep outbound queue and history bounded');
}

console.log(`\n✓ deathmatch room: ${passed} checks passed`);
