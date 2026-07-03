import * as THREE from 'three';

// Wingsuit membrane — Part A, Milestone 0.
//
// Builds the wing membrane as a set of procedural bilinear quad panels whose four
// corners are each pinned to a Mixamo bone. There is NO cloth solver yet: the whole
// sheet is positioned every frame by bilinear interpolation between the corner bone
// positions (see WingsuitSystem), so it follows the arms/legs/torso as the character
// animates and moves. This validates the silhouette + attachment before any verlet
// billow (M2) is layered on the interior.
//
// Key gotcha (see internal wingsuit planning notes): the character skeleton lives under a heavily
// scaled `object` (GLB armature unit scale). To dodge that entirely the membrane is a
// world-space group added straight to the scene, and the driver writes WORLD-space
// vertex positions into it (group stays at identity).

// Mixamo bone names for the four corners of each arm wing.
// Corner layout per panel (u across, v from free edge -> body seam):
//   C00 (u0,v0) = hand   (wing tip / leading anchor)
//   C10 (u1,v0) = foot   (lower trailing anchor)
//   C01 (u0,v1) = shoulder (upper inner, tucked toward the torso)
//   C11 (u1,v1) = hip    (lower inner, tucked toward the torso)
// The v0 edge (hand->foot) is the free trailing edge; the v1 edge (shoulder->hip) is
// the body seam that buries into the torso.
const ARM_PANELS = [
  {
    name: 'Wingsuit Left Arm Membrane',
    gridU: 8,
    gridV: 5,
    corners: [
      { bone: 'mixamorigLeftHand' },
      { bone: 'mixamorigLeftFoot' },
      { bone: 'mixamorigLeftArm' },
      { bone: 'mixamorigLeftUpLeg' },
    ],
  },
  {
    name: 'Wingsuit Right Arm Membrane',
    gridU: 8,
    gridV: 5,
    corners: [
      { bone: 'mixamorigRightHand' },
      { bone: 'mixamorigRightFoot' },
      { bone: 'mixamorigRightArm' },
      { bone: 'mixamorigRightUpLeg' },
    ],
  },
];

// Leg wing — the membrane between the two legs. Both top corners pin to the hips so it
// reads as a triangle fanning down to the feet.
const LEG_PANEL = {
  name: 'Wingsuit Leg Membrane',
  gridU: 6,
  gridV: 4,
  corners: [
    { bone: 'mixamorigLeftFoot' },
    { bone: 'mixamorigRightFoot' },
    { bone: 'mixamorigHips' },
    { bone: 'mixamorigHips' },
  ],
};

export function createWingsuit({ color = 0x8a2f3a, opacity = 0.92 } = {}) {
  const group = new THREE.Group();
  group.name = 'Wingsuit';
  group.matrixAutoUpdate = false; // identity — vertices are written in world space.

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: opacity < 1,
    opacity,
  });

  const panels = [];
  for (const spec of [...ARM_PANELS, LEG_PANEL]) {
    const panel = buildPanel(spec, material);
    panels.push(panel);
    group.add(panel.mesh);
  }

  return { group, panels, material, deployed: false };
}

function buildPanel(spec, material) {
  const { gridU, gridV } = spec;
  const cols = gridU + 1;
  const rows = gridV + 1;
  const vertexCount = cols * rows;

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let iv = 0; iv < rows; iv++) {
    for (let iu = 0; iu < cols; iu++) {
      const index = iv * cols + iu;
      uvs[index * 2] = iu / gridU;
      uvs[index * 2 + 1] = iv / gridV;
    }
  }

  const indices = [];
  for (let iv = 0; iv < gridV; iv++) {
    for (let iu = 0; iu < gridU; iu++) {
      const a = iv * cols + iu;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = spec.name;
  mesh.castShadow = true;
  mesh.frustumCulled = false; // world-space, off-origin geometry — never cull.

  return { mesh, geometry, gridU, gridV, cols, rows, corners: spec.corners };
}
