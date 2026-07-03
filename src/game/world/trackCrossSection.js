/**
 * trackCrossSection.js
 *
 * Declarative GT3-style trackside cross-sections (data only — no THREE). A road
 * opts in via `road.trackStyle: '<preset name>'`; createTracksideLayers walks the
 * named preset's bands outward from the road edge and emits the matching geometry
 * + colliders along the road's centerline frame (trackFrame.js).
 *
 * A cross-section is an ORDERED list of bands, each laid OUTWARD from the previous
 * one (starting at the road edge u=half on each side). Every band is a function of
 * lateral offset `u` and arc length `s`, so the whole stack derives from the one
 * frame and cannot drift from the road ribbon.
 *
 * Band kinds (M2–M3):
 *   curb     — thin raised red/white rumble strip flush-ish with the road surface.
 *   chevronCurb — textured directional curb ribbon between asphalt and shoulder.
 *   shoulder — a verge ribbon whose inner edge sits at road height and whose outer
 *              edge drops to the natural terrain (so it meets the surrounding land).
 *   wall     — a vertical barrier extrusion with per-segment oriented-box colliders
 *              that physically contain the vehicle.
 *   fence    — repeated chain-link panels (instanced cards) standing along the
 *              offset line, facing across the road (no collider — behind the wall).
 *   fenceFlags — repeated physical poles with tall vertical flag textures mounted
 *              along the fence line.
 *   sponsor  — repeated advertising boards (instanced cards) at arc intervals,
 *              mounted above the wall and facing IN toward the track.
 *   asset    — an atlas-backed instanced card for barriers, race signs, cones,
 *              barricades, and other track dressing. Faces IN toward the track.
 *   prop     — repeated hero props (instanced procedural meshes) at arc intervals:
 *              grandstand (with crowd billboard), streetlight, brakingBoard. Faces
 *              IN toward the track, base rests on the terrain.
 *   continuousStand — stitched seating/roof polygons following uninterrupted road
 *              samples, with instanced supports, sponsor fascia, and roof flags.
 *   gantry   — an overhead arch spanning the road at intervals (placed on the
 *              centerline, sized to the road width).
 *   overheadAsset — a textured sign card aligned to an existing gantry.
 *   tunnelBore — the structural shell of a tunnel: vertical walls rising from the
 *              road edges to a springline, then an arched ceiling meeting at the
 *              centerline apex. Spans the whole road width from the centerline
 *              (ignores side/gap, like gantry). Emits wall + ceiling colliders so
 *              the vehicle is contained on all sides, not just left/right.
 *   tunnelLight — repeated ceiling-mounted light fixtures (instanced), placed at
 *              arc intervals along a tunnelBore, facing down into the roadway.
 *
 * Common band fields:
 *   side   'both' | 'left' | 'right'  (default 'both'). Left is +u, right is -u.
 *   gap    lateral spacing (m) before the band starts (default 0).
 * Surface bands (curb/shoulder): `width` (m), `lift` (m above road for the inner
 *   edge), and color(s). curb additionally takes `stripe` (m per colour cell) +
 *   `colorA`/`colorB`. shoulder takes a single `color` and drops its outer edge to
 *   terrain.
 * Wall bands: `height` (m), `thickness` (m), `color`.
 * Fence bands: `height` (m), `panel` (m per card, default 4), `color`, `opacity`.
 * Sponsor bands: `height` (m), `boardWidth` (m, default 5), `every` (m spacing,
 *   default 8), `mountY` (m, board bottom above road, default 0.8). Sponsor artwork
 *   is selected by the layer renderer from the urban-track texture set.
 * Asset bands: `asset`, `texture`, `width`, `height`, `every`, `phase`, and
 *   `mountY` describe the textured card and its staggered placement.
 * Prop bands: `prop` ('grandstand' | 'streetlight' | 'brakingBoard'), `every` (m
 *   spacing), `scale` (default 1).
 * Gantry bands: `every` (m spacing), `height` (m), `color`. Ignores side/gap (spans
 *   the road on the centerline).
 * TunnelBore bands: `wallHeight` (m, road → springline), `archRise` (m, springline
 *   → apex), `thickness` (m, shell thickness used for colliders), `color`. Ignores
 *   side/gap (spans the road from the centerline, like gantry).
 * TunnelLight bands: `every` (m spacing), `color`.
 */

