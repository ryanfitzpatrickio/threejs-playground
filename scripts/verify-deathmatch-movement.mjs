/**
 * verify-deathmatch-movement — M3 exit-gate check (node, no browser).
 *
 * Exercises the sample → server validate → correct → remote buffer → puppet
 * lifecycle path without live PartyKit or Playwright:
 *
 *  1. Pure interpolation buffer edges (extrapolate, trim, retainOnly, snap gap)
 *  2. Correction planner boundaries + soft blend math
 *  3. Teleport / jump-pad payload application
 *  4. Clock domain: feature clientTime within maxTimestampSkewMs of server now
 *  5. Frame plan order vs movement/animation
 *  6. Two MatchRoom clients + DeathmatchNetworkSystem loopback
 *  7. drainEvents cursor under ring shift
 *  8. Feature-host harness: hard/soft correct, predict triggers, sample cadence
 *  9. RemotePlayerSystem join/leave (when Three is available in node — skipped
 *     gracefully if CapsuleGeometry needs a full renderer; buffer path always runs)
 * 10. Jump-pad one-shot on server (no re-fire while standing in volume)
 *
 * Run: node scripts/verify-deathmatch-movement.mjs
 * Alias: npm run verify:deathmatch-movement
 */

import assert from 'node:assert/strict';
import {
  createRemotePlayerBuffer,
  interpolateSamples,
  lerpAngle,
  DEFAULT_INTERP_DELAY_MS,
  MAX_SAMPLES_PER_PLAYER,
  SAMPLE_HARD_SNAP_M,
  SAMPLE_WINDOW_MS,
} from '../src/game/net/remotePlayerBuffer.js';
import {
  buildPlayerStateMessage,
  planCorrection,
  applyTeleportPayload,
  shouldSample,
  estimateClientTime,
  HARD_SNAP_DISTANCE_M,
  SOFT_CORRECT_DISTANCE_M,
  SOFT_CORRECT_BLEND,
} from '../src/game/net/deathmatchMovementReplication.js';
import { MatchRoom } from '../party/deathmatch/MatchRoom.js';
import { ROOM_CONFIG, MATCH_PHASE, MOVEMENT } from '../src/game/config/deathmatch/deathmatchRules.js';
import {
  PROTOCOL_VERSION,
  CLIENT_MSG,
  SERVER_MSG,
  EVENT_KIND,
} from '../src/game/net/deathmatchProtocol.js';
import { DeathmatchNetworkSystem, NET_STATUS } from '../src/game/systems/DeathmatchNetworkSystem.js';
import { frameStepIdList } from '../src/game/runtime/runtimeFramePlan.js';
import { RAIL_CRUCIBLE } from '../src/game/config/deathmatch/railCrucibleMap.js';
import {
  DeathmatchRuntimeFeature,
  buildAnimationReplicationState,
  resolveLocomotionLabel,
} from '../src/game/runtime/features/deathmatch/DeathmatchRuntimeFeature.js';
import { applyMovementSample } from '../party/deathmatch/movement.js';
import { RemotePlayerSystem } from '../src/game/systems/RemotePlayerSystem.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

