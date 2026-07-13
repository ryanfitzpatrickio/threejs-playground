import * as THREE from 'three';
import { flattenGeometryForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../../utils/createGltfLoader.js';

// Great sword. The default gameplay sword is Violet Tempest, whose GLB contains
// a blade and sheath in one mesh. We split the disconnected islands at load
// time so the blade can follow the hand while the sheath stays on the back.
// The original neonblade asset remains available through createMaraGreatSword.
// Carries two helper objects (bladeBase / bladeTip) at the blade ends that
// CombatSystem sweeps for hit casts. Falls back to a procedural sword if the GLB
// fails to load.

const SWORD_URL = '/assets/models/neonblade.glb';
const SWORD_SCALE = 1.5; // ~1.5m total on a 1.72m character (great sword proportions)
const VIOLET_TEMPEST_URL = '/assets/models/violet-tempest.glb';
const VIOLET_TEMPEST_SCALE = 0.86;
// Violet Tempest mesh: pommel/hilt at high +Y, tip at low −Y (opposite of the
// earlier bottom-hilt assumption that put the hand on the tip).
// Socket: map local −Y (grip → tip) to world up in armed-idle
// (setFromUnitVectors(−Y, handLocalWorldUp) — see diagnose-sword-socket.mjs).
const VIOLET_TEMPEST_SOCKET_ROTATION_DEG = [-51.94, -25.94, 50.61];

// Geometry of neonblade.glb in its native model space (see scripts/diagnose-neonblade.mjs):
// the blade lies along +X, flat in Y, with the round grip at the -X end and tip at +X.
const GRIP_X = -0.32; // model-space X where the hand grips (just behind the guard)
const GRIP_Y = 0.083; // blade centerline Y (model spans Y 0..0.165)
const GRIP_Z = 0;
const BLADE_BASE_X = -0.12; // start of the cutting blade (near the guard)
const TIP_X = 0.5; // model max X = tip

// Socket rotation (child of mixamorigRightHand) that points the blade (+X) to
// world-up in the armed-idle pose.
// Default tuned values (as of 2026-06-20):
// position: { x: 0, y: 5, z: 2 },
// rotationDegrees: { x: 180, y: 0, z: -44 },
// scale is handled by attachSword inherited-scale correction (~50).
// These are applied in loadNeonBlade and createProceduralSword.

export async function createGreatSword() {
  try {
    return await loadVioletTempest();
  } catch (error) {
    console.warn('violet-tempest.glb failed to load; falling back to the legacy Mara sword.', error);
    return createMaraGreatSword();
  }
}

/** Preserve the original sword for Mara/legacy presentation callers. */
export async function createMaraGreatSword() {
  try {
    return await loadNeonBlade();
  } catch (error) {
    console.warn('neonblade.glb failed to load; falling back to procedural sword.', error);
    return createProceduralSword();
  }
}

async function loadVioletTempest() {
  const loader = createGltfLoader();
  const gltf = await loader.loadAsync(VIOLET_TEMPEST_URL);
  const sourceMesh = findFirstMesh(gltf.scene);
  if (!sourceMesh?.geometry) {
    throw new Error('Violet Tempest GLB has no mesh geometry');
  }

  const parts = splitDisconnectedGeometry(sourceMesh.geometry);
  if (parts.length < 2) {
    throw new Error(`Violet Tempest expected blade + sheath islands, found ${parts.length}`);
  }

  const measured = parts.map((geometry) => {
    geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    return { geometry, size, bounds: geometry.boundingBox.clone() };
  });
  // This export has the sword on the larger island and the sheath on the
  // narrower island (the opposite of the usual silhouette heuristic).
  measured.sort((a, b) => (b.size.x * b.size.z) - (a.size.x * a.size.z));
  const bladePart = measured[0];
  const sheathPart = measured[measured.length - 1];

  const bladeMesh = prepareStaticPart(bladePart.geometry, sourceMesh.material, 'Violet Tempest Blade');
  const sheathMesh = prepareStaticPart(sheathPart.geometry, sourceMesh.material, 'Violet Tempest Sheath');

  const bladeBounds = bladePart.bounds;
  const bladeHeight = Math.max(bladeBounds.max.y - bladeBounds.min.y, 0.1);
  // This export has the pommel/grip at the HIGH +Y end and the tip at LOW −Y.
  // Using the bottom as the hilt put the hand on the tip — flip to top hilt.
  const bladeGrip = findTopHiltPivot(bladePart.geometry, bladeBounds);
  bladeMesh.position.copy(bladeGrip).multiplyScalar(-1);

  const bladeGroup = new THREE.Group();
  bladeGroup.name = 'Violet Tempest';
  bladeGroup.position.set(0, 5, 2);
  bladeGroup.quaternion.setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(VIOLET_TEMPEST_SOCKET_ROTATION_DEG[0]),
    THREE.MathUtils.degToRad(VIOLET_TEMPEST_SOCKET_ROTATION_DEG[1]),
    THREE.MathUtils.degToRad(VIOLET_TEMPEST_SOCKET_ROTATION_DEG[2]),
    'XYZ',
  ));
  bladeGroup.scale.setScalar(VIOLET_TEMPEST_SCALE);
  bladeGroup.add(bladeMesh);

  // Local −Y from grip → tip (socket maps −Y to world up).
  const bladeBase = new THREE.Object3D();
  bladeBase.name = 'Violet Tempest Blade Base';
  bladeBase.position.set(0, bladeBounds.max.y - bladeHeight * 0.12 - bladeGrip.y, 0);
  const bladeTip = new THREE.Object3D();
  bladeTip.name = 'Violet Tempest Blade Tip';
  bladeTip.position.set(0, bladeBounds.min.y + bladeHeight * 0.02 - bladeGrip.y, 0);
  const rightGrip = new THREE.Object3D();
  rightGrip.name = 'Violet Tempest Right Grip';
  const leftGrip = new THREE.Object3D();
  leftGrip.name = 'Violet Tempest Left Grip';
  leftGrip.position.set(0, bladeBounds.max.y - bladeHeight * 0.22 - bladeGrip.y, 0);
  bladeGroup.add(bladeBase, bladeTip, rightGrip, leftGrip);

  const sheathGroup = new THREE.Group();
  sheathGroup.name = 'Violet Tempest Sheath';
  sheathGroup.scale.setScalar(VIOLET_TEMPEST_SCALE);
  sheathMesh.position.copy(sheathPart.bounds.getCenter(new THREE.Vector3())).multiplyScalar(-1);
  sheathGroup.add(sheathMesh);

  return {
    group: bladeGroup,
    sheath: { group: sheathGroup, source: 'glb-island' },
    bladeBase,
    bladeTip,
    rightGrip,
    leftGrip,
    source: 'violet-tempest-glb',
  };
}

