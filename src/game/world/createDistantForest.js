/**
 * createDistantForest.js
 *
 * Infinite-terrain forest: SeedThree only.
 *   near  — LOD1 heroes + LOD2 clusters
 *   far   — baked crossplane impostor billboards (forestLod blend)
 *
 * No green blob trees, no haze-shell fakes. Async ready promise mounts the
 * archetype pack + starts impostor bake.
 */

import * as THREE from 'three';

/**
 * @param {object} opts
 * @param {(wx:number, wz:number) => number} opts.sampleHeight
 * @param {number} opts.loadedReach
 * @param {object} [opts.qualityPreset]
 * @param {(x:number, z:number) => boolean} [opts.isExcluded]
 * @param {import('three').WebGPURenderer | null} [opts.renderer]
 * @param {{ x:number, y:number, z:number } | null} [opts.initialCameraPosition]
 */
export function createDistantForest({
  sampleHeight,
  loadedReach,
  qualityPreset = {},
  isExcluded = null,
  renderer = null,
  initialCameraPosition = null,
}) {
  if (qualityPreset.distantForest === false) {
    return emptyDistantForest();
  }

  // Group exists immediately so the level can parent it; SeedThree content
  // attaches once the async pack is ready.
  const group = new THREE.Group();
  group.name = 'Distant Forest';
  group.userData.noCollision = true;

  let pool = null;
  let disposed = false;

  const ready = import('./forest/createDistantForestNear.js')
    .then(({ createDistantForestNear }) => createDistantForestNear({
      sampleHeight,
      isExcluded,
      qualityPreset,
      loadedReach,
      renderer,
      initialCameraPosition,
    }))
    .then((built) => {
      if (disposed) {
        built.dispose?.();
        return null;
      }
      pool = built;
      if (built?.group) group.add(built.group);
      return built;
    })
    .catch((err) => {
      console.warn('[distant-forest] SeedThree forest failed', err);
      return null;
    });

  return {
    group,
    ready,
    update(cameraX, cameraZ, opts) {
      pool?.update?.(cameraX, cameraZ, opts);
    },
    updateEnvironment(env) {
      pool?.updateEnvironment?.(env);
    },
    dispose() {
      disposed = true;
      pool?.dispose?.();
      pool = null;
      group.clear();
    },
    snapshot: () => ({
      distantForestSeedThree: true,
      ...(pool?.snapshot?.() ?? {
        distantForestNear: 0,
        distantForestHero: 0,
        distantForestImpostors: 0,
      }),
    }),
  };
}

function emptyDistantForest() {
  return {
    group: null,
    ready: Promise.resolve(null),
    update() {},
    updateEnvironment() {},
    dispose() {},
    snapshot: () => ({
      distantForestSeedThree: false,
      distantForestNear: 0,
      distantForestHero: 0,
      distantForestImpostors: 0,
    }),
  };
}