export const TRACK_CROSS_SECTIONS = {
  urbanCircuit: {
    label: 'Urban Circuit',
    bands: [
      // Repeating red chevrons right at the asphalt edge, before the shoulder.
      { kind: 'chevronCurb', side: 'both', width: 1.1, lift: 0.1, tileLength: 2.5 },
      // Grass/dirt verge sloping out to the natural terrain.
      { kind: 'shoulder', side: 'both', width: 6, lift: 0.02, color: 0x4f5d3b },
      // Hard concrete barrier wall — contains the car.
      { kind: 'wall', side: 'both', gap: 0.15, height: 1.0, thickness: 0.4, color: 0x9b959a },
      // Atlas dressing attached to the wall line. Staggered phases keep the many
      // asset families useful and readable instead of stacking them together.
      { kind: 'asset', asset: 'hazardBarrier', texture: 'barrier_hazard.png', side: 'right', width: 2.4, height: 0.9, every: 36, phase: 6, mountY: 0.02 },
      { kind: 'asset', asset: 'blueBarrier', texture: 'barrier_blue_white.png', side: 'left', width: 2.4, height: 0.9, every: 36, phase: 18, mountY: 0.02 },
      { kind: 'asset', asset: 'reflectorWall', texture: 'wall_dark_reflectors.png', side: 'both', width: 2.4, height: 0.9, every: 72, phase: 30, mountY: 0.02 },
      { kind: 'asset', asset: 'checkpoint', texture: 'sign_checkpoint.png', side: 'both', width: 2.4, height: 1.2, every: 140, phase: 20, mountY: 1.05 },
      { kind: 'asset', asset: 'chevronLeft', texture: 'sign_chevron_left.png', side: 'left', width: 2.0, height: 1.0, every: 95, phase: 34, mountY: 0.9 },
      { kind: 'asset', asset: 'chevronRight', texture: 'sign_chevron_right.png', side: 'right', width: 2.0, height: 1.0, every: 95, phase: 34, mountY: 0.9 },
      { kind: 'asset', asset: 'slow', texture: 'sign_slow.png', side: 'both', width: 1.8, height: 1.0, every: 150, phase: 55, mountY: 0.9 },
      { kind: 'asset', asset: 'speed80', texture: 'sign_speed_80.png', side: 'right', width: 1.0, height: 1.0, every: 170, phase: 76, mountY: 0.9 },
      { kind: 'asset', asset: 'turnWarning', texture: 'sign_turn_warning.png', side: 'left', width: 1.1, height: 1.0, every: 170, phase: 76, mountY: 0.9 },
      { kind: 'asset', asset: 'constructionBarricade', texture: 'barricade_orange.png', side: 'right', width: 1.8, height: 1.1, every: 125, phase: 92, mountY: 0.02 },
      { kind: 'asset', asset: 'tireBarrier', texture: 'tire_barrier.png', side: 'left', width: 2.0, height: 1.25, every: 125, phase: 92, mountY: 0.02 },
      { kind: 'asset', asset: 'coneLamp', texture: 'cone_warning_lamp.png', side: 'both', width: 0.65, height: 1.25, every: 115, phase: 108, mountY: 0.02 },
      // Additional safety and race-control dressing cut from the supplied track
      // sheet. Long intervals and distinct phases keep signs readable at speed.
      { kind: 'asset', asset: 'cautionSlow', texture: 'sign_caution_slow.png', side: 'right', width: 1.0, height: 1.15, every: 190, phase: 22, mountY: 1.0 },
      { kind: 'asset', asset: 'speed100', texture: 'sign_speed_100.png', side: 'left', width: 0.9, height: 1.15, every: 210, phase: 72, mountY: 1.0 },
      { kind: 'asset', asset: 'trackExit', texture: 'sign_track_exit.png', side: 'right', width: 1.0, height: 1.15, every: 250, phase: 128, mountY: 1.0 },
      { kind: 'asset', asset: 'noSpectators', texture: 'sign_no_spectators.png', side: 'left', width: 1.0, height: 1.15, every: 260, phase: 188, mountY: 1.0 },
      { kind: 'asset', asset: 'yellowChevron', texture: 'chevron_yellow.png', side: 'right', width: 1.8, height: 0.9, every: 120, phase: 44, mountY: 0.9 },
      { kind: 'asset', asset: 'redChevron', texture: 'chevron_red.png', side: 'left', width: 1.8, height: 0.9, every: 120, phase: 44, mountY: 0.9 },
      { kind: 'asset', asset: 'orangeCone', texture: 'cone_orange.png', side: 'right', width: 0.55, height: 0.8, every: 85, phase: 36, mountY: 0.02 },
      { kind: 'asset', asset: 'limeCone', texture: 'cone_lime.png', side: 'left', width: 0.55, height: 0.8, every: 115, phase: 64, mountY: 0.02 },
      { kind: 'asset', asset: 'redPlasticBarrier', texture: 'plastic_barrier_red.png', side: 'right', width: 1.8, height: 1.0, every: 175, phase: 104, mountY: 0.02 },
      { kind: 'asset', asset: 'whitePlasticBarrier', texture: 'plastic_barrier_white.png', side: 'left', width: 1.8, height: 1.0, every: 175, phase: 104, mountY: 0.02 },
      { kind: 'asset', asset: 'tireWall', texture: 'tire_wall_redwhite.png', side: 'left', width: 2.8, height: 0.9, every: 190, phase: 144, mountY: 0.02 },
      { kind: 'asset', asset: 'concreteBarrier', texture: 'barrier_concrete.png', side: 'right', width: 2.1, height: 0.9, every: 210, phase: 154, mountY: 0.02 },
      { kind: 'asset', asset: 'redBarrier', texture: 'barrier_red.png', side: 'left', width: 2.4, height: 0.9, every: 210, phase: 184, mountY: 0.02 },
      { kind: 'asset', asset: 'hazardBarrierNew', texture: 'barrier_hazard_new.png', side: 'right', width: 2.1, height: 0.9, every: 230, phase: 204, mountY: 0.02 },
      { kind: 'asset', asset: 'warningCone', texture: 'cone_warning.png', side: 'left', width: 0.55, height: 0.8, every: 135, phase: 94, mountY: 0.02 },
      { kind: 'asset', asset: 'blueTireStack', texture: 'tire_stack_blue.png', side: 'right', width: 0.7, height: 1.0, every: 240, phase: 34, mountY: 0.02 },
      { kind: 'asset', asset: 'redTireStack', texture: 'tire_stack_red.png', side: 'left', width: 0.7, height: 1.0, every: 240, phase: 154, mountY: 0.02 },
      // Freestanding flag cards include their own poles and sit beyond the fence.
      { kind: 'asset', asset: 'flagMotul', texture: 'flag_motul.png', side: 'left', offset: 1.5, width: 0.85, height: 3.2, every: 150, phase: 18, mountY: 0.02 },
      { kind: 'asset', asset: 'flagFalken', texture: 'flag_falken.png', side: 'right', offset: 1.5, width: 0.8, height: 3.2, every: 150, phase: 48, mountY: 0.02 },
      { kind: 'asset', asset: 'flagDunlop', texture: 'flag_dunlop.png', side: 'left', offset: 1.5, width: 0.8, height: 3.2, every: 150, phase: 78, mountY: 0.02 },
      { kind: 'asset', asset: 'flagPitEntry', texture: 'flag_pit_entry.png', side: 'right', offset: 1.5, width: 0.72, height: 3.2, every: 220, phase: 118, mountY: 0.02 },
      { kind: 'asset', asset: 'flagPitExit', texture: 'flag_pit_exit.png', side: 'left', offset: 1.5, width: 0.72, height: 3.2, every: 220, phase: 168, mountY: 0.02 },
      // Four additional sponsor families break up the two-board repetition.
      { kind: 'asset', asset: 'sponsorSpeedhunters', texture: 'sponsor_speedhunters.png', side: 'left', width: 4.8, height: 1.25, every: 64, phase: 8, mountY: 1.0 },
      { kind: 'asset', asset: 'sponsorMobil', texture: 'sponsor_mobil.png', side: 'right', width: 4.8, height: 1.25, every: 64, phase: 24, mountY: 1.0 },
      { kind: 'asset', asset: 'sponsorDunlop', texture: 'sponsor_dunlop.png', side: 'left', width: 4.8, height: 1.25, every: 64, phase: 40, mountY: 1.0 },
      { kind: 'asset', asset: 'sponsorFalken', texture: 'sponsor_falken.png', side: 'right', width: 4.8, height: 1.25, every: 64, phase: 56, mountY: 1.0 },
      // Advertising hoardings above the wall, facing the track.
      { kind: 'sponsor', side: 'both', gap: 0.1, height: 1.2, boardWidth: 5, every: 8, mountY: 0.9 },
      // Chain-link fence behind the hoardings.
      { kind: 'fence', side: 'both', gap: 0.3, height: 4.4, panel: 4, curvedTop: 1.15, curveReach: 1.25, curveSegments: 4, color: 0xb8c0c6, opacity: 0.42 },
      { kind: 'fenceFlags', side: 'both', every: 48, phase: 24, poleHeight: 5.2, flagWidth: 0.9, flagHeight: 3.1, offset: 0.18,
        textures: ['flag_motul.png', 'flag_falken.png', 'flag_dunlop.png'] },
      // Hero props: grandstands one side, streetlights the other, marker boards, and
      // overhead gantries spanning the road.
      { kind: 'continuousStand', side: 'left', gap: 2, depth: 11, frontHeight: 0.8, backHeight: 5.2, roofHeight: 6.4 },
      { kind: 'prop', side: 'right', prop: 'streetlight', gap: 1, every: 26 },
      { kind: 'prop', side: 'right', prop: 'brakingBoard', gap: 0.5, every: 55 },
      { kind: 'gantry', every: 110, phase: 55, height: 6.5, color: 0x3a3d42 },
      { kind: 'overheadAsset', asset: 'gantrySpeedhunters', texture: 'sponsor_speedhunters.png', every: 220, phase: 55, height: 6.5, width: 11.5, boardHeight: 1.45 },
      { kind: 'overheadAsset', asset: 'gantryDunlop', texture: 'sponsor_dunlop.png', every: 220, phase: 165, height: 6.5, width: 11.5, boardHeight: 1.45 },
    ],
  },

  tunnel: {
    label: 'Tunnel',
    bands: [
      // Directional curb hugging the road edge, same as the open-air preset.
      { kind: 'chevronCurb', side: 'both', width: 1.1, lift: 0.1, tileLength: 2.5 },
      // The structural shell: walls + arched ceiling, contains the vehicle on
      // every side. wallHeight + archRise MUST match roadProfile's
      // TUNNEL_INTERIOR_HEIGHT (5.2) so the terrain-cover math agrees with what's
      // actually built.
      { kind: 'tunnelBore', wallHeight: 3.4, archRise: 1.8, thickness: 0.5, color: 0x5a5850 },
      // Ceiling lights every 18m.
      { kind: 'tunnelLight', every: 18, color: 0xfff2c8 },
    ],
  },
};

export const TRACK_CROSS_SECTION_ORDER = Object.keys(TRACK_CROSS_SECTIONS);

/** Resolve a preset by name. Returns null for null/unknown (road stays plain). */
export function resolveCrossSection(name) {
  if (!name || typeof name !== 'string') return null;
  return TRACK_CROSS_SECTIONS[name] ?? null;
}
