import * as THREE from 'three';

const blockMaterial = new THREE.MeshStandardMaterial({
  color: 0xbfc3b4,
  roughness: 0.92,
  metalness: 0.02,
});
const stepMaterial = new THREE.MeshStandardMaterial({
  color: 0xd7d2bd,
  roughness: 0.9,
  metalness: 0.01,
});
const pitchMaterial = new THREE.MeshStandardMaterial({
  color: 0x161412,
  roughness: 0.78,
});
const climbSurfaceMaterial = new THREE.MeshStandardMaterial({
  color: 0x1c1711,
  roughness: 0.84,
  metalness: 0.01,
});
const wallRunPanelMaterial = new THREE.MeshStandardMaterial({
  color: 0xaaa888,
  roughness: 0.86,
  metalness: 0.01,
});
const wallRunMarkMaterial = new THREE.MeshStandardMaterial({
  color: 0x241b12,
  roughness: 0.82,
});
const climbSurfaceLineMaterial = new THREE.LineBasicMaterial({
  color: 0xd2bf7a,
  transparent: true,
  opacity: 0.58,
});
const edgeMaterial = new THREE.LineBasicMaterial({
  color: 0x7f796a,
  transparent: true,
  opacity: 0.42,
});
const ROPE_VISUAL_SEGMENTS = 18;
const ropeTexture = createRopeTexture();
const ropeMaterial = new THREE.MeshStandardMaterial({
  color: 0xd3c39a,
  map: ropeTexture,
  roughness: 0.96,
  metalness: 0.01,
  side: THREE.DoubleSide,
  transparent: true,
  alphaTest: 0.22,
});

export function createPlatformingArena() {
  const group = new THREE.Group();
  group.name = 'Platforming Test Arena';
  const colliders = [];
  const ledges = [];
  const climbSurfaces = [];
  const wallRunSurfaces = [];
  const ropes = [];

  const blocks = [
    { name: 'West Salt Block', position: [-6.4, 0, -8.8], size: [4.8, 1.2, 5.2] },
    { name: 'East Salt Block', position: [6.2, 0, -10.2], size: [5.6, 2.1, 4.4] },
    { name: 'Rear Ledge Block', position: [0, 0, -18.2], size: [5.2, 2.55, 4.2], ledgeFace: 'front' },
    { name: 'Broken High Block', position: [-5.8, 0, -18.4], size: [3.2, 3.2, 3.2], ledgeFace: 'front' },
    { name: 'Low Landing Slab', position: [5.8, 0, -17.4], size: [4.6, 0.75, 3.6] },
    {
      name: 'Guild Climb Wall',
      position: [0, 0, -29.2],
      size: [13.2, 9.6, 0.9],
      ledgeFace: 'front',
      climbSurface: {
        face: 'front',
        width: 11.4,
        height: 8.55,
        bottom: 0.62,
      },
    },
  ];
  const steps = [
    { name: 'Step Cube 01', position: [0, 0, -5.6], size: [2.6, 0.42, 2.2] },
    { name: 'Step Cube 02', position: [0, 0, -7.9], size: [2.6, 0.84, 2.2] },
    { name: 'Step Cube 03', position: [0, 0, -10.2], size: [2.6, 1.26, 2.2] },
    { name: 'Step Cube 04', position: [0, 0, -12.5], size: [2.6, 1.68, 2.2] },
    { name: 'Step Cube 05', position: [0, 0, -14.8], size: [2.8, 2.1, 2.2], ledgeFace: 'front' },
  ];
  const vaultObstacles = [
    { name: 'Vault Yard Tall Rail', position: [13.2, 0, -12.0], size: [3.6, 0.96, 0.34], vaultable: true, noLedges: true },
    { name: 'Vault Yard Two Thirds Box', position: [13.2, 0, -18.8], size: [3.0, 1.06, 0.48], vaultable: true, noLedges: true },
    { name: 'Vault Yard Tall Narrow Box', position: [8.8, 0, -15.2], size: [2.2, 1.0, 0.42], vaultable: true, noLedges: true },
    { name: 'Vault Yard Tall Side Rail', position: [18.2, 0, -16.2], size: [0.34, 1.02, 3.2], vaultable: true, noLedges: true },
  ];
  const slideObstacles = [
    { name: 'Slide Under Floating Wall 01', position: [-10.8, 0.92, -9.2], size: [4.8, 0.58, 0.42], noLedges: true, noGroundSnap: true },
    { name: 'Slide Under Floating Wall 02', position: [-10.8, 0.88, -14.4], size: [5.4, 0.64, 0.42], noLedges: true, noGroundSnap: true },
    { name: 'Slide Under Floating Wall 03', position: [-10.8, 0.84, -19.8], size: [6.0, 0.7, 0.42], noLedges: true, noGroundSnap: true },
  ];

  for (const block of blocks) {
    addBlock({ group, colliders, ledges, climbSurfaces, block, material: blockMaterial });
  }

  for (const block of steps) {
    addBlock({ group, colliders, ledges, climbSurfaces, block, material: stepMaterial });
  }

  for (const block of vaultObstacles) {
    addBlock({ group, colliders, ledges, climbSurfaces, block, material: stepMaterial });
  }

  for (const block of slideObstacles) {
    addBlock({ group, colliders, ledges, climbSurfaces, block, material: stepMaterial });
  }

  addWallRunLane({ group, colliders, wallRunSurfaces });

  addRope({
    group,
    ropes,
    name: 'Guild Practice Rope',
    anchor: new THREE.Vector3(3.85, 5.85, -12.7),
    length: 5.05,
    radius: 0.085,
    swingTangent: new THREE.Vector3(1, 0, 0),
  });

  return {
    group,
    colliders,
    ledges,
    climbSurfaces,
    wallRunSurfaces,
    ropes,
  };
}

