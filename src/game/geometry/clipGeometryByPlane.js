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
  // Single-pass dual clip: one triangle walk builds both halves. Horde sword
  // cuts used to call clipGeometryByPlane twice over ~80k tris.
  return clipGeometryPairByPlaneSinglePass(sourceGeometry, plane, options);
}

function clipGeometryPairByPlaneSinglePass(sourceGeometry, plane, options = {}) {
  const preserveSource = Boolean(options.preserveSource);
  // Prefer INDEXED clipping when possible: horde meshes are ~43k unique verts /
  // ~80k tris. Expanding via toNonIndexed first used to materialize ~240k
  // corners before any plane test.
  let source;
  let shouldDisposeSource = true;
  if (preserveSource) {
    source = sourceGeometry;
    shouldDisposeSource = false;
  } else {
    source = sourceGeometry.clone();
  }

  if (!source.getAttribute('normal')) {
    source.computeVertexNormals();
  }

  const positionAttribute = source.getAttribute('position');
  const normalAttribute = source.getAttribute('normal');
  const uvAttribute = source.getAttribute('uv');
  const skinIndexAttribute = source.getAttribute('skinIndex');
  const skinWeightAttribute = source.getAttribute('skinWeight');
  const indexAttribute = source.getIndex();
  const testAttribute = options.testPositionsAttribute
    ? source.getAttribute(options.testPositionsAttribute)
    : null;
  const clipEpsilon = options.clipEpsilon ?? DEFAULT_CLIP_EPSILON;
  const includeCap = options.includeCap ?? true;

  if (!positionAttribute || positionAttribute.count < 3) {
    if (shouldDisposeSource) source.dispose();
    return null;
  }

  // Growable builders — fully-on-side triangles copy attributes without
  // allocating THREE.Vector3 vertex objects (the old path did that for all 80k
  // tris × both sides and dominated horde cut frames).
  const positiveBuilder = createGeometryBuilder(skinIndexAttribute, skinWeightAttribute);
  const negativeBuilder = createGeometryBuilder(skinIndexAttribute, skinWeightAttribute);
  const positiveCapSegments = [];
  const negativeCapSegments = [];
  const nx = plane.normal.x;
  const ny = plane.normal.y;
  const nz = plane.normal.z;
  const nConst = plane.constant;
  const testPos = testAttribute ?? positionAttribute;
  const triCornerCount = indexAttribute ? indexAttribute.count : positionAttribute.count;
  const triCount = Math.floor(triCornerCount / 3);
  // Optional triangle budget (high-poly horde static halves). Uniform stride keeps
  // both sides coherent; cut props are short-lived so density loss is acceptable.
  const maxTriangles = options.maxTriangles > 0 ? Math.floor(options.maxTriangles) : 0;
  const triStride = maxTriangles > 0 && triCount > maxTriangles
    ? Math.ceil(triCount / maxTriangles)
    : 1;

  for (let tri = 0; tri < triCount; tri += triStride) {
    const base = tri * 3;
    const i0 = indexAttribute ? indexAttribute.getX(base) : base;
    const i1 = indexAttribute ? indexAttribute.getX(base + 1) : base + 1;
    const i2 = indexAttribute ? indexAttribute.getX(base + 2) : base + 2;
    const d0 = nx * testPos.getX(i0) + ny * testPos.getY(i0) + nz * testPos.getZ(i0) + nConst;
    const d1 = nx * testPos.getX(i1) + ny * testPos.getY(i1) + nz * testPos.getZ(i1) + nConst;
    const d2 = nx * testPos.getX(i2) + ny * testPos.getY(i2) + nz * testPos.getZ(i2) + nConst;

    const allPositive = d0 >= -clipEpsilon && d1 >= -clipEpsilon && d2 >= -clipEpsilon;
    const allNegative = d0 <= clipEpsilon && d1 <= clipEpsilon && d2 <= clipEpsilon;

    if (allPositive && !allNegative) {
      if (d0 > clipEpsilon || d1 > clipEpsilon || d2 > clipEpsilon) {
        appendTriangleFromAttributes(positiveBuilder, {
          indices: [i0, i1, i2],
          positionAttribute,
          normalAttribute,
          uvAttribute,
          skinIndexAttribute,
          skinWeightAttribute,
        });
      }
      continue;
    }

    if (allNegative && !allPositive) {
      if (d0 < -clipEpsilon || d1 < -clipEpsilon || d2 < -clipEpsilon) {
        appendTriangleFromAttributes(negativeBuilder, {
          indices: [i0, i1, i2],
          positionAttribute,
          normalAttribute,
          uvAttribute,
          skinIndexAttribute,
          skinWeightAttribute,
        });
      }
      continue;
    }

    // Straddling: allocate vertex objects only for the cut band.
    const triangle = [i0, i1, i2].map((vertIndex) => createVertexFromAttributes({
      index: vertIndex,
      positionAttribute,
      normalAttribute,
      uvAttribute,
      skinIndexAttribute,
      skinWeightAttribute,
      testAttribute,
    }));

    const positiveIntersections = [];
    const positiveClipped = clipPolygon(triangle, plane, 1, positiveIntersections, clipEpsilon);
    appendClippedPolygonToBuilder(positiveBuilder, positiveClipped, positiveCapSegments, positiveIntersections, includeCap);

    const negativeIntersections = [];
    const negativeClipped = clipPolygon(triangle, plane, -1, negativeIntersections, clipEpsilon);
    appendClippedPolygonToBuilder(negativeBuilder, negativeClipped, negativeCapSegments, negativeIntersections, includeCap);
  }

  const positiveCap = includeCap
    ? createCapVertices(positiveCapSegments, plane, 1, options)
    : [];
  const negativeCap = includeCap
    ? createCapVertices(negativeCapSegments, plane, -1, options)
    : [];

  const positive = finalizeGeometryBuilder(positiveBuilder, positiveCap);
  const negative = finalizeGeometryBuilder(negativeBuilder, negativeCap);

  if (shouldDisposeSource) source.dispose();

  if (!positive && !negative) {
    return null;
  }

  return { positive, negative };
}

