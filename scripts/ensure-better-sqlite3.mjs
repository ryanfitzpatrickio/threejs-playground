/**
 * Ensure better-sqlite3's native binary matches the current Node ABI.
 *
 * Dual Node installs (e.g. Homebrew 26 + /usr/local 22) frequently leave the
 * .node addon compiled for the wrong version. Rebuild automatically when that
 * happens so export/build keep working.
 *
 * Usable as a CLI (`node scripts/ensure-better-sqlite3.mjs`) or imported:
 *   await import('../scripts/ensure-better-sqlite3.mjs');
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function tryLoad() {
  try {
    require('better-sqlite3');
    return null;
  } catch (err) {
    const message = err?.message || String(err);
    if (err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(message)) {
      return err;
    }
    throw err;
  }
}

export function ensureBetterSqlite3() {
  const firstError = tryLoad();
  if (!firstError) return { rebuilt: false };

  console.warn(
    `[ensure-better-sqlite3] native ABI mismatch on Node ${process.version} `
    + `(modules ${process.versions.modules}) — running npm rebuild better-sqlite3…`,
  );

  const rebuild = spawnSync('npm', ['rebuild', 'better-sqlite3'], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });

  if (rebuild.status !== 0) {
    throw new Error('[ensure-better-sqlite3] npm rebuild failed');
  }

  const secondError = tryLoad();
  if (secondError) {
    throw new Error(
      '[ensure-better-sqlite3] still broken after rebuild.\n'
      + `  node: ${process.execPath} (${process.version})\n`
      + '  Fix: use one Node install, then run:\n'
      + '    rm -rf node_modules/better-sqlite3/build && npm rebuild better-sqlite3\n'
      + `  Last error: ${secondError.message}`,
    );
  }

  console.info(`[ensure-better-sqlite3] rebuilt ok for Node ${process.version}`);
  return { rebuilt: true };
}

// Eagerly run on import so `await import(...)` from Vite plugins just works.
try {
  ensureBetterSqlite3();
} catch (err) {
  if (isMain) {
    console.error(err?.message || err);
    process.exit(1);
  }
  throw err;
}

if (isMain) {
  process.exit(0);
}
