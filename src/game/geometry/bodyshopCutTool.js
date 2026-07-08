import * as THREE from 'three';
import { clipGeometryByPlane } from './clipGeometryByPlane.js';

const CLOSE_THRESHOLD = 0.04;
const MARKER_SIZE = 0.02;
const SLICE_MARKER_MIN = 0.004;
const SLICE_MARKER_MAX = 0.011;
const SLICE_MARKER_EXTENT_FACTOR = 0.0035;
const MARKER_COLOR = 0xff4444;
const LINE_COLOR = 0xff6644;
const PREVIEW_LINE_COLOR = 0xffaa44;

export function createCutToolState(scene) {
  const helpersGroup = new THREE.Group();
  helpersGroup.name = '__cut_tool_helpers__';
  helpersGroup.userData._builderHelper = true;
  scene.add(helpersGroup);

  return {
    scene,
    helpersGroup,
    points: [],
    markers: [],
    lines: [],
    previewLine: null,
    closed: false,
    targetMesh: null
  };
}

export function handleCutClick(state, intersection) {
  if (state.closed) {
    return { closed: true, pointCount: state.points.length };
  }

  const point = intersection.point.clone();
  const mesh = intersection.object;

  if (!state.targetMesh) {
    state.targetMesh = mesh;
  }

  // Check if closing the loop
  if (state.points.length >= 3) {
    const firstPoint = state.points[0];
    const dist = point.distanceTo(firstPoint);
    if (dist < CLOSE_THRESHOLD) {
      // Close the loop
      addLineSegment(state, state.points[state.points.length - 1], state.points[0]);
      state.closed = true;
      return { closed: true, pointCount: state.points.length };
    }
  }

  // Add point
  state.points.push(point);
  addMarker(state, point, state.points.length === 1);

  // Add line from previous point
  if (state.points.length > 1) {
    const prev = state.points[state.points.length - 2];
    addLineSegment(state, prev, point);
  }

  return { closed: false, pointCount: state.points.length };
}

export function undoLastPoint(state) {
  if (state.closed || state.points.length === 0) return;

  state.points.pop();

  // Remove last marker
  const lastMarker = state.markers.pop();
  if (lastMarker) {
    state.helpersGroup.remove(lastMarker);
    lastMarker.geometry?.dispose();
    lastMarker.material?.dispose();
  }

  // Remove last line
  if (state.lines.length > 0) {
    const lastLine = state.lines.pop();
    state.helpersGroup.remove(lastLine);
    lastLine.geometry?.dispose();
    lastLine.material?.dispose();
  }
}

export function clearCutPoints(state) {
  state.points = [];
  state.closed = false;
  state.targetMesh = null;

  for (const marker of state.markers) {
    state.helpersGroup.remove(marker);
    marker.geometry?.dispose();
    marker.material?.dispose();
  }
  state.markers = [];

  for (const line of state.lines) {
    state.helpersGroup.remove(line);
    line.geometry?.dispose();
    line.material?.dispose();
  }
  state.lines = [];

  if (state.previewLine) {
    state.helpersGroup.remove(state.previewLine);
    state.previewLine.geometry?.dispose();
    state.previewLine.material?.dispose();
    state.previewLine = null;
  }
}

export function disposeCutVisuals(state) {
  clearCutPoints(state);
  state.scene?.remove(state.helpersGroup);
}

