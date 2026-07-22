/**
 * verify-animal-species — guards the iconic-species expansion pass:
 * every target taxonomic family is populated (≥1 authored breed), each new
 * breed resolves a profile with its SIGNATURE body part(s) present, and the
 * mesh builds end-to-end via createProceduralDog() without throwing.
 *
 * Signature parts asserted (per the species plan):
 *   otter        → webbed-paw
 *   badger       → badger-faced coat + dorsal crest
 *   skunk        → skunk-striped coat
 *   red-panda    → red-panda coat
 *   genet        → genet-spotted coat
 *   hyena        → hyena-spotted coat + dorsal crest
 *   chinchilla   → chinchilla-silver coat
 *   porcupines   → dorsal quill field
 *   red-deer     → antler-rack headgear + cloven-hoof
 *   dromedary    → dorsal hump + cloven-hoof
 *   warthog      → tusk-boar headgear + cloven-hoof + dorsal crest
 *   beaver       → paddle tail + webbed-paw
 *   deer/camel/pig → cloven-hoof
 *
 * Run:  node scripts/verify-animal-species.mjs
 * npm:  npm run verify:animal-species
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProceduralDog } from '../src/game/characters/dog/createProceduralDog.js';
import {
  ANIMAL_SPECIES,
  DOG_BREEDS,
  isSpeciesPopulated,
  getDogBreed,
  getAnimalSpecies,
} from '../src/game/characters/dog/dogCatalog.js';
import { DOG_PHENOTYPE_PROFILES, resolveDogPhenotype } from '../src/game/characters/dog/dogPhenotypes.js';
import {
  animalClipLibraryKind,
  clipCatalogForKind,
  clipLibraryBasePath,
  DogClipPlayer,
  DOG_CLIP_CATALOG,
} from '../src/game/characters/dog/DogClipPlayer.js';
import { plantDogFeet, DOG_PAW_MESH_PAD } from '../src/game/characters/dog/dogFootPlant.js';
import * as THREE from 'three';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// Target taxonomic families: iconic expansion + remaining empty-species fill.
const TARGET_SPECIES = [
  'mustelidae',
  'mephitidae',
  'ailuridae',
  'viverridae',
  'herpestidae',
  'hyaenidae',
  'castoridae',
  'caviidae',
  'chinchillidae',
  'erethizontidae',
  'hystricidae',
  'cervidae',
  'camelidae',
  'suidae',
  // Remaining empty-species fill (19)
  'eupleridae',
  'nandiniidae',
  'prionodontidae',
  'heteromyidae',
  'dipodidae',
  'gliridae',
  'spalacidae',
  'nesomyidae',
  'geomyidae',
  'bathyergidae',
  'equidae',
  'rhinocerotidae',
  'tapiridae',
  'tayassuidae',
  'hippopotamidae',
  'giraffidae',
  'moschidae',
  'tragulidae',
  'antilocapridae',
];

// Each breed + an assertion over its resolved phenotype. `signature` is a
// (phenotype) => boolean that must hold (seed never perturbs these fields).
const BREEDS = [
  { id: 'river-otter', species: 'mustelidae', signature: (p) => p.extremities.foot === 'webbed-paw', label: 'webbed-paw' },
  { id: 'european-badger', species: 'mustelidae', signature: (p) => p.coat.pattern === 'badger-faced' && p.furnishings.dorsalCrest > 0, label: 'badger-faced + dorsal crest' },
  { id: 'least-weasel', species: 'mustelidae', signature: (p) => p.skeleton.bodyLength > 1.3 && p.skeleton.scale < 0.4, label: 'elongated tiny tube' },
  { id: 'striped-skunk', species: 'mephitidae', signature: (p) => p.coat.pattern === 'skunk-striped', label: 'skunk-striped' },
  { id: 'red-panda', species: 'ailuridae', signature: (p) => p.coat.pattern === 'red-panda', label: 'red-panda coat' },
  { id: 'common-genet', species: 'viverridae', signature: (p) => p.coat.pattern === 'genet-spotted', label: 'genet-spotted' },
  { id: 'meerkat', species: 'herpestidae', signature: (p) => p.coat.pattern === 'solid' && p.skeleton.bodyLength > 1.05, label: 'slender long-bodied' },
  { id: 'spotted-hyena', species: 'hyaenidae', signature: (p) => p.coat.pattern === 'hyena-spotted' && p.furnishings.dorsalCrest > 0, label: 'hyena-spotted + dorsal crest' },
  { id: 'capybara', species: 'caviidae', signature: (p) => p.skeleton.tailLength < 0.25, label: 'stub tail' },
  { id: 'guinea-pig', species: 'caviidae', signature: (p) => p.skeleton.scale < 0.5 && p.skeleton.tailLength < 0.2, label: 'cobby tiny + no tail' },
  { id: 'patagonian-mara', species: 'caviidae', signature: (p) => p.skeleton.legLength > 0.85 && p.skeleton.tailLength < 0.3, label: 'long legs + short tail' },
  { id: 'chinchilla', species: 'chinchillidae', signature: (p) => p.coat.pattern === 'chinchilla-silver', label: 'chinchilla-silver' },
  { id: 'north-american-porcupine', species: 'erethizontidae', signature: (p) => p.furnishings.quills > 0, label: 'dorsal quills' },
  { id: 'crested-porcupine', species: 'hystricidae', signature: (p) => p.furnishings.quills > 0 && p.furnishings.dorsalCrest > 0, label: 'long quills + crest' },
  { id: 'red-deer', species: 'cervidae', signature: (p) => p.headgear.type === 'antler-rack' && p.extremities.foot === 'cloven-hoof', label: 'antler rack + cloven hoof' },
  { id: 'dromedary', species: 'camelidae', signature: (p) => p.geometry.hump > 0 && p.extremities.foot === 'cloven-hoof', label: 'single hump + cloven hoof' },
  { id: 'llama', species: 'camelidae', signature: (p) => p.extremities.foot === 'cloven-hoof' && p.skeleton.neckLength > 1.3, label: 'long neck + cloven hoof' },
  { id: 'domestic-pig', species: 'suidae', signature: (p) => p.extremities.foot === 'cloven-hoof', label: 'cloven hoof' },
  { id: 'warthog', species: 'suidae', signature: (p) => p.headgear.type === 'tusk-boar' && p.extremities.foot === 'cloven-hoof' && p.furnishings.dorsalCrest > 0, label: 'boar tusks + crest + cloven hoof' },
  { id: 'north-american-beaver', species: 'castoridae', signature: (p) => p.tail.type === 'paddle' && p.extremities.foot === 'webbed-paw', label: 'paddle tail + webbed paw' },
  // Remaining empty-species fill
  { id: 'fossa', species: 'eupleridae', signature: (p) => p.skeleton.bodyLength > 1.2 && p.extremities.foot === 'paw', label: 'long body + paw' },
  { id: 'african-palm-civet', species: 'nandiniidae', signature: (p) => p.coat.pattern === 'genet-spotted' && p.skeleton.tailLength >= 1.0, label: 'spotted + long tail' },
  { id: 'banded-linsang', species: 'prionodontidae', signature: (p) => p.skeleton.bodyLength > 1.25 && p.skeleton.tailLength > 1.2, label: 'elongated + very long tail' },
  {
    id: 'kangaroo-rat',
    species: 'heteromyidae',
    signature: (p) => p.extremities.foot === 'rodent-paw'
      && p.skeleton.legLength > 0.9
      && (p.skeleton.frontLegScale ?? 1) < 0.9
      && (p.skeleton.frontLegScale ?? 1) >= 0.85,
    label: 'rodent-paw + long hind-biased legs (plant-safe frontLegScale)',
  },
  {
    id: 'jerboa',
    species: 'dipodidae',
    signature: (p) => p.extremities.foot === 'rodent-paw'
      && p.skeleton.tailLength > 1.2
      && p.skeleton.legLength > 0.95
      && (p.skeleton.frontLegScale ?? 1) < 0.9
      && (p.skeleton.frontLegScale ?? 1) >= 0.85,
    label: 'rodent-paw + long tail/legs (plant-safe frontLegScale)',
  },
  { id: 'edible-dormouse', species: 'gliridae', signature: (p) => p.extremities.foot === 'rodent-paw' && p.tail.type === 'sciurid', label: 'rodent-paw + bushy tail' },
  { id: 'blind-mole-rat', species: 'spalacidae', signature: (p) => p.extremities.foot === 'rodent-paw' && p.skeleton.tailLength < 0.25 && p.skeleton.legLength < 0.5, label: 'fossorial short tail/legs' },
  { id: 'giant-pouched-rat', species: 'nesomyidae', signature: (p) => p.extremities.foot === 'rodent-paw' && p.skeleton.scale > 0.5, label: 'rodent-paw + larger scale' },
  { id: 'pocket-gopher', species: 'geomyidae', signature: (p) => p.extremities.foot === 'rodent-paw' && p.skeleton.tailLength < 0.35, label: 'rodent-paw + short tail' },
  { id: 'naked-mole-rat', species: 'bathyergidae', signature: (p) => p.extremities.foot === 'rodent-paw' && p.coat.length < 0.1, label: 'rodent-paw + near-hairless' },
  { id: 'domestic-horse', species: 'equidae', signature: (p) => p.extremities.foot === 'solid-hoof' && p.skeleton.legLength > 1.2, label: 'solid hoof + long legs' },
  { id: 'white-rhinoceros', species: 'rhinocerotidae', signature: (p) => p.extremities.foot === 'solid-hoof' && p.headgear.type === 'horn-bovid', label: 'solid hoof + horn' },
  { id: 'brazilian-tapir', species: 'tapiridae', signature: (p) => p.extremities.foot === 'solid-hoof' && p.skeleton.muzzleLength > 1.3, label: 'solid hoof + long muzzle' },
  {
    id: 'collared-peccary',
    species: 'tayassuidae',
    signature: (p) => p.extremities.foot === 'cloven-hoof'
      && p.geometry?.headShape === 'suid'
      && (p.furnishings?.dorsalCrest ?? 0) > 0,
    label: 'cloven hoof + suid head + crest',
  },
  { id: 'common-hippopotamus', species: 'hippopotamidae', signature: (p) => p.extremities.foot === 'cloven-hoof' && p.skeleton.scale > 1.3, label: 'cloven hoof + giant scale' },
  {
    id: 'reticulated-giraffe',
    species: 'giraffidae',
    // Coat uses hyena-spotted as a reticulation proxy (no dedicated reticulated pattern).
    signature: (p) => p.extremities.foot === 'cloven-hoof'
      && p.skeleton.neckLength > 1.7
      && p.headgear.type === 'horn-caprine'
      && p.coat.pattern === 'hyena-spotted',
    label: 'cloven hoof + extreme neck + ossicone proxy + reticulation proxy coat',
  },
  { id: 'siberian-musk-deer', species: 'moschidae', signature: (p) => p.extremities.foot === 'cloven-hoof' && p.headgear.type === 'none', label: 'cloven hoof + hornless' },
  { id: 'lesser-mouse-deer', species: 'tragulidae', signature: (p) => p.extremities.foot === 'cloven-hoof' && p.skeleton.scale < 0.45, label: 'cloven hoof + toy scale' },
  { id: 'pronghorn', species: 'antilocapridae', signature: (p) => p.extremities.foot === 'cloven-hoof' && p.headgear.type === 'horn-caprine', label: 'cloven hoof + prong horns' },
];

// --- Every target species is populated (≥1 authored breed) ---
{
  const unpopulated = TARGET_SPECIES.filter((sp) => !isSpeciesPopulated(sp));
  assert.equal(unpopulated.length, 0, `unpopulated target species: ${unpopulated.join(', ')}`);
  ok(`${TARGET_SPECIES.length} target species populated`);
}

// --- Catalog entries exist + are authored ---
{
  const missing = BREEDS.filter((b) => !getDogBreed(b.id));
  assert.equal(missing.length, 0, `missing catalog breed: ${missing.map((b) => b.id).join(', ')}`);
  const unauthored = BREEDS.filter((b) => getDogBreed(b.id).authored !== true);
  assert.equal(unauthored.length, 0, `not authored: ${unauthored.map((b) => b.id).join(', ')}`);
  ok(`${BREEDS.length} new breed catalog entries authored`);
}

// --- Each breed has a phenotype profile + signature part resolves ---
{
  let totalVerts = 0;
  let totalBones = 0;
  for (const b of BREEDS) {
    assert.ok(DOG_PHENOTYPE_PROFILES[b.id], `no DOG_PHENOTYPE_PROFILES entry for ${b.id}`);
    const ph = resolveDogPhenotype({ breedId: b.id, seed: 1 });
    assert.equal(ph.breedId, b.id, `${b.id} identity lost`);
    // Resolved phenotype carries the family's speciesId.
    assert.equal(ph.speciesId, b.species, `${b.id} speciesId ${ph.speciesId} !== ${b.species}`);
    assert.ok(b.signature(ph), `${b.id} signature failed (${b.label})`);
  }
  ok(`${BREEDS.length} breeds resolve profiles + signature parts`);
}

// --- createProceduralDog builds every new breed without throwing ---
{
  let minVerts = Infinity;
  let minBones = Infinity;
  for (const b of BREEDS) {
    /** @type {{root: object, boneCount: number, vertexCount: number, dispose: () => void}} */
    let dog;
    assert.doesNotThrow(() => {
      dog = createProceduralDog({ breedId: b.id, seed: 7, shellCount: 2 });
    }, `${b.id} mesh build threw`);
    assert.ok(dog?.root, `${b.id} produced no root`);
    assert.ok(dog.boneCount >= 38, `${b.id} boneCount ${dog.boneCount} < 38`);
    assert.ok(dog.vertexCount > 800, `${b.id} vertexCount ${dog.vertexCount} too low`);
    minVerts = Math.min(minVerts, dog.vertexCount);
    minBones = Math.min(minBones, dog.boneCount);
    dog.dispose();
  }
  ok(`${BREEDS.length} breeds build meshes (min ${minBones} bones / ${minVerts} verts)`);
}

