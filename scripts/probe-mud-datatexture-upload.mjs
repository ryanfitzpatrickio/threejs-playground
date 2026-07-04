// M2 of the rally-mud plan (docs/rally-mud-tread-plan.md): confirm the packed
// deform DataTexture path works under the WebGPU build's constraints BEFORE
// relying on it for visuals, and that the mud material is a scope-safe variant.
//
// The rally-dust lesson was that TSL storage() COMPUTE buffers don't re-upload
// from CPU needsUpdate under WebGPU — but sampled DataTextures / buffer
// attributes DO. This probe verifies the CPU→texture packing is correct and the
// texture object is reused (needsUpdate on the same object, never swapped), which
// is what keeps it from re-dirtying the node material (city-GC gotcha).
//
// Guards:
//   - ensureTexture builds a wrapping RGBA8 DataTexture sized to the field;
//   - syncTexture packs deform data plus a second orientation texture containing
//     wheel heading + lateral phase, reusing both texture objects (no realloc);
//   - unstamped slots pack to zero (A=0 → material gate renders like plain dirt);
//   - decay lowers the packed values; a cleared cell packs back to zero;
//   - createRoadworks builds a DISTINCT mud material (not the shared module-level
//     dirtRoadMaterial) that samples the deform texture, and dirt roads are
//     untouched (scope guarantee).
//
// Headless (DataTexture needs no GPU). Actual on-screen ruts are browser-only
// (Playwright-WebGPU-capture gotcha) — this proves the data, not the pixels.
//
// Run: node scripts/probe-mud-datatexture-upload.mjs

import assert from 'node:assert/strict';

