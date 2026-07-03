# Dreamfall

Browser-first Dreamfall prototype scaffold using Vite, Solid, and Three.js.

## Current Slice

- Open salt-plane base level.
- FBX climber model loaded from `public/assets/models/climber.fbx`.
- New Mixamo pack zips extracted into `public/assets/animation-packs/`.
- Basic locomotion states use targeted clips from `locomotion-pack-2` and `magic-locomotion-pack`.
- Curated animation manifest wired into the runtime state machine, with a procedural fallback model if FBX loading fails.
- Runtime-owned animation state that starts only after the base level is loaded.
- Keyboard movement, brace, and jump states wired through game systems.
- Great-sword combat: draw/sheathe, armed locomotion, light/heavy attacks + combo, and swing-driven CSG cuts on contact.
- Sparse Solid HUD fed by runtime snapshots.
- Playwright visual smoke check for desktop and mobile rendering.

## Commands

```sh
npm install
npm run dev
npm run build
npm run visual-smoke
```

The dev server defaults to `http://127.0.0.1:5173/`.

## Controls

- `WASD` / arrow keys: move.
- `Shift`: brace.
- `Space`: jump.
- `Q`: draw / sheathe the great sword (enters/exits armed locomotion).
- Mouse left: light attack (chains a 3-hit combo).
- Mouse right: heavy attack (finisher — bisects on contact).
- `V` (hold): legacy manual aim-and-slice cut mode (debug).

## Structure

- `src/main.js`: loader only.
- `src/bootstrap.jsx`: Solid mount.
- `src/ui/`: Solid canvas and HUD components.
- `src/game/core/`: runtime and frame loop.
- `src/game/systems/`: renderer, scene, camera, level, character, input, movement, animation state.
- `src/game/world/`: base level construction.
- `src/game/characters/`: character model factories.
- `src/world/terrain/`: reusable chunked heightfield terrain (Procedural, TerrainChunk, ChunkManager).
- `src/map/MapBuilder.js`: the modular map builder (separate "page" in the app).

## Map Builder (separate page)

Press the **Map Builder** button in the floating mode switcher (top center) or hit `Ctrl/Cmd + M` / `?` to switch from the game view.

- **Sculpting**: Left-click + drag on terrain in Sculpt mode. Brush modes: raise, lower, smooth, flatten, noise, set.
- **Navigation**: Alt / right-drag / middle-drag to orbit or pan. Scroll wheel to zoom. Double-click terrain to focus.
- **Hotkeys** (while builder is active): `[ ]` brush size, `B` toggle sculpt/view, `Ctrl/Cmd+Z` undo, `Shift+Ctrl+Z` redo, `Shift+R` reset visible edges to procedural.
- **Seams & infinity**: Chunks are always initialized from a continuous world-space procedural sampler. Editing maintains exact edge matching between loaded neighbors. Use "Reset Edges" to force perimeter verts back to pure procedural values so the authored region continues seamlessly into "procedural infinity".
- **Scope**: Brush normally affects everything under the cursor. Use chunk selection + "Confine to selection" to limit deformation to specific authored chunks.
- **Persistence**: Autosaves to localStorage. Explicit Save / Load Project buttons produce portable `.json`.
- **Exports**:
  - **Export Runtime JSON**: Clean height data + generator params. Designed to be loaded by a future `ChunkManager` + `createTerrainChunkMesh` at game runtime (or baked into `createBaseLevel`).
  - **Export GLB (visible / authored)**: Produces a single binary GLB with layered structure per chunk:
    - `DreamfallTerrain_v1 / chunk_CX_CZ / visual` (sculpted mesh)
    - `... / collision` (matching geometry, ready for trimesh or later decimation)
    - `... / metadata` (Object3D carrying `userData.heights` + resolution for round-tripping)

Switch back to **Play** at any time — the original game runtime and level are untouched.

The terrain modules under `src/world/terrain/` are intentionally pure and importable without the builder or any Solid/Three renderer, for future game integration or tooling.

## Publishing (Cloudflare Pages)

The project is a static Vite + Solid app. Production build outputs to `dist/`.

### Preparation (already applied)
- Switched `three` to the published `^0.184.0` package.
- Vendored the custom CityGenerator / Skyscraper / Sidewalk procedural addons (from the dev three checkout) into `src/three-addons/`.
- `npm run build` produces a working static bundle.

### Cloudflare Pages setup

1. Push to GitHub (main branch).
2. In Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Select this repo.
4. Build settings:
   - **Build command**: `npm ci && npm run build`
   - **Build output directory**: `dist`
   - (No root directory override needed)
5. Save and Deploy.

The site will be available at `your-project.pages.dev`.

### Important limits (as of 2026)
- 20,000 files max (Free) / 100k (paid)
- **25 MiB max per file**

All model assets are now well under the 25 MiB limit after optimization (largest ~3.9 MB). See `scripts/optimize-models.mjs` + Blender conversion for the process.

**Current deploy will fail** on file size until the large models are addressed:
- Compress / re-export the GLBs/FBXs with Draco / Meshopt / quantization.
- Or move the heaviest binaries to Cloudflare R2 and load them by absolute URL at runtime.
- Or reduce poly counts / remove unused animation data.

Total asset size is ~290 MiB (mostly animation FBX + a few big models). First-time loads will be heavy; consider progressive / on-demand loading for animations.

### Quick direct deploy (no Git)
```sh
npm ci
npm run build
npx wrangler pages deploy dist --project-name=dreamfall
```

(Install wrangler globally or use npx. First time prompts for login + project creation.)

### Other notes
- No server functions needed (pure client + Web Workers for city chunks).
- The `cityChunkWorker` and GLTFExporter chunks are correctly emitted.
- `public/` assets (models, animation packs) are copied verbatim.
- Dev-only Codex bridge in `vite.config.js` is inert during `vite build`.
- Update the title/description in `index.html` before going public.
- Consider adding `public/_headers` for long-term caching of hashed assets.

After first successful deploy you can attach a custom domain in the dashboard.

## License

MIT — see [LICENSE](LICENSE).

## Development Notes

- Editor data (`data/dreamfall.db`, autosaves, your maps) lives in `data/` and is gitignored.
- The repository contains a large number of animation and model assets. Initial clone may take a while.
- Many diagnostic scripts live under `scripts/`. Most are for development/debugging specific systems.
