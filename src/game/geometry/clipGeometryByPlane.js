import * as THREE from 'three';

const DEFAULT_CLIP_EPSILON = 0.00001;
const DEFAULT_CUT_TEST_EPSILON = 0.012;
const DEFAULT_CAP_DEDUPE_PRECISION = 4;
const DEFAULT_MIN_VERTEX_COUNT = 18;
const DEFAULT_MIN_DIMENSION = 0.085;

const inverseMatrix = new THREE.Matrix4();
const normalMatrix = new THREE.Matrix3();
const tempVertex = new THREE.Vector3();
const tempGeometrySize = new THREE.Vector3();

export function getPlaneInObjectSpace(plane, object) {
  object.updateMatrixWorld(true);
  inverseMatrix.copy(object.matrixWorld).invert();
  normalMatrix.getNormalMatrix(inverseMatrix);
  return plane.clone().applyMatrix4(inverseMatrix, normalMatrix);
}

export function clipGeometryPairByPlane(sourceGeometry, plane, options = {}) {
  const positive = clipGeometryByPlane(sourceGeometry, plane, 1, options);
  const negative = clipGeometryByPlane(sourceGeometry, plane, -1, options);

  if (!positive && !negative) {
    positive?.dispose();
    negative?.dispose();
    return null;
  }

  return { positive, negative };
}

