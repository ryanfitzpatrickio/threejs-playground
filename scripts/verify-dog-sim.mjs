/**
 * verify-dog-sim — guards procedural dog skeleton/geometry/animation contracts.
 *
 * Run: node scripts/verify-dog-sim.mjs
 */

import * as THREE from 'three';
import { createDogSkeleton, DOG_BONE_DEFS, DOG_LEG_CHAINS } from '../src/game/characters/dog/dogSkeleton.js';
import { buildDogBodyGeometry } from '../src/game/characters/dog/dogBodyGeometry.js';
import { COAT_ZONE, colorMaskAt, unpackCoatMask } from '../src/game/characters/dog/dogCoatFields.js';
import { createDogAnimation } from '../src/game/characters/dog/dogAnimation.js';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';
import { createDogBoneDefs, DOG_TAIL_BONES } from '../src/game/characters/dog/dogSkeleton.js';
import { DOG_PAW_MESH_PAD } from '../src/game/characters/dog/dogFootPlant.js';
import {
  ANIMAL_ORDERS,
  ANIMAL_SPECIES,
  AUTHORED_DOG_BREED_IDS,
  DOG_BREEDS,
  DOG_FAMILIES,
  DOG_LINEAGE_KEYS,
  getDogVariants,
  getFamiliesForSpecies,
  getSpeciesIdForBreed,
  isSpeciesPopulated,
  normalizeDogVariantId,
  normalizeRenderableDogBreedId,
} from '../src/game/characters/dog/dogCatalog.js';
import {
  DOG_PHENOTYPE_PROFILES,
  resolveDogPhenotype,
} from '../src/game/characters/dog/dogPhenotypes.js';
import { nearestCoatPattern } from '../src/game/characters/dog/animalPhenotypeClamp.js';
import { dogRefUrl, dogRefUrlChain } from '../src/game/test/DogSimScene.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const rig = createDogSkeleton();
assert(rig.boneCount >= 38 && rig.boneCount <= 48, `expected ~40 bones, got ${rig.boneCount}`);
assert(DOG_BONE_DEFS.length === rig.boneCount, 'bone def count mismatch');
assert(rig.bonesByName.has('Head'), 'missing Head');
assert(rig.bonesByName.has('Tail4'), 'missing Tail4');
for (const chain of Object.values(DOG_LEG_CHAINS)) {
  for (const name of chain.bones) {
    assert(rig.bonesByName.has(name), `missing leg bone ${name}`);
  }
}

// Feet: flat pads on the floor — not tippy stilts.
{
  const pawNames = ['PawL', 'PawR', 'HindPawL', 'HindPawR'];
  const pawYs = pawNames.map((name) => rig.worldBindPos.get(name).y);
  for (const y of pawYs) {
    assert(y >= 0.005 && y <= 0.06, `paw bone y=${y.toFixed(3)} not near ground`);
  }
  const spread = Math.max(...pawYs) - Math.min(...pawYs);
  assert(spread < 0.04, `paws badly uneven (spread=${spread.toFixed(3)})`);

  // Paw should sit mostly forward of pastern/hock (flat foot), not below it (pointe).
  for (const [pastern, paw] of [['PasternL', 'PawL'], ['HockL', 'HindPawL']]) {
    const p = rig.worldBindPos.get(pastern);
    const f = rig.worldBindPos.get(paw);
    const dz = f.z - p.z;
    const dy = f.y - p.y;
    assert(dz > 0.015, `${paw} not forward of ${pastern} (flat pad) dz=${dz.toFixed(3)}`);
    assert(dy > -0.04 && dy < 0.02, `${paw} tippy relative to ${pastern} dy=${dy.toFixed(3)}`);
  }

  // Mesh pad bottoms on the floor.
  const geoProbe = buildDogBodyGeometry(rig);
  const ppos = geoProbe.getAttribute('position');
  let globalMin = Infinity;
  for (let i = 0; i < ppos.count; i += 1) globalMin = Math.min(globalMin, ppos.getY(i));
  assert(globalMin >= -0.015 && globalMin <= 0.02, `mesh minY=${globalMin.toFixed(3)} not on floor`);
  geoProbe.dispose();

  // Hind digitigrade S (head = +Z): stifle cranial of hip, hock caudal of stifle.
  // Guards the "backwards knee" regression where the first bend went caudal.
  {
    const hip = rig.worldBindPos.get('HipL');
    const stifle = rig.worldBindPos.get('ThighL');
    const hock = rig.worldBindPos.get('ShinL');
    const stifleFwd = stifle.z - hip.z;
    const hockBack = stifle.z - hock.z;
    assert(stifleFwd > 0.08, `stifle not forward of hip (dZ=${stifleFwd.toFixed(3)})`);
    assert(hockBack > 0.10, `hock not behind stifle (dZ=${hockBack.toFixed(3)})`);
    assert(hock.y - rig.worldBindPos.get('HindPawL').y > 0.10, `cannon too short (hockY=${hock.y.toFixed(3)})`);
  }
}

const geo = buildDogBodyGeometry(rig);
const verts = geo.getAttribute('position').count;
assert(verts > 1500, `expected body mesh, got ${verts} verts`);
for (const attr of ['skinIndex', 'skinWeight', 'furLength', 'coatMask', 'groomDir', 'coatZone', 'restPosition']) {
  assert(geo.getAttribute(attr), `missing attribute ${attr}`);
}

// Bind-pose skinning identity
rig.skeleton.update();
const sia = geo.getAttribute('skinIndex').array;
const swa = geo.getAttribute('skinWeight').array;
const pa = geo.getAttribute('position').array;
let maxBindErr = 0;
for (let i = 0; i < verts; i += 1) {
  const px = pa[i * 3];
  const py = pa[i * 3 + 1];
  const pz = pa[i * 3 + 2];
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let j = 0; j < 4; j += 1) {
    const bi = sia[i * 4 + j];
    const w = swa[i * 4 + j];
    if (w === 0) continue;
    const m = new THREE.Matrix4().multiplyMatrices(
      rig.skeleton.bones[bi].matrixWorld,
      rig.skeleton.boneInverses[bi],
    );
    const v = new THREE.Vector3(px, py, pz).applyMatrix4(m);
    sx += v.x * w;
    sy += v.y * w;
    sz += v.z * w;
  }
  maxBindErr = Math.max(maxBindErr, Math.hypot(sx - px, sy - py, sz - pz));
}
assert(maxBindErr < 1e-4, `bind skin error ${maxBindErr}`);

/** Max skinned-vs-bind displacement in root-local space (ignores root motion). */
function maxRootLocalDisp() {
  anim.setRootPosition(0, 0, 0);
  anim.setRootYaw(0);
  // One more tick at current behavior to refresh matrices with zeroed root.
  anim.update(0, { fixed: true });
  // Force root zero after update (gait would re-advance).
  rig.root.position.set(0, 0, 0);
  rig.root.rotation.y = 0;
  rig.root.updateMatrixWorld(true);
  rig.skeleton.update();

  let maxDisp = 0;
  for (let i = 0; i < verts; i += 1) {
    const px = pa[i * 3];
    const py = pa[i * 3 + 1];
    const pz = pa[i * 3 + 2];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let j = 0; j < 4; j += 1) {
      const bi = sia[i * 4 + j];
      const w = swa[i * 4 + j];
      if (w === 0) continue;
      const m = new THREE.Matrix4().multiplyMatrices(
        rig.skeleton.bones[bi].matrixWorld,
        rig.skeleton.boneInverses[bi],
      );
      const v = new THREE.Vector3(px, py, pz).applyMatrix4(m);
      sx += v.x * w;
      sy += v.y * w;
      sz += v.z * w;
    }
    maxDisp = Math.max(maxDisp, Math.hypot(sx - px, sy - py, sz - pz));
  }
  return maxDisp;
}

const anim = createDogAnimation(rig);
anim.setAutopilot(false);
anim.setFrozenBlink(true);
anim.setFrozenBreeze(true);
anim.setBehavior('idle');
for (let i = 0; i < 90; i += 1) anim.update(1 / 60, { fixed: true });

let idleDisp = maxRootLocalDisp();
assert(idleDisp < 0.12, `idle pose tore mesh (max vertex disp ${idleDisp.toFixed(3)})`);

// Walk shouldn't explode either
anim.setBehavior('walk');
for (let i = 0; i < 90; i += 1) anim.update(1 / 60, { fixed: true });
assert(anim.getMoveSpeed() > 0.2, `walk speed too low: ${anim.getMoveSpeed()}`);

const walkDisp = maxRootLocalDisp();
assert(walkDisp < 0.35, `walk pose tore mesh (max vertex disp ${walkDisp.toFixed(3)})`);

// Joint angles stay sane (local rest + additives, not world IK)
for (const name of ['ForearmL', 'ShinL', 'UpperArmL']) {
  const b = rig.bonesByName.get(name);
  const rest = rig.restQuaternions.get(name);
  const delta = rest.clone().invert().multiply(b.quaternion);
  const e = new THREE.Euler().setFromQuaternion(delta, 'XYZ');
  const deg = Math.abs(e.x) * 180 / Math.PI;
  assert(deg < 90, `${name} local delta X exploded: ${deg.toFixed(1)}°`);
}

// Sit: rump down, front paws near ground — not inverted / floating
anim.setBehavior('sit');
for (let i = 0; i < 120; i += 1) anim.update(1 / 60, { fixed: true });
{
  const rootY = anim.getRootPosition().y;
  assert(rootY < -0.05, `sit should lower root (y=${rootY.toFixed(3)})`);
  for (const name of ['PawL', 'PawR']) {
    const y = new THREE.Vector3().setFromMatrixPosition(rig.bonesByName.get(name).matrixWorld).y;
    assert(y > -0.08 && y < 0.18, `sit front paw ${name} y=${y.toFixed(3)} not near ground`);
  }
  for (const name of ['HindPawL', 'HindPawR']) {
    const y = new THREE.Vector3().setFromMatrixPosition(rig.bonesByName.get(name).matrixWorld).y;
    assert(y > -0.08 && y < 0.28, `sit hind paw ${name} y=${y.toFixed(3)} not near ground`);
  }
  // Head should stay above pelvis (not belly-up)
  const headY = new THREE.Vector3().setFromMatrixPosition(rig.bonesByName.get('Head').matrixWorld).y;
  const pelvisY = new THREE.Vector3().setFromMatrixPosition(rig.bonesByName.get('Pelvis').matrixWorld).y;
  assert(headY > pelvisY - 0.05, `sit inverted? headY=${headY.toFixed(3)} pelvisY=${pelvisY.toFixed(3)}`);
}

// Walk stride: front paw should swing along +Z relative to root
anim.setBehavior('walk');
anim.setRootPosition(0, 0, 0);
anim.setRootYaw(0);
const pawZs = [];
for (let i = 0; i < 60; i += 1) {
  anim.update(1 / 60, { fixed: true });
  const root = new THREE.Vector3().setFromMatrixPosition(rig.bonesByName.get('Root').matrixWorld);
  const paw = new THREE.Vector3().setFromMatrixPosition(rig.bonesByName.get('PawL').matrixWorld);
  pawZs.push(paw.z - root.z);
}
const zRange = Math.max(...pawZs) - Math.min(...pawZs);
assert(zRange > 0.06, `walk stride too small on Z (range=${zRange.toFixed(3)})`);