// --- Clip library routing: every master-list species has an expected kind ---
{
  /** @param {string} speciesId */
  function expectedKind(speciesId) {
    const orderId = getAnimalSpecies(speciesId)?.orderId ?? null;
    // Birds use embedded GLB clips (animalClipLibraryKind → null).
    if (orderId === 'aves') return 'bird';
    if (orderId === 'rodentia') return 'rodent';
    if (
      orderId === 'perissodactyla'
      || speciesId === 'giraffidae'
      || speciesId === 'hippopotamidae'
    ) {
      return 'equid';
    }
    // Remaining artiodactyls use Quaternius Cow pack (bovid).
    if (orderId === 'artiodactyla') return 'bovid';
    return 'dog';
  }

  const counts = { dog: 0, rodent: 0, equid: 0, bovid: 0, bird: 0 };
  for (const sp of ANIMAL_SPECIES) {
    const expected = expectedKind(sp.id);
    const got = animalClipLibraryKind({ speciesId: sp.id });
    // Bird species return null (embedded GLB clips), recorded as 'bird' here.
    const recorded = got == null && expected === 'bird' ? 'bird' : got;
    assert.equal(
      recorded,
      expected,
      `${sp.id} clip kind ${got} (recorded ${recorded}) !== ${expected}`,
    );
    counts[expected] += 1;
  }
  assert.equal(counts.rodent, 15, `expected 15 rodent routes, got ${counts.rodent}`);
  assert.equal(counts.equid, 5, `expected 5 equid routes, got ${counts.equid}`);
  assert.equal(counts.bovid, 8, `expected 8 bovid routes, got ${counts.bovid}`);
  assert.equal(counts.dog, 13, `expected 13 dog routes, got ${counts.dog}`);
  assert.equal(counts.bird, 10, `expected 10 bird routes, got ${counts.bird}`);
  assert.equal(
    counts.dog + counts.rodent + counts.equid + counts.bovid + counts.bird,
    ANIMAL_SPECIES.length,
  );

  // Flag / breedId resolution (not speciesId-only knobs).
  assert.equal(animalClipLibraryKind({ conformationFlags: ['horse-clips'] }), 'equid');
  assert.equal(animalClipLibraryKind({ conformationFlags: ['cow-clips'] }), 'bovid');
  assert.equal(animalClipLibraryKind({ conformationFlags: ['rat-clips'] }), 'rodent');
  // Conflicting flags: rodent/rat-clips checked first and must win.
  assert.equal(
    animalClipLibraryKind({ conformationFlags: ['horse-clips', 'rat-clips'] }),
    'rodent',
    'rat-clips must take precedence over horse-clips',
  );
  assert.equal(animalClipLibraryKind({ breedId: 'domestic-horse' }), 'equid');
  assert.equal(animalClipLibraryKind({ breedId: 'domestic-pig' }), 'bovid');
  assert.equal(animalClipLibraryKind({ breedId: 'norway-rat' }), 'rodent');
  assert.equal(animalClipLibraryKind({ breedId: 'golden-retriever' }), 'dog');

  // Farm packs share FARM_CLIP_CATALOG; dog pack is distinct.
  assert.equal(clipCatalogForKind('equid'), clipCatalogForKind('bovid'));
  assert.notEqual(clipCatalogForKind('equid'), DOG_CLIP_CATALOG);
  assert.equal(clipCatalogForKind('dog'), DOG_CLIP_CATALOG);
  assert.notEqual(clipCatalogForKind('rodent'), DOG_CLIP_CATALOG);

  // Procedural opt-out + DogClipPlayer fail-closed.
  const prevLocation = globalThis.location;
  globalThis.location = { search: '?dogAnims=procedural' };
  assert.equal(animalClipLibraryKind({ speciesId: 'canidae' }), null);
  assert.equal(animalClipLibraryKind({ breedId: 'domestic-horse' }), null);
  {
    const proceduralDog = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
    const player = new DogClipPlayer(proceduralDog);
    assert.equal(player.libraryKind, null);
    assert.equal(player.enabled, false);
    player.dispose();
    proceduralDog.dispose();
  }
  if (prevLocation === undefined) delete globalThis.location;
  else globalThis.location = prevLocation;

  ok(`clip routing exhaustive: dog ${counts.dog} / rodent ${counts.rodent} / equid ${counts.equid} / bovid ${counts.bovid} / bird ${counts.bird} + breedId + procedural`);
}

