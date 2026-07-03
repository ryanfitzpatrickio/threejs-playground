import * as THREE from 'three';

const MIN_LEDGE_SPAN = 7.5;
const MIN_WALL_RUN_SPAN = 11;
const MIN_WALL_RUN_HEIGHT = 8;
const STREET_CLEARANCE = 2.8;
const WALL_RUN_MIN_V = 0.85;
const WALL_RUN_MAX_V = 3.35;
const CLIMB_MIN_V = 0.35;
const SURFACE_SIDE_MARGIN = 0.95;
const COLLISION_FACE_DOT = 0.42;
const COLLISION_FACE_QUANTILE = 0.96;
const TOP_NORMAL_Y = 0.58;
const SIDE_NORMAL_Y = 0.35;
const MIN_LEDGE_EDGE_LENGTH = 0.45;
const MIN_TOP_SURFACE_DEPTH = 0.28;
const LEDGE_MERGE_GAP = 0.82;
// Shelf-depth aggregation. shelfDepth must reflect how far the top surface
// extends inward from a ledge edge (the real standable depth), not the altitude
// of a single mesh triangle. We aggregate over top-facing triangles sharing the
// ledge's height band; bucketing by y keeps the per-ledge scan bounded to one
// floor instead of the whole building mesh.
const SHELF_DEPTH_Y_BUCKET = 0.5;
const SHELF_DEPTH_Y_TOLERANCE = 0.5;
const SHELF_DEPTH_ALONG_MARGIN = 0.5;
const LEDGE_PLANE_SNAP = 0.18;
const LEDGE_HEIGHT_SNAP = 0.24;
const LEDGE_SNAP_POINT_SPACING = 2.4;
const INTERIOR_LEDGE_PLANE_MARGIN = 0.22;
const INTERIOR_LEDGE_VERTICAL_MARGIN = 0.72;
const INTERIOR_LEDGE_MIN_OVERLAP = 0.45;
const CLIMB_LANE_WIDTH = 4.8;
const MIN_CLIMB_LEDGE_OVERLAP = 3;
const MAX_CLIMB_STEP_HEIGHT = 18;
const MIN_CLIMB_STEP_HEIGHT = 5;
const MIN_CLIMB_PANEL_SPAN = 7;
const MIN_CLIMB_PANEL_HEIGHT = 4;
const MIN_CLIMB_PANEL_COVERAGE = 0.18;
const CLIMB_PANEL_PLANE_SNAP = 0.24;
const CLIMB_PANEL_LEDGE_TOLERANCE = 1.35;
const MAX_CLIMB_ROUTES_PER_FACE = 1;
const MIN_CLIMB_ROUTE_STEPS = 2;
const MIN_CLIMB_ROUTE_GAIN = 9;
const CLIMB_ROUTE_SAMPLE_SPACING = 2.4;

export function extractCityTraversal({ buildings }) {
  const ledges = [];
  const climbSurfaces = [];
  const wallRunSurfaces = [];

  for (const building of buildings) {
    const faces = getCollisionFaces(building);
    const buildingLedges = extractBuildingLedges(building);
    const climbPanels = extractClimbPanels(building);

    if (buildingLedges.length === 0) {
      for (const face of faces) {
        if (face.span >= 9 && building.height >= 26) {
          addFallbackRoofLedge({ ledges: buildingLedges, building, face });
        }
      }
    }

    for (const face of faces) {
      if (face.span >= MIN_WALL_RUN_SPAN && building.height >= MIN_WALL_RUN_HEIGHT) {
        addWallRunSurface({ wallRunSurfaces, building, face });
      }
    }

    ledges.push(...buildingLedges);
    addClimbSurfacesFromPanels({ climbSurfaces, building, panels: climbPanels, ledges: buildingLedges });
  }

  connectWallRunSurfaces(wallRunSurfaces);

  return {
    ledges,
    climbSurfaces,
    wallRunSurfaces,
  };
}

export function createTraversalDebugOverlay({ ledges, climbSurfaces, wallRunSurfaces }) {
  const group = new THREE.Group();
  group.name = 'Traversal Debug Overlay';
  group.userData.debugOverlay = 'traversal';
  group.visible = false;

  addLineGroup({
    group,
    name: 'Hang Ledge Debug Edges',
    vertices: ledgeVertices(ledges),
    color: 0xfacc15,
  });
  addLineGroup({
    group,
    name: 'Ledge Snap Debug Points',
    vertices: snapPointVertices(ledges),
    color: 0xf472b6,
  });
  addLineGroup({
    group,
    name: 'Wall Run Debug Edges',
    vertices: surfaceRectVertices(wallRunSurfaces),
    color: 0x38bdf8,
  });
  addLineGroup({
    group,
    name: 'Climb Debug Edges',
    vertices: surfaceRectVertices(climbSurfaces),
    color: 0x4ade80,
  });

  return group;
}

