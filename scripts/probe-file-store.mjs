// Browser probe: localStorage migration → SQLite, library hydration.
// Requires a dev server (npm run dev). Run: node scripts/probe-file-store.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { openDreamfallDatabase, readStoreEntry } from '../vite/sqlite-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'dreamfall.db');
const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';

const migrationBlueprintId = 'bp_migration_probe';
const migrationSceneId = 'scene_migration_probe';

function clearDatabase() {
  try {
    const db = openDreamfallDatabase({ dbPath, importJsonOnEmpty: false });
    db.prepare('DELETE FROM store_entries').run();
    db.prepare('UPDATE app_state SET data = ? WHERE singleton = 1').run('{}');
  } catch {
    // database may not exist yet
  }
}

async function cleanupProbeRows() {
  try {
    const db = openDreamfallDatabase({ dbPath, importJsonOnEmpty: false });
    db.prepare('DELETE FROM store_entries WHERE id IN (?, ?)').run(migrationBlueprintId, migrationSceneId);
    db.prepare('DELETE FROM store_entries WHERE id = ?').run('_draft');
    db.prepare('DELETE FROM store_entries WHERE collection = ? AND id = ?').run('mapbuilder', '_autosave');
  } catch {
    // db may not exist yet
  }
}

clearDatabase();
await cleanupProbeRows();

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const legacyBlueprints = {
  [migrationBlueprintId]: {
    id: migrationBlueprintId,
    name: 'Migrated Blueprint',
    savedAt: 42,
    project: {
      version: 1, chunkSize: 32, resolution: 33, seed: 1, amplitude: 1, octaves: 1,
      chunks: [{ cx: 0, cz: 0, heights: new Array(33 * 33).fill(0) }],
      objects: [],
    },
  },
};

const legacyScenes = {
  [migrationSceneId]: {
    id: migrationSceneId,
    name: 'Migrated Scene',
    savedAt: 43,
    map: { version: 1, name: 'Migrated Scene', zones: [], pois: [], roads: [], rivers: [], entities: [] },
  },
};

await page.addInitScript(({ blueprints, sceneId, scene }) => {
  localStorage.setItem('dreamfall:blueprints', JSON.stringify(blueprints));
  localStorage.setItem('dreamfall:worldmap:scenes', JSON.stringify({ [sceneId]: scene }));
  localStorage.setItem('dreamfall:worldmap:active', sceneId);
  localStorage.setItem('dreamfall:worldmap:autosave', JSON.stringify(scene.map));
  localStorage.setItem('dreamfall:mapbuilder:autosave', JSON.stringify({
    version: 1, chunkSize: 32, resolution: 33, seed: 9, amplitude: 1, octaves: 1,
    chunks: [{ cx: 0, cz: 0, heights: new Array(33 * 33).fill(0.2) }],
    objects: [],
  }));
}, { blueprints: legacyBlueprints, sceneId: migrationSceneId, scene: legacyScenes[migrationSceneId] });

await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);

const db = openDreamfallDatabase({ dbPath, importJsonOnEmpty: false });
assert.ok(readStoreEntry(db, 'blueprints', migrationBlueprintId), 'migrated blueprint missing from SQLite');
assert.ok(readStoreEntry(db, 'worldmaps', migrationSceneId), 'migrated scene missing from SQLite');
assert.ok(readStoreEntry(db, 'worldmaps', '_draft'), 'migrated world draft missing from SQLite');
assert.ok(readStoreEntry(db, 'mapbuilder', '_autosave'), 'migrated mapbuilder autosave missing from SQLite');

const keysGone = await page.evaluate(() => ({
  blueprints: localStorage.getItem('dreamfall:blueprints'),
  scenes: localStorage.getItem('dreamfall:worldmap:scenes'),
  active: localStorage.getItem('dreamfall:worldmap:active'),
  draft: localStorage.getItem('dreamfall:worldmap:autosave'),
  mapbuilder: localStorage.getItem('dreamfall:mapbuilder:autosave'),
}));

assert.equal(keysGone.blueprints, null);
assert.equal(keysGone.scenes, null);
assert.equal(keysGone.active, null);
assert.equal(keysGone.draft, null);
assert.equal(keysGone.mapbuilder, null);

const libraryAfterReload = await page.evaluate(async () => {
  const res = await fetch('/api/store/index');
  return res.json();
});
assert.ok(libraryAfterReload.blueprints.some((b) => b.id === migrationBlueprintId));
assert.ok(libraryAfterReload.worldmaps.some((s) => s.id === migrationSceneId));

await browser.close();
await cleanupProbeRows();

console.log('probe-file-store: migration + SQLite hydration ok');
