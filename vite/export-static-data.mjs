import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultRallyWorldMap } from '../src/world/worldMap/defaultRallyMap.js';
import { normalizeWorldMap } from '../src/world/worldMap/worldMapSchema.js';
import {
  COLLECTION_DIRS,
  DEFAULT_DB_PATH,
  DEFAULT_DATA_ROOT,
  ID_PATTERN,
  buildStoreIndex,
  collectBlueprintIdsFromWorldmaps,
  listExportableEntries,
  openDreamfallDatabase,
  readAppState,
  readStoreEntry,
  writeAppState,
  writeStoreEntry,
} from './sqlite-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, '..', 'data', 'export-manifest.json');
const DEFAULT_DEPLOY_DATA_ROOT = path.resolve(__dirname, '..', 'deploy-data');
const DEFAULT_DEPLOY_MANIFEST_PATH = path.resolve(DEFAULT_DEPLOY_DATA_ROOT, 'export-manifest.json');
const DEFAULT_DIST_DATA = path.resolve(__dirname, '..', 'dist', 'data');
const BUILTIN_RALLY_SCENE_ID = 'pine-ridge-rally';
const DEFAULT_WORLD_SCENE_ID = 'scene_mr50xnlt_1';

const COLLECTION_EXPORT_DIRS = {
  blueprints: 'blueprints',
  worldmaps: 'worldmaps',
  mapbuilder: 'mapbuilder',
  garage: 'garage',
};

async function readManifest(manifestPath) {
  try {
    const raw = await fsPromises.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return {
        worldmaps: [],
        blueprints: [],
        garage: [],
        includeState: true,
        includeExportStatic: true,
      };
    }
    throw err;
  }
}

async function readMergedManifest(options = {}) {
  const manifests = await Promise.all([
    readManifest(options.deployManifestPath ?? DEFAULT_DEPLOY_MANIFEST_PATH),
    readManifest(options.manifestPath ?? DEFAULT_MANIFEST_PATH),
  ]);
  return {
    worldmaps: [...new Set(manifests.flatMap((manifest) => manifest.worldmaps ?? []))],
    blueprints: [...new Set(manifests.flatMap((manifest) => manifest.blueprints ?? []))],
    garage: [...new Set(manifests.flatMap((manifest) => manifest.garage ?? []))],
    includeState: manifests.every((manifest) => manifest.includeState !== false),
    includeExportStatic: manifests.some((manifest) => manifest.includeExportStatic !== false),
  };
}

async function writeJson(filePath, data) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function importMissingJsonFiles(db, dataRoot) {
  if (!dataRoot || !fs.existsSync(dataRoot)) return 0;

  let imported = 0;
  for (const [collection, dirName] of Object.entries(COLLECTION_DIRS)) {
    const dir = path.join(dataRoot, dirName);
    if (!fs.existsSync(dir)) continue;

    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const id = name.slice(0, -5);
      if (!ID_PATTERN.test(id)) continue;
      if (readStoreEntry(db, collection, id) !== null) continue;

      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        writeStoreEntry(db, collection, id, data);
        imported += 1;
      } catch {
        // skip corrupt files
      }
    }
  }

  const statePath = path.join(dataRoot, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const deployState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const current = readAppState(db);
      writeAppState(db, { ...deployState, ...current });
      imported += 1;
    } catch {
      // ignore corrupt state
    }
  }

  return imported;
}

function seedBuiltInRallyScene(db) {
  if (readStoreEntry(db, 'worldmaps', BUILTIN_RALLY_SCENE_ID) !== null) return;

  const map = getDefaultRallyWorldMap();
  writeStoreEntry(db, 'worldmaps', BUILTIN_RALLY_SCENE_ID, {
    id: BUILTIN_RALLY_SCENE_ID,
    name: map.name ?? 'Pine Ridge Rally',
    savedAt: Date.now(),
    map: normalizeWorldMap(map),
  }, { exportStatic: true });
}

function ensurePlayableDefaults(db) {
  const state = readAppState(db);
  const patch = { ...state };

  if (!patch.defaultRallySceneId) patch.defaultRallySceneId = BUILTIN_RALLY_SCENE_ID;
  if (!patch.defaultWorldSceneId && readStoreEntry(db, 'worldmaps', DEFAULT_WORLD_SCENE_ID)) {
    patch.defaultWorldSceneId = DEFAULT_WORLD_SCENE_ID;
  }
  if (!patch.activeSceneId && patch.defaultWorldSceneId) {
    patch.activeSceneId = patch.defaultWorldSceneId;
  }

  if (JSON.stringify(patch) !== JSON.stringify(state)) {
    writeAppState(db, patch);
  }
}

function prepareDatabaseForExport(db, options = {}) {
  const deployDataRoot = options.deployDataRoot ?? DEFAULT_DEPLOY_DATA_ROOT;
  const importedDeploy = importMissingJsonFiles(db, deployDataRoot);
  if (importedDeploy > 0) {
    console.info(`[export-static-data] merged ${importedDeploy} deploy-data item(s)`);
  }

  seedBuiltInRallyScene(db);
  ensurePlayableDefaults(db);
}

export async function exportStaticDataToDist(options = {}) {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const distDataRoot = options.distDataRoot ?? DEFAULT_DIST_DATA;

  const db = openDreamfallDatabase({
    dbPath,
    dataRoot: options.dataRoot ?? DEFAULT_DATA_ROOT,
    importJsonOnEmpty: options.importJsonOnEmpty !== false,
  });

  prepareDatabaseForExport(db, options);

  const manifest = await readMergedManifest(options);
  const exportIds = listExportableEntries(db, manifest);

  for (const blueprintId of collectBlueprintIdsFromWorldmaps(db, exportIds.worldmaps)) {
    exportIds.blueprints.add(blueprintId);
  }

  const state = manifest.includeState === false ? {} : readAppState(db);

  await fsPromises.rm(distDataRoot, { recursive: true, force: true });
  await fsPromises.mkdir(distDataRoot, { recursive: true });

  for (const [collection, ids] of Object.entries(exportIds)) {
    const dirName = COLLECTION_EXPORT_DIRS[collection];
    if (!dirName) continue;
    for (const id of ids) {
      const data = readStoreEntry(db, collection, id);
      if (data === null) {
        console.warn(`[export-static-data] missing ${collection}/${id} — skipped`);
        continue;
      }
      await writeJson(path.join(distDataRoot, dirName, `${id}.json`), data);
    }
  }

  if (manifest.includeState !== false) {
    await writeJson(path.join(distDataRoot, 'state.json'), state);
  }

  const index = buildStoreIndex(db);
  const filtered = {
    blueprints: index.blueprints.filter((entry) => exportIds.blueprints.has(entry.id)),
    worldmaps: index.worldmaps.filter((entry) => exportIds.worldmaps.has(entry.id)),
    mapbuilder: [],
    garage: index.garage.filter((entry) => exportIds.garage.has(entry.id)),
    state,
  };

  await writeJson(path.join(distDataRoot, 'index.json'), filtered);

  const total = filtered.blueprints.length + filtered.worldmaps.length + filtered.garage.length;
  console.info(
    `[export-static-data] wrote ${total} level(s) to ${distDataRoot}`
    + ` (${filtered.worldmaps.length} world map(s), ${filtered.blueprints.length} blueprint(s))`,
  );

  return filtered;
}
