/**
 * Bespoke fully-procedural domestic cat — the "3cat" attempt.
 *
 * A fresh feline pipeline (own ~46-bone rig + ring-loft body + TSL shell coat +
 * procedural IK animation) that replaces the tortoiseshell feline stub which
 * previously rode the shared quadruped dog pipeline. The dog rig can't express
 * the cat's defining traits — a highly flexible multi-bone spine, digitigrade
 * fore & hind legs, a long expressive tail, mobile ears — so cats get their own
 * armature and coat here.
 *
 * Returned handle is duck-typed for DogSimScene (same shape as
 * createProceduralGoose / createProceduralDog): root, rig, animation, shells,
 * furDynamics, dispose, … `rigKind: 'cat'` opts the cat out of the shared
 * dog-bone clip library (see animalClipLibraryKind) so it stays procedural.
 */

import * as THREE from 'three';
import { getDogBreed, getDogFamily, normalizeDogVariantId } from '../dog/dogCatalog.js';
import { normalizeDogSeed } from '../dog/dogPhenotypes.js';
import { createCatSkeleton } from './catSkeleton.js';
import { buildCatBodyGeometry, buildCatWhiskers } from './catBodyGeometry.js';
import {
  CAT_SHELL_COUNT,
  createCatUniforms,
  createCatBodyMaterial,
  createCatShellMaterial,
  createCatWhiskerMaterial,
  CatFurDynamics,
} from './catFurMaterial.js';
import { createCatAnimation, CAT_CLIP_CATALOG } from './catAnimation.js';