function findFirstMesh(root) {
  let result = null;
  root?.traverse?.((object) => {
    if (!result && object.isMesh) result = object;
  });
  return result;
}

function findBottomHiltPivot(geometry, bounds) {
  return findHiltPivotAlongY(geometry, bounds, 'bottom');
}

/** Pommel/grip for exports that store the hilt at high +Y (Violet Tempest). */
function findTopHiltPivot(geometry, bounds) {
  return findHiltPivotAlongY(geometry, bounds, 'top');
}

/**
 * Average of vertices in the top or bottom ~16% of the Y extent (hilt region).
 * @param {'top'|'bottom'} end
 */
function findHiltPivotAlongY(geometry, bounds, end) {
  const position = geometry?.getAttribute?.('position');
  if (!position || position.count === 0) {
    return new THREE.Vector3(
      (bounds.min.x + bounds.max.x) * 0.5,
      end === 'top' ? bounds.max.y : bounds.min.y,
      (bounds.min.z + bounds.max.z) * 0.5,
    );
  }

  const height = Math.max(bounds.max.y - bounds.min.y, 0.1);
  const hiltMinY = end === 'top' ? bounds.max.y - height * 0.16 : bounds.min.y;
  const hiltMaxY = end === 'top' ? bounds.max.y : bounds.min.y + height * 0.16;
  const hiltMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const hiltMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const vertex = new THREE.Vector3();
  let count = 0;
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index);
    if (vertex.y < hiltMinY || vertex.y > hiltMaxY) continue;
    hiltMin.min(vertex);
    hiltMax.max(vertex);
    count += 1;
  }
  if (count === 0) {
    return new THREE.Vector3(
      (bounds.min.x + bounds.max.x) * 0.5,
      end === 'top' ? bounds.max.y : bounds.min.y,
      (bounds.min.z + bounds.max.z) * 0.5,
    );
  }
  return hiltMin.add(hiltMax).multiplyScalar(0.5);
}

function prepareStaticPart(geometry, material, name) {
  flattenGeometryForWebGPU(geometry);
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Split indexed geometry into disconnected islands while preserving attributes. */
function splitDisconnectedGeometry(source) {
  const index = source.getIndex();
  const position = source.getAttribute('position');
  if (!index || !position) return [source.clone()];

  const parent = Uint32Array.from({ length: position.count }, (_, i) => i);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent[right] = left;
  };

  // GLB exporters commonly duplicate vertices at UV/normal seams. Merge only
  // exact position duplicates for connectivity; keep the original attributes
  // when constructing each island so shading and UVs remain intact.
  const positionKeys = new Map();
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const key = [position.getX(vertex), position.getY(vertex), position.getZ(vertex)]
      .map((value) => Math.round(value * 100000))
      .join(',');
    const previous = positionKeys.get(key);
    if (previous == null) positionKeys.set(key, vertex);
    else union(previous, vertex);
  }

  const indices = index.array;
  for (let offset = 0; offset < indices.length; offset += 3) {
    union(indices[offset], indices[offset + 1]);
    union(indices[offset + 1], indices[offset + 2]);
  }

  const trianglesByRoot = new Map();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const root = find(indices[offset]);
    const triangles = trianglesByRoot.get(root) ?? [];
    triangles.push(indices[offset], indices[offset + 1], indices[offset + 2]);
    trianglesByRoot.set(root, triangles);
  }
  if (trianglesByRoot.size <= 1) return [source.clone()];

  const parts = [];
  for (const triangles of trianglesByRoot.values()) {
    const geometry = new THREE.BufferGeometry();
    const remap = new Map();
    const sourceVertices = [];
    const localIndices = [];
    for (const sourceIndex of triangles) {
      let localIndex = remap.get(sourceIndex);
      if (localIndex == null) {
        localIndex = sourceVertices.length;
        remap.set(sourceIndex, localIndex);
        sourceVertices.push(sourceIndex);
      }
      localIndices.push(localIndex);
    }

    for (const [name, attribute] of Object.entries(source.attributes)) {
      const values = new attribute.array.constructor(sourceVertices.length * attribute.itemSize);
      sourceVertices.forEach((sourceIndex, localIndex) => {
        const from = sourceIndex * attribute.itemSize;
        const to = localIndex * attribute.itemSize;
        for (let offset = 0; offset < attribute.itemSize; offset += 1) {
          values[to + offset] = attribute.array[from + offset];
        }
      });
      geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized));
    }
    const IndexArray = sourceVertices.length > 65535 ? Uint32Array : Uint16Array;
    geometry.setIndex(new THREE.BufferAttribute(new IndexArray(localIndices), 1));
    parts.push(geometry);
  }
  return parts;
}

