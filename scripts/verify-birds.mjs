/**
 * verify-birds — guards the Aves MVP catalog + goose-body variety contract.
 *
 * - Order Aves present with top-10 taxonomic families
 * - Each family has ≥1 authored bird-rig breed
 * - Every bird breed has a goose-body variety profile (scale/palette/pattern)
 * - Legacy bird-rigged.glb still ships (fallback / tooling)
 * - Catalog is pure node (no WebGPU)
 *
 * Run:  node scripts/verify-birds.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANIMAL_ORDERS,
  ANIMAL_SPECIES,
  AUTHORED_BIRD_BREED_IDS,
  AUTHORED_DOG_BREED_IDS,
  DOG_BREEDS,
  getAnimalSpecies,
  getDogBreed,
  isAvianSpecies,
  isBirdBreed,
  isSpeciesPopulated,
} from '../src/game/characters/dog/dogCatalog.js';
import {
  BIRD_BREED_PRESENTATION,
  BIRD_CLIP_CATALOG,
  BIRD_MODEL_URL,
} from '../src/game/characters/dog/createAuthoredBird.js';
import {
  BIRD_VARIETIES,
  resolveBirdVariety,
} from '../src/game/characters/goose/birdVarietyProfile.js';
import { GOOSE_CLIP_CATALOG } from '../src/game/characters/goose/gooseAnimation.js';
import { animalClipLibraryKind } from '../src/game/characters/dog/DogClipPlayer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const TOP10 = [
  'tyrannidae',
  'thraupidae',
  'trochilidae',
  'columbidae',
  'muscicapidae',
  'furnariidae',
  'accipitridae',
  'fringillidae',
  'anatidae',
  'psittacidae',
];

const MVP_BREEDS = [
  'eastern-phoebe',
  'blue-gray-tanager',
  'ruby-throated-hummingbird',
  'rock-pigeon',
  'european-robin',
  'rufous-hornero',
  'red-tailed-hawk',
  'house-finch',
  'mallard',
  'canada-goose',
  'scarlet-macaw',
];

// --- Order + species ---
{
  assert.ok(ANIMAL_ORDERS.some((o) => o.id === 'aves'), 'missing aves order');
  const aves = ANIMAL_SPECIES.filter((s) => s.orderId === 'aves');
  assert.equal(aves.length, 10, `expected 10 aves species, got ${aves.length}`);
  for (const id of TOP10) {
    assert.ok(getAnimalSpecies(id), `missing species ${id}`);
    assert.equal(getAnimalSpecies(id).orderId, 'aves');
    assert.ok(isAvianSpecies(id), `${id} should be avian`);
    assert.ok(isSpeciesPopulated(id), `${id} should be populated`);
  }
  ok('Aves order + top-10 families populated');
}

// --- Breeds / flags / presentation ---
{
  assert.equal(AUTHORED_BIRD_BREED_IDS.length, 11, `expected 11 bird breeds, got ${AUTHORED_BIRD_BREED_IDS.length}`);
  for (const id of MVP_BREEDS) {
    assert.ok(AUTHORED_BIRD_BREED_IDS.includes(id), `missing bird breed ${id}`);
    assert.ok(isBirdBreed(id), `${id} should be bird-rig`);
    const breed = getDogBreed(id);
    assert.ok(breed.conformationFlags.includes('bird-rig'));
    assert.ok(breed.conformationFlags.includes('avian'));
    assert.ok(BIRD_BREED_PRESENTATION[id], `${id} missing presentation scale/color`);
    // Birds must NOT enter the quadruped phenotype / park ambient pool.
    assert.ok(!AUTHORED_DOG_BREED_IDS.includes(id), `${id} leaked into AUTHORED_DOG_BREED_IDS`);
    assert.equal(
      animalClipLibraryKind({ breedId: id }),
      null,
      `${id} must not use dog-bone clip packs`,
    );
    assert.equal(
      animalClipLibraryKind({ speciesId: breed.speciesId }),
      null,
      `${breed.speciesId} must not use dog-bone clip packs`,
    );
  }
  ok('11 authored bird breeds flagged bird-rig with presentation, excluded from quadruped set');
}

// --- canada-goose (2nd anatidae breed; long-neck waterfowl) ---
{
  const id = 'canada-goose';
  assert.ok(AUTHORED_BIRD_BREED_IDS.includes(id), 'canada-goose missing from authored bird set');
  assert.ok(isBirdBreed(id), 'canada-goose should be bird-rig');
  const breed = getDogBreed(id);
  assert.equal(breed.familyId, 'duck-goose-swan', 'canada-goose must sit under duck-goose-swan');
  for (const flag of ['bird-rig', 'avian', 'waterfowl']) {
    assert.ok(breed.conformationFlags.includes(flag), `canada-goose missing flag ${flag}`);
  }
  assert.ok(!AUTHORED_DOG_BREED_IDS.includes(id), 'canada-goose leaked into quadruped authored set');
  assert.equal(animalClipLibraryKind({ breedId: id }), null, 'canada-goose must not use dog-bone clip packs');
  const pres = BIRD_BREED_PRESENTATION[id];
  assert.ok(pres, 'canada-goose missing presentation');
  assert.ok(Number.isFinite(pres.scale) && pres.scale > 1.0, 'canada-goose should read larger than a mallard');
  assert.ok(pres.neckLen > 1.0, 'canada-goose must opt into the long-neck knob');
  assert.equal(pres.bodyPlan, 'waterfowl');
  ok('canada-goose authored under anatidae with long-neck presentation');
}

// --- Goose-body varieties (studio path for all birds) ---
{
  for (const id of MVP_BREEDS) {
    assert.ok(BIRD_VARIETIES[id], `${id} missing goose-body variety`);
    const v = resolveBirdVariety(id, 1);
    assert.ok(Number.isFinite(v.scale) && v.scale > 0.05 && v.scale <= 1.2, `${id} scale`);
    assert.ok(v.palette?.backBase?.length === 3, `${id} palette.backBase`);
    assert.ok(v.palette?.stocking?.length === 3, `${id} palette.stocking`);
    assert.ok(Number.isFinite(v.stockingAmt) && v.stockingAmt >= 0, `${id} stockingAmt`);
    assert.ok(Number.isFinite(v.chinstrapAmt) && v.chinstrapAmt >= 0, `${id} chinstrapAmt`);
    assert.ok(v.label, `${id} variety label`);
    // Shape morph knobs
    assert.ok(Number.isFinite(v.neckLen) && v.neckLen >= 0 && v.neckLen <= 1, `${id} neckLen`);
    assert.ok(Number.isFinite(v.bodyUpright) && v.bodyUpright >= 0 && v.bodyUpright <= 1, `${id} bodyUpright`);
    assert.ok(Number.isFinite(v.bodyFat) && v.bodyFat > 0.5, `${id} bodyFat`);
    assert.ok(v.beakStyle, `${id} beakStyle`);
    assert.ok(v.footStyle, `${id} footStyle`);
    assert.ok(v.eyeStyle, `${id} eyeStyle`);
  }
  const goose = resolveBirdVariety('canada-goose', 1);
  assert.ok(goose.scale >= 0.95 && goose.scale <= 1.05, 'canada-goose is reference scale ~1');
  assert.equal(goose.stockingAmt, 1);
  assert.equal(goose.chinstrapAmt, 1);
  assert.ok(goose.neckLen >= 0.95, 'canada-goose full neck');
  assert.ok(goose.bodyUpright <= 0.1, 'canada-goose horizontal body');
  assert.equal(goose.beakStyle, 'goose');
  assert.equal(goose.footStyle, 'web');
  const hum = resolveBirdVariety('ruby-throated-hummingbird', 1);
  assert.ok(hum.scale < goose.scale * 0.35, 'hummingbird much smaller than goose');
  assert.ok(hum.neckLen < 0.15, 'hummingbird almost no neck');
  assert.ok(hum.bodyUpright > 0.8, 'hummingbird upright');
  assert.equal(hum.beakStyle, 'needle');
  const hawk = resolveBirdVariety('red-tailed-hawk', 1);
  assert.ok(hawk.scale > hum.scale * 2, 'hawk larger than hummingbird');
  assert.equal(hawk.beakStyle, 'hook');
  assert.equal(hawk.footStyle, 'talon');
  assert.equal(hawk.eyeStyle, 'raptor');
  const robin = resolveBirdVariety('european-robin', 1);
  assert.ok(robin.neckLen < 0.2, 'robin short neck');
  assert.ok(robin.bodyUpright > 0.8, 'robin upright');
  assert.equal(robin.footStyle, 'perch');
  ok('11 bird breeds resolve as goose-body varieties (scale/palette/shape morph)');
}

// --- Shape morph geometry (neck / upright / beak / feet) ---
{
  const { resolveGooseMorph } = await import('../src/game/characters/goose/gooseMorph.js');
  const { createGooseSkeleton } = await import('../src/game/characters/goose/gooseSkeleton.js');
  const { buildGooseBodyGeometry } = await import('../src/game/characters/goose/gooseBodyGeometry.js');

  const full = resolveGooseMorph({ neckLen: 1, bodyUpright: 0, beakStyle: 'goose', footStyle: 'web' });
  const none = resolveGooseMorph({ neckLen: 0, bodyUpright: 0.9, beakStyle: 'point', footStyle: 'perch', eyeStyle: 'large' });
  // headPos is [x,y,z]; neckPath entries are [x,y,z]
  const headY = (hp) => (hp.length >= 3 ? hp[1] : hp[0]);
  assert.ok(headY(full.headPos) > headY(none.headPos) + 0.15, 'full neck head much higher than short (horizontal ref)');
  // Short upright neck is a stump: head near neck base.
  const span3 = (head, neck0) => {
    const hx = head.length >= 3 ? head[0] : 0;
    const hy = head.length >= 3 ? head[1] : head[0];
    const hz = head.length >= 3 ? head[2] : head[1];
    const nx = neck0.length >= 3 ? neck0[0] : 0;
    const ny = neck0.length >= 3 ? neck0[1] : neck0[0];
    const nz = neck0.length >= 3 ? neck0[2] : neck0[1];
    return Math.hypot(hx - nx, hy - ny, hz - nz);
  };
  const neckSpanFull = span3(full.headPos, full.neckPath[0]);
  const neckSpanNone = span3(none.headPos, none.neckPath[0]);
  assert.ok(neckSpanFull > neckSpanNone * 2.5, 'full neck span much longer than almost-none');

  // Socket 180° flip moves head to the opposite side of the socket.
  const flip = resolveGooseMorph({ neckLen: 1, bodyUpright: 0, neckSocketRotX: 180 });
  assert.ok(
    (full.headPos[1] - full.neckSocket.y) * (flip.headPos[1] - flip.neckSocket.y) < 0,
    'neckSocketRotX 180 flips head across socket',
  );

  for (const style of ['goose', 'flat', 'point', 'cone', 'needle', 'hook']) {
    const m = resolveGooseMorph({ beakStyle: style, neckLen: 0.5 });
    assert.equal(m.beak.style, style);
    assert.ok(m.beak.length > 0.2, `${style} beak length`);
  }
  for (const style of ['web', 'perch', 'talon', 'zygodactyl']) {
    const m = resolveGooseMorph({ footStyle: style });
    assert.equal(m.foot.style, style);
    assert.equal(m.foot.web, style === 'web');
  }

  // Geometry builds for extreme morphs without throwing.
  for (const m of [full, none, resolveGooseMorph({ beakStyle: 'needle', neckLen: 0.02, bodyUpright: 1, footStyle: 'talon', eyeStyle: 'raptor' })]) {
    const rig = createGooseSkeleton(m);
    const geo = buildGooseBodyGeometry(rig.boneIndex, m);
    assert.ok(geo.getAttribute('position').count > 500, 'morphed mesh has verts');
    geo.dispose();
  }
  ok('goose morph: neck range, beak/foot styles, geometry builds');
}

// --- Clip catalog (legacy GLB names + goose procedural FSM) ---
{
  const names = new Set(BIRD_CLIP_CATALOG.map((c) => c.name));
  for (const required of ['Idle', 'Walk', 'Flap', 'Glide', 'Rest Pose']) {
    assert.ok(names.has(required), `BIRD_CLIP_CATALOG missing ${required}`);
  }
  const gooseNames = new Set(GOOSE_CLIP_CATALOG.map((c) => c.name));
  for (const required of ['Idle', 'Walk', 'Flap', 'Fly Flap', 'Fly Glide', 'Rest Pose']) {
    assert.ok(gooseNames.has(required), `GOOSE_CLIP_CATALOG missing ${required}`);
  }
  ok('BIRD_CLIP_CATALOG + GOOSE_CLIP_CATALOG have required motion names');
}

// --- GLB asset contract ---
{
  const rel = BIRD_MODEL_URL.replace(/^\//, '');
  const abs = join(root, 'public', rel.replace(/^assets\//, 'assets/'));
  // BIRD_MODEL_URL is /assets/models/bird-rigged.glb → public/assets/models/...
  const publicPath = join(root, 'public', 'assets', 'models', 'bird-rigged.glb');
  assert.ok(existsSync(publicPath), `missing ${publicPath}`);
  const buf = readFileSync(publicPath);
  assert.equal(buf.toString('utf8', 0, 4), 'glTF', 'bird-rigged.glb magic');
  // Parse JSON chunk for joints + anim names
  let offset = 12;
  const chunkLen = buf.readUInt32LE(offset);
  offset += 8; // len + type
  const json = JSON.parse(buf.toString('utf8', offset, offset + chunkLen));
  const joints = json.skins?.[0]?.joints ?? [];
  assert.ok(joints.length >= 50, `expected ≥50 joints, got ${joints.length}`);
  const nodeNames = new Set((json.nodes ?? []).map((n) => n.name));
  for (const bone of ['root', 'hips', 'head', 'wing_1_L', 'wing_1_R', 'Foot_L', 'Foot_R']) {
    assert.ok(nodeNames.has(bone), `missing bone node ${bone}`);
  }
  const animNames = new Set((json.animations ?? []).map((a) => a.name));
  for (const clip of ['Idle', 'Walk', 'Flap', 'Glide', 'Rest Pose']) {
    assert.ok(animNames.has(clip), `GLB missing clip ${clip}`);
  }
  ok(`bird-rigged.glb (${(buf.length / 1024).toFixed(0)} KiB) joints=${joints.length} clips=${animNames.size}`);
  void abs;
  void rel;
}

// --- Authored quadruped count unchanged ---
{
  assert.equal(AUTHORED_DOG_BREED_IDS.length, 120, 'quadruped authored count must stay 120');
  const birdAuthored = DOG_BREEDS.filter((b) => b.authored && b.conformationFlags?.includes('bird-rig'));
  assert.equal(birdAuthored.length, 11);
  ok('quadruped authored pool still 120; +11 bird-rig authored');
}

// --- Reference boards (4 views each) ---
{
  const views = ['three-quarter', 'profile', 'front-sit', 'head-close'];
  for (const id of MVP_BREEDS) {
    const board = join(root, 'assets-source', 'bird-ref', id, 'board.jpg');
    assert.ok(existsSync(board), `missing source board ${board}`);
    for (const view of views) {
      const still = join(root, 'public', 'assets', 'bird-ref', id, `${view}.jpg`);
      assert.ok(existsSync(still), `missing still ${still}`);
    }
  }
  ok('11 photo-board breeds × 4 reference stills + source boards present');
}

// --- Procedural mesh fits a synthetic bird skeleton ---
{
  const { buildBirdBodyGeometry, remapBirdSkinIndices } = await import(
    '../src/game/characters/dog/buildBirdBodyGeometry.js'
  );
  const THREE = await import('three');

  function bone(name, x, y, z, parent = null) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    if (parent) parent.add(b);
    return b;
  }
  const rootBone = bone('root', 0, 0, 0);
  const hips = bone('hips', 0, 0.5, -0.08, rootBone);
  const s0 = bone('spine_0', 0, -0.02, 0.14, hips);
  const s1 = bone('spine_1', 0, 0, 0.2, s0);
  const s2 = bone('spine_2', 0, 0.03, 0.16, s1);
  const s3 = bone('spine_3', 0, 0.01, 0.12, s2);
  const head = bone('head', 0, -0.01, 0.15, s3);
  bone('mouth_upper', 0, -0.02, 0.12, head);
  bone('mouth_upper_tip', 0, -0.03, 0.12, head.children[0]);
  bone('mouth_lower', 0, -0.04, 0.08, head);
  bone('mouth_lower_tip', 0, -0.02, 0.1, head.children[1]);
  const t1 = bone('tail_1', 0, 0, -0.2, hips);
  const t2 = bone('tail_2', 0, 0, -0.15, t1);
  const t3 = bone('tail_3', 0, 0, -0.2, t2);
  bone('tail_tip', 0, 0, -0.2, t3);
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const u = bone(`UpperLeg_${side}`, 0.05 * sx, -0.05, -0.08, hips);
    const l = bone(`LowerLeg_${side}`, 0, -0.15, -0.05, u);
    const a = bone(`AnkleLeg_${side}`, 0, -0.15, -0.08, l);
    const f = bone(`Foot_${side}`, 0, -0.1, -0.1, a);
    const to = bone(`Toes_${side}`, 0, -0.05, -0.05, f);
    bone(`Toes_tip_${side}`, 0, -0.03, -0.04, to);
    const w1 = bone(`wing_1_${side}`, 0.1 * sx, -0.02, 0.05, s1);
    const w2 = bone(`wing_2_${side}`, 0.05 * sx, -0.3, -0.05, w1);
    const w3 = bone(`wing_3_${side}`, 0.05 * sx, -0.4, -0.05, w2);
    const w4 = bone(`wing_4_${side}`, 0.04 * sx, -0.35, -0.02, w3);
    const w5 = bone(`wing_5_${side}`, 0.03 * sx, -0.3, 0, w4);
    bone(`wing_tip_${side}`, 0, -0.2, 0, w5);
    for (const n of [1, 2, 3, 4]) {
      const parent = n <= 1 ? w2 : n <= 2 ? w3 : n <= 3 ? w4 : w5;
      const f1 = bone(`wing_feather_${n}_1_${side}`, 0.05 * sx, -0.05, 0.02, parent);
      bone(`wing_feather_${n}_2_${side}`, 0, -0.15, 0, f1);
    }
  }
  rootBone.updateWorldMatrix(true, true);
  const bonesByName = new Map();
  rootBone.traverse((o) => {
    if (o.isBone) {
      bonesByName.set(o.name, o);
      if (o.name === 'head') bonesByName.set('Head', o);
    }
  });
  const geo = buildBirdBodyGeometry(bonesByName, {
    bodyFat: 1, wingChord: 1.15, beakLen: 1.1, breast: 1.1, tailSpread: 1.2,
  });
  const vcount = geo.getAttribute('position').count;
  assert.ok(vcount >= 1500, `expected dense bird mesh, got ${vcount} verts`);
  assert.ok(geo.getAttribute('skinIndex'), 'missing skinIndex');
  assert.ok(geo.getAttribute('skinWeight'), 'missing skinWeight');
  assert.ok(geo.getAttribute('color'), 'missing plumage zone color attribute');
  // Zone keys should include body(1,0,0) and wing(0,0,1) samples.
  const col = geo.getAttribute('color');
  let hasBody = false;
  let hasWing = false;
  let hasBellyBlend = false;
  let hasBeak = false;
  for (let i = 0; i < col.count; i += 1) {
    const r = col.getX(i);
    const g = col.getY(i);
    const b = col.getZ(i);
    if (r > 0.7 && g < 0.3 && b < 0.3) hasBody = true;
    if (b > 0.7 && r < 0.3 && g < 0.3) hasWing = true;
    if (r > 0.2 && g > 0.2 && b < 0.2) hasBellyBlend = true;
    if (r < 0.4 && g > 0.6 && b > 0.6) hasBeak = true;
  }
  assert.ok(hasBody, 'expected body zone verts');
  assert.ok(hasWing, 'expected wing zone verts');
  assert.ok(hasBellyBlend, 'expected body↔belly blend verts');
  assert.ok(hasBeak, 'expected beak/eye zone verts');
  const boneArr = [];
  bonesByName.forEach((b, n) => { if (n !== 'Head') boneArr.push(b); });
  const skeleton = new THREE.Skeleton(boneArr);
  remapBirdSkinIndices(geo, skeleton);
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  mesh.bind(skeleton);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.z > 0.4, `body length too short (${size.z})`);
  assert.ok(size.x > 0.15, `body width too thin (${size.x})`);

  // Seed presentation variation is deterministic and stays near base scale.
  const { varyBirdPresentation, BIRD_BREED_PRESENTATION } = await import(
    '../src/game/characters/dog/createAuthoredBird.js'
  );
  const base = BIRD_BREED_PRESENTATION['eastern-phoebe'];
  const a = varyBirdPresentation(base, 1);
  const b = varyBirdPresentation(base, 1);
  const c = varyBirdPresentation(base, 2);
  assert.equal(a.scale, b.scale, 'seed presentation not deterministic');
  assert.notEqual(a.scale, c.scale, 'distinct seeds should vary scale');
  assert.ok(Math.abs(a.scale / base.scale - 1) < 0.08, 'seed scale jitter out of range');

  // Plumage material builds a colorNode graph.
  const { createBirdPlumageMaterial } = await import(
    '../src/game/characters/dog/birdPlumageMaterial.js'
  );
  const mat = createBirdPlumageMaterial(base);
  assert.ok(mat, 'plumage material missing');
  assert.ok(mat.colorNode || mat.vertexColors, 'plumage material needs colorNode or vertexColors');
  mat.dispose?.();

  // --- neckLen knob contract ---
  // Guards the canada-goose long-neck feature without destabilising the 10
  // existing birds: (1) neckLen omitted and neckLen:1 must be byte-identical,
  // and (2) neckLen > 1 must grow a raised, accent-zone neck. The "grows neck"
  // checks hold bodyPlan fixed so only neckLen varies.
  const def = buildBirdBodyGeometry(bonesByName, {});
  const explicitOne = buildBirdBodyGeometry(bonesByName, { neckLen: 1 });
  assert.equal(
    def.getAttribute('position').count,
    explicitOne.getAttribute('position').count,
    'neckLen:1 must match default vertex count (existing birds unaffected)',
  );
  {
    const pa = def.getAttribute('position').array;
    const pb = explicitOne.getAttribute('position').array;
    assert.equal(pa.length, pb.length);
    let byteIdentical = true;
    for (let i = 0; i < pa.length; i += 1) {
      if (Math.abs(pa[i] - pb[i]) > 1e-6) { byteIdentical = false; break; }
    }
    assert.ok(byteIdentical, 'neckLen:1 positions must be byte-identical to default');
  }

  const noNeck = buildBirdBodyGeometry(bonesByName, { bodyPlan: 'waterfowl' });
  const necked = buildBirdBodyGeometry(bonesByName, {
    bodyPlan: 'waterfowl', neckLen: 1.9, neckThick: 1.15,
  });
  assert.ok(
    necked.getAttribute('position').count > noNeck.getAttribute('position').count,
    'long neck must add vertices',
  );
  const noNeckBox = new THREE.Box3().setFromBufferAttribute(noNeck.getAttribute('position'));
  const neckedBox = new THREE.Box3().setFromBufferAttribute(necked.getAttribute('position'));
  const hip = new THREE.Vector3();
  const headBonePos = new THREE.Vector3();
  bonesByName.get('hips').getWorldPosition(hip);
  bonesByName.get('head').getWorldPosition(headBonePos);
  const bodyLen = hip.distanceTo(headBonePos) || 0.5;
  assert.ok(
    neckedBox.max.y > noNeckBox.max.y + bodyLen * 0.2,
    `long neck should raise head Y (noNeck=${noNeckBox.max.y.toFixed(3)}, necked=${neckedBox.max.y.toFixed(3)})`,
  );
  // Neck rings are accent-zone (1,1,0) and must sit above the shoulder midline.
  const shoulderY = hip.y + (headBonePos.y - hip.y) * 0.5;
  const accentAboveShoulder = (g) => {
    const col = g.getAttribute('color');
    const pos = g.getAttribute('position');
    let n = 0;
    for (let i = 0; i < col.count; i += 1) {
      if (col.getX(i) > 0.6 && col.getY(i) > 0.6 && col.getZ(i) < 0.4 && pos.getY(i) > shoulderY) n += 1;
    }
    return n;
  };
  assert.ok(
    accentAboveShoulder(necked) > accentAboveShoulder(noNeck),
    'long neck must add accent-zone verts above the shoulder',
  );
  def.dispose();
  explicitOne.dispose();
  noNeck.dispose();
  necked.dispose();
  ok('neckLen knob: default byte-identical no-op; neckLen>1 grows a raised accent neck');

  geo.dispose();
  ok(`procedural bird mesh ${vcount} verts, size ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)} + seed/material`);
}

// --- Skeleton clone must rebind bones (animation skinning contract) ---
{
  // Guard the "frozen bird" bug: Object3D.clone shares template skeleton bones
  // while the mixer animates the clone hierarchy. Skinning then never moves.
  // createAuthoredBird uses SkeletonUtils.clone + rebindSkeletonToHierarchy.
  const src = readFileSync(join(root, 'src/game/characters/dog/createAuthoredBird.js'), 'utf8');
  assert.ok(
    src.includes('SkeletonUtils') || src.includes('cloneSkinnedHierarchy') || src.includes('clone as cloneSkinned'),
    'createAuthoredBird must SkeletonUtils-clone the bird rig (not Object3D.clone alone)',
  );
  assert.ok(
    src.includes('rebindSkeletonToHierarchy') || src.includes('cloneSkinnedHierarchy'),
    'createAuthoredBird must rebind skeleton bones to the clone hierarchy',
  );
  ok('animation skinning contract: skinned clone + hierarchy rebind');
}

// --- Canada goose proportion oracle + procedural-only display ---
{
  // Measurement GLB may exist for offline proportion tooling; it is never displayed.
  const gooseGlb = join(root, 'public', 'assets', 'models', 'bird-canada-goose.glb');
  if (existsSync(gooseGlb)) {
    const buf = readFileSync(gooseGlb);
    assert.equal(buf.toString('utf8', 0, 4), 'glTF', 'goose glb magic');
  }
  const {
    BODY_PLAN_PROFILES,
    BIRD_SHAPE_KIT,
    CANADA_GOOSE_MESH_BOUNDS,
    CANADA_GOOSE_ENVELOPE,
    CANADA_GOOSE_PALETTE,
    getBodyPlanProfile,
    planStationRadii,
    sampleEnvelope,
    waterfowlStationRadii,
  } = await import('../src/game/characters/dog/birdProportionProfile.js');
  assert.ok(CANADA_GOOSE_MESH_BOUNDS.lengthOverHeight > 2.4, 'goose L/H should be ~2.67');
  assert.ok(CANADA_GOOSE_MESH_BOUNDS.lengthOverHeight < 3.0, 'goose L/H sanity');
  assert.ok(CANADA_GOOSE_ENVELOPE.length >= 10, 'envelope stations');
  // Neck region is thin; body max is wide (folded wing bulk)
  const neck = sampleEnvelope(0.75, CANADA_GOOSE_ENVELOPE);
  const body = sampleEnvelope(0.45, CANADA_GOOSE_ENVELOPE);
  assert.ok(body.halfW > neck.halfW * 4, 'body should be much wider than neck');
  const mid = waterfowlStationRadii(0.45, 1.0);
  assert.ok(mid.rx > 0.05 && mid.ry > 0.02, 'waterfowl radii scale');
  assert.ok(CANADA_GOOSE_PALETTE.color != null, 'goose zone palette');
  assert.ok(CANADA_GOOSE_PALETTE.chin != null, 'goose chin field mark');
  assert.ok(!('albedoUrl' in CANADA_GOOSE_PALETTE), 'palette must not ship GLB albedo');
  assert.ok(BODY_PLAN_PROFILES.waterfowl, 'waterfowl body plan');
  assert.ok(BODY_PLAN_PROFILES.passerine, 'passerine body plan');
  assert.equal(getBodyPlanProfile('waterfowl').neckLen, BODY_PLAN_PROFILES.waterfowl.neckLen);
  assert.ok(BIRD_SHAPE_KIT.body === 'ovalLoft', 'dog-style shape kit');
  const passR = planStationRadii('passerine', 0.5, 1.0);
  assert.ok(passR.rx > 0.01 && passR.ry > 0.01, 'passerine envelope radii');
  const breed = getDogBreed('canada-goose');
  assert.ok(breed?.conformationFlags?.includes('bird-rig'), 'canada-goose catalog');
  assert.ok(isBirdBreed('canada-goose'));
  const {
    birdModelUrlForBreed,
    BIRD_BREED_PRESENTATION,
    BIRD_MODEL_URL,
  } = await import('../src/game/characters/dog/createAuthoredBird.js');
  // All birds share the procedural rig — never a per-breed display mesh URL.
  assert.equal(birdModelUrlForBreed('canada-goose'), BIRD_MODEL_URL);
  assert.equal(birdModelUrlForBreed('eastern-phoebe'), BIRD_MODEL_URL);
  assert.ok(BIRD_BREED_PRESENTATION['canada-goose']?.neckLen > 1.5, 'long neck presentation');
  assert.equal(BIRD_BREED_PRESENTATION['canada-goose']?.bodyPlan, 'waterfowl');
  // Guard: no source-mesh display path in createAuthoredBird.
  const authoredSrc = readFileSync(join(root, 'src/game/characters/dog/createAuthoredBird.js'), 'utf8');
  assert.ok(!authoredSrc.includes('useSourceMesh'), 'must not support source-mesh display');
  assert.ok(!authoredSrc.includes('BIRD_BREED_USE_SOURCE_MESH'), 'must not list source-mesh breeds');
  assert.ok(authoredSrc.includes('buildBirdBodyGeometry'), 'must build procedural geometry');
  ok('canada goose proportion oracle + procedural-only birds');
}

console.log(`\nverify-birds: ${passed} checks passed`);
