import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { flattenObjectForWebGPU } from './src/game/geometry/prepareWebGPUGeometry.js';
globalThis.window ??= {}; globalThis.self ??= globalThis;
const io = await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'draco3d.encoder': await draco3d.createEncoderModule(),'draco3d.decoder': await draco3d.createDecoderModule()});
async function load(f){const doc=await io.read(f);await doc.transform(dequantize());const e=doc.getRoot().listExtensionsUsed().find(x=>x.extensionName==='KHR_draco_mesh_compression');if(e)e.dispose();const glb=await io.writeBinary(doc);const ab=glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength);return new GLTFLoader().parseAsync(ab,'');}
function normalizeToHeight(root,t){root.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(root,true);const s=box.getSize(new THREE.Vector3());const sc=t/s.y;root.scale.multiplyScalar(sc);root.updateMatrixWorld(true);const nb=new THREE.Box3().setFromObject(root,true);root.position.y-=nb.min.y;}
function posedH(root){const box=new THREE.Box3();const tmp=new THREE.Vector3();root.updateMatrixWorld(true);root.traverse(c=>{if(!c.isSkinnedMesh)return;c.skeleton.update();const p=c.geometry.getAttribute('position');for(let i=0;i<p.count;i+=Math.max(1,Math.floor(p.count/6000))){tmp.fromBufferAttribute(p,i);c.applyBoneTransform(i,tmp);c.localToWorld(tmp);box.expandByPoint(tmp);}});return box;}
for(const [f,t] of [['public/assets/models/enemy1.glb',4.2],['public/assets/models/horse-rigged.glb',1.65]]){
  const g=await load(f); const r=g.scene; r.updateMatrixWorld(true); r.traverse(c=>{if(c.isSkinnedMesh&&c.skeleton)c.skeleton.update();}); flattenObjectForWebGPU(r);
  normalizeToHeight(r,t); const b=posedH(r); const s=b.getSize(new THREE.Vector3());
  console.log(f,'target',t,'=> rendered H=',s.y.toFixed(3),'minY=',b.min.y.toFixed(3), Math.abs(s.y-t)<0.02?'OK':'WRONG');
}
