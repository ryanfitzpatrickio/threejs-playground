/**
 * createTracksideLayers.js
 *
 * Builds the GT3-style trackside layer stack — curbs, shoulders, and barrier walls
 * — for any road that opts in via `road.trackStyle` (see trackCrossSection.js).
 * Mirrors createRoadworks: it consumes the same road profile + per-sample frame
 * (trackFrame.js) and returns { group, colliders, dispose }. Colliders go into
 * level.colliders so PhysicsSystem builds the wall barriers (the vehicle, a dynamic
 * Rapier body, is contained by them).
 *
 * Every layer is laid as an OFFSET RIBBON of the centerline: for a band spanning
 * lateral offsets [uInner, uOuter] on one side, we emit a strip with one inner and
 * one outer vertex per sample, exactly like the road ribbon but shifted sideways.
 * Surface bands (curb/shoulder) lie roughly flat; wall bands are extruded vertical.
 *
 * Roads are static, so this is built once at level construction.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRallySpectatorGeometry } from './rallySpectatorGeometry.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { buildRibbonFrame, offsetPoint, placementsAlong } from '../../world/worldMap/trackFrame.js';
import { resolveCrossSection } from './trackCrossSection.js';
import { createRallySurfaceMaterial, loadRallySurfaceSet } from '../materials/rallySurfaceTextures.js';
import { disablePbrEnvironment } from '../materials/disablePbrEnvironment.js';
import { collectRallyCrowdPlacements } from './rallyCrowdPlacements.js';
import { getQualityPreset, getQualityLevel } from '../config/qualityPresets.js';

const SURFACE_LIFT = 0.08;   // align curbs/trackside ribbons with the lifted road skin
const WALL_BURY_DEPTH = 0.55; // minimum foundation below the authored road grade
const WALL_MAX_BURY_DEPTH = 1.5; // follow terrain dips without creating arbitrarily deep geometry
const WALL_TERRAIN_OVERLAP = 0.18;
// Lengthen each wall collider box slightly along the road so consecutive boxes on a
// curve overlap instead of leaving a hairline gap the vehicle could clip through.
const WALL_OVERLAP = 0.15;
// Keep every race-track layer clear of a junction, including enough approach room
// for crosswalk/stop-line decals. This gate applies to visible geometry, instances,
// and wall colliders alike.
const INTERSECTION_CLEARANCE = 2.5;

// One shared vertex-coloured material for every trackside surface (curb stripes +
// shoulder verge) so all surface bands merge into a single draw call. Walls reuse
// it too (vertical faces); they merge separately only to keep their shadow flags.
const tracksideMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.92,
  metalness: 0.0,
  side: THREE.DoubleSide,
});

const TRACK_TEXTURE_ROOT = '/assets/textures/urban-track/slices';

function loadTrackTexture(filename, { repeat = false } = {}) {
  // TextureLoader needs a DOM image implementation. Headless geometry tests still
  // build the exact same meshes/materials, just without the browser-loaded bitmap.
  if (typeof document === 'undefined') return null;
  const texture = new THREE.TextureLoader().load(
    filename.startsWith('/') ? filename : `${TRACK_TEXTURE_ROOT}/${filename}`,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

const wallMaterial = new THREE.MeshStandardMaterial({
  // Unlike the square atlas renders, this crop has no black studio backdrop, so
  // the concrete artwork covers the complete wall face.
  map: loadTrackTexture('barrier_concrete.png', { repeat: true }),
  color: 0xffffff,
  roughness: 0.88,
  metalness: 0.02,
  side: THREE.DoubleSide,
});
wallMaterial.userData.trackTexture = 'barrier_concrete.png';

const chevronCurbMaterial = new THREE.MeshStandardMaterial({
  map: loadTrackTexture('curb_chevron_red.png', { repeat: true }),
  color: 0xffffff,
  roughness: 0.8,
  metalness: 0.01,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
chevronCurbMaterial.userData.trackTexture = 'curb_chevron_red.png';

const grassShoulderMaterial = createRallySurfaceMaterial(loadRallySurfaceSet('grass'), {
  hextile: getQualityPreset(getQualityLevel()).terrainHextile ?? null,
});
grassShoulderMaterial.side = THREE.DoubleSide;
grassShoulderMaterial.userData.rallySurface = 'grass';

// Repeated cards (fence panels, sponsor boards) are unit XY planes (normal +Z),
// instanced along the arc. One shared geometry + material per kind keeps draws cheap.
const cardGeom = new THREE.PlaneGeometry(1, 1);
const fenceMaterial = new THREE.MeshStandardMaterial({
  map: loadTrackTexture('fence_chainlink.png'),
  color: 0xffffff, roughness: 0.85, metalness: 0.0,
  transparent: true, alphaTest: 0.08, side: THREE.DoubleSide, depthWrite: false,
});
fenceMaterial.userData.trackTexture = 'fence_chainlink.png';
const sponsorMaterials = [
  new THREE.MeshStandardMaterial({
    map: loadTrackTexture('billboard_apex.png'),
    color: 0xffffff, roughness: 0.7, metalness: 0.0,
    transparent: true, alphaTest: 0.04, side: THREE.DoubleSide,
  }),
  new THREE.MeshStandardMaterial({
    map: loadTrackTexture('billboard_nightshift.png'),
    color: 0xffffff, roughness: 0.7, metalness: 0.0,
    transparent: true, alphaTest: 0.04, side: THREE.DoubleSide,
  }),
];
sponsorMaterials[0].userData.trackTexture = 'billboard_apex.png';
sponsorMaterials[1].userData.trackTexture = 'billboard_nightshift.png';
const assetMaterialCache = new Map();

function getAssetMaterial(filename) {
  if (!assetMaterialCache.has(filename)) {
    const material = new THREE.MeshStandardMaterial({
      map: loadTrackTexture(filename),
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.0,
      transparent: true,
      alphaTest: 0.04,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    material.userData.trackTexture = filename;
    assetMaterialCache.set(filename, material);
    disablePbrEnvironment(material);
  }
  return assetMaterialCache.get(filename);
}
// Hero props (grandstands, streetlights, marker boards, gantries) are vertex-coloured
// procedural meshes; one shared material lets every prop instance batch.
const propMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.9, metalness: 0.0,
});
const standMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.86,
  metalness: 0.02,
  side: THREE.DoubleSide,
});

for (const mat of [
  tracksideMaterial,
  wallMaterial,
  chevronCurbMaterial,
  fenceMaterial,
  ...sponsorMaterials,
  propMaterial,
  standMaterial,
]) {
  disablePbrEnvironment(mat);
}

const _color = new THREE.Color();
// Scratch for the wall collider's oriented-box basis (avoids per-segment allocs).
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
// Scratch for instanced-card matrices.
const _cardRight = new THREE.Vector3();
const _cardUp = new THREE.Vector3();
const _cardFwd = new THREE.Vector3();
const _cardMat = new THREE.Matrix4();
const _cardScale = new THREE.Matrix4();
const _cardPos = new THREE.Vector3();

export function createTracksideLayers({ profile, sampleHeight, resolve = resolveCrossSection, crowdQuality = 'low' }) {
  const group = new THREE.Group();
  group.name = 'TracksideLayers';
  group.userData.noCollision = true;

  const colliders = [];
  const surfaceGeoms = [];
  const grassShoulderGeoms = [];
  const chevronCurbGeoms = [];
  const wallGeoms = [];
  const instanced = []; // InstancedMesh objects (fences + sponsor boards)
  const crowdPlacements = [];
  const useAnimatedCrowd = crowdQuality !== 'low';

  profile.roads.forEach((b, roadIndex) => {
    const section = resolve(b.road?.trackStyle);
    if (!section || !Array.isArray(section.bands) || section.bands.length === 0) return;

    const frame = buildRibbonFrame(b);
    const { n, half } = frame;
    if (n < 2) return;
    const allowedAtArc = buildIntersectionGate(profile.intersections, roadIndex, frame);

    // Running outward offset magnitude from the centerline, per side. Bands stack
    // outward in declaration order; each consumes gap + its own width/thickness.
    const uOut = { left: half, right: half };

    for (const band of section.bands) {
      const sides = band.side === 'left' ? ['left']
        : band.side === 'right' ? ['right']
          : ['left', 'right'];
      for (const side of sides) {
        const sign = side === 'left' ? 1 : -1;
        const uInner = uOut[side] + (band.gap ?? 0);

        if (band.kind === 'curb' || band.kind === 'shoulder') {
          const width = Math.max(0.01, band.width ?? 1);
          const uOuter = uInner + width;
          if (band.kind === 'shoulder' && band.texture === 'grass') {
            grassShoulderGeoms.push(buildTexturedShoulder({
              frame, band, sign, uInner, uOuter, sampleHeight, allowedAtArc,
            }));
          } else {
            surfaceGeoms.push(buildSurfaceBand({ frame, band, sign, uInner, uOuter, sampleHeight, allowedAtArc }));
          }
          uOut[side] = uOuter;
        } else if (band.kind === 'chevronCurb') {
          const width = Math.max(0.1, band.width ?? 1.1);
          const uOuter = uInner + width;
          chevronCurbGeoms.push(buildChevronCurb({ frame, band, sign, uInner, uOuter, allowedAtArc }));
          uOut[side] = uOuter;
        } else if (band.kind === 'wall') {
          const thickness = Math.max(0.05, band.thickness ?? 0.4);
          const uOuter = uInner + thickness;
          const built = buildWall({
            frame, band, sign, uInner, uOuter, side, roadIndex, sampleHeight, allowedAtArc,
          });
          wallGeoms.push(...built.geoms);
          colliders.push(...built.colliders);
          uOut[side] = uOuter;
        } else if (band.kind === 'fence') {
          const mesh = buildFence({ frame, band, sign, uLine: uInner, allowedAtArc });
          if (mesh) instanced.push(mesh);
          // A fence is a thin line feature; it consumes no lateral width.
          uOut[side] = uInner;
        } else if (band.kind === 'fenceFlags') {
          const meshes = buildFenceFlags({ frame, band, sign, uLine: uInner, allowedAtArc });
          instanced.push(...meshes);
          uOut[side] = uInner;
        } else if (band.kind === 'sponsor') {
          const mesh = buildSponsors({ frame, band, sign, uLine: uInner, allowedAtArc });
          if (mesh) instanced.push(mesh);
          uOut[side] = uInner;
        } else if (band.kind === 'asset') {
          const mesh = buildAssetCards({ frame, band, sign, uLine: uInner, allowedAtArc });
          if (mesh) instanced.push(mesh);
          uOut[side] = uInner;
        } else if (band.kind === 'rope') {
          const rope = buildRallyRope({ frame, band, sign, uLine: uInner, sampleHeight, allowedAtArc });
          if (rope) instanced.push(rope);
          uOut[side] = uInner;
        } else if (band.kind === 'crowd') {
          const placements = collectRallyCrowdPlacements({
            frame, band, sign, uLine: uInner, sampleHeight, allowedAtArc, roadIndex, side,
          });
          crowdPlacements.push(...placements);
          if (!useAnimatedCrowd) {
            const crowd = buildRallyCrowdMesh(placements);
            if (crowd) instanced.push(crowd);
          }
          uOut[side] = uInner + (band.depth ?? 3.5);
        } else if (band.kind === 'prop') {
          const mesh = buildPropRow({ frame, band, sign, uLine: uInner, sampleHeight, allowedAtArc });
          if (mesh) instanced.push(mesh);
          uOut[side] = uInner;
        } else if (band.kind === 'continuousStand') {
          const meshes = buildContinuousStand({
            frame, band, sign, uLine: uInner, sampleHeight, allowedAtArc,
          });
          instanced.push(...meshes);
          uOut[side] = uInner + (band.depth ?? 11);
        }
      }
    }

    // Gantries + tunnel bores span the road on the centerline — handled once per
    // road, not per side.
    for (const band of section.bands) {
      if (band.kind === 'gantry') {
        const mesh = buildGantryRow({ frame, band, half, allowedAtArc });
        if (mesh) instanced.push(mesh);
      } else if (band.kind === 'overheadAsset') {
        const mesh = buildOverheadAssetRow({ frame, band, half, allowedAtArc });
        if (mesh) instanced.push(mesh);
      } else if (band.kind === 'tunnelBore') {
        // No allowedAtArc: the bore must reach its own endpoint (the junction
        // with the connecting road) — see the rationale on buildTunnelBore.
        const built = buildTunnelBore({ frame, band, half, roadIndex });
        wallGeoms.push(...built.geoms);
        colliders.push(...built.colliders);
      } else if (band.kind === 'tunnelLight') {
        const mesh = buildTunnelLight({ frame, band, half });
        if (mesh) instanced.push(mesh);
      }
    }
  });

  for (const mesh of instanced) {
    if (mesh.isInstancedMesh) mesh.computeBoundingSphere();
    else mesh.geometry?.computeBoundingSphere();
    mesh.userData.lodDistance = mesh.name.includes('Grandstand')
      ? 520
      : mesh.name === 'Trackside Fence' ? 220 : 300;
    group.add(mesh);
  }

  if (surfaceGeoms.length) {
    const merged = mergeGeometries(surfaceGeoms, false);
    for (const g of surfaceGeoms) g.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, tracksideMaterial);
      mesh.name = 'Trackside Surfaces';
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      group.add(mesh);
    }
  }
  if (grassShoulderGeoms.length) {
    const merged = mergeGeometries(grassShoulderGeoms, false);
    for (const g of grassShoulderGeoms) g.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, grassShoulderMaterial);
      mesh.name = 'Trackside Grass Shoulders';
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      group.add(mesh);
    }
  }
  if (chevronCurbGeoms.length) {
    const merged = mergeGeometries(chevronCurbGeoms, false);
    for (const g of chevronCurbGeoms) g.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, chevronCurbMaterial);
      mesh.name = 'Trackside Red Chevron Curbs';
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      group.add(mesh);
    }
  }
  if (wallGeoms.length) {
    const merged = mergeGeometries(wallGeoms, false);
    for (const g of wallGeoms) g.dispose();
    if (merged) {
      const mesh = new THREE.Mesh(merged, wallMaterial);
      mesh.name = 'Trackside Walls';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  return {
    group,
    colliders,
    crowdPlacements,
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

function buildIntersectionGate(intersections = [], roadIndex, frame) {
  const exclusions = [];
  for (const intersection of intersections) {
    for (const connection of intersection.connections) {
      if (connection.roadIndex !== roadIndex) continue;
      const at = Math.max(0, Math.min(frame.n - 1, connection.at));
      const i = Math.min(frame.n - 2, Math.floor(at));
      const t = at - i;
      const centerArc = THREE.MathUtils.lerp(frame.arc[i], frame.arc[i + 1], t);
      exclusions.push({ centerArc, radius: intersection.radius + INTERSECTION_CLEARANCE });
    }
  }
  if (exclusions.length === 0) return () => true;
  return (arc) => exclusions.every((range) => Math.abs(arc - range.centerArc) > range.radius);
}

// A flat-ish offset ribbon: inner vertex at [sign*uInner], outer at [sign*uOuter],
// one pair per sample. curb sits at road height + lift on both edges (raised
// rumble); shoulder's inner edge is at road height and its outer edge drops to the
// natural terrain so it meets the surrounding land. Colour is baked per-vertex:
// curb alternates colorA/colorB by arc cell (stripes); shoulder is a solid colour.
function buildSurfaceBand({ frame, band, sign, uInner, uOuter, sampleHeight, allowedAtArc }) {
  const { n, roadY, arc } = frame;
  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 3);
  const isCurb = band.kind === 'curb';
  const lift = (band.lift ?? 0) + SURFACE_LIFT;

  for (let i = 0; i < n; i += 1) {
    const pin = offsetPoint(frame, i, sign * uInner);
    const pout = offsetPoint(frame, i, sign * uOuter);
    const yInner = roadY[i] + lift;
    // Curb: outer edge stays at road height (flat strip). Shoulder: outer edge
    // meets the natural terrain at that point so the verge feathers into the land.
    const yOuter = isCurb ? roadY[i] + lift : sampleHeight(pout.x, pout.z);

    if (isCurb) {
      const cell = Math.floor(arc[i] / Math.max(0.1, band.stripe ?? 1.5));
      _color.set((cell & 1) === 0 ? (band.colorA ?? 0xc23b22) : (band.colorB ?? 0xe9e2d6));
    } else {
      _color.set(band.color ?? 0x4f5d3b);
    }

    const o = i * 6;
    positions[o] = pin.x; positions[o + 1] = yInner; positions[o + 2] = pin.z;
    positions[o + 3] = pout.x; positions[o + 4] = yOuter; positions[o + 5] = pout.z;
    colors[o] = _color.r; colors[o + 1] = _color.g; colors[o + 2] = _color.b;
    colors[o + 3] = _color.r; colors[o + 4] = _color.g; colors[o + 5] = _color.b;
  }

  return makeStrip(positions, colors, n, null, (i) => allowedAtArc(arc[i]) && allowedAtArc(arc[i + 1]));
}

function buildTexturedShoulder({ frame, band, sign, uInner, uOuter, sampleHeight, allowedAtArc }) {
  const { n, roadY, arc } = frame;
  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const lift = (band.lift ?? 0) + SURFACE_LIFT;
  const tileAlong = Math.max(0.5, band.tileAlong ?? 3.5);

  for (let i = 0; i < n; i += 1) {
    const pin = offsetPoint(frame, i, sign * uInner);
    const pout = offsetPoint(frame, i, sign * uOuter);
    const yInner = roadY[i] + lift;
    const yOuter = sampleHeight(pout.x, pout.z);
    const o = i * 6;
    positions[o] = pin.x; positions[o + 1] = yInner; positions[o + 2] = pin.z;
    positions[o + 3] = pout.x; positions[o + 4] = yOuter; positions[o + 5] = pout.z;
    colors.fill(1, o, o + 6);
    const uv = i * 4;
    const along = arc[i] / tileAlong;
    uvs[uv] = along; uvs[uv + 1] = 0;
    uvs[uv + 2] = along; uvs[uv + 3] = 1;
  }

  return makeStrip(positions, colors, n, uvs, (i) => allowedAtArc(arc[i]) && allowedAtArc(arc[i + 1]));
}

function buildChevronCurb({ frame, band, sign, uInner, uOuter, allowedAtArc }) {
  const { n, roadY, arc } = frame;
  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 3);
  const uvs = new Float32Array(n * 2 * 2);
  const lift = (band.lift ?? 0.075) + SURFACE_LIFT;
  const tileLength = Math.max(0.5, band.tileLength ?? 2.8);

  for (let i = 0; i < n; i += 1) {
    const inner = offsetPoint(frame, i, sign * uInner);
    const outer = offsetPoint(frame, i, sign * uOuter);
    const o = i * 6;
    positions[o] = inner.x; positions[o + 1] = roadY[i] + lift; positions[o + 2] = inner.z;
    positions[o + 3] = outer.x; positions[o + 4] = roadY[i] + lift; positions[o + 5] = outer.z;
    colors.fill(1, o, o + 6);
    const uv = i * 4;
    // Reverse one side so the arrows point consistently with road travel.
    const along = arc[i] / tileLength * sign;
    uvs[uv] = along; uvs[uv + 1] = 0;
    uvs[uv + 2] = along; uvs[uv + 3] = 1;
  }

  return makeStrip(
    positions,
    colors,
    n,
    uvs,
    (i) => allowedAtArc(arc[i]) && allowedAtArc(arc[i + 1]),
  );
}

// A barrier wall: extruded vertical strips (inner face, outer face, top cap) along
// the offset line, base on the road surface, plus one pitched-vertical oriented-box
// collider per segment so the vehicle is physically contained. Returns
// { geoms:[BufferGeometry], colliders:[descriptor] }.
function buildWall({ frame, band, sign, uInner, uOuter, side, roadIndex, sampleHeight, allowedAtArc }) {
  const { n, roadY, arc } = frame;
  const height = Math.max(0.1, band.height ?? 1);
  const lift = SURFACE_LIFT;

  // Wall tops retain the authored height while the base extends below grade.
  const innerPt = new Array(n);
  const outerPt = new Array(n);
  const baseY = new Float64Array(n);
  const topY = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    innerPt[i] = offsetPoint(frame, i, sign * uInner);
    outerPt[i] = offsetPoint(frame, i, sign * uOuter);
    const gradeY = roadY[i] + lift;
    const terrainY = Math.min(
      sampleHeight(innerPt[i].x, innerPt[i].z),
      sampleHeight(outerPt[i].x, outerPt[i].z),
    ) - WALL_TERRAIN_OVERLAP;
    baseY[i] = Math.max(
      gradeY - WALL_MAX_BURY_DEPTH,
      Math.min(gradeY - WALL_BURY_DEPTH, terrainY),
    );
    topY[i] = gradeY + height;
  }

  const colorVal = band.color ?? 0x9b959a;
  _color.set(colorVal);
  const cr = _color.r, cg = _color.g, cb = _color.b;

  // Three vertical strips: inner face, outer face, top cap. Each is a 2-vert-per-
  // sample strip; makeStrip stitches the quads. Faces are double-sided (material).
  const wallUv = (i, top) => [arc[i] / 2.4, top ? 1 : 1 - ((topY[i] - baseY[i]) / height)];
  const innerFace = vstrip(n, (i, top) => {
    const p = innerPt[i];
    return [p.x, top ? topY[i] : baseY[i], p.z];
  }, cr, cg, cb, wallUv, (i) => allowedAtArc(arc[i]) && allowedAtArc(arc[i + 1]));
  const outerFace = vstrip(n, (i, top) => {
    const p = outerPt[i];
    return [p.x, top ? topY[i] : baseY[i], p.z];
  }, cr, cg, cb, wallUv, (i) => allowedAtArc(arc[i]) && allowedAtArc(arc[i + 1]));
  const topCap = vstrip(n, (i, outer) => {
    const p = outer ? outerPt[i] : innerPt[i];
    return [p.x, topY[i], p.z];
  }, cr, cg, cb, (i, outer) => [arc[i] / 2.4, outer ? 1 : 0], (i) => allowedAtArc(arc[i]) && allowedAtArc(arc[i + 1]));

  // Per-segment oriented box on the wall centreline. Long axis (z) follows the
  // horizontal segment tangent, y is world-up (vertical wall), x is the road
  // perpendicular (thickness). center sits at mid-height.
  const colliders = [];
  const uMid = (uInner + uOuter) * 0.5;
  const thickness = uOuter - uInner;
  for (let i = 0; i < n - 1; i += 1) {
    if (!allowedAtArc(arc[i]) || !allowedAtArc(arc[i + 1])) continue;
    const m0 = offsetPoint(frame, i, sign * uMid);
    const m1 = offsetPoint(frame, i + 1, sign * uMid);
    const dx = m1.x - m0.x, dz = m1.z - m0.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-4) continue;

    _fwd.set(dx / segLen, 0, dz / segLen);
    _right.crossVectors(_up, _fwd).normalize(); // up × fwd → horizontal perpendicular
    _basis.makeBasis(_right, _up, _fwd);
    _quat.setFromRotationMatrix(_basis);

    const base = Math.min(baseY[i], baseY[i + 1]);
    const top = Math.max(topY[i], topY[i + 1]);
    const cx = (m0.x + m1.x) * 0.5;
    const cz = (m0.z + m1.z) * 0.5;
    const cy = (base + top) * 0.5;

    // AABB over the four base corners (inner/outer × i/i+1) for broad-phase +
    // analytic blocking queries.
    const xs = [innerPt[i].x, outerPt[i].x, innerPt[i + 1].x, outerPt[i + 1].x];
    const zs = [innerPt[i].z, outerPt[i].z, innerPt[i + 1].z, outerPt[i + 1].z];

    colliders.push({
      name: `Track Wall ${roadIndex}-${i}-${side}`,
      minX: Math.min(...xs) - WALL_OVERLAP,
      maxX: Math.max(...xs) + WALL_OVERLAP,
      minZ: Math.min(...zs) - WALL_OVERLAP,
      maxZ: Math.max(...zs) + WALL_OVERLAP,
      topY: top,
      bottomY: base,
      // Oriented box for the Rapier physics build (the vehicle bounces off this).
      center: { x: cx, y: cy, z: cz },
      halfExtents: { x: thickness * 0.5, y: (top - base) * 0.5, z: segLen * 0.5 + WALL_OVERLAP },
      orientation: { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w },
      width: thickness,
      depth: segLen,
      // A thin wall must never become standing ground (it would teleport the
      // character onto a 0.4 m ledge); it only blocks.
      noGroundSnap: true,
      vaultable: false,
    });
  }

  return { geoms: [innerFace, outerFace, topCap], colliders };
}

const TUNNEL_ARC_SEGMENTS = 6;

// The tunnel's structural shell: an interior cross-section ring (left wall base →
// left springline → arched ceiling → right springline → right wall base) extruded
// along the road, one ring per sample, stitched into a continuous tube — plus one
// left-wall + right-wall + ceiling oriented-box collider per segment (same pattern
// as buildWall, tripled) so the vehicle is contained on every side of the bore.
//
// Deliberately IGNORES the intersection gate other bands use: a tunnel connects to
// another road exactly AT its own endpoint (that's where the entrance sits), so
// gating geometry out near that junction — appropriate for decorative signs/fences,
// which would visually clash with a crosswalk — would delete the bore shell and
// portal frame exactly where the entrance needs to be.
function buildTunnelBore({ frame, band, half, roadIndex }) {
  const { n, roadY } = frame;
  const wallHeight = Math.max(0.1, band.wallHeight ?? 3.4);
  const archRise = Math.max(0.05, band.archRise ?? 1.8);
  const thickness = Math.max(0.05, band.thickness ?? 0.5);
  const segments = Math.max(2, Math.round(band.archSegments ?? TUNNEL_ARC_SEGMENTS));
  const ringSize = segments + 3; // leftBase + arc (segments+1 points) + rightBase

  _color.set(band.color ?? 0x5a5850);
  const cr = _color.r, cg = _color.g, cb = _color.b;

  // Lateral offset (u) and height-above-roadY for each ring point, shared by every
  // sample. u sweeps +half (left) → -half (right) via cos(angle); height rises
  // wallHeight..wallHeight+archRise via sin(angle), so index 0 (angle=0) and index
  // `segments` (angle=PI) land exactly on the two springlines.
  const ringU = new Float64Array(ringSize);
  const ringDY = new Float64Array(ringSize);
  ringU[0] = half; ringDY[0] = 0;
  for (let k = 0; k <= segments; k += 1) {
    const angle = Math.PI * (k / segments);
    ringU[k + 1] = half * Math.cos(angle);
    ringDY[k + 1] = wallHeight + archRise * Math.sin(angle);
  }
  ringU[ringSize - 1] = -half; ringDY[ringSize - 1] = 0;

  const rings = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const ring = new Array(ringSize);
    for (let j = 0; j < ringSize; j += 1) {
      const p = offsetPoint(frame, i, ringU[j]);
      ring[j] = { x: p.x, y: roadY[i] + ringDY[j], z: p.z };
    }
    rings[i] = ring;
  }

  // Stitch adjacent rings into quads (same winding as makeStrip: a,c,b / b,c,d).
  const positions = [];
  const colors = [];
  const indices = [];
  for (let i = 0; i < n - 1; i += 1) {
    const ringA = rings[i], ringB = rings[i + 1];
    for (let j = 0; j < ringSize - 1; j += 1) {
      const a = ringA[j], b = ringA[j + 1], c = ringB[j], d = ringB[j + 1];
      const base = positions.length / 3;
      for (const p of [a, b, c, d]) positions.push(p.x, p.y, p.z);
      for (let k = 0; k < 4; k += 1) colors.push(cr, cg, cb);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }

  // Portal frame: a flat "headwall" annulus at each end of the bore, connecting an
  // enlarged outer rim to the inner bore profile. The terrain-carve taper
  // (roadProfile's portal zone) opens the ground up, but by itself that reads as
  // a vague grassy notch — this gives the entrance an unmistakable, always-visible
  // silhouette (like a concrete headwall) regardless of how much the terrain
  // actually needed carving at that spot.
  const FRAME_MARGIN = 0.9;
  _color.set(band.frameColor ?? 0x4a4844);
  const fr = _color.r, fg = _color.g, fb = _color.b;
  const outerHalf = half + FRAME_MARGIN;
  const outerArchRise = archRise + FRAME_MARGIN;
  const outerU = new Float64Array(ringSize);
  const outerDY = new Float64Array(ringSize);
  outerU[0] = outerHalf; outerDY[0] = 0;
  for (let k = 0; k <= segments; k += 1) {
    const angle = Math.PI * (k / segments);
    outerU[k + 1] = outerHalf * Math.cos(angle);
    outerDY[k + 1] = wallHeight + outerArchRise * Math.sin(angle);
  }
  outerU[ringSize - 1] = -outerHalf; outerDY[ringSize - 1] = 0;

  const buildPortalFrame = (i) => {
    const inner = rings[i];
    for (let j = 0; j < ringSize - 1; j += 1) {
      const oa = offsetPoint(frame, i, outerU[j]);
      const ob = offsetPoint(frame, i, outerU[j + 1]);
      const a = { x: oa.x, y: roadY[i] + outerDY[j], z: oa.z };
      const b = { x: ob.x, y: roadY[i] + outerDY[j + 1], z: ob.z };
      const c = inner[j], d = inner[j + 1];
      const base = positions.length / 3;
      for (const p of [a, b, c, d]) positions.push(p.x, p.y, p.z);
      for (let k = 0; k < 4; k += 1) colors.push(fr, fg, fb);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  };
  buildPortalFrame(0);
  if (n > 1) buildPortalFrame(n - 1);

  const geoms = [];
  if (indices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geoms.push(geometry);
  }

  // Colliders: left wall, right wall (vertical, same shape as buildWall), plus one
  // flat ceiling box spanning the full width from the springline up past the arch
  // apex (so the visual curve can never poke through a collider that hugged it
  // exactly — a flat box comfortably enclosing the arch is far simpler and just as
  // effective at stopping the vehicle).
  const colliders = [];
  for (let i = 0; i < n - 1; i += 1) {
    const m0 = offsetPoint(frame, i, 0);
    const m1 = offsetPoint(frame, i + 1, 0);
    const dx = m1.x - m0.x, dz = m1.z - m0.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-4) continue;

    _fwd.set(dx / segLen, 0, dz / segLen);
    _right.crossVectors(_up, _fwd).normalize();
    _basis.makeBasis(_right, _up, _fwd);
    _quat.setFromRotationMatrix(_basis);

    const baseY = Math.min(roadY[i], roadY[i + 1]);
    const springY = baseY + wallHeight;
    const apexY = baseY + wallHeight + archRise;

    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? 1 : -1;
      const uMid = sign * (half + thickness * 0.5);
      const p0 = offsetPoint(frame, i, uMid);
      const p1 = offsetPoint(frame, i + 1, uMid);
      colliders.push({
        name: `Tunnel Wall ${roadIndex}-${i}-${side}`,
        minX: Math.min(p0.x, p1.x) - thickness,
        maxX: Math.max(p0.x, p1.x) + thickness,
        minZ: Math.min(p0.z, p1.z) - thickness,
        maxZ: Math.max(p0.z, p1.z) + thickness,
        topY: springY,
        bottomY: baseY,
        center: { x: (p0.x + p1.x) * 0.5, y: (baseY + springY) * 0.5, z: (p0.z + p1.z) * 0.5 },
        halfExtents: { x: thickness * 0.5, y: (springY - baseY) * 0.5, z: segLen * 0.5 + WALL_OVERLAP },
        orientation: { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w },
        width: thickness,
        depth: segLen,
        // Same rationale as buildWall: a thin shell must never become standing
        // ground, it only blocks.
        noGroundSnap: true,
        vaultable: false,
      });
    }

    const ceilingTop = apexY + thickness;
    colliders.push({
      name: `Tunnel Ceiling ${roadIndex}-${i}`,
      minX: Math.min(m0.x, m1.x) - half - thickness,
      maxX: Math.max(m0.x, m1.x) + half + thickness,
      minZ: Math.min(m0.z, m1.z) - half - thickness,
      maxZ: Math.max(m0.z, m1.z) + half + thickness,
      topY: ceilingTop,
      bottomY: springY,
      center: { x: (m0.x + m1.x) * 0.5, y: (springY + ceilingTop) * 0.5, z: (m0.z + m1.z) * 0.5 },
      halfExtents: { x: half + thickness, y: (ceilingTop - springY) * 0.5, z: segLen * 0.5 + WALL_OVERLAP },
      orientation: { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w },
      width: (half + thickness) * 2,
      depth: segLen,
      noGroundSnap: true,
      vaultable: false,
    });
  }

  return { geoms, colliders };
}

// Ceiling-mounted light fixtures, instanced at arc intervals along a tunnelBore.
// No allowedAtArc: matches buildTunnelBore — lights run the bore's full length,
// including right up to the junction at either end.
function buildTunnelLight({ frame, band, half }) {
  const every = Math.max(4, band.every ?? 18);
  const mountY = band.mountY ?? 4.8;
  const anchors = placementsAlong(frame, every, { phase: every * 0.5, lateral: 0 });
  if (anchors.length === 0) return null;

  const geom = buildTunnelLightFixture(band.color ?? 0xfff2c8);
  const mesh = new THREE.InstancedMesh(geom, propMaterial, anchors.length);
  mesh.name = 'Trackside Tunnel Light';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  for (let k = 0; k < anchors.length; k += 1) {
    const a = anchors[k];
    setPropMatrix(a.tx, a.tz, a.x, a.roadY + mountY, a.z, 1);
    mesh.setMatrixAt(k, _cardMat);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildTunnelLightFixture(color) {
  return mergeColored([
    coloredBox(0.5, 0.1, 0.5, 0, 0, 0, 0x2c2c2c),      // housing
    coloredBox(0.34, 0.05, 0.34, 0, -0.06, 0, color),  // glowing lens
  ]);
}

// Chain-link fence: instanced vertical cards standing along the offset line, each
// panel facing across the road (double-sided). No collider — it sits behind the wall.
function buildFence({ frame, band, sign, uLine, allowedAtArc }) {
  const height = Math.max(0.1, band.height ?? 2);
  const panel = Math.max(0.5, band.panel ?? 4);
  const anchors = placementsAlong(frame, panel, { phase: panel * 0.5, lateral: sign * uLine }).filter((a) => allowedAtArc(a.s));
  if (anchors.length === 0) return null;

  const geometry = buildSafetyFencePanel({
    width: panel,
    height,
    curvedTop: band.curvedTop ?? 1.15,
    curveReach: band.curveReach ?? 1.25,
    curveSegments: band.curveSegments ?? 4,
  });
  const mesh = new THREE.InstancedMesh(geometry, fenceMaterial, anchors.length);
  mesh.name = 'Trackside Fence';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  for (let k = 0; k < anchors.length; k += 1) {
    const a = anchors[k];
    // Local +Z points inward, so the curved crown leans over the racing surface.
    setPropMatrix(-sign * a.nx, -sign * a.nz, a.x, a.roadY + SURFACE_LIFT, a.z, 1);
    mesh.setMatrixAt(k, _cardMat);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function buildSafetyFencePanel({ width, height, curvedTop, curveReach, curveSegments }) {
  const crownHeight = Math.min(height * 0.45, Math.max(0, curvedTop));
  const verticalHeight = height - crownHeight;
  const segments = Math.max(1, Math.round(curveSegments));
  const rings = segments + 2;
  const positions = new Float32Array(rings * 2 * 3);
  const uvs = new Float32Array(rings * 2 * 2);
  const indices = [];

  for (let ring = 0; ring < rings; ring += 1) {
    let y;
    let z;
    let v;
    if (ring === 0) {
      y = 0; z = 0; v = 0;
    } else if (ring === 1) {
      y = verticalHeight; z = 0; v = verticalHeight / (height + curveReach);
    } else {
      const t = (ring - 1) / segments;
      const angle = t * Math.PI * 0.5;
      y = verticalHeight + Math.sin(angle) * crownHeight;
      z = (1 - Math.cos(angle)) * curveReach;
      v = (verticalHeight + t * (crownHeight + curveReach)) / (height + curveReach);
    }
    const p = ring * 6;
    positions[p] = -width * 0.5; positions[p + 1] = y; positions[p + 2] = z;
    positions[p + 3] = width * 0.5; positions[p + 4] = y; positions[p + 5] = z;
    const uv = ring * 4;
    uvs[uv] = 0; uvs[uv + 1] = v;
    uvs[uv + 2] = 1; uvs[uv + 3] = v;
  }
  for (let ring = 0; ring < rings - 1; ring += 1) {
    const a = ring * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Fence-mounted motorsport flags: real slim poles plus tall textured banners,
// spaced far enough apart to read as track dressing rather than a solid wall.
function buildFenceFlags({ frame, band, sign, uLine, allowedAtArc }) {
  const every = Math.max(24, band.every ?? 48);
  const poleHeight = Math.max(2.5, band.poleHeight ?? 5.2);
  const flagWidth = Math.max(0.5, band.flagWidth ?? 0.9);
  const flagHeight = Math.max(1.5, band.flagHeight ?? 3.1);
  const anchors = placementsAlong(frame, every, {
    phase: band.phase ?? every * 0.5,
    lateral: sign * (uLine + (band.offset ?? 0.18)),
  }).filter((anchor) => allowedAtArc(anchor.s));
  if (!anchors.length) return [];

  const poleGeometry = coloredBox(0.10, poleHeight, 0.10, 0, poleHeight * 0.5, 0, 0x454a50);
  const poles = new THREE.InstancedMesh(poleGeometry, propMaterial, anchors.length);
  poles.name = 'Trackside Fence Flag Poles';
  poles.castShadow = true;
  poles.receiveShadow = true;
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    setPropMatrix(-sign * anchor.nx, -sign * anchor.nz, anchor.x, anchor.roadY - 0.08, anchor.z, 1);
    poles.setMatrixAt(index, _cardMat);
  }
  poles.instanceMatrix.needsUpdate = true;

  const textures = band.textures ?? ['flag_motul.png', 'flag_falken.png', 'flag_dunlop.png'];
  const meshes = [poles];
  textures.forEach((texture, textureIndex) => {
    const selected = anchors.filter((_, index) => index % textures.length === textureIndex);
    if (!selected.length) return;
    const flags = new THREE.InstancedMesh(cardGeom, getAssetMaterial(texture), selected.length);
    flags.name = `Trackside Fence Flag ${texture}`;
    flags.castShadow = false;
    flags.receiveShadow = false;
    for (let index = 0; index < selected.length; index += 1) {
      const anchor = selected[index];
      setCardMatrix(
        -sign * anchor.nx, -sign * anchor.nz,
        anchor.x, anchor.roadY + poleHeight - flagHeight * 0.5 - 0.2, anchor.z,
        flagWidth, flagHeight,
      );
      flags.setMatrixAt(index, _cardMat);
    }
    flags.instanceMatrix.needsUpdate = true;
    meshes.push(flags);
  });
  return meshes;
}

// Sponsor hoardings: instanced textured boards at arc intervals, mounted above the
// wall and facing IN toward the track. Each side uses a different sponsor texture.
function buildSponsors({ frame, band, sign, uLine, allowedAtArc }) {
  const height = Math.max(0.1, band.height ?? 1.2);
  const boardWidth = Math.max(0.5, band.boardWidth ?? 5);
  const every = Math.max(boardWidth, band.every ?? 8);
  const mountY = band.mountY ?? 0.8;
  const anchors = placementsAlong(frame, every, { phase: every * 0.5, lateral: sign * uLine }).filter((a) => allowedAtArc(a.s));
  if (anchors.length === 0) return null;

  const material = sponsorMaterials[sign > 0 ? 0 : 1];
  const mesh = new THREE.InstancedMesh(cardGeom, material, anchors.length);
  mesh.name = 'Trackside Sponsors';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  for (let k = 0; k < anchors.length; k += 1) {
    const a = anchors[k];
    // Inward normal (toward the centerline) = -sign * road-perpendicular.
    setCardMatrix(-sign * a.nx, -sign * a.nz, a.x, a.roadY + mountY + height * 0.5, a.z, boardWidth, height);
    mesh.setMatrixAt(k, _cardMat);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// General atlas-backed roadside prop. These remain cheap instanced cards, but cover
// the small signs and silhouette props for which full procedural geometry adds no
// useful detail at racing speed.
function buildAssetCards({ frame, band, sign, uLine, allowedAtArc }) {
  if (!band.texture) return null;
  const width = Math.max(0.1, band.width ?? 1);
  const height = Math.max(0.1, band.height ?? 1);
  const every = Math.max(width, band.every ?? 30);
  const phase = THREE.MathUtils.clamp(band.phase ?? every * 0.5, 0, every);
  const mountY = band.mountY ?? 0;
  const anchors = placementsAlong(frame, every, {
    phase,
    lateral: sign * (uLine + (band.offset ?? 0)),
  }).filter((a) => allowedAtArc(a.s));
  if (anchors.length === 0) return null;

  const mesh = new THREE.InstancedMesh(cardGeom, getAssetMaterial(band.texture), anchors.length);
  mesh.name = `Trackside Asset ${band.asset ?? band.texture}`;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  for (let k = 0; k < anchors.length; k += 1) {
    const a = anchors[k];
    setCardMatrix(
      -sign * a.nx, -sign * a.nz,
      a.x, a.roadY + SURFACE_LIFT + mountY + height * 0.5, a.z,
      width, height,
    );
    mesh.setMatrixAt(k, _cardMat);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// Rally safety tape: procedural timber stakes plus a red/white sagging ribbon.
// It is deliberately visual-only; leaving the stage remains possible.
function buildRallyRope({ frame, band, sign, uLine, sampleHeight, allowedAtArc }) {
  const every = Math.max(2.5, band.every ?? 4);
  const height = Math.max(0.5, band.height ?? 1);
  const anchors = placementsAlong(frame, every, {
    phase: every * 0.5,
    lateral: sign * uLine,
  }).filter((a) => allowedAtArc(a.s));
  if (anchors.length < 2) return null;

  const root = new THREE.Group();
  root.name = 'Rally Safety Rope';
  const stakeGeometry = coloredBox(0.09, height, 0.09, 0, height * 0.5, 0, 0x725037);
  const stakes = new THREE.InstancedMesh(stakeGeometry, propMaterial, anchors.length);
  stakes.name = 'Rally Rope Stakes';
  stakes.castShadow = true;
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i];
    const groundY = sampleHeight(a.x, a.z);
    _cardMat.makeTranslation(a.x, groundY, a.z);
    stakes.setMatrixAt(i, _cardMat);
    a.groundY = groundY;
  }
  stakes.instanceMatrix.needsUpdate = true;
  stakes.computeBoundingSphere();
  stakes.userData.lodDistance = 240;
  root.add(stakes);

  const positions = [];
  const colors = [];
  const indices = [];
  const tapeHalfHeight = 0.045;
  const subdivisions = 4;
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (b.s - a.s > every * 1.5) continue;
    const base = positions.length / 3;
    for (let stepIndex = 0; stepIndex <= subdivisions; stepIndex += 1) {
      const t = stepIndex / subdivisions;
      const x = THREE.MathUtils.lerp(a.x, b.x, t);
      const z = THREE.MathUtils.lerp(a.z, b.z, t);
      const top = THREE.MathUtils.lerp(a.groundY, b.groundY, t) + height - Math.sin(Math.PI * t) * 0.16;
      positions.push(x, top + tapeHalfHeight, z, x, top - tapeHalfHeight, z);
      const red = ((i + stepIndex) & 1) === 0;
      _color.set(red ? 0xd72d27 : 0xf3ead7);
      for (let v = 0; v < 2; v += 1) colors.push(_color.r, _color.g, _color.b);
    }
    for (let stepIndex = 0; stepIndex < subdivisions; stepIndex += 1) {
      const v = base + stepIndex * 2;
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  }
  if (indices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const tape = new THREE.Mesh(geometry, tracksideMaterial);
    tape.name = 'Rally Red White Safety Tape';
    tape.castShadow = false;
    tape.userData.lodDistance = 240;
    root.add(tape);
  }
  return root;
}

// Authored low-poly spectators. Density increases on the outside of bends while
// remaining capped per road/side, keeping the stage cheap and deterministic.
function buildRallyCrowdMesh(placements) {
  if (!placements?.length) return null;

  const geometry = buildRallySpectatorGeometry();
  const mesh = new THREE.InstancedMesh(geometry, propMaterial, placements.length);
  mesh.name = 'Rally Spectator Crowd';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  for (let i = 0; i < placements.length; i += 1) {
    const a = placements[i];
    setPropMatrix(-a.sign * a.nx, -a.sign * a.nz, a.x, a.y, a.z, a.scale);
    mesh.setMatrixAt(i, _cardMat);
    mesh.setColorAt(i, _color.setHex(a.color));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function buildRallySpectatorGeometry() {
  return createRallySpectatorGeometry();
}

// Build a vertical card transform into _cardMat: a (width × height) plane centered at
// (px,py,pz), facing horizontal direction (fx,fz), standing upright. The unit plane's
// +Z is its normal, +X its width, +Y its height.
function setCardMatrix(fx, fz, px, py, pz, width, height) {
  _cardFwd.set(fx, 0, fz);
  if (_cardFwd.lengthSq() < 1e-8) _cardFwd.set(0, 0, 1);
  _cardFwd.normalize();
  _cardRight.crossVectors(_up, _cardFwd).normalize(); // horizontal width axis
  _cardUp.crossVectors(_cardFwd, _cardRight).normalize(); // ≈ world up
  _cardMat.makeBasis(_cardRight, _cardUp, _cardFwd);
  _cardScale.makeScale(width, height, 1);
  _cardMat.multiply(_cardScale);
  _cardPos.set(px, py, pz);
  _cardMat.setPosition(_cardPos);
}

// A row of identical hero props placed at arc intervals along the offset line,
// facing IN toward the track, base resting on the terrain. One InstancedMesh per row.
function buildPropRow({ frame, band, sign, uLine, sampleHeight, allowedAtArc }) {
  const geom = buildPropGeometry(band.prop, band);
  if (!geom) return null;
  const every = Math.max(2, band.every ?? 24);
  const scale = band.scale ?? 1;
  const anchors = placementsAlong(frame, every, { phase: every * 0.5, lateral: sign * uLine }).filter((a) => allowedAtArc(a.s));
  if (anchors.length === 0) { geom.dispose(); return null; }

  const mesh = new THREE.InstancedMesh(geom, propMaterial, anchors.length);
  mesh.name = `Trackside Prop ${band.prop}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  for (let k = 0; k < anchors.length; k += 1) {
    const a = anchors[k];
    const groundY = sampleHeight(a.x, a.z);
    // Inward facing (toward centerline) = -sign * road-perpendicular.
    setPropMatrix(-sign * a.nx, -sign * a.nz, a.x, groundY, a.z, scale);
    mesh.setMatrixAt(k, _cardMat);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// Continuous grandstand assembled from the same road samples as the track. Every
// adjacent allowed pair contributes a connected module; intersection-gated pairs
// are omitted and capped, producing deliberate clean breaks instead of overlaps.
function buildContinuousStand({ frame, band, sign, uLine, sampleHeight, allowedAtArc }) {
  const depth = Math.max(5, band.depth ?? 11);
  const frontHeight = band.frontHeight ?? 0.8;
  const backHeight = Math.max(frontHeight + 2, band.backHeight ?? 5.2);
  const roofHeight = Math.max(backHeight + 0.8, band.roofHeight ?? 6.4);
  const positions = [];
  const colors = [];
  const indices = [];

  const point = (i, distance, y) => ({
    x: frame.posX[i] + frame.norX[i] * sign * distance,
    y,
    z: frame.posZ[i] + frame.norZ[i] * sign * distance,
  });
  const addQuad = (a, b, c, d, color) => {
    const base = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(p.x, p.y, p.z);
    _color.set(color);
    for (let i = 0; i < 4; i += 1) colors.push(_color.r, _color.g, _color.b);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const segmentAllowed = (i) => allowedAtArc(frame.arc[i]) && allowedAtArc(frame.arc[i + 1]);
  for (let i = 0; i < frame.n - 1; i += 1) {
    if (!segmentAllowed(i)) continue;
    const j = i + 1;
    const yFront0 = frame.roadY[i] + frontHeight;
    const yFront1 = frame.roadY[j] + frontHeight;
    const yBack0 = frame.roadY[i] + backHeight;
    const yBack1 = frame.roadY[j] + backHeight;
    const front0 = point(i, uLine, 0);
    const front1 = point(j, uLine, 0);
    const baseFront0 = sampleHeight(front0.x, front0.z);
    const baseFront1 = sampleHeight(front1.x, front1.z);

    // Main raked seating deck and front/back enclosure.
    addQuad(point(i, uLine, yFront0), point(j, uLine, yFront1), point(j, uLine + depth, yBack1), point(i, uLine + depth, yBack0), 0x686b71);
    addQuad(point(i, uLine, baseFront0), point(j, uLine, baseFront1), point(j, uLine, yFront1), point(i, uLine, yFront0), 0x30343a);
    addQuad(point(i, uLine + depth, frame.roadY[i]), point(i, uLine + depth, yBack0 + 0.8), point(j, uLine + depth, yBack1 + 0.8), point(j, uLine + depth, frame.roadY[j]), 0x44484f);

    // Six raised seat/tier bands create readable horizontal detail without gaps.
    for (let tier = 0; tier < 6; tier += 1) {
      const t0 = tier / 6;
      const t1 = (tier + 0.72) / 6;
      const d0 = uLine + depth * t0;
      const d1 = uLine + depth * t1;
      const h00 = THREE.MathUtils.lerp(yFront0, yBack0, t0) + 0.055;
      const h01 = THREE.MathUtils.lerp(yFront0, yBack0, t1) + 0.055;
      const h10 = THREE.MathUtils.lerp(yFront1, yBack1, t0) + 0.055;
      const h11 = THREE.MathUtils.lerp(yFront1, yBack1, t1) + 0.055;
      addQuad(point(i, d0, h00), point(j, d0, h10), point(j, d1, h11), point(i, d1, h01), tier % 2 ? 0x8b3430 : 0xb7babf);
    }

    // Canopy follows the curve as another stitched ribbon.
    addQuad(
      point(i, uLine + depth * 0.32, frame.roadY[i] + roofHeight),
      point(j, uLine + depth * 0.32, frame.roadY[j] + roofHeight),
      point(j, uLine + depth + 0.8, frame.roadY[j] + roofHeight - 0.2),
      point(i, uLine + depth + 0.8, frame.roadY[i] + roofHeight - 0.2),
      0x34383f,
    );

    // Cap each continuous run at its two ends.
    if (i === 0 || !segmentAllowed(i - 1)) {
      addQuad(point(i, uLine, frame.roadY[i]), point(i, uLine, yFront0), point(i, uLine + depth, yBack0), point(i, uLine + depth, frame.roadY[i]), 0x50545b);
    }
    if (j === frame.n - 1 || !segmentAllowed(j)) {
      addQuad(point(j, uLine + depth, frame.roadY[j]), point(j, uLine + depth, yBack1), point(j, uLine, yFront1), point(j, uLine, frame.roadY[j]), 0x50545b);
    }
  }

  const meshes = [];
  if (indices.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const structure = new THREE.Mesh(geometry, standMaterial);
    structure.name = 'Trackside Continuous Grandstand';
    structure.castShadow = true;
    structure.receiveShadow = true;
    meshes.push(structure);
  }

  meshes.push(...buildStandDetails({ frame, sign, uLine, depth, roofHeight, allowedAtArc }));
  return meshes;
}

function buildStandDetails({ frame, sign, uLine, depth, roofHeight, allowedAtArc }) {
  const meshes = [];
  const supportAnchors = placementsAlong(frame, 10, { phase: 5, lateral: sign * uLine })
    .filter((a) => allowedAtArc(a.s));
  if (supportAnchors.length) {
    const supportGeom = mergeColored([
      coloredBox(0.18, roofHeight, 0.18, 0, roofHeight * 0.5, 0, 0x292d33),
      coloredBox(0.18, roofHeight - 0.5, 0.18, 0, (roofHeight - 0.5) * 0.5, -depth, 0x292d33),
      coloredBox(0.14, 0.14, depth, 0, roofHeight - 0.3, -depth * 0.5, 0x292d33),
    ]);
    const supports = new THREE.InstancedMesh(supportGeom, propMaterial, supportAnchors.length);
    supports.name = 'Trackside Grandstand Supports';
    supports.castShadow = true;
    for (let i = 0; i < supportAnchors.length; i += 1) {
      const a = supportAnchors[i];
      setPropMatrix(-sign * a.nx, -sign * a.nz, a.x, a.roadY, a.z, 1);
      supports.setMatrixAt(i, _cardMat);
    }
    supports.instanceMatrix.needsUpdate = true;
    meshes.push(supports);
  }

  const sponsorTextures = ['sponsor_speedhunters.png', 'sponsor_mobil.png', 'sponsor_dunlop.png', 'sponsor_falken.png'];
  const sponsorAnchors = placementsAlong(frame, 18, { phase: 9, lateral: sign * (uLine - 0.08) })
    .filter((a) => allowedAtArc(a.s));
  sponsorTextures.forEach((texture, textureIndex) => {
    const anchors = sponsorAnchors.filter((_, i) => i % sponsorTextures.length === textureIndex);
    if (!anchors.length) return;
    const mesh = new THREE.InstancedMesh(cardGeom, getAssetMaterial(texture), anchors.length);
    mesh.name = `Grandstand Fascia ${texture}`;
    for (let i = 0; i < anchors.length; i += 1) {
      const a = anchors[i];
      setCardMatrix(-sign * a.nx, -sign * a.nz, a.x, a.roadY + 1.25, a.z, 4.2, 1.05);
      mesh.setMatrixAt(i, _cardMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
  });

  const flagTextures = ['flag_motul.png', 'flag_falken.png', 'flag_dunlop.png'];
  const flagAnchors = placementsAlong(frame, 30, { phase: 15, lateral: sign * (uLine + depth * 0.9) })
    .filter((a) => allowedAtArc(a.s));
  flagTextures.forEach((texture, textureIndex) => {
    const anchors = flagAnchors.filter((_, i) => i % flagTextures.length === textureIndex);
    if (!anchors.length) return;
    const mesh = new THREE.InstancedMesh(cardGeom, getAssetMaterial(texture), anchors.length);
    mesh.name = `Grandstand Roof Flag ${texture}`;
    for (let i = 0; i < anchors.length; i += 1) {
      const a = anchors[i];
      setCardMatrix(-sign * a.nx, -sign * a.nz, a.x, a.roadY + roofHeight + 1.5, a.z, 0.8, 3);
      mesh.setMatrixAt(i, _cardMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
  });
  return meshes;
}

// Overhead gantries spanning the road, placed on the centerline at arc intervals.
function buildGantryRow({ frame, band, half, allowedAtArc }) {
  const every = Math.max(20, band.every ?? 110);
  const anchors = placementsAlong(frame, every, { phase: band.phase ?? every * 0.5, lateral: 0 }).filter((a) => allowedAtArc(a.s));
  if (anchors.length === 0) return null;
  const geom = buildGantryGeometry({ half, height: band.height ?? 6.5, color: band.color ?? 0x3a3d42 });
  if (!geom) return null;

  const mesh = new THREE.InstancedMesh(geom, propMaterial, anchors.length);
  mesh.name = 'Trackside Gantry';
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  for (let k = 0; k < anchors.length; k += 1) {
    const a = anchors[k];
    // Gantry geometry spans local X; align it across the road by facing the tangent.
    setPropMatrix(a.tx, a.tz, a.x, a.roadY, a.z, 1);
    mesh.setMatrixAt(k, _cardMat);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// Textured panels mounted on the face of the procedural overhead gantries. Each
// family remains one instanced draw and shares the same arc phase as its gantry.
function buildOverheadAssetRow({ frame, band, half, allowedAtArc }) {
  if (!band.texture) return null;
  const every = Math.max(20, band.every ?? 220);
  const anchors = placementsAlong(frame, every, {
    phase: band.phase ?? every * 0.5,
    lateral: 0,
  }).filter((a) => allowedAtArc(a.s));
  if (anchors.length === 0) return null;

  const gantryClearSpan = half * 2 + 1.0;
  const width = Math.min(gantryClearSpan, Math.max(1, band.width ?? gantryClearSpan * 0.9));
  const height = Math.max(0.4, band.boardHeight ?? 1.2);
  const mountY = (band.height ?? 6.5) - 0.9;
  const mesh = new THREE.InstancedMesh(cardGeom, getAssetMaterial(band.texture), anchors.length);
  mesh.name = `Trackside Overhead ${band.asset ?? band.texture}`;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  for (let k = 0; k < anchors.length; k += 1) {
    const a = anchors[k];
    setCardMatrix(
      a.tx, a.tz,
      a.x + a.tx * 0.32, a.roadY + mountY, a.z + a.tz * 0.32,
      width, height,
    );
    mesh.setMatrixAt(k, _cardMat);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// Build a prop transform into _cardMat: base at (px,py,pz), +Z facing (fx,fz), +Y up,
// uniform `scale`. Unlike a card, the geometry already has its base at local y=0, so
// there is no height-centering here.
function setPropMatrix(fx, fz, px, py, pz, scale) {
  _cardFwd.set(fx, 0, fz);
  if (_cardFwd.lengthSq() < 1e-8) _cardFwd.set(0, 0, 1);
  _cardFwd.normalize();
  _cardRight.crossVectors(_up, _cardFwd).normalize();
  _cardUp.crossVectors(_cardFwd, _cardRight).normalize();
  _cardMat.makeBasis(_cardRight, _cardUp, _cardFwd);
  if (scale !== 1) _cardMat.multiply(_cardScale.makeScale(scale, scale, scale));
  _cardMat.setPosition(px, py, pz);
}

// ---- Procedural prop geometry (vertex-coloured, base at y=0, +Z = track-facing) ----

function buildPropGeometry(prop, band) {
  switch (prop) {
    case 'streetlight': return buildStreetlight();
    case 'grandstand': return buildGrandstand();
    case 'brakingBoard': return buildBrakingBoard();
    default: return null;
  }
}

function buildStreetlight() {
  return mergeColored([
    coloredBox(0.16, 6, 0.16, 0, 3, 0, 0x4a4d52),      // pole
    coloredBox(0.12, 0.12, 2.2, 0, 5.8, 1.1, 0x4a4d52), // arm reaching toward track
    coloredBox(0.5, 0.22, 0.5, 0, 5.7, 2.2, 0xffe6ad),  // lamp head (warm)
  ]);
}

function buildGrandstand() {
  // Front edge at z=0 (the offset line), seating rakes up and back toward -Z.
  return mergeColored([
    coloredBox(12, 5, 0.5, 0, 2.5, -6, 0x8a8e95),           // back wall
    coloredBox(12, 0.3, 4.2, 0, 6, -4, 0x55585e),           // roof
    coloredBox(0.5, 5, 6, -6, 2.5, -3, 0x73767d),           // left side wall
    coloredBox(0.5, 5, 6, 6, 2.5, -3, 0x73767d),            // right side wall
    quadGeom(                                                // crowd seating slope
      [-5.6, 1, 0], [5.6, 1, 0], [5.6, 4.6, -5.6], [-5.6, 4.6, -5.6], 0xb1685a,
    ),
  ]);
}

function buildBrakingBoard() {
  return mergeColored([
    coloredBox(0.12, 1.6, 0.12, 0, 0.8, 0, 0x2c2c2c),  // post
    coloredBox(1.4, 1.0, 0.08, 0, 1.7, 0.05, 0xf2f2f2), // board
    coloredBox(1.4, 0.22, 0.1, 0, 1.7, 0.07, 0xcc2a22), // red marker stripe
  ]);
}

function buildGantryGeometry({ half, height, color }) {
  const span = half * 2 + 1.6;          // clear the road plus a margin each side
  const postX = span * 0.5;
  return mergeColored([
    coloredBox(0.5, height, 0.5, -postX, height * 0.5, 0, color),       // left post
    coloredBox(0.5, height, 0.5, postX, height * 0.5, 0, color),        // right post
    coloredBox(span + 1, 0.6, 0.6, 0, height, 0, color),               // top beam
    coloredBox(span * 0.88, 1.5, 0.22, 0, height - 0.95, 0, 0x16171b), // sign panel
  ]);
}

// ---- small geometry helpers ----

function coloredBox(w, h, d, cx, cy, cz, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(cx, cy, cz);
  setGeomColor(g, hex);
  return g;
}

// A single quad (two triangles) from four corners, with computed normals + a uv so it
// shares the BoxGeometry attribute set (position, normal, uv, color) for merging.
function quadGeom(a, b, c, d, hex) {
  const g = new THREE.BufferGeometry();
  const positions = new Float32Array([
    a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
    a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2],
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(12), 2));
  // Indexed so it merges with the (indexed) BoxGeometry props.
  g.setIndex([0, 1, 2, 3, 4, 5]);
  g.computeVertexNormals();
  setGeomColor(g, hex);
  return g;
}

function setGeomColor(g, hex) {
  _color.set(hex);
  const count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = _color.r;
    colors[i * 3 + 1] = _color.g;
    colors[i * 3 + 2] = _color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function mergeColored(geoms) {
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  return merged;
}

// Vertical/edge strip helper: 2 verts per sample (a/b) chosen by `pick(i, isB)`,
// solid colour, stitched into quads.
function vstrip(n, pick, cr, cg, cb, pickUv = null, segmentAllowed = null) {
  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 3);
  const uvs = pickUv ? new Float32Array(n * 2 * 2) : null;
  for (let i = 0; i < n; i += 1) {
    const a = pick(i, false);
    const b = pick(i, true);
    const o = i * 6;
    positions[o] = a[0]; positions[o + 1] = a[1]; positions[o + 2] = a[2];
    positions[o + 3] = b[0]; positions[o + 4] = b[1]; positions[o + 5] = b[2];
    colors[o] = cr; colors[o + 1] = cg; colors[o + 2] = cb;
    colors[o + 3] = cr; colors[o + 4] = cg; colors[o + 5] = cb;
    if (uvs) {
      const uvA = pickUv(i, false);
      const uvB = pickUv(i, true);
      const u = i * 4;
      uvs[u] = uvA[0]; uvs[u + 1] = uvA[1];
      uvs[u + 2] = uvB[0]; uvs[u + 3] = uvB[1];
    }
  }
  return makeStrip(positions, colors, n, uvs, segmentAllowed);
}

// Stitch a 2-vert-per-sample strip into a triangle ribbon (matches the road ribbon
// winding: a,c,b / b,c,d per quad).
function makeStrip(positions, colors, n, uvs = null, segmentAllowed = null) {
  const indices = [];
  for (let i = 0; i < n - 1; i += 1) {
    if (segmentAllowed && !segmentAllowed(i)) continue;
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (uvs) geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}
