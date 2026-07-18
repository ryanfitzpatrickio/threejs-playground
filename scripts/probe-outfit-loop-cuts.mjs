// Diagnose why garment cruft survives authored surface loop cuts.
//
// Replays the exact outfitLoopCuts saved for a sim (or an outfit's authored
// defaults) against an outfit GLB, using the same installOutfitLoopCuts path
// as the runtime, then reports every surviving triangle in a region of
// interest: its height, angle around the loop axis, and how far below the
// effective cut boundary each vertex sits (or whether a hidden vertex
// survived, which would indicate a classification bug).
//
// Usage:
//   node scripts/probe-outfit-loop-cuts.mjs <outfit.glb> [--sim <simId>] [--cuts '<json>']
//     [--ymin 2.3] [--rmax 0.5]
//
// Defaults: --sim showcase-female, cuts read from data/dreamfall.db.

import path from 'node:path';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import * as THREE from 'three';
import {
  compileOutfitLoopCuts,
  installOutfitLoopCuts,
  sanitizeOutfitLoopCuts,
} from '../src/game/characters/simhuman/outfitLoopCuts.js';

const args = process.argv.slice(2);
const file = args[0];
if (!file) throw new Error('Usage: node scripts/probe-outfit-loop-cuts.mjs <outfit.glb> [--sim id] [--cuts json] [--ymin n] [--rmax n]');
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

let cutsJson = opt('cuts', null);
if (!cutsJson) {
  const simId = opt('sim', 'showcase-female');
  const row = execSync(
    `sqlite3 data/dreamfall.db "SELECT json_extract(data,'$.outfitLoopCuts') FROM store_entries WHERE collection='sims' AND id='${simId}';"`,
    { encoding: 'utf8' },
  ).trim();
  cutsJson = row && row !== 'null' ? row : '[]';
}
const cuts = sanitizeOutfitLoopCuts(JSON.parse(cutsJson));
console.log(`cuts: ${cuts.length}`);
for (const cut of cuts) {
  const reach = Number.isFinite(cut.radialReach) ? ` reach=${cut.radialReach}` : ' reach=off';
  console.log(`  ${cut.id} target=${cut.target} interp=${cut.interpolation} hideSide=${cut.hideSide} inset=${cut.edgeInset}${reach} points=${cut.points.length}`);
}
const compiled = compileOutfitLoopCuts(cuts);

const yMin = Number(opt('ymin', 2.3));
const rMax = Number(opt('rmax', 0.5));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const document = await io.read(path.resolve(file));
const meshes = [];
for (const node of document.getRoot().listNodes()) {
  const sourceMesh = node.getMesh();
  if (!sourceMesh || !node.getSkin()) continue;
  for (const primitive of sourceMesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    if (!position) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position.getArray(), 3));
    const sourceIndex = primitive.getIndices();
    if (sourceIndex) geometry.setIndex(new THREE.BufferAttribute(sourceIndex.getArray(), 1));
    else geometry.setIndex([...Array(position.getCount()).keys()]);
    meshes.push(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  }
}
console.log(`meshes: ${meshes.length}`);

// Sample a periodic knot field (axial or radius) around the ring.
function sampleKnotField(knots, angle, interpolation, field) {
  if (!knots?.length) return 0;
  if (knots.length === 1) return knots[0][field];
  const tau = Math.PI * 2;
  let rightIndex = knots.findIndex((knot) => knot.angle >= angle);
  if (rightIndex < 0) rightIndex = 0;
  const leftIndex = (rightIndex - 1 + knots.length) % knots.length;
  const left = knots[leftIndex];
  const right = knots[rightIndex];
  const leftAngle = left.angle;
  const rightAngle = rightIndex === 0 ? right.angle + tau : right.angle;
  const sampleAngle = rightIndex === 0 && angle < leftAngle ? angle + tau : angle;
  const span = Math.max(1e-6, rightAngle - leftAngle);
  let t = Math.min(1, Math.max(0, (sampleAngle - leftAngle) / span));
  if (interpolation === 'smooth') t = t * t * (3 - 2 * t);
  return left[field] + (right[field] - left[field]) * t;
}

