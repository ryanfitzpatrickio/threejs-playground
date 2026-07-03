import * as THREE from 'three';
import { createAtlasMaterial } from '../../map/textureAtlas.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';

const edgeMaterial = new THREE.LineBasicMaterial({
  color: 0x7f796a,
  transparent: true,
  opacity: 0.34,
});

export function createSavedMapObjects(objectsJson = []) {
  const group = new THREE.Group();
  group.name = 'Saved Map Objects';
  const meshes = [];
  const colliders = [];
  const ledges = [];
  let spawnPoint = null;

  for (const entry of objectsJson) {
    if (entry?.type === 'player_spawn' || entry?.markerType === 'player_spawn') {
      spawnPoint = new THREE.Vector3(...toArray(entry.position, [0, 0, 0]));
      continue;
    }

    const mesh = createObjectMesh(entry);
    if (!mesh) continue;

    group.add(mesh);
    meshes.push(mesh);

    if (mesh.userData.collisionEnabled) {
      const collider = createColliderFromMesh(mesh);
      if (collider) {
        colliders.push(collider);
        addTopLedges({ ledges, collider, name: mesh.name });
      }
    }

    if (mesh.geometry) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMaterial);
      edges.name = `${mesh.name} Edges`;
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      edges.scale.copy(mesh.scale);
      group.add(edges);
    }
  }

  return {
    group,
    meshes,
    colliders,
    ledges,
    spawnPoint,
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    dispose: () => disposeObject3D(group),
  };
}

function createObjectMesh(entry) {
  const type = normalizeType(entry.type);
  const geometry = createGeometry(type);
  if (!geometry) return null;

  const material = createAtlasMaterial(entry.tileIndex ?? 0, entry.textureRepeat || [1, 1], entry.zIndex || 0);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = entry.name || `map_${type}`;
  mesh.position.fromArray(toArray(entry.position, [0, 0, 0]));
  mesh.scale.fromArray(toArray(entry.scale, [1, 1, 1]).map((value) => Math.max(0.01, value)));
  mesh.rotation.fromArray(toArray(entry.rotationDegrees, [0, 0, 0]).map(THREE.MathUtils.degToRad));
  mesh.renderOrder = Math.round(Number(entry.zIndex) || 0);
  mesh.castShadow = type !== 'plane';
  mesh.receiveShadow = true;
  mesh.userData = {
    kind: 'savedMapObject',
    primitiveType: type,
    collisionEnabled: type !== 'plane',
  };
  mesh.updateMatrixWorld(true);
  return mesh;
}

function createGeometry(type) {
  if (type === 'sphere') return new THREE.SphereGeometry(0.5, 24, 16);
  if (type === 'cylinder') return new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
  if (type === 'cone') return new THREE.ConeGeometry(0.5, 1, 24);
  if (type === 'plane') {
    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    return geometry;
  }
  return new THREE.BoxGeometry(1, 1, 1);
}

function normalizeType(type) {
  return ['box', 'sphere', 'cylinder', 'cone', 'plane'].includes(type) ? type : 'box';
}

function toArray(value, fallback) {
  if (!Array.isArray(value) || value.length !== fallback.length) return [...fallback];
  return value.map((item, index) => {
    const next = Number(item);
    return Number.isFinite(next) ? next : fallback[index];
  });
}

function createColliderFromMesh(mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  if (box.isEmpty()) return null;

  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.x <= 0.01 || size.y <= 0.01 || size.z <= 0.01) return null;

  return {
    name: mesh.name,
    minX: box.min.x,
    maxX: box.max.x,
    minZ: box.min.z,
    maxZ: box.max.z,
    topY: box.max.y,
    bottomY: box.min.y,
    width: size.x,
    depth: size.z,
    vaultable: size.y <= 1.15,
    noGroundSnap: false,
  };
}

function addTopLedges({ ledges, collider, name }) {
  const topY = collider.topY;
  ledges.push(
    {
      name: `${name} Front Top Ledge`,
      blockName: name,
      face: 'front',
      hangMode: 'braced',
      axis: 'x',
      min: collider.minX,
      max: collider.maxX,
      y: topY,
      x: (collider.minX + collider.maxX) * 0.5,
      z: collider.maxZ,
      normal: { x: 0, y: 0, z: 1 },
      tangent: { x: 1, y: 0, z: 0 },
    },
    {
      name: `${name} Back Top Ledge`,
      blockName: name,
      face: 'back',
      hangMode: 'braced',
      axis: 'x',
      min: collider.minX,
      max: collider.maxX,
      y: topY,
      x: (collider.minX + collider.maxX) * 0.5,
      z: collider.minZ,
      normal: { x: 0, y: 0, z: -1 },
      tangent: { x: -1, y: 0, z: 0 },
    },
    {
      name: `${name} Left Top Ledge`,
      blockName: name,
      face: 'left',
      hangMode: 'braced',
      axis: 'z',
      min: collider.minZ,
      max: collider.maxZ,
      y: topY,
      x: collider.minX,
      z: (collider.minZ + collider.maxZ) * 0.5,
      normal: { x: -1, y: 0, z: 0 },
      tangent: { x: 0, y: 0, z: 1 },
    },
    {
      name: `${name} Right Top Ledge`,
      blockName: name,
      face: 'right',
      hangMode: 'braced',
      axis: 'z',
      min: collider.minZ,
      max: collider.maxZ,
      y: topY,
      x: collider.maxX,
      z: (collider.minZ + collider.maxZ) * 0.5,
      normal: { x: 1, y: 0, z: 0 },
      tangent: { x: 0, y: 0, z: -1 },
    },
  );
}
