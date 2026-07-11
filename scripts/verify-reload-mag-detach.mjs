// AR1 regression for magazine part extraction / re-attachment
// (docs/advanced-reload-system-plan.md). Builds synthetic gun hierarchies (a
// rifle and a pistol) with a named, annotated magazine mesh, then asserts the
// magazineParts helpers: the mag is found by identity+behavior, detach preserves
// its world transform under a carrier, and re-attach restores the exact original
// parent + gun-local transform (round-trips within tolerance) with no leaks.
//
// Pure node with the real Three math (no WebGPU). AR2 will extend this with the
// physics drop. Run: node scripts/verify-reload-mag-detach.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  isMagazinePart,
  findMagazineParts,
  findMagazineMeshes,
  detachMagazine,
  reattachMagazine,
} from '../src/game/weapons/magazineParts.js';
import { createDroppedMagazineManager } from '../src/game/weapons/droppedMagazines.js';
import { FirstPersonWeaponSystem } from '../src/game/systems/FirstPersonWeaponSystem.js';
import {
  reloadDebugSocket,
  resetReloadDebugSocket,
} from '../src/game/weapons/reloadDebugSocket.js';

/** Build a gun root with receiver > magazine and a matching profile. */
function makeGun({ magName, rootPose, receiverPose, magPose }) {
  const root = new THREE.Group();
  root.name = 'gunRoot';
  root.position.fromArray(rootPose.p);
  root.quaternion.fromArray(rootPose.q);

  const receiver = new THREE.Object3D();
  receiver.name = 'receiver';
  receiver.position.fromArray(receiverPose.p);
  receiver.quaternion.fromArray(receiverPose.q);
  root.add(receiver);

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.03));
  mag.name = magName;
  mag.position.fromArray(magPose.p);
  mag.quaternion.fromArray(magPose.q);
  receiver.add(mag);

  // A decoy non-magazine part to prove filtering.
  const rail = new THREE.Object3D();
  rail.name = 'rail';
  receiver.add(rail);

  root.updateMatrixWorld(true);

  const profile = {
    parts: [
      { meshName: 'rail', identity: 'misc', behaviors: [] },
      { meshName: magName, identity: 'magazine', behaviors: ['detaches_on_reload'] },
    ],
  };
  return { root, receiver, mag, profile };
}

const q = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray();

function maxMatrixDiff(a, b) {
  let m = 0;
  for (let i = 0; i < 16; i += 1) m = Math.max(m, Math.abs(a.elements[i] - b.elements[i]));
  return m;
}

// --- Part predicate + lookup ------------------------------------------------
assert.equal(isMagazinePart({ identity: 'magazine', behaviors: ['detaches_on_reload'] }), true);
assert.equal(isMagazinePart({ identity: 'magazine', behaviors: [] }), false, 'magazine without behavior is not detachable');
assert.equal(isMagazinePart({ identity: 'grip', behaviors: ['detaches_on_reload'] }), false, 'wrong identity');

