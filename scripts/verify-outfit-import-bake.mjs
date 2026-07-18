// Regression check for the Outfit Import Studio Blender bake
// (scripts/prepare-unrigged-outfit.py).
//
// Guards the 2026-07-14 "obliterated import" bug: Meshy/FBX cloth arrives as
// TRIANGLE SOUP (every triangle owns 3 private verts). Decimate on soup
// cannot edge-collapse — it deletes whole triangles, moth-eating the fabric
// into confetti. The bake must WELD vertices first (which also drops the
// count under the decimate budget), smooth-shade so the glTF export doesn't
// re-split every corner, transfer full weight coverage, sample a baked posed
// body surface, inverse-skin the garment back to bind space, and strip Meshy's
// white emissive (baked as glowing speckles at runtime).
//
// Builds a synthetic soup cloth from the authored peasant outfit geometry,
// runs the real Blender bake, and asserts the output is a connected, fully
// skinned, emissive-free garment in UBC bind space.
//
// Requires Blender (BLENDER_BIN or /Applications/Blender.app). Skips cleanly
// when unavailable (CI).
//
// Run: node scripts/verify-outfit-import-bake.mjs   (npm run verify:outfit-import-bake)

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import {
  applyPoseProcedure,
  capturePoseWorldDeltas,
  captureRestQuaternions,
  captureRestWorldMatrices,
} from '../src/game/characters/simhuman/outfitImportPose.js';
import { toRuntimeRigifyBoneName } from '../src/game/characters/simhuman/rigifySkeleton.js';
import { resolveSimOutfitBone } from '../src/game/characters/simhuman/simOutfitBoneMap.js';
import { getSimBodyProfile } from '../src/game/characters/simhuman/simBodyProfiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLENDER_BIN = process.env.BLENDER_BIN || '/Applications/Blender.app/Contents/MacOS/Blender';
const bodyArgIndex = process.argv.indexOf('--body');
const BODY_ID = bodyArgIndex >= 0 ? process.argv[bodyArgIndex + 1] : 'male';
const BODY_PROFILE = getSimBodyProfile(BODY_ID);
if (!BODY_PROFILE) throw new Error(`Unsupported --body ${BODY_ID}`);
const BODY_GLB = path.join(ROOT, 'public/assets/simhuman', BODY_PROFILE.outfitDonorFile);

