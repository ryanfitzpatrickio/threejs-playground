/**
 * Outfit fit materials: bind-pose XYZ scale/position + radial ease.
 *
 * Skinned outfits share the body skeleton in AttachedBindMode. Parent/group
 * scale is cancelled every frame via bindMatrixInverse — so fit scale MUST be
 * applied in the vertex shader on positionLocal (before skinning).
 *
 * Multi-mesh Quaternius outfits (arms / torso / legs) tear at seams if we push
 * along geometric normals — neighboring verts on different meshes leave along
 * different directions. Expand around the body Y-axis (radial XZ) instead so
 * every piece shares the same expansion field and seams stay closed.
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  float,
  Fn,
  length,
  max,
  positionLocal,
  select,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import { LIMB_CUT_ATTRIBUTE } from './outfitLimbVisibility.js';

/**
 * Shared uniforms for every mesh of one outfit instance.
 * @returns {{
 *   pushUniform: object,
 *   fitScaleUniform: object,
 *   fitPositionUniform: object,
 *   setPush(meters: number): void,
 *   setFitScale(scale: {x:number,y:number,z:number}): void,
 *   setFitPosition(position: {x:number,y:number,z:number}): void,
 * }}
 */
export function createOutfitFitUniforms() {
  const pushUniform = uniform(0);
  const fitScaleUniform = uniform(new THREE.Vector3(1, 1, 1));
  const fitPositionUniform = uniform(new THREE.Vector3(0, 0, 0));
  const limbRevealUniforms = {
    arms: uniform(0),
    legs: uniform(0),
    feet: uniform(0),
  };
  return {
    pushUniform,
    fitScaleUniform,
    fitPositionUniform,
    limbRevealUniforms,
    setPush(meters) {
      pushUniform.value = Number.isFinite(meters) ? meters : 0;
    },
    setFitScale(scale) {
      const x = Number(scale?.x);
      const y = Number(scale?.y);
      const z = Number(scale?.z);
      // Keep X/Z equal so bulk is a circular cylinder (avoids seam shear).
      const sx = Number.isFinite(x) ? x : 1;
      const sy = Number.isFinite(y) ? y : 1;
      const sz = Number.isFinite(z) ? z : 1;
      const radial = (sx + sz) * 0.5;
      fitScaleUniform.value.set(radial, sy, radial);
    },
    setFitPosition(position) {
      const x = Number(position?.x);
      const y = Number(position?.y);
      const z = Number(position?.z);
      fitPositionUniform.value.set(
        Number.isFinite(x) ? x : 0,
        Number.isFinite(y) ? y : 0,
        Number.isFinite(z) ? z : 0,
      );
    },
    setLimbReveal(reveal) {
      for (const key of ['arms', 'legs', 'feet']) {
        const value = Number(reveal?.[key]);
        const maxReveal = key === 'arms' ? 2 : 1;
        limbRevealUniforms[key].value = Number.isFinite(value)
          ? Math.min(maxReveal, Math.max(0, value))
          : 0;
      }
    },
  };
}

/** @deprecated use createOutfitFitUniforms */
export function createSharedOutfitPushUniform(initialPush = 0) {
  const u = uniform(initialPush);
  u.value = initialPush;
  return u;
}

/**
 * Bind-pose fit:
 *  1) uniform XZ + Y scale about the shared armature origin
 *  2) pure radial push in the XZ plane (identical field on every outfit piece)
 *  3) shared XYZ position offset for every baked outfit piece
 *
 * No geometric-normal component — multi-mesh seams (torso/arms/legs) reopen when
 * neighboring verts leave along different face normals.
 *
 * Skinning runs after positionNode.
 */
export function outfitFitPositionNode(
  fitScaleUniform,
  pushUniform,
  fitPositionUniform = vec3(0, 0, 0),
) {
  return Fn(() => {
    const p = positionLocal.mul(fitScaleUniform);
    // Horizontal offset from the vertical body axis (shared across all pieces).
    const horiz = vec3(p.x, float(0), p.z);
    const horizLen = length(horiz);
    const radialDir = horiz.div(max(horizLen, float(1e-4)));
    // Position is last so it stays a rigid shared offset and cannot alter the
    // automatic radial ease direction.
    return p.add(radialDir.mul(pushUniform)).add(fitPositionUniform);
  })();
}

/** Fragment-precise garment cut. Attributes interpolate across triangles. */
export function outfitLimbMaskNode(limbRevealUniforms) {
  const cutCoordinate = attribute(LIMB_CUT_ATTRIBUTE, 'vec3');
  const components = [cutCoordinate.x, cutCoordinate.y, cutCoordinate.z];
  const cuts = ['arms', 'legs', 'feet'].map((key, index) => {
    const reveal = limbRevealUniforms[key];
    return reveal.greaterThan(0)
      .and(components[index].lessThanEqual(reveal));
  });
  return cuts[0].or(cuts[1]).or(cuts[2]).not();
}