// --- Catalog-wide clip flag exclusivity (every rat/horse flag matches route set) ---
{
  const equidSpecies = new Set([
    'equidae', 'rhinocerotidae', 'tapiridae', 'giraffidae', 'hippopotamidae',
  ]);
  for (const breed of DOG_BREEDS) {
    const flags = breed.conformationFlags ?? [];
    if (flags.includes('rat-clips') || flags.includes('rodent')) {
      const orderId = getAnimalSpecies(breed.speciesId)?.orderId;
      assert.equal(
        orderId,
        'rodentia',
        `${breed.id} has rat-clips/rodent flag but species ${breed.speciesId} is not rodentia`,
      );
      assert.equal(
        animalClipLibraryKind({ breedId: breed.id }),
        'rodent',
        `${breed.id} with rat-clips must route rodent`,
      );
    }
    if (flags.includes('horse-clips')) {
      assert.ok(
        equidSpecies.has(breed.speciesId),
        `${breed.id} has horse-clips but species ${breed.speciesId} is not in equid route set`,
      );
      assert.equal(
        animalClipLibraryKind({ breedId: breed.id }),
        'equid',
        `${breed.id} with horse-clips must route equid`,
      );
    }
  }
  ok('catalog-wide rat-clips → rodentia and horse-clips → equid exclusivity');
}

