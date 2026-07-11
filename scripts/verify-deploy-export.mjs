import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportStaticDataToDist } from '../vite/export-static-data.mjs';
import { closeDreamfallDatabase } from '../vite/sqlite-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDbPath = path.join(__dirname, '..', '.codex-tmp', 'deploy-export-verify.db');
const tempDistData = path.join(__dirname, '..', '.codex-tmp', 'deploy-export-dist');

function rmDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

rmDbFiles(tempDbPath);
fs.mkdirSync(path.dirname(tempDbPath), { recursive: true });
fs.rmSync(tempDistData, { recursive: true, force: true });

const filtered = await exportStaticDataToDist({
  dbPath: tempDbPath,
  distDataRoot: tempDistData,
  dataRoot: path.join(__dirname, '..', 'deploy-data'),
  importJsonOnEmpty: false,
});

closeDreamfallDatabase(tempDbPath);

assert.ok(filtered.worldmaps.length >= 2, 'expected default world + rally world maps');
assert.ok(
  filtered.worldmaps.some((entry) => entry.id === 'scene_mr50xnlt_1'),
  'default world map missing from export',
);
assert.ok(
  filtered.worldmaps.some((entry) => entry.id === 'pine-ridge-rally'),
  'default rally map missing from export',
);

assert.equal(filtered.state.defaultWorldSceneId, 'scene_mr50xnlt_1');
assert.equal(filtered.state.defaultRallySceneId, 'pine-ridge-rally');

for (const sceneId of ['scene_mr50xnlt_1', 'pine-ridge-rally']) {
  const filePath = path.join(tempDistData, 'worldmaps', `${sceneId}.json`);
  assert.ok(fs.existsSync(filePath), `${sceneId}.json not written`);
}

const blueprintIds = filtered.blueprints.map((entry) => entry.id);
for (const blueprintId of ['bp_racetrackcenter_mr2x9jj1_1', 'bp_mr2wum6d_1']) {
  assert.ok(blueprintIds.includes(blueprintId), `blueprint ${blueprintId} missing from export`);
}

const { GUN_CATALOG } = await import('../src/game/weapons/gunProfile.js');
const gunsmithIds = (filtered.gunsmith ?? []).map((entry) => entry.id);
assert.equal(
  gunsmithIds.length,
  GUN_CATALOG.length,
  `expected all ${GUN_CATALOG.length} catalog guns, got ${gunsmithIds.length}: ${gunsmithIds.join(', ')}`,
);
for (const entry of GUN_CATALOG) {
  assert.ok(gunsmithIds.includes(entry.id), `gunsmith ${entry.id} missing from export index`);
  const filePath = path.join(tempDistData, 'gunsmith', `${entry.id}.json`);
  assert.ok(fs.existsSync(filePath), `gunsmith/${entry.id}.json not written`);
}

console.log('verify:deploy-export ok');
