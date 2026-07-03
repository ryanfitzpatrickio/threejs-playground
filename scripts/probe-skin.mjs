#!/usr/bin/env node
/**
 * Inspect skinning data inside each skinned GLB so we can tell whether
 * "spiky / exploded" vertices come from corrupt skin data or from the
 * render path.
 *
 * Reports per skinned GLB:
 *   - JOINTS_0 componentType / normalized + max value vs joint count
 *   - WEIGHTS_0 componentType / normalized + min/max + any NaN/Inf
 *   - per-vertex weight sum stats (how far from 1.0)
 *   - POSITION min/max (to spot a bind box that is itself exploded)
 */
import { NodeIO } from '@gltf-transform/core';
import path from 'node:path';

const ROOT = path.resolve('.');
const IO = new NodeIO();

const FILES = [
  'public/assets/models/climber.glb',
  'public/assets/models/enemy1.glb',
  'public/assets/models/horse-rigged.glb',
];

const COMP_NAME = { 5120: 'BYTE', 5121: 'UBYTE', 5122: 'SHORT', 5123: 'USHORT', 5125: 'UINT', 5126: 'FLOAT' };

function statsForAccessor(acc, { normalized }) {
  const arr = acc.getArray();
  if (!arr) return { empty: true };
  let min = Infinity, max = -Infinity, sum = 0, nan = 0, inf = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]);
    if (Number.isNaN(v)) { nan++; continue; }
    if (!Number.isFinite(v)) { inf++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { count: arr.length, min, max, sum, avg: sum / arr.length, nan, inf, normalized };
}

function weightSumStats(acc) {
  const arr = acc.getArray();
  const n = arr.length / 4;
  let worst = 0, worstIdx = -1, overCount = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.abs(arr[i*4] + arr[i*4+1] + arr[i*4+2] + arr[i*4+3] - 1);
    if (s > worst) { worst = s; worstIdx = i; }
    if (s > 0.05) overCount++;
  }
  return { verts: n, worstDeviation: worst, worstIdx, offByCount: overCount };
}

for (const file of FILES) {
  const full = path.join(ROOT, file);
  console.log('\n========================================');
  console.log(file);
  try {
    const doc = await IO.read(full);
    const root = doc.getRoot();
    const skins = root.listSkins();
    const meshes = root.listMeshes();
    console.log(`  meshes: ${meshes.length}, skins: ${skins.length}, textures: ${root.listTextures().length}`);

    for (const skin of skins) {
      const joints = skin.listJoints();
      const ibm = skin.getInverseBindMatrices();
      console.log(`  SKIN "${skin.getName() || '(unnamed)'}": joints=${joints.length} ibm=${ibm ? 'yes' : 'no'}`);

      // spot NaN in inverse bind matrices (a classic "spike" cause)
      if (ibm) {
        const m = ibm.getArray();
        let nan = 0;
        for (let i = 0; i < m.length; i++) if (!Number.isFinite(m[i])) nan++;
        console.log(`    ibm entries=${m.length} badFloats=${nan}`);
      }

      for (const j of joints.slice(0, 6)) {
        process.stdout.write(j.getName() + ' ');
      }
      if (joints.length > 6) process.stdout.write(`... (+${joints.length - 6})`);
      console.log('');

      const jointCount = joints.length;

      for (const mesh of meshes) {
        for (const prim of mesh.listPrimitives()) {
          const jointsAttr = prim.getAttribute('JOINTS_0');
          const weightsAttr = prim.getAttribute('WEIGHTS_0');
          const pos = prim.getAttribute('POSITION');
          const idx = prim.getIndices();
          if (!jointsAttr) continue;

          console.log(`  PRIMITIVE: verts=${pos.getCount()} tris=${idx ? idx.getCount()/3 : (pos.getCount()/3 |0)}`);

          if (pos) {
            const ps = statsForAccessor(pos, { normalized: false });
            console.log(`    POSITION min=[${ps.min.toFixed(3)}] max=[${ps.max.toFixed(3)}] badFloats=${ps.nan + ps.inf}`);
          }

          console.log(`    JOINTS_0  type=${COMP_NAME[jointsAttr.getComponentType()]}/${jointsAttr.getType()} normalized=${jointsAttr.getNormalized()}`);
          const js = statsForAccessor(jointsAttr, { normalized: jointsAttr.getNormalized() });
          const outOfRange = js.max >= jointCount;
          console.log(`              min=${js.min} max=${js.max}  →  ${outOfRange ? '❌ OUT OF RANGE (max >= jointCount ' + jointCount + ')' : '✅ in range'}`);

          console.log(`    WEIGHTS_0 type=${COMP_NAME[weightsAttr.getComponentType()]}/${weightsAttr.getType()} normalized=${weightsAttr.getNormalized()}`);
          const ws = statsForAccessor(weightsAttr, { normalized: weightsAttr.getNormalized() });
          console.log(`              min=${ws.min.toFixed(4)} max=${ws.max.toFixed(4)} nan=${ws.nan} inf=${ws.inf}`);
          const wsum = weightSumStats(weightsAttr);
          console.log(`              per-vert sum vs 1.0: worstDev=${wsum.worstDeviation.toFixed(4)} offByCount=${wsum.offByCount}/${wsum.verts}`);
        }
      }
    }

    // also list animations present in the file
    const anims = root.listAnimations();
    console.log(`  animations in file: ${anims.length} (${anims.map(a => a.getName() || '?').slice(0,5).join(', ')})`);
  } catch (e) {
    console.log('  ERROR reading:', e.message);
  }
}
