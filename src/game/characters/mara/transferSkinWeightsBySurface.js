import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const point = new THREE.Vector3();
const closestPoint = new THREE.Vector3();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const barycentric = new THREE.Vector3();

export function transferSkinWeightsBySurface({
  sourceGeometry,
  targetGeometry,
  targetToSource = new THREE.Matrix4(),
}) {
  const sourcePosition = sourceGeometry?.getAttribute('position');
  const sourceSkinIndex = sourceGeometry?.getAttribute('skinIndex');
  const sourceSkinWeight = sourceGeometry?.getAttribute('skinWeight');
  const targetPosition = targetGeometry?.getAttribute('position');
  if (!sourcePosition || !sourceSkinIndex || !sourceSkinWeight || !targetPosition) {
    throw new Error('Surface weight transfer requires position, skinIndex, and skinWeight attributes.');
  }

  const searchGeometry = new THREE.BufferGeometry();
  searchGeometry.setAttribute('position', sourcePosition);
  searchGeometry.setIndex(sourceGeometry.index?.clone() ?? sequentialIndex(sourcePosition.count));
  const bvh = new MeshBVH(searchGeometry, { indirect: true });
  const searchIndex = searchGeometry.index;
  const transferredIndices = new Uint16Array(targetPosition.count * 4);
  const transferredWeights = new Float32Array(targetPosition.count * 4);
  const distances = new Float32Array(targetPosition.count);

  for (let vertex = 0; vertex < targetPosition.count; vertex += 1) {
    point.fromBufferAttribute(targetPosition, vertex).applyMatrix4(targetToSource);
    const hit = bvh.closestPointToPoint(point, { point: closestPoint });
    if (!hit || hit.faceIndex == null) continue;

    const triangleOffset = hit.faceIndex * 3;
    const ia = searchIndex.getX(triangleOffset);
    const ib = searchIndex.getX(triangleOffset + 1);
    const ic = searchIndex.getX(triangleOffset + 2);
    a.fromBufferAttribute(sourcePosition, ia);
    b.fromBufferAttribute(sourcePosition, ib);
    c.fromBufferAttribute(sourcePosition, ic);
    THREE.Triangle.getBarycoord(closestPoint, a, b, c, barycentric);
    distances[vertex] = hit.distance;

    const influences = new Map();
    addVertexInfluences(influences, sourceSkinIndex, sourceSkinWeight, ia, barycentric.x);
    addVertexInfluences(influences, sourceSkinIndex, sourceSkinWeight, ib, barycentric.y);
    addVertexInfluences(influences, sourceSkinIndex, sourceSkinWeight, ic, barycentric.z);
    const strongest = [...influences.entries()]
      .filter(([, weight]) => weight > 1e-6)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4);
    const total = strongest.reduce((sum, [, weight]) => sum + weight, 0) || 1;

    for (let influence = 0; influence < strongest.length; influence += 1) {
      transferredIndices[vertex * 4 + influence] = strongest[influence][0];
      transferredWeights[vertex * 4 + influence] = strongest[influence][1] / total;
    }
  }

  targetGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(transferredIndices, 4));
  targetGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(transferredWeights, 4));
  targetGeometry.setAttribute('skinTransferDistance', new THREE.Float32BufferAttribute(distances, 1));
  searchGeometry.dispose();

  return summarizeDistances(distances);
}

function addVertexInfluences(target, indices, weights, vertex, barycentricWeight) {
  for (let component = 0; component < Math.min(4, indices.itemSize); component += 1) {
    const boneIndex = indices.getComponent(vertex, component);
    const weight = weights.getComponent(vertex, component) * barycentricWeight;
    if (weight > 0) target.set(boneIndex, (target.get(boneIndex) ?? 0) + weight);
  }
}

function sequentialIndex(count) {
  const ArrayType = count > 65535 ? Uint32Array : Uint16Array;
  return new THREE.BufferAttribute(ArrayType.from({ length: count }, (_, index) => index), 1);
}

function summarizeDistances(values) {
  const sorted = Array.from(values).sort((left, right) => left - right);
  const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
  return {
    vertices: values.length,
    medianDistance: percentile(0.5),
    p95Distance: percentile(0.95),
    maxDistance: sorted.at(-1) ?? 0,
  };
}

