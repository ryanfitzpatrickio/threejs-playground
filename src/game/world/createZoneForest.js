/**
 * createZoneForest.js
 *
 * A polygon-masked instanced forest for `wilds` world-map zones. Reuses r185's
 * ForestGenerator look — its exported `createForestMaterial` and the same lumpy
 * tree-blob geometry — but does its own placement so trees scatter only inside the
 * drawn polygons, in world coordinates, sitting on the streaming terrain's
 * continuous shaped-height sampler. One InstancedMesh (one draw call). Trees do not
 * cast shadows and are not raycast (kept out of the geometry index).
 */

import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createForestMaterial } from 'three/examples/jsm/generators/ForestGenerator.js';
import { uniform } from 'three/tsl';
import { zoneBounds, zoneContains, polygonArea } from '../../world/worldMap/zoneGeometry.js';

const TREES_PER_SQM = 0.22;       // density target
const MAX_TREES = 220000;         // hard cap so a huge zone can't explode the build
const CULL_FROM = 90;             // distance the canopy starts thinning
const CULL_TO = 280;              // distance past which no tree is drawn
const ALT_MIN = 0.08;             // forest band, as a fraction of the zone's height range
const ALT_MAX = 0.58;
const MIN_FLATNESS = 0.5;         // skip steep ground (normal.y below this)

