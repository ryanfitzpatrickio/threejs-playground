import * as THREE from 'three';

/** sRGB hex for the rally mud road ribbon (createRallySurfaceMaterial mudSurface). */
export const RALLY_MUD_TRACK_SRGB = 0x7a5f38;

/** Linear RGB triple from an sRGB hex (for particle/decal shaders). */
export function mudLinearFromHex(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

// Shared mud browns — same hue family as RALLY_MUD_TRACK_SRGB.
export const RALLY_MUD_WET_LINEAR = mudLinearFromHex(0x625038);   // fresh / rut wet
export const RALLY_MUD_BODY_LINEAR = mudLinearFromHex(RALLY_MUD_TRACK_SRGB);

export const RALLY_MUD_DECAL_DARK_LINEAR = mudLinearFromHex(0x5e4a36);
export const RALLY_MUD_DECAL_LIGHT_LINEAR = mudLinearFromHex(0x7a5f38);
