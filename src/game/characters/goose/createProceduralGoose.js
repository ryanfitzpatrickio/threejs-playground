/**
 * Procedural bird built on the Canada-goose body.
 *
 * All authored Aves breeds share this pipeline: ~53-bone goose rig, ring-loft
 * body, TSL shell plumage, flight-feather cards, and procedural FSM animation.
 * Per-breed identity is a variety profile (scale + palette + pattern knobs) —
 * see birdVarietyProfile.js. Canada goose is the reference variety at scale 1.
 *
 * Returned handle is duck-typed for DogSimScene (same shape as createAuthoredBird /
 * createProceduralDog): root, rig, animation, shells, furDynamics, dispose, …
 */

import * as THREE from 'three';
import {
  getDogBreed,
  getDogFamily,
  isBirdBreed,
  normalizeDogBreedId,
  normalizeDogVariantId,
} from '../dog/dogCatalog.js';
import { normalizeDogSeed } from '../dog/dogPhenotypes.js';
import { createGooseSkeleton } from './gooseSkeleton.js';
import { buildGooseBodyGeometry } from './gooseBodyGeometry.js';
import {
  GOOSE_SHELL_COUNT,
  createGooseUniforms,
  createGooseBodyMaterial,
  createGooseShellMaterial,
  applyGooseMorphLandmarks,
  GooseFeatherDynamics,
} from './goosePlumage.js';
import {
  buildGooseFeatherGeometry,
  createGooseFeatherMaterial,
} from './gooseFeatherGeometry.js';
import { createGooseAnimation, GOOSE_CLIP_CATALOG } from './gooseAnimation.js';
import {
  applyBirdVarietyToUniforms,
  resolveBirdVariety,
} from './birdVarietyProfile.js';
import { resolveGooseMorph } from './gooseMorph.js';

/**
 * @param {{
 *   breedId?: string,
 *   seed?: number,
 *   variantId?: string,
 *   shellCount?: number,
 * }} [options]
 */