function addBlock({ group, colliders, ledges, climbSurfaces, block, material }) {
  const [width, height, depth] = block.size;
  const [x, y, z] = block.position;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.name = block.name;
  mesh.position.set(x, y + height * 0.5, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial);
  edges.name = `${block.name} Edges`;
  edges.position.copy(mesh.position);
  group.add(edges);

  const collider = {
    name: block.name,
    minX: x - width * 0.5,
    maxX: x + width * 0.5,
    minZ: z - depth * 0.5,
    maxZ: z + depth * 0.5,
    topY: y + height,
    bottomY: y,
    width,
    depth,
    vaultable: block.vaultable === true,
    noGroundSnap: block.noGroundSnap === true,
  };
  colliders.push(collider);

  if (!block.noLedges) {
    addTopLedges({ ledges, block, collider });
  }

  if (block.ledgeFace) {
    addPitchLedge({ group, block, collider, face: block.ledgeFace });
  }

  if (block.climbSurface) {
    addClimbSurface({ group, climbSurfaces, block, collider });
  }
}

function addTopLedges({ ledges, block, collider }) {
  const [width, height, depth] = block.size;
  const [x, y, z] = block.position;
  const topY = y + height;
  const hangModes = resolveBlockHangModes(block);

  ledges.push(
    {
      name: `${block.name} Front Top Ledge`,
      blockName: block.name,
      face: 'front',
      hangMode: hangModes.front,
      axis: 'x',
      min: collider.minX,
      max: collider.maxX,
      y: topY,
      x,
      z: collider.maxZ,
      normal: { x: 0, y: 0, z: 1 },
      tangent: { x: 1, y: 0, z: 0 },
    },
    {
      name: `${block.name} Back Top Ledge`,
      blockName: block.name,
      face: 'back',
      hangMode: hangModes.back,
      axis: 'x',
      min: collider.minX,
      max: collider.maxX,
      y: topY,
      x,
      z: collider.minZ,
      normal: { x: 0, y: 0, z: -1 },
      tangent: { x: -1, y: 0, z: 0 },
    },
    {
      name: `${block.name} Left Top Ledge`,
      blockName: block.name,
      face: 'left',
      hangMode: hangModes.left,
      axis: 'z',
      min: collider.minZ,
      max: collider.maxZ,
      y: topY,
      x: collider.minX,
      z,
      normal: { x: -1, y: 0, z: 0 },
      tangent: { x: 0, y: 0, z: 1 },
    },
    {
      name: `${block.name} Right Top Ledge`,
      blockName: block.name,
      face: 'right',
      hangMode: hangModes.right,
      axis: 'z',
      min: collider.minZ,
      max: collider.maxZ,
      y: topY,
      x: collider.maxX,
      z,
      normal: { x: 1, y: 0, z: 0 },
      tangent: { x: 0, y: 0, z: -1 },
    },
  );
}

