# Three.js Playground

An experimental browser playground for building and testing real-time 3D ideas with Three.js. It combines small game prototypes, procedural world generation, animation, physics, terrain editing, and rendering experiments in one Vite-powered workspace.

This repository is intentionally exploratory rather than a finished game or reusable engine. Features may be incomplete, replaced, or kept as reference implementations while new ideas are tested.

## What’s in the Playground

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
npm run pull:forest-textures   # forest zone bark + needle PBR from SeedThree (required after clone)
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

Switch back to **Play** at any time — the playground runtime and level are untouched.

The terrain modules under `src/world/terrain/` are intentionally pure and importable without the builder or any Solid/Three renderer, for future game integration or tooling.

## Publishing (Cloudflare Pages)

The project is a static Vite + Solid app. Production build outputs to `dist/`.

### Preparation (already applied)
- Switched `three` to the published `^0.185.0` package.
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

## References & Credits

Several core effects are ports or direct adaptations of techniques from open Three.js experiments (ported to TSL + WebGPU where needed). Third-party libraries, vendored addons, and asset sources are listed below under their original permissive licenses or terms of use.

### Core Libraries (npm)

| Project | Role in Dreamfall |
|--------|-------------------|
| [Three.js](https://github.com/mrdoob/three.js) | WebGPU renderer, TSL, glTF loading, animation, math |
| [Solid.js](https://github.com/solidjs/solid) | UI shell, HUD, settings, editor controls |
| [Vite](https://github.com/vitejs/vite) | Dev server and production bundling |
| [@dimforge/rapier3d-compat](https://github.com/dimforge/rapier) | Vehicle, character, terrain, and prop physics |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | Accelerated raycasts and level geometry indexing |
| [three-simplecloth](https://www.npmjs.com/package/three-simplecloth) | Player jacket cloth simulation on WebGPU |
| [@gltf-transform](https://github.com/donmccurdy/glTF-Transform) + [Draco](https://github.com/google/draco) | Asset verification, compression, and pipeline tooling |
| [Playwright](https://github.com/microsoft/playwright) | Visual smoke and headless verification scripts |

Additional Three.js helpers are vendored under `src/three-addons/` when the pinned release predates a needed node or generator (LightProbeGrid, SSAO, Dual Kawase bloom, LoftGeometry, etc.).

### Rain, Wetness, Lightning, and Puddles

- Rain streaks, animated ripple normals for standing water, water beading/droplets, lightning strikes + scheduling, and flash compositing: [achrefelouafi/RainSystemThreeJS](https://github.com/achrefelouafi/RainSystemThreeJS)
  - `src/game/render/createRainEffect.js` (streaks)
  - `src/game/render/createLightningBolt.js`
  - `src/game/systems/WeatherSystem.js`
  - `src/game/materials/wetSurfaceNodes.js`, `createTerrainBiomeMaterial.js`, vehicle wet overlays, and CityGenerator road material

### Parallax & Surface Detail

- Parallax Occlusion Mapping (POM) with silhouette clipping and curved horizons: [SkyeShark/threejs-silhouette-pom](https://github.com/SkyeShark/threejs-silhouette-pom) (vendored at `src/three-addons/tsl/utils/ParallaxOcclusion.js`)
- Hex-tiling noise reduction for rally mud/terrain textures: Mikkelsen's hex-tile demo ([mmikk/hextile-demo](https://github.com/mmikk/hextile-demo)) — TSL port in `src/game/materials/hexTilingNodes.js`

### Procedural City

- City block / skyscraper / sidewalk / street-furniture generators: vendored from the three.js dev branch / [PR #33906](https://github.com/mrdoob/three.js/pull/33906) into `src/three-addons/generators/`

### Volumetric Sky, Clouds, and Atmosphere

- LUT atmosphere, volumetric cloud march, temporal reprojection, cloud shadows, and god rays: ported from an analyzed production WebGPU sky reference (reverse-engineering notes in [`volumetric-sky-cloud-analysis.md`](volumetric-sky-cloud-analysis.md))
  - `src/game/render/cloud/` (`CloudSkyProvider`, `CloudMarchNode`, `AtmosphereLUTNode`, etc.)
  - `src/game/systems/SkySystem.js`

### Forest & Vegetation

- **Procedural trees ([SeedThree](https://github.com/SkyeShark/SeedThree)):** generator modules vendored from [SkyeShark/SeedThree](https://github.com/SkyeShark/SeedThree) (MIT) into `src/game/world/forest/seedthree/` — Weber–Penn skeleton, branch meshing, leaf cards, impostors, wind, and the original pine / Douglas fir / loblolly species presets. Dreamfall wraps these in `src/game/world/forest/` for zone placement, LOD rebinning, instancing, and colliders.
  - Live reference app: [skyeshark.github.io/SeedThree](https://skyeshark.github.io/SeedThree/)
  - Forest zone runtime: `createForestZone.js`, `forestTreeBuilder.js`, `forestLod.js`, `forestSpecies.js`
- **Forest PBR textures:** bark under `public/assets/textures/forest/{species}/` (base pine, Douglas fir, loblolly tracked in git). Needle PBR for all catalog species lives in gitignored `data/forest-leaves/` — run `npm run pull:forest-textures` after clone. Leaves are served at `/assets/forest-leaves/` via the Vite plugin and copied into `dist/` on build. Sources are pulled from [SeedThree](https://github.com/SkyeShark/SeedThree) with per-species tweaks in `forestSpeciesTextures.js`.
- Parametric tree skeleton follows the **Weber–Penn** paper ([PDF](https://courses.cs.duke.edu/fall02/cps124/resources/p119-weber.pdf)) — `seedthree/weber-penn.js`
- Leaf-card placement also follows Blender Sapling / [dgreenheck/ez-tree](https://github.com/dgreenheck/ez-tree) conventions (also cited by SeedThree)
- Backlit foliage translucency: Barré–Brisebois subsurface-scattering approach (Unreal Two-Sided Foliage family) in `seedthree/leaf-cards.js` and `seedthree/impostor.js`

### Crowds & Spectators

- Rally sideline flipbook crowd (baked pose instancing, unlit texture path): adapted from an earlier in-house **3js-rocks** crowd prototype; runtime in `src/game/world/spectatorCrowd.js`, asset build in `scripts/build-crowd-glb.py`
- Ambient city sidewalk crowd (soldier bake + instancing): `src/game/systems/CrowdSystem.js`
- Spectator base mesh + Mixamo-style gesture clips under `assets-source/models/crowd/` and `assets-source/animations/crowd-gestures/`

### Office Interiors

- Socket-based Wave Function Collapse solver: vendored from SkyeShark's **level-maker** workspace into `src/game/world/office/wfc/` (same author as the POM repo above); algorithm family from [mxgmn/WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse)

### Characters, Animation, and Models

- Default player mesh: Mixamo-compatible T-pose body (`player-tpose.glb`) driven by Mixamo packs under `public/assets/animation-packs/` (`?playerModel=player`)
- Previous Mara/climber body kept for A/B: `climber.glb` (`?playerModel=climber` or `?playerModel=mixamo`)
- Alternate skeleton route: [Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app) (`playernew-mesh2motion.glb`, `?playerModel=mesh2motion`); assets CC0 per Mesh2Motion
- Several character and vehicle meshes (climber, soldier, crowd base, overlays): [Tripo](https://www.tripo3d.ai/) exports retargeted onto Mixamo-compatible armatures

### Audio

- **Engine audio (RPM + load layered simulation)**: modeled on [markeasting/engine-audio](https://github.com/markeasting/engine-audio) (MIT © 2025 Mark Oosting). Uses on-load / off-load loop layers at multiple RPM ranges, crossfading by RPM and throttle, pitch detuning, limiter, and transmission whine. The "BAC Mono" profile matches the reference's `bac_mono` configuration (samples under `public/assets/audio/engine/`). See `EngineAudio.js` and `engineProfiles.js`. Boxer profile is a local extension with one-shot accents.
- Rain ambience, thunder, tire gravel/mud layers, stone pings, and screech synthesis: original procedural generation via the Web Audio API (filtered white noise, bandpass/lowpass layers, envelope sweeps). See `WeatherSystem.js` (RainAmbienceAudio, ThunderAudio) and `TireEffects.js` (TireScreechAudioSystem + procedural layers).
- Other sampled clips (tire turn/brake, crashes, cabin rain on glass, exterior idle): custom assets under `public/assets/audio/`.
- **First-person weapon SFX (planned)**: [Snake's Authentic Gun Sounds](https://f8studios.itch.io/snakes-authentic-gun-sounds) by [SnakeF8 / F8 Studios](https://f8studios.itch.io) — studio-recorded gunshots (incl. 5.56 / 7.62 variants), reloads, bolt/pump cycling, and related weapon handling. Free pack; commercial use allowed; credit not required but appreciated. Not wired into the runtime yet (temporary Web Audio clicks in `WeaponSystem`); samples will live under `public/assets/audio/guns/` when integrated. Related sequel pack (9mm / .308 / shotgun): [Snake's Second Authentic Gun Sounds Pack](https://f8studios.itch.io/snakes-second-authentic-gun-sounds-pack).

### Other / Planned

- Additional reverse-engineering and research notes at repo root: [`volumetric-sky-cloud-analysis.md`](volumetric-sky-cloud-analysis.md), [`ragdoll_research.md`](ragdoll_research.md), [`multiplayer_pain_points.md`](multiplayer_pain_points.md).

## Development Notes

- Player models are selected by source-skeleton profile. The default is `mesh2motion`; use `?playerModel=mixamo` or `?playerModel=mesh2motion` to test either rig and its compatible animation routes.
- Use the in-game **Cloth** button to fit bone-attached collider spheres against the live jacket simulation. Profiles autosave per player model and can be imported/exported as JSON.
- Jacket setup uses two independent weight systems. Mesh2Motion skeletal weights are transferred automatically from the fitted jacket to the nearest player-body triangles; `clothWeight` uses `0` for simulated vertices and `1` for vertices pinned to skinning. The runtime generates a bone-aware mask when that attribute is absent.
- Editor data (`data/dreamfall.db`, autosaves, your maps) lives in `data/` and is gitignored.
- The repository contains a large number of animation and model assets. Initial clone may take a while.
- Many diagnostic scripts live under `scripts/`. Most are for development/debugging specific systems.