function getCollisionFaces(building) {
  const { collider } = building;

  return [
    fitFaceToCollision(building, createFace({
      face: 'back',
      axis: 'x',
      min: collider.minX,
      max: collider.maxX,
      x: (collider.minX + collider.maxX) * 0.5,
      z: collider.minZ,
      normal: { x: 0, y: 0, z: -1 },
      tangent: { x: -1, y: 0, z: 0 },
      clearOrigin: { x: (collider.minX + collider.maxX) * 0.5, z: collider.minZ - STREET_CLEARANCE },
    })),
    fitFaceToCollision(building, createFace({
      face: 'front',
      axis: 'x',
      min: collider.minX,
      max: collider.maxX,
      x: (collider.minX + collider.maxX) * 0.5,
      z: collider.maxZ,
      normal: { x: 0, y: 0, z: 1 },
      tangent: { x: 1, y: 0, z: 0 },
      clearOrigin: { x: (collider.minX + collider.maxX) * 0.5, z: collider.maxZ + STREET_CLEARANCE },
    })),
    fitFaceToCollision(building, createFace({
      face: 'left',
      axis: 'z',
      min: collider.minZ,
      max: collider.maxZ,
      x: collider.minX,
      z: (collider.minZ + collider.maxZ) * 0.5,
      normal: { x: -1, y: 0, z: 0 },
      tangent: { x: 0, y: 0, z: 1 },
      clearOrigin: { x: collider.minX - STREET_CLEARANCE, z: (collider.minZ + collider.maxZ) * 0.5 },
    })),
    fitFaceToCollision(building, createFace({
      face: 'right',
      axis: 'z',
      min: collider.minZ,
      max: collider.maxZ,
      x: collider.maxX,
      z: (collider.minZ + collider.maxZ) * 0.5,
      normal: { x: 1, y: 0, z: 0 },
      tangent: { x: 0, y: 0, z: -1 },
      clearOrigin: { x: collider.maxX + STREET_CLEARANCE, z: (collider.minZ + collider.maxZ) * 0.5 },
    })),
  ];
}

function createFace(face) {
  return {
    ...face,
    span: face.max - face.min,
  };
}

function fitFaceToCollision(building, face) {
  const physicsMesh = building.collider.physicsMesh;
  const vertices = physicsMesh?.vertices;
  const indices = physicsMesh?.indices;

  if (!(vertices instanceof Float32Array) || !(indices instanceof Uint32Array)) {
    return face;
  }

  const normal = new THREE.Vector3(face.normal.x, face.normal.y, face.normal.z);
  const coordinates = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const triangleNormal = new THREE.Vector3();
  const minY = building.collider.bottomY + 0.15;
  const maxY = Math.min(building.collider.topY - 0.2, building.collider.bottomY + 8);

  for (let index = 0; index < indices.length; index += 3) {
    setPointFromMesh(a, vertices, indices[index]);
    setPointFromMesh(b, vertices, indices[index + 1]);
    setPointFromMesh(c, vertices, indices[index + 2]);
    triangleNormal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();

    if (triangleNormal.dot(normal) < COLLISION_FACE_DOT) {
      continue;
    }

    collectFaceCoordinate({ coordinates, face, point: a, minY, maxY });
    collectFaceCoordinate({ coordinates, face, point: b, minY, maxY });
    collectFaceCoordinate({ coordinates, face, point: c, minY, maxY });
  }

  if (coordinates.length < 3) {
    return face;
  }

  coordinates.sort((aCoord, bCoord) => aCoord - bCoord);
  const outwardCoord = face.normal.x > 0 || face.normal.z > 0
    ? quantile(coordinates, COLLISION_FACE_QUANTILE)
    : quantile(coordinates, 1 - COLLISION_FACE_QUANTILE);

  if (face.axis === 'x') {
    return {
      ...face,
      z: outwardCoord,
      clearOrigin: {
        ...face.clearOrigin,
        z: outwardCoord + face.normal.z * STREET_CLEARANCE,
      },
    };
  }

  return {
    ...face,
    x: outwardCoord,
    clearOrigin: {
      ...face.clearOrigin,
      x: outwardCoord + face.normal.x * STREET_CLEARANCE,
    },
  };
}

