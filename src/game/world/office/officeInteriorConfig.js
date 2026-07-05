// officeInteriorConfig.js — decoupled dimensions for perimeter windows vs story height.
//
// Walkable floor / wall height (STORY_HEIGHT) is separate from the interior-mapping
// "fake room" seen through the glass — windows can be taller/wider/deeper than the
// wall module implies.

import { STORY_HEIGHT } from './generateOfficeLayout.js';

/** Perimeter interior-mapping window + analytic room behind the glass. */
export const OFFICE_PERIMETER_WINDOW = {
  width: 2.35,
  height: 2.55,
  roomDepth: 5.2,
  sill: 0.22,
  headMargin: 0.18,
};

/** Centre Y of the window quad given floor level and story height. */
export function perimeterWindowCenterY(floorY, wallHeight = STORY_HEIGHT) {
  const { height, sill, headMargin } = OFFICE_PERIMETER_WINDOW;
  const maxH = wallHeight - sill - headMargin;
  const h = Math.min(height, maxH);
  return floorY + sill + h * 0.5;
}

export function perimeterWindowHeight(wallHeight = STORY_HEIGHT) {
  const { height, sill, headMargin } = OFFICE_PERIMETER_WINDOW;
  return Math.min(height, wallHeight - sill - headMargin);
}