function createGeometryBuilder(skinIndexAttribute, skinWeightAttribute) {
  return {
    positions: [],
    normals: [],
    uvs: [],
    skinIndices: skinIndexAttribute ? [] : null,
    skinWeights: skinWeightAttribute ? [] : null,
    count: 0,
  };
}

function appendTriangleFromAttributes(builder, {
  indices,
  positionAttribute,
  normalAttribute,
  uvAttribute,
  skinIndexAttribute,
  skinWeightAttribute,
}) {
  for (const index of indices) {
    builder.positions.push(
      positionAttribute.getX(index),
      positionAttribute.getY(index),
      positionAttribute.getZ(index),
    );
    if (normalAttribute) {
      builder.normals.push(
        normalAttribute.getX(index),
        normalAttribute.getY(index),
        normalAttribute.getZ(index),
      );
    } else {
      builder.normals.push(0, 1, 0);
    }
    if (uvAttribute) {
      builder.uvs.push(uvAttribute.getX(index), uvAttribute.getY(index));
    } else {
      builder.uvs.push(0, 0);
    }
    if (builder.skinIndices) {
      builder.skinIndices.push(
        skinIndexAttribute.getX(index),
        skinIndexAttribute.getY(index),
        skinIndexAttribute.getZ(index),
        skinIndexAttribute.getW(index),
      );
      builder.skinWeights.push(
        skinWeightAttribute.getX(index),
        skinWeightAttribute.getY(index),
        skinWeightAttribute.getZ(index),
        skinWeightAttribute.getW(index),
      );
    }
    builder.count += 1;
  }
}

function appendClippedPolygonToBuilder(builder, clipped, capSegments, intersections, includeCap) {
  if (!clipped || clipped.length < 3) {
    return;
  }
  for (let pointIndex = 1; pointIndex < clipped.length - 1; pointIndex += 1) {
    appendVertexObject(builder, clipped[0]);
    appendVertexObject(builder, clipped[pointIndex]);
    appendVertexObject(builder, clipped[pointIndex + 1]);
  }
  if (includeCap && intersections.length === 2) {
    capSegments.push(intersections.map((vertex) => cloneVertex(vertex)));
  }
}

function appendVertexObject(builder, vertex) {
  builder.positions.push(vertex.position.x, vertex.position.y, vertex.position.z);
  builder.normals.push(vertex.normal.x, vertex.normal.y, vertex.normal.z);
  builder.uvs.push(vertex.uv.x, vertex.uv.y);
  if (builder.skinIndices) {
    const si = vertex.skinIndex ?? [0, 0, 0, 0];
    const sw = vertex.skinWeight ?? [1, 0, 0, 0];
    builder.skinIndices.push(si[0], si[1], si[2], si[3]);
    builder.skinWeights.push(sw[0], sw[1], sw[2], sw[3]);
  }
  builder.count += 1;
}