function extractBuildingLedges(building) {
  const physicsMesh = building.collider.physicsMesh;
  const vertices = physicsMesh?.vertices;
  const indices = physicsMesh?.traversalIndices ?? physicsMesh?.indices;

  if (!(vertices instanceof Float32Array) || !(indices instanceof Uint32Array)) {
    return [];
  }

  const { records, edgeMap } = buildTriangleRecords({ vertices, indices });
  const topRecordsByYBucket = buildTopRecordsByYBucket(records);
  const candidates = [];

  for (const record of records) {
    if (!record.top) {
      continue;
    }

    for (const edge of record.edges) {
      const edgeLength = edge.a.distanceTo(edge.b);

      if (edgeLength < MIN_LEDGE_EDGE_LENGTH || Math.abs(edge.a.y - edge.b.y) > 0.12) {
        continue;
      }

      const neighbors = edgeMap.get(edge.key) ?? [];
      const side = neighbors
        .map((entry) => records[entry.triangleIndex])
        .find((neighbor) => neighbor !== record && Math.abs(neighbor.normal.y) < SIDE_NORMAL_Y);

      if (!side) {
        continue;
      }

      const candidate = createLedgeCandidateFromEdge({ building, edge, side, topRecordsByYBucket });

      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return mergeLedgeCandidates({
    building,
    candidates: filterInteriorLedgeCandidates(candidates),
  });
}

function buildTriangleRecords({ vertices, indices }) {
  const records = [];
  const edgeMap = new Map();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  // Weld pass: one quantized-position id per vertex index (1 mm, same welding
  // tolerance the old toFixed(3) string keys encoded) so edge identity becomes
  // a NUMBER. The old path built two `x,y,z` strings + one `a|b` concat PER
  // EDGE (9 strings/triangle) — those keys dominated the city chunk worker
  // profile (~10 s of the ~13.5 s ledge extraction per worker in the ultra
  // city trace). Here each vertex is stringified once, edges are pure math.
  const vertexCount = vertices.length / 3;
  const weldIds = new Uint32Array(vertexCount);
  const weldMap = new Map();
  for (let i = 0; i < vertexCount; i += 1) {
    const o = i * 3;
    const key =
      `${Math.round(vertices[o] * 1000)},${Math.round(vertices[o + 1] * 1000)},${Math.round(vertices[o + 2] * 1000)}`;
    let id = weldMap.get(key);
    if (id === undefined) {
      id = weldMap.size;
      weldMap.set(key, id);
    }
    weldIds[i] = id;
  }
  // Welded ids are < vertexCount, so lo*vertexCount+hi is collision-free and
  // stays far below Number.MAX_SAFE_INTEGER for any realistic mesh.
  const edgeKeyOf = (ia, ib) => {
    const wa = weldIds[ia];
    const wb = weldIds[ib];
    return wa < wb ? wa * vertexCount + wb : wb * vertexCount + wa;
  };

  for (let index = 0; index < indices.length; index += 3) {
    const ia = indices[index];
    const ib = indices[index + 1];
    const ic = indices[index + 2];
    setPointFromMesh(a, vertices, ia);
    setPointFromMesh(b, vertices, ib);
    setPointFromMesh(c, vertices, ic);

    const normal = new THREE.Vector3().crossVectors(
      ab.subVectors(b, a),
      ac.subVectors(c, a),
    );
    const area = normal.length() * 0.5;

    if (area < 0.0001) {
      continue;
    }

    normal.normalize();
    const triangleIndex = records.length;
    // Edges share the SAME cloned Vector3s as `points` (every downstream
    // consumer reads, never mutates) — 3 vector allocations per triangle
    // instead of 9.
    const pa = a.clone();
    const pb = b.clone();
    const pc = c.clone();
    const edges = [
      { a: pa, b: pb, key: edgeKeyOf(ia, ib) },
      { a: pb, b: pc, key: edgeKeyOf(ib, ic) },
      { a: pc, b: pa, key: edgeKeyOf(ic, ia) },
    ];
    const record = {
      normal,
      top: normal.y > TOP_NORMAL_Y,
      points: [pa, pb, pc],
      edges,
    };

    records.push(record);

    for (const edge of edges) {
      let list = edgeMap.get(edge.key);
      if (!list) {
        list = [];
        edgeMap.set(edge.key, list);
      }
      list.push({ triangleIndex });
    }
  }

  return { records, edgeMap };
}

function createLedgeCandidateFromEdge({ building, edge, side, topRecordsByYBucket }) {
  const midpoint = new THREE.Vector3().addVectors(edge.a, edge.b).multiplyScalar(0.5);
  const outward = new THREE.Vector3(side.normal.x, 0, side.normal.z);

  if (outward.lengthSq() < 0.0001) {
    outward.set(midpoint.x - building.centerX, 0, midpoint.z - building.centerZ);
  }

  if (outward.lengthSq() < 0.0001) {
    return null;
  }

  outward.normalize();

  const centerOut = new THREE.Vector3(midpoint.x - building.centerX, 0, midpoint.z - building.centerZ);
  if (centerOut.lengthSq() > 0.0001 && outward.dot(centerOut.normalize()) < 0) {
    outward.multiplyScalar(-1);
  }

  const edgeDelta = new THREE.Vector3().subVectors(edge.b, edge.a);
  const snapped = snapNormalToCardinal(outward);

  if (!snapped) {
    return null;
  }

  const axis = snapped.axis;
  const edgeAxisLength = axis === 'x' ? Math.abs(edgeDelta.x) : Math.abs(edgeDelta.z);
  const offAxisLength = axis === 'x' ? Math.abs(edgeDelta.z) : Math.abs(edgeDelta.x);

  if (edgeAxisLength < MIN_LEDGE_EDGE_LENGTH || edgeAxisLength < offAxisLength * 1.35) {
    return null;
  }

  const min = axis === 'x'
    ? Math.min(edge.a.x, edge.b.x)
    : Math.min(edge.a.z, edge.b.z);
  const max = axis === 'x'
    ? Math.max(edge.a.x, edge.b.x)
    : Math.max(edge.a.z, edge.b.z);
  const fixed = axis === 'x' ? midpoint.z : midpoint.x;

  // Measure how far the contiguous top surface extends INWARD from this edge,
  // aggregating every top-facing triangle in this ledge's height band and
  // along-span. The old per-triangle measurement returned one triangle's
  // altitude (~mesh resolution), which made large flat roofs read as ~0.6 m
  // and blocked top-outs onto standable roofs.
  const shelfDepth = measureShelfDepth({
    topRecordsByYBucket,
    y: midpoint.y,
    axis,
    min,
    max,
    midpoint,
    outward,
  });

  if (shelfDepth < MIN_TOP_SURFACE_DEPTH) {
    return null;
  }

  return {
    face: snapped.face,
    axis,
    min,
    max,
    y: midpoint.y,
    fixed,
    x: axis === 'z' ? fixed : (edge.a.x + edge.b.x) * 0.5,
    z: axis === 'x' ? fixed : (edge.a.z + edge.b.z) * 0.5,
    normal: snapped.normal,
    tangent: tangentForFace(snapped.face),
    shelfDepth,
  };
}

// Group top-facing triangle records by quantized centroid y so shelf-depth
// scans only touch one floor of the mesh instead of the whole building.
function buildTopRecordsByYBucket(records) {
  const buckets = new Map();

  for (const record of records) {
    if (!record.top) {
      continue;
    }

    const centroidY = (record.points[0].y + record.points[1].y + record.points[2].y) / 3;
    const bucket = Math.round(centroidY / SHELF_DEPTH_Y_BUCKET);
    let arr = buckets.get(bucket);

    if (!arr) {
      arr = [];
      buckets.set(bucket, arr);
    }

    arr.push(record);
  }

  return buckets;
}

function measureShelfDepth({ topRecordsByYBucket, y, axis, min, max, midpoint, outward }) {
  let best = 0;
  const lo = Math.floor((y - SHELF_DEPTH_Y_TOLERANCE) / SHELF_DEPTH_Y_BUCKET);
  const hi = Math.ceil((y + SHELF_DEPTH_Y_TOLERANCE) / SHELF_DEPTH_Y_BUCKET);

  for (let bucket = lo; bucket <= hi; bucket += 1) {
    const arr = topRecordsByYBucket.get(bucket);

    if (!arr) {
      continue;
    }

    for (const record of arr) {
      for (const point of record.points) {
        if (Math.abs(point.y - y) > SHELF_DEPTH_Y_TOLERANCE) {
          continue;
        }

        const along = axis === 'x' ? point.x : point.z;

        if (along < min - SHELF_DEPTH_ALONG_MARGIN || along > max + SHELF_DEPTH_ALONG_MARGIN) {
          continue;
        }

        // Inward distance from the ledge edge (positive = toward building interior).
        const inward = -((point.x - midpoint.x) * outward.x + (point.z - midpoint.z) * outward.z);

        if (inward > best) {
          best = inward;
        }
      }
    }
  }

  return best;
}

function filterInteriorLedgeCandidates(candidates) {
  return candidates.filter((candidate, index) => {
    const candidateExterior = exteriorLedgePlaneValue(candidate);

    for (let otherIndex = 0; otherIndex < candidates.length; otherIndex += 1) {
      if (otherIndex === index) {
        continue;
      }

      const other = candidates[otherIndex];

      if (
        other.face !== candidate.face ||
        other.axis !== candidate.axis ||
        Math.abs(other.y - candidate.y) > INTERIOR_LEDGE_VERTICAL_MARGIN ||
        ledgeOverlap(candidate, other) < INTERIOR_LEDGE_MIN_OVERLAP
      ) {
        continue;
      }

      if (exteriorLedgePlaneValue(other) > candidateExterior + INTERIOR_LEDGE_PLANE_MARGIN) {
        return false;
      }
    }

    return true;
  });
}

function exteriorLedgePlaneValue(candidate) {
  const normalSign = candidate.axis === 'x'
    ? Math.sign(candidate.normal.z)
    : Math.sign(candidate.normal.x);
  const fixed = Number.isFinite(candidate.fixed)
    ? candidate.fixed
    : candidate.axis === 'x'
      ? candidate.z
      : candidate.x;
  return fixed * (normalSign || 1);
}

function ledgeOverlap(a, b) {
  return Math.min(a.max, b.max) - Math.max(a.min, b.min);
}

function snapNormalToCardinal(normal) {
  if (Math.abs(normal.x) >= Math.abs(normal.z)) {
    const sign = normal.x >= 0 ? 1 : -1;
    return {
      face: sign > 0 ? 'right' : 'left',
      axis: 'z',
      normal: { x: sign, y: 0, z: 0 },
    };
  }

  const sign = normal.z >= 0 ? 1 : -1;
  return {
    face: sign > 0 ? 'front' : 'back',
    axis: 'x',
    normal: { x: 0, y: 0, z: sign },
  };
}

function tangentForFace(face) {
  return {
    front: { x: 1, y: 0, z: 0 },
    back: { x: -1, y: 0, z: 0 },
    left: { x: 0, y: 0, z: 1 },
    right: { x: 0, y: 0, z: -1 },
  }[face];
}

function mergeLedgeCandidates({ building, candidates }) {
  const groups = new Map();

  for (const candidate of candidates) {
    const key = [
      candidate.face,
      candidate.axis,
      Math.round(candidate.fixed / LEDGE_PLANE_SNAP),
      Math.round(candidate.y / LEDGE_HEIGHT_SNAP),
    ].join(':');

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(candidate);
  }

  const ledges = [];

  for (const group of groups.values()) {
    group.sort((a, b) => a.min - b.min);
    let current = null;

    for (const segment of group) {
      if (!current) {
        current = { ...segment };
        continue;
      }

      if (segment.min <= current.max + LEDGE_MERGE_GAP) {
        current.max = Math.max(current.max, segment.max);
        current.y = Math.max(current.y, segment.y);
        current.shelfDepth = Math.min(current.shelfDepth ?? Infinity, segment.shelfDepth ?? Infinity);
        current.fixed = (current.fixed + segment.fixed) * 0.5;
        current.x = current.axis === 'z' ? current.fixed : (current.min + current.max) * 0.5;
        current.z = current.axis === 'x' ? current.fixed : (current.min + current.max) * 0.5;
        continue;
      }

      pushMergedLedge({ ledges, building, candidate: current });
      current = { ...segment };
    }

    if (current) {
      pushMergedLedge({ ledges, building, candidate: current });
    }
  }

  ledges.sort((a, b) => (a.blockName.localeCompare(b.blockName) || a.y - b.y || a.face.localeCompare(b.face) || a.min - b.min));
  ledges.forEach((ledge, index) => {
    ledge.levelIndex = index;
    ledge.name = `${ledge.name} ${index + 1}`;
  });
  return ledges;
}

function pushMergedLedge({ ledges, building, candidate }) {
  if (candidate.max - candidate.min < MIN_LEDGE_SPAN) {
    return;
  }

  ledges.push(createLedge({
    building,
    face: candidate.face,
    axis: candidate.axis,
    min: candidate.min,
    max: candidate.max,
    y: candidate.y,
    x: candidate.axis === 'z' ? candidate.fixed : (candidate.min + candidate.max) * 0.5,
    z: candidate.axis === 'x' ? candidate.fixed : (candidate.min + candidate.max) * 0.5,
    normal: candidate.normal,
    tangent: candidate.tangent,
    shelfDepth: candidate.shelfDepth,
  }));
}

function createLedge({ building, face, axis, min, max, y, x, z, normal, tangent, shelfDepth = Infinity }) {
  return {
    name: `${building.name} ${face} Ledge`,
    blockName: building.name,
    face,
    hangMode: y > building.collider.bottomY + 46 ? 'free' : 'braced',
    axis,
    min,
    max,
    y,
    x,
    z,
    normal,
    tangent,
    shelfDepth,
    snapPoints: createSnapPoints({ axis, min, max, y, x, z, normal, tangent }),
  };
}

function createSnapPoints({ axis, min, max, y, x, z, normal, tangent }) {
  const span = max - min;
  const count = Math.max(2, Math.floor(span / LEDGE_SNAP_POINT_SPACING) + 1);
  const points = [];

  for (let index = 0; index < count; index += 1) {
    const alpha = count === 1 ? 0 : index / (count - 1);
    const along = THREE.MathUtils.lerp(min + 0.18, max - 0.18, alpha);
    points.push({
      along,
      x: axis === 'x' ? along : x,
      y,
      z: axis === 'z' ? along : z,
      normal,
      tangent,
    });
  }

  return points;
}

function addFallbackRoofLedge({ ledges, building, face }) {
  const min = face.min + 0.8;
  const max = face.max - 0.8;

  if (max - min < MIN_LEDGE_SPAN) {
    return;
  }

  ledges.push(createLedge({
    building,
    face: face.face,
    axis: face.axis,
    min,
    max,
    y: building.collider.topY,
    x: face.x,
    z: face.z,
    normal: face.normal,
    tangent: face.tangent,
  }));
}

function addWallRunSurface({ wallRunSurfaces, building, face }) {
  const minU = SURFACE_SIDE_MARGIN;
  const maxU = face.span - SURFACE_SIDE_MARGIN;

  if (maxU - minU < MIN_WALL_RUN_SPAN) {
    return;
  }

  wallRunSurfaces.push({
    name: `${building.name} ${face.face} Wall Run`,
    blockName: building.name,
    face: face.face,
    origin: surfaceOrigin(face, building.collider.bottomY + WALL_RUN_MIN_V),
    normal: face.normal,
    tangent: face.tangent,
    up: { x: 0, y: 1, z: 0 },
    minU,
    maxU,
    minV: 0,
    maxV: Math.min(WALL_RUN_MAX_V - WALL_RUN_MIN_V, building.height - 0.8),
    rootOffset: 0.42,
    handYOffset: 1.22,
    handForwardOffset: -0.28,
    handNormalOffset: 0.02,
  });
}

function extractClimbPanels(building) {
  const physicsMesh = building.collider.physicsMesh;
  const vertices = physicsMesh?.vertices;
  const indices = physicsMesh?.traversalIndices ?? physicsMesh?.indices;

  if (!(vertices instanceof Float32Array) || !(indices instanceof Uint32Array)) {
    return [];
  }

  const groups = new Map();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  for (let index = 0; index < indices.length; index += 3) {
    setPointFromMesh(a, vertices, indices[index]);
    setPointFromMesh(b, vertices, indices[index + 1]);
    setPointFromMesh(c, vertices, indices[index + 2]);

    const normal = new THREE.Vector3().crossVectors(
      ab.subVectors(b, a),
      ac.subVectors(c, a),
    );
    const area = normal.length() * 0.5;

    if (area < 0.0001) {
      continue;
    }

    normal.normalize();

    if (Math.abs(normal.y) > SIDE_NORMAL_Y) {
      continue;
    }

    const centroid = new THREE.Vector3()
      .add(a)
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3);
    const outward = new THREE.Vector3(normal.x, 0, normal.z);

    if (outward.lengthSq() <= 0.0001) {
      continue;
    }

    outward.normalize();

    const centerOut = new THREE.Vector3(centroid.x - building.centerX, 0, centroid.z - building.centerZ);
    if (centerOut.lengthSq() > 0.0001 && outward.dot(centerOut.normalize()) < 0) {
      outward.multiplyScalar(-1);
    }

    const snapped = snapNormalToCardinal(outward);
    const axis = snapped.axis;
    const fixed = axis === 'x'
      ? (a.z + b.z + c.z) / 3
      : (a.x + b.x + c.x) / 3;
    const min = axis === 'x'
      ? Math.min(a.x, b.x, c.x)
      : Math.min(a.z, b.z, c.z);
    const max = axis === 'x'
      ? Math.max(a.x, b.x, c.x)
      : Math.max(a.z, b.z, c.z);
    const minY = Math.min(a.y, b.y, c.y);
    const maxY = Math.max(a.y, b.y, c.y);

    if (max - min < 0.18 || maxY - minY < 0.18) {
      continue;
    }

    const key = [
      snapped.face,
      axis,
      Math.round(fixed / CLIMB_PANEL_PLANE_SNAP),
    ].join(':');

    if (!groups.has(key)) {
      groups.set(key, {
        face: snapped.face,
        axis,
        fixed,
        min,
        max,
        minY,
        maxY,
        area: 0,
        normal: snapped.normal,
        tangent: tangentForFace(snapped.face),
      });
    }

    const group = groups.get(key);
    group.fixed = (group.fixed + fixed) * 0.5;
    group.min = Math.min(group.min, min);
    group.max = Math.max(group.max, max);
    group.minY = Math.min(group.minY, minY);
    group.maxY = Math.max(group.maxY, maxY);
    group.area += area;
  }

  const byFace = new Map();

  for (const panel of groups.values()) {
    const span = panel.max - panel.min;
    const height = panel.maxY - panel.minY;
    const coverage = panel.area / Math.max(0.001, span * height);

    if (
      span < MIN_CLIMB_PANEL_SPAN ||
      height < MIN_CLIMB_PANEL_HEIGHT ||
      coverage < MIN_CLIMB_PANEL_COVERAGE
    ) {
      continue;
    }

    panel.coverage = coverage;
    panel.score = span * Math.min(height, MAX_CLIMB_STEP_HEIGHT * 1.5) * coverage;

    if (!byFace.has(panel.face)) {
      byFace.set(panel.face, []);
    }

    byFace.get(panel.face).push(panel);
  }

  const panels = [];

  for (const facePanels of byFace.values()) {
    panels.push(...facePanels);
  }

  return panels;
}

function addClimbSurfacesFromPanels({ climbSurfaces, building, panels, ledges }) {
  const routesByFace = new Map();
  const wallGroups = groupLedgesByWall(ledges);

  for (const wallLedges of wallGroups.values()) {
    const samples = sampleRouteAlongPoints(wallLedges);

    for (const along of samples) {
      const route = buildLedgeColumnRoute({ building, panels, ledges: wallLedges, along });

      if (!route || route.steps.length < MIN_CLIMB_ROUTE_STEPS || route.gain < MIN_CLIMB_ROUTE_GAIN) {
        continue;
      }

      if (!routesByFace.has(route.face)) {
        routesByFace.set(route.face, []);
      }

      routesByFace.get(route.face).push(route);
    }
  }

  for (const routes of routesByFace.values()) {
    routes.sort((a, b) => b.score - a.score);

    for (const route of routes.slice(0, MAX_CLIMB_ROUTES_PER_FACE)) {
      for (const step of route.steps) {
        const surface = createClimbSurfaceFromRouteStep({
          building,
          step,
          index: climbSurfaces.length + 1,
        });

        if (surface) {
          climbSurfaces.push(surface);
        }
      }
    }
  }
}

function groupLedgesByWall(ledges) {
  const groups = new Map();

  for (const ledge of ledges) {
    const fixed = ledge.axis === 'x' ? ledge.z : ledge.x;
    const key = [
      ledge.blockName,
      ledge.face,
      ledge.axis,
      Math.round(fixed / CLIMB_PANEL_PLANE_SNAP),
    ].join(':');

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(ledge);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.y - b.y || a.min - b.min);
  }

  return groups;
}

