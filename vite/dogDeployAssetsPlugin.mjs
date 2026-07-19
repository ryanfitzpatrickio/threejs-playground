/**
 * Manifest-driven asset copy for the standalone dog product build
 * (docs/dog-park-standalone-deploy-plan.md). vite.dog.config.js sets
 * `publicDir: false` so Vite's default "copy everything under public/" never
 * runs; this plugin copies only `deploy/dog-asset-manifest.json` entries into
 * dist-dog/, then fails the build if anything else shows up (defense in depth
 * against someone re-enabling publicDir) or if size budgets are exceeded.
 *
 * Sibling of vite/deployAssetsPlugin.mjs (main playground's dist/ hygiene),
 * parameterized on distRoot instead of hardcoding dist/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUDFLARE_ASSET_MAX_BYTES } from './deployAssetsPlugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'deploy', 'dog-asset-manifest.json');

export function readDogAssetManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Only supports the two glob shapes the manifest actually uses: `dir/**` and `**\/basename`. */
function globMatches(relPosixPath, pattern) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relPosixPath === prefix || relPosixPath.startsWith(`${prefix}/`);
  }
  if (pattern.startsWith('**/')) {
    return path.posix.basename(relPosixPath) === pattern.slice(3);
  }
  throw new Error(`[dog-deploy-assets] unsupported glob pattern: ${pattern} (only "dir/**" and "**/basename" are implemented)`);
}

function isExcluded(relPosixPath, excludeGlobs) {
  return (excludeGlobs || []).some((pattern) => globMatches(relPosixPath, pattern));
}

/** Resolves manifest `include` + `includeGlobs` into concrete { from, to } copy jobs. */
export function resolveDogManifestCopyJobs(manifest, rootDir = ROOT) {
  const jobs = [];
  const missingRequired = [];

  for (const entry of manifest.include || []) {
    const from = path.join(rootDir, entry.from);
    if (!fs.existsSync(from)) {
      if (!entry.optional) missingRequired.push(entry.from);
      continue;
    }
    jobs.push({ from, to: entry.to, sourceGlob: entry.from });
  }

  for (const glob of manifest.includeGlobs || []) {
    const baseFrom = glob.from.endsWith('/**') ? glob.from.slice(0, -3) : glob.from;
    const fromDir = path.join(rootDir, baseFrom);
    const files = walkFiles(fromDir);
    if (!files.length && !glob.optional) missingRequired.push(glob.from);
    for (const file of files) {
      const relFromRoot = path.relative(rootDir, file).split(path.sep).join('/');
      if (isExcluded(relFromRoot, manifest.excludeGlobs)) continue;
      if (glob.includeBasenames && !glob.includeBasenames.includes(path.basename(file))) continue;
      const relFromBase = path.relative(fromDir, file).split(path.sep).join('/');
      jobs.push({ from: file, to: path.posix.join(glob.toPrefix || '', relFromBase), sourceGlob: glob.from });
    }
  }

  return { jobs, missingRequired };
}

/**
 * Copies manifest-allowlisted files into distRoot, then asserts no other
 * static (non Vite-emitted) files exist and no size budget is exceeded.
 */
