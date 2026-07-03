import * as THREE from 'three';

const _inverse = new THREE.Matrix4();
const _baseLocal = new THREE.Vector3();
const _baseWorld = new THREE.Vector3();
const _currentLocal = new THREE.Vector3();
const _currentWorld = new THREE.Vector3();
const _nextWorld = new THREE.Vector3();
const _nextLocal = new THREE.Vector3();
const _offsetWorld = new THREE.Vector3();
const _deformDirection = new THREE.Vector3();

function hashPosition(x, y, z) {
  const value = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Permanently deform a BufferGeometry around a world-space impact point.
 * The immutable base snapshot makes repeated impacts saturate instead of folding
 * geometry through itself. Returns the number of vertices changed.
 */
export function applyCrumple(mesh, {
  point,
  dir,
  radius,
  depth,
  bendUp = 0,
  noise = 0,
  maxDepth = depth,
} = {}) {
  if (
    mesh?.geometry
    && !mesh.userData.vehicleDamageGeometryUnique
    && !mesh.userData.vehicleDamageGeometryOwned
  ) {
    // Generated frame rails can share one geometry. Damage is local to a physical
    // part, so take ownership before mutating it; overlay geometry is already
    // per-instance, but cloning once here also makes that guarantee explicit.
    mesh.geometry = mesh.geometry.clone();
    mesh.userData.vehicleDamageGeometryOwned = true;
  }
  const geometry = mesh?.geometry;
  const position = geometry?.getAttribute?.('position');
  if (!position || !point || !dir || !(radius > 0) || !(depth > 0)) return 0;

  mesh.updateMatrixWorld(true);
  _inverse.copy(mesh.matrixWorld).invert();
  const snapshot = mesh.userData.vehicleDamageBasePositions
    ?? (mesh.userData.vehicleDamageBasePositions = new Float32Array(position.array));
  _deformDirection.copy(dir).normalize().addScaledVector(THREE.Object3D.DEFAULT_UP, bendUp).normalize();

  let changed = 0;
  for (let index = 0; index < position.count; index += 1) {
    _currentLocal.fromBufferAttribute(position, index);
    _currentWorld.copy(_currentLocal).applyMatrix4(mesh.matrixWorld);
    const distance = _currentWorld.distanceTo(point);
    if (distance >= radius) continue;

    _baseLocal.fromArray(snapshot, index * 3);
    _baseWorld.copy(_baseLocal).applyMatrix4(mesh.matrixWorld);
    const t = 1 - distance / radius;
    const falloff = t * t * (3 - 2 * t);
    const wrinkle = 1 + (hashPosition(_baseLocal.x, _baseLocal.y, _baseLocal.z) * 2 - 1) * noise;
    _nextWorld.copy(_currentWorld).addScaledVector(_deformDirection, depth * falloff * wrinkle);

    _offsetWorld.copy(_nextWorld).sub(_baseWorld);
    if (_offsetWorld.length() > maxDepth) {
      _offsetWorld.setLength(maxDepth);
      _nextWorld.copy(_baseWorld).add(_offsetWorld);
    }
    _nextLocal.copy(_nextWorld).applyMatrix4(_inverse);
    position.setXYZ(index, _nextLocal.x, _nextLocal.y, _nextLocal.z);
    changed += 1;
  }

  if (changed) {
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return changed;
}

export function restoreCrumple(mesh) {
  const geometry = mesh?.geometry;
  const position = geometry?.getAttribute?.('position');
  const snapshot = mesh?.userData?.vehicleDamageBasePositions;
  if (!position || !snapshot || snapshot.length !== position.array.length) return false;
  position.array.set(snapshot);
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return true;
}