export function applyCut(state, targetMesh, camera) {
  if (!state.closed || state.points.length < 3) {
    throw new Error('Boundary must be closed (at least 3 points).');
  }

  // Surface-only cut: separate triangles whose centers fall inside the boundary
  // into a cutout mesh. Uses camera direction to filter front-facing faces only.

  targetMesh.updateMatrixWorld(true);
  const inverseMatrix = new THREE.Matrix4().copy(targetMesh.matrixWorld).invert();

  const localPoints = state.points.map((p) => p.clone().applyMatrix4(inverseMatrix));

  // Camera forward in mesh-local space — used to determine which faces
  // the user is actually looking at (front-facing vs back of shell)
  const camForwardWorld = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const camForwardLocal = camForwardWorld.clone().transformDirection(inverseMatrix).normalize();

  // Compute best-fit plane for 2D projection
  const centroid = new THREE.Vector3();
  for (const p of localPoints) centroid.add(p);
  centroid.divideScalar(localPoints.length);

  // Plane normal via Newell's method (used for 2D projection only)
  const planeNormal = new THREE.Vector3();
  for (let i = 0; i < localPoints.length; i++) {
    const current = localPoints[i];
    const next = localPoints[(i + 1) % localPoints.length];
    planeNormal.x += (current.y - next.y) * (current.z + next.z);
    planeNormal.y += (current.z - next.z) * (current.x + next.x);
    planeNormal.z += (current.x - next.x) * (current.y + next.y);
  }
  planeNormal.normalize();

  if (planeNormal.lengthSq() < 0.001) {
    throw new Error('Could not determine cut plane — points may be collinear.');
  }

  // Build 2D coordinate frame on the boundary plane
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();

  if (Math.abs(planeNormal.y) < 0.9) {
    tangent.crossVectors(planeNormal, new THREE.Vector3(0, 1, 0)).normalize();
  } else {
    tangent.crossVectors(planeNormal, new THREE.Vector3(1, 0, 0)).normalize();
  }
  bitangent.crossVectors(planeNormal, tangent).normalize();

  // Project boundary points to 2D
  const boundary2D = localPoints.map((p) => {
    const d = p.clone().sub(centroid);
    return [d.dot(tangent), d.dot(bitangent)];
  });

  // Compute distance tolerance: only cut faces near the boundary plane,
  // not faces on other surfaces that happen to project inside the polygon.
  // Use the boundary's 2D radius as a reference — faces farther from the
  // plane than half the boundary size are on a different surface.
  let boundaryRadius = 0;
  for (const p of localPoints) {
    const dist = p.clone().sub(centroid).length();
    if (dist > boundaryRadius) boundaryRadius = dist;
  }
  // Also measure how much the boundary points themselves deviate from the plane
  let maxPlaneDev = 0;
  for (const p of localPoints) {
    const dev = Math.abs(p.clone().sub(centroid).dot(planeNormal));
    if (dev > maxPlaneDev) maxPlaneDev = dev;
  }
  // Tolerance: at least the boundary's own deviation, scaled up for surface curvature,
  // but capped relative to boundary size so we don't grab distant surfaces
  const distTolerance = Math.max(maxPlaneDev * 3, boundaryRadius * 0.4, 0.05);

  const geo = targetMesh.geometry;
  const posAttr = geo.getAttribute('position');
  const indexAttr = geo.getIndex();
  const totalTriangles = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

  const insideIndices = [];
  const outsideIndices = [];

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const faceCenter = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();
  const edgeAB = new THREE.Vector3();
  const edgeAC = new THREE.Vector3();
  const delta = new THREE.Vector3();

  for (let tri = 0; tri < totalTriangles; tri++) {
    let iA, iB, iC;
    if (indexAttr) {
      iA = indexAttr.getX(tri * 3);
      iB = indexAttr.getX(tri * 3 + 1);
      iC = indexAttr.getX(tri * 3 + 2);
    } else {
      iA = tri * 3;
      iB = tri * 3 + 1;
      iC = tri * 3 + 2;
    }

    vA.fromBufferAttribute(posAttr, iA);
    vB.fromBufferAttribute(posAttr, iB);
    vC.fromBufferAttribute(posAttr, iC);

    // Compute face normal
    edgeAB.subVectors(vB, vA);
    edgeAC.subVectors(vC, vA);
    faceNormal.crossVectors(edgeAB, edgeAC).normalize();

    // Only include faces visible to the camera (front-facing).
    const viewDot = faceNormal.dot(camForwardLocal);
    if (viewDot >= 0) {
      outsideIndices.push(iA, iB, iC);
      continue;
    }

    // Face center
    faceCenter.copy(vA).add(vB).add(vC).divideScalar(3);

    // Check distance from boundary plane — reject faces on other surfaces
    delta.subVectors(faceCenter, centroid);
    const distFromPlane = Math.abs(delta.dot(planeNormal));
    if (distFromPlane > distTolerance) {
      outsideIndices.push(iA, iB, iC);
      continue;
    }

    // Project face center onto the boundary plane for 2D containment test
    const u = delta.dot(tangent);
    const v = delta.dot(bitangent);

    if (pointInPolygon2D(u, v, boundary2D)) {
      insideIndices.push(iA, iB, iC);
    } else {
      outsideIndices.push(iA, iB, iC);
    }
  }

  if (insideIndices.length === 0) {
    throw new Error('No faces found inside the boundary. Try drawing a larger area.');
  }

  const bodyGeometry = buildGeometryFromFaces(geo, outsideIndices);
  const cutoutGeometry = buildGeometryFromFaces(geo, insideIndices);

  return { body: bodyGeometry, cutout: cutoutGeometry };
}

