import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { prepareClip } from '../src/game/characters/mara/MaraAnimationController.js';
globalThis.window = { URL: { createObjectURL: () => '' } };
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };
const ROOT = path.resolve('.');
const PUBLIC = path.resolve('public');
const loader = new FBXLoader();
const loadFbx = (p) => { const b = readFileSync(p); return loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), ''); };
const model = loadFbx(path.join(ROOT, 'assets-source/models/climber.fbx'));
const rootBind = model.getObjectByName('mixamorigHips').position.clone();
const targetBind = (o => { const m = new Map(); o.traverse(c => { if (c.name && c.isBone) m.set(c.name, c.quaternion.clone().normalize()); }); return m; })(model);
const targetNames = (o => { const n = new Set(); o.traverse(c => { if (c.name) n.add(c.name); }); return n; })(model);

const LEG_RE = /^(mixamorigHips|mixamorigLeftUpLeg|mixamorigLeftLeg|mixamorigLeftFoot|mixamorigLeftToe|mixamorigRightUpLeg|mixamorigRightLeg|mixamorigRightFoot|mixamorigRightToe)/;
for (const state of ['lightSlash1', 'heavyAttack', 'armedIdle']) {
  const url = state === 'lightSlash1' ? 'great sword slash.fbx'
    : state === 'heavyAttack' ? 'great sword high spin attack.fbx'
    : 'great sword idle.fbx';
  const src = loadFbx(path.join(PUBLIC, 'assets/animation-packs', url));
  const clip = prepareClip({ clip: src.animations[0], state, rootBindPosition: rootBind, sourceBindRotations: (o=>{const m=new Map();o.traverse(c=>{if(c.name&&c.isBone)m.set(c.name,c.quaternion.clone().normalize())});return m})(src), targetBindRotations: targetBind, targetNames, retargetQuaternionTracks: true, rootPosition: 'locked' });
  const legTracks = clip.tracks.filter(t => LEG_RE.test(t.name));
  // For each leg track, measure keyframe value spread (how much it animates).
  let animatedLegs = 0;
  let maxRange = 0;
  for (const t of legTracks) {
    const vals = t.values;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < vals.length; i++) { if (vals[i] < mn) mn = vals[i]; if (vals[i] > mx) mx = vals[i]; }
    const range = mx - mn;
    if (range > maxRange) maxRange = range;
    if (range > 0.02) animatedLegs++;
  }
  console.log(`${state}: legTracks=${legTracks.length}, animated(>0.02 range)=${animatedLegs}, maxLegRange=${maxRange.toFixed(3)} (quat range ~0 = static, ~1-2 = big motion)`);
}
