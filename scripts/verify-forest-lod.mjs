import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createForestLodState,
  disposeForestLodState,
  rebinForestLod,
} from '../src/game/world/forest/forestLod.js';
import { bentNormalCardGeometry } from '../src/game/world/forest/seedthree/impostor.js';

function mockLodGroup() {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 10, 0.5),
    new THREE.MeshBasicMaterial(),
  ));
  const foliage = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.5, 1),
    new THREE.MeshBasicMaterial(),
    4,
  );
  foliage.count = 4;
  group.add(foliage);
  return group;
}

function mockArchetype() {
  const impostorGroup = new THREE.Group();
  for (const rotY of [0, -Math.PI / 2]) {
    const card = new THREE.Mesh(
      bentNormalCardGeometry(8, 16),
      new THREE.MeshBasicMaterial({ alphaTest: 0.35 }),
    );
    card.rotation.y = rotY;
    card.userData.isBillboardCard = true;
    impostorGroup.add(card);
  }
  return {
    index: 0,
    lod1Group: mockLodGroup(),
    lod2Group: mockLodGroup(),
    impostorGroup,
    impostorHalfH: 8,
  };
}

function placement(x) {
  return { x, y: 0, z: 0, rotY: 0, scale: 1, archetypeIndex: 0 };
}

// Upstream billboard fix: exactly one quad per crossed card (four tris/tree).
const cardGeometry = bentNormalCardGeometry(8, 16);
assert.equal(cardGeometry.attributes.position.count, 4);
assert.equal(cardGeometry.index.count / 3, 2);
cardGeometry.dispose();

// The near budget follows distance, not placement array order.
const nearestState = createForestLodState([mockArchetype()], [placement(55), placement(5)], {
  heroCount: 0,
  nearCount: 1,
  nearRadius: 50,
  farRadius: 200,
  fadeBand: 0.2,
});
rebinForestLod(nearestState, new THREE.Vector3(), { force: true });
assert.equal(nearestState.slots[0]._hasNearLod, false, 'farther first placement loses near slot');
assert.equal(nearestState.slots[1]._hasNearLod, true, 'closest placement receives near slot');
disposeForestLodState(nearestState);

// Cluster and impostor overlap across the transition; opacity is smoothstep(0.5).
const overlapState = createForestLodState([mockArchetype()], [placement(50)], {
  heroCount: 0,
  nearCount: 1,
  nearRadius: 50,
  farRadius: 200,
  fadeBand: 0.2,
});
rebinForestLod(overlapState, new THREE.Vector3(), { force: true });
assert.equal(overlapState.stats.near, 1);
assert.equal(overlapState.stats.far, 1);
for (const im of overlapState.archBuckets[0].billboards) {
  assert.equal(im.geometry.attributes.aImpostorFade.getX(0), 0.5);
  assert.equal(im.material.transparent, true);
}
disposeForestLodState(overlapState);

// Far populations are split into safe 512-instance batches instead of truncating.
const many = Array.from({ length: 700 }, (_, i) => placement(100 + i * 0.01));
const batchedState = createForestLodState([mockArchetype()], many, {
  heroCount: 0,
  nearCount: 0,
  nearRadius: 20,
  farRadius: 200,
});
rebinForestLod(batchedState, new THREE.Vector3(), { force: true });
const batches = batchedState.archBuckets[0].billboards;
assert.equal(batches.length, 4, 'two crossed cards each use two batches');
assert.deepEqual(batches.map((im) => im.count), [512, 188, 512, 188]);
assert.equal(batchedState.stats.far, 700);
assert.ok(batches.every((im) => im.count <= 512));
disposeForestLodState(batchedState);

console.log('Forest LOD verification passed.');