// Catalog size is the current authored animal set (canids + non-canine extensions).
assert(DOG_BREEDS.length === 121, `expected 121 catalog breeds, got ${DOG_BREEDS.length}`);
assert(
  new Set(DOG_BREEDS.map((breed) => breed.id)).size === DOG_BREEDS.length,
  'catalog breed IDs must be unique',
);
assert(new Set(DOG_FAMILIES.map((family) => family.id)).size === DOG_FAMILIES.length, 'family IDs must be unique');
assert(AUTHORED_DOG_BREED_IDS.length === 120, `expected 120 authored breeds, got ${AUTHORED_DOG_BREED_IDS.length}`);

// Species: Carnivora 13 + Rodentia 15 + Perissodactyla 3 + Artiodactyla 10 = 41
assert(ANIMAL_ORDERS.length === 4, `expected 4 animal orders, got ${ANIMAL_ORDERS.length}`);
assert(ANIMAL_SPECIES.length === 41, `expected 41 taxonomic species, got ${ANIMAL_SPECIES.length}`);
assert(new Set(ANIMAL_SPECIES.map((s) => s.id)).size === 41, 'species IDs must be unique');
const carnivoraCount = ANIMAL_SPECIES.filter((s) => s.orderId === 'carnivora').length;
const rodentiaCount = ANIMAL_SPECIES.filter((s) => s.orderId === 'rodentia').length;
const perissoCount = ANIMAL_SPECIES.filter((s) => s.orderId === 'perissodactyla').length;
const artioCount = ANIMAL_SPECIES.filter((s) => s.orderId === 'artiodactyla').length;
assert(carnivoraCount === 13, `expected 13 carnivora species, got ${carnivoraCount}`);
assert(rodentiaCount === 15, `expected 15 rodentia species, got ${rodentiaCount}`);
assert(perissoCount === 3, `expected 3 perissodactyla species, got ${perissoCount}`);
assert(artioCount === 10, `expected 10 artiodactyla species, got ${artioCount}`);
assert(isSpeciesPopulated('canidae'), 'canidae should have authored breeds');
assert(isSpeciesPopulated('felidae'), 'felidae should have authored breeds');
assert(isSpeciesPopulated('procyonidae'), 'procyonidae should have authored breeds');
assert(isSpeciesPopulated('bovidae'), 'bovidae should have domestic-goat');
assert(isSpeciesPopulated('muridae'), 'muridae should have norway-rat / house-mouse');
assert(isSpeciesPopulated('sciuridae'), 'sciuridae should have grey-squirrel');
assert(isSpeciesPopulated('cricetidae'), 'cricetidae should have syrian-hamster');
assert(isSpeciesPopulated('ursidae'), 'ursidae should have brown-bear / polar-bear / giant-panda');
assert(getFamiliesForSpecies('canidae').some((f) => f.id === 'retriever-sporting'), 'canidae missing dog silhouette families');
assert(getFamiliesForSpecies('felidae').some((f) => f.id === 'feline'), 'felidae missing feline family');
assert(getFamiliesForSpecies('procyonidae').some((f) => f.id === 'raccoon'), 'procyonidae missing raccoon family');
assert(getFamiliesForSpecies('procyonidae').length === 4, 'procyonidae should have 4 silhouette families');
assert(getFamiliesForSpecies('procyonidae').some((f) => f.id === 'coati'), 'procyonidae missing coati family');
assert(getFamiliesForSpecies('procyonidae').some((f) => f.id === 'kinkajou'), 'procyonidae missing kinkajou family');
assert(getFamiliesForSpecies('procyonidae').some((f) => f.id === 'ringtail'), 'procyonidae missing ringtail family');
assert(getFamiliesForSpecies('ursidae').length === 3, 'ursidae should have 3 silhouette families');
assert(getFamiliesForSpecies('ursidae').some((f) => f.id === 'ursine'), 'ursidae missing ursine family');
assert(getFamiliesForSpecies('ursidae').some((f) => f.id === 'polar'), 'ursidae missing polar family');
assert(getFamiliesForSpecies('ursidae').some((f) => f.id === 'panda'), 'ursidae missing panda family');
assert(getFamiliesForSpecies('equidae').length === 1, 'equidae should have equid silhouette family');
assert(isSpeciesPopulated('equidae'), 'equidae should have domestic-horse');
assert(isSpeciesPopulated('rhinocerotidae'), 'rhinocerotidae should have white-rhinoceros');
assert(isSpeciesPopulated('tapiridae'), 'tapiridae should have brazilian-tapir');
assert(isSpeciesPopulated('heteromyidae'), 'heteromyidae should have kangaroo-rat');
assert(isSpeciesPopulated('giraffidae'), 'giraffidae should have reticulated-giraffe');
assert(isSpeciesPopulated('eupleridae'), 'eupleridae should have fossa');

const rankedBreeds = DOG_BREEDS.filter((breed) => Number.isInteger(breed.popularity.rank));
assert(
  rankedBreeds.length === 25
    && rankedBreeds.map((breed) => breed.popularity.rank).sort((a, b) => a - b).every((rank, i) => rank === i + 1),
  'AKC 2025 ranks must be exactly 1–25',
);
const familyIds = new Set(DOG_FAMILIES.map((family) => family.id));
const speciesIds = new Set(ANIMAL_SPECIES.map((species) => species.id));
for (const family of DOG_FAMILIES) {
  assert(speciesIds.has(family.speciesId), `${family.id} references missing species ${family.speciesId}`);
}
for (const breed of DOG_BREEDS) {
  assert(familyIds.has(breed.familyId), `${breed.id} references missing family ${breed.familyId}`);
  assert(breed.speciesId, `${breed.id} missing speciesId`);
  assert(speciesIds.has(breed.speciesId), `${breed.id} references missing species ${breed.speciesId}`);
  assert(getSpeciesIdForBreed(breed.id) === breed.speciesId, `${breed.id} speciesId lookup mismatch`);
  assert(breed.popularity.year === 2025, `${breed.id} popularity year mismatch`);
  assert(Object.isFrozen(breed), `${breed.id} catalog entry should be immutable`);
  assert(
    JSON.stringify(Object.keys(breed.generatorLineage)) === JSON.stringify(DOG_LINEAGE_KEYS),
    `${breed.id} lineage schema mismatch`,
  );
  const total = Object.values(breed.generatorLineage).reduce((sum, value) => sum + value, 0);
  assert(Math.abs(total - 1) < 1e-9, `${breed.id} lineage weights sum to ${total}`);
  // Variant plumbing: every breed resolves to a uniform Breed → Variant path,
  // even breeds with no authored subtype (synthetic single 'default' entry).
  assert(Array.isArray(breed.variants) && breed.variants.length >= 1, `${breed.id} missing variants list`);
  assert(Object.isFrozen(breed.variants), `${breed.id} variants list should be immutable`);
  assert(
    breed.variants.some((variant) => variant.id === breed.defaultVariantId),
    `${breed.id} defaultVariantId '${breed.defaultVariantId}' is not in its own variants list`,
  );
  assert(
    new Set(breed.variants.map((variant) => variant.id)).size === breed.variants.length,
    `${breed.id} has duplicate variant ids`,
  );
}
assert(
  Object.keys(DOG_PHENOTYPE_PROFILES).length === 120,
  `expected 120 phenotype profiles, got ${Object.keys(DOG_PHENOTYPE_PROFILES).length}`,
);
for (const id of AUTHORED_DOG_BREED_IDS) {
  assert(DOG_PHENOTYPE_PROFILES[id], `missing authored phenotype ${id}`);
}

// Resolution is deterministic, bounded, and refuses catalog-only approximations.
for (const id of AUTHORED_DOG_BREED_IDS) {
  const a = resolveDogPhenotype({ breedId: id, seed: 0xf00dcafe });
  const b = resolveDogPhenotype({ breedId: id, seed: 0xf00dcafe });
  const c = resolveDogPhenotype({ breedId: id, seed: 0xf00dcaff });
  assert(JSON.stringify(a) === JSON.stringify(b), `${id} seed resolution is not deterministic`);
  assert(JSON.stringify(a) !== JSON.stringify(c), `${id} distinct seeds should vary resolved values`);
  const base = DOG_PHENOTYPE_PROFILES[id];
  assert(a.ears.type === base.ears.type, `${id} seed changed defining ear type`);
  assert(a.tail.type === base.tail.type, `${id} seed changed defining tail type`);
  assert(a.coat.pattern === base.coat.pattern, `${id} seed changed defining coat pattern`);
  assert(Math.abs(a.skeleton.scale / base.skeleton.scale - 1) <= base.variation.scale + 1e-9, `${id} size escaped variation limit`);
  assert(Math.abs(a.coat.length / base.coat.length - 1) <= base.variation.coatLength + 1e-9, `${id} coat escaped variation limit`);
}
// Catalog-only stubs fall back to the first authored breed in-family (not always Golden).
assert(normalizeRenderableDogBreedId('havanese') === 'cavalier-king-charles-spaniel', 'canid catalog-only should use toy-companion authored base');
assert(normalizeRenderableDogBreedId('siamese') === 'siamese', 'authored feline should render as itself');
assert(normalizeRenderableDogBreedId('unknown-dog') === 'golden-retriever', 'unknown breed did not fall back to Golden');
assert(resolveDogPhenotype({ breedId: 'golden-retriever', seed: 1 }).skeleton.scale === 1, 'Golden seed 1 default drifted');
// Every cat-ref board is authored: own profile, feline family, cat patterns.
{
  const coon = resolveDogPhenotype({ breedId: 'maine-coon', seed: 1 });
  assert(coon.breedId === 'maine-coon', 'authored feline should keep catalog breedId');
  assert(coon.familyId === 'feline', 'authored feline should stay in feline family');
  assert(coon.coat.pattern === 'cat-tabby', 'maine-coon should use the cat-tabby pattern');
  assert(coon.ears.type === 'erect', 'maine-coon should keep erect feline ears');
  const felineCount = DOG_BREEDS.filter((b) => b.familyId === 'feline').length;
  assert(felineCount === 43, `expected 43 feline breeds, got ${felineCount}`);
  const felineAuthored = AUTHORED_DOG_BREED_IDS.filter((id) => DOG_BREEDS.find((b) => b.id === id)?.familyId === 'feline');
  assert(felineAuthored.length === 43, `expected 43 authored feline breeds, got ${felineAuthored.length}`);
}

function sampledSkinDisplacement(dog) {
  const dogGeo = dog.geometry;
  const positions = dogGeo.getAttribute('position').array;
  const skinIndices = dogGeo.getAttribute('skinIndex').array;
  const skinWeights = dogGeo.getAttribute('skinWeight').array;
  dog.rig.root.position.set(0, 0, 0);
  dog.rig.root.rotation.set(0, 0, 0);
  dog.rig.root.updateMatrixWorld(true);
  dog.rig.skeleton.update();
  let max = 0;
  for (let i = 0; i < dog.vertexCount; i += 4) {
    const source = new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    const skinned = new THREE.Vector3();
    for (let j = 0; j < 4; j += 1) {
      const weight = skinWeights[i * 4 + j];
      if (!weight) continue;
      const boneIndex = skinIndices[i * 4 + j];
      const matrix = new THREE.Matrix4().multiplyMatrices(
        dog.rig.skeleton.bones[boneIndex].matrixWorld,
        dog.rig.skeleton.boneInverses[boneIndex],
      );
      skinned.addScaledVector(source.clone().applyMatrix4(matrix), weight);
    }
    max = Math.max(max, source.distanceTo(skinned));
  }
  return max;
}

