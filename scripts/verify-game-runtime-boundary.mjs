/**
 * Ratcheting boundary guard for GameRuntime modularization.
 *
 * Rules (phase 5 lock-in, with transitional ceilings while extraction continues):
 * - GameRuntime.js physical line count must not exceed CEILING (ratchets down only)
 * - Import count must not increase beyond IMPORT_CEILING
 * - GameRuntime.js must not construct *System classes directly
 * - GameRuntime.js must not implement __DREAMFALL_DEBUG__
 * - GameRuntime.js must not contain levelMode feature branches
 * - Runtime / debug-runtime modules should stay under MODULE_CEILING (exceptions listed)
 *
 *   npm run verify:game-runtime-boundary
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const facadePath = join(root, 'src/game/core/GameRuntime.js');

// Phase 5 target is 450; transitional ceiling after extraction.
const CEILING = 450;
const IMPORT_CEILING = 5;
const MODULE_CEILING = 600;

/** Documented exceptions above MODULE_CEILING (mechanical frame/loader bodies). */
const MODULE_EXCEPTIONS = new Map([
  ['src/game/runtime/RuntimeFramePipeline.js', 950],
  ['src/game/runtime/RuntimeLoader.js', 650],
  ['src/game/runtime/createRuntimeKernel.js', 750],
]);

function physicalLines(text) {
  // Count like wc -l (newline-terminated lines; trailing content without newline counts)
  if (text.length === 0) return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function nonblankLines(text) {
  return text.split('\n').filter((l) => l.trim().length > 0).length;
}

function countImports(text) {
  const matches = text.match(/^import\s.+$/gm);
  return matches?.length ?? 0;
}

function listJsFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listJsFiles(p, acc);
    else if (name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const facade = readFileSync(facadePath, 'utf8');
const lines = physicalLines(facade);
const nonblank = nonblankLines(facade);
const imports = countImports(facade);

console.log('GameRuntime.js boundary:');
console.log({
  physicalLines: lines,
  nonblankLines: nonblank,
  imports,
  ceiling: CEILING,
  importCeiling: IMPORT_CEILING,
});

assert.ok(
  lines <= CEILING,
  `GameRuntime.js has ${lines} lines (ceiling ${CEILING}). Extract features; do not grow the facade.`,
);
assert.ok(
  imports <= IMPORT_CEILING,
  `GameRuntime.js has ${imports} imports (ceiling ${IMPORT_CEILING}).`,
);

// Prohibited patterns in the facade
assert.doesNotMatch(facade, /new\s+\w+System\s*\(/, 'facade must not construct *System classes');
assert.doesNotMatch(facade, /globalThis\.__DREAMFALL_DEBUG__\s*=/, 'facade must not install debug bridge');
assert.doesNotMatch(facade, /levelMode\s*===\s*['"]/, 'facade must not branch on levelMode');
assert.doesNotMatch(facade, /from\s+['"]\.\.\/systems\//, 'facade must not import systems/');
assert.doesNotMatch(facade, /from\s+['"]\.\.\/vehicles\//, 'facade must not import vehicles/');
assert.doesNotMatch(facade, /from\s+['"]\.\.\/world\//, 'facade must not import world/');
assert.doesNotMatch(facade, /from\s+['"]three['"]/, 'facade must not import three');
assert.match(facade, /createRuntimeKernel/, 'facade must delegate to runtime kernel');

// Allowed facade imports: only runtime kernel layer
const importLines = facade.match(/^import\s.+$/gm) ?? [];
for (const line of importLines) {
  assert.match(
    line,
    /from\s+['"]\.\.\/runtime\//,
    `facade import must be from runtime/ layer: ${line}`,
  );
}

// Module ceilings under runtime/ and debug/runtime/
const moduleRoots = [
  join(root, 'src/game/runtime'),
  join(root, 'src/game/debug/runtime'),
];
const oversized = [];
for (const dir of moduleRoots) {
  for (const file of listJsFiles(dir)) {
    const rel = relative(root, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    const n = physicalLines(text);
    const limit = MODULE_EXCEPTIONS.get(rel) ?? MODULE_CEILING;
    if (n > limit) {
      oversized.push({ file: rel, lines: n, limit });
    }
  }
}

if (oversized.length) {
  console.error('Modules over line ceiling:', oversized);
}
assert.equal(oversized.length, 0, 'runtime modules exceed per-file line ceiling');

// Report largest runtime modules for visibility
const sizes = [];
for (const dir of moduleRoots) {
  for (const file of listJsFiles(dir)) {
    const rel = relative(root, file).replace(/\\/g, '/');
    sizes.push({ file: rel, lines: physicalLines(readFileSync(file, 'utf8')) });
  }
}
sizes.sort((a, b) => b.lines - a.lines);
console.log('Largest runtime modules:');
for (const row of sizes.slice(0, 12)) {
  console.log(`  ${row.lines.toString().padStart(4)}  ${row.file}`);
}

console.log('PASS: game-runtime-boundary');
