import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DB_PATH,
  DEFAULT_DATA_ROOT,
  buildStoreIndex,
  listExportableEntries,
  openDreamfallDatabase,
  readAppState,
  readStoreEntry,
} from './sqlite-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = path.resolve(__dirname, '..', 'data', 'export-manifest.json');
const DEFAULT_DIST_DATA = path.resolve(__dirname, '..', 'dist', 'data');

const COLLECTION_DIRS = {
  blueprints: 'blueprints',
  worldmaps: 'worldmaps',
  mapbuilder: 'mapbuilder',
  garage: 'garage',
};

async function readManifest(manifestPath) {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
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

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function exportStaticDataToDist(options = {}) {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const distDataRoot = options.distDataRoot ?? DEFAULT_DIST_DATA;

  const db = openDreamfallDatabase({
    dbPath,
    dataRoot: options.dataRoot ?? DEFAULT_DATA_ROOT,
    importJsonOnEmpty: true,
  });

  const manifest = await readManifest(manifestPath);
  const exportIds = listExportableEntries(db, manifest);
  const state = manifest.includeState === false ? {} : readAppState(db);

  await fs.rm(distDataRoot, { recursive: true, force: true });
  await fs.mkdir(distDataRoot, { recursive: true });

  for (const [collection, ids] of Object.entries(exportIds)) {
    const dirName = COLLECTION_DIRS[collection];
    if (!dirName) continue;
    for (const id of ids) {
      const data = readStoreEntry(db, collection, id);
      if (data === null) continue;
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
  console.info(`[export-static-data] wrote ${total} level(s) to ${distDataRoot}`);
}