// Every authored breed uses and disposes the same geometry/rig/animation path.
const authoredStats = [];
for (const breedId of AUTHORED_DOG_BREED_IDS) {
  const dog = createProceduralDog({ breedId, seed: 1, shellCount: 4 });
  assert(dog.breedId === breedId, `${breedId} factory resolved as ${dog.breedId}`);
  assert(dog.boneCount === 41, `${breedId} broke the 41-bone contract`);
  assert(
    dog.bodyMesh.material.depthTest && dog.bodyMesh.material.depthWrite && !dog.bodyMesh.material.transparent,
    `${breedId} body core must remain an opaque depth occluder`,
  );
  for (const eye of dog.face.eyes) {
    eye.root.traverse((object) => {
      if (!object.isMesh) return;
      assert(object.material.depthTest, `${breedId} eye feature bypasses depth occlusion`);
      assert(object.material.side === THREE.FrontSide, `${breedId} eye feature renders through its back face`);
    });
  }
  const noseFeature = dog.rig.root.getObjectByName('Nose');
  assert(noseFeature, `${breedId} missing nose feature`);
  noseFeature.traverse((object) => {
    if (!object.isMesh) return;
    assert(object.material.depthTest, `${breedId} nose feature bypasses depth occlusion`);
    assert(object.material.side === THREE.FrontSide, `${breedId} nose feature renders through its back face`);
  });
  if (dog.phenotype.skeleton.muzzleLength < 0.5) {
    const muzzleBone = dog.rig.bonesByName.get('Muzzle');
    const noseBone = dog.rig.bonesByName.get('NoseTip');
    const jawBone = dog.rig.bonesByName.get('Jaw');
    const muzzleReach = muzzleBone.position.z + noseBone.position.z;
    assert(
      muzzleReach >= dog.phenotype.skeleton.headSize * 0.074,
      `${breedId} brachy nose is buried in the skull (reach=${muzzleReach.toFixed(3)})`,
    );
    // Teeth/gum are jaw-local; convert to head-local and require them behind the nose pad.
    const jawInterior = jawBone?.getObjectByName('DogJawInterior');
    if (jawInterior && jawBone) {
      let maxToothHeadZ = -Infinity;
      jawInterior.traverse((object) => {
        if (!object.isMesh || object.geometry?.type !== 'ConeGeometry') return;
        maxToothHeadZ = Math.max(maxToothHeadZ, jawBone.position.z + object.position.z);
      });
      if (Number.isFinite(maxToothHeadZ)) {
        assert(
          maxToothHeadZ <= muzzleReach - dog.phenotype.skeleton.headSize * 0.004,
          `${breedId} brachy teeth protrude past the nose `
          + `(toothZ=${maxToothHeadZ.toFixed(3)}, noseZ=${muzzleReach.toFixed(3)})`,
        );
        // Still far enough forward to clear the jaw loft / show when panting.
        assert(
          maxToothHeadZ >= jawBone.position.z + dog.phenotype.skeleton.headSize * 0.03,
          `${breedId} brachy teeth buried too deep in the jaw `
          + `(toothZ=${maxToothHeadZ.toFixed(3)}, jawZ=${jawBone.position.z.toFixed(3)})`,
        );
      }
    }
  }
  for (const attr of ['position', 'normal', 'skinIndex', 'skinWeight', 'furLength', 'coatMask', 'groomDir', 'coatZone', 'restPosition']) {
    assert(dog.geometry.getAttribute(attr), `${breedId} missing geometry attribute ${attr}`);
  }
  const packedCoat = dog.geometry.getAttribute('coatMask');
  let innerEarVertices = 0;
  for (let i = 0; i < packedCoat.count; i += 1) {
    const packed = packedCoat.getX(i);
    const coatPayload = packed - Math.floor(packed / 4) * 4;
    if (coatPayload > 1.5) innerEarVertices += 1;
  }
  assert(innerEarVertices >= 16, `${breedId} is missing inner-pinna surface vertices`);
  const earBase = dog.rig.worldBindPos.get('EarL0');
  const earMid = dog.rig.worldBindPos.get('EarL1');
  const earTip = dog.rig.worldBindPos.get('EarL2');
  const earPathLength = earBase.distanceTo(earMid) + earMid.distanceTo(earTip);
  const minimumEarPath = dog.phenotype.ears.type === 'rounded'
    ? 0.012
    : dog.phenotype.ears.fold === 'rose' ? 0.025 : 0.035;
  assert(earPathLength > minimumEarPath, `${breedId} ear centerline collapsed`);
  if (dog.phenotype.ears.type === 'folded') {
    const expectedLateralHinge = 0.055
      * dog.phenotype.skeleton.headSize
      * dog.phenotype.geometry.skullWidth;
    assert(
      Math.abs(earBase.x) > expectedLateralHinge,
      `${breedId} folded-ear hinge is buried inside the skull`,
    );
  }
  if (dog.phenotype.ears.type === 'erect' || dog.phenotype.ears.type === 'bat' || dog.phenotype.ears.type === 'rounded') {
    assert(earTip.y > earBase.y, `${breedId} upright ear does not rise above its root`);
  } else if (dog.phenotype.ears.type === 'floppy') {
    assert(earTip.y < earBase.y, `${breedId} floppy ear does not hang below its root`);
  } else if (dog.phenotype.ears.fold === 'semi-prick') {
    assert(earMid.y > earBase.y, `${breedId} semi-prick ear lost its upright lower hinge`);
    assert(earTip.y < earMid.y, `${breedId} semi-prick ear lost its upper fold`);
  } else {
    assert(earTip.y < earBase.y, `${breedId} folded ear does not drop beside its cheek`);
  }
  dog.geometry.computeBoundingBox();
  const bounds = dog.geometry.boundingBox;
  assert(
    [...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite),
    `${breedId} has non-finite bounds`,
  );
  const size = bounds.getSize(new THREE.Vector3());
  const diagonal = size.length();
  assert(diagonal > 0.2, `${breedId} geometry collapsed`);
  {
    const bindYs = ['PawL', 'PawR', 'HindPawL', 'HindPawR'].map(
      (pawName) => dog.rig.worldBindPos.get(pawName).y,
    );
    for (let i = 0; i < bindYs.length; i += 1) {
      const y = bindYs[i];
      // Ceiling 0.06 catches jumper front-float false greens that still passed 0.08.
      assert(y >= 0 && y < 0.06, `${breedId} ${['PawL', 'PawR', 'HindPawL', 'HindPawR'][i]} bind y=${y.toFixed(3)} not ground-planted`);
    }
    const bindSpread = Math.max(...bindYs) - Math.min(...bindYs);
    assert(
      bindSpread < 0.04,
      `${breedId} bind paw spread ${bindSpread.toFixed(3)} (front/hind not coplanar)`,
    );
  }
  const initialDisp = sampledSkinDisplacement(dog);
  assert(initialDisp < 1e-4, `${breedId} bind-pose identity error ${initialDisp}`);
  dog.animation.setAutopilot(false);
  dog.animation.setFrozenBlink(true);
  dog.animation.setFrozenBreeze(true);
  for (const behaviorName of ['idle', 'walk', 'trot', 'sit']) {
    dog.animation.setBehavior(behaviorName);
    for (let i = 0; i < 45; i += 1) dog.animation.update(1 / 60, { fixed: true });
    const deformation = sampledSkinDisplacement(dog);
    assert(
      deformation < diagonal * 0.9,
      `${breedId} ${behaviorName} deformation ${deformation.toFixed(3)} exceeds scale-relative limit`,
    );
  }
  authoredStats.push(`${breedId}:${dog.vertexCount}`);
  dog.dispose();
}

// Defining authored traits guard against profiles collapsing toward one generic dog.
const dachshund = resolveDogPhenotype({ breedId: 'dachshund', seed: 1 });
assert(dachshund.skeleton.bodyLength / dachshund.skeleton.legLength > 2.4, 'Dachshund is not long/low');
const frenchie = resolveDogPhenotype({ breedId: 'french-bulldog', seed: 1 });
assert(frenchie.skeleton.muzzleLength < 0.5 && frenchie.ears.type === 'bat', 'French Bulldog lacks short muzzle/bat ears');
const pom = resolveDogPhenotype({ breedId: 'pomeranian', seed: 1 });
assert(pom.tail.type === 'curled' && pom.coat.tail > 1.5 && pom.coat.length > 1.2, 'Pomeranian lacks plume/coat');
assert(resolveDogPhenotype({ breedId: 'chihuahua', seed: 1 }).skeleton.scale < 0.5, 'Chihuahua is not toy scale');
assert(resolveDogPhenotype({ breedId: 'german-shepherd-dog', seed: 1 }).ears.type === 'erect', 'German Shepherd ears are not erect');
assert(resolveDogPhenotype({ breedId: 'rottweiler', seed: 1 }).coat.pattern === 'black-tan', 'Rottweiler markings missing');
const schnauzer = resolveDogPhenotype({ breedId: 'miniature-schnauzer', seed: 1 });
assert(schnauzer.furnishings.brows > 0.5 && schnauzer.furnishings.beard > 0.5, 'Schnauzer furnishings missing');
const labrador = resolveDogPhenotype({ breedId: 'labrador-retriever', seed: 1 });
assert(labrador.coat.length < 0.35 && labrador.tail.thickness > 1.2, 'Labrador lacks short coat/otter tail');
const poodle = resolveDogPhenotype({ breedId: 'poodle', seed: 1 });
assert(poodle.coat.grooming === 'curly' && poodle.furnishings.topknot > 0.8 && poodle.skeleton.legLength > 1.1, 'Poodle lacks curly furnishings/leg proportions');
const beagle = resolveDogPhenotype({ breedId: 'beagle', seed: 1 });
assert(beagle.coat.pattern === 'hound-saddle' && beagle.ears.type === 'floppy' && beagle.ears.length > 1.1, 'Beagle lacks hound markings/ears');
const pointer = resolveDogPhenotype({ breedId: 'german-shorthaired-pointer', seed: 1 });
assert(pointer.coat.pattern === 'liver-roan' && pointer.skeleton.legLength > 1.1 && pointer.skeleton.muzzleLength > 1.2, 'GSP lacks lean pointer/ticked traits');
const bulldog = resolveDogPhenotype({ breedId: 'bulldog', seed: 1 });
assert(bulldog.skeleton.muzzleLength < 0.35 && bulldog.skeleton.chestWidth > 1.2, 'Bulldog lacks short muzzle/heavy front');
assert(resolveDogPhenotype({ breedId: 'cane-corso', seed: 1 }).skeleton.scale > 1.1, 'Cane Corso lacks guardian scale');
const cavalier = resolveDogPhenotype({ breedId: 'cavalier-king-charles-spaniel', seed: 1 });
assert(cavalier.ears.length > 1.3 && cavalier.coat.grooming === 'silky' && cavalier.coat.tail > 1.2, 'Cavalier lacks silky ears/plume');
const yorkie = resolveDogPhenotype({ breedId: 'yorkshire-terrier', seed: 1 });
assert(yorkie.skeleton.scale < 0.5 && yorkie.ears.type === 'erect' && yorkie.furnishings.topknot > 0.5, 'Yorkshire Terrier lacks toy/erect/topknot traits');
const aussie = resolveDogPhenotype({ breedId: 'australian-shepherd', seed: 1 });
assert(aussie.coat.pattern === 'blue-merle' && aussie.furnishings.ruff > 0.5 && aussie.skeleton.tailLength < 0.4, 'Australian Shepherd lacks merle/ruff/bobtail traits');
const doberman = resolveDogPhenotype({ breedId: 'doberman-pinscher', seed: 1 });
assert(doberman.coat.pattern === 'black-tan' && doberman.skeleton.legLength > 1.1 && doberman.skeleton.muzzleLength > 1.2, 'Doberman lacks lean black-and-tan traits');
const corgi = resolveDogPhenotype({ breedId: 'pembroke-welsh-corgi', seed: 1 });
assert(corgi.skeleton.bodyLength / corgi.skeleton.legLength > 2.4 && corgi.ears.type === 'erect', 'Pembroke Welsh Corgi is not long/low with erect ears');
const boxer = resolveDogPhenotype({ breedId: 'boxer', seed: 1 });
assert(
  boxer.skeleton.muzzleLength < 0.5
    && boxer.skeleton.legLength > 1.1
    && boxer.skeleton.hipWidth < boxer.skeleton.chestWidth
    && boxer.coat.pattern === 'fawn-mask'
    && boxer.ears.type === 'folded',
  'Boxer lacks athletic short-muzzle fawn-mask conformation',
);
const bernese = resolveDogPhenotype({ breedId: 'bernese-mountain-dog', seed: 1 });
assert(bernese.skeleton.scale > 1.15 && bernese.coat.length > 1.1 && bernese.tail.type === 'plume', 'Bernese lacks giant long-coat/plume traits');
const shihTzu = resolveDogPhenotype({ breedId: 'shih-tzu', seed: 1 });
assert(shihTzu.skeleton.scale < 0.5 && shihTzu.skeleton.muzzleLength < 0.4 && shihTzu.furnishings.topknot > 0.7, 'Shih Tzu lacks toy/short-muzzle/topknot traits');
const greatDane = resolveDogPhenotype({ breedId: 'great-dane', seed: 1 });
assert(greatDane.skeleton.scale > 1.3 && greatDane.skeleton.legLength > 1.3, 'Great Dane lacks giant tall proportions');
const boston = resolveDogPhenotype({ breedId: 'boston-terrier', seed: 1 });
assert(boston.ears.type === 'bat' && boston.skeleton.muzzleLength < 0.4 && boston.coat.pattern === 'tuxedo', 'Boston Terrier lacks bat ears/short muzzle/tuxedo');
const husky = resolveDogPhenotype({ breedId: 'siberian-husky', seed: 1 });
assert(
  husky.familyId === 'spitz'
    && husky.ears.type === 'erect'
    && husky.tail.type === 'sickle'
    && husky.coat.pattern === 'husky-mask'
    && husky.face.irisColor === 0x76bde5,
  'Siberian Husky lacks Spitz silhouette/mask/blue eyes',
);