export function copyDogManifestAssets(distRoot, manifest) {
  const { jobs, missingRequired } = resolveDogManifestCopyJobs(manifest);
  if (missingRequired.length) {
    throw new Error(
      `[dog-deploy-assets] manifest references missing required paths:\n  - ${missingRequired.join('\n  - ')}`,
    );
  }

  const copied = [];
  for (const job of jobs) {
    const dest = path.join(distRoot, job.to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(job.from, dest);
    copied.push(job.to);
  }
  return copied;
}

/** Vite's own chunk output: flat `assets/<name>-<hash>.<ext>` + root `index.html`. */
function isViteEmittedPath(relPosixPath) {
  if (relPosixPath === 'index.html') return true;
  const parts = relPosixPath.split('/');
  return parts[0] === 'assets'
    && parts.length === 2
    && /-[A-Za-z0-9_-]{6,}\.(js|css|mjs|map|wasm)$/.test(parts[1]);
}

/**
 * Every file under distRoot must be either Vite-emitted (JS/CSS/HTML chunk)
 * or an exact manifest allowlist destination. Anything else means publicDir
 * leaked back on, or a plugin wrote somewhere the manifest doesn't know
 * about — both are the "ships 1 GiB by accident" failure mode this pipeline
 * exists to prevent.
 */
export function findExtraDistFiles(distRoot, manifest) {
  const { jobs } = resolveDogManifestCopyJobs(manifest, ROOT);
  const allowed = new Set(jobs.map((job) => job.to));
  const extras = [];
  for (const filePath of walkFiles(distRoot)) {
    const rel = path.relative(distRoot, filePath).split(path.sep).join('/');
    if (isViteEmittedPath(rel) || allowed.has(rel)) continue;
    extras.push(rel);
  }
  return extras;
}

export function checkDogBundleBudgets(distRoot, manifest) {
  const files = walkFiles(distRoot);
  const budgets = manifest.budgets || {};
  const maxFileBytes = budgets.maxFileBytes ?? CLOUDFLARE_ASSET_MAX_BYTES;

  let totalBytes = 0;
  let largestJsChunk = 0;
  const oversized = [];
  const sized = [];

  for (const filePath of files) {
    const { size } = fs.statSync(filePath);
    totalBytes += size;
    sized.push({ path: path.relative(distRoot, filePath), size });
    if (size > maxFileBytes) oversized.push({ path: path.relative(distRoot, filePath), size });
    if (filePath.endsWith('.js') && size > largestJsChunk) largestJsChunk = size;
  }

  const errors = [];
  if (oversized.length) {
    errors.push(
      `Per-file limit ${formatMiB(maxFileBytes)} exceeded:\n${oversized.map((o) => `  - ${o.path} (${formatMiB(o.size)})`).join('\n')}`,
    );
  }
  if (budgets.maxTotalBytes != null && totalBytes > budgets.maxTotalBytes) {
    errors.push(`Total dist-dog size ${formatMiB(totalBytes)} exceeds budget ${formatMiB(budgets.maxTotalBytes)}.`);
  }
  if (budgets.maxJsChunkBytes != null && largestJsChunk > budgets.maxJsChunkBytes) {
    errors.push(`Largest JS chunk ${formatMiB(largestJsChunk)} exceeds budget ${formatMiB(budgets.maxJsChunkBytes)}.`);
  }

  return { totalBytes, largestJsChunk, sized, errors };
}

/**
 * Module graph fingerprint for verify-dog-bundle.mjs: written from the real
 * Rollup bundle (not text search) so "does App.jsx/GameRuntime.js enter the
 * graph" is an exact answer. Lives outside dist-dog so it never ships.
 */
export const DOG_BUILD_MODULES_META_PATH = path.join(ROOT, '.codex-tmp', 'dog-build-modules.json');

export function dogDeployAssetsPlugin({ manifestPath = MANIFEST_PATH } = {}) {
  let outDir = 'dist-dog';

  return {
    name: 'dreamfall-dog-deploy-assets',
    apply: 'build',
    configResolved(config) {
      outDir = path.isAbsolute(config.build.outDir)
        ? config.build.outDir
        : path.join(config.root || ROOT, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      const moduleIds = new Set();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') {
          for (const id of Object.keys(chunk.modules || {})) moduleIds.add(id);
        }
      }
      const relIds = [...moduleIds]
        .filter((id) => id.startsWith(ROOT))
        .map((id) => path.relative(ROOT, id).split(path.sep).join('/'));
      fs.mkdirSync(path.dirname(DOG_BUILD_MODULES_META_PATH), { recursive: true });
      fs.writeFileSync(DOG_BUILD_MODULES_META_PATH, JSON.stringify(relIds, null, 2));
    },
    closeBundle() {
      // Vite/Rolldown name the emitted HTML file after the source file's own
      // basename (dog.html), not the rollupOptions.input key ("index") — a
      // generateBundle-time bundle-object rename does not survive Vite's own
      // internal HTML write step, so fix it up on disk instead. Cloudflare
      // Workers Static Assets only serves "/" from index.html; the source
      // file stays dog.html for repo clarity.
      const emittedDogHtml = path.join(outDir, 'dog.html');
      const emittedIndexHtml = path.join(outDir, 'index.html');
      if (fs.existsSync(emittedDogHtml) && !fs.existsSync(emittedIndexHtml)) {
        fs.renameSync(emittedDogHtml, emittedIndexHtml);
      }

      const manifest = readDogAssetManifest(manifestPath);
      const copied = copyDogManifestAssets(outDir, manifest);
      if (copied.length) {
        console.log(`[dog-deploy-assets] copied ${copied.length} allowlisted file(s) into ${path.relative(ROOT, outDir)}/`);
      }

      const { totalBytes, largestJsChunk, sized, errors } = checkDogBundleBudgets(outDir, manifest);
      const top10 = [...sized].sort((a, b) => b.size - a.size).slice(0, 10);
      console.log(
        [
          `[dog-deploy-assets] ${path.relative(ROOT, outDir)}/ total ${formatMiB(totalBytes)}, largest JS chunk ${formatMiB(largestJsChunk)}`,
          'Top files:',
          ...top10.map((f) => `  - ${f.path} (${formatMiB(f.size)})`),
        ].join('\n'),
      );

      const extras = findExtraDistFiles(outDir, manifest);
      if (extras.length) {
        errors.push(`Non-allowlisted files present in ${path.relative(ROOT, outDir)}/:\n${extras.map((f) => `  - ${f}`).join('\n')}`);
      }

      if (errors.length) {
        throw new Error(`[dog-deploy-assets] budget/allowlist check failed:\n${errors.join('\n')}`);
      }
    },
  };
}