// --- Every master-list species is populated (no empty catalog slots) ---
{
  const empty = ANIMAL_SPECIES.filter((s) => !isSpeciesPopulated(s.id)).map((s) => s.id);
  assert.equal(empty.length, 0, `still-empty species: ${empty.join(', ')}`);
  ok(`all ${ANIMAL_SPECIES.length} master-list species populated`);
}

// --- Equid / bovid Quaternius packs (measured, not config-only) ---
{
  assert.equal(clipLibraryBasePath('equid'), '/assets/equid-anims');
  assert.equal(clipLibraryBasePath('bovid'), '/assets/bovid-anims');
  assert.equal(clipLibraryBasePath('dog'), '/assets/dog-anims');
  assert.equal(clipLibraryBasePath('rodent'), '/assets/rodent-anims');

  function trackMotion(track) {
    const step = track.name.endsWith('.quaternion') ? 4 : 3;
    const values = track.values;
    let max = 0;
    for (let i = step; i < values.length; i += step) {
      let d = 0;
      for (let c = 0; c < step; c += 1) d += Math.abs(values[i + c] - values[c]);
      max = Math.max(max, d);
    }
    return max;
  }

  function assertFarmPack(dir, label, sourceNeedle) {
    const manifest = JSON.parse(readFileSync(join(root, `public/assets/${dir}/manifest.json`), 'utf8'));
    assert.ok(String(manifest.source).includes(sourceNeedle), `${dir} source must include ${sourceNeedle}`);
    assert.ok(manifest.clips.length >= 5, `${dir} must ship locomotion clips (got ${manifest.clips.length})`);
    for (const name of ['Idle', 'Walk', 'Run']) {
      assert.ok(manifest.clips.some((c) => c.name === name), `${dir} missing ${name}`);
    }
    const walkEntry = manifest.clips.find((c) => c.name === 'Walk');
    const walk = JSON.parse(readFileSync(join(root, `public/assets/${dir}`, walkEntry.file), 'utf8'));
    assert.ok(walk.tracks.length >= 20, `${dir} Walk track count ${walk.tracks.length} too low`);
    assert.ok(
      walk.tracks.some((t) => t.name.startsWith('Pelvis.') || t.name.startsWith('ShoulderL.')),
      `${dir} Walk must target dog skeleton bones`,
    );
    const forearmL = walk.tracks.find((t) => t.name === 'ForearmL.quaternion')
      ?? walk.tracks.find((t) => t.name === 'UpperArmL.quaternion');
    const thighL = walk.tracks.find((t) => t.name === 'ThighL.quaternion')
      ?? walk.tracks.find((t) => t.name === 'ShinL.quaternion');
    assert.ok(forearmL, `${dir} Walk missing a front-leg quaternion track`);
    assert.ok(thighL, `${dir} Walk missing a hind-leg quaternion track`);
    assert.ok(
      trackMotion(forearmL) > 0.05,
      `${label} Walk front-leg motion too low (${trackMotion(forearmL).toFixed(4)})`,
    );
    assert.ok(
      trackMotion(thighL) > 0.03,
      `${label} Walk hind-leg motion too low (${trackMotion(thighL).toFixed(4)})`,
    );
    return { manifest, walk };
  }

  const equid = assertFarmPack('equid-anims', 'equid', 'Horse');
  const bovid = assertFarmPack('bovid-anims', 'bovid', 'Cow');
  ok(
    `equid+bovid Quaternius packs `
    + `(equid ${equid.manifest.clips.length} clips / walk ${equid.walk.tracks.length} tracks; `
    + `bovid ${bovid.manifest.clips.length} clips / walk ${bovid.walk.tracks.length} tracks)`,
  );
}