/**
 * Point-in-polygon test using ray casting algorithm.
 */
function pointInPolygon2D(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];

    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Build a new BufferGeometry from a subset of faces (given as flat index triples).
 */
function buildGeometryFromFaces(sourceGeo, faceIndices) {
  const srcPos = sourceGeo.getAttribute('position');
  const srcNorm = sourceGeo.getAttribute('normal');
  const srcUv = sourceGeo.getAttribute('uv');

  // Map old vertex indices to new compact indices
  const vertexMap = new Map();
  const newIndices = [];
  let nextIndex = 0;

  for (const oldIdx of faceIndices) {
    if (!vertexMap.has(oldIdx)) {
      vertexMap.set(oldIdx, nextIndex++);
    }
    newIndices.push(vertexMap.get(oldIdx));
  }

  const vertexCount = vertexMap.size;
  const positions = new Float32Array(vertexCount * 3);
  const normals = srcNorm ? new Float32Array(vertexCount * 3) : null;
  const uvs = srcUv ? new Float32Array(vertexCount * 2) : null;

  for (const [oldIdx, newIdx] of vertexMap) {
    positions[newIdx * 3] = srcPos.getX(oldIdx);
    positions[newIdx * 3 + 1] = srcPos.getY(oldIdx);
    positions[newIdx * 3 + 2] = srcPos.getZ(oldIdx);

    if (normals && srcNorm) {
      normals[newIdx * 3] = srcNorm.getX(oldIdx);
      normals[newIdx * 3 + 1] = srcNorm.getY(oldIdx);
      normals[newIdx * 3 + 2] = srcNorm.getZ(oldIdx);
    }

    if (uvs && srcUv) {
      uvs[newIdx * 2] = srcUv.getX(oldIdx);
      uvs[newIdx * 2 + 1] = srcUv.getY(oldIdx);
    }
  }

  const newGeo = new THREE.BufferGeometry();
  newGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (normals) newGeo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  if (uvs) newGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  newGeo.setIndex(newIndices);

  newGeo.computeVertexNormals();
  newGeo.computeBoundingBox();
  newGeo.computeBoundingSphere();

  return newGeo;
}

/**
 * Cut a mesh using a cylinder volume via face separation.
 * Checks each triangle center: if it falls inside the cylinder, it goes to cutout.
 * Works reliably on hollow shell meshes from AI generators.
 */
