/**
 * Bespoke fully-procedural domestic horse — "horse v2".
 *
 * A fresh equine pipeline (own ~120-bone rig + ring-loft body + TSL shell
 * coat + procedural gait/IK animation) that lives BESIDE the v1
 * `domestic-horse` phenotype (shared dog skeleton + Quaternius equid clips).
 * The catalog `horse-rig` flag on `domestic-horse-procedural` routes builds
 * here (mirrors the cat's `cat-rig`).
 *
 * Returned handle is duck-typed for DogSimScene (same shape as
 * createProceduralCat / createProceduralGoose / createProceduralDog): root,
 * rig, animation, shells, furDynamics, dispose, … `rigKind: 'horse'` opts the
 * horse out of the shared dog-bone clip library (see animalClipLibraryKind)
 * so it stays procedural.
 */

import * as THREE from 'three';
import { getDogBreed, getDogFamily, normalizeDogVariantId } from '../dog/dogCatalog.js';
import { normalizeDogSeed } from '../dog/dogPhenotypes.js';
import { createHorseSkeleton } from './horseSkeleton.js';
import { buildHorseBodyGeometry } from './horseBodyGeometry.js';
import {
  HORSE_SHELL_COUNT,
  createHorseUniforms,
  createHorseBodyMaterial,
  createHorseShellMaterial,
  HorseFurDynamics,
} from './horseCoatMaterial.js';
import { createHorseAnimation, HORSE_CLIP_CATALOG } from './horseAnimation.js';

/** Tiny deterministic hash → [0,1) for per-seed coat variation. */
function seedRand(seed, salt) {
  const x = Math.sin((seed + 1) * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * @param {{ breedId?: string, seed?: number, variantId?: string, shellCount?: number, budget?: 'hero'|'npc' }} [options]
 */
export function createProceduralHorse(options = {}) {
  const breedId = options.breedId ?? 'domestic-horse-procedural';
  const breed = getDogBreed(breedId) ?? getDogBreed('domestic-horse-procedural');
  const family = getDogFamily(breed?.familyId ?? 'equid');
  const seed = normalizeDogSeed(options.seed ?? 1);
  const variantId = normalizeDogVariantId(breedId, options.variantId);
  const budget = options.budget === 'npc' ? 'npc' : 'hero';
  // Spec range 80–100 for hero; NPCs drop far lower for crowd budget.
  const shellCount = Math.max(3, Math.min(100,
    options.shellCount ?? (budget === 'npc' ? 10 : HORSE_SHELL_COUNT)));
  const useFrustumCull = budget === 'npc';

  // ---- 1. bespoke horse skeleton + geometry ---------------------------------
  const rig = createHorseSkeleton();
  const geometry = buildHorseBodyGeometry(rig.boneIndex);

  const root = new THREE.Group();
  root.name = `ProceduralHorse_${breedId}`;
  const model = rig.root;
  model.name = 'HorseArmature';
  root.add(model);

  const { skeleton, bonesByName } = rig;
  model.updateMatrixWorld(true);
  skeleton.calculateInverses();
  skeleton.update();

  // ---- 2. materials + skinned meshes ----------------------------------------
  const uniforms = createHorseUniforms();
  // Per-seed coat variation: face marking size, sock layout, dappling, roan.
  uniforms.blazeAmt.value = seedRand(seed, 1) < 0.5 ? 0.15 + seedRand(seed, 2) * 0.25 : 0.55 + seedRand(seed, 2) * 0.45;
  uniforms.sockFL.value = seedRand(seed, 3) < 0.55 ? 1 : 0;
  uniforms.sockFR.value = seedRand(seed, 4) < 0.25 ? 1 : 0;
  uniforms.sockHL.value = seedRand(seed, 5) < 0.35 ? 1 : 0;
  uniforms.sockHR.value = seedRand(seed, 6) < 0.35 ? 1 : 0;
  uniforms.dappleAmt.value = 0.15 + seedRand(seed, 7) * 0.5;
  uniforms.roanAmt.value = seedRand(seed, 8) < 0.2 ? 0.3 + seedRand(seed, 9) * 0.4 : 0;
  uniforms.coatGloss.value = 0.75 + seedRand(seed, 10) * 0.25;
  const furDynamics = new HorseFurDynamics(uniforms);

  const bodyMaterial = createHorseBodyMaterial(uniforms);
  const bodyMesh = new THREE.SkinnedMesh(geometry, bodyMaterial);
  bodyMesh.name = 'HorseBody';
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
    const mat = createHorseShellMaterial(uniforms, i, shellCount);
    shellMaterials.push(mat);
    const mesh = new THREE.SkinnedMesh(geometry, mat);
    mesh.name = `HorseShell_${i}`;
    mesh.bind(skeleton);
    mesh.castShadow = budget === 'hero' && i === 1;
    mesh.receiveShadow = false;
    mesh.frustumCulled = useFrustumCull;
    mesh.renderOrder = i;
    model.add(mesh);
    shells.push(mesh);
  }

  skeleton.calculateInverses();
  model.updateMatrixWorld(true);
  skeleton.update();

  // ---- 3. procedural animation facade ---------------------------------------
  const animation = createHorseAnimation({ root, model, rig, uniforms });
  animation.setBehavior('idle');
  animation.update(1 / 30); // one settle frame so hooves ground

  const vertexCount = geometry.getAttribute('position')?.count ?? 0;

  const phenotype = Object.freeze({
    breedId,
    variantId,
    familyId: breed?.familyId ?? 'equid',
    speciesId: family?.speciesId ?? breed?.speciesId ?? 'equidae',
    seed,
    // scale drives studio chase-cam framing (dog scale 1 ≈ 0.6 m withers).
    skeleton: { scale: 2.4, headSize: 1.1, bodyLength: 1, chestWidth: 1, hipWidth: 1, legLength: 1 },
    geometry: { torsoWidth: 1, torsoDepth: 1 },
    ears: { type: 'erect' },
    tail: { type: 'long-haired' },
    face: {},
    coat: {
      length: 1,
      pattern: 'bay',
      palette: { base: 0x6b3318, points: 0x0e0b0b, white: 0xede9e2 },
    },
    furnishings: { crestMane: true, forelock: true },
    extremities: { foot: 'solid-hoof' },
    headgear: { type: 'none' },
    motion: {},
    personality: { ...(breed?.behavior ?? {}) },
    variation: {},
    rigKind: 'horse', // bespoke procedural rig — not the shared dog-bone clip library
    shape: { bodyPlan: 'equine', headStyle: 'domestic-horse', footStyle: 'solid-hoof' },
  });

  let nakedBody = false;
  let showFur = true;
  let detailLevel = 2;
  let visibleShellCount = shellCount;
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
    presentation: { label: breed?.label ?? 'Domestic Horse (Procedural)', scale: 2.4 },
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
    rigKind: 'horse',
    isBird: false,
    horseClips: HORSE_CLIP_CATALOG,
    update(dt, opts = {}) {
      animation.update(dt);
      if (opts.skipFurDynamics || detailLevel <= 0) return;
      rig.rootBone.getWorldPosition(worldRoot);
      const breeze = animation.isFrozenBreeze()
        ? 0
        : 0.20 + Math.sin((opts.time ?? animation.getTime()) * 0.45) * 0.06;
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
      // Same rule as dogFurLod: thin stacks keep shells (no bare undercoat
      // flash); thicker stacks thin to a dense base coat at distance.
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
      syncShellVisibility();
      return detailLevel;
    },
    getDetailLevel: () => detailLevel,
    dispose,
    boneCount: bonesByName.size,
    vertexCount,
  };
}
