// One-shot import of legacy data/*.json files into SQLite.
// Run: npm run db:import-json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DATA_ROOT,
  DEFAULT_DB_PATH,
  importJsonFilesToDatabase,
  openDreamfallDatabase,
} from '../vite/sqlite-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', 'data', 'dreamfall.db');

for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

const db = openDreamfallDatabase({
  dbPath,
  dataRoot: path.resolve(__dirname, '..', 'data'),
  importJsonOnEmpty: false,
});

const imported = importJsonFilesToDatabase(db, DEFAULT_DATA_ROOT);
console.log(`import-json-to-sqlite: imported ${imported} file(s) into ${DEFAULT_DB_PATH}`);
