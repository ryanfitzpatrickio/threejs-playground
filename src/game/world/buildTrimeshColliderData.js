import * as THREE from 'three';

const WALKABLE_FEATURE_NORMAL_Y = 0.34;
const ROOF_WALKABLE_NORMAL_Y = 0.85;

function setPointFromVertexArray(target, vertices, index) {
  const offset = index * 3;
  target.set(vertices[offset], vertices[offset + 1], vertices[offset + 2]);
  return target;
}

export function buildTrimeshColliderData(mesh) {
  const geometry = mesh?.geometry;
  const position = geometry?.attributes?.position;

  if (!position || position.count < 3) {
    return null;
  }

  mesh.updateMatrixWorld(true);

  const source = position.array;
  const vertices = new Float32Array(position.count * 3);
  const point = new THREE.Vector3();

  for (let index = 0; index < position.count; index += 1) {
    const offset = index * 3;
    point
      .set(source[offset], source[offset + 1], source[offset + 2])
      .applyMatrix4(mesh.matrixWorld);
    vertices[offset] = point.x;
    vertices[offset + 1] = point.y;
    vertices[offset + 2] = point.z;
  }

  const sourceIndex = geometry.index?.array;
  const triangleCount = sourceIndex ? Math.floor(sourceIndex.length / 3) : Math.floor(position.count / 3);
  const traversalIndices = new Uint32Array(triangleCount * 3);
  const filtered = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const ia = sourceIndex ? sourceIndex[triangle * 3] : triangle * 3;
    const ib = sourceIndex ? sourceIndex[triangle * 3 + 1] : triangle * 3 + 1;
    const ic = sourceIndex ? sourceIndex[triangle * 3 + 2] : triangle * 3 + 2;
    traversalIndices[triangle * 3] = ia;
    traversalIndices[triangle * 3 + 1] = ib;
    traversalIndices[triangle * 3 + 2] = ic;

    setPointFromVertexArray(a, vertices, ia);
    setPointFromVertexArray(b, vertices, ib);
    setPointFromVertexArray(c, vertices, ic);
    normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();

    const isWall = normal.y <= WALKABLE_FEATURE_NORMAL_Y;
    const isWalkableRoof = normal.y >= ROOF_WALKABLE_NORMAL_Y;

    if (!isWall && !isWalkableRoof) {
      continue;
    }

    filtered.push(ia, ib, ic);
  }

  if (filtered.length < 3) {
    return null;
  }

  return {
    vertices,
    indices: new Uint32Array(filtered),
    traversalIndices,
  };
}