// --- Raccoon (first non-canine family) -------------------------------------
{
  const raccoonBreed = DOG_BREEDS.find((breed) => breed.id === 'raccoon');
  assert(raccoonBreed, 'raccoon breed missing from catalog');
  assert(raccoonBreed.familyId === 'raccoon', 'raccoon breed should be in its own family');
  assert(raccoonBreed.speciesId === 'procyonidae', 'raccoon should nest under Procyonidae');
  assert(DOG_FAMILIES.some((family) => family.id === 'raccoon'), 'raccoon family missing from DOG_FAMILIES');
  assert(raccoonBreed.popularity.rank === null, 'raccoon is not an AKC breed — rank must stay null');
  assert(raccoonBreed.akc.group === null, 'raccoon is not an AKC breed — group must stay null');

  const raccoon = resolveDogPhenotype({ breedId: 'raccoon', seed: 1 });
  assert(raccoon.skeleton.legLength < 0.85, 'raccoon should be low/short-legged');
  assert(raccoon.ears.type === 'rounded', 'raccoon should use blunt rounded pinnae');
  assert(raccoon.skeleton.muzzleLength >= 0.5, 'raccoon muzzle must stay above the brachycephalic-check threshold');
  assert(raccoon.coat.pattern === 'raccoon-mask', 'raccoon lacks its coat pattern');
  assert(raccoon.coat.tail > 1.0, 'raccoon tail should be extra bushy for the ring pattern to read');

  // The mask/ring pattern function must actually vary output (not a flat
  // color) — sample the tail along its local axis and the head across the
  // eye band, both using the real per-vertex zone/head-center contract.
  const headCenter = new THREE.Vector3(0, 0.62, 0.42);
  const tailSamples = Array.from({ length: 12 }, (_, i) => {
    const p = new THREE.Vector3(0, 0.3, -i * 0.03);
    return colorMaskAt(COAT_ZONE.tail, p, headCenter, raccoon);
  });
  assert(Math.max(...tailSamples) - Math.min(...tailSamples) > 0.5, 'raccoon tail should show alternating dark/light rings');
  const eyeBand = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.03, 0.626, 0.44), headCenter, raccoon);
  const forehead = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.01, 0.66, 0.44), headCenter, raccoon);
  assert(eyeBand > forehead + 0.3, 'raccoon bandit mask should be darker at eye level than on the forehead');
  const muzzleTip = colorMaskAt(COAT_ZONE.muzzle, new THREE.Vector3(0, 0.6, 0.5), headCenter, raccoon);
  assert(muzzleTip < 0.3, 'raccoon muzzle/chin should stay pale, not masked');
}

// --- Procyonidae expansions (coati / kinkajou / ringtail) ------------------
{
  const coatiBreed = DOG_BREEDS.find((b) => b.id === 'white-nosed-coati');
  const kinkBreed = DOG_BREEDS.find((b) => b.id === 'kinkajou');
  const ringBreed = DOG_BREEDS.find((b) => b.id === 'ringtail');
  assert(coatiBreed && kinkBreed && ringBreed, 'procyonidae expansion breeds missing');
  assert(coatiBreed.familyId === 'coati' && coatiBreed.speciesId === 'procyonidae');
  assert(kinkBreed.familyId === 'kinkajou' && kinkBreed.speciesId === 'procyonidae');
  assert(ringBreed.familyId === 'ringtail' && ringBreed.speciesId === 'procyonidae');
  for (const b of [coatiBreed, kinkBreed, ringBreed]) {
    assert(b.conformationFlags.includes('procyonid'), `${b.id} should flag procyonid`);
    assert(b.popularity.rank === null && b.akc.group === null, `${b.id} is not AKC`);
  }

  const coati = resolveDogPhenotype({ breedId: 'white-nosed-coati', seed: 1 });
  const kink = resolveDogPhenotype({ breedId: 'kinkajou', seed: 1 });
  const ring = resolveDogPhenotype({ breedId: 'ringtail', seed: 1 });
  assert(coati.coat.pattern === 'coati-snout', 'white-nosed-coati should use coati-snout');
  assert(kink.coat.pattern === 'solid', 'kinkajou should use solid golden coat');
  assert(ring.coat.pattern === 'ringed-tail', 'ringtail should use ringed-tail pattern');
  assert(coati.skeleton.muzzleLength > 1.15, 'coati should have a long snout');
  const raccoonPh = resolveDogPhenotype({ breedId: 'raccoon', seed: 1 });
  assert(coati.skeleton.muzzleLength > raccoonPh.skeleton.muzzleLength,
    'coati muzzle should be longer than raccoon');
  assert(kink.skeleton.muzzleLength < 0.85, 'kinkajou muzzle should stay short/round');
  assert(kink.tail.thickness > 1.25, 'kinkajou tail should be thick (prehensile read)');
  assert(ring.skeleton.tailLength > 1.2, 'ringtail should have a very long tail');
  assert(ring.skeleton.tailLength > coati.skeleton.tailLength,
    'ringtail tail should be longer than coati');
  assert(nearestCoatPattern('white-nosed-coati').pattern === 'coati-snout');
  assert(nearestCoatPattern('ringtail').pattern === 'ringed-tail');

  const pHead = new THREE.Vector3(0, 0.62, 0.42);
  const coatiSnout = colorMaskAt(COAT_ZONE.muzzle, new THREE.Vector3(0, 0.6, 0.5), pHead, coati);
  const coatiBody = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.42, 0), pHead, coati);
  assert(coatiSnout < 0.2 && coatiBody > coatiSnout + 0.2,
    'coati snout should be pale vs brown body');
  const ringTailSamples = [0.0, 0.1, 0.2, 0.3].map((z) => (
    colorMaskAt(COAT_ZONE.tail, new THREE.Vector3(0, 0.5, -z), pHead, ring)
  ));
  assert(Math.max(...ringTailSamples) - Math.min(...ringTailSamples) > 0.5,
    'ringtail tail should show dark/light rings');

  for (const breedId of ['white-nosed-coati', 'kinkajou', 'ringtail']) {
    const dog = createProceduralDog({ breedId, seed: 1, shellCount: 0 });
    assert(dog.geometry?.getAttribute('position')?.count > 1000, `${breedId} mesh too small`);
    dog.dispose?.();
  }
}