/** Tiny deterministic hash → [0,1) for per-seed coat variation. */
function seedRand(seed, salt) {
  const x = Math.sin((seed + 1) * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * @param {{ breedId?: string, seed?: number, variantId?: string, shellCount?: number, budget?: 'hero'|'npc' }} [options]
 */
export function createProceduralCat(options = {}) {
  const breedId = options.breedId ?? 'domestic-shorthair';
  const breed = getDogBreed(breedId) ?? getDogBreed('domestic-shorthair');
  const family = getDogFamily(breed?.familyId ?? 'feline');
  const seed = normalizeDogSeed(options.seed ?? 1);
  const variantId = normalizeDogVariantId(breedId, options.variantId);
  const budget = options.budget === 'npc' ? 'npc' : 'hero';
  // Spec range 40–60 for hero; NPCs drop far lower for crowd budget.
  const shellCount = Math.max(3, Math.min(60,
    options.shellCount ?? (budget === 'npc' ? 8 : CAT_SHELL_COUNT)));
  const useFrustumCull = budget === 'npc';

  // ---- 1. bespoke cat skeleton + geometry -----------------------------------
  const rig = createCatSkeleton();
  const geometry = buildCatBodyGeometry(rig.boneIndex);

  const root = new THREE.Group();
  root.name = `ProceduralCat_${breedId}`;
  const model = rig.root;
  model.name = 'CatArmature';
  root.add(model);

  const { skeleton, bonesByName } = rig;
  model.updateMatrixWorld(true);
  skeleton.calculateInverses();
  skeleton.update();

  // ---- 2. materials + skinned meshes ----------------------------------------
  const uniforms = createCatUniforms();
  // Per-seed coat variation. A true tortoiseshell has essentially no white
  // (that's a calico) and only a faint torbie stripe in the ginger.
  uniforms.whiteAmt.value = seedRand(seed, 1) * 0.15;
  uniforms.tabbyStrength.value = 0.25 + seedRand(seed, 2) * 0.25;
  // Coat length/texture from breed conformation flags: long-haired / grooming
  // breeds grow a neck/cheek ruff; rex breeds get a wavier coat; shorthairs
  // stay sleek.
  const flags = Array.isArray(breed?.conformationFlags) ? breed.conformationFlags : [];
  const longHair = flags.includes('high-grooming') || flags.includes('cold-climate-double-coat');
  const rex = flags.includes('rex-coat');
  const ruffAmt = options.ruff ?? (longHair ? 0.7 + seedRand(seed, 3) * 0.3 : 0.0);
  const coatWave = rex ? 0.9 : longHair ? 0.55 : 0.35;
  uniforms.ruffAmt.value = ruffAmt;
  uniforms.coatWave.value = coatWave;
  uniforms.maxFurLen.value = longHair ? 1.6 : 1.0;
  const furDynamics = new CatFurDynamics(uniforms);

  const bodyMaterial = createCatBodyMaterial(uniforms);
  const bodyMesh = new THREE.SkinnedMesh(geometry, bodyMaterial);
  bodyMesh.name = 'CatBody';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.frustumCulled = useFrustumCull;
  bodyMesh.renderOrder = -1;
  bodyMesh.bind(skeleton);
  model.add(bodyMesh);

  /** @type {THREE.SkinnedMesh[]} */
  const shells = [];
  /** @type {THREE.Material[]} */
  const shellMaterials = [];
  for (let i = 1; i <= shellCount; i += 1) {
    const mat = createCatShellMaterial(uniforms, i, shellCount);
    shellMaterials.push(mat);
    const mesh = new THREE.SkinnedMesh(geometry, mat);
    mesh.name = `CatShell_${i}`;
    mesh.bind(skeleton);
    mesh.castShadow = budget === 'hero' && i === 1;
    mesh.receiveShadow = false;
    mesh.frustumCulled = useFrustumCull;
    mesh.renderOrder = i;
    model.add(mesh);
    shells.push(mesh);
  }

  // ---- 2b. whiskers (own skinned ribbon mesh, muzzle-bound, sway dynamics) ---
  const whiskerGeo = buildCatWhiskers(rig.boneIndex);
  const whiskerMaterial = createCatWhiskerMaterial(uniforms);
  const whiskerMesh = new THREE.SkinnedMesh(whiskerGeo, whiskerMaterial);
  whiskerMesh.name = 'CatWhiskers';
  whiskerMesh.castShadow = false;
  whiskerMesh.receiveShadow = false;
  whiskerMesh.frustumCulled = false;
  whiskerMesh.renderOrder = shellCount + 1;
  whiskerMesh.bind(skeleton);
  model.add(whiskerMesh);

  skeleton.calculateInverses();
  model.updateMatrixWorld(true);
  skeleton.update();

  // ---- 3. procedural animation facade ---------------------------------------
  const animation = createCatAnimation({ root, model, rig, uniforms });
  animation.setBehavior('idle');
  animation.update(1 / 30); // one settle frame so paws ground

  const vertexCount = geometry.getAttribute('position')?.count ?? 0;

  const phenotype = Object.freeze({
    breedId,
    variantId,
    familyId: breed?.familyId ?? 'feline',
    speciesId: family?.speciesId ?? breed?.speciesId ?? 'felidae',
    seed,
    skeleton: { scale: 1, headSize: 0.7, bodyLength: 1, chestWidth: 1, hipWidth: 1, legLength: 1 },
    geometry: { torsoWidth: 1, torsoDepth: 1 },
    ears: { type: 'erect' },
    tail: { type: 'long' },
    face: {},
    coat: {
      length: longHair ? 1.6 : 1,
      pattern: 'tortoiseshell',
      ruff: ruffAmt,
      wave: coatWave,
      palette: { base: 0x0e0d0d, accent: 0x9e5220, white: 0xf0eee6 },
    },
    furnishings: {},
    extremities: { foot: 'digitigrade' },
    headgear: { type: 'none' },
    motion: {},
    personality: { ...(breed?.behavior ?? {}) },
    variation: {},
    rigKind: 'cat', // bespoke procedural rig — not the shared dog-bone clip library
    shape: { bodyPlan: 'feline', headStyle: 'domestic-cat', footStyle: 'digitigrade' },
  });

  let nakedBody = false;
  let showFur = true;
  let detailLevel = 2;
  let visibleShellCount = shellCount;
  let faceVisible = true;
  const worldRoot = new THREE.Vector3();

  function syncShellVisibility() {
    const on = showFur && !nakedBody;
    const n = on ? Math.min(shellCount, visibleShellCount) : 0;
    for (let i = 0; i < shells.length; i += 1) shells[i].visible = i < n;
  }

  function dispose() {
    geometry.dispose();
    bodyMaterial.dispose();
    for (const m of shellMaterials) m.dispose();
    whiskerGeo.dispose();
    whiskerMaterial.dispose();
    root.removeFromParent();
  }

  return {
    breed,
    breedId,
    variantId,
    familyId: phenotype.familyId,
    speciesId: phenotype.speciesId,
    seed,
    phenotype,
    resolvedTraits: phenotype,
    presentation: { label: breed?.label ?? 'Domestic Cat', scale: 1 },
    root,
    rig: {
      root: model,
      skeleton,
      bonesByName,
      boneCount: bonesByName.size,
      phenotype,
      worldBindPos: rig.worldBindPos,
      rootBone: rig.rootBone,
    },
    geometry,
    bodyMesh,
    shells,
    shellCount,
    budget,
    face: null,
    headgear: null,
    animation,
    furUniforms: uniforms,
    furDynamics,
    rigKind: 'cat',
    isBird: false,
    catClips: CAT_CLIP_CATALOG,
    update(dt, opts = {}) {
      animation.update(dt);
      if (opts.skipFurDynamics || detailLevel <= 0) return;
      rig.rootBone.getWorldPosition(worldRoot);
      const breeze = animation.isFrozenBreeze()
        ? 0
        : 0.22 + Math.sin((opts.time ?? animation.getTime()) * 0.5) * 0.06;
      furDynamics.update(dt, worldRoot, { time: opts.time ?? animation.getTime(), breeze });
    },
    setNakedBody(on) {
      nakedBody = Boolean(on);
      furDynamics.setNaked(nakedBody);
      syncShellVisibility();
    },
    getNakedBody: () => nakedBody,
    setShowFur(on) { showFur = Boolean(on); syncShellVisibility(); },
    getShowFur: () => showFur,
    setDetailLevel(level) {
      // Same rule as dogFurLod: thin stacks keep shells (no bare undercoat flash);
      // thicker stacks thin to a dense base coat at distance.
      detailLevel = Math.max(0, Math.min(2, Math.floor(Number(level) || 0)));
      if (shellCount <= 4) {
        visibleShellCount = shellCount;
      } else if (detailLevel >= 2) {
        visibleShellCount = shellCount;
      } else if (detailLevel === 1) {
        visibleShellCount = Math.min(shellCount, Math.max(4, Math.ceil(shellCount * 0.5)));
      } else {
        visibleShellCount = Math.min(shellCount, Math.max(3, Math.ceil(shellCount * 0.22)));
      }
      faceVisible = true;
      void faceVisible;
      syncShellVisibility();
      return detailLevel;
    },
    getDetailLevel: () => detailLevel,
    dispose,
    boneCount: bonesByName.size,
    vertexCount,
  };
}