function resolveBlockHangModes(block) {
  const fallback = normalizeHangMode(block.hangMode ?? block.ledgeHangMode) ?? 'braced';
  const faceModes = block.hangModes ?? {};

  return {
    front: normalizeHangMode(faceModes.front) ?? fallback,
    back: normalizeHangMode(faceModes.back) ?? fallback,
    left: normalizeHangMode(faceModes.left) ?? fallback,
    right: normalizeHangMode(faceModes.right) ?? fallback,
  };
}

function normalizeHangMode(mode) {
  return mode === 'free' || mode === 'braced'
    ? mode
    : null;
}

function addPitchLedge({ group, block, collider, face }) {
  const [width, height, depth] = block.size;
  const [x, y, z] = block.position;
  const ledgeHeight = y + height - 0.18;
  const isFront = face === 'front';
  const strip = new THREE.Mesh(new THREE.BoxGeometry(width * 0.82, 0.1, 0.055), pitchMaterial);
  strip.name = `${block.name} Pitch Ledge`;
  strip.position.set(x, ledgeHeight, z + (isFront ? depth * 0.5 + 0.031 : -depth * 0.5 - 0.031));
  group.add(strip);

  return strip;
}

function addClimbSurface({ group, climbSurfaces, block, collider }) {
  const { climbSurface } = block;
  const [blockWidth, , blockDepth] = block.size;
  const [x, , z] = block.position;
  const width = Math.min(climbSurface.width ?? blockWidth * 0.84, blockWidth - 0.42);
  const height = climbSurface.height ?? Math.max(1, collider.topY - collider.bottomY - 0.8);
  const bottom = climbSurface.bottom ?? collider.bottomY + 0.55;
  const centerY = bottom + height * 0.5;
  const isFront = climbSurface.face !== 'back';
  const normalZ = isFront ? 1 : -1;
  const surfaceZ = z + normalZ * (blockDepth * 0.5 + 0.037);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.045), climbSurfaceMaterial);
  panel.name = `${block.name} Climbable Pitch Surface`;
  panel.position.set(x, centerY, surfaceZ);
  panel.castShadow = false;
  panel.receiveShadow = true;
  group.add(panel);

  const verticalMarks = 5;
  const horizontalMarks = 7;
  const lineGeometry = new THREE.BufferGeometry();
  const positions = [];
  const left = x - width * 0.5;
  const right = x + width * 0.5;
  const bottomY = bottom;
  const topY = bottom + height;
  const lineZ = surfaceZ + normalZ * 0.032;

  for (let index = 1; index < verticalMarks; index += 1) {
    const markX = THREE.MathUtils.lerp(left, right, index / verticalMarks);
    positions.push(markX, bottomY, lineZ, markX, topY, lineZ);
  }

  for (let index = 1; index < horizontalMarks; index += 1) {
    const markY = THREE.MathUtils.lerp(bottomY, topY, index / horizontalMarks);
    positions.push(left, markY, lineZ, right, markY, lineZ);
  }

  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(lineGeometry, climbSurfaceLineMaterial);
  lines.name = `${block.name} Climb Surface Route Marks`;
  group.add(lines);

  climbSurfaces.push({
    name: `${block.name} Front Climb Surface`,
    blockName: block.name,
    face: climbSurface.face ?? 'front',
    origin: { x, y: bottom, z: surfaceZ },
    normal: { x: 0, y: 0, z: normalZ },
    tangent: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    minU: -width * 0.5,
    maxU: width * 0.5,
    minV: 0.2,
    maxV: height - 0.2,
    rootOffset: 0.38,
  });
}

