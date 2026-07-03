import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { flattenGeometryForWebGPU } from './prepareWebGPUGeometry.js';

// Tripo splits vertices at almost every edge; merge then smooth up to this angle.
const DEFAULT_CREASE_ANGLE_DEG = 88;

/**
 * Weld split vertices and rebuild averaged normals for a round shaded shell.
 * Per-triangle derivative normals (the old "smooth shader") stay faceted — this
 * is the correct fix for glossy Tripo exports.
 */
export function prepareVehicleOverlayGeometry(
  geometry,
  { creaseAngleDeg = DEFAULT_CREASE_ANGLE_DEG, mergeTolerance = 1e-4 } = {},
) {
  if (!geometry) return geometry;

  const merged = mergeVertices(geometry, mergeTolerance);
  if (merged !== geometry) geometry.dispose();

  toCreasedNormals(merged, THREE.MathUtils.degToRad(creaseAngleDeg));
  flattenGeometryForWebGPU(merged);
  return merged;
}
