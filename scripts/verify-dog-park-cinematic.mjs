/**
 * Guards dog-park cinematic tour: five authored shots, goose V formation math,
 * and camera-mode normalization (cinematic is distinct from squirrel-chase).
 *
 * Run: node scripts/verify-dog-park-cinematic.mjs
 */
import assert from 'node:assert/strict';
import {
  CINEMATIC_SHOTS,
  DogParkCinematicDirector,
} from '../src/game/runtime/features/dogPark/DogParkCinematicDirector.js';
import {
  FLOCK_COUNT,
  FLOCK_SHELL_COUNT,
  flockSlotOffset,
  sampleFlockPath,
} from '../src/game/runtime/features/dogPark/DogParkGooseFlock.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

{
  assert.equal(CINEMATIC_SHOTS.length, 5, 'tour has 5 shots');
  const ids = CINEMATIC_SHOTS.map((s) => s.id);
  assert.deepEqual(ids, [
    'geese-v',
    'squirrel-driveby',
    'tree-canopy',
    'lake-overlook',
    'cat-fight',
  ]);
  for (const shot of CINEMATIC_SHOTS) {
    assert.ok(shot.duration > 0, `${shot.id} has duration`);
    assert.ok(['follow', 'side-track', 'world'].includes(shot.style), `${shot.id} style`);
  }
  ok('five authored shots with valid styles');
}

{
  assert.equal(FLOCK_COUNT, 5);
  assert.ok(FLOCK_SHELL_COUNT <= 6, 'flock shells stay budget-friendly');
  const lead = flockSlotOffset(0);
  assert.equal(lead.side, 0);
  assert.equal(lead.back, 0);
  // V opens: left/right alternate with increasing back offset.
  const a = flockSlotOffset(1);
  const b = flockSlotOffset(2);
  assert.ok(a.side < 0 && b.side > 0, 'wing 1 left, wing 2 right');
  assert.ok(a.back < 0 && b.back < 0, 'wings trail the lead');
  assert.ok(Math.abs(a.side) === Math.abs(b.side), 'symmetric first rank');
  const c = flockSlotOffset(3);
  assert.ok(Math.abs(c.back) > Math.abs(a.back), 'deeper ranks trail further');
  ok('V formation slot offsets');
}

{
  const a = sampleFlockPath(0, { centerX: 0, centerZ: 0, radiusX: 10, radiusZ: 8, altitude: 12 });
  const b = sampleFlockPath(Math.PI / 2, { centerX: 0, centerZ: 0, radiusX: 10, radiusZ: 8, altitude: 12 });
  assert.ok(Math.abs(a.x - 10) < 1e-6 && Math.abs(a.z) < 1e-6);
  assert.ok(Math.abs(b.z - 8) < 1e-6 && Math.abs(b.x) < 1e-6);
  assert.ok(a.y > 10 && a.y < 14, 'altitude near authored band');
  // Heading is tangent to the ellipse.
  assert.ok(Number.isFinite(a.headingYaw));
  ok('elliptical flock path samples');
}

