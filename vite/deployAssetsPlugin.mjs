/**
 * Production build hygiene for Cloudflare Pages/Workers asset limits.
 *
 * Vite copies all of public/ into dist/ as-is. Local bodyshop scratch files
 * (_bodyshop-draft.glb / _bodyshop-cleaned.glb) live under public/ for the
 * dev server but must never ship. Build also does not run model optimization
 * — oversized authored GLBs fail deploy with a clear message instead of
 * waiting for wrangler.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** Cloudflare Workers/Pages static asset max (binary MiB). */
export const CLOUDFLARE_ASSET_MAX_BYTES = 25 * 1024 * 1024;

/** Local-only bodyshop editor scratch; never deploy. */
const LOCAL_ONLY_BASENAMES = new Set([
  '_bodyshop-draft.glb',
  '_bodyshop-cleaned.glb',
]);

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function stripLocalOnlyAssets(distRoot = DIST) {
  const removed = [];
  for (const filePath of walkFiles(distRoot)) {
    if (!LOCAL_ONLY_BASENAMES.has(path.basename(filePath))) continue;
    fs.rmSync(filePath, { force: true });
    removed.push(path.relative(distRoot, filePath));
  }
  return removed;
}

export function findOversizedAssets(distRoot = DIST, maxBytes = CLOUDFLARE_ASSET_MAX_BYTES) {
  const oversized = [];
  for (const filePath of walkFiles(distRoot)) {
    const { size } = fs.statSync(filePath);
    if (size > maxBytes) {
      oversized.push({
        path: path.relative(distRoot, filePath),
        size,
      });
    }
  }
  return oversized.sort((a, b) => b.size - a.size);
}

export function deployAssetsPlugin() {
  return {
    name: 'dreamfall-deploy-assets',
    apply: 'build',
    closeBundle() {
      const removed = stripLocalOnlyAssets(DIST);
      if (removed.length) {
        console.log(
          `[deploy-assets] stripped local-only files from dist:\n  - ${removed.join('\n  - ')}`,
        );
      }

      const oversized = findOversizedAssets(DIST);
      if (!oversized.length) return;

      const lines = oversized.map(
        (item) => `  - ${item.path} (${formatMiB(item.size)})`,
      );
      throw new Error(
        [
          `Cloudflare asset limit is ${formatMiB(CLOUDFLARE_ASSET_MAX_BYTES)} per file.`,
          'Build does not auto-optimize models — oversized files must be reduced first.',
          'Run: node scripts/optimize-models.mjs --models <name>',
          'Oversized files in dist:',
          ...lines,
        ].join('\n'),
      );
    },
  };
}