// Effective hidden test identical to the garment drop rule (torso min 1 vertex).
function vertexHidden(cut, x, y, z) {
  const { origin, axis, u, v } = cut.frame;
  const dx = x - origin[0];
  const dy = y - origin[1];
  const dz = z - origin[2];
  const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
  const radialU = dx * u[0] + dy * u[1] + dz * u[2];
  const radialV = dx * v[0] + dy * v[1] + dz * v[2];
  const radius = Math.hypot(radialU, radialV);
  if (radius > cut.radialLimit) return { hidden: false, margin: Infinity, angle: 0, axial, boundary: 0 };
  const tau = Math.PI * 2;
  const angle = ((Math.atan2(radialV, radialU) % tau) + tau) % tau;
  // Tube limit: finite radialReach keeps the cut inside a ring around the dots.
  if (Number.isFinite(cut.radialReach)) {
    const ringRadius = sampleKnotField(cut.knots, angle, cut.interpolation, 'radius');
    if (radius > ringRadius + cut.radialReach) {
      return { hidden: false, margin: Infinity, angle, axial, boundary: 0, outsideTube: true };
    }
  }
  const boundary = sampleKnotField(cut.knots, angle, cut.interpolation, 'axial');
  const adjusted = cut.hideSide === 'negative' ? boundary - cut.edgeInset : boundary + cut.edgeInset;
  const hidden = cut.hideSide === 'negative' ? axial <= adjusted : axial >= adjusted;
  // margin < 0 means "kept, this far below the (positive-side) boundary".
  return { hidden, margin: cut.hideSide === 'negative' ? adjusted - axial : axial - adjusted, angle, axial, boundary: adjusted };
}

// Boundary profile around the ring (torso frame assumed y-up). Sample on the
// drawn ring radius so tube-limited cuts report their real axial threshold.
if (compiled.length) {
  console.log('\neffective boundary per 10° sector (per torso cut):');
  for (const cut of compiled.filter((entry) => entry.target === 'torso')) {
    const line = [];
    for (let deg = 0; deg < 360; deg += 30) {
      const angle = (deg * Math.PI) / 180;
      const ringR = sampleKnotField(cut.knots, angle, cut.interpolation, 'radius') || 0.2;
      // Sit slightly inside the ring so radialReach does not exclude the sample.
      const r = Math.max(0.02, ringR * 0.5);
      const x = Math.cos(angle) * r;
      const z = -Math.sin(angle) * r;
      const probe = vertexHidden(cut, x, 0, z);
      line.push(`${deg}°:${probe.boundary.toFixed(3)}`);
    }
    const reach = Number.isFinite(cut.radialReach) ? `reach=${cut.radialReach}` : 'reach=off';
    console.log(`  ${cut.id} (${reach}): ` + line.join(' '));
    console.log('    knots: ' + cut.knots.map((knot) => `${((knot.angle * 180) / Math.PI).toFixed(0)}°@y${knot.axial.toFixed(3)}/r${knot.radius.toFixed(3)}`).join(' '));
  }
}

const handle = installOutfitLoopCuts(meshes, cuts);
console.log(`\ntriangles: source=${handle.sourceTriangles} visible=${handle.visibleTriangles} removed=${handle.sourceTriangles - handle.visibleTriangles}`);

// Scan SURVIVING triangles in the region of interest.
let regionTriangles = 0;
let hiddenVertexSurvivors = 0;
const marginBuckets = new Map();
const samples = [];
const yExtent = [Infinity, -Infinity];
for (const mesh of meshes) {
  const geometry = mesh.geometry;
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  for (let offset = 0; offset + 2 < index.count; offset += 3) {
    const ids = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
    let inRegion = false;
    const verts = ids.map((id) => [position.getX(id), position.getY(id), position.getZ(id)]);
    for (const [x, y, z] of verts) {
      if (y > yMin && Math.hypot(x, z) < rMax) { inRegion = true; break; }
    }
    if (!inRegion) continue;
    regionTriangles += 1;
    let worstMargin = -Infinity;
    let anyHidden = false;
    for (const [x, y, z] of verts) {
      yExtent[0] = Math.min(yExtent[0], y);
      yExtent[1] = Math.max(yExtent[1], y);
      for (const cut of compiled) {
        const result = vertexHidden(cut, x, y, z);
        if (result.hidden) anyHidden = true;
        worstMargin = Math.max(worstMargin, result.margin);
      }
    }
    if (anyHidden) hiddenVertexSurvivors += 1;
    const bucket = worstMargin === Infinity ? 'radial-limit' : `${(Math.floor((worstMargin * 100) / 2) * 2) / 100}`;
    marginBuckets.set(bucket, (marginBuckets.get(bucket) ?? 0) + 1);
    if (samples.length < 12 && regionTriangles % 3 === 0) {
      samples.push(verts.map((v) => v.map((n) => Number(n.toFixed(3)))));
    }
  }
}
console.log(`\nsurviving triangles with any vertex y>${yMin} & r<${rMax}: ${regionTriangles}`);
console.log(`  y extent: ${yExtent[0].toFixed(3)} .. ${yExtent[1].toFixed(3)}`);
console.log(`  triangles with a vertex the cuts classify as HIDDEN (should be 0): ${hiddenVertexSurvivors}`);
console.log('  kept-margin buckets (units below boundary; radial-limit = outside cut envelope):');
for (const [bucket, count] of [...marginBuckets.entries()].sort()) {
  console.log(`    ${bucket}: ${count}`);
}
console.log('  sample surviving vertices:');
for (const sample of samples) console.log('    ' + JSON.stringify(sample));
// NOTE: no handle.dispose() — the appended analysis needs the filtered geometry.

