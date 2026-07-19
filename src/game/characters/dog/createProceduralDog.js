/**
 * Factory: procedural skinned dog with shell fur, face features, and animation.
 */

import * as THREE from 'three';
import { createDogSkeleton } from './dogSkeleton.js';
import { buildDogBodyGeometry } from './dogBodyGeometry.js';
import {
  DEFAULT_SHELL_COUNT,
  createDogFurUniforms,
  createDogShellMaterial,
  createDogBodyMaterial,
  DogFurDynamics,
} from './dogFurMaterial.js';
import { createDogHeadFeatures } from './dogHeadFeatures.js';
import { createAnimalHeadgear } from './animalHeadgear.js';
import { createDogAnimation } from './dogAnimation.js';
import { resolveDogPhenotype } from './dogPhenotypes.js';
import {
  getBreedOrVirtual,
  normalizeDirectPhenotype,
  resolveDogPhenotypeFromRecipe,
} from './animalPhenotypeClamp.js';
import { plantDogFeet } from './dogFootPlant.js';

/**
 * Build a procedural skinned animal (shared quadruped rig).
 *
 * Resolution precedence:
 * 1. `phenotype` — pre-built / integrity-checked object (no recipe clamp)
 * 2. `recipe` — validated + clamped AnimalPhenotype JSON (never Golden fallback)
 * 3. catalog `breedId` via `resolveDogPhenotype` (unknown → Golden)
 *
 * @param {{
 *   breedId?: string,
 *   seed?: number,
 *   variantId?: string,
 *   shellCount?: number,
 *   phenotype?: object,
 *   recipe?: object,
 *   budget?: 'hero' | 'npc',
 * }} [options]
 */