export function clipGeometryByPlane(sourceGeometry, plane, sideSign, options = {}) {
  if (sideSign !== 1 && sideSign !== -1) {
    throw new Error(`clipGeometryByPlane sideSign must be 1 or -1, got ${sideSign}`);
  }

  const source = sourceGeometry.index ? sourceGeometry.toNonIndexed() : sourceGeometry.clone();

  if (!source.getAttribute('normal')) {
    source.computeVertexNormals();
  }

  const positionAttribute = source.getAttribute('position');
  const normalAttribute = source.getAttribute('normal');
  const uvAttribute = source.getAttribute('uv');
  const skinIndexAttribute = source.getAttribute('skinIndex');
  const skinWeightAttribute = source.getAttribute('skinWeight');
  // Optional per-vertex "test" position (e.g. the skinned/posed world position)
  // used for the inside/outside decision while the geometry itself stays in bind
  // space. The `plane` must be expressed in the same space as these positions.
  const testAttribute = options.testPositionsAttribute
    ? source.getAttribute(options.testPositionsAttribute)
    : null;
  const originalVertices = [];
  const capSegments = [];
  const clipEpsilon = options.clipEpsilon ?? DEFAULT_CLIP_EPSILON;
  const includeCap = options.includeCap ?? true;

  if (!positionAttribute || positionAttribute.count < 3) {
    source.dispose();
    return null;
  }

  for (let index = 0; index < positionAttribute.count; index += 3) {
    const triangle = [0, 1, 2].map((offset) => createVertexFromAttributes({
      index: index + offset,
      positionAttribute,
      normalAttribute,
      uvAttribute,
      skinIndexAttribute,
      skinWeightAttribute,
      testAttribute,
    }));
    const intersections = [];
    const clipped = clipPolygon(triangle, plane, sideSign, intersections, clipEpsilon);

    if (clipped.length < 3) {
      continue;
    }

    for (let pointIndex = 1; pointIndex < clipped.length - 1; pointIndex += 1) {
      pushVertex(originalVertices, clipped[0]);
      pushVertex(originalVertices, clipped[pointIndex]);
      pushVertex(originalVertices, clipped[pointIndex + 1]);
    }

    if (intersections.length === 2) {
      capSegments.push(intersections.map((vertex) => cloneVertex(vertex)));
    }
  }

  const capVertices = includeCap
    ? createCapVertices(capSegments, plane, sideSign, options)
    : [];

  if (!originalVertices.length) {
    source.dispose();
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  const positions = [
    ...originalVertices.flatMap((vertex) => vertex.position),
    ...capVertices.flatMap((vertex) => vertex.position),
  ];
  const normals = [
    ...originalVertices.flatMap((vertex) => vertex.normal),
    ...capVertices.flatMap((vertex) => vertex.normal),
  ];
  const uvs = [
    ...originalVertices.flatMap((vertex) => vertex.uv),
    ...capVertices.flatMap((vertex) => vertex.uv),
  ];
  const skinIndices = skinIndexAttribute
    ? [
      ...originalVertices.flatMap((vertex) => vertex.skinIndex),
      ...capVertices.flatMap((vertex) => vertex.skinIndex ?? [0, 0, 0, 0]),
    ]
    : null;
  const skinWeights = skinWeightAttribute
    ? [
      ...originalVertices.flatMap((vertex) => vertex.skinWeight),
      ...capVertices.flatMap((vertex) => vertex.skinWeight ?? [1, 0, 0, 0]),
    ]
    : null;

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (skinIndices) {
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  }
  if (skinWeights) {
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  }
  geometry.addGroup(0, originalVertices.length, 0);
  if (capVertices.length) {
    geometry.addGroup(originalVertices.length, capVertices.length, 1);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  source.dispose();

  return geometry;
}

export function planeCutsGeometry(geometry, plane, options = {}) {
  const positionAttribute = geometry.getAttribute('position');
  const epsilon = options.cutTestEpsilon ?? DEFAULT_CUT_TEST_EPSILON;

  if (!positionAttribute) {
    return false;
  }

  let positive = false;
  let negative = false;

  for (let index = 0; index < positionAttribute.count; index += 1) {
    const distance = plane.distanceToPoint(
      tempVertex.set(
        positionAttribute.getX(index),
        positionAttribute.getY(index),
        positionAttribute.getZ(index),
      ),
    );

    if (distance > epsilon) {
      positive = true;
    }

    if (distance < -epsilon) {
      negative = true;
    }

    if (positive && negative) {
      return true;
    }
  }

  return false;
}

export function isViableCutGeometry(geometry, options = {}) {
  const positionAttribute = geometry.getAttribute('position');
  const minVertexCount = options.minVertexCount ?? DEFAULT_MIN_VERTEX_COUNT;
  const minDimension = options.minDimension ?? DEFAULT_MIN_DIMENSION;

  if (!positionAttribute || positionAttribute.count < minVertexCount) {
    return false;
  }

  geometry.computeBoundingBox();
  geometry.boundingBox.getSize(tempGeometrySize);
  return Math.max(tempGeometrySize.x, tempGeometrySize.y, tempGeometrySize.z) > minDimension;
}

export function createCapVertices(segments, plane, sideSign, options = {}) {
  const groups = groupCapSegments(
    segments,
    options.capDedupePrecision ?? DEFAULT_CAP_DEDUPE_PRECISION,
  );

  if (!groups.length) {
    return [];
  }

  return groups.flatMap((points) => createCapFanVertices(points, plane, sideSign));
}

function createCapFanVertices(points, plane, sideSign) {
  const center = points
    .reduce((sum, point) => sum.add(point.position), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
  const axisU = new THREE.Vector3(0, 1, 0).cross(plane.normal);

  if (axisU.lengthSq() < 0.0001) {
    axisU.set(1, 0, 0).cross(plane.normal);
  }

  axisU.normalize();
  const axisV = plane.normal.clone().cross(axisU).normalize();
  const capNormal = plane.normal.clone().multiplyScalar(sideSign > 0 ? -1 : 1);

  points.sort((a, b) => {
    const aOffset = a.position.clone().sub(center);
    const bOffset = b.position.clone().sub(center);
    return Math.atan2(aOffset.dot(axisV), aOffset.dot(axisU))
      - Math.atan2(bOffset.dot(axisV), bOffset.dot(axisU));
  });

  const centerSkin = averageSkinInfluence(points);
  const centerVertex = {
    position: center,
    skinIndex: centerSkin?.indices ?? null,
    skinWeight: centerSkin?.weights ?? null,
  };

  const vertices = [];

  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    const ordered = sideSign > 0
      ? [centerVertex, next, points[index]]
      : [centerVertex, points[index], next];

    for (const point of ordered) {
      vertices.push({
        position: [point.position.x, point.position.y, point.position.z],
        normal: [capNormal.x, capNormal.y, capNormal.z],
        uv: [0.5 + point.position.dot(axisU), 0.5 + point.position.dot(axisV)],
        skinIndex: point.skinIndex ? [...point.skinIndex] : null,
        skinWeight: point.skinWeight ? [...point.skinWeight] : null,
      });
    }
  }

  return vertices;
}

function groupCapSegments(segments, precision) {
  const nodes = new Map();

  for (const segment of segments) {
    if (segment.length !== 2) {
      continue;
    }

    const [first, second] = segment;
    const firstKey = capVertexKey(first, precision);
    const secondKey = capVertexKey(second, precision);

    if (firstKey === secondKey) {
      continue;
    }

    if (!nodes.has(firstKey)) {
      nodes.set(firstKey, {
        vertex: cloneVertex(first),
        neighbors: new Set(),
      });
    }

    if (!nodes.has(secondKey)) {
      nodes.set(secondKey, {
        vertex: cloneVertex(second),
        neighbors: new Set(),
      });
    }

    nodes.get(firstKey).neighbors.add(secondKey);
    nodes.get(secondKey).neighbors.add(firstKey);
  }

  const groups = [];
  const visited = new Set();

  for (const key of nodes.keys()) {
    if (visited.has(key)) {
      continue;
    }

    const stack = [key];
    const group = [];
    visited.add(key);

    while (stack.length) {
      const currentKey = stack.pop();
      const node = nodes.get(currentKey);

      if (!node) {
        continue;
      }

      group.push(node.vertex);

      for (const neighbor of node.neighbors) {
        if (visited.has(neighbor)) {
          continue;
        }

        visited.add(neighbor);
        stack.push(neighbor);
      }
    }

    if (group.length >= 3) {
      groups.push(group);
    }
  }

  return groups;
}

function capVertexKey(vertex, precision) {
  const point = vertex.position ?? vertex;
  return `${point.x.toFixed(precision)},${point.y.toFixed(precision)},${point.z.toFixed(precision)}`;
}

function dedupeCapVertices(vertices, precision) {
  const seen = new Map();

  for (const vertex of vertices) {
    const point = vertex.position ?? vertex;
    const key = `${point.x.toFixed(precision)},${point.y.toFixed(precision)},${point.z.toFixed(precision)}`;

    if (!seen.has(key)) {
      seen.set(key, {
        position: point.clone(),
        skinIndex: vertex.skinIndex ? [...vertex.skinIndex] : null,
        skinWeight: vertex.skinWeight ? [...vertex.skinWeight] : null,
      });
    }
  }

  return [...seen.values()];
}

function averageSkinInfluence(vertices) {
  const weightsByBone = new Map();
  let skinnedCount = 0;

  for (const vertex of vertices) {
    if (!vertex.skinIndex || !vertex.skinWeight) {
      continue;
    }

    skinnedCount += 1;
    accumulateSkinInfluence(weightsByBone, vertex.skinIndex, vertex.skinWeight, 1);
  }

  if (!skinnedCount) {
    return null;
  }

  const influences = [...weightsByBone.entries()]
    .filter(([, weight]) => weight > 0.000001)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);

  while (influences.length < 4) {
    influences.push([0, 0]);
  }

  const total = influences.reduce((sum, [, weight]) => sum + weight, 0);
  const weights = total > 0.000001
    ? influences.map(([, weight]) => weight / total)
    : [1, 0, 0, 0];

  return {
    indices: influences.map(([boneIndex]) => boneIndex),
    weights,
  };
}
function createVertexFromAttributes({
  index,
  positionAttribute,
  normalAttribute,
  uvAttribute,
  skinIndexAttribute,
  skinWeightAttribute,
  testAttribute = null,
}) {
  return {
    position: new THREE.Vector3(
      positionAttribute.getX(index),
      positionAttribute.getY(index),
      positionAttribute.getZ(index),
    ),
    test: testAttribute
      ? new THREE.Vector3(
        testAttribute.getX(index),
        testAttribute.getY(index),
        testAttribute.getZ(index),
      )
      : null,
    normal: normalAttribute
      ? new THREE.Vector3(
        normalAttribute.getX(index),
        normalAttribute.getY(index),
        normalAttribute.getZ(index),
      ).normalize()
      : new THREE.Vector3(),
    uv: uvAttribute
      ? new THREE.Vector2(uvAttribute.getX(index), uvAttribute.getY(index))
      : new THREE.Vector2(),
    skinIndex: skinIndexAttribute
      ? readVec4Attribute(skinIndexAttribute, index)
      : null,
    skinWeight: skinWeightAttribute
      ? readVec4Attribute(skinWeightAttribute, index)
      : null,
  };
}

function clipPolygon(points, plane, sideSign, intersections, clipEpsilon) {
  const output = [];

  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const distanceA = plane.distanceToPoint(a.test ?? a.position) * sideSign;
    const distanceB = plane.distanceToPoint(b.test ?? b.position) * sideSign;
    const aInside = distanceA >= -clipEpsilon;
    const bInside = distanceB >= -clipEpsilon;

    if (aInside && bInside) {
      output.push(cloneVertex(b));
    } else if (aInside && !bInside) {
      const cut = interpolateVertex(a, b, distanceA / (distanceA - distanceB));
      output.push(cut);
      intersections.push(cloneVertex(cut));
    } else if (!aInside && bInside) {
      const cut = interpolateVertex(a, b, distanceA / (distanceA - distanceB));
      output.push(cut, cloneVertex(b));
      intersections.push(cloneVertex(cut));
    }
  }

  return output;
}