async function loadNeonBlade() {
  const loader = createGltfLoader();
  const gltf = await loader.loadAsync(SWORD_URL);
  const mesh = gltf.scene;
  mesh.name = 'Neon Blade';

  // Translate so the grip sits at the group origin, then scale.
  // Note: group-level socket (position/rot) is applied after for the hand attachment default.
  mesh.position.set(-GRIP_X * SWORD_SCALE, -GRIP_Y * SWORD_SCALE, -GRIP_Z * SWORD_SCALE);
  mesh.scale.setScalar(SWORD_SCALE);
  mesh.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.visible = true;
      child.frustumCulled = false;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (!material) continue;
        material.roughness = Math.max(material.roughness ?? 0.6, 0.45);
        material.transparent = false;
        material.depthWrite = true;
      }
      if (child.geometry) flattenGeometryForWebGPU(child.geometry);
    }
  });

  const group = new THREE.Group();
  group.name = 'Great Sword';
  // Default socket tuned for hand attachment (good defaults as of 2026-06-20)
  group.position.set(0, 5, 2);
  group.quaternion.setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(180),
    0,
    THREE.MathUtils.degToRad(-44),
    'XYZ'
  ));
  group.add(mesh);

  const bladeBase = new THREE.Object3D();
  bladeBase.name = 'Great Sword Blade Base';
  bladeBase.position.set((BLADE_BASE_X - GRIP_X) * SWORD_SCALE, 0, 0);

  const bladeTip = new THREE.Object3D();
  bladeTip.name = 'Great Sword Blade Tip';
  bladeTip.position.set((TIP_X - GRIP_X) * SWORD_SCALE, 0, 0);

  group.add(bladeBase, bladeTip);

  return { group, bladeBase, bladeTip, source: 'glb' };
}

// Procedural fallback (only if the GLB is missing). Blade along +Y, socketed
// with its own rotation so it points up from the hand.
const FALLBACK_BLADE_LENGTH = 1.42;

const FALLBACK_MATERIALS = {
  blade: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.28, metalness: 0.85 }),
  guard: new THREE.MeshStandardMaterial({ color: 0x6b5a3a, roughness: 0.5, metalness: 0.45 }),
  grip: new THREE.MeshStandardMaterial({ color: 0x2a1c14, roughness: 0.82 }),
  pommel: new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.45, metalness: 0.6 }),
};

function createProceduralSword() {
  const group = new THREE.Group();
  group.name = 'Great Sword (Procedural)';
  // Default socket tuned for hand attachment (good defaults as of 2026-06-20)
  group.position.set(0, 5, 2);
  group.quaternion.setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(180),
    0,
    THREE.MathUtils.degToRad(-44),
    'XYZ'
  ));

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.22, 10), FALLBACK_MATERIALS.grip);
  grip.position.y = -0.11;
  grip.castShadow = true;

  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), FALLBACK_MATERIALS.pommel);
  pommel.position.y = -0.22;
  pommel.castShadow = true;

  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.07), FALLBACK_MATERIALS.guard);
  guard.position.y = 0.02;
  guard.castShadow = true;

  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.11, FALLBACK_BLADE_LENGTH, 0.02), FALLBACK_MATERIALS.blade);
  blade.position.y = FALLBACK_BLADE_LENGTH * 0.5;
  blade.castShadow = true;

  group.add(grip, pommel, guard, blade);

  const bladeBase = new THREE.Object3D();
  bladeBase.position.set(0, 0.08, 0);
  const bladeTip = new THREE.Object3D();
  bladeTip.position.set(0, FALLBACK_BLADE_LENGTH + 0.16, 0);
  group.add(bladeBase, bladeTip);

  return { group, bladeBase, bladeTip, source: 'procedural' };
}
