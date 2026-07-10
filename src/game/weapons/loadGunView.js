/**
 * Load a gun GLB + profile into a runtime view with anchor Object3Ds.
 * Used by FirstPersonWeaponSystem (M4) and later WeaponSystem.
 */

import * as THREE from 'three';
import { createGltfLoader } from '../utils/createGltfLoader.js';
import { flattenObjectForWebGPU } from '../geometry/prepareWebGPUGeometry.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import {
  applyAnchorObjectTransform,
  createDefaultAnchor,
  findAnchor,
  GUN_ANCHOR_NAMES,
  normalizeAnchorList,
} from './gunAnchors.js';
import {
  createCatalogStubProfile,
  GUN_CATALOG,
  normalizeProfile,
} from './gunProfile.js';
import { resolveGunProfile } from './gunsmithStore.js';
import { createGun } from './createGun.js';
import { applyGunProfileMaterials } from './gunMaterials.js';
import {
  buildAnchorsFromOrientedBounds,
  orientGunMeshToWeaponSpace,
} from './gunHandSocket.js';

const loader = createGltfLoader();
const viewCache = new Map();

/**
 * @typedef {object} GunView
 * @property {string} id
 * @property {object} profile
 * @property {import('./BaseGun.js').BaseGun} gun
 * @property {THREE.Group} root
 * @property {Record<string, THREE.Object3D>} anchors
 * @property {() => void} dispose
 */

/**
 * Build (or clone from cache) a gun view for the given catalog/profile id.
 * @param {string} gunId
 * @param {{profile?:object, meshNames?:string[]}} [options]
 * @returns {Promise<GunView>}
 */
export async function loadGunView(gunId, options = {}) {
  const entry = GUN_CATALOG.find((g) => g.id === gunId)
    || { id: gunId, label: gunId, glbUrl: `/assets/guns/${gunId}.glb`, weaponKind: 'rifle' };

  let profile = options.profile
    ? normalizeProfile(options.profile)
    : resolveGunProfile(gunId, { meshNames: options.meshNames || [] });

  if (!profile) {
    profile = createCatalogStubProfile(entry, options.meshNames || []);
  }

  const template = await loadGunTemplate(entry.glbUrl);
  const root = new THREE.Group();
  root.name = `GunView_${profile.id}`;
  const meshClone = template.clone(true);
  root.add(meshClone);

  // Map X-long Meshy imports into weapon space (−Z muzzle, +Y top).
  orientGunMeshToWeaponSpace(root);

  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  // Runtime honors the same per-part profile previewed and exported in Gunsmith.
  // All non-baked modes intentionally discard the GLB's base-color material.
  await applyGunProfileMaterials(root, profile);

  // Prefer authored anchors; if profile only has defaults/stubs, rebuild from bounds
  // so grip/muzzle match the oriented mesh (defaults assumed −Z forward already).
  const boundsAnchors = buildAnchorsFromOrientedBounds(root);
  const anchorsList = normalizeAnchorList(profile.anchors);
  const legacyXForward = anchorsNeedCanonicalRebuild(anchorsList);
  const hasAuthored = !legacyXForward && anchorsList.some((a) => {
    const def = createDefaultAnchor(a.name);
    if (!def) return true;
    const dp = def.position;
    const p = a.position || [0, 0, 0];
    return Math.hypot(p[0] - dp[0], p[1] - dp[1], p[2] - dp[2]) > 1e-4;
  });

  let finalAnchors = anchorsList;
  if (!hasAuthored) {
    finalAnchors = GUN_ANCHOR_NAMES.map((name) => (
      boundsAnchors[name] || createDefaultAnchor(name)
    ));
  } else {
    for (const name of GUN_ANCHOR_NAMES) {
      if (!finalAnchors.some((a) => a.name === name)) {
        finalAnchors.push(boundsAnchors[name] || createDefaultAnchor(name));
      }
    }
  }
  profile = normalizeProfile({ ...profile, anchors: finalAnchors });

  const anchors = {};
  for (const name of GUN_ANCHOR_NAMES) {
    const data = findAnchor(profile.anchors, name) || boundsAnchors[name] || createDefaultAnchor(name);
    const marker = new THREE.Object3D();
    marker.name = `gun_anchor_${name}`;
    marker.userData.socketName = name;
    applyAnchorObjectTransform(marker, data);
    root.add(marker);
    anchors[name] = marker;
  }

  // Placement under aim anchor is identity; FirstPersonHandIk drives aim pose.

  const gun = createGun(profile, { root });

  return {
    id: profile.id,
    profile,
    gun,
    root,
    anchors,
    dispose() {
      gun.dispose?.();
      if (root.parent) root.parent.remove(root);
      disposeObject3D(root);
    },
  };
}

/**
 * Early Gunsmith stubs were saved from the raw Meshy X-long bounds. Runtime gun
 * space is now canonical −Z-forward, so preserving those values puts grip and
 * muzzle markers sideways relative to the reoriented mesh. Real canonical
 * profiles have their muzzle/stock separation primarily on Z.
 */
export function anchorsNeedCanonicalRebuild(anchors) {
  const list = normalizeAnchorList(anchors);
  const muzzle = list.find((anchor) => anchor.name === 'muzzle');
  const stock = list.find((anchor) => anchor.name === 'stock_shoulder');
  if (!muzzle?.position || !stock?.position) return false;

  const dx = Math.abs((muzzle.position[0] ?? 0) - (stock.position[0] ?? 0));
  const dz = Math.abs((muzzle.position[2] ?? 0) - (stock.position[2] ?? 0));
  return dx > 0.25 && dx > dz * 2;
}

async function loadGunTemplate(url) {
  if (viewCache.has(url)) {
    return viewCache.get(url);
  }
  const gltf = await loader.loadAsync(url);
  const scene = gltf.scene || gltf.scenes?.[0];
  if (!scene) throw new Error(`Gun GLB has no scene: ${url}`);
  flattenObjectForWebGPU(scene);
  scene.updateMatrixWorld(true);
  viewCache.set(url, scene);
  return scene;
}

/** Default equip gun for FP playground. Override with `?gun=<id>`. */
export function defaultGunIdFromQuery() {
  const DEFAULT_GUN_ID = 'desert-ar15';
  try {
    if (typeof window === 'undefined') return DEFAULT_GUN_ID;
    const q = new URLSearchParams(window.location.search).get('gun');
    if (q && (GUN_CATALOG.some((g) => g.id === q) || q.endsWith('.glb'))) {
      return q.replace(/\.glb$/i, '');
    }
  } catch {
    // ignore
  }
  return DEFAULT_GUN_ID;
}

export function clearGunViewCache() {
  viewCache.clear();
}