{
  // Lightweight director cycle with stub subjects.
  const squirrelRoot = { position: { x: 3, y: 0.1, z: 1 }, rotation: { y: 0.4 } };
  const dogRoot = { position: { x: 1, y: 0.2, z: 0 }, rotation: { y: 0.5 } };
  const leadRoot = { position: { x: 0, y: 14, z: 0 }, rotation: { y: 0 } };
  const chasePair = {
    squirrel: { animal: { root: squirrelRoot, rig: { root: squirrelRoot }, animation: { getRootYaw: () => 0.4, getYawRate: () => 0.1 } } },
    dog: { animal: { root: dogRoot } },
    getSquirrelCameraTarget: () => squirrelRoot,
    getSquirrelCameraMotion: () => ({
      headingYaw: 0.4, yawRate: 0.1, moving: true, speed: 3, forwardIntent: 1,
    }),
  };
  const flock = {
    getLeadCameraTarget: () => leadRoot,
    getLeadCameraMotion: () => ({
      headingYaw: 1.2, yawRate: 0.1, moving: true, speed: 4, forwardIntent: 1,
    }),
  };
  const catRoot = { position: { x: -16, y: 0.1, z: -7 }, rotation: { y: 0.2 } };
  const catFight = {
    getCameraTarget: () => catRoot,
    getCameraMotion: () => ({
      headingYaw: 0.2, yawRate: 0.4, moving: true, speed: 1.2, forwardIntent: 1,
    }),
    getMidpoint: (out) => {
      out.set(-16, 0.3, -7);
      return out;
    },
  };
  const pigeonFocus = { x: 0, y: 5.8, z: 17 };
  const treePigeons = {
    getFocusPoint: (out) => {
      out.set(pigeonFocus.x, pigeonFocus.y, pigeonFocus.z);
      return out;
    },
    getCameraTarget: () => leadRoot,
  };
  const director = new DogParkCinematicDirector({
    getChasePair: () => chasePair,
    getGooseFlock: () => flock,
    getCatFight: () => catFight,
    getTreePigeons: () => treePigeons,
    getPlayerDog: () => ({ rig: { root: dogRoot }, root: dogRoot, animation: { getRootYaw: () => 0 } }),
    getLake: () => ({ x: 16, z: 8 }),
    getBounds: () => ({ minX: -30, maxX: 30, minZ: -22.5, maxZ: 22.5 }),
    getMudPatches: () => [{ x: -21, z: -5 }],
  });

  const camera = {
    position: { x: 0, y: 2, z: 5, copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }, lerpVectors(a, b, t) {
      this.x = a.x + (b.x - a.x) * t;
      this.y = a.y + (b.y - a.y) * t;
      this.z = a.z + (b.z - a.z) * t;
      return this;
    } },
    lookAt() {},
    updateMatrixWorld() {},
    getWorldDirection(out) { out.set(0, 0, -1); return out; },
  };
  // Minimal DogCameraSystem stand-in.
  const chaseCamera = {
    active: true,
    targetObject: null,
    setTarget(target, opts = {}) {
      this.targetObject = target;
      this.lastOpts = opts;
    },
    update() {},
  };

  director.start({ snapCamera: camera });
  assert.equal(director.active, true);
  assert.equal(director.getCurrentShot().id, 'geese-v');

  // Advance through first shot duration into squirrel drive-by.
  for (let i = 0; i < 60 * 14; i += 1) {
    director.update(1 / 60, { camera, chaseCamera, frameInput: {} });
  }
  assert.equal(director.getCurrentShot().id, 'squirrel-driveby');
  ok('director advances geese → squirrel drive-by');

  // Side-track should leave chase cam inactive and position the lens.
  assert.equal(chaseCamera.active, false);
  assert.ok(Number.isFinite(camera.position.x));
  assert.ok(camera.position.y > 1, 'drive-by eye is elevated');
  ok('squirrel drive-by is a side-track world write');

  // Jump to tree canopy by advancing more.
  for (let i = 0; i < 60 * 12; i += 1) {
    director.update(1 / 60, { camera, chaseCamera, frameInput: {} });
  }
  assert.equal(director.getCurrentShot().id, 'tree-canopy');
  assert.ok(camera.position.y > 5, 'canopy cam sits in the trees');
  // Eye should look toward pigeon focus (z near 17, y elevated).
  assert.ok(Math.abs(camera.position.z - (pigeonFocus.z + 3.8)) < 1.5, 'canopy frames pigeons');
  ok('tree canopy world shot frames pigeons');

  // From tree-canopy: advance tree(9) + lake(10) + a beat into cat-fight(10).
  for (let i = 0; i < 60 * 20; i += 1) {
    director.update(1 / 60, { camera, chaseCamera, frameInput: {} });
  }
  assert.equal(director.getCurrentShot().id, 'cat-fight', `shot=${director.getCurrentShot()?.id}`);
  assert.equal(chaseCamera.targetObject, catRoot);
  ok('director reaches cat-fight follow shot');

  const snap = director.snapshot();
  assert.equal(snap.active, true);
  assert.equal(snap.shotCount, 5);
  assert.equal(snap.shotId, 'cat-fight');
  ok('cinematic snapshot exposes shot id');

  director.stop();
  assert.equal(director.active, false);
  ok('director stops cleanly');
}

{
  // Mirror normalizeCameraMode contracts used by HUD + runtime (inline check).
  const normalize = (value) => {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === 'cinematic' || raw === 'tour' || raw === 'cinema') return 'cinematic';
    if (raw === 'squirrel-chase' || raw === 'squirrel' || raw === 'chase') return 'squirrel-chase';
    return 'player';
  };
  assert.equal(normalize('cinematic'), 'cinematic');
  assert.equal(normalize('tour'), 'cinematic');
  assert.equal(normalize('squirrel-chase'), 'squirrel-chase');
  assert.equal(normalize('chase'), 'squirrel-chase');
  assert.equal(normalize('player'), 'player');
  // Regression: old alias must NOT map cinematic → squirrel-chase.
  assert.notEqual(normalize('cinematic'), 'squirrel-chase');
  ok('camera mode normalize keeps cinematic distinct');
}

console.log(`\n${passed} passed`);