const V = PROTOCOL_VERSION;
const TEST_CONFIG = Object.freeze({
  ...ROOM_CONFIG,
  countdownMs: 50,
  respawnDelayMs: 50,
  spawnProtectionMs: 20,
  intermissionMs: 50,
  matchDurationMs: 5_000_000,
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pure remote buffer + edges
// ═══════════════════════════════════════════════════════════════════════════
{
  const buf = createRemotePlayerBuffer({ delayMs: 100, maxSamples: 8, windowMs: 500 });
  buf.pushSample({
    playerId: 'p2',
    position: [0, 0, 0],
    velocity: [2, 0, 0],
    yaw: 0,
    pitch: 0,
    locomotionState: 'idle',
    currentWeapon: 'midnight-glock',
    alive: true,
  }, 1000);
  buf.pushSample({
    playerId: 'p2',
    position: [2, 0, 0],
    velocity: [2, 0, 0],
    yaw: Math.PI / 2,
    pitch: 0.4,
    locomotionState: 'run',
    currentWeapon: 'midnight-glock',
    alive: true,
  }, 1100);

  const atEdge = buf.sampleAt('p2', 1200);
  assert.ok(atEdge);
  assert.ok(Math.abs(atEdge.position[0] - 2) < 1e-6);

  const mid = buf.sampleAt('p2', 1150);
  assert.ok(mid);
  assert.ok(Math.abs(mid.position[0] - 1) < 1e-6, `expected ~1, got ${mid.position[0]}`);
  assert.ok(Math.abs(mid.yaw - Math.PI / 4) < 1e-6);
  assert.ok(Math.abs(mid.pitch - 0.2) < 1e-6, 'pitch lerps');

  // Velocity extrapolation past newest sample.
  const extrap = interpolateSamples([
    {
      t: 1000, position: [0, 0, 0], velocity: [10, 0, 0], yaw: 0, pitch: 0,
      locomotionState: 'run', currentWeapon: null, alive: true,
    },
    {
      t: 1100, position: [1, 0, 0], velocity: [10, 0, 0], yaw: 0, pitch: 0,
      locomotionState: 'run', currentWeapon: null, alive: true,
    },
  ], 1150);
  assert.equal(extrap.extrapolated, true);
  assert.ok(Math.abs(extrap.position[0] - (1 + 10 * 0.05)) < 1e-6);

  // Same-tick replace updates weapon/alive.
  buf.pushSample({
    playerId: 'p2',
    position: [2, 0, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    locomotionState: 'idle',
    currentWeapon: 'desert-ar15',
    alive: false,
  }, 1100);
  const tail = buf.tracks.get('p2').samples.at(-1);
  // May have been replaced if 1100 was still last, or ignored if later samples exist from spam below.
  // Fresh track for same-tick:
  const buf2 = createRemotePlayerBuffer();
  buf2.pushSample({
    playerId: 'x', position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0,
    locomotionState: 'idle', currentWeapon: 'a', alive: true,
  }, 50);
  buf2.pushSample({
    playerId: 'x', position: [1, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0,
    locomotionState: 'run', currentWeapon: 'b', alive: false,
  }, 50);
  assert.equal(buf2.tracks.get('x').samples.length, 1);
  assert.equal(buf2.tracks.get('x').samples[0].currentWeapon, 'b');
  assert.equal(buf2.tracks.get('x').samples[0].alive, false);

  // Invalid push ignored.
  buf2.pushSample(null, 100);
  buf2.pushSample({ playerId: 'y' }, 100); // no position
  assert.equal(buf2.tracks.has('y'), false);

  // windowMs trim keeps recent samples only (option must be honored, not default 750).
  const bufW = createRemotePlayerBuffer({ maxSamples: 32, windowMs: 200 });
  for (let i = 0; i < 10; i += 1) {
    bufW.pushSample({
      playerId: 'w',
      position: [i, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      locomotionState: 'idle',
      alive: true,
    }, 1000 + i * 100);
  }
  const samplesW = bufW.tracks.get('w').samples;
  assert.ok(samplesW.length >= 2);
  assert.ok(
    samplesW[samplesW.length - 1].t - samplesW[0].t <= 200 + 100,
    `windowMs:200 not honored, span=${samplesW[samplesW.length - 1].t - samplesW[0].t}`,
  );

  // maxSamples bound.
  for (let i = 0; i < 40; i += 1) {
    buf.pushSample({
      playerId: 'p2',
      position: [i, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      locomotionState: 'idle',
      alive: true,
    }, 2000 + i * 50);
  }
  assert.ok(buf.tracks.get('p2').samples.length <= 8);

  // retainOnly drops others.
  buf.pushSample({
    playerId: 'p3', position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0,
    locomotionState: 'idle', alive: true,
  }, 5000);
  buf.retainOnly(['p2']);
  assert.equal(buf.tracks.has('p3'), false);
  assert.equal(buf.tracks.has('p2'), true);

  // Hard snap across large teleport gap (no multi-metre lerp).
  const snapPose = interpolateSamples([
    {
      t: 0, position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0,
      locomotionState: 'idle', currentWeapon: null, alive: true,
    },
    {
      t: 50, position: [SAMPLE_HARD_SNAP_M + 1, 0, 0], velocity: [0, 0, 0], yaw: 1, pitch: 0,
      locomotionState: 'idle', currentWeapon: null, alive: true,
    },
  ], 25);
  assert.ok(Math.abs(snapPose.position[0] - (SAMPLE_HARD_SNAP_M + 1)) < 1e-6);
  assert.equal(snapPose.yaw, 1);

  buf.remove('p2');
  assert.equal(buf.sampleAt('p2', 3000), null);

  // Exact angle wrap: from nearly π to nearly -π short path.
  const a = Math.PI - 0.1;
  const b = -Math.PI + 0.1;
  const midA = lerpAngle(a, b, 0.5);
  // Shortest path midpoint is near ±π (either sign).
  const expected = a + (() => {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d * 0.5;
  })();
  assert.ok(Math.abs(midA - expected) < 1e-9, `lerpAngle wrap: got ${midA}, expected ${expected}`);

  ok('remote buffer edges: lerp, extrapolate, trim, retainOnly, same-tick, hard-snap gap, angle wrap');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Correction planner boundaries
// ═══════════════════════════════════════════════════════════════════════════
{
  const cases = [
    { d: SOFT_CORRECT_DISTANCE_M - 1e-6, kind: 'none' },
    { d: SOFT_CORRECT_DISTANCE_M, kind: 'soft' },
    { d: 1.0, kind: 'soft' },
    { d: HARD_SNAP_DISTANCE_M - 1e-6, kind: 'soft' },
    { d: HARD_SNAP_DISTANCE_M, kind: 'hard' },
    { d: HARD_SNAP_DISTANCE_M + 5, kind: 'hard' },
  ];
  for (const c of cases) {
    const plan = planCorrection([0, 0, 0], [c.d, 0, 0]);
    assert.equal(plan.kind, c.kind, `d=${c.d} expected ${c.kind}, got ${plan.kind}`);
  }
  const soft = planCorrection([0, 0, 0], [1, 0, 0]);
  assert.equal(soft.kind, 'soft');
  assert.ok(Math.abs(soft.position[0] - SOFT_CORRECT_BLEND) < 1e-9);
  assert.ok(Math.abs(soft.distance - 1) < 1e-9);
  ok('correction planner table at exact 0.35/2.5 thresholds + soft blend factor');
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Teleport / jump pad payloads
// ═══════════════════════════════════════════════════════════════════════════
{
  const pose = { position: [1, 0, 1], velocity: [3, 0, 0], yaw: 0.5 };
  const tp = applyTeleportPayload(pose, {
    kind: 'teleporter',
    exitPosition: [10, 2, -4],
    exitYaw: 1.2,
  });
  assert.equal(tp.applied, true);
  assert.deepEqual(pose.position, [10, 2, -4]);
  assert.equal(pose.yaw, 1.2);

  const pose2 = { position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0 };
  const jp = applyTeleportPayload(pose2, { kind: 'jumpPad', velocity: [0, 14, 4] });
  assert.equal(jp.kind, 'jumpPad');
  assert.deepEqual(pose2.velocity, [0, 14, 4]);

  // Error paths: null pose/payload, unknown kind → applied:false.
  assert.equal(applyTeleportPayload(null, { kind: 'teleporter' }).applied, false);
  assert.equal(applyTeleportPayload(pose2, null).applied, false);
  assert.equal(applyTeleportPayload(pose2, { kind: 'warpZone' }).applied, false);
  ok('teleporter snaps pose; jump pad sets launch velocity; error paths applied:false');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Sample helpers + locomotion label + clock domain
// ═══════════════════════════════════════════════════════════════════════════
{
  assert.equal(shouldSample(0, MOVEMENT.sampleIntervalMs - 1), false);
  assert.equal(shouldSample(0, MOVEMENT.sampleIntervalMs), true);
  assert.equal(estimateClientTime(1000, 50), 1050);

  const msg = buildPlayerStateMessage({
    seq: 3,
    clientTime: 1234,
    position: [1, 2, 3],
    velocity: [0.5, 0, -0.5],
    yaw: 1,
    pitch: -0.2,
    locomotionState: 'run',
  });
  assert.equal(msg.type, CLIENT_MSG.PLAYER_STATE);

  assert.equal(resolveLocomotionLabel({ grounded: true, speed: 0 }), 'idle');
  assert.equal(resolveLocomotionLabel({ grounded: true, speed: 2 }), 'walk');
  assert.equal(resolveLocomotionLabel({ grounded: true, speed: 8 }), 'run');
  assert.equal(resolveLocomotionLabel({ grounded: false, verticalVelocity: 3 }), 'jump');
  assert.equal(resolveLocomotionLabel({ grounded: false, verticalVelocity: -5 }), 'fall');

  // Feature-level clientTime must sit inside server skew window (Date.now domain).
  let wall = 5_000_000;
  const netClock = { _now: () => wall, clockOffsetMs: 12 };
  const featureNow = typeof netClock._now === 'function' ? netClock._now() : Date.now();
  const clientTime = estimateClientTime(featureNow, netClock.clockOffsetMs);
  const serverNow = wall; // server uses same domain in tests
  assert.ok(
    Math.abs(clientTime - serverNow) < MOVEMENT.maxTimestampSkewMs,
    `clientTime skew ${Math.abs(clientTime - serverNow)} exceeds maxTimestampSkewMs`,
  );
  // performance.now()-style values would be ~seconds since origin, not epoch.
  const bogusPerf = 12345.67;
  const bad = estimateClientTime(bogusPerf, 12);
  assert.ok(
    Math.abs(bad - serverNow) > MOVEMENT.maxTimestampSkewMs,
    'documents that performance.now domain fails skew (regression guard)',
  );
  ok('sample helpers, locomotion labels, and clientTime clock domain');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Frame plan order
// ═══════════════════════════════════════════════════════════════════════════
{
  const ids = frameStepIdList();
  const idx = (id) => {
    const i = ids.indexOf(id);
    assert.ok(i >= 0, `missing step ${id}`);
    return i;
  };
  assert.ok(idx('physics-begin-frame') < idx('deathmatch-net-apply'));
  assert.ok(idx('deathmatch-net-apply') < idx('movement-traversal-chain'));
  assert.ok(idx('movement-traversal-chain') < idx('deathmatch-sample-send'));
  assert.ok(idx('deathmatch-sample-send') < idx('animation-state'));
  assert.ok(idx('animation-state') < idx('deathmatch-remote-puppets'));
  ok('frame plan order: beginFrame < net-apply < movement < sample < anim < remotes');
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Jump-pad one-shot on server
// ═══════════════════════════════════════════════════════════════════════════
{
  const pad = RAIL_CRUCIBLE.jumpPads[0];
  const padPos = [
    (pad.bounds.min[0] + pad.bounds.max[0]) / 2,
    (pad.bounds.min[1] + pad.bounds.max[1]) / 2,
    (pad.bounds.min[2] + pad.bounds.max[2]) / 2,
  ];
  const player = {
    playerId: 'p1',
    alive: true,
    position: [...padPos],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    lastInputSeq: 0,
    lastSampleAt: 1000,
    history: [],
    locomotionState: 'idle',
    activeJumpPadId: null,
  };
  const r1 = applyMovementSample({}, player, {
    seq: 1,
    clientTime: 1050,
    position: padPos,
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
  }, 1050);
  assert.equal(r1.events.filter((e) => e.kind === 'teleport').length, 1);
  const r2 = applyMovementSample({}, player, {
    seq: 2,
    clientTime: 1100,
    position: padPos,
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
  }, 1100);
  assert.equal(r2.events.filter((e) => e.kind === 'teleport').length, 0, 'no re-fire while in pad');
  // Leave pad then re-enter (use a legal mid-floor spawn, not the solid centre).
  const offPad = [...RAIL_CRUCIBLE.playerSpawns.find((s) => s.id === 'spawn-m1').position];
  player.position = [...offPad];
  applyMovementSample({}, player, {
    seq: 3,
    clientTime: 1150,
    position: offPad,
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
  }, 1150);
  assert.equal(player.activeJumpPadId, null);
  // Place feet back in the pad (avoid displacement clamp rejecting a far teleport).
  player.position = [...padPos];
  player.lastSampleAt = 1200;
  const r4 = applyMovementSample({}, player, {
    seq: 4,
    clientTime: 1250,
    position: padPos,
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
  }, 1250);
  assert.equal(r4.events.filter((e) => e.kind === 'teleport').length, 1, 're-fire after exit');
  ok('server jump-pad is one-shot until volume exit');
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Feature host harness (no Three scene required)
// ═══════════════════════════════════════════════════════════════════════════
{
  let wall = 2_000_000;
  const sent = [];
  const net = {
    _now: () => wall,
    clockOffsetMs: 5,
    playerId: 'p1',
    phase: MATCH_PHASE.RUNNING,
    players: [{
      playerId: 'p1',
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      alive: true,
      connected: true,
    }, {
      playerId: 'p2',
      position: [3, 0, 0],
      velocity: [1, 0, 0],
      yaw: 0.5,
      locomotionState: 'run',
      currentWeapon: 'midnight-glock',
      alive: true,
      connected: true,
      displayName: 'Boris',
    }],
    snapshotGeneration: 1,
    serverTime: wall,
    isNetworkReady: () => true,
    estimateServerTime: (n) => n + 5,
    getLocalPlayer() {
      return this.players.find((p) => p.playerId === this.playerId);
    },
    drainEvents: () => [],
    send(msg) {
      sent.push(msg);
      return true;
    },
  };

  // Minimal mock RemotePlayerSystem (no Three).
  const mockRemotes = {
    localId: null,
    ingested: [],
    removed: [],
    setLocalPlayerId(id) { this.localId = id; },
    ingestPlayers(players, t, opts) {
      this.ingested.push({ players, t, opts });
    },
    removePlayer(id) { this.removed.push(id); },
    update() {},
    attach() {},
    snapshot: () => ({ puppetCount: 0 }),
  };

  const character = {
    group: {
      position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      rotation: { y: 0 },
    },
    velocity: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    verticalVelocity: 0,
    yaw: 0,
    grounded: true,
    speed: 0,
    animationController: {
      currentState: 'jog',
      upperBodyState: 'lightSlash1',
      layered: true,
      attackLegState: 'lightSlash1',
      attackLegTarget: 0.75,
      footworkActive: false,
      footworkLegState: null,
      footworkBodyState: null,
      mirrorX: 1,
    },
  };
  const physics = { syncCharacterBody() { this.synced = true; } };

  const host = {
    levelMode: 'deathmatch',
    networkSystem: net,
    remotePlayerSystem: mockRemotes,
    sceneSystem: { scene: {} },
    physicsSystem: physics,
    cameraSystem: { yaw: 0, pitch: 0 },
  };

  const feature = new DeathmatchRuntimeFeature(host);
  feature.setNetworkSystem(net);

  // Soft correction: local at 0, server at 1 → blend.
  net.players[0].position = [1, 0, 0];
  net.snapshotGeneration = 2;
  feature.applyAuthoritative({ character, physics, nowMs: wall });
  assert.ok(character.group.position.x > 0 && character.group.position.x < 1);
  assert.equal(feature._stats.softCorrects, 1);
  // Soft correct must not force yaw/camera.
  assert.equal(host.cameraSystem.yaw, 0);

  // Hard correction.
  character.group.position.set(0, 0, 0);
  net.players[0].position = [HARD_SNAP_DISTANCE_M + 2, 0, 0];
  net.players[0].yaw = 1.5;
  net.snapshotGeneration = 3;
  feature.applyAuthoritative({ character, physics, nowMs: wall });
  assert.ok(Math.abs(character.group.position.x - (HARD_SNAP_DISTANCE_M + 2)) < 1e-6);
  assert.equal(feature._stats.hardSnaps, 1);
  assert.equal(character.yaw, 1.5);
  assert.equal(host.cameraSystem.yaw, 1.5);

  // Sample cadence at ~60 Hz frames with wall clock.
  character.group.position.set(5, 0, 5);
  character.speed = 7;
  character.yaw = 0.2;
  character.group.rotation.y = -1.1;
  sent.length = 0;
  feature._lastSampleAt = 0;
  feature._sampleSeq = 0;
  for (let i = 0; i < 10; i += 1) {
    wall += 16; // ~60 fps
    feature.sampleAndSend({
      character,
      animationStateSystem: { state: 'stale_anim', leanAmount: 0.25 },
      cameraSystem: host.cameraSystem,
      nowMs: wall,
    });
  }
  // 10 frames * 16ms = 160ms → about 3 samples at 50ms cadence.
  assert.ok(sent.length >= 2 && sent.length <= 4, `expected ~3 samples, got ${sent.length}`);
  const last = sent[sent.length - 1];
  assert.equal(last.locomotionState, 'run', 'derived from speed, not stale anim');
  assert.equal(last.yaw, -1.1, 'samples actual body/group facing, not stale character.yaw');
  assert.deepEqual(last.animation, buildAnimationReplicationState(
    character,
    { state: 'stale_anim', leanAmount: 0.25 },
  ));
  assert.equal(last.animation.upper, 'lightSlash1');
  assert.equal(last.animation.attackLegWeight, 0.75);
  assert.ok(
    Math.abs(last.clientTime - wall) < MOVEMENT.maxTimestampSkewMs,
    'feature clientTime in Date.now domain within skew',
  );

  // Local jump-pad prediction (pad volume).
  const pad = RAIL_CRUCIBLE.jumpPads[0];
  const padPos = [
    (pad.bounds.min[0] + pad.bounds.max[0]) / 2,
    (pad.bounds.min[1] + pad.bounds.max[1]) / 2,
    (pad.bounds.min[2] + pad.bounds.max[2]) / 2,
  ];
  character.group.position.set(padPos[0], padPos[1], padPos[2]);
  character.velocity.set(0, 0, 0);
  character.verticalVelocity = 0;
  const beforePads = feature._stats.jumpPadsApplied;
  feature._predictJumpPad(character);
  assert.ok(feature._stats.jumpPadsApplied > beforePads);
  assert.ok(character.verticalVelocity > 0);
  // Second predict while still in pad is a no-op.
  const midPads = feature._stats.jumpPadsApplied;
  feature._predictJumpPad(character);
  assert.equal(feature._stats.jumpPadsApplied, midPads);

  // Server jump-pad TELEPORT must not double-boost when already predicted.
  const predictedVy = character.verticalVelocity;
  const padEventPayload = {
    playerId: 'p1',
    triggerId: pad.id,
    kind: 'jumpPad',
    velocity: pad.velocity,
  };
  // Simulate gravity drain after prediction — confirm must not reset to full launch.
  character.verticalVelocity = predictedVy - 2;
  if (character.velocity?.set) {
    character.velocity.set(0, character.verticalVelocity, 0);
  }
  const padsBeforeConfirm = feature._stats.jumpPadsApplied;
  feature._applyTeleportEvent(padEventPayload, character, physics);
  assert.equal(feature._stats.jumpPadsApplied, padsBeforeConfirm, 'no double boost on pad confirm');
  assert.ok(
    Math.abs(character.verticalVelocity - (predictedVy - 2)) < 1e-6,
    'gravity-drained velocity preserved on pad confirmation',
  );

  // Production _wallNow path (no nowMs) uses network._now().
  wall = 2_500_000;
  character.group.position.set(5, 0, 5);
  character.speed = 0;
  feature._lastSampleAt = 0;
  sent.length = 0;
  feature.sampleAndSend({
    character,
    animationStateSystem: null,
    cameraSystem: host.cameraSystem,
    // intentionally omit nowMs
  });
  assert.equal(sent.length, 1);
  assert.ok(
    Math.abs(sent[0].clientTime - (wall + net.clockOffsetMs)) < 1e-6,
    `expected clientTime from network._now, got ${sent[0].clientTime}`,
  );

  // Offline / inactive no-op.
  const offlineFeature = new DeathmatchRuntimeFeature({
    levelMode: 'deathmatch',
    networkSystem: null,
    remotePlayerSystem: mockRemotes,
    sceneSystem: { scene: {} },
    physicsSystem: physics,
    cameraSystem: host.cameraSystem,
  });
  sent.length = 0;
  offlineFeature.sampleAndSend({ character, nowMs: wall });
  assert.equal(sent.length, 0, 'no network → no samples');

  // Dead skip.
  net.players[0].alive = false;
  sent.length = 0;
  feature._lastSampleAt = 0;
  feature.sampleAndSend({ character, cameraSystem: host.cameraSystem, nowMs: wall + 100 });
  assert.equal(sent.length, 0, 'dead player skips samples');
  net.players[0].alive = true;

  // Phase gate: waiting → no samples.
  net.phase = MATCH_PHASE.WAITING;
  sent.length = 0;
  feature._lastSampleAt = 0;
  feature.sampleAndSend({ character, cameraSystem: host.cameraSystem, nowMs: wall + 200 });
  assert.equal(sent.length, 0, 'WAITING phase gates samples');
  net.phase = MATCH_PHASE.RUNNING;

  // PLAYER_LEAVE → removePlayer.
  mockRemotes.removed.length = 0;
  feature._handleEvent(
    { kind: EVENT_KIND.PLAYER_LEAVE, payload: { playerId: 'p2' } },
    character,
    physics,
  );
  assert.deepEqual(mockRemotes.removed, ['p2']);

  // Teleporter sample-then-predict: send entrance, then local exit snap.
  const tp = RAIL_CRUCIBLE.teleporters[0];
  const tpEntrance = [
    (tp.bounds.min[0] + tp.bounds.max[0]) / 2,
    (tp.bounds.min[1] + tp.bounds.max[1]) / 2,
    (tp.bounds.min[2] + tp.bounds.max[2]) / 2,
  ];
  character.group.position.set(tpEntrance[0], tpEntrance[1], tpEntrance[2]);
  character.yaw = 0;
  feature._activePredictedTeleporterId = null;
  feature._lastSampleAt = 0;
  feature._sampleSeq = 10;
  sent.length = 0;

  // Backpressure: send fails → feet stay at entrance, no one-shot, seq unchanged.
  const realSend = net.send.bind(net);
  net.send = (msg) => {
    if (msg?.type === CLIENT_MSG.PLAYER_STATE && net._forceBackpressure) return false;
    return realSend(msg);
  };
  net._forceBackpressure = true;
  feature.sampleAndSend({
    character,
    cameraSystem: host.cameraSystem,
    nowMs: wall + 500,
  });
  assert.equal(sent.length, 0, 'backpressure drops entrance sample');
  assert.ok(
    Math.abs(character.group.position.x - tpEntrance[0]) < 1e-6
      && Math.abs(character.group.position.z - tpEntrance[2]) < 1e-6,
    'must remain at entrance when send fails',
  );
  assert.equal(feature._activePredictedTeleporterId, null, 'one-shot not set on failed send');
  assert.equal(feature._sampleSeq, 10, 'seq not advanced on failed send');

  // Clear backpressure → send succeeds → exit snap + seq advance.
  net._forceBackpressure = false;
  feature.sampleAndSend({
    character,
    cameraSystem: host.cameraSystem,
    nowMs: wall + 550,
  });
  assert.equal(sent.length, 1, 'teleporter forces entrance sample after backpressure clears');
  assert.ok(
    Math.abs(sent[0].position[0] - tpEntrance[0]) < 1e-6
      && Math.abs(sent[0].position[2] - tpEntrance[2]) < 1e-6,
    `sample must be entrance pose, got ${sent[0].position}`,
  );
  assert.ok(
    Math.abs(character.group.position.x - tp.exitPosition[0]) < 1e-6
      && Math.abs(character.group.position.z - tp.exitPosition[2]) < 1e-6,
    'local exit snap only after successful send',
  );
  assert.equal(feature._activePredictedTeleporterId, tp.id);
  assert.equal(feature._sampleSeq, 11);
  net.send = realSend;

  // Server TELEPORT confirmation via applyAuthoritative (already at exit — snap is idempotent).
  const pendingEvents = [{
    kind: EVENT_KIND.TELEPORT,
    payload: {
      playerId: 'p1',
      triggerId: tp.id,
      kind: 'teleporter',
      exitPosition: tp.exitPosition,
      exitYaw: tp.exitYaw,
    },
  }];
  net.drainEvents = () => {
    const out = pendingEvents.splice(0);
    return out;
  };
  feature.applyAuthoritative({ character, physics, nowMs: wall + 600 });
  assert.ok(
    Math.abs(character.group.position.x - tp.exitPosition[0]) < 1e-6,
    'server TELEPORT keeps exit pose',
  );

  // Snapshot redaction: no resume token / socket.
  const snap = feature.snapshot();
  assert.equal(snap.mode, 'deathmatch');
  assert.ok(!('resumeToken' in snap));
  assert.ok(!('socket' in snap));
  assert.ok(typeof snap.samplesSent === 'number');

  ok('feature harness: correct/yaw/cadence/pad/double-boost/wallNow/gates/teleporter sample-then-predict/snapshot');
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. drainEvents cursor under ring shift
//
// Proven failure mode without cursor decrement:
//   1. Push N read fillers, drain all → cursor = N
//   2. Push MARKER as first unread (index N)
//   3. Push until length > 64 so a *read* event is shifted from the front
//   4. Without decrement: cursor stays N, marker slides to N-1 → SKIPPED
//   5. With decrement: cursor becomes N-1 → marker still drained
// ═══════════════════════════════════════════════════════════════════════════
{
  let wall = 3_000_000;
  const net = new DeathmatchNetworkSystem({
    host: 'x',
    room: 'y',
    displayName: 'T',
    now: () => wall,
    socketFactory: () => ({
      send() {},
      close() {},
      addEventListener() {},
      removeEventListener() {},
      bufferedAmount: 0,
    }),
  });
  net._welcomed = true;

  // 40 read fillers, fully drained.
  for (let i = 0; i < 40; i += 1) {
    net._onEvent({
      seq: i,
      kind: EVENT_KIND.PHASE_CHANGE,
      payload: { phase: 'waiting', slot: 'read' },
    });
  }
  assert.equal(net.drainEvents().length, 40);
  assert.equal(net._eventCursor, 40);
  assert.equal(net.recentEvents.length, 40);

  // First unread is the distinctive marker (would be at index 40).
  net._onEvent({
    seq: 40,
    kind: EVENT_KIND.TELEPORT,
    payload: { playerId: 'p1', kind: 'jumpPad', velocity: [0, 10, 0], marker: 'first-unread' },
  });
  assert.equal(net.recentEvents.length, 41);
  assert.equal(net._eventCursor, 40);

  // Grow past ring capacity (64): each push past 64 shifts a *read* event off
  // the front. One shift is enough for the false-green case.
  // length goes 41 → 65 triggers one shift (removes index 0, a read event).
  for (let i = 41; i < 65; i += 1) {
    net._onEvent({
      seq: i,
      kind: EVENT_KIND.PHASE_CHANGE,
      payload: { phase: 'waiting', slot: 'unread-filler' },
    });
  }
  // After one shift: length 64, marker should still be unread.
  assert.equal(net.recentEvents.length, 64);

  const drained = net.drainEvents();
  assert.ok(
    drained.some((e) => e.payload?.marker === 'first-unread'),
    `cursor must track first unread across shift; drained markers=${
      drained.map((e) => e.payload?.marker).filter(Boolean).join(',') || 'none'
    } cursor=${net._eventCursor}`,
  );

  // Monkey-patch regression: without decrement, the same sequence loses the marker.
  {
    const net2 = new DeathmatchNetworkSystem({
      host: 'x', room: 'y', displayName: 'T', now: () => wall,
      socketFactory: () => ({
        send() {}, close() {}, addEventListener() {}, removeEventListener() {}, bufferedAmount: 0,
      }),
    });
    net2._welcomed = true;
    // Broken ring push: shift without cursor fix.
    const brokenOnEvent = (msg) => {
      net2.recentEvents.push({ seq: msg.seq, kind: msg.kind, payload: msg.payload });
      if (net2.recentEvents.length > 64) {
        net2.recentEvents.shift();
        // intentionally NO cursor decrement
      }
    };
    for (let i = 0; i < 40; i += 1) {
      brokenOnEvent({ seq: i, kind: EVENT_KIND.PHASE_CHANGE, payload: { phase: 'waiting' } });
    }
    net2.drainEvents();
    brokenOnEvent({
      seq: 40,
      kind: EVENT_KIND.TELEPORT,
      payload: { marker: 'first-unread' },
    });
    for (let i = 41; i < 65; i += 1) {
      brokenOnEvent({ seq: i, kind: EVENT_KIND.PHASE_CHANGE, payload: { phase: 'waiting' } });
    }
    const brokenDrain = net2.drainEvents();
    assert.equal(
      brokenDrain.some((e) => e.payload?.marker === 'first-unread'),
      false,
      'control: broken cursor must skip first-unread (proves test is not false-green)',
    );
  }

  assert.deepEqual(net.drainEvents(), []);
  ok('drainEvents cursor decrements on shift; control fails without fix');
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Two-client MatchRoom + NetworkSystem integration
// ═══════════════════════════════════════════════════════════════════════════

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function createLoopbackPair() {
  const room = new MatchRoom({
    roomId: 'move-test',
    seed: 0x4d333031,
    config: { ...TEST_CONFIG },
    allowSoloStart: true,
  });
  room.state.allowSoloStart = true;

  const conns = new Map();
  let connSeq = 0;
  let now = 10_000;

  const broadcast = (frame) => {
    for (const c of conns.values()) c.deliver(frame);
  };
  const deliverTo = (connId, frame) => {
    const c = conns.get(connId);
    if (c) c.deliver(frame);
  };

  const flushOutbound = () => {
    const out = room.drainOutbound();
    for (const item of out) {
      const raw = JSON.stringify(item.msg);
      if (item.to === '*') broadcast(raw);
      else deliverTo(item.to, raw);
    }
  };

  const makeClient = (displayName) => {
    let activeSocket = null;

    const socketFactory = ({ query }) => {
      const listeners = {
        open: new Set(), message: new Set(), close: new Set(), error: new Set(),
      };
      const dispatch = (type, ev) => {
        for (const cb of listeners[type]) cb(ev);
      };

      let serverConnId = null;

      const open = () => {
        const q = typeof query === 'function' ? query() : query;
        serverConnId = `c${(connSeq += 1)}`;
        const result = room.connect(serverConnId, {
          displayName: q?.name ?? displayName,
          playerId: q?.pid,
          resumeToken: q?.token,
        }, now);
        if (result.error) {
          queueMicrotask(() => {
            dispatch('message', {
              data: JSON.stringify({
                v: V,
                type: SERVER_MSG.ERROR,
                code: 'capacity',
                recoverable: false,
                message: 'room is full',
              }),
            });
            dispatch('close', {});
          });
          return;
        }
        conns.set(serverConnId, {
          deliver(frame) {
            queueMicrotask(() => dispatch('message', { data: frame }));
          },
        });
        queueMicrotask(() => {
          flushOutbound();
          dispatch('open', {});
          flushOutbound();
        });
      };

      const socket = {
        bufferedAmount: 0,
        send(data) {
          if (!serverConnId) return;
          let decoded = data;
          try {
            decoded = typeof data === 'string' ? JSON.parse(data) : data;
          } catch {
            return;
          }
          room.message(serverConnId, decoded, now);
          flushOutbound();
        },
        close() {
          if (serverConnId && conns.has(serverConnId)) {
            room.disconnect(serverConnId, now);
            conns.delete(serverConnId);
            flushOutbound();
          }
          queueMicrotask(() => dispatch('close', {}));
        },
        addEventListener(type, cb) {
          listeners[type]?.add(cb);
        },
        removeEventListener(type, cb) {
          listeners[type]?.delete(cb);
        },
      };
      activeSocket = socket;
      queueMicrotask(open);
      return socket;
    };

    const net = new DeathmatchNetworkSystem({
      host: 'loopback',
      room: 'move-test',
      displayName,
      socketFactory,
      now: () => now,
    });

    return { net, get socket() { return activeSocket; } };
  };

  return {
    room,
    makeClient,
    tick(ms = 50) {
      now += ms;
      room.tick(now);
      flushOutbound();
    },
    get now() { return now; },
    flushOutbound,
  };
}

{
  const loop = createLoopbackPair();
  const a = loop.makeClient('Ada');
  const b = loop.makeClient('Boris');
  a.net.connect();
  b.net.connect();
  await settle();

  assert.equal(a.net.status, NET_STATUS.WELCOMED);
  assert.equal(b.net.status, NET_STATUS.WELCOMED);
  assert.notEqual(a.net.playerId, b.net.playerId);
  ok('two clients welcome with distinct playerIds');

  a.net.sendReady(true);
  b.net.sendReady(true);
  await settle();
  loop.tick(50);
  await settle();
  loop.tick(TEST_CONFIG.countdownMs + 10);
  await settle();
  assert.equal(loop.room.state.phase, MATCH_PHASE.RUNNING);
  ok('match reaches RUNNING after dual ready + countdown');

  const pa = loop.room.state.players.get(a.net.playerId);
  const pb = loop.room.state.players.get(b.net.playerId);
  assert.equal(pa.alive && pb.alive, true);

  const startA = [...pa.position];
  for (let i = 0; i < 6; i += 1) {
    a.net.send(buildPlayerStateMessage({
      seq: i + 1,
      clientTime: loop.now,
      position: [
        startA[0] + 0.5 * ((i + 1) / 6),
        startA[1],
        startA[2],
      ],
      velocity: [2, 0, 0],
      yaw: 0.3,
      pitch: 0,
      locomotionState: 'run',
      animation: {
        base: 'rifle_run_left', upper: 'rifle_reload', layered: true,
        attackLeg: null, attackLegWeight: 0, footwork: false,
        footworkLeg: null, footworkBody: null, mirrorX: false, lean: 0,
      },
    }));
    await settle();
    loop.tick(MOVEMENT.sampleIntervalMs);
    await settle();
  }

  const aOnB = b.net.players.find((p) => p.playerId === a.net.playerId);
  assert.ok(aOnB, 'B sees A in player list');
  assert.ok(
    Math.hypot(aOnB.position[0] - startA[0], aOnB.position[2] - startA[2]) > 0.1,
    'A movement replicated to B',
  );
  assert.equal(aOnB.locomotionState, 'run');
  assert.equal(aOnB.animation.base, 'rifle_run_left');
  assert.equal(aOnB.animation.upper, 'rifle_reload');
  ok('player_state samples replicate pose + layered animation graph to peer');

  const bufB = createRemotePlayerBuffer({ delayMs: DEFAULT_INTERP_DELAY_MS });
  for (let gen = 0; gen < 4; gen += 1) {
    loop.tick(50);
    await settle();
    for (const p of b.net.players) {
      if (p.playerId === b.net.playerId) continue;
      bufB.pushSample(p, b.net.serverTime || loop.now);
    }
  }
  const remotePose = bufB.sampleAt(a.net.playerId, b.net.estimateServerTime(loop.now));
  assert.ok(remotePose, 'B can interpolate A');
  assert.equal(remotePose.animation.base, 'rifle_run_left');
  assert.equal(remotePose.animation.upper, 'rifle_reload');
  assert.ok(bufB.snapshot().players[0].sampleCount <= MAX_SAMPLES_PER_PLAYER);
  ok('remote buffer on peer interpolates opponent under delay');

  const far = [startA[0] + 80, startA[1], startA[2]];
  a.net.send(buildPlayerStateMessage({
    seq: 100,
    clientTime: loop.now,
    position: far,
    velocity: [100, 0, 0],
    yaw: 0,
    pitch: 0,
    locomotionState: 'run',
  }));
  await settle();
  loop.tick(50);
  await settle();
  const corrected = a.net.getLocalPlayer();
  assert.ok(corrected);
  const moved = Math.hypot(corrected.position[0] - startA[0], corrected.position[2] - startA[2]);
  assert.ok(moved < 20, `server clamped teleport-speed move, moved=${moved}`);
  assert.equal(planCorrection(far, corrected.position).kind, 'hard');
  ok('server clamps illegal movement; client plans hard snap');

  // Jump pad event via network drain.
  const pad = RAIL_CRUCIBLE.jumpPads[0];
  const padPos = [
    (pad.bounds.min[0] + pad.bounds.max[0]) / 2,
    (pad.bounds.min[1] + pad.bounds.max[1]) / 2,
    (pad.bounds.min[2] + pad.bounds.max[2]) / 2,
  ];
  pa.position = [...padPos];
  pa.lastSampleAt = loop.now;
  pa.activeJumpPadId = null;
  a.net.drainEvents();
  a.net.send(buildPlayerStateMessage({
    seq: 200,
    clientTime: loop.now,
    position: padPos,
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    locomotionState: 'idle',
  }));
  await settle();
  const events = a.net.drainEvents();
  const jumpEv = events.find((e) => e.kind === EVENT_KIND.TELEPORT && e.payload?.kind === 'jumpPad');
  assert.ok(jumpEv, `expected jumpPad teleport event, got ${JSON.stringify(events.map((e) => e.kind))}`);
  ok('jump pad sample emits teleport event drained by client');

  // Teleporter round-trip: prev at entrance → sample with feature prediction
  // sends entrance → server ends at exit with TELEPORT event → local exit snap.
  const tp = RAIL_CRUCIBLE.teleporters[0];
  const tpPos = [
    (tp.bounds.min[0] + tp.bounds.max[0]) / 2,
    (tp.bounds.min[1] + tp.bounds.max[1]) / 2,
    (tp.bounds.min[2] + tp.bounds.max[2]) / 2,
  ];
  pa.alive = true;
  pa.position = [...tpPos];
  pa.lastSampleAt = loop.now;
  pa.lastInputSeq = 200;

  // Feature host wired to live client A.
  const featureChar = {
    group: {
      position: {
        x: tpPos[0], y: tpPos[1], z: tpPos[2],
        set(x, y, z) { this.x = x; this.y = y; this.z = z; },
      },
    },
    velocity: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    verticalVelocity: 0,
    yaw: 0,
    grounded: true,
    speed: 0,
  };
  const featureHost = {
    levelMode: 'deathmatch',
    networkSystem: a.net,
    remotePlayerSystem: {
      setLocalPlayerId() {}, ingestPlayers() {}, removePlayer() {}, update() {}, attach() {},
    },
    sceneSystem: { scene: {} },
    physicsSystem: { syncCharacterBody() {} },
    cameraSystem: { yaw: 0, pitch: 0 },
  };
  const liveFeature = new DeathmatchRuntimeFeature(featureHost);
  liveFeature.setNetworkSystem(a.net);
  liveFeature._sampleSeq = 200;
  liveFeature._lastSampleAt = 0;
  liveFeature._activePredictedTeleporterId = null;

  a.net.drainEvents();
  // sampleAndSend must put entrance on the wire then snap local to exit.
  liveFeature.sampleAndSend({
    character: featureChar,
    cameraSystem: featureHost.cameraSystem,
    nowMs: loop.now,
  });
  await settle();

  // Server accepted entrance → TELEPORT + exit pose.
  assert.deepEqual(
    pa.position,
    tp.exitPosition,
    `server must end at exit after entrance sample, got ${pa.position}`,
  );
  const tpEvents = a.net.drainEvents();
  const tpEv = tpEvents.find((e) => e.kind === EVENT_KIND.TELEPORT && e.payload?.kind === 'teleporter');
  assert.ok(tpEv, 'teleporter event emitted after entrance sample');
  assert.deepEqual(tpEv.payload.exitPosition, tp.exitPosition);
  // Local prediction after send.
  assert.ok(
    Math.abs(featureChar.group.position.x - tp.exitPosition[0]) < 1e-6
      && Math.abs(featureChar.group.position.z - tp.exitPosition[2]) < 1e-6,
    'client predicted exit after sending entrance',
  );
  ok('teleporter sample-then-predict: entrance sample → server exit + TELEPORT + local snap');

  // Peer disconnect: assert connected:false or leave event for B.
  const bId = b.net.playerId;
  a.net.drainEvents();
  b.net.dispose();
  await settle();
  loop.tick(50);
  await settle();
  const bAfter = a.net.players.find((p) => p.playerId === bId);
  const leaveEvents = a.net.recentEvents.filter(
    (e) => e.kind === EVENT_KIND.PLAYER_LEAVE && e.payload?.playerId === bId,
  );
  // markDisconnected keeps the player with connected:false (resume window).
  assert.ok(
    (bAfter && bAfter.connected === false) || leaveEvents.length > 0,
    `expected B disconnected or leave event; bAfter=${JSON.stringify(bAfter)} leave=${leaveEvents.length}`,
  );
  ok('peer disconnect reflects connected:false (or leave event) for B');

  a.net.dispose();
  assert.equal(a.net.socket, null);
  ok('network dispose clears socket');
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. bufferedAmount backpressure skips player_state
// ═══════════════════════════════════════════════════════════════════════════
{
  let sent = 0;
  const net = new DeathmatchNetworkSystem({
    host: 'x', room: 'y', displayName: 'T', now: () => 1,
    socketFactory: () => ({
      bufferedAmount: 50_000,
      send() { sent += 1; },
      close() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  net.socket = net._socketFactory({});
  net._disposed = false;
  const okSend = net.send({ type: CLIENT_MSG.READY, ready: true });
  // READY still sends (only player_state is coalesced).
  assert.equal(okSend, true);
  assert.equal(sent, 1);
  const skipped = net.send({
    type: CLIENT_MSG.PLAYER_STATE,
    seq: 1,
    clientTime: 1,
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
  });
  assert.equal(skipped, false);
  assert.equal(sent, 1, 'player_state dropped under backpressure');
  ok('bufferedAmount backpressure skips stale player_state samples');
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. RemotePlayerSystem join/leave lifecycle (Three under Node)
// ═══════════════════════════════════════════════════════════════════════════
{
  const remotes = new RemotePlayerSystem();
  remotes.setLocalPlayerId('p1');
  remotes.ingestPlayers([
    {
      playerId: 'p1',
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      locomotionState: 'idle',
      currentWeapon: 'midnight-glock',
      alive: true,
      connected: true,
      displayName: 'Local',
    },
    {
      playerId: 'p2',
      position: [3, 0, 1],
      velocity: [1, 0, 0],
      yaw: 0.5,
      pitch: 0,
      locomotionState: 'run',
      currentWeapon: 'desert-ar15',
      alive: true,
      connected: true,
      displayName: 'Boris',
    },
  ], 1000, { localPlayerId: 'p1' });

  assert.equal(remotes.puppets.size, 1, 'local player must not get a puppet');
  assert.ok(remotes.puppets.has('p2'));
  assert.equal(remotes.snapshot().puppetCount, 1);

  remotes.update({ delta: 0.016, serverTime: 1100 });
  const pose = remotes.buffer.sampleAt('p2', 1100);
  assert.ok(pose);

  remotes.removePlayer('p2');
  assert.equal(remotes.puppets.size, 0);
  assert.equal(remotes.buffer.tracks.size, 0);

  remotes.ingestPlayers([
    {
      playerId: 'p3',
      position: [1, 0, 1],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      locomotionState: 'idle',
      currentWeapon: 'midnight-glock',
      alive: true,
      connected: true,
      displayName: 'Cara',
    },
  ], 1200, { localPlayerId: 'p1' });
  assert.equal(remotes.puppets.size, 1);
  remotes.dispose();
  assert.equal(remotes.puppets.size, 0);
  assert.equal(remotes._disposed, true);
  ok('RemotePlayerSystem join/leave/dispose under Node Three');
}

console.log(`\nverify-deathmatch-movement: ${passed} checks passed`);