function addWallRunLane({ group, colliders, wallRunSurfaces }) {
  const loop = [
    {
      name: 'Wall Run Loop North',
      position: [26, 0.55, -35],
      size: [92, 2.95, 0.28],
      normal: [0, 0, 1],
      tangent: [1, 0, 0],
      next: 'Wall Run Loop East Wall Run Surface',
      previous: 'Wall Run Loop West Wall Run Surface',
    },
    {
      name: 'Wall Run Loop East',
      position: [72, 0.55, -15],
      size: [0.28, 2.95, 40],
      normal: [-1, 0, 0],
      tangent: [0, 0, 1],
      next: 'Wall Run Loop South Wall Run Surface',
      previous: 'Wall Run Loop North Wall Run Surface',
    },
    {
      name: 'Wall Run Loop South',
      position: [26, 0.55, 5],
      size: [92, 2.95, 0.28],
      normal: [0, 0, -1],
      tangent: [-1, 0, 0],
      next: 'Wall Run Loop West Wall Run Surface',
      previous: 'Wall Run Loop East Wall Run Surface',
    },
    {
      name: 'Wall Run Loop West',
      position: [-20, 0.55, -15],
      size: [0.28, 2.95, 40],
      normal: [1, 0, 0],
      tangent: [0, 0, -1],
      next: 'Wall Run Loop North Wall Run Surface',
      previous: 'Wall Run Loop South Wall Run Surface',
    },
  ];
  const panels = [
    { name: 'Wall Run North Panel 01', position: [25.8, 0.55, -8.2], size: [9.2, 2.65, 0.28], normal: [0, 0, -1], tangent: [1, 0, 0] },
    { name: 'Wall Run South Panel 02', position: [36.0, 0.55, -12.6], size: [9.2, 2.65, 0.28], normal: [0, 0, 1], tangent: [1, 0, 0] },
    { name: 'Wall Run North Panel 03', position: [46.2, 0.55, -8.2], size: [9.2, 2.65, 0.28], normal: [0, 0, -1], tangent: [1, 0, 0] },
    { name: 'Wall Run South Panel 04', position: [56.4, 0.55, -12.6], size: [9.2, 2.65, 0.28], normal: [0, 0, 1], tangent: [1, 0, 0] },
    { name: 'Wall Run Exit Panel 05', position: [66.8, 0.55, -10.4], size: [9.6, 2.85, 0.28], normal: [0, 0, 1], tangent: [1, 0, 0] },
  ];

  for (const panel of loop) {
    addWallRunPanel({ group, colliders, wallRunSurfaces, panel });
  }

  for (const panel of panels) {
    addWallRunPanel({ group, colliders, wallRunSurfaces, panel });
  }
}

function addWallRunPanel({ group, colliders, wallRunSurfaces, panel }) {
  const [width, height, depth] = panel.size;
  const [x, bottomY, z] = panel.position;
  const normal = new THREE.Vector3(panel.normal[0], panel.normal[1], panel.normal[2]).normalize();
  const tangent = panel.tangent
    ? new THREE.Vector3(panel.tangent[0], panel.tangent[1], panel.tangent[2]).normalize()
    : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal).normalize();
  const centerY = bottomY + height * 0.5;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), wallRunPanelMaterial);
  mesh.name = panel.name;
  mesh.position.set(x, centerY, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  const stripeLength = Math.abs(tangent.x) > Math.abs(tangent.z) ? width * 0.88 : depth * 0.88;
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(
      Math.abs(tangent.x) > Math.abs(tangent.z) ? stripeLength : 0.045,
      0.12,
      Math.abs(tangent.z) > Math.abs(tangent.x) ? stripeLength : 0.045,
    ),
    wallRunMarkMaterial,
  );
  stripe.name = `${panel.name} Pitch Run Mark`;
  stripe.position
    .set(x, bottomY + height * 0.64, z)
    .addScaledVector(normal, Math.abs(normal.x) > Math.abs(normal.z) ? width * 0.5 + 0.028 : depth * 0.5 + 0.028);
  stripe.castShadow = false;
  stripe.receiveShadow = true;
  group.add(stripe);

  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial);
  edges.name = `${panel.name} Edges`;
  edges.position.copy(mesh.position);
  group.add(edges);

  const collider = {
    name: panel.name,
    minX: x - width * 0.5,
    maxX: x + width * 0.5,
    minZ: z - depth * 0.5,
    maxZ: z + depth * 0.5,
    topY: bottomY + height,
    bottomY,
    width,
    depth,
    vaultable: false,
  };
  colliders.push(collider);

  const length = Math.abs(tangent.x) > Math.abs(tangent.z) ? width : depth;
  const surfaceOrigin = new THREE.Vector3(x, bottomY, z)
    .addScaledVector(tangent, -length * 0.5)
    .addScaledVector(normal, Math.abs(normal.x) > Math.abs(normal.z) ? width * 0.5 + 0.045 : depth * 0.5 + 0.045);

  wallRunSurfaces.push({
    name: `${panel.name} Wall Run Surface`,
    blockName: panel.name,
    origin: { x: surfaceOrigin.x, y: surfaceOrigin.y, z: surfaceOrigin.z },
    normal: { x: normal.x, y: normal.y, z: normal.z },
    tangent: { x: tangent.x, y: tangent.y, z: tangent.z },
    up: { x: 0, y: 1, z: 0 },
    minU: 0.25,
    maxU: length - 0.25,
    minV: 0.12,
    maxV: height - 0.3,
    rootOffset: 0,
    handYOffset: 1.22,
    handForwardOffset: -0.28,
    handNormalOffset: 0,
    nextSurfaceName: panel.next ?? null,
    previousSurfaceName: panel.previous ?? null,
  });
}

