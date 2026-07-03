import * as THREE from 'three';

const tempPosition = new THREE.Vector3();
const tempBox = new THREE.Box3();
const tempSize = new THREE.Vector3();

export function bakeSkinnedModelGeometry(root) {
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