export function createZoneForest({ zones = [], sampleHeight, forestCount }) {
  if (!zones.length) return { group: null, count: 0, setCameraPosition() {}, dispose() {} };

  // Sample the zones' height range so the altitude band is meaningful.
  let minY = Infinity, maxY = -Infinity;
  for (const zone of zones) {
    const b = zoneBounds(zone);
    for (let s = 0; s <= 8; s += 1) {
      const x = b.minX + ((b.maxX - b.minX) * s) / 8;
      for (let t = 0; t <= 8; t += 1) {
        const z = b.minZ + ((b.maxZ - b.minZ) * t) / 8;
        const y = sampleHeight(x, z);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const span = Math.max(1, maxY - minY);

  const cap = Math.min(MAX_TREES, forestCount ?? MAX_TREES);
  let totalArea = 0;
  for (const zone of zones) {
    totalArea += zone.shape === 'polygon'
      ? polygonArea(zone.points)
      : Math.max(0, (zone.rect.maxX - zone.rect.minX) * (zone.rect.maxZ - zone.rect.minZ));
  }
  const target = Math.min(cap, Math.max(1, Math.ceil(totalArea * TREES_PER_SQM)));

  const geometry = blobGeometry();
  const camPos = uniform(new THREE.Vector3());
  const material = createForestMaterial(uniform(CULL_FROM), uniform(CULL_TO), camPos);

  const mesh = new THREE.InstancedMesh(geometry, material, target);
  mesh.name = 'Wilds Forest';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false; // shader does the distance cull; the mesh spans the zones
  mesh.userData.noCollision = true;

  const cull = new Float32Array(target * 4);
  const region = new Float32Array(target);

  const slopeAt = (x, z) => {
    const e = 3;
    const hx = sampleHeight(x + e, z) - sampleHeight(x - e, z);
    const hz = sampleHeight(x, z + e) - sampleHeight(x, z - e);
    return (2 * e) / Math.sqrt(hx * hx + 4 * e * e + hz * hz); // flatness 0..1
  };

  const dummy = new THREE.Object3D();
  let placed = 0;

  for (const zone of zones) {
    if (placed >= target) break;
    const b = zoneBounds(zone);
    const area = zone.shape === 'polygon'
      ? polygonArea(zone.points)
      : Math.max(1, (b.maxX - b.minX) * (b.maxZ - b.minZ));
    const zoneTarget = Math.min(target - placed, Math.max(1, Math.ceil(area * TREES_PER_SQM)));
    const rng = mulberry32(hashZone(zone) || 1);
    let zonePlaced = 0;
    let attempts = 0;
    const maxAttempts = zoneTarget * 16;

    while (zonePlaced < zoneTarget && placed < target && attempts < maxAttempts) {
      attempts += 1;
      const x = b.minX + rng() * (b.maxX - b.minX);
      const z = b.minZ + rng() * (b.maxZ - b.minZ);
      if (!zoneContains(zone, x, z)) continue;

      const y = sampleHeight(x, z);
      const altitude = (y - minY) / span;
      if (altitude < ALT_MIN || altitude > ALT_MAX) continue;
      if (slopeAt(x, z) < MIN_FLATNESS) continue;
      // density: cheap value-noise clearings, feathered at the top of the band
      const dens = density(x, z) * smooth(ALT_MAX, ALT_MAX - 0.16, altitude);
      if (rng() >= dens) continue;

      dummy.position.set(x, y - 0.4, z); // sink the base into the ground
      dummy.rotation.set((rng() - 0.5) * 0.12, rng() * Math.PI * 2, (rng() - 0.5) * 0.12);
      const s = 0.8 + rng() * rng() * 2.4; // mostly small, rare giants
      dummy.scale.set(s * (0.85 + rng() * 0.3), s, s * (0.85 + rng() * 0.3));
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);

      const c = placed * 4;
      cull[c] = x;
      cull[c + 1] = dummy.position.y;
      cull[c + 2] = z;
      cull[c + 3] = rng();
      region[placed] = THREE.MathUtils.clamp(density(x * 0.7, z * 0.7) + 0.2, 0, 1);

      placed += 1;
      zonePlaced += 1;
    }
  }

  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('cull', new THREE.InstancedBufferAttribute(cull, 4));
  geometry.setAttribute('region', new THREE.InstancedBufferAttribute(region, 1));

  const group = new THREE.Group();
  group.name = 'Wilds Forest Group';
  group.userData.noCollision = true;
  group.add(mesh);

  return {
    group,
    count: placed,
    setCameraPosition: (pos) => { camPos.value.copy(pos); },
    dispose: () => { geometry.dispose(); },
  };
}

// One tree blob: an icosphere squashed into a lumpy teardrop (matches r185's
// ForestGenerator.blobGeometry, which isn't exported), with a baked `ao` 0→1.
function blobGeometry({ detail = 0, radius = 1.3, height = 4, distortion = 0.5 } = {}) {
  let geometry = new THREE.IcosahedronGeometry(1, detail);
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('normal');
  geometry = mergeVertices(geometry);

  const position = geometry.attributes.position;
  const count = position.count;
  const normals = new Float32Array(count * 3);
  const ao = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const ux = position.getX(i);
    const uy = position.getY(i);
    const uz = position.getZ(i);
    const h = (uy + 1) / 2;
    const taper = 1 - 0.62 * h;
    const lump = 1 + distortion * (Math.sin(ux * 3.1) * Math.sin(uy * 2.7 + 1.3) * Math.sin(uz * 3.5 + 2.1));
    const r = taper * lump;
    position.setXYZ(i, ux * r * radius, h * height, uz * r * radius);
    const inv = 1 / Math.hypot(ux, 0.55, uz);
    normals[i * 3] = ux * inv;
    normals[i * 3 + 1] = 0.55 * inv;
    normals[i * 3 + 2] = uz * inv;
    ao[i] = h;
  }

  position.needsUpdate = true;
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function density(x, z) {
  // Cheap 2-octave value noise → patches and clearings, in [0,1].
  const n =
    Math.sin(x * 0.018 + 1.3) * Math.cos(z * 0.015 + 0.7) * 0.6 +
    Math.sin(x * 0.05 + z * 0.04) * 0.4;
  return THREE.MathUtils.clamp(n * 0.5 + 0.62, 0, 1);
}

function smooth(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function hashZone(zone) {
  const b = zoneBounds(zone);
  return Math.abs((Math.round(b.minX) * 73856093) ^ (Math.round(b.minZ) * 19349663)) >>> 0;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