// --- Structure analysis: connected components + XZ density map ---------------
{
  const loY = Number(opt('cy', 2.5));
  const regionR = Number(opt('cr', 0.65));
  // Collect surviving triangles in the analysis region.
  const tris = [];
  const vertSet = new Map(); // vertex id -> index into pts
  const pts = [];
  for (const mesh of meshes) {
    const index = mesh.geometry.getIndex();
    const position = mesh.geometry.getAttribute('position');
    for (let offset = 0; offset + 2 < index.count; offset += 3) {
      const ids = [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)];
      const keep = ids.some((id) => {
        const y = position.getY(id);
        return y > loY && Math.hypot(position.getX(id), position.getZ(id)) < regionR;
      });
      if (!keep) continue;
      const local = ids.map((id) => {
        if (!vertSet.has(id)) {
          vertSet.set(id, pts.length);
          pts.push([position.getX(id), position.getY(id), position.getZ(id)]);
        }
        return vertSet.get(id);
      });
      tris.push(local);
    }
  }
  // Union-find over shared vertices.
  const parent = pts.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (const [a, b, c] of tris) { parent[find(a)] = find(b); parent[find(b)] = find(c); }
  const comps = new Map();
  for (const tri of tris) {
    const root = find(tri[0]);
    if (!comps.has(root)) comps.set(root, { tris: 0, verts: new Set() });
    const comp = comps.get(root);
    comp.tris += 1;
    tri.forEach((v) => comp.verts.add(v));
  }
  const ranked = [...comps.values()].sort((a, b) => b.tris - a.tris).slice(0, 10);
  console.log(`\ncomponents above y>${loY} r<${regionR} (top ${ranked.length} of ${comps.size}):`);
  for (const comp of ranked) {
    let yLo = Infinity, yHi = -Infinity, rLo = Infinity, rHi = -Infinity;
    const angles = [];
    for (const v of comp.verts) {
      const [x, y, z] = pts[v];
      yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
      const r = Math.hypot(x, z);
      rLo = Math.min(rLo, r); rHi = Math.max(rHi, r);
      angles.push(Math.atan2(-z, x));
    }
    // angular span (max gap complement)
    angles.sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 0; i < angles.length; i += 1) {
      const next = i === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[i + 1];
      maxGap = Math.max(maxGap, next - angles[i]);
    }
    const span = Math.PI * 2 - maxGap;
    console.log(`  tris=${comp.tris} verts=${comp.verts.size} y=[${yLo.toFixed(2)},${yHi.toFixed(2)}] r=[${rLo.toFixed(2)},${rHi.toFixed(2)}] angularSpan=${(span * 180 / Math.PI).toFixed(0)}°`);
  }

  // XZ density map for the region (60 cols x 24 rows), y in [loY, loY+0.5].
  const cols = 60, rows = 24, half = regionR;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  let mapped = 0;
  for (const [x, y, z] of pts) {
    if (y < loY || y > loY + 0.5) continue;
    const cx = Math.floor(((x + half) / (2 * half)) * cols);
    const cz = Math.floor(((z + half) / (2 * half)) * rows);
    if (cx < 0 || cx >= cols || cz < 0 || cz >= rows) continue;
    grid[cz][cx] += 1; mapped += 1;
  }
  console.log(`\nXZ density (top view, +x right, +z DOWN=front?, y ${loY}..${(loY + 0.5).toFixed(1)}), ${mapped} verts:`);
  const shades = ' .:-=+*#%@';
  let peak = 1;
  grid.forEach((row) => row.forEach((v) => { peak = Math.max(peak, v); }));
  for (const row of grid) {
    console.log('  ' + row.map((v) => shades[Math.min(shades.length - 1, Math.floor((v / peak) * (shades.length - 1)))]).join(''));
  }
}