/**
 * Soft coverage counterpart to the hard limb mask. Alpha-to-coverage turns
 * this narrow coordinate band into a stable antialiased sleeve/hem edge while
 * the recessed body underlay prevents dark gaps behind it.
 */
export function outfitLimbCoverageNode(limbRevealUniforms) {
  const cutCoordinate = attribute(LIMB_CUT_ATTRIBUTE, 'vec3');
  const components = [cutCoordinate.x, cutCoordinate.y, cutCoordinate.z];
  const feather = float(0.018);
  let coverage = float(1);
  for (const [index, key] of ['arms', 'legs', 'feet'].entries()) {
    const reveal = limbRevealUniforms[key];
    const edgeCoverage = smoothstep(
      reveal.sub(feather),
      reveal.add(feather),
      components[index],
    );
    coverage = coverage.mul(select(reveal.greaterThan(0), edgeCoverage, float(1)));
  }
  return coverage;
}

/**
 * Replace mesh materials with fit-capable node materials.
 * @returns {import('three/webgpu').MeshStandardNodeMaterial[]}
 */
export function installOutfitInflateOnMesh(mesh, fitUniforms) {
  if (!mesh?.isMesh) return [];
  const pushUniform = fitUniforms.pushUniform ?? fitUniforms;
  const fitScaleUniform = fitUniforms.fitScaleUniform
    ?? uniform(new THREE.Vector3(1, 1, 1));
  const fitPositionUniform = fitUniforms.fitPositionUniform
    ?? uniform(new THREE.Vector3(0, 0, 0));
  const limbRevealUniforms = fitUniforms.limbRevealUniforms;

  const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const created = [];
  const next = sources.map((src) => {
    if (!src) return src;
    if (
      src.userData?.outfitInflate
      && src.userData.outfitPushUniform === pushUniform
      && src.userData.outfitFitScaleUniform === fitScaleUniform
      && src.userData.outfitFitPositionUniform === fitPositionUniform
    ) {
      // Refresh position node graph (HMR / reinstall).
      src.positionNode = outfitFitPositionNode(
        fitScaleUniform,
        pushUniform,
        fitPositionUniform,
      );
      if (limbRevealUniforms) {
        src.maskNode = null;
        // WebGPU's shadow override does not inherit opacityNode/alphaTestNode.
        // Give it the same hard limb discard explicitly so visually removed
        // clothing cannot continue casting onto the restored body beneath it.
        src.maskShadowNode = outfitLimbMaskNode(limbRevealUniforms);
        src.opacityNode = outfitLimbCoverageNode(limbRevealUniforms);
        src.alphaTestNode = float(0.5);
        src.alphaToCoverage = true;
      }
      src.needsUpdate = true;
      return src;
    }
    const material = new MeshStandardNodeMaterial();
    copyStandardMaps(src, material);
    material.positionNode = outfitFitPositionNode(
      fitScaleUniform,
      pushUniform,
      fitPositionUniform,
    );
    if (limbRevealUniforms) {
      material.maskShadowNode = outfitLimbMaskNode(limbRevealUniforms);
      material.opacityNode = outfitLimbCoverageNode(limbRevealUniforms);
      material.alphaTestNode = float(0.5);
      material.alphaToCoverage = true;
    }
    // Double-sided: collar/sleeve/hem openings show the fabric interior
    // (lining) instead of culling to a see-through hole.
    material.side = THREE.DoubleSide;
    material.userData.outfitInflate = true;
    material.userData.outfitPushUniform = pushUniform;
    material.userData.outfitFitScaleUniform = fitScaleUniform;
    material.userData.outfitFitPositionUniform = fitPositionUniform;
    material.needsUpdate = true;
    created.push(material);
    return material;
  });
  mesh.material = Array.isArray(mesh.material) ? next : next[0];
  return created;
}

export function copyStandardMaps(source, target) {
  if (!source || !target) return;
  if (source.color?.isColor) target.color.copy(source.color);
  target.map = source.map ?? null;
  target.normalMap = source.normalMap ?? null;
  target.roughnessMap = source.roughnessMap ?? null;
  target.metalnessMap = source.metalnessMap ?? null;
  target.aoMap = source.aoMap ?? null;
  target.emissiveMap = source.emissiveMap ?? null;
  if (source.emissive?.isColor) target.emissive.copy(source.emissive);
  target.emissiveIntensity = source.emissiveIntensity ?? target.emissiveIntensity;
  target.roughness = source.roughness ?? 0.85;
  target.metalness = source.metalness ?? 0.02;
  target.side = THREE.DoubleSide;
  target.transparent = Boolean(source.transparent);
  target.opacity = source.opacity ?? 1;
  target.alphaTest = source.alphaTest ?? 0;
  target.depthWrite = source.depthWrite ?? true;
  target.depthTest = source.depthTest ?? true;
  target.flatShading = Boolean(source.flatShading);
  if (source.normalScale?.isVector2) target.normalScale.copy(source.normalScale);
  if (target.map) target.map.colorSpace = THREE.SRGBColorSpace;
}
