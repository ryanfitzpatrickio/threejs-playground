// Reproduce "race track center piece entity doesn't load in World play" with the
// REAL draft map + blueprint from data/dreamfall.db, through the same
// createStreamingTerrainLevel path the runtime World uses.
//
// Run: node scripts/probe-entity-world-load.mjs

import Database from 'better-sqlite3';

// --- headless DOM stub (createAtlasMaterial paints canvas textures per object) ---
const ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : ctx2d),
  apply: () => ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

const db = new Database('data/dreamfall.db', { readonly: true });
const row = (collection, id) =>
  JSON.parse(db.prepare('select data from store_entries where collection=? and id=?').get(collection, id).data);
const draft = row('worldmaps', '_draft');
const blueprintRows = db.prepare("select id, data from store_entries where collection='blueprints'").all();
db.close();

const { saveBlueprint } = await import('../src/map/blueprintLibrary.js');
const { normalizeWorldMap } = await import('../src/world/worldMap/worldMapSchema.js');
const { createStreamingTerrainLevel } = await import('../src/game/world/createStreamingTerrainLevel.js');

// Seed the fileStore cache exactly with what the browser would have hydrated.
for (const { data } of blueprintRows) {
  const entry = JSON.parse(data);
  saveBlueprint({ id: entry.id, name: entry.name, project: entry.project });
}

const worldMap = normalizeWorldMap(draft);
console.log('map entities after normalize:', JSON.stringify(worldMap.entities));

const level = createStreamingTerrainLevel({}, { worldMap });

const entityGroups = [];
level.group.traverse((o) => { if (o.name?.startsWith('Entity ')) entityGroups.push(o); });
console.log('entity groups in level:', entityGroups.map((g) => `${g.name} children=${g.children.length}`));

const bpColliders = level.colliders.filter((c) => String(c.name ?? '').includes('bp') || String(c.physicsOwnerKey ?? '').includes('bp'));
console.log('blueprint colliders:', bpColliders.length);

const e = worldMap.entities[0];
if (e) {
  const g = level.getGroundHeightAt({ x: e.x, y: 100, z: e.z });
  console.log(`ground at entity (${e.x}, ${e.z}):`, g);
  let minY = Infinity, maxY = -Infinity, meshCount = 0;
  for (const eg of entityGroups) {
    eg.updateMatrixWorld(true);
    eg.traverse((o) => {
      if (!o.isMesh) return;
      meshCount += 1;
      minY = Math.min(minY, o.position.y);
      maxY = Math.max(maxY, o.position.y);
    });
  }
  console.log(`entity meshes: ${meshCount}, mesh y range: ${minY.toFixed(2)}..${maxY.toFixed(2)}`);
}
console.log('spawnPoint:', level.spawnPoint);