// --- Measured foot kits + headgear geometry (not phenotype knobs alone) ---
{
  /** Metrics for verts primarily skinned to a paw bone. */
  function footMetrics(dog, boneName = 'PawL') {
    const boneIdx = dog.rig.skeleton.bones.findIndex((b) => b.name === boneName);
    assert.ok(boneIdx >= 0, `missing bone ${boneName}`);
    const pos = dog.geometry.getAttribute('position');
    const skinIndex = dog.geometry.getAttribute('skinIndex');
    const skinWeight = dog.geometry.getAttribute('skinWeight');
    let minX = Infinity;
    let maxX = -Infinity;
    let count = 0;
    for (let i = 0; i < pos.count; i += 1) {
      let w = 0;
      for (let j = 0; j < 4; j += 1) {
        if (skinIndex.getComponent(i, j) === boneIdx) w += skinWeight.getComponent(i, j);
      }
      if (w < 0.45) continue;
      const x = pos.getX(i);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      count += 1;
    }
    assert.ok(count > 10, `${dog.breedId} foot verts too few (${count})`);
    return { width: maxX - minX, count };
  }

  /** Count mesh descendants under a headgear root (empty Group must fail). */
  function headgearMeshCount(headgear) {
    if (!headgear?.root) return 0;
    let n = 0;
    headgear.root.traverse((obj) => {
      if (obj.isMesh) n += 1;
    });
    return n;
  }

  const golden = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
  const horse = createProceduralDog({ breedId: 'domestic-horse', seed: 1, shellCount: 0 });
  const goat = createProceduralDog({ breedId: 'domestic-goat', seed: 1, shellCount: 0 });
  const peccary = createProceduralDog({ breedId: 'collared-peccary', seed: 1, shellCount: 0 });
  const rat = createProceduralDog({ breedId: 'norway-rat', seed: 1, shellCount: 0 });
  const rhino = createProceduralDog({ breedId: 'white-rhinoceros', seed: 1, shellCount: 0 });
  const giraffe = createProceduralDog({ breedId: 'reticulated-giraffe', seed: 1, shellCount: 0 });

  const goldenM = footMetrics(golden);
  const horseM = footMetrics(horse);
  const goatM = footMetrics(goat);
  const peccaryM = footMetrics(peccary);
  const ratM = footMetrics(rat);
  // Dog pads are the widest end-effector; hooves/rodent paws must measure narrower.
  assert.ok(goldenM.width > 0.05, `golden pad width ${goldenM.width}`);
  assert.ok(horseM.width < goldenM.width * 0.75, `solid-hoof width ${horseM.width} not narrower than paw ${goldenM.width}`);
  assert.ok(goatM.width < goldenM.width * 0.75, `cloven-hoof width ${goatM.width} not narrower than paw ${goldenM.width}`);
  assert.ok(ratM.width < goldenM.width * 0.45, `rodent-paw width ${ratM.width} not skinny vs paw ${goldenM.width}`);

  // Cloven emits two toe spheres + cleft (higher near-paw vert count than solid wall).
  assert.equal(horse.phenotype.extremities.foot, 'solid-hoof');
  assert.equal(goat.phenotype.extremities.foot, 'cloven-hoof');
  assert.equal(peccary.phenotype.extremities.foot, 'cloven-hoof');
  assert.equal(rat.phenotype.extremities.foot, 'rodent-paw');
  assert.ok(
    goatM.count > horseM.count * 1.2,
    `cloven-hoof goat verts ${goatM.count} should exceed solid-hoof horse ${horseM.count} (dual toes + cleft)`,
  );
  assert.ok(
    peccaryM.count > horseM.count * 1.2,
    `cloven-hoof peccary verts ${peccaryM.count} should exceed solid-hoof horse ${horseM.count}`,
  );
  assert.ok(
    Math.abs(goatM.count - peccaryM.count) < 40,
    `cloven samples should share toe kit (~same count); goat ${goatM.count} vs peccary ${peccaryM.count}`,
  );

  assert.ok(!golden.headgear?.root, 'golden should not emit headgear root');
  assert.ok(
    headgearMeshCount(rhino.headgear) >= 2,
    `rhino headgear must have mesh children (got ${headgearMeshCount(rhino.headgear)})`,
  );
  assert.ok(
    headgearMeshCount(giraffe.headgear) >= 2,
    `giraffe headgear must have mesh children (got ${headgearMeshCount(giraffe.headgear)})`,
  );
  assert.ok(
    headgearMeshCount(goat.headgear) >= 2,
    `goat headgear must have mesh children (got ${headgearMeshCount(goat.headgear)})`,
  );
  assert.equal(headgearMeshCount(horse.headgear), 0, 'horse has no headgear kit');

  for (const d of [golden, horse, goat, peccary, rat, rhino, giraffe]) d.dispose();
  ok('measured foot kits (paw/solid/cloven/rodent) + headgear meshes');
}