function sampleRouteAlongPoints(ledges) {
  const samples = new Set();

  for (const ledge of ledges) {
    const min = ledge.min + MIN_CLIMB_LEDGE_OVERLAP * 0.5;
    const max = ledge.max - MIN_CLIMB_LEDGE_OVERLAP * 0.5;

    if (max <= min) {
      continue;
    }

    for (let along = min; along <= max; along += CLIMB_ROUTE_SAMPLE_SPACING) {
      samples.add(Math.round(along / 0.5) * 0.5);
    }

    samples.add(Math.round(((min + max) * 0.5) / 0.5) * 0.5);
  }

  return [...samples].sort((a, b) => a - b);
}

function buildLedgeColumnRoute({ building, panels, ledges, along }) {
  const targets = selectColumnTargets({ ledges, along });
  const steps = [];
  let lowerY = building.collider.bottomY + CLIMB_MIN_V;
  let overlapTotal = 0;

  for (const upper of targets) {
    const verticalGap = upper.y - lowerY;

    if (verticalGap < MIN_CLIMB_STEP_HEIGHT || verticalGap > MAX_CLIMB_STEP_HEIGHT) {
      continue;
    }

    const panel = findSupportingPanelForStep({ panels, ledge: upper, along, lowerY, upperY: upper.y });

    if (!panel) {
      continue;
    }

    const overlap = Math.min(panel.max, upper.max) - Math.max(panel.min, upper.min);

    if (overlap < MIN_CLIMB_LEDGE_OVERLAP) {
      continue;
    }

    steps.push({
      panel,
      lowerY,
      upper,
      verticalGap,
      overlap,
      along,
    });
    overlapTotal += overlap;
    lowerY = upper.y;
  }

  if (steps.length === 0) {
    return null;
  }

  const firstY = building.collider.bottomY + CLIMB_MIN_V;
  const lastY = steps[steps.length - 1].upper.y;
  const gain = lastY - firstY;
  const routeDensity = steps.length / Math.max(1, gain);
  const score =
    gain * 2.8 +
    steps.length * 18 +
    overlapTotal * 0.9 +
    routeDensity * 24;

  return {
    face: steps[0].upper.face,
    steps,
    gain,
    score,
  };
}