function finalizeGeometryBuilder(builder, capVertices = []) {
  if (builder.count < 3 && !capVertices.length) {
    return null;
  }

  const totalVerts = builder.count + capVertices.length;
  if (totalVerts < 3) {
    return null;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const skinIndices = builder.skinIndices ? new Uint16Array(totalVerts * 4) : null;
  const skinWeights = builder.skinWeights ? new Float32Array(totalVerts * 4) : null;

  positions.set(builder.positions);
  normals.set(builder.normals);
  uvs.set(builder.uvs);
  if (skinIndices) {
    skinIndices.set(builder.skinIndices);
    skinWeights.set(builder.skinWeights);
  }

  for (let i = 0; i < capVertices.length; i += 1) {
    const vertex = capVertices[i];
    const slot = builder.count + i;
    const p = vertex.position;
    const n = vertex.normal;
    const uv = vertex.uv;
    positions[slot * 3] = p[0];
    positions[slot * 3 + 1] = p[1];
    positions[slot * 3 + 2] = p[2];
    normals[slot * 3] = n[0];
    normals[slot * 3 + 1] = n[1];
    normals[slot * 3 + 2] = n[2];
    uvs[slot * 2] = uv[0];
    uvs[slot * 2 + 1] = uv[1];
    if (skinIndices) {
      const si = vertex.skinIndex ?? [0, 0, 0, 0];
      const sw = vertex.skinWeight ?? [1, 0, 0, 0];
      const base = slot * 4;
      skinIndices[base] = si[0];
      skinIndices[base + 1] = si[1];
      skinIndices[base + 2] = si[2];
      skinIndices[base + 3] = si[3];
      skinWeights[base] = sw[0];
      skinWeights[base + 1] = sw[1];
      skinWeights[base + 2] = sw[2];
      skinWeights[base + 3] = sw[3];
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (skinIndices) {
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  }
  geometry.addGroup(0, builder.count, 0);
  if (capVertices.length) {
    geometry.addGroup(builder.count, capVertices.length, 1);
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function clipGeometryByPlane(sourceGeometry, plane, sideSign, options = {}) {
  if (sideSign !== 1 && sideSign !== -1) {
    throw new Error(`clipGeometryByPlane sideSign must be 1 or -1, got ${sideSign}`);
  }

  // preserveSource: caller already owns a non-indexed working copy (e.g. shared
  // pair-clip). Avoid clone+dispose of ~240k expanded horde verts per side.
  const preserveSource = Boolean(options.preserveSource);
  let source;
  let shouldDisposeSource = true;
  if (sourceGeometry.index) {
    source = sourceGeometry.toNonIndexed();
  } else if (preserveSource) {
    source = sourceGeometry;
    shouldDisposeSource = false;
  } else {
    source = sourceGeometry.clone();
  }

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
    if (shouldDisposeSource) source.dispose();
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
    if (shouldDisposeSource) source.dispose();
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  const totalVerts = originalVertices.length + capVertices.length;
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const skinIndices = skinIndexAttribute ? new Uint16Array(totalVerts * 4) : null;
  const skinWeights = skinWeightAttribute ? new Float32Array(totalVerts * 4) : null;

  const writeVertex = (vertex, slot) => {
    const p = vertex.position;
    const n = vertex.normal;
    const uv = vertex.uv;
    positions[slot * 3] = p[0];
    positions[slot * 3 + 1] = p[1];
    positions[slot * 3 + 2] = p[2];
    normals[slot * 3] = n[0];
    normals[slot * 3 + 1] = n[1];
    normals[slot * 3 + 2] = n[2];
    uvs[slot * 2] = uv[0];
    uvs[slot * 2 + 1] = uv[1];
    if (skinIndices) {
      const si = vertex.skinIndex ?? [0, 0, 0, 0];
      const sw = vertex.skinWeight ?? [1, 0, 0, 0];
      const base = slot * 4;
      skinIndices[base] = si[0];
      skinIndices[base + 1] = si[1];
      skinIndices[base + 2] = si[2];
      skinIndices[base + 3] = si[3];
      skinWeights[base] = sw[0];
      skinWeights[base + 1] = sw[1];
      skinWeights[base + 2] = sw[2];
      skinWeights[base + 3] = sw[3];
    }
  };

  for (let i = 0; i < originalVertices.length; i += 1) {
    writeVertex(originalVertices[i], i);
  }
  for (let i = 0; i < capVertices.length; i += 1) {
    writeVertex(capVertices[i], originalVertices.length + i);
  }

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
  if (shouldDisposeSource) source.dispose();

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
