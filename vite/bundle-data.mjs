import { exportStaticDataToDist } from './export-static-data.mjs';

export async function bundleDataToDist(options = {}) {
  await exportStaticDataToDist(options);
}
