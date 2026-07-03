// Inspects neonblade.glb: bounding box, scale, named nodes, and longest axis
// (the blade direction). Used to pick the right-hand socket transform.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// GLTFLoader loads embedded textures via Image/createObjectURL. We only need
// geometry, so stub the image path so textures no-op while meshes still parse.
globalThis.window = globalThis.window || {};
globalThis.self = globalThis;
globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => 'blob:stub');
globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {});
globalThis.Image = class FakeImage {
  constructor() { this.width = 1; this.height = 1; this._onload = null; }
  set src(v) { this._src = v; if (this._onload) queueMicrotask(() => this._onload()); }
  get src() { return this._src; }
  addEventListener(type, fn) { if (type === 'load') this._onload = fn; }
  removeEventListener() {}
};

const PUBLIC = path.resolve('public');
const buffer = readFileSync(path.join(PUBLIC, 'assets/models/neonblade.glb'));
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

const loader = new GLTFLoader();
const gltf = await new Promise((resolve, reject) => {
  loader.parse(arrayBuffer, '', resolve, reject);
});

const scene = gltf.scene;
scene.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(scene);
const size = box.getSize(new THREE.Vector3());
const center = box.getCenter(new THREE.Vector3());

console.log('=== neonblade.glb ===');
console.log(`scenes: ${gltf.scenes.length}, root name: "${scene.name || '(unnamed)'}"`);
console.log(`bbox size:  x=${size.x.toFixed(4)} y=${size.y.toFixed(4)} z=${size.z.toFixed(4)}`);
console.log(`bbox min:   x=${box.min.x.toFixed(4)} y=${box.min.y.toFixed(4)} z=${box.min.z.toFixed(4)}`);
console.log(`bbox max:   x=${box.max.x.toFixed(4)} y=${box.max.y.toFixed(4)} z=${box.max.z.toFixed(4)}`);
console.log(`center:     x=${center.x.toFixed(4)} y=${center.y.toFixed(4)} z=${center.z.toFixed(4)}`);
console.log(`longest axis: ${
  size.x >= size.y && size.x >= size.z ? 'X' : size.y >= size.z ? 'Y' : 'Z'
} (length ${(Math.max(size.x, size.y, size.z)).toFixed(4)})`);

console.log('\n=== scene contents ===');
let meshCount = 0;
const namedNodes = [];
scene.traverse((obj) => {
  if (obj.isMesh) {
    meshCount += 1;
    const m = obj.geometry;
    const bx = new THREE.Box3().setFromObject(obj);
    const s = bx.getSize(new THREE.Vector3());
    console.log(
      `mesh[${meshCount}] "${obj.name}" geom=${m?.attributes?.position?.count ?? '?'}verts ` +
        `localSize=(${s.x.toFixed(3)},${s.y.toFixed(3)},${s.z.toFixed(3)}) ` +
        `pos=(${obj.position.x.toFixed(3)},${obj.position.y.toFixed(3)},${obj.position.z.toFixed(3)})`,
    );
  }
  if (obj.name) namedNodes.push(obj.name + (obj.isMesh ? ' [mesh]' : obj.isBone ? ' [bone]' : ' [node]'));
});
console.log(`meshes: ${meshCount}`);
console.log(`named nodes: ${namedNodes.length ? namedNodes.join(', ') : '(none)'}`);

// Which X end is the handle? The grip is thinner (smaller Y/Z cross-section)
// than the blade. Compare the cross-section extent at each end.
const mesh = scene.getObjectByProperty('isMesh', true);
if (mesh) {
  const pos = mesh.geometry.attributes.position;
  const v = new THREE.Vector3();
  const m = mesh.matrixWorld;
  const slice = (xMin, xMax) => {
    let yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (v.x < xMin || v.x > xMax) continue;
      if (v.y < yMin) yMin = v.y; if (v.y > yMax) yMax = v.y;
      if (v.z < zMin) zMin = v.z; if (v.z > zMax) zMax = v.z;
    }
    return { y: yMax - yMin, z: zMax - zMin };
  };
  const slices = [
    ['-0.50,-0.40', -0.5, -0.4],
    ['-0.40,-0.25', -0.4, -0.25],
    ['-0.10, 0.10', -0.1, 0.1],
    [' 0.25, 0.40', 0.25, 0.4],
    [' 0.40, 0.50', 0.4, 0.5],
  ];
  console.log(`\n=== X-slice profile (YZ extent). Small Z = flat blade; round Y≈Z = grip ===`);
  for (const [label, a, b] of slices) {
    const r = slice(a, b);
    console.log(`x in [${label}]: Y=${r.y.toFixed(3)} Z=${r.z.toFixed(3)}`);
  }
}

// Animations / skins?
console.log(`\nanimations: ${gltf.animations?.length ?? 0}`);
const skinned = [];
scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o.name); });
console.log(`skinned meshes: ${skinned.length ? skinned.join(', ') : '(none)'}`);
