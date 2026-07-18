import * as THREE from 'three';

/** Shared authored mud colors. Every mud effect starts from these sRGB values. */
export const MUD_WET_SRGB = 0x625038;
export const MUD_DRY_SRGB = 0x7a5f38;

/** Backwards-compatible rally name for the dry road/crust color. */
export const RALLY_MUD_TRACK_SRGB = MUD_DRY_SRGB;

/** Linear RGB triple from an sRGB hex (for particle/decal shaders). */
export function mudLinearFromHex(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

// Shared mud browns — same hue family as RALLY_MUD_TRACK_SRGB.
export const RALLY_MUD_WET_LINEAR = mudLinearFromHex(MUD_WET_SRGB);   // fresh / rut wet
export const RALLY_MUD_BODY_LINEAR = mudLinearFromHex(MUD_DRY_SRGB);

export const RALLY_MUD_DECAL_DARK_LINEAR = mudLinearFromHex(MUD_WET_SRGB);
export const RALLY_MUD_DECAL_LIGHT_LINEAR = mudLinearFromHex(MUD_DRY_SRGB);