// --- Grey squirrel (Sciuridae — rodent-ref board) --------------------------
{
  const squirrelBreed = DOG_BREEDS.find((breed) => breed.id === 'grey-squirrel');
  assert(squirrelBreed, 'grey-squirrel breed missing from catalog');
  assert(squirrelBreed.familyId === 'squirrel', 'grey-squirrel should be in squirrel silhouette family');
  assert(squirrelBreed.speciesId === 'sciuridae', 'grey-squirrel should nest under Sciuridae');
  assert(squirrelBreed.conformationFlags.includes('bushy-tail'), 'grey-squirrel catalog flag should mark bushy-tail');
  assert(squirrelBreed.conformationFlags.includes('rat-clips'), 'grey-squirrel should use rodent clip pack');

  const squirrel = resolveDogPhenotype({ breedId: 'grey-squirrel', seed: 1 });
  assert(squirrel.coat.pattern === 'squirrel-grey', 'grey-squirrel lacks squirrel-grey coat pattern');
  assert(squirrel.tail.type === 'sciurid', 'grey-squirrel should use sciurid rising-plume rest pose');
  // Thin solid core — bush comes from coat.tail shells, not a potato loft tube.
  assert(squirrel.tail.thickness < 1.35 && squirrel.tail.thickness > 0.9,
    'grey-squirrel plume solid core should stay modest (shell fluff carries bush)');
  assert(squirrel.coat.tail > 1.4, 'grey-squirrel tail coat should be very long for plume read');
  assert(squirrel.skeleton.tailLength > 1.2, 'grey-squirrel tail bone chain should be elongated');
  assert(squirrel.skeleton.scale <= 0.42 && squirrel.skeleton.scale >= 0.28,
    'grey-squirrel scale should sit in the rodent plan band 0.28–0.42');
  assert(squirrel.skeleton.legLength < 0.8, 'grey-squirrel legs should be shortened vs dog defaults');
  assert((squirrel.skeleton.frontLegScale ?? 1) < 0.95,
    'grey-squirrel front legs should scale shorter than the hind column');
  assert(squirrel.skeleton.muzzleLength < 0.72 && squirrel.skeleton.muzzleLength >= 0.5,
    'grey-squirrel muzzle should be short but above brachycephalic threshold');
  assert(squirrel.face.eyeScale > 1.2, 'grey-squirrel eyes should read large (ref head-close)');
  assert((squirrel.face.lidOpacity ?? 1) < 0.5,
    'grey-squirrel lids should be dialed down so periocular pale is coat-driven');
  assert(squirrel.face.hideTeeth === true, 'grey-squirrel should hide exterior tooth cones for closed snouts');
  assert(squirrel.ears.type === 'erect' && squirrel.ears.length < 0.7,
    'grey-squirrel ears should be modest erect pinnae');
  assert(squirrel.geometry.hindLegThickness > squirrel.geometry.legThickness * 1.3,
    'grey-squirrel haunches should be substantially thicker than front column');

  // Cool silver palette (guards warm washed beige that still passes crude hex checks).
  const { undercoat, guard, root, tip } = squirrel.coat.palette;
  assert(guard < 0x303030, 'grey-squirrel guard should be near-charcoal');
  assert(undercoat > 0xd8d8d0, 'grey-squirrel undercoat should be near-white chalk');
  // root/tip are cool mid greys (shell multiply). Channel spread must stay tight
  // and green/blue must not lag red by a warm-brown margin.
  for (const [name, hex] of [['root', root], ['tip', tip]]) {
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    assert(Math.abs(r - g) < 18 && Math.abs(g - b) < 18 && Math.abs(r - b) < 18,
      `grey-squirrel ${name} should be cool-neutral, not warm brown (rgb ${r},${g},${b})`);
    assert(r >= 0x70 && r <= 0xd0, `grey-squirrel ${name} mid-grey multiply band`);
  }
  assert(squirrel.face.noseColor > 0x806050, 'grey-squirrel nose should be soft taupe, not black');

  // Bind-space sciurid plume: free tall column *behind* the rump.
  {
    const defs = createDogBoneDefs(squirrel);
    const bones = new Map();
    for (const def of defs) {
      const b = new THREE.Bone();
      b.name = def.name;
      b.position.fromArray(def.pos);
      if (def.rot) {
        b.rotation.set(
          THREE.MathUtils.degToRad(def.rot[0]),
          THREE.MathUtils.degToRad(def.rot[1] || 0),
          THREE.MathUtils.degToRad(def.rot[2] || 0),
        );
      }
      bones.set(def.name, b);
    }
    const root = new THREE.Group();
    for (const def of defs) {
      const b = bones.get(def.name);
      if (def.parent) bones.get(def.parent).add(b);
      else root.add(b);
    }
    root.updateMatrixWorld(true);
    const pelvis = new THREE.Vector3();
    bones.get('Pelvis').getWorldPosition(pelvis);
    const tailPts = DOG_TAIL_BONES.map((n) => {
      const p = new THREE.Vector3();
      bones.get(n).getWorldPosition(p);
      return p;
    });
    const tailY = tailPts.map((p) => p.y);
    const tailDz = tailPts.map((p) => p.z - pelvis.z);
    const rise = Math.max(...tailY) - tailY[0];
    assert(rise > 0.12, `sciurid plume must rise steeply above Tail0 (rise=${rise.toFixed(3)})`);
    assert(Math.max(...tailY) > pelvis.y + 0.15,
      'sciurid plume max Y should tower over the pelvis');
    assert(tailY[2] > tailY[0] && tailY[3] > tailY[0],
      'sciurid mid-chain must climb above Tail0');
    // Free column: tip stays caudal (or barely at pelvis Z) — not a backpack over the back.
    assert(Math.max(...tailDz) < 0.08,
      `sciurid tip must stay behind the rump (max dz=${Math.max(...tailDz).toFixed(3)}; backpack fails)`);
    assert(tailDz[0] < -0.02, 'sciurid Tail0 should sit behind the pelvis');
  }

  // Pattern must actually countershade (not solid flat mask like the old profile).
  const sqHead = new THREE.Vector3(0, 0.62, 0.42);
  const bellyMask = colorMaskAt(COAT_ZONE.belly, new THREE.Vector3(0, 0.25, 0.1), sqHead, squirrel);
  const dorsalMask = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.48, 0), sqHead, squirrel);
  const flankMask = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0.08, 0.36, 0), sqHead, squirrel);
  const muzzleMask = colorMaskAt(COAT_ZONE.muzzle, new THREE.Vector3(0, 0.6, 0.5), sqHead, squirrel);
  // Frontal chest/sternum body sample — must be chalk, not mid-grey.
  const chestMask = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.38, 0.26), sqHead, squirrel);
  assert(bellyMask < 0.15, 'grey-squirrel belly should be chalk-white (low colorMask)');
  assert(muzzleMask < 0.2, 'grey-squirrel muzzle/chin should stay pale into the white bib');
  assert(chestMask < 0.12, 'grey-squirrel frontal chest bib must be chalk (body-zone mask < 0.12)');
  assert(dorsalMask > 0.5, 'grey-squirrel dorsal coatMask must stay high so shell multiply reads charcoal grey');
  assert(dorsalMask > bellyMask + 0.35, 'grey-squirrel dorsal coat should be much darker than belly countershading');
  assert(flankMask > bellyMask + 0.25, 'grey-squirrel flanks should stay darker than the pale belly');
  // Periocular annulus sample (eyeDist≈0.72), NOT the eye-center lobe (eyeRing≈0).
  // Absolute pale floor + large margin — relative-only asserts pass without the lobe.
  const eyeRing = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.05, 0.634, 0.44), sqHead, squirrel);
  const midCheek = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.045, 0.61, 0.44), sqHead, squirrel);
  const crown = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.01, 0.66, 0.42), sqHead, squirrel);
  assert(eyeRing < 0.18, 'grey-squirrel periocular annulus must be absolutely pale (mask < 0.18)');
  assert(eyeRing < midCheek - 0.25, 'grey-squirrel periocular annulus must be much paler than mid-cheek');
  assert(eyeRing < crown - 0.12, 'grey-squirrel periocular annulus should be paler than crown');
  // Tail grizzle by loft alongT (0 base → 1 tip) — tip frost must lighten.
  const tailBase = colorMaskAt(COAT_ZONE.tail, new THREE.Vector3(0, 0.5, -0.2), sqHead, squirrel, { alongT: 0.1 });
  const tailMid = colorMaskAt(COAT_ZONE.tail, new THREE.Vector3(0, 0.55, -0.1), sqHead, squirrel, { alongT: 0.5 });
  const tailTip = colorMaskAt(COAT_ZONE.tail, new THREE.Vector3(0, 0.6, 0.0), sqHead, squirrel, { alongT: 0.95 });
  assert(tailMid > tailTip + 0.08, 'grey-squirrel plume tip should frost paler than mid (alongT)');
  assert(Math.abs(tailBase - tailTip) > 0.05 || tailMid - tailTip > 0.08,
    'grey-squirrel plume should show mid/tip variation along loft');

  // Baked geometry must carry the pattern (not a constant solid payload).
  const dog = createProceduralDog({ breedId: 'grey-squirrel', seed: 1, shellCount: 0 });
  const coatAttr = dog.geometry.getAttribute('coatMask');
  let bodyMin = 1;
  let bodyMax = 0;
  let bodySum = 0;
  let bodyN = 0;
  let bellySum = 0;
  let bellyN = 0;
  for (let i = 0; i < coatAttr.count; i += 1) {
    const { zone, colorMask: mask } = unpackCoatMask(coatAttr.getX(i));
    if (zone === COAT_ZONE.body) {
      bodyMin = Math.min(bodyMin, mask);
      bodyMax = Math.max(bodyMax, mask);
      bodySum += mask;
      bodyN += 1;
    } else if (zone === COAT_ZONE.belly) {
      bellySum += mask;
      bellyN += 1;
    }
  }
  assert(bodyN > 50 && bellyN > 10, 'grey-squirrel mesh missing body/belly coat zones');
  assert(bodyMax - bodyMin > 0.35, 'grey-squirrel body coatMask must vary (bib vs dorsal), not solid');
  // Mean can drop with a wide chalk bib; still require a non-pale average so a
  // solid-white wash fails (dorsal samples + max already guard charcoal).
  assert(bodySum / bodyN > 0.18, 'grey-squirrel mean body coatMask too pale — will wash beige under shell lighting');
  assert(bodyMax > 0.7, 'grey-squirrel body coatMask max must stay charcoal on dorsal');
  assert(bellySum / bellyN < 0.12, 'grey-squirrel mean belly coatMask should stay chalk-pale');

  // Tail mesh should be a free column, not a body-engulfing backpack potato.
  {
    const rest = dog.geometry.getAttribute('restPosition');
    let tMinX = 1e9;
    let tMaxX = -1e9;
    let tMinZ = 1e9;
    let tMaxZ = -1e9;
    let tMaxY = -1e9;
    let tN = 0;
    let bodyMaxZ = -1e9;
    for (let i = 0; i < coatAttr.count; i += 1) {
      const { zone } = unpackCoatMask(coatAttr.getX(i));
      const x = rest.getX(i);
      const y = rest.getY(i);
      const z = rest.getZ(i);
      if (zone === COAT_ZONE.tail) {
        tMinX = Math.min(tMinX, x);
        tMaxX = Math.max(tMaxX, x);
        tMinZ = Math.min(tMinZ, z);
        tMaxZ = Math.max(tMaxZ, z);
        tMaxY = Math.max(tMaxY, y);
        tN += 1;
      }
      if (zone === COAT_ZONE.body || zone === COAT_ZONE.belly) {
        bodyMaxZ = Math.max(bodyMaxZ, z);
      }
    }
    assert(tN > 40, 'grey-squirrel mesh missing tail coat zone');
    const tailWidth = tMaxX - tMinX;
    assert(tailWidth < 0.14, `sciurid plume solid core too wide (width=${tailWidth.toFixed(3)}; potato backpack)`);
    // Tip of free column should not reach as far forward as the chest.
    assert(tMaxZ < bodyMaxZ - 0.02,
      `sciurid plume maxZ should stay caudal of chest (tail ${tMaxZ.toFixed(3)} vs body ${bodyMaxZ.toFixed(3)})`);
    assert(tMaxY > 0.55, 'sciurid plume mesh should tower (maxY)');
  }
  dog.dispose?.();

  // Sciurid pattern aliases (chipmunk block below owns full fidelity checks).
  assert(nearestCoatPattern('grey-squirrel').pattern === 'squirrel-grey',
    'alias grey-squirrel should resolve to squirrel-grey');
  assert(nearestCoatPattern('eastern-grey').pattern === 'squirrel-grey',
    'alias eastern-grey should resolve to squirrel-grey');
  assert(nearestCoatPattern('agouti').pattern === 'cat-ticked',
    'generic agouti must not alias into sciurid countershading');
  assert(nearestCoatPattern('chipmunk').pattern === 'chipmunk-stripe',
    'alias chipmunk should resolve to chipmunk-stripe');
}

