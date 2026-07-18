import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';
import { createThreeAliases } from './vite/sharedViteResolve.mjs';
import { shaderDebugPlugin } from './vite/shaderDebugPlugin.mjs';
import { dogDeployAssetsPlugin } from './vite/dogDeployAssetsPlugin.mjs';

// Second product pipeline (docs/dog-park-standalone-deploy-plan.md). Builds a
// standalone dog product into dist-dog/, deployed to the separate Cloudflare
// project "dog-park" via wrangler.dog.jsonc. Never shares dist/ or the main
// index.html/App.jsx module graph with the playground (vite.config.js).
export default defineConfig(({ command }) => ({
  plugins: [
    solidPlugin(),
    // RuntimeLoader.js statically imports virtual:dreamfall-shader-debug. Phase S
    // (studio, DogSimCanvas) never reaches RuntimeLoader, but registering the
    // prod-inert stub unconditionally avoids a Vite resolve break if/when Phase P
    // wires in the GameRuntime `dog-park` levelMode path.
    shaderDebugPlugin(command === 'serve'),
    dogDeployAssetsPlugin(),
  ],
  resolve: {
    alias: createThreeAliases(),
    dedupe: ['three'],
  },
  // Critical: the playground's public/ (~1 GiB of simoutfits/animation-packs/etc.)
  // must never be copied wholesale into the dog product. dogDeployAssetsPlugin
  // copies only the deploy/dog-asset-manifest.json allowlist instead.
  publicDir: false,
  build: {
    outDir: 'dist-dog',
    emptyOutDir: true,
    rollupOptions: {
      // Input key must be `index` so Cloudflare Workers Static Assets serves
      // `/` as index.html (source file stays dog.html for repo clarity).
      input: {
        index: fileURLToPath(new URL('./dog.html', import.meta.url)),
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
  },
}));
