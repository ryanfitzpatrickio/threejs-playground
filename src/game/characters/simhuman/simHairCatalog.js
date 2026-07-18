/**
 * Sim hair-cap catalog.
 *
 * Authored GLBs live under /assets/simhair/. Each entry can keep only a subset
 * of source meshes (Meshy part-segmentation packs ship many parts).
 */

/** Showcase Female tuned defaults (Chestnut Cascade on head socket). */
export const DEFAULT_SIM_HAIR_STYLE_ID = 'chestnut-cascade';
export const DEFAULT_SIM_HAIR_COLOR = '#c8af97';
export const DEFAULT_SIM_HAIR_FIT = Object.freeze({
  scale: 0.43,
  position: Object.freeze({ x: 0.005, y: 0.485, z: -0.065 }),
  rotation: Object.freeze({ x: 0, y: 0, z: 0 }),
});

export const SIM_HAIR_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'chestnut-cascade',
    name: 'Chestnut Cascade',
    description: 'Long cascading hair (Meshy). Keeps mesh 7 only from the part pack.',
    url: '/assets/simhair/chestnut-cascade.glb',
    /**
     * 0-based mesh indices to keep at attach. Empty = keep every mesh in the
     * runtime GLB. The prepared asset already contains only source mesh 7
     * (index 6 from the Meshy part-segmentation pack).
     */
    keepMeshIndices: Object.freeze([]),
    /** Source pack mesh index kept by prepare:sim-hair (1-based mesh 7). */
    sourceKeepMeshIndex: 6,
    /** Fallback solid tint when the source material is a segmentation color. */
    defaultColor: DEFAULT_SIM_HAIR_COLOR,
  }),
]);

const BY_ID = new Map(SIM_HAIR_OPTIONS.map((entry) => [entry.id, entry]));

export function listSimHairOptions() {
  return [...SIM_HAIR_OPTIONS];
}

export function getSimHairDefinition(id) {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

export function isSimHairStyleId(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

export function resolveSimHairAsset(id) {
  const definition = getSimHairDefinition(id);
  if (!definition) return null;
  return { ...definition };
}