export function applyCylinderCut(cylinderMesh, targetMesh) {
  cylinderMesh.updateMatrixWorld(true);
  targetMesh.updateMatrixWorld(true);

  const params = cylinderMesh.geometry.parameters;
  const radius = params.radiusTop;
  const halfHeight = params.height * 0.5;

  // Matrix to transform mesh-local points into cylinder-local space.
  // In cylinder-local space, the cylinder is centered at origin with Y as axis.
  const meshToCylinder = new THREE.Matrix4()
    .copy(cylinderMesh.matrixWorld)
    .invert()
    .multiply(targetMesh.matrixWorld);

  const geo = targetMesh.geometry;
  const posAttr = geo.getAttribute('position');
  const indexAttr = geo.getIndex();
  const totalTriangles = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

  const insideIndices = [];
  const outsideIndices = [];

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const faceCenter = new THREE.Vector3();

  for (let tri = 0; tri < totalTriangles; tri++) {
    let iA, iB, iC;
    if (indexAttr) {
      iA = indexAttr.getX(tri * 3);
      iB = indexAttr.getX(tri * 3 + 1);
      iC = indexAttr.getX(tri * 3 + 2);
    } else {
      iA = tri * 3;
      iB = tri * 3 + 1;
      iC = tri * 3 + 2;
    }

    vA.fromBufferAttribute(posAttr, iA);
    vB.fromBufferAttribute(posAttr, iB);
    vC.fromBufferAttribute(posAttr, iC);

    // Face center in mesh-local space
    faceCenter.copy(vA).add(vB).add(vC).divideScalar(3);

    // Transform to cylinder-local space
    faceCenter.applyMatrix4(meshToCylinder);

    // In cylinder-local: Y is the axis, check radius on XZ plane and height on Y
    const distXZ = Math.sqrt(faceCenter.x * faceCenter.x + faceCenter.z * faceCenter.z);

    if (distXZ <= radius && Math.abs(faceCenter.y) <= halfHeight) {
      insideIndices.push(iA, iB, iC);
    } else {
      outsideIndices.push(iA, iB, iC);
    }
  }

  if (insideIndices.length === 0) {
    throw new Error('No faces found inside the cylinder. Try repositioning or scaling it.');
  }

  const bodyGeometry = buildGeometryFromFaces(geo, outsideIndices);
  const cutoutGeometry = buildGeometryFromFaces(geo, insideIndices);

  return { body: bodyGeometry, cutout: cutoutGeometry };
}

// --- Slice tool ---
// Two points define a line. Combined with camera direction, this defines a cutting plane.
// Everything on one side is removed. clipGeometryByPlane caps the cut edge.

export function createSliceState(scene) {
  const helpersGroup = new THREE.Group();
  helpersGroup.name = '__slice_helpers__';
  helpersGroup.userData._builderHelper = true;
  scene.add(helpersGroup);

  return {
    scene,
    helpersGroup,
    pointA: null,
    pointB: null,
    markers: [],
    lines: [],
    previewLine: null,
    targetMesh: null,
    flipSide: false
  };
}

export function handleSliceClick(state, intersection) {
  const point = intersection.point.clone();
  const mesh = intersection.object;

  if (!state.targetMesh) {
    state.targetMesh = mesh;
  }

  if (!state.pointA) {
    state.pointA = point;
    addMarker(state, point, true, getSliceMarkerRadius(mesh));
    return { ready: false, pointCount: 1 };
  }

  if (!state.pointB) {
    state.pointB = point;
    addMarker(state, point, false, getSliceMarkerRadius(mesh));
    addLineSegment(state, state.pointA, state.pointB);
    return { ready: true, pointCount: 2 };
  }

  return { ready: true, pointCount: 2 };
}

export function updateSlicePreview(state, worldPoint) {
  if (!state.pointA || state.pointB) return;

  // Update or create preview line from pointA to cursor
  if (state.previewLine) {
    state.helpersGroup.remove(state.previewLine);
    state.previewLine.geometry?.dispose();
    state.previewLine.material?.dispose();
    state.previewLine = null;
  }

  const geometry = new THREE.BufferGeometry().setFromPoints([state.pointA, worldPoint]);
  const material = new THREE.LineBasicMaterial({
    color: 0xffff44,
    depthTest: false,
    depthWrite: false,
    linewidth: 2
  });
  state.previewLine = new THREE.Line(geometry, material);
  state.previewLine.renderOrder = 998;
  state.previewLine.userData._builderHelper = true;
  state.helpersGroup.add(state.previewLine);
}