function selectColumnTargets({ ledges, along }) {
  const byHeight = new Map();

  for (const ledge of ledges) {
    if (along < ledge.min + MIN_CLIMB_LEDGE_OVERLAP * 0.5 || along > ledge.max - MIN_CLIMB_LEDGE_OVERLAP * 0.5) {
      continue;
    }

    const heightKey = Math.round(ledge.y / 2);
    const existing = byHeight.get(heightKey);

    if (!existing || (ledge.max - ledge.min) > (existing.max - existing.min)) {
      byHeight.set(heightKey, ledge);
    }
  }

  return [...byHeight.values()].sort((a, b) => a.y - b.y || b.max - b.min - (a.max - a.min));
}

function findSupportingPanelForStep({ panels, ledge, along, lowerY, upperY }) {
  const ledgeFixed = ledge.axis === 'x' ? ledge.z : ledge.x;
  let bestPanel = null;
  let bestScore = Infinity;

  for (const panel of panels) {
    if (panel.face !== ledge.face || panel.axis !== ledge.axis) {
      continue;
    }

    if (
      along < panel.min + MIN_CLIMB_LEDGE_OVERLAP * 0.5 ||
      along > panel.max - MIN_CLIMB_LEDGE_OVERLAP * 0.5 ||
      Math.abs(ledgeFixed - panel.fixed) > CLIMB_PANEL_LEDGE_TOLERANCE ||
      panel.minY > lowerY + 1.2 ||
      panel.maxY < upperY - 0.7
    ) {
      continue;
    }

    const score = Math.abs(ledgeFixed - panel.fixed) + Math.abs((panel.min + panel.max) * 0.5 - along) * 0.02;

    if (score < bestScore) {
      bestScore = score;
      bestPanel = panel;
    }
  }

  return bestPanel;
}

