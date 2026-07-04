/**
 * createRoadworks.js
 *
 * Builds the visible + collidable road geometry from a road profile
 * (src/world/worldMap/roadProfile.js):
 *   - one paved ribbon mesh per road at roadY (terrain conforms underneath where
 *     grounded; the ribbon also covers bridged spans),
 *   - bridged spans get per-segment cuboid DECK colliders (walkable + analytic
 *     ground via the existing collider path) and support PIER box meshes down to the
 *     terrain.
 * Roads are static, so this is built once at level construction.
 *
 * Returns { group, colliders, dispose }. Colliders go into level.colliders so
 * PhysicsSystem builds them and getGroundHeightAt can stand the player on a bridge.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createRibbonRoadMaterial } from '../../three-addons/generators/CityGenerator.js';
import { createRallySurfaceMaterial, loadRallyRutAtlas, loadRallySurfaceSet } from '../materials/rallySurfaceTextures.js';
import { rainWetness, rainWind } from '../systems/weatherUniforms.js';
import { BRIDGE_THRESH } from '../../world/worldMap/roadProfile.js';
import { buildRibbonFrame, offsetPoint } from '../../world/worldMap/trackFrame.js';
import { chunkGeometriesByGrid } from '../utils/chunkGeometryByGrid.js';
import { surfaceForRoad } from '../../world/worldMap/roadSurface.js';
import { getQualityPreset, getQualityLevel } from '../config/qualityPresets.js';

// Parallax occlusion mapping for rally surfaces is quality-gated (ultra-only).
// Read once at module load — the dirt material below is a build-once singleton,
// matching the existing pattern for the other module-level road materials.
const rallyParallaxOcclusion = getQualityPreset(getQualityLevel()).parallaxOcclusion ?? null;

// Chunk size (metres) the merged ribbon geometry is split into so Three.js's
// default per-mesh frustum culling can skip whole chunks that are off-screen —
// a large road network no longer has to be one always-submitted mesh. See
// chunkGeometryByGrid.js.
const RIBBON_CHUNK_SIZE = 128;

const RIBBON_LIFT = 0.10;   // sit the ribbon cleanly above the graded terrain
export const ROAD_SURFACE_LIFT = RIBBON_LIFT;
const DECK_THICK = 0.6;
// Vertical skirt dropped from each road edge so the ribbon reads as a solid slab
// instead of a paper-thin plane. Top of the skirt is flush with the ribbon surface.
const SIDE_DEPTH = 0.6;
// Lengthen each pitched deck box slightly along the road so consecutive decks (and
// the deck↔grounded-terrain boundary at a bridge foot) overlap instead of leaving a
// hairline seam the player/vehicle can drop through. The boxes are pitched to road
// grade, so this overlap stays at road height — it never forms a step/wall.
const DECK_OVERLAP = 0.4;
const PIER_SPACING = 14;    // metres between piers on a bridged span
const PIER_HALF = 0.7;

// The road ribbon + side skirts share the city's procedural wet-asphalt TSL
// material, dressed with lane/edge markings driven by a per-vertex `roadMark`
// attribute (world-space asphalt, so it still tiles seamlessly). Built once.
const roadMaterial = createRibbonRoadMaterial({ rainWetness, rainWind });
roadMaterial.side = THREE.DoubleSide;
const dirtRoadMaterial = createRallySurfaceMaterial(loadRallySurfaceSet('dirt'), { rainWetness, rainWind, parallaxOcclusion: rallyParallaxOcclusion });
dirtRoadMaterial.side = THREE.DoubleSide;
const pierMaterial = new THREE.MeshStandardMaterial({ color: 0x555154, roughness: 0.9, metalness: 0.04 });
const intersectionPaintMaterial = new THREE.MeshStandardMaterial({
  color: 0xd8d5ca,
  roughness: 0.82,
  metalness: 0,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});

// POM marches in tangent space, so the rally ribbon meshes need a `tangent`
// attribute. THREE.computeTangents() requires an index, but chunkGeometriesByGrid
// emits non-indexed triangle soup — add a trivial sequential index first (POM
// reads the resulting per-vertex tangents; it does not need shared-vertex
// indexing). One-time, static geometry, only when POM is enabled.
function ensureRibbonTangents(geom) {
  if (!geom.getAttribute('uv') || !geom.getAttribute('normal')) return;
  if (!geom.index) {
    const count = geom.attributes.position.count;
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) idx[i] = i;
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  geom.computeTangents();
}

function roadHash(roadIndex, sampleIndex, salt) {
  const x = Math.sin((roadIndex + 1) * 91.17 + sampleIndex * 17.31 + salt * 11.7) * 43758.5453;
  return x - Math.floor(x);
}

// Lateral columns across a MUD road ribbon. The lean 2-vert edge strip can't hold
// a rut between the wheels; interior columns give the mud material's vertex
// displacement geometry to actually push down into a trough. Denser (was 42) so a
// TIGHT ~0.4 m rut still lands on ~2 columns and reads as a crisp channel instead
// of a smeared dip. Odd so a column lands on the centreline.
const MUD_RIBBON_COLUMNS = 73;
const ROAD_UV_LENGTH = 3.2;

// Mud roads sit as a slightly-proud "soft mud" layer: the flat ribbon is lifted
// this much extra, and the vertex sink pushes ruts back down THROUGH that lift so
// a full-depth rut bottoms out around the underlying road/terrain height instead
// of dipping BELOW it (which would let the light terrain poke through the trough).
// Kept small: this lift is also how far a resting tyre "sinks" into the flat mud,
// so too much buries the car to its axles.
const MUD_RIBBON_LIFT_EXTRA = 0.18;
// Metres a full-depth (normalized 1.0) rut displaces the ribbon down. Sized to the
// available headroom (base lift + extra) so rut bottoms land at ~terrain height.
export const MUD_VISUAL_SINK = RIBBON_LIFT + MUD_RIBBON_LIFT_EXTRA;

// Soft mud shoulders. Other roads drop a VERTICAL side skirt (SIDE_DEPTH), which on
// a mud road leaves a hard step where the proud ribbon (lifted the amounts above)
// meets the lower surrounding terrain — a visible seam. Instead a mud edge rolls
// off as a rounded berm: it flares outward while easing DOWN below the sampled
// ground, so the lift folds into the terrain and reads as a mound of mud piled
// along the road rather than a cut edge.
const MUD_SHOULDER_WIDTH = 1.4;   // lateral roll-off distance (m) beyond the edge
const MUD_SHOULDER_COLUMNS = 5;   // verts across the shoulder (col 0 = welded edge)
const MUD_SHOULDER_TUCK = 0.22;   // metres the outer rim sinks below terrain

// Build a rolled mud shoulder for one road edge. Column 0 welds exactly to the
// ribbon's (jittered) outer edge vertex at the raised mud surface; the remaining
// columns flare outward by MUD_SHOULDER_WIDTH while easing down (smoothstep, so the
// top stays flat like a mound crest and the base rounds into the ground) to
// MUD_SHOULDER_TUCK below the terrain sampled at each column, burying the seam.
function buildMudShoulderGeometry({
  frame, roadY, n, half, arc, roadIndex, edge, side, intersectionMask, sampleHeight,
}) {
  const S = MUD_SHOULDER_COLUMNS;
  const positions = new Float32Array(n * S * 3);
  const roadMark = new Float32Array(n * S * 3);
  const roadIntersection = new Float32Array(n * S);
  const uvs = new Float32Array(n * S * 2);
  for (let i = 0; i < n; i += 1) {
    const yTop = roadY[i] + RIBBON_LIFT + MUD_RIBBON_LIFT_EXTRA;
    for (let k = 0; k < S; k += 1) {
      const tk = k / (S - 1); // 0 at the road edge → 1 at the outer rim
      const vi = i * S + k;
      const o = vi * 3;
      let px;
      let pz;
      let py;
      if (k === 0) {
        // Weld to the ribbon's outer edge vertex so there is no crack/overlap.
        px = edge[i].x;
        pz = edge[i].z;
        py = yTop;
      } else {
        const p = offsetPoint(frame, i, side * (half + tk * MUD_SHOULDER_WIDTH));
        px = p.x;
        pz = p.z;
        const ground = sampleHeight(px, pz) - MUD_SHOULDER_TUCK;
        const s = tk * tk * (3 - 2 * tk); // smoothstep ease
        py = yTop + (ground - yTop) * s;
      }
      positions[o] = px;
      positions[o + 1] = py;
      positions[o + 2] = pz;
      roadMark[o] = side * half; // clamp marking coord to the edge (mud has no lanes)
      roadMark[o + 1] = arc[i];
      roadMark[o + 2] = half;
      roadIntersection[vi] = intersectionMask?.[i] ?? 1;
      uvs[vi * 2] = tk;
      uvs[vi * 2 + 1] = arc[i] / ROAD_UV_LENGTH;
    }
  }
  const indices = [];
  for (let i = 0; i < n - 1; i += 1) {
    for (let k = 0; k < S - 1; k += 1) {
      const a = i * S + k;
      const b = a + 1;
      const c = (i + 1) * S + k;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('roadMark', new THREE.BufferAttribute(roadMark, 3));
  geom.setAttribute('roadIntersection', new THREE.BufferAttribute(roadIntersection, 1));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// Build a laterally dense ribbon (C columns across) for a mud road, filling
// edgeL/edgeR from the outer columns (skirts + colliders reuse them). Same
// roadMark(signed lateral, arc, half-width) + roadIntersection attributes the
// lean ribbon carries, so it merges into the same material.
function buildDenseRibbonGeometry({ frame, roadY, n, half, arc, roadIndex, intersectionMask, edgeL, edgeR }) {
  const C = MUD_RIBBON_COLUMNS;
  const positions = new Float32Array(n * C * 3);
  const roadMark = new Float32Array(n * C * 3);
  const roadIntersection = new Float32Array(n * C);
  const uvs = new Float32Array(n * C * 2);
  for (let i = 0; i < n; i += 1) {
    const y = roadY[i] + RIBBON_LIFT + MUD_RIBBON_LIFT_EXTRA;
    const jitterL = (roadHash(roadIndex, i, 1) - 0.5) * 0.34;
    const jitterR = (roadHash(roadIndex, i, 2) - 0.5) * 0.34;
    for (let j = 0; j < C; j += 1) {
      // +half (left edge) → -half (right edge); edges carry the loose jitter.
      const t = j / (C - 1);
      let lat = half - t * 2 * half;
      if (j === 0) lat = half + jitterL;
      else if (j === C - 1) lat = -half - jitterR;
      const p = offsetPoint(frame, i, lat);
      const vi = i * C + j;
      const o = vi * 3;
      positions[o] = p.x;
      positions[o + 1] = y;
      positions[o + 2] = p.z;
      roadMark[o] = lat;
      roadMark[o + 1] = arc[i];
      roadMark[o + 2] = half;
      roadIntersection[vi] = intersectionMask?.[i] ?? 1;
      uvs[vi * 2] = t;
      uvs[vi * 2 + 1] = arc[i] / ROAD_UV_LENGTH;
      if (j === 0) edgeL[i] = { x: p.x, z: p.z };
      else if (j === C - 1) edgeR[i] = { x: p.x, z: p.z };
    }
  }
  const indices = [];
  for (let i = 0; i < n - 1; i += 1) {
    for (let j = 0; j < C - 1; j += 1) {
      const a = i * C + j;
      const b = a + 1;
      const c = (i + 1) * C + j;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('roadMark', new THREE.BufferAttribute(roadMark, 3));
  geom.setAttribute('roadIntersection', new THREE.BufferAttribute(roadIntersection, 1));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

export function createRoadworks({ profile, sampleHeight, mudField = null }) {
  const group = new THREE.Group();
  group.name = 'Roadworks';
  group.userData.noCollision = true;

  const colliders = [];
  const ribbonGeoms = [];
  const dirtRibbonGeoms = [];
  const mudRibbonGeoms = [];
  const pierMatrices = [];
  const paintGeoms = [];

  // Mud roads get their OWN lazily-built material (same dirt textures + the deform
  // node), NOT the shared module-level `dirtRoadMaterial` — so world-mode dirt
  // roads stay byte-for-byte unchanged (scope guarantee). Built once, only if a
  // mud ribbon actually exists (rally maps with a mud road).
  let mudRoadMaterial = null;
  const getMudRoadMaterial = () => {
    if (mudRoadMaterial) return mudRoadMaterial;
    const tex = mudField?.ensureTexture?.() ?? null;
    const footprint = mudField?.footprint ?? 0;
    mudRoadMaterial = createRallySurfaceMaterial(loadRallySurfaceSet('dirt'), {
      rainWetness,
      rainWind,
      deformTexture: tex,
      orientationTexture: mudField?.orientationTexture ?? null,
      deformTilesPerMetre: mudField?.deformTilesPerMetre ?? null,
      rutAtlas: loadRallyRutAtlas('rut'),
      heavyRutAtlas: loadRallyRutAtlas('rut-heavy'),
      mudSurface: true,
      parallaxOcclusion: rallyParallaxOcclusion,
      // Real geometric ruts: displace the dense ribbon down by the deform depth,
      // faded to zero beyond the (torus-wrapped) footprint around the car. Sized
      // to the ribbon's lift headroom so ruts bottom out at ~terrain height.
      deformSinkScale: MUD_VISUAL_SINK,
      deformCenter: mudField?.centerUniform ?? null,
      deformFadeNear: footprint * 0.35,
      deformFadeFar: footprint * 0.47,
    });
    mudRoadMaterial.side = THREE.DoubleSide;
    return mudRoadMaterial;
  };

  // Scratch for building the pitched-deck orientation (avoids per-segment allocs).
  const _dir = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _basis = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();

  profile.roads.forEach((b, roadIndex) => {
    const { samples, n, half, roadY, terrainY, grounded } = b;
    const forceDeckCollider = b.road?.trackStyle === 'tunnel';
    const surf = surfaceForRoad(b.road);
    const isMud = surf === 'mud';
    // Mud is a loose surface like dirt (edge jitter, matte PBR); it just also
    // routes to the deform-textured mud material.
    const isLoose = surf === 'dirt' || isMud;
    const targetRibbonGeoms = isMud ? mudRibbonGeoms : (isLoose ? dirtRibbonGeoms : ribbonGeoms);

    // Per-sample ribbon edge points (left/right of centerline). Cached so both the
    // ribbon mesh and the deck colliders fit the *actual* rotated road footprint —
    // the deck AABBs are built from these corners, not by inflating the centerline
    // bbox by `half` (which over-extended boxes along the travel axis and put an
    // invisible wall over the grounded terrain at bridge ends).
    const edgeL = new Array(n);
    const edgeR = new Array(n);

    // Per-sample frame (arc, unit tangent, road-perpendicular normal, position)
    // shared with the trackside layer stack so the ribbon, the deck colliders, and
    // the outboard layers all derive from one source and cannot drift. `arc` drives
    // the dashed centre line.
    const frame = buildRibbonFrame(b);
    const arc = frame.arc;

    // Ribbon: a strip of left/right verts per sample. `roadMark` carries the
    // marking coordinate per vertex: (signed lateral metres, arc length, half-width).
    // Mud roads instead build a laterally DENSE ribbon so the mud material can
    // displace real ruts; edgeL/edgeR still come from its outer columns.
    if (isMud) {
      const geom = buildDenseRibbonGeometry({
        frame, roadY, n, half, arc, roadIndex,
        intersectionMask: b.intersectionMask, edgeL, edgeR,
      });
      targetRibbonGeoms.push(geom);
    } else {
    const positions = new Float32Array(n * 2 * 3);
    const roadMark = new Float32Array(n * 2 * 3);
    const roadIntersection = new Float32Array(n * 2);
    const uvs = new Float32Array(n * 2 * 2);
    for (let i = 0; i < n; i += 1) {
      const y = roadY[i] + RIBBON_LIFT;
      // u = +half → left edge, -half → right edge (matches the old perpendicular).
      const edgeJitterL = isLoose ? (roadHash(roadIndex, i, 1) - 0.5) * 0.34 : 0;
      const edgeJitterR = isLoose ? (roadHash(roadIndex, i, 2) - 0.5) * 0.34 : 0;
      const eL = offsetPoint(frame, i, half + edgeJitterL);
      const eR = offsetPoint(frame, i, -half - edgeJitterR);
      const lx = eL.x;
      const lz = eL.z;
      const rx = eR.x;
      const rz = eR.z;
      edgeL[i] = { x: lx, z: lz };
      edgeR[i] = { x: rx, z: rz };
      const o = i * 6;
      positions[o] = lx;
      positions[o + 1] = y;
      positions[o + 2] = lz;
      positions[o + 3] = rx;
      positions[o + 4] = y;
      positions[o + 5] = rz;
      // left edge is +half, right edge is -half; fragment interpolates across the road.
      roadMark[o] = half;
      roadMark[o + 1] = arc[i];
      roadMark[o + 2] = half;
      roadMark[o + 3] = -half;
      roadMark[o + 4] = arc[i];
      roadMark[o + 5] = half;
      roadIntersection[i * 2] = b.intersectionMask?.[i] ?? 1;
      roadIntersection[i * 2 + 1] = b.intersectionMask?.[i] ?? 1;
      uvs[i * 4] = 0;
      uvs[i * 4 + 1] = arc[i] / ROAD_UV_LENGTH;
      uvs[i * 4 + 2] = 1;
      uvs[i * 4 + 3] = arc[i] / ROAD_UV_LENGTH;
    }
    const indices = [];
    for (let i = 0; i < n - 1; i += 1) {
      const a = i * 2, bb = a + 1, c = a + 2, d = a + 3;
      indices.push(a, c, bb, bb, c, d);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('roadMark', new THREE.BufferAttribute(roadMark, 3));
    geom.setAttribute('roadIntersection', new THREE.BufferAttribute(roadIntersection, 1));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    targetRibbonGeoms.push(geom);
    }

    // Mud roads: the proud ribbon rolls off each edge as a rounded berm that tucks
    // under the terrain (see buildMudShoulderGeometry) instead of a vertical skirt,
    // so the lift seam folds into the ground rather than reading as a cut step.
    if (isMud) {
      targetRibbonGeoms.push(buildMudShoulderGeometry({
        frame, roadY, n, half, arc, roadIndex, edge: edgeL, side: 1,
        intersectionMask: b.intersectionMask, sampleHeight,
      }));
      targetRibbonGeoms.push(buildMudShoulderGeometry({
        frame, roadY, n, half, arc, roadIndex, edge: edgeR, side: -1,
        intersectionMask: b.intersectionMask, sampleHeight,
      }));
    } else {
    // Side skirts: a vertical strip dropped from each edge (left and right), top
    // flush with the ribbon surface, bottom SIDE_DEPTH below. Gives the road slab
    // visible thickness from the side.
    for (const edge of [edgeL, edgeR]) {
      const sidePos = new Float32Array(n * 2 * 3);
      // Skirt verts sit at the curb (lateral = ±half → edgeDist 0), so the marking
      // shader paints nothing on them; they still need the attribute to merge.
      const sideMark = new Float32Array(n * 2 * 3);
      const sideIntersection = new Float32Array(n * 2);
      const sideUvs = new Float32Array(n * 2 * 2);
      const lat = edge === edgeL ? half : -half;
      for (let i = 0; i < n; i += 1) {
        const topYi = roadY[i] + RIBBON_LIFT;
        const o = i * 6;
        sidePos[o] = edge[i].x;
        sidePos[o + 1] = topYi;
        sidePos[o + 2] = edge[i].z;
        sidePos[o + 3] = edge[i].x;
        sidePos[o + 4] = topYi - SIDE_DEPTH;
        sidePos[o + 5] = edge[i].z;
        sideMark[o] = lat;
        sideMark[o + 1] = arc[i];
        sideMark[o + 2] = half;
        sideMark[o + 3] = lat;
        sideMark[o + 4] = arc[i];
        sideMark[o + 5] = half;
        sideIntersection[i * 2] = 0;
        sideIntersection[i * 2 + 1] = 0;
        sideUvs[i * 4] = arc[i] / ROAD_UV_LENGTH;
        sideUvs[i * 4 + 1] = 0;
        sideUvs[i * 4 + 2] = arc[i] / ROAD_UV_LENGTH;
        sideUvs[i * 4 + 3] = 1;
      }
      const sideIdx = [];
      for (let i = 0; i < n - 1; i += 1) {
        const a = i * 2, bb = a + 1, c = a + 2, d = a + 3;
        sideIdx.push(a, c, bb, bb, c, d);
      }
      const sideGeom = new THREE.BufferGeometry();
      sideGeom.setAttribute('position', new THREE.BufferAttribute(sidePos, 3));
      sideGeom.setAttribute('roadMark', new THREE.BufferAttribute(sideMark, 3));
      sideGeom.setAttribute('roadIntersection', new THREE.BufferAttribute(sideIntersection, 1));
      sideGeom.setAttribute('uv', new THREE.BufferAttribute(sideUvs, 2));
      sideGeom.setIndex(sideIdx);
      sideGeom.computeVertexNormals();
      targetRibbonGeoms.push(sideGeom);
    }
    }

    // Bridged spans → deck colliders + piers.
    let lastPierS = -Infinity;
    let accumS = 0;
    for (let i = 0; i < n - 1; i += 1) {
      const segLen = Math.hypot(samples[i + 1].x - samples[i].x, samples[i + 1].z - samples[i].z);
      accumS += segLen;
      // Profile grounded flags are sampled before river carves; re-check clearance
      // against the final shaped surface so roads over water still get deck boxes.
      if (!forceDeckCollider && grounded[i] && grounded[i + 1]
        && (b.fixed || !segmentNeedsDeckCollider({
          samples, roadY, i, sampleHeight, bridgeThresh: BRIDGE_THRESH,
        }))) continue;

      const a = samples[i];
      const c = samples[i + 1];
      const topY = Math.max(roadY[i], roadY[i + 1]);
      // Deck collider: AABB fit tightly to the four ribbon corners of this segment.
      // Only the perpendicular half-width inflates the box (the centerline span sets
      // the travel-axis extent), so consecutive decks tile end-to-end instead of
      // overhanging the grounded terrain at a bridge's foot.
      const cl0 = edgeL[i], cr0 = edgeR[i], cl1 = edgeL[i + 1], cr1 = edgeR[i + 1];

      // Pitched oriented box: the top face follows the road slope so a dynamic
      // vehicle rolls along a continuous ramp. dir runs down the segment (with its
      // vertical rise), right is the horizontal road-perpendicular, normal is the
      // tilted deck up. The box is built around these axes (x=right, y=normal,
      // z=dir) and centered half a deck-thickness below the ribbon surface.
      const y0 = roadY[i] + RIBBON_LIFT;
      const y1 = roadY[i + 1] + RIBBON_LIFT;
      _dir.set(c.x - a.x, y1 - y0, c.z - a.z);
      const segLen3 = _dir.length() || 1;
      _dir.multiplyScalar(1 / segLen3);
      _right.set(cr0.x - cl0.x, 0, cr0.z - cl0.z);
      if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
      _right.normalize();
      _normal.copy(_dir).cross(_right).normalize(); // dir × right → tilted up (y>0)
      _basis.makeBasis(_right, _normal, _dir);
      _quat.setFromRotationMatrix(_basis);
      // Center: midpoint of the two top edges, dropped half a thickness along normal.
      const midX = (a.x + c.x) * 0.5;
      const midZ = (a.z + c.z) * 0.5;
      const midY = (y0 + y1) * 0.5;
      const halfThick = DECK_THICK * 0.5;

      colliders.push({
        name: `Road Deck ${roadIndex}-${i}`,
        // Overlap-padded so the analytic ground-snap has no seam between decks
        // either (small enough that at a bridge foot it stays flush with the road).
        minX: Math.min(cl0.x, cr0.x, cl1.x, cr1.x) - DECK_OVERLAP,
        maxX: Math.max(cl0.x, cr0.x, cl1.x, cr1.x) + DECK_OVERLAP,
        minZ: Math.min(cl0.z, cr0.z, cl1.z, cr1.z) - DECK_OVERLAP,
        maxZ: Math.max(cl0.z, cr0.z, cl1.z, cr1.z) + DECK_OVERLAP,
        topY: topY + RIBBON_LIFT,
        bottomY: topY - DECK_THICK,
        // Analytic character grounding must follow the pitched top face. topY is
        // still the AABB maximum used by broad-phase/blocking queries.
        surfaceHeightAt: (x, z) => deckSurfaceHeightAt({
          x, z,
          x0: a.x, z0: a.z, y0,
          x1: c.x, z1: c.z, y1,
        }),
        // Oriented box for the Rapier physics build (smooth ramp, no risers).
        center: {
          x: midX - _normal.x * halfThick,
          y: midY - _normal.y * halfThick,
          z: midZ - _normal.z * halfThick,
        },
        halfExtents: { x: half, y: halfThick, z: segLen3 * 0.5 + DECK_OVERLAP },
        orientation: { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w },
        width: half * 2,
        depth: segLen,
        vaultable: false,
      });

      // Piers down to the terrain at intervals.
      if (accumS - lastPierS >= PIER_SPACING) {
        lastPierS = accumS;
        const mx = (a.x + c.x) * 0.5;
        const mz = (a.z + c.z) * 0.5;
        const ground = Math.min(terrainY[i], terrainY[i + 1], sampleHeight(mx, mz));
        const deckBottom = topY - DECK_THICK;
        const h = deckBottom - ground;
        if (h > 1) {
          const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(mx, ground + h * 0.5, mz),
            new THREE.Quaternion(),
            new THREE.Vector3(PIER_HALF * 2, h, PIER_HALF * 2),
          );
          pierMatrices.push(matrix);
        }
      }
    }
  });

  // One flat asphalt polygon per detected junction. A regular polygon is used
  // instead of letting independently pitched ribbons overlap: its single Y plane
  // guarantees a level driving surface while the leveled road profiles ease every
  // connected approach onto it.
  for (const intersection of profile.intersections ?? []) {
    // Junction pads use the shared dirt look for any loose (dirt/mud) approach —
    // no deform on the flat pad in v1; paint only on paved approaches.
    const loose = intersection.connections?.some((connection) => {
      const s = surfaceForRoad(profile.roads[connection.roadIndex]?.road);
      return s === 'dirt' || s === 'mud';
    });
    (loose ? dirtRibbonGeoms : ribbonGeoms).push(createIntersectionSurface(intersection));
    if (!loose) paintGeoms.push(...createIntersectionPaint(intersection));
  }

  if (ribbonGeoms.length > 0) {
    // Chunked instead of one merged mesh: a large road network would otherwise
    // be a single always-submitted mesh regardless of how much of it is
    // actually on screen.
    const chunks = chunkGeometriesByGrid(ribbonGeoms, RIBBON_CHUNK_SIZE);
    for (const g of ribbonGeoms) g.dispose();
    for (const [key, geom] of chunks) {
      geom.computeBoundingSphere();
      const mesh = new THREE.Mesh(geom, roadMaterial);
      mesh.name = `Road Ribbon ${key}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      group.add(mesh);
    }
  }

  if (dirtRibbonGeoms.length > 0) {
    const chunks = chunkGeometriesByGrid(dirtRibbonGeoms, RIBBON_CHUNK_SIZE);
    for (const g of dirtRibbonGeoms) g.dispose();
    for (const [key, geom] of chunks) {
      geom.computeBoundingSphere();
      // Only when enabled, so default (non-ultra) road geometry is unchanged.
      if (rallyParallaxOcclusion?.enabled) ensureRibbonTangents(geom);
      const mesh = new THREE.Mesh(geom, dirtRoadMaterial);
      mesh.name = `Dirt Rally Road Ribbon ${key}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      group.add(mesh);
    }
  }

  if (mudRibbonGeoms.length > 0) {
    const material = getMudRoadMaterial();
    const chunks = chunkGeometriesByGrid(mudRibbonGeoms, RIBBON_CHUNK_SIZE);
    for (const g of mudRibbonGeoms) g.dispose();
    for (const [key, geom] of chunks) {
      geom.computeBoundingSphere();
      if (rallyParallaxOcclusion?.enabled) ensureRibbonTangents(geom);
      const mesh = new THREE.Mesh(geom, material);
      mesh.name = `Mud Rally Road Ribbon ${key}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      group.add(mesh);
    }
  }

  if (pierMatrices.length > 0) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geometry, pierMaterial, pierMatrices.length);
    for (let i = 0; i < pierMatrices.length; i += 1) mesh.setMatrixAt(i, pierMatrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = 'Road Piers';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.lodDistance = 260;
    group.add(mesh);
  }

  if (paintGeoms.length > 0) {
    const merged = mergeGeometries(paintGeoms, false);
    for (const g of paintGeoms) g.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, intersectionPaintMaterial);
      mesh.name = 'Intersection White Paint Decals';
      mesh.receiveShadow = true;
      mesh.renderOrder = 3;
      group.add(mesh);
    }
  }

  group.userData.intersections = (profile.intersections ?? []).map((intersection) => ({
    id: intersection.id,
    x: intersection.x,
    z: intersection.z,
    elevation: intersection.y + RIBBON_LIFT,
    wayCount: intersection.wayCount,
  }));

  return {
    group,
    colliders,
    updateLOD: (position) => updateDistanceLOD(group, position),
    dispose: () => disposeObject3D(group),
  };
}

function updateDistanceLOD(root, position) {
  if (!position) return;
  root.traverse((object) => {
    const distance = object.userData?.lodDistance;
    if (!distance || !object.geometry) return;
    if (object.isInstancedMesh) {
      if (!object.boundingSphere) object.computeBoundingSphere();
    } else if (!object.geometry.boundingSphere) {
      object.geometry.computeBoundingSphere();
    }
    const sphere = object.isInstancedMesh ? object.boundingSphere : object.geometry.boundingSphere;
    const center = sphere.center.clone().applyMatrix4(object.matrixWorld);
    object.visible = center.distanceTo(position) - sphere.radius <= distance;
  });
}

function createIntersectionSurface(intersection) {
  const sides = 20;
  const vertexCount = sides + 1;
  const positions = new Float32Array(vertexCount * 3);
  const roadMark = new Float32Array(vertexCount * 3);
  const roadIntersection = new Float32Array(vertexCount);
  const uvs = new Float32Array(vertexCount * 2);
  const y = intersection.y + RIBBON_LIFT + 0.008;
  positions[0] = intersection.x;
  positions[1] = y;
  positions[2] = intersection.z;
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2;
    const offset = (i + 1) * 3;
    positions[offset] = intersection.x + Math.cos(angle) * intersection.radius;
    positions[offset + 1] = y;
    positions[offset + 2] = intersection.z + Math.sin(angle) * intersection.radius;
    uvs[(i + 1) * 2] = Math.cos(angle) * 0.5 + 0.5;
    uvs[(i + 1) * 2 + 1] = Math.sin(angle) * 0.5 + 0.5;
  }
  const indices = [];
  for (let i = 0; i < sides; i += 1) indices.push(0, ((i + 1) % sides) + 1, i + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('roadMark', new THREE.BufferAttribute(roadMark, 3));
  geometry.setAttribute('roadIntersection', new THREE.BufferAttribute(roadIntersection, 1));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createIntersectionPaint(intersection) {
  const geometries = [];
  const y = intersection.y + RIBBON_LIFT + 0.035;
  for (const arm of intersection.arms) {
    const lateralX = -arm.z;
    const lateralZ = arm.x;
    const usableWidth = Math.max(2, arm.width - 1.1);

    // Zebra crossing: four broad white bars across the complete approach.
    for (let stripe = 0; stripe < 4; stripe += 1) {
      const station = intersection.radius - 3.25 + stripe * 0.78;
      geometries.push(createPaintQuad({
        cx: intersection.x + arm.x * station,
        cz: intersection.z + arm.z * station,
        y,
        axisX: lateralX,
        axisZ: lateralZ,
        length: usableWidth,
        depth: 0.42,
      }));
    }

    // Stop bar on the outside of the crossing. This is intentionally a separate
    // decal from the procedural ribbon lines, so it remains crisp at any angle.
    const stopStation = intersection.radius - 4.05;
    geometries.push(createPaintQuad({
      cx: intersection.x + arm.x * stopStation,
      cz: intersection.z + arm.z * stopStation,
      y: y + 0.002,
      axisX: lateralX,
      axisZ: lateralZ,
      length: usableWidth,
      depth: 0.2,
    }));

    // Multi-way junctions also get two short broken guide marks leading traffic
    // off each center line and into the open intersection.
    if (intersection.wayCount >= 3) {
      for (const station of [intersection.radius - 5.2, intersection.radius - 6.5]) {
        geometries.push(createPaintQuad({
          cx: intersection.x + arm.x * station,
          cz: intersection.z + arm.z * station,
          y,
          axisX: lateralX,
          axisZ: lateralZ,
          length: 0.16,
          depth: 0.72,
        }));
      }
    }
  }
  return geometries;
}

function createPaintQuad({ cx, cz, y, axisX, axisZ, length, depth }) {
  // axis is lateral; its perpendicular is the approach travel direction.
  const travelX = axisZ;
  const travelZ = -axisX;
  const lx = axisX * length * 0.5;
  const lz = axisZ * length * 0.5;
  const dx = travelX * depth * 0.5;
  const dz = travelZ * depth * 0.5;
  const positions = new Float32Array([
    cx - lx - dx, y, cz - lz - dz,
    cx + lx - dx, y, cz + lz - dz,
    cx + lx + dx, y, cz + lz + dz,
    cx - lx + dx, y, cz - lz + dz,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();
  return geometry;
}

function segmentNeedsDeckCollider({ samples, roadY, i, sampleHeight, bridgeThresh }) {
  const a = samples[i];
  const c = samples[i + 1];
  const y0 = roadY[i] + RIBBON_LIFT;
  const y1 = roadY[i + 1] + RIBBON_LIFT;
  const mx = (a.x + c.x) * 0.5;
  const mz = (a.z + c.z) * 0.5;
  const roadTop = Math.max(y0, y1);
  const terrainMin = Math.min(
    sampleHeight(a.x, a.z),
    sampleHeight(c.x, c.z),
    sampleHeight(mx, mz),
  );
  return roadTop - terrainMin > bridgeThresh;
}

export function deckSurfaceHeightAt({ x, z, x0, z0, y0, x1, z1, y1 }) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 1e-8
    ? THREE.MathUtils.clamp(((x - x0) * dx + (z - z0) * dz) / lengthSq, 0, 1)
    : 0;
  return THREE.MathUtils.lerp(y0, y1, t);
}
