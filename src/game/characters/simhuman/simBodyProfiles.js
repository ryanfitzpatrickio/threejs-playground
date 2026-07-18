/**
 * Body profiles shared by the Sim creator and body-specific outfit bake bridge.
 * `outfitDonorFile` is the prepared GLB Blender samples when transferring skin
 * weights and optional modeling morphs to an imported outfit.
 */
export const SIM_BODY_PROFILES = Object.freeze([
  Object.freeze({ id: 'human5', label: 'Base', outfitDonorFile: 'human5.glb' }),
  Object.freeze({ id: 'male', label: 'Male', outfitDonorFile: 'ubc-male.glb' }),
  Object.freeze({ id: 'female', label: 'Female', outfitDonorFile: 'ubc-female.glb' }),
]);

const PROFILE_BY_ID = new Map(SIM_BODY_PROFILES.map((profile) => [profile.id, profile]));

export function getSimBodyProfile(id) {
  return PROFILE_BY_ID.get(String(id ?? '')) ?? null;
}

export function isSimBodyId(id) {
  return getSimBodyProfile(id) !== null;
}