export async function createProceduralGoose(options = {}) {
  const breedId = normalizeDogBreedId(options.breedId ?? 'canada-goose', 'canada-goose');
  const breed = getDogBreed(breedId) ?? getDogBreed('canada-goose');
  // Non-bird callers still get a Canada goose rather than throwing (park / debug).
  const effectiveBreedId = isBirdBreed(breedId) ? breedId : 'canada-goose';
  const effectiveBreed = getDogBreed(effectiveBreedId) ?? breed;
  const family = getDogFamily(effectiveBreed.familyId);
  const seed = normalizeDogSeed(options.seed ?? 1);
  const variantId = normalizeDogVariantId(effectiveBreedId, options.variantId);
  const shellCount = Math.max(4, Math.min(80, options.shellCount ?? GOOSE_SHELL_COUNT));
  const variety = resolveBirdVariety(effectiveBreedId, seed);
  // Shape morph: neck length, body upright, beak/foot/eye styles from variety.
  const morph = resolveGooseMorph({
    neckLen: variety.neckLen,
    neckRot: variety.neckRot ?? 0,
    neckSocketX: variety.neckSocketX ?? 0,
    neckSocketY: variety.neckSocketY ?? 0,
    neckSocketZ: variety.neckSocketZ ?? 0,
    neckSocketRotX: variety.neckSocketRotX ?? 0,
    neckSocketRotY: variety.neckSocketRotY ?? 0,
    neckSocketRotZ: variety.neckSocketRotZ ?? 0,
    bodyUpright: variety.bodyUpright,
    bodyFat: variety.bodyFat,
    beakStyle: variety.beakStyle,
    beakPosX: variety.beakPosX ?? 0,
    beakPosY: variety.beakPosY ?? 0,
    beakPosZ: variety.beakPosZ ?? 0,
    beakRotX: variety.beakRotX ?? 0,
    beakRotY: variety.beakRotY ?? 0,
    beakRotZ: variety.beakRotZ ?? 0,
    beakScaleX: variety.beakScaleX ?? 1,
    beakScaleY: variety.beakScaleY ?? 1,
    beakScaleZ: variety.beakScaleZ ?? 1,
    footStyle: variety.footStyle,
    eyeStyle: variety.eyeStyle,
  });

  // ---- 1. bespoke goose skeleton + geometry ---------------------------------
  const rig = createGooseSkeleton(morph);
  const geometry = buildGooseBodyGeometry(rig.boneIndex, morph);
  const featherBuild = buildGooseFeatherGeometry(rig.boneIndex, morph);

  const root = new THREE.Group();
  root.name = `ProceduralBird_${effectiveBreedId}`;
  root.scale.setScalar(variety.scale);
  const model = rig.root;
  model.name = 'GooseArmature';
  root.add(model);

  const { skeleton, bonesByName } = rig;
  model.updateMatrixWorld(true);
  skeleton.calculateInverses();
  skeleton.update();

  // ---- 2. materials + skinned meshes ----------------------------------------
  const uniforms = createGooseUniforms();
  applyBirdVarietyToUniforms(uniforms, variety);
  applyGooseMorphLandmarks(uniforms, morph.dims);
  const furDynamics = new GooseFeatherDynamics(uniforms);

  const bodyMaterial = createGooseBodyMaterial(uniforms);
  const bodyMesh = new THREE.SkinnedMesh(geometry, bodyMaterial);
  bodyMesh.name = 'GooseBody';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.frustumCulled = false;
  bodyMesh.renderOrder = -1;
  bodyMesh.bind(skeleton);
  model.add(bodyMesh);

  /** @type {THREE.SkinnedMesh[]} */
  const shells = [];
  /** @type {THREE.Material[]} */
  const shellMaterials = [];
  for (let i = 1; i <= shellCount; i += 1) {
    const mat = createGooseShellMaterial(uniforms, i, shellCount);
    shellMaterials.push(mat);
    const mesh = new THREE.SkinnedMesh(geometry, mat);
    mesh.name = `GooseShell_${i}`;
    mesh.bind(skeleton);
    mesh.castShadow = i === 1;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = i;
    model.add(mesh);
    shells.push(mesh);
  }

  // Explicit flight feathers (primaries / secondaries / tertials / rectrix fan).
  // Skinned to wing/tail chains; spread/tailFan uniforms driven by the anim FSM.
  const feather = createGooseFeatherMaterial(uniforms);
  const featherMesh = new THREE.SkinnedMesh(featherBuild.geometry, feather.material);
  featherMesh.name = 'GooseFlightFeathers';
  featherMesh.castShadow = true;
  featherMesh.receiveShadow = false;
  featherMesh.frustumCulled = false;
  featherMesh.bind(skeleton);
  model.add(featherMesh);

  model.updateMatrixWorld(true);
  skeleton.update();

  // ---- 3. procedural animation facade ---------------------------------------
  const featherControls = {
    setSpread(t) { feather.uniforms.spread.value = t; },
    setTailFan(t) { feather.uniforms.tailFan.value = t; },
  };

  const animation = createGooseAnimation({
    root,
    model,
    rig,
    uniforms,
    feathers: featherControls,
  });
  animation.setBehavior('idle');
  // One settle frame so feet ground and neck/legs rest at bind.
  animation.update(1 / 30);

  const vertexCount = geometry.getAttribute('position')?.count ?? 0;
  const phenotype = Object.freeze({
    breedId: effectiveBreedId,
    variantId,
    familyId: effectiveBreed.familyId,
    speciesId: family?.speciesId ?? effectiveBreed.speciesId,
    seed,
    skeleton: {
      scale: variety.scale,
      headSize: 0.8,
      bodyLength: 1 - morph.bodyUpright * 0.2,
      chestWidth: morph.bodyFat,
      hipWidth: morph.bodyFat,
      legLength: 1,
      neckLength: 0.15 + morph.neckLen * 2.05,
      tailLength: 0.8,
    },
    geometry: { torsoWidth: 1, torsoDepth: 1 },
    ears: { type: 'none' },
    tail: { type: 'feathered' },
    face: {},
    coat: {
      length: variety.maxFeatherLen,
      palette: {
        base: rgbToHex(variety.palette.backBase),
        belly: rgbToHex(variety.palette.belly),
        accent: rgbToHex(variety.palette.stocking),
      },
    },
    furnishings: {},
    extremities: { foot: variety.footStyle === 'web' ? 'webbed' : variety.footStyle },
    headgear: { type: 'none' },
    motion: {},
    personality: { ...effectiveBreed.behavior },
    variation: {},
    // All bird varieties share the goose procedural rig (not bird-rigged.glb).
    rigKind: 'goose',
    shape: {
      bodyPlan: variety.bodyPlan,
      beakStyle: variety.beakStyle,
      footStyle: variety.footStyle,
      eyeStyle: variety.eyeStyle,
      neckLen: morph.neckLen,
      neckRot: morph.neckRot,
      neckSocketX: morph.neckSocketX,
      neckSocketY: morph.neckSocketY,
      neckSocketZ: morph.neckSocketZ,
      neckSocketRotX: morph.neckSocketRotX,
      neckSocketRotY: morph.neckSocketRotY,
      neckSocketRotZ: morph.neckSocketRotZ,
      bodyUpright: morph.bodyUpright,
      bodyFat: morph.bodyFat,
      beakPosX: morph.beakPosX,
      beakPosY: morph.beakPosY,
      beakPosZ: morph.beakPosZ,
      beakRotX: morph.beakRotX,
      beakRotY: morph.beakRotY,
      beakRotZ: morph.beakRotZ,
      beakScaleX: morph.beakScaleX,
      beakScaleY: morph.beakScaleY,
      beakScaleZ: morph.beakScaleZ,
    },
  });

  let nakedBody = false;
  let showFur = true;
  let detailLevel = 2;
  let visibleShellCount = shellCount;

  function syncShellVisibility() {
    const on = showFur && !nakedBody;
    const n = on ? Math.min(shellCount, visibleShellCount) : 0;
    for (let i = 0; i < shells.length; i += 1) {
      shells[i].visible = i < n;
    }
  }

  function dispose() {
    geometry.dispose();
    bodyMaterial.dispose();
    for (const m of shellMaterials) m.dispose();
    featherBuild.geometry.dispose();
    feather.material.dispose();
    root.removeFromParent();
  }

  return {
    breed: effectiveBreed,
    breedId: effectiveBreedId,
    variantId,
    familyId: effectiveBreed.familyId,
    speciesId: family?.speciesId ?? effectiveBreed.speciesId,
    seed,
    phenotype,
    resolvedTraits: phenotype,
    presentation: {
      label: variety.label,
      scale: variety.scale,
      bodyPlan: variety.bodyPlan,
      beakStyle: variety.beakStyle,
      footStyle: variety.footStyle,
      eyeStyle: variety.eyeStyle,
      neckLen: morph.neckLen,
      neckRot: morph.neckRot,
      neckSocketX: morph.neckSocketX,
      neckSocketY: morph.neckSocketY,
      neckSocketZ: morph.neckSocketZ,
      neckSocketRotX: morph.neckSocketRotX,
      neckSocketRotY: morph.neckSocketRotY,
      neckSocketRotZ: morph.neckSocketRotZ,
      bodyUpright: morph.bodyUpright,
      bodyFat: morph.bodyFat,
      beakPosX: morph.beakPosX,
      beakPosY: morph.beakPosY,
      beakPosZ: morph.beakPosZ,
      beakRotX: morph.beakRotX,
      beakRotY: morph.beakRotY,
      beakRotZ: morph.beakRotZ,
      beakScaleX: morph.beakScaleX,
      beakScaleY: morph.beakScaleY,
      beakScaleZ: morph.beakScaleZ,
    },
    variety,
    morph,
    root,
    rig: {
      root: bonesByName.get('root') ?? model,
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
    budget: 'hero',
    face: null,
    headgear: null,
    animation,
    featherControls,
    furUniforms: uniforms,
    furDynamics,
    update(dt) {
      animation.update(dt);
    },
    setNakedBody(on) {
      nakedBody = Boolean(on);
      furDynamics.setNaked(nakedBody);
      syncShellVisibility();
    },
    getNakedBody: () => nakedBody,
    setShowFur(on) {
      showFur = Boolean(on);
      syncShellVisibility();
    },
    getShowFur: () => showFur,
    setDetailLevel(level) {
      detailLevel = Math.max(0, Math.min(2, Math.floor(Number(level) || 0)));
      visibleShellCount = detailLevel === 0 ? 0 : detailLevel === 1 ? Math.min(8, shellCount) : shellCount;
      syncShellVisibility();
      return detailLevel;
    },
    getDetailLevel: () => detailLevel,
    dispose,
    boneCount: bonesByName.size,
    vertexCount,
    // Studio clip grid: procedural goose FSM (shared by all bird varieties).
    isBird: true,
    rigKind: 'goose',
    birdClips: GOOSE_CLIP_CATALOG,
    birdActions: null,
  };
}

/** @param {[number, number, number]} rgb */
function rgbToHex(rgb) {
  const c = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2]);
  return c.getHex();
}

export { GOOSE_CLIP_CATALOG } from './gooseAnimation.js';
export {
  BIRD_VARIETIES,
  resolveBirdVariety,
  applyBirdVarietyToUniforms,
} from './birdVarietyProfile.js';
export {
  resolveGooseMorph,
  morphFromBodyPlan,
  BEAK_STYLES,
  FOOT_STYLES,
  EYE_STYLES,
  DEFAULT_GOOSE_MORPH,
} from './gooseMorph.js';