// --- Eastern chipmunk (Sciuridae — rodent-ref board) -----------------------
{
  const chipBreed = DOG_BREEDS.find((breed) => breed.id === 'eastern-chipmunk');
  assert(chipBreed, 'eastern-chipmunk breed missing from catalog');
  assert(chipBreed.familyId === 'squirrel', 'eastern-chipmunk should be in squirrel silhouette family');
  assert(chipBreed.speciesId === 'sciuridae', 'eastern-chipmunk should nest under Sciuridae');
  assert(chipBreed.conformationFlags.includes('striped'), 'eastern-chipmunk catalog flag should mark striped');
  assert(chipBreed.conformationFlags.includes('rat-clips'), 'eastern-chipmunk should use rodent clip pack');

  const chipmunk = resolveDogPhenotype({ breedId: 'eastern-chipmunk', seed: 1 });
  assert(chipmunk.coat.pattern === 'chipmunk-stripe', 'eastern-chipmunk should use chipmunk-stripe');
  assert(chipmunk.tail.type === 'plume', 'eastern-chipmunk should use a caudal plume (not sciurid tower)');
  assert(chipmunk.skeleton.scale <= 0.42 && chipmunk.skeleton.scale >= 0.28,
    'eastern-chipmunk scale should sit in the rodent plan band 0.28–0.42');
  assert(chipmunk.skeleton.legLength < 0.8, 'eastern-chipmunk legs should be shortened vs dog defaults');
  assert((chipmunk.skeleton.frontLegScale ?? 1) < 0.95,
    'eastern-chipmunk front legs should scale shorter than the hind column');
  assert(chipmunk.skeleton.muzzleLength < 0.72 && chipmunk.skeleton.muzzleLength >= 0.5,
    'eastern-chipmunk muzzle should be short but above brachycephalic threshold');
  assert(chipmunk.face.eyeScale > 1.2, 'eastern-chipmunk eyes should read large (ref head-close)');
  assert((chipmunk.face.lidOpacity ?? 1) < 0.5,
    'eastern-chipmunk lids should be dialed down so facial stripe is coat-driven');
  assert(chipmunk.face.hideTeeth === true, 'eastern-chipmunk should hide exterior tooth cones');
  assert(chipmunk.ears.type === 'erect' && chipmunk.ears.length < 0.6,
    'eastern-chipmunk ears should be small erect pinnae');
  assert(chipmunk.geometry.hindLegThickness > chipmunk.geometry.legThickness * 1.25,
    'eastern-chipmunk haunches should be thicker than front column');
  assert(chipmunk.coat.tail > 0.9, 'eastern-chipmunk tail coat should be long enough for bushy plume');
  assert(chipmunk.face.noseColor > 0xa07060, 'eastern-chipmunk nose should be soft pink-tan, not black');

  // Warm mid root/tip (shell multiplies) + cream under / black guard.
  // Near-white root washes the body beige; pure mid-brown muddies stripes —
  // assert a warm mid band that still keeps 5-stripe contrast under shells.
  const { undercoat: chipUC, guard: chipG, root: chipRoot, tip: chipTip } = chipmunk.coat.palette;
  assert(chipG < 0x282018, 'eastern-chipmunk guard should be near-black for stripe contrast');
  assert(chipUC > 0xe0d0c0, 'eastern-chipmunk undercoat should be near-chalk cream');
  for (const [name, hex] of [['root', chipRoot], ['tip', chipTip]]) {
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    assert(r > g && g > b - 10, `eastern-chipmunk ${name} should be warm russet (rgb ${r},${g},${b})`);
    assert(r >= 0x70 && r <= 0xf0, `eastern-chipmunk ${name} mid-warm band`);
  }

  const cmHead = new THREE.Vector3(0, 0.62, 0.42);
  const chipBelly = colorMaskAt(COAT_ZONE.belly, new THREE.Vector3(0, 0.25, 0.1), cmHead, chipmunk);
  // Dorsal sample at y≈0.40 (scaled body peaks ~0.45 — 0.48 is above the mesh).
  const chipDorsal = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.40, 0), cmHead, chipmunk);
  const chipMuzzle = colorMaskAt(COAT_ZONE.muzzle, new THREE.Vector3(0, 0.6, 0.5), cmHead, chipmunk);
  // Mid-dorsal dark stripe (|x|≈0) vs pale stripe (|x|≈0.035) vs outer dark
  // (|x|≈0.065). Sample y≈0.40 — within scaled body y range (~0.22–0.45).
  const stripeDark = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0.0, 0.40, 0.0), cmHead, chipmunk);
  const stripePale = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0.035, 0.40, 0.0), cmHead, chipmunk);
  const stripeOuter = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0.065, 0.40, 0.0), cmHead, chipmunk);
  assert(chipBelly < 0.15, 'eastern-chipmunk belly should be chalk-pale');
  assert(chipMuzzle < 0.2, 'eastern-chipmunk muzzle/chin should stay pale into the bib');
  // Frontal chest at lower y so bib (not dorsal wash) is tested.
  const chipChestLow = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.30, 0.22), cmHead, chipmunk);
  assert(chipChestLow < 0.16, 'eastern-chipmunk lower chest bib must be chalk');
  assert(chipDorsal > chipBelly + 0.25, 'eastern-chipmunk dorsal should countershade vs belly');
  assert(stripeDark > stripePale + 0.4,
    'eastern-chipmunk mid-dorsal stripe must be much darker than the pale stripe band');
  assert(stripeOuter > stripePale + 0.3,
    'eastern-chipmunk outer dark stripe must stay darker than the pale stripe band');
  // White facial stripe / periocular annulus (absolute pale floor).
  // Sample the eye annulus (eyeDist≈0.72), not the pupil center — same class
  // as the grey-squirrel periocular check (false-green otherwise).
  const faceStripe = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.05, 0.634, 0.44), cmHead, chipmunk);
  // Superciliary pale band slightly medial of the eye.
  const browStripe = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.035, 0.62, 0.44), cmHead, chipmunk);
  const midCheek = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.045, 0.605, 0.44), cmHead, chipmunk);
  const crown = colorMaskAt(COAT_ZONE.head, new THREE.Vector3(0.01, 0.66, 0.42), cmHead, chipmunk);
  assert(faceStripe < 0.18, 'eastern-chipmunk periocular annulus must be absolutely pale (mask < 0.18)');
  assert(browStripe < 0.22, 'eastern-chipmunk white facial stripe band must be pale');
  assert(faceStripe < midCheek - 0.15, 'eastern-chipmunk periocular must be paler than mid-cheek');
  assert(faceStripe < crown - 0.12, 'eastern-chipmunk periocular should be paler than crown');
  // Tail tip frost via alongT.
  const tMid = colorMaskAt(COAT_ZONE.tail, new THREE.Vector3(0, 0.5, -0.15), cmHead, chipmunk, { alongT: 0.5 });
  const tTip = colorMaskAt(COAT_ZONE.tail, new THREE.Vector3(0, 0.55, -0.05), cmHead, chipmunk, { alongT: 0.95 });
  assert(tMid > tTip + 0.06, 'eastern-chipmunk plume tip should frost paler than mid (alongT)');

  // Baked mesh: body mask varies (stripes + bib), belly chalk.
  const chipDog = createProceduralDog({ breedId: 'eastern-chipmunk', seed: 1, shellCount: 0 });
  const chipCoat = chipDog.geometry.getAttribute('coatMask');
  let bMin = 1;
  let bMax = 0;
  let bSum = 0;
  let bN = 0;
  let belSum = 0;
  let belN = 0;
  for (let i = 0; i < chipCoat.count; i += 1) {
    const { zone, colorMask: mask } = unpackCoatMask(chipCoat.getX(i));
    if (zone === COAT_ZONE.body) {
      bMin = Math.min(bMin, mask);
      bMax = Math.max(bMax, mask);
      bSum += mask;
      bN += 1;
    } else if (zone === COAT_ZONE.belly) {
      belSum += mask;
      belN += 1;
    }
  }
  assert(bN > 50 && belN > 10, 'eastern-chipmunk mesh missing body/belly coat zones');
  assert(bMax - bMin > 0.4, 'eastern-chipmunk body coatMask must vary (stripes + bib), not solid');
  assert(bMax > 0.75, 'eastern-chipmunk body max must reach near-black on dark stripes');
  assert(bMin < 0.15, 'eastern-chipmunk body min must reach chalk on pale stripe/bib');
  assert(belSum / belN < 0.14, 'eastern-chipmunk mean belly coatMask should stay chalk-pale');
  chipDog.dispose?.();
}

