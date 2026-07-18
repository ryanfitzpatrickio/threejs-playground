import * as THREE from 'three';
import { clone as cloneSkinnedObject } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { buildModelingMorphs } from '../../../vendor/vibe-human/characterModeling.ts';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import { flattenObjectForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { installBodyHideUnderOutfit } from './bodyHideUnderOutfit.js';
import {
  sanitizeOutfitLimbReveal,
  sanitizeOutfitPosition,
  sanitizeOutfitScale,
  sanitizeOutfitSkinTuck,
} from './simAppearanceSchema.js';
import {
  installOutfitLoopCuts,
  sanitizeOutfitLoopCuts,
} from './outfitLoopCuts.js';
import { resolveSimOutfitAsset } from './simOutfitCatalog.js';
import { resolveSimOutfitBone, toSimOutfitTargetBoneName } from './simOutfitBoneMap.js';
import {
  computeOutfitFitFromMorphs,
  computeOutfitRegionScales,
  isOutfitProjectedMorphTarget,
  selectOutfitMorphs,
} from './simOutfitFit.js';
import {
  createOutfitFitUniforms,
  installOutfitInflateOnMesh,
} from './outfitInflateMaterial.js';
import { installOutfitLimbCuts } from './outfitLimbVisibility.js';

const templatePromises = new Map();

/**
 * Slight overdrive on baked bulk morphs. Keep modest — stacking big gain with
 * residual push/scale reopens multi-mesh seams (torso/arms/legs).
 */
const PROJECTED_MORPH_GAIN = 1.18;

/**
 * Attach a skinned authored outfit and wire body-morph fit drivers.
 *
 * Fit stack:
 * 1. Bone-weight body hide — discard torso/limb body fragments (face/hands/feet stay)
 * 2. Offline projected morph targets (mass/muscle/fat)
 * 3. Radial cloth ease + bind-pose XYZ scale/position (outfit mesh only)
 */
export async function attachSimOutfit({ actor, outfitId, scene, variant, body } = {}) {
  const resolvedVariant = variant
    ?? actor.preset?.outfitVariant
    ?? 'morph';
  // Prefer an explicit body (the skeleton actually being bound) over preset.body,
  // which can race ahead/behind during creator body switches.
  const resolvedBody = body
    ?? actor?.preset?.body
    ?? null;
  const asset = resolveSimOutfitAsset(outfitId, resolvedBody, {
    variant: resolvedVariant,
  });
  if (!asset) {
    throw new Error(`Outfit ${outfitId} is not compatible with ${resolvedBody}`);
  }

  const template = await loadOutfitTemplate(asset.url);
  const group = cloneSkinnedObject(template);
  group.name = `Sim Outfit:${actor.id}:${outfitId}`;
  const meshes = [];
  const morphMeshes = [];
  const ownedSkeletons = [];
  const ownedMaterials = [];
  const missingBones = new Set();

  // Shared shader uniforms — AttachedBindMode cancels Object3D.scale on skinned
  // meshes, so fit scale + inflate live in positionNode (bind pose).
  const fitUniforms = createOutfitFitUniforms();

  group.updateMatrixWorld(true);
  group.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    // Skip helper meshes that sometimes ride along in prepared GLBs.
    if (/ico|sphere/i.test(node.name || '')) {
      node.visible = false;
      return;
    }
    const sourceSkeleton = node.skeleton;
    if (!sourceSkeleton?.bones?.length) return;

    const bones = sourceSkeleton.bones.map((sourceBone) => {
      const target = resolveSimOutfitBone(actor.model.bones, sourceBone.name);
      if (!target) {
        const targetName = toSimOutfitTargetBoneName(sourceBone.name);
        missingBones.add(`${sourceBone.name} -> ${targetName}`);
        return sourceBone;
      }
      return target;
    });
    const skeleton = new THREE.Skeleton(
      bones,
      sourceSkeleton.boneInverses.map((matrix) => matrix.clone()),
    );
    node.bind(skeleton, node.bindMatrix);
    node.normalizeSkinWeights?.();
    node.castShadow = true;
    node.receiveShadow = true;
    node.frustumCulled = false;
    node.renderOrder = 1;
    ownedMaterials.push(...installOutfitInflateOnMesh(node, fitUniforms));
    meshes.push(node);
    if (node.morphTargetDictionary && node.morphTargetInfluences) {
      morphMeshes.push(node);
    }
    ownedSkeletons.push(skeleton);
  });

  if (meshes.length === 0) {
    throw new Error('Outfit has no skinned meshes to attach');
  }
  if (missingBones.size > 0) {
    const boneTotal = meshes[0]?.skeleton?.bones?.length ?? missingBones.size;
    if (missingBones.size > boneTotal * 0.35) {
      throw new Error(
        `Outfit skeleton is missing Sim bones: ${[...missingBones].slice(0, 8).join(', ')}`,
      );
    }
    console.warn(
      `[attachSimOutfit] ${missingBones.size} outfit bone(s) not on body (using source):`,
      [...missingBones].slice(0, 6).join(', '),
    );
  }

  group.position.copy(actor.model.object.position);
  group.quaternion.copy(actor.model.object.quaternion);
  group.scale.copy(actor.model.object.scale);
  actor.group.add(group);
  scene?.updateMatrixWorld?.(true);

  // Remove body triangles under the outfit. Head/neck remain; the recessed
  // skin companion continuously fills whatever the garment leaves open; limb
  // ownership is shared by the reveal sliders and their inverse garment cut.
  let lastLimbReveal = sanitizeOutfitLimbReveal(actor.preset?.outfitLimbReveal);
  const limbCuts = installOutfitLimbCuts(meshes, lastLimbReveal);
  let lastLoopCuts = sanitizeOutfitLoopCuts(actor.preset?.outfitLoopCuts);
  let lastSkinTuck = sanitizeOutfitSkinTuck(actor.preset?.outfitSkinTuck);
  const loopCuts = installOutfitLoopCuts(meshes, lastLoopCuts);
  fitUniforms.setLimbReveal(lastLimbReveal);
  let bodyHide = installBodyHideUnderOutfit(actor.model, {
    limbReveal: lastLimbReveal,
    loopCuts: lastLoopCuts,
    skinTuck: lastSkinTuck,
  });
  if (!bodyHide) {
    console.warn('[attachSimOutfit] body hide under outfit did not apply — chest may show through');
  }
  for (const mesh of meshes) mesh.renderOrder = 1;

  const projectedTargetCount = morphMeshes.reduce(
    (sum, mesh) => sum + Object.keys(mesh.morphTargetDictionary).filter(isOutfitProjectedMorphTarget).length,
    0,
  );
  const hasProjectedMorphs = projectedTargetCount > 0;

  let lastFit = computeOutfitFitFromMorphs(actor.preset?.morphs);
  let lastMode = hasProjectedMorphs ? 'projected-morph' : 'normal-push';
  let lastOutfitScale = sanitizeOutfitScale(actor.preset?.outfitScale);
  let lastOutfitPosition = sanitizeOutfitPosition(actor.preset?.outfitPosition);

  const applyOutfitScale = (appearance) => {
    lastOutfitScale = sanitizeOutfitScale(
      appearance?.outfitScale ?? actor.preset?.outfitScale,
    );
    const auto = lastOutfitScale.x === 1 && lastOutfitScale.y === 1 && lastOutfitScale.z === 1;

    // Morph-enabled assets already expand via shape keys. Extra auto-scale
    // shears multi-mesh seams — only apply user-set scale (or identity).
    if (hasProjectedMorphs) {
      fitUniforms.setFitScale(auto ? { x: 1, y: 1, z: 1 } : lastOutfitScale);
      return;
    }

    // Standard (no morphs): mild cylindrical bulk from body sliders.
    if (auto) {
      const radial = 1.02
        + Math.max(0, lastFit.mass) * 0.035
        + lastFit.fat * 0.04
        + Math.max(0, lastFit.muscle) * 0.018;
      fitUniforms.setFitScale({ x: radial, y: 1, z: radial });
    } else {
      fitUniforms.setFitScale(lastOutfitScale);
    }
  };

  const applyAppearance = (appearance) => {
    const sliderMorphs = appearance?.morphs ?? actor.preset?.morphs ?? {};
    lastFit = computeOutfitFitFromMorphs(sliderMorphs);
    applyOutfitScale(appearance);
    lastOutfitPosition = sanitizeOutfitPosition(
      appearance?.outfitPosition ?? actor.preset?.outfitPosition,
    );
    fitUniforms.setFitPosition(lastOutfitPosition);

    // Live limb sliders rebuild paired body/outfit index wrappers.
    const limbReveal = sanitizeOutfitLimbReveal(
      appearance?.outfitLimbReveal ?? actor.preset?.outfitLimbReveal,
    );
    const limbsChanged = ['arms', 'legs', 'feet'].some(
      (key) => limbReveal[key] !== lastLimbReveal[key],
    );
    const nextLoopCuts = sanitizeOutfitLoopCuts(
      appearance?.outfitLoopCuts ?? actor.preset?.outfitLoopCuts,
    );
    const loopsChanged = JSON.stringify(nextLoopCuts) !== JSON.stringify(lastLoopCuts);
    lastSkinTuck = sanitizeOutfitSkinTuck(
      appearance?.outfitSkinTuck ?? actor.preset?.outfitSkinTuck,
    );
    fitUniforms.setLimbReveal(limbReveal);
    if (limbsChanged || loopsChanged) {
      lastLimbReveal = limbReveal;
      lastLoopCuts = nextLoopCuts;
      bodyHide?.dispose();
      bodyHide = installBodyHideUnderOutfit(actor.model, {
        limbReveal,
        loopCuts: lastLoopCuts,
        skinTuck: lastSkinTuck,
      });
      limbCuts?.setReveal(limbReveal);
      loopCuts?.setCuts(lastLoopCuts);
    }
    // Uniform-only update: live slider dragging does not rebuild geometry.
    bodyHide?.setSkinTuck(lastSkinTuck);

    if (hasProjectedMorphs) {
      const influences = buildModelingMorphs(sliderMorphs);
      for (const mesh of morphMeshes) {
        for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
          if (!isOutfitProjectedMorphTarget(name)) {
            mesh.morphTargetInfluences[index] = 0;
            continue;
          }
          const w = (influences[name] ?? 0) * PROJECTED_MORPH_GAIN;
          mesh.morphTargetInfluences[index] = Math.min(1, Math.max(0, w));
        }
      }
      // Tiny radial ease only — morphs own bulk. Large residual push opened seams.
      const residualLocal = 0.004
        + Math.max(0, lastFit.mass) * 0.006
        + lastFit.fat * 0.008
        + Math.max(0, lastFit.muscle) * 0.004;
      fitUniforms.setPush(residualLocal);
      lastMode = 'projected-morph';
      return;
    }

    // Standard variant: radial ease carries bulk (no shape keys).
    const residualLocal = 0.014
      + Math.max(0, lastFit.mass) * 0.02
      + lastFit.fat * 0.025
      + Math.max(0, lastFit.muscle) * 0.01;
    fitUniforms.setPush(residualLocal);
    lastMode = 'radial-push';
  };

  applyAppearance(actor.preset);

  return {
    id: outfitId,
    name: asset.name,
    body: asset.body,
    variant: asset.variant,
    url: asset.url,
    group,
    meshes,
    morphMeshes,
    suggestedLimbReveal: limbCuts?.suggestedReveal ?? null,
    applyAppearance,
    snapshot() {
      group.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(group);
      return {
        id: outfitId,
        body: asset.body,
        variant: asset.variant,
        meshes: meshes.length,
        morphMeshes: morphMeshes.length,
        projectedTargets: projectedTargetCount,
        bodyHideMeshes: bodyHide?.meshCount ?? 0,
        bodyVisibleTriangles: bodyHide?.keptTriangleCount ?? 0,
        recessedSkinMeshes: bodyHide?.recessedMeshCount ?? 0,
        outfitSourceTriangles: limbCuts?.sourceTriangles ?? 0,
        outfitVisibleTriangles: limbCuts?.visibleTriangles ?? 0,
        outfitLoopVisibleTriangles: loopCuts?.visibleTriangles ?? 0,
        outfitLoopCuts: lastLoopCuts.map((cut) => ({ ...cut, points: cut.points.map((point) => [...point]) })),
        outfitLimbCoverage: limbCuts?.coverageRatios ?? null,
        suggestedLimbReveal: limbCuts?.suggestedReveal ?? null,
        visible: group.visible,
        fit: {
          pushLocal: fitUniforms.pushUniform.value,
          selectedMorphs: selectOutfitMorphs(lastFit.selected),
          regionScales: computeOutfitRegionScales(lastFit),
          outfitScale: { ...lastOutfitScale },
          outfitPosition: { ...lastOutfitPosition },
          outfitSkinTuck: { ...lastSkinTuck },
          outfitLimbReveal: { ...lastLimbReveal },
          shaderScale: fitUniforms.fitScaleUniform.value.toArray(),
          shaderPosition: fitUniforms.fitPositionUniform.value.toArray(),
          mode: lastMode,
        },
        bounds: bounds.isEmpty() ? null : {
          min: bounds.min.toArray(),
          max: bounds.max.toArray(),
          height: bounds.max.y - bounds.min.y,
        },
      };
    },
    dispose() {
      bodyHide?.dispose();
      loopCuts?.dispose();
      limbCuts?.dispose();
      group.removeFromParent();
      for (const skeleton of ownedSkeletons) skeleton.dispose();
      for (const material of ownedMaterials) {
        material.map = null;
        material.normalMap = null;
        material.roughnessMap = null;
        material.metalnessMap = null;
        material.aoMap = null;
        material.emissiveMap = null;
        material.dispose?.();
      }
    },
  };
}

