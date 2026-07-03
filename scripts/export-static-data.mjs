// Export configured levels from SQLite into dist/data/ for production.
// Run automatically during `npm run build`, or manually:
//   node scripts/export-static-data.mjs

import { exportStaticDataToDist } from '../vite/export-static-data.mjs';

await exportStaticDataToDist();