if (!existsSync(BLENDER_BIN)) {
  console.log('verify-outfit-import-bake: SKIP (Blender not found; set BLENDER_BIN)');
  process.exit(0);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

function triangleUvKeysFromFlat(flat) {
  const keys = [];
  for (let i = 0; i < flat.length; i += 6) {
    const corners = [];
    for (let corner = 0; corner < 3; corner += 1) {
      corners.push(`${flat[i + corner * 2].toFixed(5)},${flat[i + corner * 2 + 1].toFixed(5)}`);
    }
    keys.push(corners.sort().join('|'));
  }
  return keys.sort();
}

function triangleUvKeysFromPrimitive(primitive) {
  const uv = primitive.getAttribute('TEXCOORD_0');
  const indices = primitive.getIndices().getArray();
  const keys = [];
  const value = [0, 0];
  for (let i = 0; i < indices.length; i += 3) {
    const corners = [];
    for (let corner = 0; corner < 3; corner += 1) {
      uv.getElement(indices[i + corner], value);
      corners.push(`${value[0].toFixed(5)},${value[1].toFixed(5)}`);
    }
    keys.push(corners.sort().join('|'));
  }
  return keys.sort();
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dreamfall-import-verify-'));
try {
  // Build the same exact-matrix pose payload used by the browser importer.
  const bodyDoc = await io.read(BODY_GLB);
  let bindMaxAbsX = 0;
  for (const mesh of bodyDoc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const value = [0, 0, 0];
      for (let i = 0; i < (position?.getCount() ?? 0); i += 1) {
        position.getElement(i, value);
        bindMaxAbsX = Math.max(bindMaxAbsX, Math.abs(value[0]));
      }
    }
  }
  const bodySkin = bodyDoc.getRoot().listSkins()[0];
  const jointNodes = new Set(bodySkin.listJoints());
  const boneByNode = new Map();
  const poseBones = {};
  for (const node of jointNodes) {
    const bone = new THREE.Bone();
    bone.name = node.getName();
    bone.position.fromArray(node.getTranslation());
    bone.quaternion.fromArray(node.getRotation());
    bone.scale.fromArray(node.getScale());
    boneByNode.set(node, bone);
    poseBones[bone.name] = bone;
  }
  const poseRoot = new THREE.Group();
  for (const node of jointNodes) {
    const bone = boneByNode.get(node);
    const parentBone = boneByNode.get(node.getParentNode());
    (parentBone ?? poseRoot).add(bone);
  }
  poseRoot.updateMatrixWorld(true);
  const restQuats = captureRestQuaternions(poseBones);
  const restWorld = captureRestWorldMatrices(poseBones, poseRoot);
  const poseResult = applyPoseProcedure(poseBones, restQuats, {
    procedure: 'arms-down',
    macros: {},
  });
  assert.ok(poseResult.applied >= 2, 'synthetic browser pose lowers both arms');
  poseRoot.updateMatrixWorld(true);
  const exactPose = capturePoseWorldDeltas(poseBones, restWorld, poseRoot);
  assert.equal(exactPose.format, 'bone-world-delta-v1');
  assert.ok(Object.keys(exactPose.bones).length >= 2, 'exact pose contains changed bone matrices');
  // In the browser, GLTFLoader sanitizes bone names (DEF-upper_arm.L →
  // DEF-upper_armL) and the Import Studio ships the pose under those runtime
  // names. Dotted Blender names here would mask the name-space mismatch that
  // made real bakes silently transfer against a T-pose body (2026-07-14).
  exactPose.bones = Object.fromEntries(
    Object.entries(exactPose.bones).map(([name, matrix]) => [
      toRuntimeRigifyBoneName(name),
      matrix,
    ]),
  );

  // --- Build posed soup cloth from the authored peasant -------------------
  // This mirrors the browser export: garment vertices are already arms-down,
  // while Blender receives the exact pose separately for spatial transfer.
  const src = await io.read(path.join(ROOT, 'public/assets/simoutfits/standard/male-peasant.glb'));
  const srcSkin = src.getRoot().listSkins()[0];
  const srcJoints = srcSkin.listJoints();
  const inverseBind = srcSkin.getInverseBindMatrices();
  const inv = new Array(16).fill(0);
  const unmappedSourceJoints = new Set();
  const jointMatrices = srcJoints.map((joint, index) => {
    inverseBind.getElement(index, inv);
    // Human5 intentionally omits the UBC finger-tip leaf helpers. For fixture
    // posing, inherit their parent joint transform just as a terminal helper
    // would; Blender's actual base-body transfer emits native human5 joints.
    const bone = resolveSimOutfitBone(poseBones, joint.getName())
      ?? resolveSimOutfitBone(poseBones, joint.getParentNode()?.getName());
    if (!bone) {
      // Some authored outfit skins retain a zero-weight scene root. It is not a
      // deformation dependency; fail below only if an exported vertex uses it.
      unmappedSourceJoints.add(index);
      return new THREE.Matrix4();
    }
    return bone.matrixWorld.clone().multiply(new THREE.Matrix4().fromArray(inv));
  });
  const positions = [];
  const uvs = [];
  const source = new THREE.Vector3();
  const skinned = new THREE.Vector3();
  const transformed = new THREE.Vector3();
  let unmappedSourceWeight = 0;
  for (const mesh of src.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const uv = prim.getAttribute('TEXCOORD_0');
      const joints = prim.getAttribute('JOINTS_0');
      const weights = prim.getAttribute('WEIGHTS_0');
      const idx = prim.getIndices().getArray();
      const pe = [0, 0, 0];
      const je = [0, 0, 0, 0];
      const we = [0, 0, 0, 0];
      const ue = [0, 0];
      assert.ok(joints && weights, `${mesh.getName()} is skinned`);
      for (let t = 0; t < idx.length; t += 1) {
        const vertex = idx[t];
        pos.getElement(vertex, pe);
        joints.getElement(vertex, je);
        weights.getElement(vertex, we);
        source.fromArray(pe);
        skinned.set(0, 0, 0);
        for (let k = 0; k < 4; k += 1) {
          if (we[k] <= 1e-8) continue;
          if (unmappedSourceJoints.has(je[k])) unmappedSourceWeight += we[k];
          transformed.copy(source).applyMatrix4(jointMatrices[je[k]]);
          skinned.addScaledVector(transformed, we[k]);
        }
        positions.push(skinned.x, skinned.y, skinned.z);
        if (uv) uv.getElement(vertex, ue);
        uvs.push(ue[0], ue[1]);
      }
    }
  }
  assert.ok(
    unmappedSourceWeight < 0.1,
    `weighted source outfit joints must map to the target body (unmapped weight ${unmappedSourceWeight})`,
  );
  const soupTris = positions.length / 9;
  const sourceTriangleUvs = triangleUvKeysFromFlat(uvs);

  const doc = new Document();
  const buffer = doc.createBuffer();
  const sentinel = new PNG({ width: 2, height: 2 });
  const colors = [
    [255, 0, 0, 255], [0, 255, 0, 255],
    [0, 0, 255, 255], [255, 255, 0, 255],
  ];
  colors.forEach((rgba, pixel) => sentinel.data.set(rgba, pixel * 4));
  const texture = doc.createTexture('OrientationSentinel')
    .setImage(PNG.sync.write(sentinel))
    .setMimeType('image/png');
  const mat = doc.createMaterial('ClothMat')
    .setBaseColorFactor([1, 1, 1, 1])
    .setBaseColorTexture(texture);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uvs)).setBuffer(buffer))
    .setMaterial(mat);
  doc.createScene('Scene').addChild(doc.createNode('Cloth').setMesh(doc.createMesh('Cloth').addPrimitive(prim)));
  const clothPath = path.join(tmp, 'soup-cloth.glb');
  await new NodeIO().write(clothPath, doc);

  const posePath = path.join(tmp, 'pose.json');
  writeFileSync(posePath, `${JSON.stringify(exactPose, null, 2)}\n`);
  const outPath = path.join(tmp, 'baked.glb');

  // --- Run the real bake ---------------------------------------------------
  const bakeLog = execFileSync(BLENDER_BIN, [
    '--background',
    '--python', path.join(ROOT, 'scripts/prepare-unrigged-outfit.py'),
    '--',
    '--cloth', clothPath,
    '--body', BODY_GLB,
    '--output', outPath,
    '--no-auto-align',
    '--pose', posePath,
    '--max-verts', '70000',
  ], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 8 * 60 * 1000 });
  assert.match(
    bakeLog,
    /applied exact glTF world-delta pose on [1-9]\d* bones/,
    'Blender must consume the exact matrix pose format (0 bones = name mismatch)',
  );
  assert.match(
    bakeLog,
    /posed transfer source baked modifiers=\d+/,
    'posed transfer must use an evaluated body snapshot',
  );
  // The posed body must actually be arms-down. pb.matrix assignment without a
  // per-bone depsgraph update stacked parent rotations onto chained bones
  // (forearm/hand), swinging arms UP/OUT (x ±1.49, z 3.77) — and the bug was
  // invisible to the round-trip asserts because transfer + inverse-skin shared
  // the same corrupt matrices. Assert the baked pose geometry directly.
  const posedAabb = bakeLog.match(
    /posed transfer source baked modifiers=\d+ AABB z\[(-?[\d.]+),(-?[\d.]+)\] x\[(-?[\d.]+),(-?[\d.]+)\]/,
  );
  assert.ok(posedAabb, 'bake log reports posed transfer source AABB');
  const posedZMax = Number(posedAabb[2]);
  const posedXMin = Number(posedAabb[3]);
  const posedXMax = Number(posedAabb[4]);
  assert.ok(
    posedZMax < 3.6,
    `arms-down posed body must not grow taller than bind (z max ${posedZMax})`,
  );
  assert.ok(
    Math.max(Math.abs(posedXMin), Math.abs(posedXMax)) < bindMaxAbsX * 0.8,
    `arms-down posed body must lower the arm span from ±${bindMaxAbsX.toFixed(3)} `
      + `to x [${posedXMin},${posedXMax}]`,
  );
  assert.match(
    bakeLog,
    /inverse-skinned cloth pose→rest converted=\d+\/\d+ missing=0 singular=0/,
    'posed cloth must return cleanly to bind space',
  );

  // --- Assert output shape -------------------------------------------------
  const baked = await io.read(outPath);
  const root = baked.getRoot();
  const skins = root.listSkins();
  assert.equal(skins.length, 1, 'baked GLB has one skin');

  const outPrim = root.listMeshes()[0].listPrimitives()[0];
  const pos = outPrim.getAttribute('POSITION');
  const ji = outPrim.getAttribute('JOINTS_0');
  const jw = outPrim.getAttribute('WEIGHTS_0');
  const idx = outPrim.getIndices().getArray();
  assert.ok(ji && jw, 'baked cloth is skinned');
  assert.deepEqual(
    triangleUvKeysFromPrimitive(outPrim),
    sourceTriangleUvs,
    'Blender bake preserves every triangle UV and its orientation',
  );
  assert.ok(outPrim.getMaterial()?.getBaseColorTexture(), 'base-color texture survives Blender bake');

  // Exact posed sampling must recover sleeve ownership and lift the authored
  // arms-down geometry back out into bind space. The broken local-Euler path
  // left cuffs near the torso with no forearm-dominant vertices.
  const outJoints = skins[0].listJoints();
  const jointElement = [0, 0, 0, 0];
  const weightElement = [0, 0, 0, 0];
  const positionElement = [0, 0, 0];
  let forearmVerts = 0;
  let limbMaxAbsX = 0;
  for (let i = 0; i < pos.getCount(); i += 1) {
    ji.getElement(i, jointElement);
    jw.getElement(i, weightElement);
    let best = 0;
    for (let k = 1; k < 4; k += 1) if (weightElement[k] > weightElement[best]) best = k;
    const jointName = outJoints[jointElement[best]]?.getName() ?? '';
    if (!/upper_arm|forearm|hand/i.test(jointName)) continue;
    pos.getElement(i, positionElement);
    limbMaxAbsX = Math.max(limbMaxAbsX, Math.abs(positionElement[0]));
    if (/forearm/i.test(jointName)) forearmVerts += 1;
  }
  assert.ok(forearmVerts > 20, `sleeves retain forearm ownership (${forearmVerts} verts)`);
  assert.ok(limbMaxAbsX > 0.8, `sleeves return to bind-pose arm span (${limbMaxAbsX.toFixed(3)})`);

  const vertCount = pos.getCount();
  const triCount = idx.length / 3;
  assert.ok(
    vertCount < soupTris * 3 * 0.5,
    `weld must collapse soup verts (got ${vertCount} of ${soupTris * 3} soup verts)`,
  );

  // Connectivity: union-find over the index. Soup ⇒ components == tris.
  const parent = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i += 1) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < idx.length; t += 3) {
    parent[find(idx[t])] = find(idx[t + 1]);
    parent[find(idx[t + 1])] = find(idx[t + 2]);
  }
  const components = new Set();
  for (let i = 0; i < vertCount; i += 1) components.add(find(i));
  assert.ok(
    components.size < triCount * 0.05,
    `baked mesh must be connected, not triangle soup (components=${components.size} tris=${triCount})`,
  );

  // Full weight coverage, normalized.
  const we = [0, 0, 0, 0];
  let uncovered = 0;
  for (let i = 0; i < vertCount; i += 1) {
    jw.getElement(i, we);
    const sum = we[0] + we[1] + we[2] + we[3];
    if (sum < 0.5) uncovered += 1;
  }
  assert.equal(uncovered, 0, 'every baked vert carries skin weights');

  // Bind-space height ≈ UBC (~3.0–3.6), not runtime 1.75.
  const pe = [0, 0, 0];
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < vertCount; i += 1) {
    pos.getElement(i, pe);
    if (pe[1] < yMin) yMin = pe[1];
    if (pe[1] > yMax) yMax = pe[1];
  }
  assert.ok(yMax - yMin > 2.2 && yMax - yMin < 5, `bind height sane (${(yMax - yMin).toFixed(2)})`);

  // Meshy emissive must be stripped.
  for (const material of root.listMaterials()) {
    const emissive = material.getEmissiveFactor();
    assert.ok(
      !material.getEmissiveTexture() && emissive[0] + emissive[1] + emissive[2] === 0,
      `material ${material.getName()} must not be emissive`,
    );
  }

  console.log(
    `verify-outfit-import-bake: ${BODY_ID} weld ${soupTris * 3}→${vertCount} verts, `
    + `${components.size} components, forearm=${forearmVerts}, armSpan=${limbMaxAbsX.toFixed(3)}, `
    + 'full weights, no emissive OK',
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