// --- createProceduralDog routing + DogClipPlayer libraryKind for equid/rodent ---
{
  const horse = createProceduralDog({ breedId: 'domestic-horse', seed: 1, shellCount: 0 });
  const rat = createProceduralDog({ breedId: 'norway-rat', seed: 1, shellCount: 0 });
  const dog = createProceduralDog({ breedId: 'golden-retriever', seed: 1, shellCount: 0 });
  assert.equal(animalClipLibraryKind(horse), 'equid');
  assert.equal(animalClipLibraryKind(rat), 'rodent');
  assert.equal(animalClipLibraryKind(dog), 'dog');

  const horsePlayer = new DogClipPlayer(horse);
  const ratPlayer = new DogClipPlayer(rat);
  const dogPlayer = new DogClipPlayer(dog);
  assert.equal(horsePlayer.libraryKind, 'equid');
  assert.equal(ratPlayer.libraryKind, 'rodent');
  assert.equal(dogPlayer.libraryKind, 'dog');
  assert.equal(horsePlayer.enabled, true);
  assert.equal(clipLibraryBasePath(horsePlayer.libraryKind), '/assets/equid-anims');
  assert.equal(clipLibraryBasePath(ratPlayer.libraryKind), '/assets/rodent-anims');

  const pig = createProceduralDog({ breedId: 'domestic-pig', seed: 1, shellCount: 0 });
  const pigPlayer = new DogClipPlayer(pig);
  assert.equal(pigPlayer.libraryKind, 'bovid');
  assert.equal(clipLibraryBasePath(pigPlayer.libraryKind), '/assets/bovid-anims');

  horsePlayer.dispose();
  ratPlayer.dispose();
  dogPlayer.dispose();
  pigPlayer.dispose();
  horse.dispose();
  rat.dispose();
  dog.dispose();
  pig.dispose();
  ok('DogClipPlayer libraryKind equid/bovid/rodent/dog from createProceduralDog');
}

