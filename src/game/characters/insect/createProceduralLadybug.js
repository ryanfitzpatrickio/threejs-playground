/**
 * Fully procedural seven-spotted ladybug — first Insecta mesh path.
 *
 * Minimal 15-bone rig + skinned dome/elytra/legs + hard-chitin material with
 * baked spot mask + light soft shells on belly/joints. Duck-typed for
 * DogSimScene (same handle shape as createProceduralCat / createProceduralDog).
 *
 * Flag: `ladybug-rig` on the catalog breed (seven-spotted-ladybug).
 */

import * as THREE from 'three';
import { getDogBreed, getDogFamily, normalizeDogVariantId } from '../dog/dogCatalog.js';
import { normalizeDogSeed } from '../dog/dogPhenotypes.js';
import { createLadybugSkeleton } from './ladybugSkeleton.js';
import { buildLadybugBodyGeometry } from './ladybugBodyGeometry.js';
import {
  LADYBUG_SHELL_COUNT,
  createLadybugUniforms,
  createLadybugBodyMaterial,
  createLadybugShellMaterial,
  LadybugShellDynamics,
} from './ladybugMaterial.js';
import { createLadybugAnimation, LADYBUG_CLIP_CATALOG } from './ladybugAnimation.js';

/** Tiny deterministic hash → [0,1) for per-seed pattern variation. */
function seedRand(seed, salt) {
  const x = Math.sin((seed + 1) * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * @param {{
 *   breedId?: string,
 *   seed?: number,
 *   variantId?: string,
 *   shellCount?: number,
 *   budget?: 'hero' | 'npc',
 * }} [options]
 */
export function createProceduralLadybug(options = {}) {
  const breedId = options.breedId ?? 'seven-spotted-ladybug';
  const breed = getDogBreed(breedId) ?? getDogBreed('seven-spotted-ladybug');
  const family = getDogFamily(breed?.familyId ?? 'ladybug');
  const seed = normalizeDogSeed(options.seed ?? 1);
  const variantId = normalizeDogVariantId(breedId, options.variantId);
  const budget = options.budget === 'npc' ? 'npc' : 'hero';
  const shellCount = Math.max(0, Math.min(24,
    options.shellCount ?? (budget === 'npc' ? 4 : LADYBUG_SHELL_COUNT)));
  const useFrustumCull = budget === 'npc';

  // ---- 1. skeleton + geometry -----------------------------------------------
  const rig = createLadybugSkeleton();
  const geometry = buildLadybugBodyGeometry(rig.boneIndex);

  const root = new THREE.Group();
  root.name = `ProceduralLadybug_${breedId}`;
  // Display scale: macro studio size (body ~10cm). Seed nudges size slightly.
  const displayScale = 1.0 + (seedRand(seed, 0) - 0.5) * 0.12;
  root.scale.setScalar(displayScale);

  const model = rig.root;
  model.name = 'LadybugArmature';
  root.add(model);

  const { skeleton, bonesByName } = rig;
  model.updateMatrixWorld(true);
  skeleton.calculateInverses();
  skeleton.update();

  // ---- 2. materials + skinned meshes ----------------------------------------
  const uniforms = createLadybugUniforms();
  // Spot pattern strength + red tint from variant / seed
  const variantSpot = variantId === 'immaculate' ? 0.05
    : variantId === 'two-spot' ? 0.55
      : 1.0;
  uniforms.spotStrength.value = variantSpot * (0.9 + seedRand(seed, 1) * 0.15);
  uniforms.redTint.value = 0.92 + seedRand(seed, 2) * 0.16;

  const shellDynamics = new LadybugShellDynamics(uniforms);

  const bodyMaterial = createLadybugBodyMaterial(uniforms);
  const bodyMesh = new THREE.SkinnedMesh(geometry, bodyMaterial);
  bodyMesh.name = 'LadybugBody';
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
    const mat = createLadybugShellMaterial(uniforms, i, shellCount);
    shellMaterials.push(mat);
    const mesh = new THREE.SkinnedMesh(geometry, mat);
    mesh.name = `LadybugShell_${i}`;
    mesh.bind(skeleton);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = useFrustumCull;
    mesh.renderOrder = i;
    model.add(mesh);
    shells.push(mesh);
  }

  skeleton.calculateInverses();
  model.updateMatrixWorld(true);
  skeleton.update();

  // ---- 3. animation ---------------------------------------------------------
  const animation = createLadybugAnimation({ root, model, rig, uniforms });
  animation.setBehavior('idle');
  animation.update(1 / 30);

  const vertexCount = geometry.getAttribute('position')?.count ?? 0;

  const phenotype = Object.freeze({
    breedId,
    variantId,
    familyId: breed?.familyId ?? 'ladybug',
    speciesId: family?.speciesId ?? breed?.speciesId ?? 'coccinellidae',
    seed,
    skeleton: { scale: displayScale, bodyLength: 1, chestWidth: 1, hipWidth: 1, legLength: 1 },
    geometry: { torsoWidth: 1, torsoDepth: 1 },
    ears: { type: 'none' },
    tail: { type: 'none' },
    face: {},
    coat: {
      length: 0.05,
      pattern: 'ladybug-spotted',
      palette: { base: 0xc71f14, accent: 0x0a0a0a, white: 0xe8e4dc },
    },
    furnishings: {},
    extremities: { foot: 'insect-tarsus' },
    headgear: { type: 'none' },
    motion: {},
    personality: { ...(breed?.behavior ?? {}) },
    variation: {},
    rigKind: 'insect',
    shape: { bodyPlan: 'beetle', headStyle: 'ladybug', footStyle: 'insect' },
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
    presentation: { label: breed?.label ?? 'Ladybug', scale: displayScale },
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
    furDynamics: shellDynamics,
    rigKind: 'insect',
    isBird: false,
    isInsect: true,
    ladybugClips: LADYBUG_CLIP_CATALOG,
    catClips: LADYBUG_CLIP_CATALOG, // studio panel fallback for clip list
    update(dt, opts = {}) {
      animation.update(dt);
      if (opts.skipFurDynamics || detailLevel <= 0 || shellCount === 0) return;
      rig.rootBone.getWorldPosition(worldRoot);
      const breeze = animation.isFrozenBreeze()
        ? 0
        : 0.15 + Math.sin((opts.time ?? animation.getTime()) * 0.5) * 0.05;
      shellDynamics.update(dt, worldRoot, { time: opts.time ?? animation.getTime(), breeze });
    },
    setNakedBody(on) {
      nakedBody = Boolean(on);
      shellDynamics.setNaked(nakedBody);
      syncShellVisibility();
    },
    getNakedBody: () => nakedBody,
    setShowFur(on) { showFur = Boolean(on); syncShellVisibility(); },
    getShowFur: () => showFur,
    setDetailLevel(level) {
      detailLevel = Math.max(0, Math.min(2, Math.floor(Number(level) || 0)));
      if (shellCount <= 4) {
        visibleShellCount = shellCount;
      } else if (detailLevel >= 2) {
        visibleShellCount = shellCount;
      } else if (detailLevel === 1) {
        visibleShellCount = Math.min(shellCount, Math.max(3, Math.ceil(shellCount * 0.5)));
      } else {
        visibleShellCount = Math.min(shellCount, 2);
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
