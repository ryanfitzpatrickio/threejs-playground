// Loads climber.fbx + the armed-idle clip, applies the grip pose, and reports
// the right-hand bone's world frame so we can pick the socket rotation that
// points the sword blade (modeled along +X) "up" from the hand.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { prepareClip } from '../src/game/characters/mara/MaraAnimationController.js';

globalThis.window = { URL: { createObjectURL: () => '' } };
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };

const ROOT = path.resolve('.');
const PUBLIC = path.resolve('public');
const TARGET_HEIGHT = 1.72;

const loader = new FBXLoader();
const loadFbx = (p) => {
  const b = readFileSync(p);
  return loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};

const object = loadFbx(path.join(ROOT, 'assets-source/models/climber.fbx'));
const rootBindPosition = object.getObjectByName('mixamorigHips')?.position.clone() ?? new THREE.Vector3();
const targetBindRotations = collectBindRotations(object);
const targetNames = collectTargetNames(object);

// Normalize to 1.72m (same as createMaraFbxModel).
const box = new THREE.Box3().setFromObject(object);
const size = box.getSize(new THREE.Vector3());
const center = box.getCenter(new THREE.Vector3());
const modelScale = TARGET_HEIGHT / size.y;
object.scale.setScalar(modelScale);
object.position.set(-center.x * modelScale, -box.min.y * modelScale, -center.z * modelScale);

// Apply the armed-idle clip to the skeleton at mid-clip.
const src = loadFbx(path.join(PUBLIC, 'assets/animation-packs/great sword idle.fbx'));
const prepared = prepareClip({
  clip: src.animations[0],
  state: 'armedIdle',
  rootBindPosition,
  sourceBindRotations: collectBindRotations(src),
  targetBindRotations,
  targetNames,
  retargetQuaternionTracks: true,
  rootPosition: 'locked',
});

const mixer = new THREE.AnimationMixer(object);
const action = mixer.clipAction(prepared);
action.play();
mixer.update((prepared.duration || 1) * 0.5);
object.updateMatrixWorld(true);

const hand = object.getObjectByName('mixamorigRightHand');
const e = hand.matrixWorld.elements;
const handPos = new THREE.Vector3(e[12], e[13], e[14]);
// Hand-local axes in world = columns of the world matrix (column-major). Normalize
// (the object is scaled to 1.72m, so columns carry that scale).
const axisX = new THREE.Vector3(e[0], e[1], e[2]).normalize();
const axisY = new THREE.Vector3(e[4], e[5], e[6]).normalize();
const axisZ = new THREE.Vector3(e[8], e[9], e[10]).normalize();
console.log(`right hand world pos: (${handPos.x.toFixed(3)}, ${handPos.y.toFixed(3)}, ${handPos.z.toFixed(3)})  [character height ~${TARGET_HEIGHT}m]`);

// We want the sword blade (modeled along local +X) to point world-UP in this pose.
// Target hand-local direction D = inverse(handWorldRot) * worldUp. For a rotation
// matrix, inverse = transpose, so D is worldUp dotted into each world axis column.
const worldUp = new THREE.Vector3(0, 1, 0);
const D = new THREE.Vector3(
  worldUp.dot(axisX),
  worldUp.dot(axisY),
  worldUp.dot(axisZ),
).normalize();
console.log(`\ntarget hand-local dir for blade (world +Y expressed in hand-local): (${D.x.toFixed(3)}, ${D.y.toFixed(3)}, ${D.z.toFixed(3)})`);

// Socket quaternion: minimal rotation taking sword-local +X to D.
const swordX = new THREE.Vector3(1, 0, 0);
const socketQuat = new THREE.Quaternion().setFromUnitVectors(swordX, D);
const euler = new THREE.Euler().setFromQuaternion(socketQuat, 'XYZ');
const deg = (r) => THREE.MathUtils.radToDeg(r).toFixed(2);
console.log(`\nSOCKET rotation (apply to the sword group, child of mixamorigRightHand):`);
console.log(`  Euler XYZ (deg): (${deg(euler.x)}, ${deg(euler.y)}, ${deg(euler.z)})`);
console.log(`  quaternion: [${socketQuat.x.toFixed(4)}, ${socketQuat.y.toFixed(4)}, ${socketQuat.z.toFixed(4)}, ${socketQuat.w.toFixed(4)}]`);

function collectBindRotations(o) {
  const r = new Map();
  o.traverse((c) => { if (c.name && c.isBone) r.set(c.name, c.quaternion.clone().normalize()); });
  return r;
}
function collectTargetNames(o) {
  const n = new Set();
  o.traverse((c) => { if (c.name) n.add(c.name); });
  return n;
}
