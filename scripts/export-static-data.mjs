// Export configured levels + all catalog gunsmith profiles into dist/data/.
// Invoked automatically by `npm run build` (after vite) and also via the
// dreamfall-store Vite closeBundle hook. Safe to re-run:
//   npm run export:static-data

import { exportStaticDataToDist } from '../vite/export-static-data.mjs';

const result = await exportStaticDataToDist();
const gunCount = result.gunsmith?.length ?? 0;
console.info(`[export:static-data] done — ${gunCount} gunsmith profile(s) in dist/data/gunsmith/`);