// --- Norway rat + house mouse (Muridae — rodent-ref boards) ----------------
{
  const ratBreed = DOG_BREEDS.find((breed) => breed.id === 'norway-rat');
  const mouseBreed = DOG_BREEDS.find((breed) => breed.id === 'house-mouse');
  assert(ratBreed && mouseBreed, 'norway-rat / house-mouse breeds missing from catalog');
  assert(ratBreed.familyId === 'mouse-rat' && mouseBreed.familyId === 'mouse-rat',
    'muridae breeds should use mouse-rat silhouette family');
  assert(ratBreed.speciesId === 'muridae' && mouseBreed.speciesId === 'muridae',
    'norway-rat / house-mouse should nest under Muridae');
  assert(ratBreed.conformationFlags.includes('rat-clips')
    && mouseBreed.conformationFlags.includes('rat-clips'),
    'muridae breeds should use rodent clip pack');

  assert(nearestCoatPattern('norway-rat').pattern === 'murine-agouti',
    'alias norway-rat should resolve to murine-agouti');
  assert(nearestCoatPattern('house-mouse').pattern === 'murine-agouti',
    'alias house-mouse should resolve to murine-agouti');
  assert(nearestCoatPattern('muridae').pattern === 'murine-agouti',
    'alias muridae should resolve to murine-agouti');

  const rat = resolveDogPhenotype({ breedId: 'norway-rat', seed: 1 });
  const mouse = resolveDogPhenotype({ breedId: 'house-mouse', seed: 1 });
  assert(rat.coat.pattern === 'murine-agouti', 'norway-rat should use murine-agouti');
  assert(mouse.coat.pattern === 'murine-agouti', 'house-mouse should use murine-agouti');
  assert(rat.extremities?.foot === 'rodent-paw' && mouse.extremities?.foot === 'rodent-paw',
    'muridae should use rodent-paw limb ends (skinny distal + plantigrade foot)');
  assert(rat.skeleton.legLength < 0.65 && mouse.skeleton.legLength < 0.6,
    'muridae legs should stay short stilts under the body');
  assert(mouse.geometry.pawSize < 0.55 && rat.geometry.pawSize < 0.6,
    'muridae pawSize should stay small for rodent-paw kit');
  assert(rat.tail.type === 'straight' && mouse.tail.type === 'straight',
    'muridae should use thin straight tails (not plumes)');
  assert(rat.tail.thickness < 0.45 && mouse.tail.thickness < 0.4,
    'muridae tails should stay thin/scaly (not bushy)');
  assert(rat.coat.tail <= 0.08 && mouse.coat.tail <= 0.08,
    'muridae tail coat length should be nearly bare');
  assert(rat.skeleton.scale > mouse.skeleton.scale,
    'norway-rat should be larger scale than house-mouse');
  assert(rat.skeleton.scale <= 0.42 && rat.skeleton.scale >= 0.28
    && mouse.skeleton.scale <= 0.42 && mouse.skeleton.scale >= 0.28,
    'muridae scale should sit in the rodent plan band 0.28–0.42');
  assert(mouse.ears.length > rat.ears.length,
    'house-mouse pinnae should read larger than norway-rat');
  assert(rat.face.hideTeeth && mouse.face.hideTeeth,
    'muridae should hide exterior tooth cones');
  assert((rat.face.lidOpacity ?? 1) < 0.5 && (mouse.face.lidOpacity ?? 1) < 0.5,
    'muridae lids should be dialed down');
  assert(rat.face.noseColor > 0xa07060 && mouse.face.noseColor > 0xa07060,
    'muridae noses should be soft pink, not black');
  assert(mouse.face.eyeScale > rat.face.eyeScale,
    'house-mouse eyes should read larger relative to the toy skull');

  // Cool grey-brown rat vs warm sandy mouse palettes.
  {
    const { undercoat: ru, guard: rg, root: rr, tip: rt } = rat.coat.palette;
    assert(rg < 0x404040, 'norway-rat guard should be dark cool brown-grey');
    assert(ru > 0xd8d0c8, 'norway-rat undercoat should be near-chalk for pale belly');
    for (const [name, hex] of [['root', rr], ['tip', rt]]) {
      const r = (hex >> 16) & 0xff;
      const g = (hex >> 8) & 0xff;
      const b = hex & 0xff;
      assert(Math.abs(r - g) < 24 && Math.abs(g - b) < 24,
        `norway-rat ${name} should be cool-neutral grey-brown (rgb ${r},${g},${b})`);
    }
  }
  {
    const { undercoat: mu, guard: mg, root: mr, tip: mt } = mouse.coat.palette;
    assert(mg < 0x504030, 'house-mouse guard should be warm dark brown');
    assert(mu > 0xe0d8d0, 'house-mouse undercoat should be near-chalk cream');
    for (const [name, hex] of [['root', mr], ['tip', mt]]) {
      const r = (hex >> 16) & 0xff;
      const g = (hex >> 8) & 0xff;
      const b = hex & 0xff;
      assert(r > g && g > b - 12,
        `house-mouse ${name} should be warm sandy (rgb ${r},${g},${b})`);
    }
  }

  const mHead = new THREE.Vector3(0, 0.62, 0.42);
  for (const [id, ph] of [['norway-rat', rat], ['house-mouse', mouse]]) {
    const belly = colorMaskAt(COAT_ZONE.belly, new THREE.Vector3(0, 0.25, 0.1), mHead, ph);
    const dorsal = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.40, 0), mHead, ph);
    const chest = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.30, 0.22), mHead, ph);
    const muzzle = colorMaskAt(COAT_ZONE.muzzle, new THREE.Vector3(0, 0.6, 0.5), mHead, ph);
    const paw = colorMaskAt(COAT_ZONE.paw, new THREE.Vector3(0.05, 0.05, 0.1), mHead, ph);
    assert(belly < 0.15, `${id} belly should be chalk-pale`);
    assert(muzzle < 0.2, `${id} muzzle/chin should stay pale into the bib`);
    assert(chest < 0.18, `${id} lower chest bib must be pale`);
    assert(dorsal > belly + 0.25, `${id} dorsal should countershade vs belly`);
    assert(paw < 0.25, `${id} paws should stay pale (pink extremity read)`);
    // Solid flat 0.35 would fail the dorsal/belly contrast.
    assert(dorsal > 0.4, `${id} dorsal coatMask must stay mid-high for grizzle`);
  }

  // Baked mesh contrast for both (solid flat would fail body range).
  for (const breedId of ['norway-rat', 'house-mouse']) {
    const dog = createProceduralDog({ breedId, seed: 1, shellCount: 0 });
    const coatAttr = dog.geometry.getAttribute('coatMask');
    let bodyMin = 1;
    let bodyMax = 0;
    let bodyN = 0;
    let bellySum = 0;
    let bellyN = 0;
    for (let i = 0; i < coatAttr.count; i += 1) {
      const { zone, colorMask: mask } = unpackCoatMask(coatAttr.getX(i));
      if (zone === COAT_ZONE.body) {
        bodyMin = Math.min(bodyMin, mask);
        bodyMax = Math.max(bodyMax, mask);
        bodyN += 1;
      } else if (zone === COAT_ZONE.belly) {
        bellySum += mask;
        bellyN += 1;
      }
    }
    assert(bodyN > 50 && bellyN > 10, `${breedId} mesh missing body/belly coat zones`);
    assert(bodyMax - bodyMin > 0.25, `${breedId} body coatMask must vary (bib vs dorsal), not solid`);
    assert(bodyMax > 0.55, `${breedId} body max must stay dark enough on dorsal`);
    assert(bellySum / bellyN < 0.14, `${breedId} mean belly coatMask should stay chalk-pale`);
    dog.dispose?.();
  }
}

// --- Syrian hamster (Cricetidae — rodent-ref head shape priority) ----------
{
  const hamBreed = DOG_BREEDS.find((breed) => breed.id === 'syrian-hamster');
  assert(hamBreed, 'syrian-hamster breed missing from catalog');
  assert(hamBreed.familyId === 'hamster-vole', 'syrian-hamster should use hamster-vole silhouette family');
  assert(hamBreed.speciesId === 'cricetidae', 'syrian-hamster should nest under Cricetidae');
  assert(hamBreed.conformationFlags.includes('rat-clips')
    || hamBreed.conformationFlags.includes('rodent'),
    'syrian-hamster should be a rodent clip breed');

  assert(nearestCoatPattern('syrian-hamster').pattern === 'hamster-golden',
    'alias syrian-hamster should resolve to hamster-golden');
  assert(nearestCoatPattern('hamster').pattern === 'hamster-golden',
    'alias hamster should resolve to hamster-golden');

  const ham = resolveDogPhenotype({ breedId: 'syrian-hamster', seed: 1 });
  assert(ham.coat.pattern === 'hamster-golden', 'syrian-hamster should use hamster-golden');
  // Brachycephalic round head (ref head-close / front-sit) — compact, not super-wide.
  assert(ham.skeleton.muzzleLength <= 0.45 && ham.skeleton.muzzleLength >= 0.28,
    'syrian-hamster muzzle must be brachycephalic (≤0.45)');
  assert(ham.skeleton.headSize >= 1.05 && ham.skeleton.headSize <= 1.22,
    'syrian-hamster head should be slightly large vs body (not oversized balloon)');
  assert(ham.geometry.skullWidth >= 1.1 && ham.geometry.skullWidth <= 1.32,
    'syrian-hamster skull width should stay compact-round (not mumps-wide)');
  assert(ham.geometry.skullLength <= 0.9, 'syrian-hamster skull should stay short in Z');
  assert(ham.geometry.cheekFullness >= 1.0 && ham.geometry.cheekFullness <= 1.25,
    'syrian-hamster cheeks soft fill — not extreme lateral balloons');
  assert(ham.geometry.muzzleWidth >= 0.95 && ham.geometry.muzzleWidth <= 1.15,
    'syrian-hamster muzzle should be blunt but not plate-wide');
  assert(ham.ears.type === 'rounded', 'syrian-hamster should use rounded pinnae (not erect triangles)');
  assert(ham.ears.length < 0.55, 'syrian-hamster ears should be small rounded cups');
  assert(ham.face.eyeScale > 1.2, 'syrian-hamster eyes should read large');
  assert(ham.face.hideTeeth === true, 'syrian-hamster should hide exterior tooth cones');
  assert((ham.face.lidOpacity ?? 1) < 0.4, 'syrian-hamster lids should be dialed down');
  assert(ham.skeleton.tailLength < 0.35, 'syrian-hamster tail should be a stub');
  assert(ham.skeleton.legLength < 0.65, 'syrian-hamster legs should be short/stocky');
  assert(ham.face.noseColor > 0xa07060, 'syrian-hamster nose should be soft pink');

  // Warm golden palette (not cool grey muridae, not washed pure yellow).
  {
    const { undercoat: hu, guard: hg, root: hr, tip: ht } = ham.coat.palette;
    assert(hu > 0xe8e0d0, 'syrian-hamster undercoat should be near-chalk cream');
    assert(hg > 0x804010 && hg < 0xe0a060, 'syrian-hamster guard should be warm golden orange');
    for (const [name, hex] of [['root', hr], ['tip', ht]]) {
      const r = (hex >> 16) & 0xff;
      const g = (hex >> 8) & 0xff;
      const b = hex & 0xff;
      assert(r > g && g > b, `syrian-hamster ${name} should be warm golden (rgb ${r},${g},${b})`);
    }
  }

  const hHead = new THREE.Vector3(0, 0.62, 0.42);
  const hBelly = colorMaskAt(COAT_ZONE.belly, new THREE.Vector3(0, 0.25, 0.1), hHead, ham);
  const hDorsal = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.40, 0), hHead, ham);
  const hChest = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.30, 0.22), hHead, ham);
  const hPaw = colorMaskAt(COAT_ZONE.paw, new THREE.Vector3(0.05, 0.05, 0.1), hHead, ham);
  assert(hBelly < 0.15, 'syrian-hamster belly should be chalk-pale');
  assert(hChest < 0.2, 'syrian-hamster chest bib should stay pale');
  assert(hDorsal > hBelly + 0.2, 'syrian-hamster dorsal should countershade vs belly');
  assert(hPaw < 0.2, 'syrian-hamster paws should stay pale (pink extremity read)');

  // Mesh head is wide vs deep (spherical brachy read).
  {
    const dog = createProceduralDog({ breedId: 'syrian-hamster', seed: 1, shellCount: 0 });
    const rest = dog.geometry.getAttribute('restPosition');
    const coatAttr = dog.geometry.getAttribute('coatMask');
    let hMinX = 1e9;
    let hMaxX = -1e9;
    let hMinZ = 1e9;
    let hMaxZ = -1e9;
    let headN = 0;
    let bodyMin = 1;
    let bodyMax = 0;
    let bodyN = 0;
    for (let i = 0; i < coatAttr.count; i += 1) {
      const { zone, colorMask: mask } = unpackCoatMask(coatAttr.getX(i));
      if (zone === COAT_ZONE.head || zone === COAT_ZONE.muzzle) {
        hMinX = Math.min(hMinX, rest.getX(i));
        hMaxX = Math.max(hMaxX, rest.getX(i));
        hMinZ = Math.min(hMinZ, rest.getZ(i));
        hMaxZ = Math.max(hMaxZ, rest.getZ(i));
        headN += 1;
      }
      if (zone === COAT_ZONE.body) {
        bodyMin = Math.min(bodyMin, mask);
        bodyMax = Math.max(bodyMax, mask);
        bodyN += 1;
      }
    }
    assert(headN > 80, 'syrian-hamster mesh missing head/muzzle coat zones');
    const headW = hMaxX - hMinX;
    const headD = hMaxZ - hMinZ;
    const ratio = headW / Math.max(headD, 1e-6);
    // Round face: slightly wider than deep, but not mumps (was ~2.4).
    assert(ratio > 1.05 && ratio < 1.85,
      `syrian-hamster head W/D should be compact-round (got ${ratio.toFixed(2)}; W=${headW.toFixed(3)} D=${headD.toFixed(3)})`);
    assert(bodyN > 50 && bodyMax - bodyMin > 0.2,
      'syrian-hamster body coatMask must vary (bib vs golden), not solid flat');
    dog.dispose?.();
  }
}

