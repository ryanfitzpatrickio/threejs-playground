import * as THREE from 'three';
import { forestBarkMaterial } from './seedthree/barkMaterial.js';
import { WIND_DIR } from './seedthree/wind.js';
import {
  computeFoliageInstancingBudget,
  sampleFoliageSourceIndex,
  MAX_FOREST_FOLIAGE_INSTANCES,
} from './forestFoliageBudget.js';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _mtx = new THREE.Matrix4();
const _yAxis = new THREE.Vector3(0, 1, 0);
const MAX_INSTANCES_PER_DRAW = MAX_FOREST_FOLIAGE_INSTANCES;

function stripInstancedAttributes(geo) {
  for (const name of Object.keys(geo.attributes)) {
    if (geo.attributes[name].isInstancedBufferAttribute) {
      geo.deleteAttribute(name);
    }
  }
}

/**
 * Static instanced grove from pre-built LOD2 archetypes (M2 — no rebinning).
 */
export function buildStaticForestBuckets(archetypes, placements) {
  const group = new THREE.Group();
  group.name = 'Forest Zone Trees';
  group.userData.noCollision = true;

  const byArchetype = new Map();
  for (const p of placements) {
    const list = byArchetype.get(p.archetypeIndex) ?? [];
    list.push(p);
    byArchetype.set(p.archetypeIndex, list);
  }

  for (const [archIdx, slots] of byArchetype) {
    const archetype = archetypes[archIdx];
    if (!archetype?.lod2Group) continue;
    const N = Math.min(slots.length, MAX_INSTANCES_PER_DRAW);
    const activeSlots = slots.slice(0, N);
    const lod2 = archetype.lod2Group;

    for (const child of lod2.children) {
      if (child.isMesh && !child.isInstancedMesh) {
        const geo = child.geometry.clone();
        stripInstancedAttributes(geo);
        geo.userData.forestClone = true;
        geo.setAttribute('aWindVec', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3));
        geo.setAttribute('aAnchorPos', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3));
        const im = new THREE.InstancedMesh(geo, forestBarkMaterial(child.material), N);
        im.name = `Forest Bark ${archIdx}`;
        im.castShadow = false;
        im.receiveShadow = false;
        im.frustumCulled = false;
        im.userData.noCollision = true;

        const bwv = geo.attributes.aWindVec;
        const bap = geo.attributes.aAnchorPos;
        activeSlots.forEach((slot, i) => {
          _quat.setFromAxisAngle(_yAxis, slot.rotY);
          _scale.set(slot.scale, slot.scale, slot.scale);
          _pos.set(slot.x, slot.y, slot.z);
          _mtx.compose(_pos, _quat, _scale);
          im.setMatrixAt(i, _mtx);
          const cos = Math.cos(-slot.rotY);
          const sin = Math.sin(-slot.rotY);
          bwv.setXYZ(
            i,
            (WIND_DIR.x * cos + WIND_DIR.z * sin) / slot.scale,
            0,
            (WIND_DIR.z * cos - WIND_DIR.x * sin) / slot.scale,
          );
          bap.setXYZ(i, slot.x, slot.y, slot.z);
        });
        bwv.needsUpdate = true;
        bap.needsUpdate = true;
        im.instanceMatrix.needsUpdate = true;
        group.add(im);
      } else if (child.isInstancedMesh) {
        const budget = computeFoliageInstancingBudget(child.count, N);
        if (!budget) continue;
        const { trees, k, srcK, maxInstances } = budget;
        const activeSlots = slots.slice(0, trees);
        const geo = child.geometry.clone();
        stripInstancedAttributes(geo);
        geo.userData.forestClone = true;
        const thick = new Float32Array(maxInstances);
        for (let t = 0; t < maxInstances; t += 1) thick[t] = 0.4 + 0.6 * Math.random();
        geo.setAttribute('aThickness', new THREE.InstancedBufferAttribute(thick, 1));
        geo.setAttribute('aTreeOrigin', new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3));
        geo.setAttribute('aWindVec', new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3));
        geo.setAttribute('aAnchorPos', new THREE.InstancedBufferAttribute(new Float32Array(maxInstances * 3), 3));

        const rebuilt = new Set(['aThickness', 'aTreeOrigin', 'aWindVec', 'aAnchorPos']);
        for (const [name, attr] of Object.entries(child.geometry.attributes)) {
          if (!attr.isInstancedBufferAttribute || rebuilt.has(name)) continue;
          const arr = new attr.array.constructor(maxInstances * attr.itemSize);
          for (let offset = 0; offset < maxInstances; offset += k) {
            const copyCount = Math.min(k, maxInstances - offset);
            arr.set(attr.array.subarray(0, copyCount * attr.itemSize), offset * attr.itemSize);
          }
          geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, attr.itemSize));
        }

        const im = new THREE.InstancedMesh(geo, child.material, maxInstances);
        im.name = `Forest Foliage ${archIdx}`;
        im.castShadow = false;
        im.receiveShadow = false;
        im.frustumCulled = false;
        im.userData.noCollision = true;
        im.userData.k = k;

        const snap = new Float32Array(k * 16);
        for (let j = 0; j < k; j += 1) {
          child.getMatrixAt(sampleFoliageSourceIndex(srcK, k, j), _mtx);
          snap.set(_mtx.elements, j * 16);
        }
        im.userData.srcMatrices = snap;

        const orig = geo.attributes.aTreeOrigin;
        const wvec = geo.attributes.aWindVec;
        const apos = geo.attributes.aAnchorPos;
        const slotMtx = new THREE.Matrix4();
        const cardMtx = new THREE.Matrix4();
        const outMtx = new THREE.Matrix4();
        let flat = 0;
        activeSlots.forEach((slot) => {
          if (flat >= maxInstances) return;
          _quat.setFromAxisAngle(_yAxis, slot.rotY);
          _scale.set(slot.scale, slot.scale, slot.scale);
          _pos.set(slot.x, slot.y, slot.z);
          slotMtx.compose(_pos, _quat, _scale);
          const cos = Math.cos(-slot.rotY);
          const sin = Math.sin(-slot.rotY);
          const wvx = (WIND_DIR.x * cos + WIND_DIR.z * sin) / slot.scale;
          const wvz = (WIND_DIR.z * cos - WIND_DIR.x * sin) / slot.scale;
          for (let j = 0; j < k; j += 1) {
            if (flat >= maxInstances) break;
            cardMtx.fromArray(snap, j * 16);
            outMtx.multiplyMatrices(slotMtx, cardMtx);
            im.setMatrixAt(flat, outMtx);
            orig.setXYZ(flat, slot.x, slot.y + 6 * slot.scale, slot.z);
            wvec.setXYZ(flat, wvx, 0, wvz);
            apos.setXYZ(flat, slot.x, slot.y, slot.z);
            flat += 1;
          }
        });
        orig.needsUpdate = true;
        wvec.needsUpdate = true;
        apos.needsUpdate = true;
        im.count = flat;
        im.instanceMatrix.needsUpdate = true;
        group.add(im);
      }
    }
  }

  return group;
}

export function disposeForestBuckets(group) {
  group?.traverse((obj) => {
    if (!obj.isInstancedMesh) return;
    if (obj.geometry?.userData?.forestClone) obj.geometry.dispose();
    obj.dispose();
  });
}
