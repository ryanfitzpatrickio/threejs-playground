/**
 * M6 remote shell presentation checks (pure node).
 *
 * Verifies locomotion→clip mapping and that RemotePlayerSystem still works in
 * capsule-fallback mode under node (no document → no GLB load). Full skinned
 * shells are browser-only via remotePlayerShellCache.
 *
 * Run: node scripts/verify-deathmatch-shell.mjs
 * Alias: npm run verify:deathmatch-shell
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RemotePlayerSystem } from '../src/game/systems/RemotePlayerSystem.js';
import {
  mapLocomotionToClip,
  canLoadRemoteShells,
  createRemoteShellInstance,
  REMOTE_LOCO_STATES,
} from '../src/game/net/remotePlayerShellCache.js';

let passed = 0;
const ok = (msg) => {
  passed += 1;
  console.log(`  ✓ ${msg}`);
};

{
  assert.equal(mapLocomotionToClip('idle'), 'armedIdle');
  assert.equal(mapLocomotionToClip('walk'), 'armedWalk');
  assert.equal(mapLocomotionToClip('run'), 'armedJog');
  assert.equal(mapLocomotionToClip('sprint'), 'armedSprint');
  assert.equal(mapLocomotionToClip('idle', { armed: false }), 'idle');
  assert.equal(mapLocomotionToClip('run', { armed: false }), 'jog');
  assert.ok(REMOTE_LOCO_STATES.includes('armedJog'));
  ok('locomotion labels map to Mara loco clip names');
}

{
  // A clone uses the same MaraAnimationController graph as the local player,
  // including upper-body reload, attack-leg blending, and turn footwork.
  const source = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = 'mixamorigHips';
  const leftLeg = new THREE.Bone();
  leftLeg.name = 'mixamorigLeftUpLeg';
  const spine = new THREE.Bone();
  spine.name = 'mixamorigSpine';
  hips.add(leftLeg, spine);
  source.add(hips);
  const clip = (name, boneName = 'mixamorigHips') => new THREE.AnimationClip(name, 1, [
    new THREE.QuaternionKeyframeTrack(
      `${boneName}.quaternion`,
      [0, 1],
      [0, 0, 0, 1, 0, 0, 0, 1],
    ),
  ]);
  const clips = new Map([
    ['idle', { clip: clip('idle'), loop: true }],
    ['rifle_run_left', { clip: clip('rifle_run_left', 'mixamorigLeftUpLeg'), loop: true }],
    ['rifle_reload', { clip: clip('rifle_reload', 'mixamorigSpine'), loop: false }],
    ['rifle_turn_left', { clip: clip('rifle_turn_left', 'mixamorigLeftUpLeg'), loop: false }],
    ['rifle_aim_idle', { clip: clip('rifle_aim_idle', 'mixamorigSpine'), loop: true }],
    ['lightSlash1', { clip: clip('lightSlash1'), loop: false }],
  ]);
  const shell = createRemoteShellInstance({
    modelRoot: source,
    clips,
    skeletonSource: 'mixamo',
  });
  shell.applyAnimation({
    base: 'rifle_run_left', upper: 'rifle_reload', layered: true,
    attackLeg: 'lightSlash1', attackLegWeight: 0.4,
    footwork: false, footworkLeg: null, footworkBody: null,
    mirrorX: false, lean: 0.2,
  }, 'idle');
  shell.update(1 / 60);
  assert.equal(shell.controller.currentState, 'rifle_run_left');
  assert.equal(shell.controller.upperBodyState, 'rifle_reload');
  assert.equal(shell.controller.attackLegState, 'lightSlash1');
  assert.equal(shell.controller.attackLegTarget, 0.4);

  shell.applyAnimation({
    base: 'rifle_aim_idle', upper: null, layered: true,
    attackLeg: null, attackLegWeight: 0,
    footwork: true, footworkLeg: 'rifle_turn_left', footworkBody: 'rifle_aim_idle',
    mirrorX: true, lean: 0,
  }, 'idle');
  shell.update(1 / 60);
  assert.equal(shell.controller.footworkActive, true);
  assert.equal(shell.controller.footworkLegState, 'rifle_turn_left');
  assert.equal(shell.controller.mirrorX, -1);
  shell.dispose();
  ok('remote shell replays full-body, layered, attack-leg, and footwork states');
}

{
  // Node has no document → shells unavailable → capsules only.
  assert.equal(canLoadRemoteShells(), false);
  const remotes = new RemotePlayerSystem();
  remotes.attach(new THREE.Scene());
  remotes.setLocalPlayerId('me');
  remotes.ingestPlayers([
    {
      playerId: 'peer',
      displayName: 'B',
      position: [10, 0, -4],
      velocity: [3, 0, 0],
      yaw: 0.2,
      pitch: 0,
      alive: true,
      connected: true,
      locomotionState: 'run',
      currentWeapon: 'midnight-glock',
    },
  ], 1000, { localPlayerId: 'me' });
  remotes.update({ delta: 0.016, serverTime: 1000 });
  const snap = remotes.snapshot();
  assert.equal(snap.puppetCount, 1);
  assert.equal(snap.puppets[0].visible, true);
  assert.equal(snap.puppets[0].shell, false, 'node must stay capsule fallback');
  assert.ok(snap.shellMode === 'pending' || snap.shellMode === 'capsule-fallback');
  remotes.playFire('peer');
  remotes.flashHit('peer');
  remotes.update({ delta: 0.05, serverTime: 1050 });
  remotes.dispose();
  remotes.dispose(); // idempotent
  ok('node capsule fallback + fire/hit cosmetics + dispose');
}

{
  // Dead stays hidden (match-only).
  const remotes = new RemotePlayerSystem();
  remotes.attach(new THREE.Scene());
  remotes.ingestPlayers([
    {
      playerId: 'ghost',
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      alive: false,
      connected: true,
      locomotionState: 'idle',
    },
  ], 1, { localPlayerId: 'me' });
  remotes.update({ delta: 0.016, serverTime: 1 });
  assert.equal(remotes.snapshot().puppets[0].visible, false);
  remotes.dispose();
  ok('dead remotes stay hidden (no lobby shells)');
}

console.log(`\n✓ deathmatch shell: ${passed} checks passed`);