function pushVertex(target, vertex) {
  const pushed = {
    position: [vertex.position.x, vertex.position.y, vertex.position.z],
    normal: [vertex.normal.x, vertex.normal.y, vertex.normal.z],
    uv: [vertex.uv.x, vertex.uv.y],
  };

  if (vertex.skinIndex) {
    pushed.skinIndex = [...vertex.skinIndex];
  }

  if (vertex.skinWeight) {
    pushed.skinWeight = [...vertex.skinWeight];
  }

  target.push(pushed);
}

function cloneVertex(vertex) {
  return {
    position: vertex.position.clone(),
    test: vertex.test ? vertex.test.clone() : null,
    normal: vertex.normal.clone(),
    uv: vertex.uv.clone(),
    skinIndex: vertex.skinIndex ? [...vertex.skinIndex] : null,
    skinWeight: vertex.skinWeight ? [...vertex.skinWeight] : null,
  };
}

function interpolateVertex(a, b, t) {
  const vertex = {
    position: a.position.clone().lerp(b.position, t),
    normal: a.normal.clone().lerp(b.normal, t).normalize(),
    uv: a.uv.clone().lerp(b.uv, t),
  };

  if (a.test || b.test) {
    vertex.test = (a.test ?? a.position).clone().lerp(b.test ?? b.position, t);
  }

  if (a.skinIndex || b.skinIndex) {
    const skin = interpolateSkinInfluence(a, b, t);

    vertex.skinIndex = skin.indices;
    vertex.skinWeight = skin.weights;
  }

  return vertex;
}

