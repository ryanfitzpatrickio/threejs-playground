/**
 * Three.js → WebGPU/TSL build aliases shared by the main playground config
 * (vite.config.js) and the standalone dog product config (vite.dog.config.js).
 * Kept in one place so the two configs cannot drift.
 */
import { fileURLToPath } from 'node:url';

const threeModule = fileURLToPath(new URL('../node_modules/three/build/three.webgpu.js', import.meta.url));
const threeTslModule = fileURLToPath(new URL('../node_modules/three/build/three.tsl.js', import.meta.url));

export function createThreeAliases() {
  return [
    { find: /^three$/, replacement: threeModule },
    { find: /^three\/webgpu$/, replacement: threeModule },
    { find: /^three\/tsl$/, replacement: threeTslModule },
  ];
}
