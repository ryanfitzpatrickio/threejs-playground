import {
  autoDetectGarageMeshPartRole,
  collectMeshAncestryNames,
  resolveMeshPartKey,
  resolvePartOverride,
} from '../materials/createVehicleOverlayMaterials.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';

/**
 * List mesh parts from a chassis GLB with auto-detected roles and any saved overrides.
 */
export async function loadChassisMeshPartCatalog({
  url,
  profileId = null,
  partOverrides = {},
  disableGlassDetection = false,
} = {}) {
  if (!url) return [];
  if (url.startsWith('/') && typeof window === 'undefined') return [];

  const gltf = await createGltfLoader().loadAsync(url);
  const byKey = new Map();

  gltf.scene.traverse((child) => {
    if (!child.isMesh) return;
    const key = resolveMeshPartKey(child);
    if (byKey.has(key)) return;

    const autoRole = autoDetectGarageMeshPartRole(child, profileId, { disableGlassDetection });
    const override = resolvePartOverride(child, partOverrides);
    byKey.set(key, {
      key,
      names: collectMeshAncestryNames(child),
      autoRole,
      role: override ?? 'auto',
      effectiveRole: override ?? autoRole,
    });
  });

  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function getChassisPartOverridesForBuild(build, chassisId = build?.chassisId) {
  const all = build?.chassisPartOverrides ?? {};
  const overrides = all[chassisId];
  return overrides && typeof overrides === 'object' ? overrides : {};
}