function createClimbSurfaceFromRouteStep({ building, step, index }) {
  const { panel, upper, lowerY, along } = step;
  const availableMin = Math.max(panel.min, upper.min);
  const availableMax = Math.min(panel.max, upper.max);
  const laneWidth = Math.min(CLIMB_LANE_WIDTH, availableMax - availableMin);
  const center = THREE.MathUtils.clamp(along, availableMin + laneWidth * 0.5, availableMax - laneWidth * 0.5);
  const min = center - laneWidth * 0.5;
  const max = center + laneWidth * 0.5;
  const span = max - min;

  if (span < MIN_CLIMB_LEDGE_OVERLAP) {
    return null;
  }

  const origin = climbSurfaceOriginFromPanel({ panel, laneMin: min, laneMax: max, y: lowerY });
  const maxV = upper.y - lowerY;

  if (maxV < MIN_CLIMB_STEP_HEIGHT) {
    return null;
  }

  return {
    name: `${building.name} ${panel.face} Climb ${index}`,
    blockName: building.name,
    face: panel.face,
    origin,
    normal: panel.normal,
    tangent: panel.tangent,
    up: { x: 0, y: 1, z: 0 },
    minU: 0,
    maxU: laneWidth,
    minV: 0,
    maxV,
    rootOffset: 0.42,
    targetLedgeName: upper.name,
  };
}

