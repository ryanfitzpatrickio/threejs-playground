#!/usr/bin/env node
/**
 * M4: pure unit checks for hand-IK helpers + gun view anchors.
 * WebGPU-safe two-bone solver must NOT expand skeleton.bones.
 *
 * Usage: node scripts/verify-fp-ik.mjs
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createFirstPersonHandIk,
  findRightHandBone,
} from '../src/game/characters/player/firstPersonHandIk.js';
import { HAND_IK_MAX_DISTANCE } from '../src/game/characters/player/firstPersonRig.js';
import {
  applyAnchorObjectTransform,
  createDefaultAnchor,
  findAnchor,
  createStubAnchors,
} from '../src/game/weapons/gunAnchors.js';
import { createCatalogStubProfile, GUN_CATALOG } from '../src/game/weapons/gunProfile.js';
import { createGun } from '../src/game/weapons/createGun.js';
import {
  anchorsNeedCanonicalRebuild,
  defaultGunIdFromQuery,
} from '../src/game/weapons/loadGunView.js';
import { gunDebugSocket } from '../src/game/weapons/gunDebugSocket.js';

assert.ok(HAND_IK_MAX_DISTANCE >= 2);
assert.equal(defaultGunIdFromQuery(), 'desert-ar15');
assert.equal(anchorsNeedCanonicalRebuild([
  createDefaultAnchor('muzzle', { position: [-0.46, 0.19, 0] }),
  createDefaultAnchor('stock_shoulder', { position: [0.45, 0.2, 0] }),
]), true, 'legacy X-forward anchors must rebuild after mesh orientation');
assert.equal(anchorsNeedCanonicalRebuild([
  createDefaultAnchor('muzzle', { position: [0, 0.19, -0.46] }),
  createDefaultAnchor('stock_shoulder', { position: [0, 0.2, 0.45] }),
]), false, 'canonical Z-forward anchors must be preserved');

// --- Anchor stubs on every catalog kind ---
for (const entry of GUN_CATALOG) {
  const profile = createCatalogStubProfile(entry, ['mesh_0']);
  const gun = createGun(profile);
  assert.ok(gun.getAnchor('grip_mount'), `${entry.id} grip_mount`);
  assert.ok(gun.getAnchor('muzzle'), `${entry.id} muzzle`);
  if (entry.weaponKind !== 'pistol') {
    assert.ok(gun.getAnchor('left_hand_ik_target'), `${entry.id} left_hand_ik_target`);
  }
}

// --- Anchor Object3D placement ---
{
  const root = new THREE.Group();
  const grip = new THREE.Object3D();
  grip.name = 'gun_anchor_grip_mount';
  applyAnchorObjectTransform(grip, createDefaultAnchor('grip_mount', { position: [0.01, 0.02, 0.03] }));
  root.add(grip);
  assert.ok(Math.abs(grip.position.x - 0.01) < 1e-6);
  const found = findAnchor(createStubAnchors('rifle'), 'muzzle');
  assert.equal(found.name, 'muzzle');
}

// --- Missing right arm → null ---
{
  const bare = new THREE.Group();
  assert.equal(createFirstPersonHandIk(bare), null);
}

// --- Scene-graph bones only (no SkinnedMesh) — WebGPU-safe path ---
{
  const modelRoot = new THREE.Group();
  modelRoot.name = 'Model';
  const bodyRoot = new THREE.Group();
  bodyRoot.add(modelRoot);

  function addBone(name, parent) {
    const b = new THREE.Bone();
    b.name = name;
    parent.add(b);
    return b;
  }
  const hips = addBone('mixamorigHips', modelRoot);
  const spine = addBone('mixamorigSpine', hips);
  const rArm = addBone('mixamorigRightArm', spine);
  const rFore = addBone('mixamorigRightForeArm', rArm);
  const rHand = addBone('mixamorigRightHand', rFore);
  rArm.position.set(0.2, 0.4, 0);
  rFore.position.set(0.25, 0, 0);
  rHand.position.set(0.25, 0, 0);
  const lArm = addBone('mixamorigLeftArm', spine);
  const lFore = addBone('mixamorigLeftForeArm', lArm);
  const lHand = addBone('mixamorigLeftHand', lFore);
  lArm.position.set(-0.2, 0.4, 0);
  lFore.position.set(-0.25, 0, 0);
  lHand.position.set(-0.25, 0, 0);
  modelRoot.updateMatrixWorld(true);

  // With a skinned mesh, ensure we NEVER grow skeleton.bones.
  const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const n = geo.attributes.position.count;
  const skinIndex = new THREE.BufferAttribute(new Uint16Array(n * 4), 4);
  const skinWeight = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
  for (let i = 0; i < n; i += 1) {
    skinIndex.setXYZW(i, 0, 0, 0, 0);
    skinWeight.setXYZW(i, 1, 0, 0, 0);
  }
  geo.setAttribute('skinIndex', skinIndex);
  geo.setAttribute('skinWeight', skinWeight);
  const allBones = [];
  modelRoot.traverse((c) => { if (c.isBone) allBones.push(c); });
  const skeleton = new THREE.Skeleton(allBones);
  const boneCountBefore = skeleton.bones.length;
  const matricesBytesBefore = skeleton.boneMatrices.byteLength;
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  mesh.add(hips);
  mesh.bind(skeleton);
  modelRoot.add(mesh);

  const ik = createFirstPersonHandIk(modelRoot, bodyRoot);
  assert.ok(ik, 'IK rig should construct from named arm bones');
  assert.equal(skeleton.bones.length, boneCountBefore, 'must not push IK target bones onto skeleton');
  assert.equal(
    skeleton.boneMatrices.byteLength,
    matricesBytesBefore,
    'boneMatrices byteLength must stay fixed (WebGPU UBO)',
  );

  const gunRoot = new THREE.Group();
  const grip = new THREE.Object3D();
  grip.name = 'gun_anchor_grip_mount';
  gunRoot.add(grip);
  const support = new THREE.Object3D();
  support.name = 'gun_anchor_left_hand_ik_target';
  support.position.set(0.05, 0, 0.15);
  gunRoot.add(support);
  const adsCamera = new THREE.Object3D();
  adsCamera.name = 'gun_anchor_adsCamera';
  adsCamera.position.set(0.08, 0.12, -0.04);
  gunRoot.add(adsCamera);

  ik.setWeapon(gunRoot, { grip_mount: grip, left_hand_ik_target: support, adsCamera });
  ik.updateWeaponAnchorFromRightHand();
  ik.updateRightHandIk({ snapAnchorToGrip: true });
  ik.updateLeftHandIk();

  assert.equal(skeleton.bones.length, boneCountBefore);
  assert.equal(skeleton.boneMatrices.byteLength, matricesBytesBefore);

  const measure = ik.measure();
  assert.equal(measure.solver, 'bodyAnchored+dualIk');
  assert.equal(measure.hasGun, true);

  // ADS moves the gun, not the gameplay camera: the authored sight socket must
  // land on the camera eye at full blend and restore at zero blend.
  {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(-0.17, 0.61, -0.22);
    bodyRoot.add(camera);
    bodyRoot.updateMatrixWorld(true);
    const restPosition = gunRoot.position.clone();
    const sightWorld = new THREE.Vector3();
    const cameraWorld = new THREE.Vector3();
    const sightRotation = new THREE.Quaternion();
    const cameraRotation = new THREE.Quaternion();
    camera.rotation.set(-0.12, 0.27, 0, 'YXZ');

    ik.setAdsPose(camera, 1);
    ik.layoutGunInHand({ force: true });
    adsCamera.getWorldPosition(sightWorld);
    camera.getWorldPosition(cameraWorld);
    adsCamera.getWorldQuaternion(sightRotation);
    camera.getWorldQuaternion(cameraRotation);
    assert.ok(
      sightWorld.distanceTo(cameraWorld) < 1e-6,
      'full ADS should align adsCamera socket to the gameplay camera eye',
    );
    assert.ok(
      sightRotation.angleTo(cameraRotation) < 1e-6,
      'full ADS should align the authored sight axis to the gameplay camera',
    );

    ik.setAdsPose(camera, 0);
    ik.layoutGunInHand({ force: true });
    assert.ok(
      gunRoot.position.distanceTo(restPosition) < 1e-6,
      'releasing ADS should restore the authored hip-fire pose',
    );
  }

  // Right-hand IK must pull the dominant hand toward grip_mount: reset the arm to
  // a raw pose, measure the gap, solve, and confirm the gap shrinks.
  gunDebugSocket.rightIkEnabled = true;
  rArm.quaternion.identity();
  rFore.quaternion.identity();
  rHand.quaternion.identity();
  modelRoot.updateMatrixWorld(true);
  ik.updateWeaponFromRightHand?.();
  const beforeRightCm = ik.measure().rightHandToGripCm;
  // dt:1 snaps the IK blend weight to full so the solve is deterministic here.
  ik.updateRightHandIk({ dt: 1 });
  const afterRightCm = ik.measure().rightHandToGripCm;
  assert.ok(beforeRightCm != null && afterRightCm != null, 'right grip distance measured');
  assert.ok(
    afterRightCm < beforeRightCm - 1e-3,
    `right hand IK should close the grip gap (${beforeRightCm?.toFixed(2)} → ${afterRightCm?.toFixed(2)} cm)`,
  );

  assert.equal(findRightHandBone(modelRoot)?.name, 'mixamorigRightHand');

  // Palm must hard-lock through simulated loco: animation yanks the wrist each
  // frame; after IK the hand world quat must match the support target.
  {
    gunDebugSocket.leftIkEnabled = true;
    gunDebugSocket.leftIkHandBlend = 0.89; // used to soft-slerp and residual-twist
    const targetQ = new THREE.Quaternion();
    const handQ = new THREE.Quaternion();
    for (let frame = 0; frame < 8; frame += 1) {
      // Fake walk: twist arm + hand every frame the way mixer would.
      lArm.rotation.z = Math.sin(frame * 0.7) * 0.35;
      lFore.rotation.y = Math.cos(frame * 0.5) * 0.45;
      lHand.rotation.set(frame * 0.2, frame * -0.15, frame * 0.1);
      modelRoot.updateMatrixWorld(true);
      ik.updateLeftHandIk({ dt: 1 }); // dt:1 → full IK weight, so palm hard-locks
      // Support target lives under gunRoot as runtime_left_ik_target.
      const target = gunRoot.getObjectByName('runtime_left_ik_target');
      assert.ok(target, 'left ik target present');
      target.getWorldQuaternion(targetQ);
      lHand.getWorldQuaternion(handQ);
      const ang = handQ.angleTo(targetQ);
      assert.ok(
        ang < 1e-4,
        `frame ${frame}: left hand world rot drifted ${ang.toFixed(5)} rad from IK target`,
      );
    }
  }

  ik.dispose();
  assert.equal(ik.weaponAnchor.parent, null);
}

console.log('verify-fp-ik: all checks passed');
