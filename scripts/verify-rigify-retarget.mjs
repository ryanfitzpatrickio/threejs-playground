// Pure-node contract check for generated Mixamo -> Rigify clips.
// Covers the human5 pack plus the UBC male/female body-specific packs.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RIGIFY_FROM_MIXAMO,
  RIGIFY_HIP_BONE,
  toRuntimeRigifyBoneName,
} from '../src/game/characters/simhuman/rigifySkeleton.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REQUIRED_CLIPS = new Set(['idle', 'walking', 'running', 'left turn', 'right turn']);
const PINNED_PINKY_JOINTS = Object.freeze([
  ['DEF-f_ring01L', 'DEF-f_pinky01L'],
  ['DEF-f_ring02L', 'DEF-f_pinky02L'],
  ['DEF-f_ring03L', 'DEF-f_pinky03L'],
  ['DEF-f_ring01R', 'DEF-f_pinky01R'],
  ['DEF-f_ring02R', 'DEF-f_pinky02R'],
  ['DEF-f_ring03R', 'DEF-f_pinky03R'],
]);
const PACKS = [
  {
    label: 'human5',
    model: 'public/assets/simhuman/human5.glb',
    output: 'public/assets/animations-rigify',
    retargetSpace: 'world-bind-delta',
  },
  {
    label: 'ubc-male',
    model: 'public/assets/simhuman/ubc-male.glb',
    output: 'public/assets/animations-rigify-ubc-male',
    retargetSpace: 'world-bind-delta',
  },
  {
    label: 'ubc-female',
    model: 'public/assets/simhuman/ubc-female.glb',
    output: 'public/assets/animations-rigify-ubc-female',
    retargetSpace: 'world-bind-delta',
  },
];

for (const pack of PACKS) await verifyPack(pack);

console.log(
  `verify-rigify-retarget: OK (${PACKS.length} packs, ${REQUIRED_CLIPS.size} clips each, `
  + `${Object.keys(RIGIFY_FROM_MIXAMO).length} mapped bones)`,
);

async function verifyPack(pack) {
  const modelBuffer = await readFile(path.join(ROOT, pack.model));
  const jsonLength = modelBuffer.readUInt32LE(12);
  const gltf = JSON.parse(modelBuffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const targetBones = new Set(
    (gltf.nodes ?? [])
      .map((node) => node.name ?? '')
      .filter((name) => name.startsWith('DEF-'))
      .map(toRuntimeRigifyBoneName),
  );

  for (const target of Object.keys(RIGIFY_FROM_MIXAMO)) {
    assert.ok(targetBones.has(target), `${pack.label}: mapped target bone does not exist: ${target}`);
  }

  const manifest = JSON.parse(
    await readFile(path.join(ROOT, pack.output, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.retargetSpace, pack.retargetSpace, `${pack.label}: retarget space`);
  assert.equal(manifest.animations.length, REQUIRED_CLIPS.size, `${pack.label}: manifest clip count`);
  assert.deepEqual(
    new Set(manifest.animations.map((entry) => entry.name)),
    REQUIRED_CLIPS,
    `${pack.label}: required clips`,
  );

  for (const entry of manifest.animations) {
    assert.ok(entry.duration > 0, `${pack.label}/${entry.name}: duration must be positive`);
    const clipPath = path.join(ROOT, entry.clipUrl.replace(/^\//, 'public/'));
    const clip = JSON.parse(await readFile(clipPath, 'utf8'));
    assert.ok(clip.duration > 0, `${pack.label}/${entry.name}: JSON duration must be positive`);
    assert.equal(
      clip.tracks.length,
      entry.tracks,
      `${pack.label}/${entry.name}: manifest track count`,
    );

    let hipTrack = null;
    const trackByName = new Map(clip.tracks.map((track) => [track.name, track]));
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      assert.ok(dot > 0, `${pack.label}/${entry.name}: malformed track ${track.name}`);
      const boneName = track.name.slice(0, dot);
      assert.ok(
        targetBones.has(boneName),
        `${pack.label}/${entry.name}: missing target bone ${boneName}`,
      );
      assert.ok(track.times.length > 1, `${pack.label}/${entry.name}/${track.name}: too few keys`);
      assert.ok(
        track.times.every(Number.isFinite),
        `${pack.label}/${entry.name}/${track.name}: non-finite time`,
      );
      assert.ok(
        track.values.every(Number.isFinite),
        `${pack.label}/${entry.name}/${track.name}: non-finite value`,
      );

      if (track.type === 'quaternion') {
        for (let i = 0; i < track.values.length; i += 4) {
          const norm = Math.hypot(...track.values.slice(i, i + 4));
          assert.ok(
            Math.abs(norm - 1) < 1e-3,
            `${pack.label}/${entry.name}/${track.name}: quaternion norm ${norm}`,
          );
        }
      }
      if (track.name === `${RIGIFY_HIP_BONE}.position`) hipTrack = track;
    }

    for (const [ringBone, pinkyBone] of PINNED_PINKY_JOINTS) {
      const ringTrack = trackByName.get(`${ringBone}.quaternion`);
      const pinkyTrack = trackByName.get(`${pinkyBone}.quaternion`);
      assert.ok(ringTrack, `${pack.label}/${entry.name}: ring track missing for ${ringBone}`);
      assert.ok(pinkyTrack, `${pack.label}/${entry.name}: pinned pinky track missing for ${pinkyBone}`);
      assert.ok(
        Math.abs(pinkyTrack.times[0] - ringTrack.times[0]) < 1e-6,
        `${pack.label}/${entry.name}: ${pinkyBone} starts after ${ringBone}`,
      );
      assert.ok(
        Math.abs(pinkyTrack.times.at(-1) - ringTrack.times.at(-1)) < 1e-6,
        `${pack.label}/${entry.name}: ${pinkyBone} ends before ${ringBone}`,
      );
      if (quaternionTrackMotion(ringTrack) > 1e-5) {
        assert.ok(
          quaternionTrackMotion(pinkyTrack) > 1e-5,
          `${pack.label}/${entry.name}: ${pinkyBone} remained static`,
        );
      }
    }

    assert.ok(hipTrack, `${pack.label}/${entry.name}: hip position track missing`);
    const bindX = hipTrack.values[0];
    const bindZ = hipTrack.values[2];
    const yValues = [];
    for (let i = 0; i < hipTrack.values.length; i += 3) {
      assert.ok(
        Math.abs(hipTrack.values[i] - bindX) < 1e-6,
        `${pack.label}/${entry.name}: hip X has root motion`,
      );
      assert.ok(
        Math.abs(hipTrack.values[i + 2] - bindZ) < 1e-6,
        `${pack.label}/${entry.name}: hip Z has root motion`,
      );
      yValues.push(hipTrack.values[i + 1]);
    }
    assert.ok(
      Math.hypot(bindX, yValues[0], bindZ) > 0.05,
      `${pack.label}/${entry.name}: hip bind position was not restored`,
    );
    assert.ok(
      Math.max(...yValues) - Math.min(...yValues) < 1,
      `${pack.label}/${entry.name}: implausible hip Y range`,
    );
  }
}

function quaternionTrackMotion(track) {
  const first = track.values.slice(0, 4);
  let maxDistance = 0;
  for (let i = 4; i < track.values.length; i += 4) {
    const dot = Math.abs(
      first[0] * track.values[i]
      + first[1] * track.values[i + 1]
      + first[2] * track.values[i + 2]
      + first[3] * track.values[i + 3],
    );
    maxDistance = Math.max(maxDistance, 1 - Math.min(1, dot));
  }
  return maxDistance;
}