export function clearSlice(state) {
  state.pointA = null;
  state.pointB = null;
  state.targetMesh = null;
  state.flipSide = false;

  for (const marker of state.markers) {
    state.helpersGroup.remove(marker);
    marker.geometry?.dispose();
    marker.material?.dispose();
  }
  state.markers = [];

  for (const line of state.lines) {
    state.helpersGroup.remove(line);
    line.geometry?.dispose();
    line.material?.dispose();
  }
  state.lines = [];

  if (state.previewLine) {
    state.helpersGroup.remove(state.previewLine);
    state.previewLine.geometry?.dispose();
    state.previewLine.material?.dispose();
    state.previewLine = null;
  }
}

export function disposeSlice(state) {
  clearSlice(state);
  state.scene?.remove(state.helpersGroup);
}

export function applySlice(state, targetMesh, camera) {
  if (!state.pointA || !state.pointB) {
    throw new Error('Place two points to define the slice line.');
  }

  targetMesh.updateMatrixWorld(true);
  const inverseMatrix = new THREE.Matrix4().copy(targetMesh.matrixWorld).invert();

  // Convert points to mesh-local space
  const localA = state.pointA.clone().applyMatrix4(inverseMatrix);
  const localB = state.pointB.clone().applyMatrix4(inverseMatrix);

  // The slice line direction
  const lineDir = new THREE.Vector3().subVectors(localB, localA).normalize();

  // Camera forward in mesh-local space
  const camForwardWorld = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const camForwardLocal = camForwardWorld.clone().transformDirection(inverseMatrix).normalize();

  // Plane normal = cross(lineDir, cameraForward) — perpendicular to both
  const planeNormal = new THREE.Vector3().crossVectors(lineDir, camForwardLocal).normalize();

  if (planeNormal.lengthSq() < 0.001) {
    throw new Error('Slice line is parallel to the view — try a different angle.');
  }

  // Flip if requested
  if (state.flipSide) {
    planeNormal.negate();
  }

  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, localA);
  const geometry = clipGeometryByPlane(targetMesh.geometry, plane, -1, { includeCap: true });
  if (!geometry) {
    throw new Error('Slice removed the entire mesh — try flipping the cut side.');
  }

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

function getSliceMarkerRadius(mesh) {
  if (!mesh) return SLICE_MARKER_MAX * 0.75;
  mesh.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(mesh);
  const size = bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z, 1e-6);
  return THREE.MathUtils.clamp(
    extent * SLICE_MARKER_EXTENT_FACTOR,
    SLICE_MARKER_MIN,
    SLICE_MARKER_MAX,
  );
}

function addMarker(state, position, isFirst, radius = MARKER_SIZE) {
  const markerRadius = isFirst ? radius * 1.35 : radius;
  const geometry = new THREE.SphereGeometry(markerRadius, 10, 10);
  const material = new THREE.MeshBasicMaterial({
    color: isFirst ? 0x44ff44 : MARKER_COLOR,
    depthTest: false,
    depthWrite: false
  });
  const marker = new THREE.Mesh(geometry, material);
  marker.position.copy(position);
  marker.renderOrder = 999;
  marker.userData._builderHelper = true;
  state.helpersGroup.add(marker);
  state.markers.push(marker);
}

function addLineSegment(state, from, to) {
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  const material = new THREE.LineBasicMaterial({
    color: state.closed ? PREVIEW_LINE_COLOR : LINE_COLOR,
    depthTest: false,
    depthWrite: false,
    linewidth: 2
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 998;
  line.userData._builderHelper = true;
  state.helpersGroup.add(line);
  state.lines.push(line);
}
