/**
 * primitiveGeometry.js
 *
 * Shared unit-primitive geometry for the Map Builder editor and the runtime
 * blueprint instantiator, so placed objects render identically in both. All
 * primitives are unit-sized (1×1×1 box space) and centered at the origin; the
 * object's transform (position/rotation/scale) is applied by the caller.
 *
 * Extracted from MapBuilder so createBlueprintEntities can build the same meshes
 * at runtime without importing the whole editor.
 */

import * as THREE from 'three';

export const PRIMITIVE_TYPES = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'player_spawn'];

export function isValidPrimitiveType(type) {
  return PRIMITIVE_TYPES.includes(type);
}

/**
 * Unit geometry for a primitive type. `plane` is rotated to be horizontal (XZ).
 * Unknown types fall back to a unit box.
 */
export function createPrimitiveGeometry(type) {
  if (type === 'player_spawn') return new THREE.ConeGeometry(0.45, 1, 24);
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

/**
 * Half-extents of the unit primitive in LOCAL space (before the object's
 * transform). Used by the runtime to derive axis-aligned collider boxes for
 * placed objects. `plane` is flat, so its y half-extent is 0.
 */
export function primitiveHalfExtents(type) {
  switch (type) {
    case 'player_spawn': return { x: 0.225, y: 0.5, z: 0.225 };
    case 'plane': return { x: 0.5, y: 0.0, z: 0.5 };
    case 'sphere':
    case 'cylinder':
    case 'cone':
    case 'box':
    default:
      return { x: 0.5, y: 0.5, z: 0.5 };
  }
}