function climbSurfaceOriginFromPanel({ panel, laneMin, laneMax, y }) {
  if (panel.axis === 'x') {
    return {
      x: panel.tangent.x >= 0 ? laneMin : laneMax,
      y,
      z: panel.fixed,
    };
  }

  return {
    x: panel.fixed,
    y,
    z: panel.tangent.z >= 0 ? laneMin : laneMax,
  };
}

function surfaceOrigin(face, y) {
  if (face.axis === 'x') {
    return {
      x: face.tangent.x >= 0 ? face.min : face.max,
      y,
      z: face.z,
    };
  }

  return {
    x: face.x,
    y,
    z: face.tangent.z >= 0 ? face.min : face.max,
  };
}

function connectWallRunSurfaces(surfaces) {
  const byBlockFace = new Map(surfaces.map((surface) => [`${surface.blockName}:${surface.face}`, surface]));

  for (const surface of surfaces) {
    const next = byBlockFace.get(`${surface.blockName}:${nextFace(surface.face)}`);
    const previous = byBlockFace.get(`${surface.blockName}:${previousFace(surface.face)}`);

    if (next && cornerNormalsMeet(surface, next)) {
      surface.nextSurfaceName = next.name;
    }

    if (previous && cornerNormalsMeet(surface, previous)) {
      surface.previousSurfaceName = previous.name;
    }
  }
}