const { createMudDeformField } = await import('../src/game/world/mudDeformField.js');
const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { createRoadworks } = await import('../src/game/world/createRoadworks.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- texture packing
{
  const cell = 0.5, R = 64;
  const f = createMudDeformField({ cellSize: cell, resolution: R, maxDepth: 0.1 });
  const tex = f.ensureTexture();
  assert.equal(tex, f.texture, 'ensureTexture publishes the texture');
  assert.equal(tex.image.width, R, 'texture is field-resolution wide');
  assert.equal(tex.image.height, R, 'texture is field-resolution tall');
  assert.equal(tex.wrapS, 1000 /* THREE.RepeatWrapping */, 'wrapS repeats (world-XZ torus)');
  const data = tex.image.data;
  const orientationTex = f.orientationTexture;
  const orientationData = orientationTex.image.data;
  assert.equal(data.length, R * R * 4, 'RGBA8 buffer sized to the grid');

  // Stamp cell (2, 3) at full depth; centre at ((c+0.5)*cellSize).
  const wx = 2, wz = 3;
  f.stamp((wx + 0.5) * cell, (wz + 0.5) * cell, {
    depth: 0.1, wetness: 0.5, tread: 1, directionX: 1, directionZ: 0,
  });
  const same = f.ensureTexture();
  f.syncTexture();
  assert.equal(same, tex, 'syncTexture reuses the same texture object (no realloc)');

  const slot = (wz * R + wx) * 4;
  assert.ok(data[slot] >= 254, `depth (0.1 / maxDepth 0.1) packs to full R (${data[slot]})`);
  assert.ok(Math.abs(data[slot + 1] - 128) <= 2, `wetness 0.5 → ~128 G (${data[slot + 1]})`);
  assert.ok(data[slot + 2] >= 254, `tread 1 → full B (${data[slot + 2]})`);
  assert.ok(data[slot + 3] >= 254, `presence A set where stamped (${data[slot + 3]})`);
  assert.ok(orientationData[slot] >= 254, `heading +X packs to full orientation R (${orientationData[slot]})`);
  assert.ok(Math.abs(orientationData[slot + 1] - 128) <= 2,
    `heading Z=0 packs to midpoint orientation G (${orientationData[slot + 1]})`);
  assert.ok(Math.abs(orientationData[slot + 2] - 64) <= 2,
    `lateral phase packs into orientation B (${orientationData[slot + 2]})`);
  assert.ok(orientationData[slot + 3] >= 254, 'orientation presence follows deform presence');

  const footWx = 5, footWz = 6;
  f.stamp((footWx + 0.5) * cell, (footWz + 0.5) * cell, {
    depth: 0.04, wetness: 1, tread: 0.45, directionX: 0, directionZ: 1, kind: 'foot',
  });
  f.syncTexture();
  const footSlot = (footWz * R + footWx) * 4;
  assert.ok(Math.abs(orientationData[footSlot + 3] - 128) <= 2,
    `foot stamp type packs to midpoint orientation A (${orientationData[footSlot + 3]})`);

  // An unstamped slot is fully zero → the material gate leaves it looking like dirt.
  const emptySlot = (10 * R + 20) * 4;
  assert.equal(data[emptySlot + 3], 0, 'unstamped slot has zero presence');
  assert.equal(orientationData[emptySlot + 3], 0, 'unstamped slot has zero orientation presence');
  ok('ensureTexture + syncTexture pack into the correct ring slot');

  // Decay lowers the packed depth; a long decay clears it back to zero.
  f.decay(4);
  f.syncTexture();
  assert.ok(data[slot] > 0 && data[slot] < 254, `decay lowers packed depth (${data[slot]})`);
  f.decay(120);
  f.syncTexture();
  assert.equal(data[slot + 3], 0, 'cleared cell packs back to zero presence');
  assert.equal(orientationData[slot + 3], 0, 'cleared cell packs orientation back to zero');
  ok('decay flows through to the packed texture');
}

// ---------------------------------------------------------------- footprint FIFO
{
  const f = createMudDeformField({
    cellSize: 0.05,
    resolution: 64,
    maxDepth: 0.1,
    maxFootprints: 2,
    footprintFadeTau: 0.01,
  });
  const stamp = (x) => f.stampFootprint(x, 0, {
    depth: 0.04, wetness: 0.8, tread: 0.4, directionX: 1, directionZ: 0,
  });
  stamp(-0.7);
  stamp(0);
  stamp(0.7);
  f.decay(0.2);
  assert.equal(f.sampleAt(-0.625, 0).wetness, 0, 'oldest footprint retires first');
  assert.ok(f.sampleAt(0.075, 0).wetness > 0, 'newer footprint remains intact');
  assert.ok(f.sampleAt(0.775, 0).wetness > 0, 'newest footprint remains intact');
  ok('footprint trail eviction is strict FIFO');
}

// The production 15 cm grid must retain a sole silhouette rather than reducing
// the footprint to the single circular texel that caused the original defect.
{
  const f = createMudDeformField({ cellSize: 0.15, resolution: 64, maxDepth: 0.25 });
  f.stampFootprint(0, 0, {
    depth: 0.04, wetness: 0.8, tread: 0.4, directionX: 0, directionZ: 1, side: -1,
  });
  assert.ok(f.activeCount >= 8, `footprint spans multiple production-grid texels (${f.activeCount})`);
  assert.ok(f.activeCount <= 20, `footprint remains shoe-shaped (${f.activeCount} texels)`);
  ok('footprint brush preserves a heel-to-toe silhouette at production resolution');
}

// ---------------------------------------------------------------- material scope
{
  const sampleHeight = () => 0;
  const profile = buildRoadProfile({
    roads: [
      { points: [{ x: -60, z: 0 }, { x: 60, z: 0 }], width: 8, trackStyle: 'rallyStage', surface: 'mud' },
      { points: [{ x: -60, z: 40 }, { x: 60, z: 40 }], width: 8, trackStyle: 'rallyStage' },
    ],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  const mudField = createMudDeformField();
  const rw = createRoadworks({ profile, sampleHeight, mudField });
  const mud = rw.group.children.find((c) => /Mud Rally Road Ribbon/.test(c.name));
  const dirt = rw.group.children.find((c) => /Dirt Rally Road Ribbon/.test(c.name));
  assert.ok(mud, 'mud road builds a Mud Rally Road Ribbon mesh');
  assert.ok(dirt, 'dirt road still builds a Dirt Rally Road Ribbon mesh');
  assert.notEqual(mud.material, dirt.material, 'mud uses a distinct material (not shared dirtRoadMaterial)');
  assert.ok(mud.material.colorNode, 'mud material has a composed colorNode (deform folded in)');
  assert.ok(mudField.texture, 'building the mud material created the deform texture');
  assert.ok(mudField.orientationTexture, 'mud material receives the wheel-orientation texture');
  // M2b: the mud ribbon is laterally DENSE (interior columns) so the vertex sink
  // can carve real ruts; the dirt ribbon stays the lean 2-vert strip.
  const vcount = (re) => rw.group.children
    .filter((c) => re.test(c.name))
    .reduce((s, c) => s + (c.geometry.attributes.position?.count ?? 0), 0);
  const mudV = vcount(/Mud Rally Road Ribbon/);
  const dirtV = vcount(/Dirt Rally Road Ribbon/);
  assert.ok(mudV > dirtV * 4, `mud ribbon is laterally dense (${mudV} verts vs dirt ${dirtV})`);
  // The mud material drives a vertex displacement (positionNode) for the sink.
  assert.ok(mud.material.positionNode, 'mud material has a positionNode (vertex rut sink)');
  rw.dispose?.();
  ok('createRoadworks: scope-safe mud material variant + deform texture + dense ribbon');
}

console.log(`\nAll ${passed} mud DataTexture (M2) probes passed.`);