// --- Post-plant residual for jumpers + ungulates (not dog-only) ---
{
  const plantBreeds = [
    'kangaroo-rat', 'jerboa', 'domestic-horse', 'reticulated-giraffe', 'norway-rat',
  ];
  for (const breedId of plantBreeds) {
    const dog = createProceduralDog({ breedId, seed: 1, shellCount: 0 });
    dog.animation.setAutopilot(false);
    dog.animation.setBehavior('idle');
    dog.root.position.set(0, 0, 0);
    // Bind coplanarity before plant.
    const bindYs = ['PawL', 'PawR', 'HindPawL', 'HindPawR'].map(
      (n) => dog.rig.worldBindPos.get(n).y,
    );
    const bindSpread = Math.max(...bindYs) - Math.min(...bindYs);
    assert.ok(
      bindSpread < 0.04,
      `${breedId} bind paw spread ${bindSpread.toFixed(3)} (front/hind not coplanar)`,
    );
    assert.ok(Math.max(...bindYs) < 0.06, `${breedId} bind maxY ${Math.max(...bindYs).toFixed(3)}`);

    plantDogFeet({ root: dog.root, rig: dog.rig }, { getGroundHeight: () => 0 });
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
    assert.ok(minPad > -0.02, `${breedId} pad minY=${minPad.toFixed(3)} sunk`);
    assert.ok(minPad < 0.04, `${breedId} pad minY=${minPad.toFixed(3)} floating`);
    assert.ok(maxPad - minPad < 0.08, `${breedId} pad spread=${(maxPad - minPad).toFixed(3)}`);
    dog.dispose();
  }
  ok(`post-plant residual for ${plantBreeds.length} jumper/ungulate breeds`);
}

console.log(`\n${passed} passed`);