for (const spec of [
  {
    label: 'rifle',
    magName: 'ar_magazine',
    rootPose: { p: [1.2, 1.5, -0.4], q: q(0.1, 0.7, -0.2) },
    receiverPose: { p: [0.02, -0.03, 0.05], q: q(0, 0.15, 0) },
    magPose: { p: [0, -0.08, 0.04], q: q(0.05, 0, 0.02) },
  },
  {
    label: 'pistol',
    magName: 'glock_mag',
    rootPose: { p: [-0.6, 1.1, 0.3], q: q(-0.2, 1.4, 0.1) },
    receiverPose: { p: [0, 0, 0], q: q(0, 0, 0) },
    magPose: { p: [0, -0.10, 0.0], q: q(0, 0, 0) },
  },
]) {
  const { root, receiver, mag, profile } = makeGun(spec);

  const parts = findMagazineParts(profile);
  assert.equal(parts.length, 1, `${spec.label}: exactly one magazine part`);
  const found = findMagazineMeshes(root, profile);
  assert.equal(found.length, 1, `${spec.label}: mag mesh resolved`);
  assert.equal(found[0].mesh, mag, `${spec.label}: resolved the right mesh`);

  // Capture the pre-detach world transform.
  mag.updateWorldMatrix(true, false);
  const worldBefore = mag.matrixWorld.clone();

  // A carrier standing in for the left hand, placed somewhere unrelated.
  const holder = new THREE.Object3D();
  holder.name = 'leftHand';
  holder.position.set(0.4, 1.2, -0.1);
  holder.quaternion.copy(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.5, 0.2)));
  const carrierRoot = new THREE.Group();
  carrierRoot.add(holder);
  carrierRoot.updateMatrixWorld(true);

  const record = detachMagazine(mag, holder);
  assert.ok(record, `${spec.label}: detach returns a record`);
  assert.equal(mag.parent, holder, `${spec.label}: mag now rides the carrier`);
  assert.equal(record.originalParent, receiver, `${spec.label}: original parent captured`);

  mag.updateWorldMatrix(true, false);
  const worldDetached = mag.matrixWorld.clone();
  assert.ok(maxMatrixDiff(worldBefore, worldDetached) < 1e-5,
    `${spec.label}: world transform preserved through detach (Δ=${maxMatrixDiff(worldBefore, worldDetached)})`);

  // Re-attach and confirm an exact round-trip.
  assert.equal(reattachMagazine(record), true, `${spec.label}: reattach succeeds`);
  assert.equal(mag.parent, receiver, `${spec.label}: mag back under its original parent`);
  assert.equal(holder.children.length, 0, `${spec.label}: carrier left empty (no leaked parent)`);

  mag.updateWorldMatrix(true, false);
  const worldAfter = mag.matrixWorld.clone();
  assert.ok(maxMatrixDiff(worldBefore, worldAfter) < 1e-5,
    `${spec.label}: world transform recovered after reattach (Δ=${maxMatrixDiff(worldBefore, worldAfter)})`);

  // Local transform recovered too (within ~1 mm / tiny rotation).
  assert.ok(mag.position.distanceTo(new THREE.Vector3().fromArray(spec.magPose.p)) < 1e-4,
    `${spec.label}: local position restored`);
}

// --- No magazine annotation → nothing found, helpers stay safe --------------
{
  const root = new THREE.Group();
  const bare = { parts: [{ meshName: 'x', identity: 'misc', behaviors: [] }] };
  assert.deepEqual(findMagazineMeshes(root, bare), []);
  assert.equal(detachMagazine(null, new THREE.Object3D()), null);
  assert.equal(reattachMagazine(null), false);
}