// --- Ursidae P0 (3 families × 1 breed) -------------------------------------
{
  const brown = DOG_BREEDS.find((b) => b.id === 'brown-bear');
  const polar = DOG_BREEDS.find((b) => b.id === 'polar-bear');
  const panda = DOG_BREEDS.find((b) => b.id === 'giant-panda');
  assert(brown && polar && panda, 'ursidae P0 breeds missing from catalog');
  assert(brown.familyId === 'ursine' && brown.speciesId === 'ursidae', 'brown-bear should nest under ursine/ursidae');
  assert(polar.familyId === 'polar' && polar.speciesId === 'ursidae', 'polar-bear should nest under polar/ursidae');
  assert(panda.familyId === 'panda' && panda.speciesId === 'ursidae', 'giant-panda should nest under panda/ursidae');
  for (const breed of [brown, polar, panda]) {
    assert(breed.conformationFlags.includes('ursid'), `${breed.id} should flag ursid`);
    assert(breed.conformationFlags.includes('plantigrade'), `${breed.id} should flag plantigrade`);
    assert(breed.conformationFlags.includes('short-tail'), `${breed.id} should flag short-tail`);
  }

  const brownPh = resolveDogPhenotype({ breedId: 'brown-bear', seed: 1 });
  const polarPh = resolveDogPhenotype({ breedId: 'polar-bear', seed: 1 });
  const pandaPh = resolveDogPhenotype({ breedId: 'giant-panda', seed: 1 });
  assert(brownPh.skeleton.scale > 1.0 && polarPh.skeleton.scale > brownPh.skeleton.scale * 0.95,
    'bears should be large-scale; polar at least as tall as brown');
  assert(brownPh.skeleton.tailLength < 0.35 && polarPh.skeleton.tailLength < 0.35 && pandaPh.skeleton.tailLength < 0.35,
    'ursids should have stub tails');
  assert(brownPh.ears.type === 'rounded' && polarPh.ears.type === 'rounded' && pandaPh.ears.type === 'rounded',
    'ursids should use rounded pinnae');
  assert(brownPh.coat.pattern === 'solid', 'brown-bear should use solid coat');
  assert(polarPh.coat.pattern === 'solid-white', 'polar-bear should use solid-white coat');
  assert(pandaPh.coat.pattern === 'panda-bicolor', 'giant-panda should use panda-bicolor');
  assert(nearestCoatPattern('giant-panda').pattern === 'panda-bicolor',
    'alias giant-panda should resolve to panda-bicolor');
  assert(pandaPh.skeleton.muzzleLength < brownPh.skeleton.muzzleLength,
    'giant-panda muzzle should be shorter than brown bear');
  assert(polarPh.skeleton.legLength > brownPh.skeleton.legLength,
    'polar-bear should have longer legs than brown bear');

  // Panda pattern contrast: ear black, belly white, body patches.
  const pHead = new THREE.Vector3(0, 0.62, 0.42);
  const earMask = colorMaskAt(COAT_ZONE.ear, new THREE.Vector3(0.06, 0.7, 0.4), pHead, pandaPh);
  const bellyMask = colorMaskAt(COAT_ZONE.belly, new THREE.Vector3(0, 0.25, 0.1), pHead, pandaPh);
  const bodyWhite = colorMaskAt(COAT_ZONE.body, new THREE.Vector3(0, 0.42, -0.05), pHead, pandaPh);
  assert(earMask > 0.85, 'panda ears should be black (high colorMask)');
  assert(bellyMask < 0.15, 'panda belly should stay chalk white');
  assert(bodyWhite < 0.25, 'panda mid-back should stay mostly white ground');

  // Mesh bake smoke for each ursid.
  for (const breedId of ['brown-bear', 'polar-bear', 'giant-panda']) {
    const dog = createProceduralDog({ breedId, seed: 1, shellCount: 0 });
    assert(dog.geometry?.getAttribute('position')?.count > 1000, `${breedId} mesh too small`);
    dog.dispose?.();
  }
}

// --- Breed variants (Family → Breed → Variant → Seed) ---------------------

// 1. Default identity: resolving with no variantId lands on the breed's
//    authored default (dachshund's is 'smooth', not the literal 'default').
{
  const smoothByOmission = resolveDogPhenotype({ breedId: 'dachshund', seed: 1 });
  assert(smoothByOmission.variantId === 'smooth', 'dachshund default variant should be smooth');
  const smoothExplicit = resolveDogPhenotype({ breedId: 'dachshund', seed: 1, variantId: 'smooth' });
  assert(JSON.stringify(smoothByOmission) === JSON.stringify(smoothExplicit), 'omitted variantId should equal explicit default');
  assert(resolveDogPhenotype({ breedId: 'golden-retriever', seed: 1 }).variantId === 'default', 'single-variant breed should resolve to default');
}

// 2. Unknown variant falls back to default, no throw.
{
  const bogus = resolveDogPhenotype({ breedId: 'dachshund', seed: 1, variantId: 'not-a-real-variant' });
  assert(bogus.variantId === 'smooth', 'unknown variant id should fall back to breed default');
  assert(normalizeDogVariantId('dachshund', 'not-a-real-variant') === 'smooth', 'normalizeDogVariantId should fall back, not throw');
  assert(normalizeDogVariantId('not-a-real-breed', 'anything') === 'default', 'unknown breed should fall back to default without throwing');
}

// 3. Dachshund coat trio: discrete coat difference, shared conformation.
{
  const smooth = resolveDogPhenotype({ breedId: 'dachshund', seed: 1, variantId: 'smooth' });
  const long = resolveDogPhenotype({ breedId: 'dachshund', seed: 1, variantId: 'longhaired' });
  const wire = resolveDogPhenotype({ breedId: 'dachshund', seed: 1, variantId: 'wirehaired' });
  assert(smooth.coat.length < long.coat.length, 'longhaired dachshund should have more coat.length than smooth');
  assert(wire.furnishings.beard > 0.5 && wire.coat.grooming === 'wire', 'wirehaired dachshund should have a beard and wire grooming');
  assert(long.coat.grooming === 'feathered', 'longhaired dachshund should have feathered grooming');
  const eps = 1e-9;
  for (const variant of [smooth, long, wire]) {
    assert(Math.abs(variant.skeleton.bodyLength - smooth.skeleton.bodyLength) < eps, `${variant.variantId} bodyLength drifted from smooth`);
    assert(Math.abs(variant.skeleton.legLength - smooth.skeleton.legLength) < eps, `${variant.variantId} legLength drifted from smooth`);
    assert(variant.ears.type === smooth.ears.type, `${variant.variantId} changed the defining ear type`);
    assert(variant.tail.type === smooth.tail.type, `${variant.variantId} changed the defining tail type`);
  }
}

// 4. Seed isolation: same seed + different variant → same noise direction
//    (deterministic per-seed sign), different coat fields.
{
  const seed = 0xdeadbeef;
  const smoothA = resolveDogPhenotype({ breedId: 'dachshund', seed, variantId: 'smooth' });
  const longA = resolveDogPhenotype({ breedId: 'dachshund', seed, variantId: 'longhaired' });
  const scaleRatioSmooth = smoothA.skeleton.scale / DOG_PHENOTYPE_PROFILES.dachshund.skeleton.scale - 1;
  const scaleRatioLong = longA.skeleton.scale / DOG_PHENOTYPE_PROFILES.dachshund.skeleton.scale - 1;
  assert(Math.sign(scaleRatioSmooth) === Math.sign(scaleRatioLong), 'same seed should push scale the same direction across variants');
  assert(smoothA.coat.length !== longA.coat.length, 'same seed + different variant should still differ in coat.length');
  assert(smoothA.seed === longA.seed, 'variant switch should not change the resolved seed');
}

// 5. Ref fallback chain: missing variant subfolder still resolves to the
//    breed-level legacy still (existing boards keep working, no file moves).
{
  assert(
    JSON.stringify(dogRefUrlChain('head-close.jpg', 'dachshund', 'smooth')) === JSON.stringify([
      '/assets/dog-ref/dachshund/head-close.jpg',
      '/assets/dog-ref/head-close.jpg',
    ]),
    'default-variant chain should use the breed-root path before the shared Golden fallback',
  );
  const longChain = dogRefUrlChain('head-close.jpg', 'dachshund', 'longhaired');
  assert(longChain.length === 3, 'named-variant chain should try variant, breed, then shared fallback paths');
  assert(longChain[0] === '/assets/dog-ref/dachshund/longhaired/head-close.jpg', 'variant candidate should come first');
  assert(longChain[1] === '/assets/dog-ref/dachshund/head-close.jpg', 'legacy breed-root path should be the fallback');
  assert(longChain[2] === '/assets/dog-ref/head-close.jpg', 'shared Golden still should remain the terminal fallback');
  assert(dogRefUrl('head-close.jpg', 'golden-retriever') === '/assets/dog-ref/head-close.jpg', 'Golden keeps its legacy root-level path');
}

// 6. Catalog: getDogVariants matches the frozen breed.variants for every id,
//    including breeds with no authored subtype (synthetic single 'default').
for (const breedInfo of DOG_BREEDS) {
  assert(getDogVariants(breedInfo.id) === breedInfo.variants, `${breedInfo.id} getDogVariants should return the catalog's own list`);
}
assert(getDogVariants('havanese').length === 1 && getDogVariants('havanese')[0].id === 'default', 'catalog-only breed should carry a synthetic single default variant');

// 7. Foot plant: any breed scale/legLength must land pads on y=0 after plantDogFeet.
{
  const { createProceduralDog } = await import('../src/game/characters/dog/createProceduralDog.js');
  const plantBreeds = [
    'chihuahua', 'golden-retriever', 'great-dane', 'dachshund',
    'pembroke-welsh-corgi', 'pomeranian', 'cane-corso',
    // Non-canine residual plant suite (jumpers + ungulates + rodent).
    'kangaroo-rat', 'jerboa', 'domestic-horse', 'reticulated-giraffe', 'norway-rat',
  ];
  for (const breedId of plantBreeds) {
    const dog = createProceduralDog({ breedId, seed: 1, shellCount: 0 });
    // Autopilot defaults into a walk cycle on the first tick — plant must be
    // checked in a standing pose (all four pads load-bearing), not mid-stride.
    dog.animation.setAutopilot(false);
    dog.animation.setBehavior('idle');
    dog.root.position.set(0, 0, 0);
    dog.update(0, { fixed: true, plantFeet: true, getGroundHeight: () => 0 });
    dog.root.updateMatrixWorld(true);
    dog.rig.skeleton.update();
    const scale = dog.phenotype.skeleton.scale;
    const padHang = DOG_PAW_MESH_PAD * scale;
    const padYs = ['PawL', 'PawR', 'HindPawL', 'HindPawR'].map((name) => {
      const p = new THREE.Vector3();
      dog.rig.bonesByName.get(name).getWorldPosition(p);
      return p.y - padHang;
    });
    const minPad = Math.min(...padYs);
    const maxPad = Math.max(...padYs);
    assert(minPad > -0.02, `${breedId} pad minY=${minPad.toFixed(3)} sunk through ground`);
    assert(minPad < 0.035, `${breedId} pad minY=${minPad.toFixed(3)} floating too high`);
    // Extreme legLength breeds can retain a few cm front/hind residual without IK.
    assert(maxPad - minPad < 0.08, `${breedId} pad spread=${(maxPad - minPad).toFixed(3)} after plant`);
    dog.dispose?.();
  }
}

console.log(
  `ok — dog sim: ${rig.boneCount} bones, ${verts} verts, bindErr=${maxBindErr.toExponential(1)}, `
  + `idleDisp=${idleDisp.toFixed(3)}, walkDisp=${walkDisp.toFixed(3)}, walkStrideZ=${zRange.toFixed(3)}, `
  + `authored=[${authoredStats.join(', ')}], dachshund variants=[${DOG_BREEDS.find((b) => b.id === 'dachshund').variants.map((v) => v.id).join(', ')}]`,
);
