import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEAVES_DIR = path.resolve(__dirname, '..', 'data', 'forest-leaves');
const URL_PREFIX = '/assets/forest-leaves';

function forestLeavesMiddleware(req, res, next) {
  const rel = decodeURIComponent((req.url || '').split('?')[0].replace(/^\//, ''));
  if (!rel || rel.includes('..')) {
    next();
    return;
  }
  const filePath = path.join(LEAVES_DIR, rel);
  if (!filePath.startsWith(LEAVES_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    next();
    return;
  }
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
}

function serveForestLeaves(server) {
  server.middlewares.use(URL_PREFIX, forestLeavesMiddleware);
}

/** Dev/preview static host + production copy for gitignored forest needle PBR. */
export function forestLeavesPlugin() {
  return {
    name: 'dreamfall-forest-leaves',
    configureServer(server) {
      serveForestLeaves(server);
    },
    configurePreviewServer(server) {
      serveForestLeaves(server);
    },
    closeBundle() {
      if (!fs.existsSync(LEAVES_DIR)) return;
      const outDir = path.resolve(process.cwd(), 'dist', 'assets', 'forest-leaves');
      fs.mkdirSync(outDir, { recursive: true });
      for (const name of fs.readdirSync(LEAVES_DIR)) {
        if (!name.endsWith('.png')) continue;
        fs.copyFileSync(path.join(LEAVES_DIR, name), path.join(outDir, name));
      }
    },
  };
}
