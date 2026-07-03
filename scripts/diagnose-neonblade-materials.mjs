import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
globalThis.window = globalThis.window || {};
globalThis.self = globalThis;
globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => 'blob:stub');
globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {});
globalThis.Image = class { constructor(){this.width=1;this.height=1;} set src(v){this._s=v; if(this._l) queueMicrotask(()=>this._l());} addEventListener(t,f){if(t==='load')this._l=f;} removeEventListener(){} };
const b = readFileSync(path.resolve('public/assets/models/neonblade.glb'));
const gltf = await new Promise((res,rej)=> new GLTFLoader().parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'',res,rej));
const scene = gltf.scene;
let i=0;
scene.traverse(o=>{
  if(!o.isMesh) return;
  const mats = Array.isArray(o.material)?o.material:[o.material];
  for(const m of mats){
    i++;
    console.log(`mat[${i}] on "${o.name}":`);
    console.log(`  type: ${m.type}`);
    console.log(`  color: #${(m.color?.getHexString?.() ?? 'n/a')}, opacity: ${m.opacity}, transparent: ${m.transparent}`);
    console.log(`  emissive: #${(m.emissive?.getHexString?.() ?? 'n/a')}, emissiveIntensity: ${m.emissiveIntensity}`);
    console.log(`  map: ${!!m.map}, emissiveMap: ${!!m.emissiveMap}, normalMap: ${!!m.normalMap}, alphaMap: ${!!m.alphaMap}`);
    console.log(`  metalness: ${m.metalness}, roughness: ${m.roughness}, side: ${m.side}, depthWrite: ${m.depthWrite}, visible: ${o.visible}`);
    if(m.userData?.gltfExtensions){
      console.log(`  gltfExtensions: ${JSON.stringify(Object.keys(m.userData.gltfExtensions))}`);
      for(const k of Object.keys(m.userData.gltfExtensions)){
        console.log(`    ${k}: ${JSON.stringify(m.userData.gltfExtensions[k]).slice(0,200)}`);
      }
    }
  }
});
// Also dump raw glTF JSON material defs for alphaMode etc.
const jsonChunk = JSON.parse(Buffer.from(b.buffer.slice(12, 12 + new DataView(b.buffer.slice(0,20)).getUint32(12,true))).toString());
console.log('\n=== raw glTF materials (alphaMode/factor) ===');
for(const [idx,mat] of (jsonChunk.materials||[]).entries()){
  console.log(`mat${idx} "${mat.name||''}": alphaMode=${mat.alphaMode??'OPAQUE'} alphaCutoff=${mat.alphaCutoff} doubleSided=${mat.doubleSided}`);
  console.log(`  pbr: ${JSON.stringify(mat.pbrMetallicRoughness?.baseColorFactor)} emissiveFactor: ${JSON.stringify(mat.emissiveFactor)} metallic=${mat.pbrMetallicRoughness?.metallicFactor} rough=${mat.pbrMetallicRoughness?.roughnessFactor}`);
  const ext = mat.extensions || {};
  console.log(`  extensions: ${JSON.stringify(Object.keys(ext))}`);
  if(ext.KHR_materials_emissive_strength) console.log(`    emissive_strength: ${JSON.stringify(ext.KHR_materials_emissive_strength)}`);
}
