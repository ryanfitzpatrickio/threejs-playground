import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { flattenGeometryForWebGPU } from './prepareWebGPUGeometry.js';

// Tripo splits vertices at almost every edge; merge then smooth up to this angle.
const DEFAULT_CREASE_ANGLE_DEG = 88;

/**
 * Weld split vertices and rebuild averaged normals for a round shaded shell.
 * Per-triangle derivative normals (the old "smooth shader") stay faceted — this
 * is the correct fix for glossy Tripo exports.
 *
 * Meshy / KHR_mesh_quantization exports use interleaved Uint16 positions;
 * mergeVertices must run after flattenGeometryForWebGPU converts them to floats.
 */
export function prepareVehicleOverlayGeometry(
  geometry,
  { creaseAngleDeg = DEFAULT_CREASE_ANGLE_DEG, mergeTolerance = 1e-4 } = {},
) {
  if (!geometry) return geometry;

  flattenGeometryForWebGPU(geometry);

  let merged = mergeVertices(geometry, mergeTolerance);
  if (merged !== geometry) geometry.dispose();

  const creased = toCreasedNormals(merged, THREE.MathUtils.degToRad(creaseAngleDeg));
  if (creased !== merged) {
    merged.dispose();
    merged = creased;
  }
  flattenGeometryForWebGPU(merged);
  stripOverlayVertexColors(merged);
  ensureOverlayUv(merged);
  return merged;
}

/** Meshy exports bake albedo into COLOR_0 — it washes out mapped materials on WebGPU. */
function stripOverlayVertexColors(geometry) {
  if (geometry.getAttribute('color')) geometry.deleteAttribute('color');
}

function ensureOverlayUv(geometry) {
  const position = geometry.getAttribute('position');
  if (!position) return;

  const uvAttr = geometry.getAttribute('uv');
  let needsPlanar = !uvAttr;
  if (uvAttr && !needsPlanar) {
    needsPlanar = true;
    for (let i = 0; i < uvAttr.count; i += 1) {
      if (Math.abs(uvAttr.getX(i)) > 1e-4 || Math.abs(uvAttr.getY(i)) > 1e-4) {
        needsPlanar = false;
        break;
      }
    }
  }
  if (!needsPlanar) return;

  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds || bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3());
  const scale = Math.max(size.x, size.y, size.z, 1e-6);
  const uv = new THREE.Float32BufferAttribute(new Float32Array(position.count * 2), 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  // The creased geometry is non-indexed, so each triangle can use the projection
  // best aligned to its face without UV seams corrupting neighbouring faces.
  // Normalize by the largest object-space dimension: Meshy assets are commonly
  // authored at ~0.01 units and scaled up on attach, while Tripo shells use metres.
  for (let i = 0; i + 2 < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    faceNormal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
    const nx = Math.abs(faceNormal.x);
    const ny = Math.abs(faceNormal.y);
    const nz = Math.abs(faceNormal.z);
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = corner === 0 ? a : corner === 1 ? b : c;
      if (nx >= ny && nx >= nz) {
        uv.setXY(i + corner, (vertex.z - bounds.min.z) / scale, (vertex.y - bounds.min.y) / scale);
      } else if (ny >= nz) {
        uv.setXY(i + corner, (vertex.x - bounds.min.x) / scale, (vertex.z - bounds.min.z) / scale);
      } else {
        uv.setXY(i + corner, (vertex.x - bounds.min.x) / scale, (vertex.y - bounds.min.y) / scale);
      }
    }
  }
  geometry.setAttribute('uv', uv);
}
