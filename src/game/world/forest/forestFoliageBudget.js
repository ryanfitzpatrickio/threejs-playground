/** WebGPU instancing cap for forest foliage (see forestLod.js). */
export const MAX_FOREST_FOLIAGE_INSTANCES = 512;

/** Fit per-tree leaf cards × tree count into the WebGPU instancing budget. */
export function computeFoliageInstancingBudget(sourceCardsPerTree, treeCount) {
  const srcK = Math.max(0, sourceCardsPerTree | 0);
  let trees = Math.min(Math.max(0, treeCount | 0), MAX_FOREST_FOLIAGE_INSTANCES);
  if (srcK === 0 || trees === 0) return null;

  let k = Math.min(srcK, Math.floor(MAX_FOREST_FOLIAGE_INSTANCES / trees));
  if (k < 1) {
    trees = Math.min(trees, MAX_FOREST_FOLIAGE_INSTANCES);
    k = 1;
  }
  return { trees, k, srcK, maxInstances: trees * k };
}

export function sampleFoliageSourceIndex(srcK, k, j) {
  if (k >= srcK) return j;
  return Math.min(srcK - 1, Math.floor((j * srcK) / k));
}
