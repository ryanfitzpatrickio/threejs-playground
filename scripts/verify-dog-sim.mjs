/**
 * verify-dog-sim — guards procedural dog skeleton/geometry/animation contracts.
 *
 * Run: node scripts/verify-dog-sim.mjs
 */

import * as THREE from 'three';
import { createDogSkeleton, DOG_BONE_DEFS, DOG_LEG_CHAINS } from '../src/game/characters/dog/dogSkeleton.js';
import { buildDogBodyGeometry } from '../src/game/characters/dog/dogBodyGeometry.js';
import { createDogAnimation } from '../src/game/characters/dog/dogAnimation.js';
import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';
import {
  AUTHORED_DOG_BREED_IDS,
  DOG_BREEDS,
  DOG_FAMILIES,
  DOG_LINEAGE_KEYS,
  normalizeRenderableDogBreedId,
} from '../src/game/characters/dog/dogCatalog.js';
import {
  DOG_PHENOTYPE_PROFILES,
  resolveDogPhenotype,
} from '../src/game/characters/dog/dogPhenotypes.js';

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

// Catalog: exact 2025 top 25, stable identities, family membership, and
// normalized gameplay-generation vectors with one shared ten-key schema.
assert(DOG_BREEDS.length === 26, `expected 26 catalog breeds, got ${DOG_BREEDS.length}`);
assert(new Set(DOG_BREEDS.map((breed) => breed.id)).size === 26, 'catalog breed IDs must be unique');
assert(new Set(DOG_FAMILIES.map((family) => family.id)).size === DOG_FAMILIES.length, 'family IDs must be unique');
assert(AUTHORED_DOG_BREED_IDS.length === 25, `expected 25 authored breeds, got ${AUTHORED_DOG_BREED_IDS.length}`);
const rankedBreeds = DOG_BREEDS.filter((breed) => Number.isInteger(breed.popularity.rank));
assert(
  rankedBreeds.length === 25
    && rankedBreeds.map((breed) => breed.popularity.rank).sort((a, b) => a - b).every((rank, i) => rank === i + 1),
  'AKC 2025 ranks must be exactly 1–25',
);
const familyIds = new Set(DOG_FAMILIES.map((family) => family.id));
for (const breed of DOG_BREEDS) {
  assert(familyIds.has(breed.familyId), `${breed.id} references missing family ${breed.familyId}`);
  assert(breed.popularity.year === 2025, `${breed.id} popularity year mismatch`);
  assert(Object.isFrozen(breed), `${breed.id} catalog entry should be immutable`);
  assert(
    JSON.stringify(Object.keys(breed.generatorLineage)) === JSON.stringify(DOG_LINEAGE_KEYS),
    `${breed.id} lineage schema mismatch`,
  );
  const total = Object.values(breed.generatorLineage).reduce((sum, value) => sum + value, 0);
  assert(Math.abs(total - 1) < 1e-9, `${breed.id} lineage weights sum to ${total}`);
}
assert(
  Object.keys(DOG_PHENOTYPE_PROFILES).length === 25,
  `expected 25 phenotype profiles, got ${Object.keys(DOG_PHENOTYPE_PROFILES).length}`,
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
assert(normalizeRenderableDogBreedId('havanese') === 'golden-retriever', 'catalog-only breed rendered approximately');
assert(normalizeRenderableDogBreedId('unknown-dog') === 'golden-retriever', 'unknown breed did not fall back to Golden');
assert(resolveDogPhenotype({ breedId: 'golden-retriever', seed: 1 }).skeleton.scale === 1, 'Golden seed 1 default drifted');

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
  const minimumEarPath = dog.phenotype.ears.fold === 'rose' ? 0.025 : 0.035;
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
  if (dog.phenotype.ears.type === 'erect' || dog.phenotype.ears.type === 'bat') {
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
  for (const pawName of ['PawL', 'PawR', 'HindPawL', 'HindPawR']) {
    const y = dog.rig.worldBindPos.get(pawName).y;
    assert(y >= 0 && y < 0.08, `${breedId} ${pawName} bind y=${y.toFixed(3)} not ground-planted`);
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

console.log(
  `ok — dog sim: ${rig.boneCount} bones, ${verts} verts, bindErr=${maxBindErr.toExponential(1)}, `
  + `idleDisp=${idleDisp.toFixed(3)}, walkDisp=${walkDisp.toFixed(3)}, walkStrideZ=${zRange.toFixed(3)}, `
  + `authored=[${authoredStats.join(', ')}]`,
);
