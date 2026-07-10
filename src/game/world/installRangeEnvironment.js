/**
 * Warehouse HDR environment for the Shooting Range.
 *
 * Three.js sample scenes often use Polyhaven's empty warehouse HDR (CC0) for
 * indoor industrial IBL — there is no warehouse file inside the npm package,
 * so we ship a 1k copy under public/assets/textures/env/.
 *
 * Loaded via HDRLoader → PMREM (same path as three.js envmap examples).
 */

import * as THREE from 'three';
import { PMREMGenerator } from 'three/webgpu';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

/** Public URL of the equirectangular warehouse HDR. */
export const RANGE_WAREHOUSE_HDR_URL = '/assets/textures/env/empty_warehouse_01_1k.hdr';

const cache = new WeakMap();

/**
 * Load + PMREM-convert the warehouse HDR once per renderer.
 * @param {import('three').WebGPURenderer|import('three').WebGLRenderer} renderer
 * @param {{ url?: string, size?: number }} [options]
 * @returns {Promise<{ texture: THREE.Texture, dispose: () => void }|null>}
 */
export async function loadWarehouseEnvironment(renderer, {
  url = RANGE_WAREHOUSE_HDR_URL,
  size = 256,
} = {}) {
  if (!renderer) return null;

  const cached = cache.get(renderer);
  if (cached?.url === url && cached.texture) {
    return cached;
  }

  // Drop previous cache entry for this renderer if URL changed.
  if (cached) {
    cached.dispose?.();
    cache.delete(renderer);
  }

  const loader = new HDRLoader();
  let equirect;
  try {
    equirect = await loader.loadAsync(url);
  } catch (err) {
    console.warn('[range-env] failed to load warehouse HDR', url, err);
    return null;
  }

  equirect.mapping = THREE.EquirectangularReflectionMapping;
  equirect.colorSpace = THREE.LinearSRGBColorSpace;

  const generator = new PMREMGenerator(renderer);
  let target;
  try {
    // WebGPU PMREM accepts size via render target options on fromEquirectangular
    // in r185; fall back to default if the signature ignores extra args.
    target = generator.fromEquirectangular(equirect);
  } finally {
    generator.dispose();
    equirect.dispose?.();
  }

  if (!target?.texture) {
    target?.dispose?.();
    return null;
  }

  target.texture.name = 'Range Warehouse PMREM';
  // size hint kept for callers / future resize; generator uses its default mip chain.
  void size;

  const entry = {
    url,
    texture: target.texture,
    dispose: () => {
      target.dispose?.();
      if (cache.get(renderer) === entry) cache.delete(renderer);
    },
  };
  cache.set(renderer, entry);
  return entry;
}

/**
 * Install warehouse HDR as scene.environment (IBL). Keeps sky as background
 * so the open roof still shows outdoor sky; materials pick up warehouse light.
 *
 * @param {THREE.Scene} scene
 * @param {object} renderer
 * @param {{
 *   url?: string,
 *   intensity?: number,
 *   rotationY?: number,
 *   asBackground?: boolean,
 * }} [options]
 * @returns {Promise<THREE.Texture|null>}
 */
export async function installRangeEnvironment(scene, renderer, {
  url = RANGE_WAREHOUSE_HDR_URL,
  intensity = 1.05,
  rotationY = 0.35,
  asBackground = false,
} = {}) {
  if (!scene || !renderer) return null;

  const env = await loadWarehouseEnvironment(renderer, { url });
  if (!env?.texture) return null;

  scene.environment = env.texture;
  scene.environmentIntensity = Number.isFinite(intensity) ? intensity : 1.05;
  if (scene.environmentRotation) {
    scene.environmentRotation.y = Number.isFinite(rotationY) ? rotationY : 0.35;
  }

  if (asBackground) {
    scene.background = env.texture;
    scene.backgroundBlurriness = 0.08;
    scene.backgroundIntensity = 0.85;
  }

  return env.texture;
}