function nextFace(face) {
  return {
    front: 'right',
    right: 'back',
    back: 'left',
    left: 'front',
  }[face];
}

function previousFace(face) {
  return {
    front: 'left',
    left: 'back',
    back: 'right',
    right: 'front',
  }[face];
}

function cornerNormalsMeet(a, b) {
  const an = new THREE.Vector3(a.normal.x, 0, a.normal.z);
  const bn = new THREE.Vector3(b.normal.x, 0, b.normal.z);
  return Math.abs(an.dot(bn)) < 0.1;
}

function setPointFromMesh(target, vertices, index) {
  const offset = index * 3;
  target.set(vertices[offset], vertices[offset + 1], vertices[offset + 2]);
  return target;
}

function collectFaceCoordinate({ coordinates, face, point, minY, maxY }) {
  if (point.y < minY || point.y > maxY) {
    return;
  }

  coordinates.push(face.axis === 'x' ? point.z : point.x);
}

function quantile(values, amount) {
  if (values.length === 1) {
    return values[0];
  }

  const index = THREE.MathUtils.clamp(Math.round((values.length - 1) * amount), 0, values.length - 1);
  return values[index];
}

function addLineGroup({ group, name, vertices, color }) {
  if (vertices.length === 0) {
    return;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = name;
  lines.userData.debugOverlay = 'traversal';
  lines.frustumCulled = false;
  group.add(lines);
}

function ledgeVertices(ledges) {
  const vertices = [];

  for (const ledge of ledges) {
    const start = ledgePoint(ledge, ledge.min);
    const end = ledgePoint(ledge, ledge.max);
    vertices.push(...start, ...end);
  }

  return vertices;
}

function snapPointVertices(ledges) {
  const vertices = [];
  const size = 0.16;

  for (const ledge of ledges) {
    for (const point of ledge.snapPoints ?? []) {
      vertices.push(
        point.x - ledge.tangent.x * size,
        point.y,
        point.z - ledge.tangent.z * size,
        point.x + ledge.tangent.x * size,
        point.y,
        point.z + ledge.tangent.z * size,
        point.x,
        point.y - size,
        point.z,
        point.x,
        point.y + size,
        point.z,
      );
    }
  }

  return vertices;
}

function surfaceRectVertices(surfaces) {
  const vertices = [];

  for (const surface of surfaces) {
    const corners = [
      surfacePoint(surface, surface.minU, surface.minV),
      surfacePoint(surface, surface.maxU, surface.minV),
      surfacePoint(surface, surface.maxU, surface.maxV),
      surfacePoint(surface, surface.minU, surface.maxV),
    ];
    vertices.push(
      ...corners[0], ...corners[1],
      ...corners[1], ...corners[2],
      ...corners[2], ...corners[3],
      ...corners[3], ...corners[0],
    );
  }

  return vertices;
}

function ledgePoint(ledge, along) {
  return [
    ledge.axis === 'x' ? along : ledge.x,
    ledge.y,
    ledge.axis === 'z' ? along : ledge.z,
  ];
}

function surfacePoint(surface, u, v) {
  return [
    surface.origin.x + surface.tangent.x * u + surface.up.x * v,
    surface.origin.y + surface.tangent.y * u + surface.up.y * v,
    surface.origin.z + surface.tangent.z * u + surface.up.z * v,
  ];
}
