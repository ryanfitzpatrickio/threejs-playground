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
import { createDogAnimation } from './dogAnimation.js';
import { getDogBreed } from './dogCatalog.js';
import { resolveDogPhenotype } from './dogPhenotypes.js';

/**
 * @param {{ breedId?: string, seed?: number, shellCount?: number }} [options]
 */
export function createProceduralDog(options = {}) {
  const shellCount = options.shellCount ?? DEFAULT_SHELL_COUNT;
  const phenotype = resolveDogPhenotype({
    breedId: options.breedId ?? 'golden-retriever',
    seed: options.seed ?? 1,
  });
  const breed = getDogBreed(phenotype.breedId);

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
  bodyMesh.frustumCulled = false;
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
    mesh.castShadow = i === 0;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = i;
    root.add(mesh);
    shells.push(mesh);
  }

  // Normalize skeleton after all binds (shared skeleton).
  rig.skeleton.calculateInverses();
  rig.root.updateMatrixWorld(true);
  rig.skeleton.update();

  const face = createDogHeadFeatures(rig.bonesByName, phenotype);
  const animation = createDogAnimation(rig, { face, phenotype });
  const furDynamics = new DogFurDynamics(furUniforms);

  let nakedBody = false;
  let showFur = true;
  const worldRoot = new THREE.Vector3();

  /**
   * @param {number} dt
   * @param {{ fixed?: boolean, time?: number }} [opts]
   */
  function update(dt, opts = {}) {
    animation.update(dt, { fixed: opts.fixed });
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
    bodyMesh.visible = true;
    for (const s of shells) s.visible = nakedBody ? false : showFur;
  }

  function setShowFur(on) {
    showFur = Boolean(on);
    if (!nakedBody) {
      for (const s of shells) s.visible = showFur;
    }
  }

  function dispose() {
    geometry.dispose();
    bodyMaterial.dispose();
    for (const m of shellMaterials) m.dispose();
    face.dispose();
    root.removeFromParent();
  }

  return {
    breed,
    breedId: phenotype.breedId,
    familyId: phenotype.familyId,
    seed: phenotype.seed,
    phenotype,
    resolvedTraits: phenotype,
    root,
    rig,
    geometry,
    bodyMesh,
    shells,
    shellCount,
    face,
    animation,
    furUniforms,
    furDynamics,
    update,
    setNakedBody,
    getNakedBody: () => nakedBody,
    setShowFur,
    getShowFur: () => showFur,
    dispose,
    boneCount: rig.boneCount,
    vertexCount: geometry.getAttribute('position')?.count ?? 0,
  };
}
