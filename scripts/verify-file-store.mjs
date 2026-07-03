// Programmatic verification of the dreamfall SQLite store REST API.
// Run: npm run verify:file-store

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDreamfallStoreMiddleware } from '../vite/dreamfall-store-plugin.mjs';
import { openDreamfallDatabase, writeStoreEntry } from '../vite/sqlite-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDbPath = path.join(__dirname, '..', '.codex-tmp', 'file-store-verify.db');

function rmDbFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

async function fetchJson(base, pathname, init) {
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

rmDbFiles(tempDbPath);
fs.mkdirSync(path.dirname(tempDbPath), { recursive: true });

const middleware = createDreamfallStoreMiddleware({ dbPath: tempDbPath, importJsonOnEmpty: false });
const server = http.createServer((req, res) => {
  middleware(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found');
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

console.log('verify-file-store');

{
  const blueprint = {
    id: 'bp_test',
    name: 'Test Blueprint',
    savedAt: Date.now(),
    project: { version: 1, chunkSize: 32, resolution: 33, chunks: [], objects: [] },
  };
  const put = await fetchJson(base, '/api/store/blueprints/bp_test', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(blueprint),
  });
  assert.equal(put.status, 200, `PUT blueprint status ${put.status}`);
  ok('PUT blueprint');

  const index = await fetchJson(base, '/api/store/index');
  assert.equal(index.status, 200);
  assert.ok(index.body.blueprints.some((b) => b.id === 'bp_test'));
  ok('GET index lists saved blueprint');

  const snapshot = await fetchJson(base, '/api/store/snapshot');
  assert.equal(snapshot.status, 200);
  assert.ok(snapshot.body.worldmaps?.bp_test === undefined);
  assert.ok(snapshot.body.blueprints?.bp_test?.name === 'Test Blueprint');
  ok('GET snapshot returns full blueprint payload');

  const db = openDreamfallDatabase({ dbPath: tempDbPath, importJsonOnEmpty: false });
  writeStoreEntry(db, 'blueprints', 'dropped', {
    id: 'ignored-id',
    name: 'Hand Inserted',
    savedAt: 1,
    project: { version: 1, chunkSize: 32, resolution: 33, chunks: [{ cx: 0, cz: 0, heights: [] }], objects: [] },
  });

  const index2 = await fetchJson(base, '/api/store/index');
  assert.ok(index2.body.blueprints.some((b) => b.id === 'dropped'));
  ok('direct DB insert appears in index');

  const readDropped = await fetchJson(base, '/api/store/blueprints/dropped');
  assert.equal(readDropped.body.id, 'dropped');
  ok('stored id wins over mismatched id field in JSON');

  const evil = await fetchJson(base, '/api/store/blueprints/..%2Fevil', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.ok(evil.status >= 400);
  ok('path traversal rejected');

  const del = await fetchJson(base, '/api/store/blueprints/bp_test', { method: 'DELETE' });
  assert.equal(del.status, 200);
  ok('DELETE blueprint');
}

await new Promise((resolve) => server.close(resolve));
rmDbFiles(tempDbPath);

console.log(`\nverify-file-store: ${passed} passed`);