export async function attachPresetOutfit({ actor, scene }) {
  if (!actor.preset.outfitId) return null;
  try {
    return await attachSimOutfit({ actor, outfitId: actor.preset.outfitId, scene });
  } catch (error) {
    console.warn(`[sims] failed to attach outfit ${actor.preset.outfitId} to ${actor.id}`, error);
    return null;
  }
}

async function loadOutfitTemplate(url) {
  if (!templatePromises.has(url)) {
    const promise = createGltfLoader().loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      flattenObjectForWebGPU(root);
      root.traverse((node) => {
        if (!node.isMesh) return;
        // Ensure skin attrs are clean after Draco/glTF decode (WebGPU is picky).
        if (node.isSkinnedMesh && node.geometry) {
          flattenObjectForWebGPU(node);
          node.normalizeSkinWeights?.();
          node.geometry.computeVertexNormals?.();
        }
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!material) continue;
          material.side = THREE.DoubleSide;
          if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
          material.needsUpdate = true;
        }
      });
      return root;
    }).catch((error) => {
      // Drop failed loads so the next click can retry instead of replaying the rejection.
      templatePromises.delete(url);
      throw error;
    });
    templatePromises.set(url, promise);
  }
  return templatePromises.get(url);
}

/** Drop cached templates (call after re-baking the same outfit id). */
export function clearOutfitTemplateCache() {
  templatePromises.clear();
}