export function createProceduralDog(options = {}) {
  const budget = options.budget === 'npc' ? 'npc' : 'hero';
  const shellCount = options.shellCount ?? (budget === 'npc' ? 3 : DEFAULT_SHELL_COUNT);
  const seed = options.seed ?? 1;
  // NPCs: frustum cull + no multi-shell shadows. Hero keeps always-draw so
  // close-ups never pop when the root AABB lags skinned fur.
  const useFrustumCull = budget === 'npc' || options.frustumCulled === true;

  let phenotype;
  if (options.phenotype) {
    phenotype = normalizeDirectPhenotype(options.phenotype, { seed });
  } else if (options.recipe) {
    phenotype = resolveDogPhenotypeFromRecipe(options.recipe, {
      seed: options.seed ?? options.recipe.seed ?? 1,
    });
  } else {
    phenotype = resolveDogPhenotype({
      breedId: options.breedId ?? 'golden-retriever',
      seed,
      variantId: options.variantId,
    });
  }

  const breed = getBreedOrVirtual(phenotype);

  const rig = createDogSkeleton({ phenotype });
  // Geometry is authored in the skeleton's bind world space.
  const geometry = buildDogBodyGeometry(rig, phenotype);

  const root = new THREE.Group();
  root.name = `ProceduralDog_${phenotype.breedId}`;
  root.scale.setScalar(phenotype.skeleton.scale);
  root.add(rig.root);

  const furUniforms = createDogFurUniforms(phenotype);
  furUniforms.shellCount.value = shellCount;

  const bodyMaterial = createDogBodyMaterial(furUniforms);
  const bodyMesh = new THREE.SkinnedMesh(geometry, bodyMaterial);
  bodyMesh.name = 'DogBody';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.frustumCulled = useFrustumCull;
  // Bind with identity — geometry is already in the same space as the skeleton bind pose.
  bodyMesh.bind(rig.skeleton);
  // Keep a solid undercoat under transparent shells so gaps never read as holes.
  bodyMesh.visible = true;
  bodyMesh.renderOrder = -1;
  root.add(bodyMesh);

  /** @type {THREE.SkinnedMesh[]} */
  const shells = [];
  /** @type {THREE.Material[]} */
  const shellMaterials = [];

  for (let i = 0; i < shellCount; i += 1) {
    const mat = createDogShellMaterial(furUniforms, i, shellCount);
    shellMaterials.push(mat);
    const mesh = new THREE.SkinnedMesh(geometry, mat);
    mesh.name = `DogFurShell_${i}`;
    mesh.bind(rig.skeleton);
    // Only the first shell casts a shadow — multi-shell shadow maps explode draw cost.
    mesh.castShadow = budget === 'hero' && i === 0;
    mesh.receiveShadow = false;
    mesh.frustumCulled = useFrustumCull;
    mesh.renderOrder = i;
    root.add(mesh);
    shells.push(mesh);
  }

  // Normalize skeleton after all binds (shared skeleton).
  rig.skeleton.calculateInverses();
  rig.root.updateMatrixWorld(true);
  rig.skeleton.update();

  const face = createDogHeadFeatures(rig.bonesByName, phenotype);
  const headgear = createAnimalHeadgear(rig.bonesByName, phenotype);
  const animation = createDogAnimation(rig, { face, phenotype });
  const furDynamics = new DogFurDynamics(furUniforms);

  let nakedBody = false;
  let showFur = true;
  /** Visible shell layers (LOD). -1 = all when showFur. */
  let visibleShellCount = shellCount;
  let faceVisible = true;
  let headgearVisible = true;
  /** 0 body-only · 1 sparse shells · 2 full shells + face */
  let detailLevel = 2;
  const worldRoot = new THREE.Vector3();

  function setBoneDecorVisible(boneName, visible) {
    const bone = rig.bonesByName.get(boneName);
    if (!bone) return;
    for (const child of bone.children) {
      // Skeleton bones are also children — only toggle mesh/group decor.
      if (child.isBone) continue;
      if (child.name === 'AnimalHeadgear') {
        child.visible = visible && headgearVisible;
      } else {
        child.visible = visible;
      }
    }
  }

  function applyVisibility() {
    bodyMesh.visible = true;
    const shellsOn = !nakedBody && showFur;
    const n = shellsOn ? Math.max(0, Math.min(shellCount, visibleShellCount)) : 0;
    for (let i = 0; i < shells.length; i += 1) {
      shells[i].visible = i < n;
    }
    // Face/nose/whiskers/jaw interior are Object3D children of Head/Muzzle/Jaw.
    setBoneDecorVisible('Head', faceVisible);
    setBoneDecorVisible('Muzzle', faceVisible);
    setBoneDecorVisible('Jaw', faceVisible);
    if (headgear?.root) headgear.root.visible = headgearVisible && faceVisible;
  }

  /**
   * Distance / budget LOD for park crowds.
   * 0 = body only (far)
   * 1 = body + one shell, face on (mid)
   * 2 = full shells + face/headgear (near)
   * @param {0|1|2} level
   */
  function setDetailLevel(level) {
    const next = Math.max(0, Math.min(2, Math.floor(Number(level) || 0)));
    if (next === detailLevel) return detailLevel;
    detailLevel = next;
    if (detailLevel <= 0) {
      visibleShellCount = 0;
      faceVisible = false;
      headgearVisible = false;
    } else if (detailLevel === 1) {
      visibleShellCount = Math.min(1, shellCount);
      faceVisible = true;
      headgearVisible = false;
    } else {
      visibleShellCount = shellCount;
      faceVisible = true;
      headgearVisible = true;
    }
    applyVisibility();
    return detailLevel;
  }

  /**
   * @param {number} dt
   * @param {{
   *   fixed?: boolean,
   *   time?: number,
   *   skipFurDynamics?: boolean,
   *   getGroundHeight?: (x: number, z: number) => number,
   *   plantFeet?: boolean,
   *   plantIk?: boolean,
   * }} [opts]
   */
  function update(dt, opts = {}) {
    animation.update(dt, { fixed: opts.fixed });
    // After procedural (or pre-clip) pose: plant pads on ground for any breed
    // scale / legLength. Controllers pass getGroundHeight; studio uses y=0.
    if (opts.plantFeet !== false) {
      plantDogFeet({ root, rig, phenotype }, {
        getGroundHeight: opts.getGroundHeight ?? (() => 0),
        ik: opts.plantIk !== false,
      });
    }
    if (opts.skipFurDynamics || detailLevel <= 0) {
      return;
    }
    rig.root.getWorldPosition(worldRoot);
    const breeze = animation.isFrozenBreeze()
      ? 0
      : 0.28 + Math.sin((opts.time ?? animation.getTime()) * 0.4) * 0.06;
    furDynamics.update(dt, worldRoot, {
      time: opts.time ?? animation.getTime(),
      breeze,
    });
  }

  function setNakedBody(on) {
    nakedBody = Boolean(on);
    furDynamics.setNaked(nakedBody);
    applyVisibility();
  }

  function setShowFur(on) {
    showFur = Boolean(on);
    applyVisibility();
  }

  function dispose() {
    geometry.dispose();
    bodyMaterial.dispose();
    for (const m of shellMaterials) m.dispose();
    face.dispose();
    headgear.dispose();
    root.removeFromParent();
  }

  // NPCs start at full detail; park system drops them via setDetailLevel.
  applyVisibility();

  return {
    breed,
    breedId: phenotype.breedId,
    variantId: phenotype.variantId,
    familyId: phenotype.familyId,
    speciesId: phenotype.speciesId ?? breed.speciesId ?? null,
    seed: phenotype.seed,
    phenotype,
    resolvedTraits: phenotype,
    root,
    rig,
    geometry,
    bodyMesh,
    shells,
    shellCount,
    budget,
    face,
    headgear,
    animation,
    furUniforms,
    furDynamics,
    update,
    setNakedBody,
    getNakedBody: () => nakedBody,
    setShowFur,
    getShowFur: () => showFur,
    setDetailLevel,
    getDetailLevel: () => detailLevel,
    dispose,
    boneCount: rig.boneCount,
    vertexCount: geometry.getAttribute('position')?.count ?? 0,
  };
}
