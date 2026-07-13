import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const tempPosition = new THREE.Vector3();
const tempBox = new THREE.Box3();
const tempSize = new THREE.Vector3();

/**
 * Bake a posed skinned model into a static BufferGeometry.
 *
 * @param {THREE.Object3D} root
 * @param {{ topology?: 'expanded' | 'indexed' }} [options]
 *   - `expanded` (default): one vertex per triangle corner. Required for CSG/cut paths.
 *   - `indexed`: preserve unique verts + index buffer. Use for crowd/proxy instancing so
 *     a 13k-vert proxy mesh does not inflate to ~35k after de-index.
 */
export function bakeSkinnedModelGeometry(root, options = {}) {
  const topology = options.topology === 'indexed' ? 'indexed' : 'expanded';
  if (topology === 'indexed') {
    return bakeSkinnedModelGeometryIndexed(root);
  }
  return bakeSkinnedModelGeometryExpanded(root);
}

function bakeSkinnedModelGeometryExpanded(root) {
  root.updateMatrixWorld(true);

  const positions = [];
  const uvs = [];
  const skinIndices = [];
  const skinWeights = [];
  let meshCount = 0;
  let skinnedMeshCount = 0;
  let material = null;
  let hasSkinAttributes = false;
  let boneNames = [];

  root.traverse((child) => {
    if ((!child.isMesh && !child.isSkinnedMesh) || !child.geometry) {
      return;
    }

    const geometry = child.geometry;
    const positionAttribute = geometry.getAttribute('position');
    const uvAttribute = geometry.getAttribute('uv');
    const skinIndexAttribute = geometry.getAttribute('skinIndex');
    const skinWeightAttribute = geometry.getAttribute('skinWeight');
    const indexAttribute = geometry.index;

    if (!positionAttribute) {
      return;
    }

    meshCount += 1;
    material ??= getPrimaryMaterial(child.material);

    if (child.isSkinnedMesh) {
      skinnedMeshCount += 1;
      child.skeleton?.update?.();
      if (child.skeleton?.bones?.length && boneNames.length === 0) {
        boneNames = child.skeleton.bones.map((bone) => bone.name);
      }
    }

    const drawCount = indexAttribute ? indexAttribute.count : positionAttribute.count;
    const triangleCount = Math.floor(drawCount / 3) * 3;

    for (let drawIndex = 0; drawIndex < triangleCount; drawIndex += 1) {
      const vertexIndex = indexAttribute
        ? indexAttribute.getX(drawIndex)
        : drawIndex;

      tempPosition.fromBufferAttribute(positionAttribute, vertexIndex);

      if (child.isSkinnedMesh && typeof child.applyBoneTransform === 'function') {
        child.applyBoneTransform(vertexIndex, tempPosition);
      }

      tempPosition.applyMatrix4(child.matrixWorld);
      positions.push(tempPosition.x, tempPosition.y, tempPosition.z);

      if (uvAttribute) {
        uvs.push(uvAttribute.getX(vertexIndex), uvAttribute.getY(vertexIndex));
      } else {
        uvs.push(0, 0);
      }

      if (skinIndexAttribute && skinWeightAttribute) {
        hasSkinAttributes = true;
        skinIndices.push(
          skinIndexAttribute.getX(vertexIndex),
          skinIndexAttribute.getY(vertexIndex),
          skinIndexAttribute.getZ(vertexIndex),
          skinIndexAttribute.getW(vertexIndex),
        );
        skinWeights.push(
          skinWeightAttribute.getX(vertexIndex),
          skinWeightAttribute.getY(vertexIndex),
          skinWeightAttribute.getZ(vertexIndex),
          skinWeightAttribute.getW(vertexIndex),
        );
      } else {
        skinIndices.push(0, 0, 0, 0);
        skinWeights.push(1, 0, 0, 0);
      }
    }
  });

  if (positions.length < 9) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (hasSkinAttributes) {
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    meshCount,
    skinnedMeshCount,
    vertexCount: geometry.getAttribute('position').count,
    bounds: getBoundsSnapshot(geometry),
    material,
    hasTexture: Boolean(material?.map),
    boneNames,
  };
}

/**
 * Indexed bake: one transformed position per unique vertex, index buffer retained.
 * Keeps GPU vertex cost at the source mesh density for InstancedMesh proxies.
 */
function bakeSkinnedModelGeometryIndexed(root) {
  root.updateMatrixWorld(true);

  const parts = [];
  let meshCount = 0;
  let skinnedMeshCount = 0;
  let material = null;
  let boneNames = [];

  root.traverse((child) => {
    if ((!child.isMesh && !child.isSkinnedMesh) || !child.geometry) {
      return;
    }

    const geometry = child.geometry;
    const positionAttribute = geometry.getAttribute('position');
    const uvAttribute = geometry.getAttribute('uv');
    const indexAttribute = geometry.index;
    if (!positionAttribute) return;

    meshCount += 1;
    material ??= getPrimaryMaterial(child.material);

    if (child.isSkinnedMesh) {
      skinnedMeshCount += 1;
      child.skeleton?.update?.();
      if (child.skeleton?.bones?.length && boneNames.length === 0) {
        boneNames = child.skeleton.bones.map((bone) => bone.name);
      }
    }

    const vertexCount = positionAttribute.count;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);

    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      tempPosition.fromBufferAttribute(positionAttribute, vertexIndex);
      if (child.isSkinnedMesh && typeof child.applyBoneTransform === 'function') {
        child.applyBoneTransform(vertexIndex, tempPosition);
      }
      tempPosition.applyMatrix4(child.matrixWorld);
      positions[vertexIndex * 3] = tempPosition.x;
      positions[vertexIndex * 3 + 1] = tempPosition.y;
      positions[vertexIndex * 3 + 2] = tempPosition.z;
      if (uvAttribute) {
        uvs[vertexIndex * 2] = uvAttribute.getX(vertexIndex);
        uvs[vertexIndex * 2 + 1] = uvAttribute.getY(vertexIndex);
      }
    }

    const part = new THREE.BufferGeometry();
    part.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    part.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (indexAttribute) {
      // Clone so the source mesh can be disposed without invalidating the pose.
      const src = indexAttribute.array;
      const IndexArray = src.constructor;
      part.setIndex(new THREE.BufferAttribute(new IndexArray(src), 1));
    }
    part.computeVertexNormals();
    parts.push(part);
  });

  if (parts.length === 0) return null;

  let geometry;
  if (parts.length === 1) {
    geometry = parts[0];
  } else {
    geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!geometry) return null;
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    meshCount,
    skinnedMeshCount,
    vertexCount: geometry.getAttribute('position').count,
    bounds: getBoundsSnapshot(geometry),
    material,
    hasTexture: Boolean(material?.map),
    boneNames,
  };
}

function getPrimaryMaterial(material) {
  if (Array.isArray(material)) {
    return material.find(Boolean) ?? null;
  }

  return material ?? null;
}

function getBoundsSnapshot(geometry) {
  tempBox.copy(geometry.boundingBox);
  tempBox.getSize(tempSize);

  return {
    x: Number(tempSize.x.toFixed(3)),
    y: Number(tempSize.y.toFixed(3)),
    z: Number(tempSize.z.toFixed(3)),
  };
}