function readVec4Attribute(attribute, index) {
  return [
    attribute.getX(index),
    attribute.getY(index),
    attribute.getZ(index),
    attribute.getW(index),
  ];
}

function interpolateSkinInfluence(a, b, t) {
  const weightsByBone = new Map();

  accumulateSkinInfluence(weightsByBone, a.skinIndex, a.skinWeight, 1 - t);
  accumulateSkinInfluence(weightsByBone, b.skinIndex, b.skinWeight, t);

  const influences = [...weightsByBone.entries()]
    .filter(([, weight]) => weight > 0.000001)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);

  while (influences.length < 4) {
    influences.push([0, 0]);
  }

  const total = influences.reduce((sum, [, weight]) => sum + weight, 0);
  const weights = total > 0.000001
    ? influences.map(([, weight]) => weight / total)
    : [1, 0, 0, 0];

  return {
    indices: influences.map(([boneIndex]) => boneIndex),
    weights,
  };
}

function accumulateSkinInfluence(weightsByBone, indices, weights, scale) {
  if (!indices || !weights) {
    return;
  }

  for (let index = 0; index < 4; index += 1) {
    const boneIndex = Math.max(0, Math.round(indices[index] ?? 0));
    const weight = Math.max(0, weights[index] ?? 0) * scale;

    if (weight <= 0.000001) {
      continue;
    }

    weightsByBone.set(
      boneIndex,
      (weightsByBone.get(boneIndex) ?? 0) + weight,
    );
  }
}