function addRope({ group, ropes, name, anchor, length, radius, swingTangent }) {
  const ropeGroup = new THREE.Group();
  ropeGroup.name = name;
  const center = anchor.clone();
  center.y -= length * 0.5;

  const cardWidth = radius * 3.1;
  const geometry = createRopeRibbonGeometry({
    anchor,
    length,
    width: cardWidth,
    axis: 'x',
    segments: ROPE_VISUAL_SEGMENTS,
  });
  const cardA = new THREE.Mesh(geometry, ropeMaterial);
  cardA.name = `${name} Rope Card A`;
  cardA.castShadow = true;
  cardA.receiveShadow = true;
  ropeGroup.add(cardA);

  const cardB = new THREE.Mesh(createRopeRibbonGeometry({
    anchor,
    length,
    width: cardWidth,
    axis: 'z',
    segments: ROPE_VISUAL_SEGMENTS,
  }), ropeMaterial);
  cardB.name = `${name} Rope Card B`;
  cardB.castShadow = true;
  cardB.receiveShadow = true;
  ropeGroup.add(cardB);

  const lineGeometry = new THREE.CylinderGeometry(radius * 0.42, radius * 0.62, length, 8, 18);
  const lineMaterial = new THREE.MeshStandardMaterial({
    color: 0x7c6845,
    roughness: 1,
    metalness: 0,
  });
  const core = new THREE.Mesh(lineGeometry, lineMaterial);
  core.name = `${name} Rope Core`;
  core.position.copy(center);
  core.castShadow = true;
  core.visible = false;
  ropeGroup.add(core);

  const beam = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 0.26), pitchMaterial);
  beam.name = `${name} Overhead Anchor Beam`;
  beam.position.set(anchor.x, anchor.y + 0.08, anchor.z);
  beam.castShadow = true;
  beam.receiveShadow = true;
  ropeGroup.add(beam);

  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.6, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0x202015, roughness: 0.82 }),
  );
  marker.name = `${name} Pitch Knot`;
  marker.position.copy(anchor);
  marker.castShadow = true;
  ropeGroup.add(marker);

  group.add(ropeGroup);
  ropes.push({
    name,
    anchor: { x: anchor.x, y: anchor.y, z: anchor.z },
    length,
    radius,
    swingTangent: { x: swingTangent.x, y: swingTangent.y, z: swingTangent.z },
    minGrabDistance: 1.05,
    maxGrabDistance: length - 0.45,
    rootHangOffset: 1.18,
    attachRadius: 0.82,
    visual: {
      cardA,
      cardB,
      core,
      width: cardWidth,
      segments: ROPE_VISUAL_SEGMENTS,
    },
  });
}

function createRopeRibbonGeometry({ anchor, length, width, axis, segments }) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const halfWidth = width * 0.5;

  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const y = anchor.y - length * t;
    const offsetA = -halfWidth;
    const offsetB = halfWidth;

    if (axis === 'x') {
      positions.push(anchor.x + offsetA, y, anchor.z, anchor.x + offsetB, y, anchor.z);
    } else {
      positions.push(anchor.x, y, anchor.z + offsetA, anchor.x, y, anchor.z + offsetB);
    }

    uvs.push(0, t, 1, t);
  }

  for (let index = 0; index < segments; index += 1) {
    const a = index * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

function createRopeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 256;
  const context = canvas.getContext('2d');

  context.fillStyle = '#b7a06c';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#6f5d3d';
  context.lineWidth = 5;

  for (let y = -canvas.height; y < canvas.height * 2; y += 18) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y + 34);
    context.stroke();
  }

  context.strokeStyle = '#d9c891';
  context.lineWidth = 3;

  for (let y = -canvas.height; y < canvas.height * 2; y += 18) {
    context.beginPath();
    context.moveTo(canvas.width, y);
    context.lineTo(0, y + 34);
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 4);

  return texture;
}