// --- AR4: fresh magazine cycles from left hand into the socket ---------------
{
  const { root, receiver, mag, profile } = makeGun({
    magName: 'cycle_mag',
    rootPose: { p: [0, 0, 0], q: q(0, 0, 0) },
    receiverPose: { p: [0.1, 0.2, -0.3], q: q(0, 0.2, 0) },
    magPose: { p: [0, -0.08, 0.04], q: q(0, 0, 0) },
  });
  profile.anchors = [
    { name: 'mag_insert', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  ];
  // Place mag_socket on the mag origin so insert-local capture is ~identity.
  const magSocket = new THREE.Object3D();
  root.add(magSocket);
  const beltSource = new THREE.Object3D();
  beltSource.position.set(0.35, -0.35, 0.1);
  root.add(beltSource);
  const leftHand = new THREE.Object3D();
  leftHand.position.set(-0.2, 1.1, 0.5);
  const scene = new THREE.Group();
  scene.add(root, leftHand);
  scene.updateMatrixWorld(true);
  {
    const magWorld = new THREE.Vector3();
    mag.getWorldPosition(magWorld);
    root.worldToLocal(magWorld);
    magSocket.position.copy(magWorld);
    scene.updateMatrixWorld(true);
  }

  const fp = new FirstPersonWeaponSystem();
  fp.gunView = { root, profile, anchors: { mag_socket: magSocket, mag_belt_source: beltSource } };
  fp.handIk = { leftHandBone: leftHand, setWeapon() {}, dispose() {} };

  // Capture pre-drop gun-local pose so we can assert the closed seat cycle.
  const seatedLocal = {
    position: mag.position.clone(),
    quaternion: mag.quaternion.clone(),
    scale: mag.scale.clone(),
  };
  mag.updateWorldMatrix(true, false);
  const seatedWorldScale = new THREE.Vector3();
  mag.getWorldScale(seatedWorldScale);

  assert.equal(fp.handleReloadMagazinePhase('mag_drop'), true, 'AR4 removes the spent mag from the well');
  assert.equal(mag.parent, null, 'spent source mesh is no longer seated');
  assert.equal(fp.handleReloadMagazinePhase('mag_spawn'), true, 'AR4 creates a fresh mag at the left hand');
  // Zero mag-carry fudge so insert lands on the hold point for this pure test.
  reloadDebugSocket.magCarryPosition = [0, 0, 0];
  reloadDebugSocket.magCarryRotationDeg = [0, 0, 0];
  // Mag rides a carrier under the left-hand IK bone (not a finger).
  const carrier = leftHand.getObjectByName('ReloadMagCarrier');
  assert.ok(carrier, 'reload mag carrier is under the left-hand bone');
  assert.equal(carrier.parent, leftHand, 'carrier parents to IK hand bone');
  const fresh = carrier.children.find((child) => child.name === 'cycle_mag');
  assert.ok(fresh, 'fresh magazine rides the left-hand carrier');
  fp._updateCarriedMagazinePose();
  // Frozen local pose: re-update must not stack or drift.
  const localA = fresh.position.clone();
  fp._updateCarriedMagazinePose();
  fp._updateCarriedMagazinePose();
  assert.ok(fresh.position.distanceTo(localA) < 1e-6, 'carry pose is stable across frames');
  leftHand.position.set(1.5, 2.0, -0.5);
  scene.updateMatrixWorld(true);
  const handPos = new THREE.Vector3();
  const magPos = new THREE.Vector3();
  leftHand.getWorldPosition(handPos);
  fresh.getWorldPosition(magPos);
  // Insert at identity → mag origin sits on the hold point (hand origin here).
  assert.ok(magPos.distanceTo(handPos) < 0.02, 'insert-aligned mag sits on the hand anchor');
  const movedHand = handPos.clone();
  leftHand.position.set(-0.4, 0.2, 1.1);
  scene.updateMatrixWorld(true);
  leftHand.getWorldPosition(handPos);
  fresh.getWorldPosition(magPos);
  assert.ok(magPos.distanceTo(handPos) < 0.02, 'fresh magazine follows the left hand after a second move');
  assert.ok(handPos.distanceTo(movedHand) > 0.5, 'hand actually moved between samples');
  const freshWorldScale = new THREE.Vector3();
  fresh.getWorldScale(freshWorldScale);
  assert.ok(freshWorldScale.distanceTo(seatedWorldScale) < 1e-4,
    'fresh magazine keeps its authored world scale on the hand');

  assert.equal(fp.handleReloadMagazinePhase('mag_seat'), true, 'AR4 seats the fresh magazine');
  assert.equal(fresh.parent, receiver, 'fresh magazine returns under the original receiver');
  assert.equal(leftHand.getObjectByName('ReloadMagCarrier'), undefined,
    'hand carrier is removed after seat');
  // Seat always snaps mag_insert → mag_socket (world), not a blind GLB local restore.
  fresh.updateWorldMatrix(true, false);
  magSocket.updateWorldMatrix(true, false);
  const seatMag = new THREE.Vector3();
  const seatSock = new THREE.Vector3();
  fresh.getWorldPosition(seatMag);
  magSocket.getWorldPosition(seatSock);
  assert.ok(seatMag.distanceTo(seatSock) < 1e-4,
    'seated mag insert (origin here) lands on mag_socket');
  assert.ok(fresh.scale.distanceTo(seatedLocal.scale) < 1e-6,
    'fresh magazine keeps authored local scale under the gun');
  assert.equal(findMagazineMeshes(root, profile)[0]?.mesh, fresh,
    'next reload resolves the newly seated magazine');
  resetReloadDebugSocket();
}

// --- AR4 scale: Mixamo armature (0.01) must not balloon Meshy mag scale -------
{
  const { root, receiver, mag, profile } = makeGun({
    magName: 'tiny_mag',
    rootPose: { p: [0, 0, 0], q: q(0, 0, 0) },
    receiverPose: { p: [0, 0, 0], q: q(0, 0, 0) },
    magPose: { p: [0, -0.08, 0], q: q(0, 0, 0) },
  });
  // Simulate a Meshy import: huge geometry authored with tiny local scale under
  // a scaled container, matching desert-ar15's mesh_4 hierarchy.
  mag.scale.setScalar(0.0001);
  const importScale = new THREE.Group();
  importScale.scale.setScalar(0.46);
  root.add(importScale);
  importScale.add(receiver);

  profile.anchors = [
    { name: 'mag_insert', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
  ];
  const magSocket = new THREE.Object3D();
  magSocket.position.set(0, -0.08, 0);
  root.add(magSocket);
  const beltSource = new THREE.Object3D();
  beltSource.position.set(0.2, -0.4, 0.1);
  root.add(beltSource);

  // Mixamo-like hand under armature scale 0.01.
  const armature = new THREE.Group();
  armature.scale.setScalar(0.01);
  const leftHand = new THREE.Object3D();
  leftHand.position.set(0, 100, 0); // 1 m in world after armature scale
  armature.add(leftHand);

  const scene = new THREE.Group();
  scene.add(root, armature);
  scene.updateMatrixWorld(true);

  mag.updateWorldMatrix(true, false);
  const preScale = new THREE.Vector3();
  mag.getWorldScale(preScale);
  const preBox = new THREE.Box3().setFromObject(mag);
  const preSize = preBox.getSize(new THREE.Vector3()).length();

  const fp = new FirstPersonWeaponSystem();
  fp.gunView = { root, profile, anchors: { mag_socket: magSocket, mag_belt_source: beltSource } };
  fp.handIk = { leftHandBone: leftHand };
  reloadDebugSocket.magCarryPosition = [0, 0, 0];
  reloadDebugSocket.magCarryRotationDeg = [0, 0, 0];

  // Socket on mag origin so insert-local is identity (align origin → hand).
  scene.updateMatrixWorld(true);
  {
    const mw = new THREE.Vector3();
    mag.getWorldPosition(mw);
    root.worldToLocal(mw);
    magSocket.position.copy(mw);
    scene.updateMatrixWorld(true);
  }

  assert.equal(fp.handleReloadMagazinePhase('mag_drop'), true);
  assert.equal(fp.handleReloadMagazinePhase('mag_spawn'), true);
  const carrier = leftHand.getObjectByName('ReloadMagCarrier');
  assert.ok(carrier, 'tiny mag uses a hand carrier');
  const fresh = carrier.children.find((c) => c.name === 'tiny_mag');
  assert.ok(fresh, 'tiny mag clones onto the hand carrier');
  fp._updateCarriedMagazinePose();
  fresh.updateWorldMatrix(true, false);
  const midScale = new THREE.Vector3();
  fresh.getWorldScale(midScale);
  assert.ok(midScale.distanceTo(preScale) < 1e-5,
    `hand world scale preserved (got ${midScale.toArray()}, want ${preScale.toArray()})`);
  const midBox = new THREE.Box3().setFromObject(fresh);
  const midSize = midBox.getSize(new THREE.Vector3()).length();
  assert.ok(Math.abs(midSize - preSize) / Math.max(preSize, 1e-8) < 0.05,
    `hand-held mag size stays ~authored (${midSize.toFixed(4)} vs ${preSize.toFixed(4)})`);
  // Follows the hand after a bone move (carrier counter-scale stays valid).
  leftHand.position.set(0, 200, 0);
  scene.updateMatrixWorld(true);
  fp._updateCarriedMagazinePose();
  const handW = new THREE.Vector3();
  const magW = new THREE.Vector3();
  leftHand.getWorldPosition(handW);
  fresh.getWorldPosition(magW);
  assert.ok(magW.distanceTo(handW) < 0.05, 'tiny mag insert stays on the hand anchor');

  assert.equal(fp.handleReloadMagazinePhase('mag_seat'), true);
  assert.equal(fresh.parent, receiver, 'tiny mag reseats under receiver');
  fresh.updateWorldMatrix(true, false);
  const postScale = new THREE.Vector3();
  fresh.getWorldScale(postScale);
  assert.ok(postScale.distanceTo(preScale) < 1e-5, 'seated world scale matches pre-drop');
  resetReloadDebugSocket();
}

// Legacy Gunsmith profiles currently label every GLB mesh as `misc`. AR4 still
// needs to communicate a fresh mag in that case, so it falls back to a compact
// runtime proxy until an authored detachable part is tagged.
{
  const root = new THREE.Group();
  const magSocket = new THREE.Object3D();
  const beltSource = new THREE.Object3D();
  beltSource.position.set(0.2, -0.3, 0.05);
  root.add(magSocket, beltSource);
  const leftHand = new THREE.Object3D();
  const scene = new THREE.Group();
  scene.add(root, leftHand);
  scene.updateMatrixWorld(true);

  const fp = new FirstPersonWeaponSystem();
  fp.gunView = {
    root,
    profile: {
      parts: [],
      anchors: [{ name: 'mag_insert', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }],
    },
    anchors: { mag_socket: magSocket, mag_belt_source: beltSource },
  };
  fp.handIk = { leftHandBone: leftHand };

  assert.equal(fp.handleReloadMagazinePhase('mag_drop'), true, 'fallback begins for unannotated profile');
  assert.equal(fp.handleReloadMagazinePhase('mag_spawn'), true, 'fallback fresh mag appears at the left hand');
  const carrier = leftHand.getObjectByName('ReloadMagCarrier');
  assert.ok(carrier?.children.some((child) => child.userData.reloadFallbackMagazine),
    'fallback is visibly parented under the hand carrier');
  assert.equal(fp.handleReloadMagazinePhase('mag_seat'), true, 'fallback mag seats at the socket');
  assert.ok(root.children.some((child) => child.userData.reloadFallbackMagazine), 'seated fallback remains on the gun');
  fp._clearFallbackMagazine();
  fp._fallbackMagazineGeometry?.dispose();
  fp._fallbackMagazineMaterial?.dispose();
}

// --- AR2: old-magazine physics drop (real Rapier world) ---------------------
await RAPIER.init();
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), floor);
  // Minimal physics facade the manager needs (no interpolation → live pose sync).
  const physicsSystem = { RAPIER, world, interpolationAlpha: 1, sampleInterpolatedPose: () => null };

  const scene = new THREE.Group();
  const manager = createDroppedMagazineManager(scene, { lifetime: 1.0, fadeDuration: 0.2 });

  // A magazine mesh at a known world pose (0.05 × 0.15 × 0.03 m).
  const magSize = [0.05, 0.15, 0.03];
  const mag = new THREE.Mesh(new THREE.BoxGeometry(...magSize), new THREE.MeshStandardMaterial());
  mag.position.set(1, 1.5, -2);
  scene.add(mag);
  scene.updateMatrixWorld(true);

  const prop = manager.drop({ magMesh: mag, physicsSystem });
  assert.ok(prop && prop.body, 'drop spawns a dynamic body');
  assert.equal(scene.children.includes(prop.mesh), true, 'dropped mesh added to the scene');
  assert.equal(manager.props.length, 1, 'manager tracks the prop');

  // Body spawns at the magazine's last world transform, with downward velocity.
  const t0 = prop.body.translation();
  assert.ok(Math.hypot(t0.x - 1, t0.y - 1.5, t0.z + 2) < 1e-4, 'body at the mag world position');
  assert.ok(prop.body.linvel().y < 0, 'initial velocity is downward');

  // One cuboid collider, sized within the magazine's bounds.
  assert.equal(prop.body.numColliders(), 1, 'single collider');
  const he = prop.body.collider(0).halfExtents();
  assert.ok(he, 'collider is a cuboid (has half extents)');
  assert.ok(he.x > 0 && he.y > 0 && he.z > 0, 'non-degenerate extents');
  assert.ok(
    he.x <= magSize[0] * 0.5 + 1e-3 && he.y <= magSize[1] * 0.5 + 1e-3 && he.z <= magSize[2] * 0.5 + 1e-3,
    `collider within mag bounds (${he.x.toFixed(3)},${he.y.toFixed(3)},${he.z.toFixed(3)})`,
  );

  // Step the sim: the mag falls, and the mesh tracks the body.
  const yStart = prop.body.translation().y;
  for (let i = 0; i < 30; i += 1) { world.step(); manager.update({ delta: 1 / 60, physicsSystem }); }
  const yAfter = prop.body.translation().y;
  assert.ok(yAfter < yStart - 0.05, `dropped mag fell (${yStart.toFixed(3)} → ${yAfter.toFixed(3)})`);
  assert.ok(Math.abs(prop.mesh.position.y - yAfter) < 1e-3, 'mesh synced to the falling body');

  // Runs out its lifetime → despawns (body freed, mesh removed).
  for (let i = 0; i < 120; i += 1) { world.step(); manager.update({ delta: 1 / 60, physicsSystem }); }
  assert.equal(manager.props.length, 0, 'prop despawned on lifetime');
  assert.equal(prop.body, null, 'rigid body reference cleared on despawn');
  assert.equal(scene.children.includes(prop.mesh), false, 'mesh removed from the scene on despawn');

  // Concurrent-drop budget: never exceeds capacity.
  for (let i = 0; i < 12; i += 1) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...magSize), mag.material);
    m.position.set(0, 5, 0);
    scene.add(m);
    scene.updateMatrixWorld(true);
    manager.drop({ magMesh: m, physicsSystem });
  }
  assert.ok(manager.props.length <= 8, `concurrent dropped mags capped (${manager.props.length} ≤ 8)`);
  manager.dispose();
  assert.equal(manager.props.length, 0, 'dispose clears all props');
}

console.log('verify-reload-mag-detach: all checks passed');
