# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An experimental Three.js playground (Vite + Solid + Three r185 WebGPU + Rapier physics), not a finished game. Features are exploratory; some code exists as reference implementations. Deployed as a static site to Cloudflare (wrangler).

## Commands

```sh
npm run dev            # dev server at http://127.0.0.1:5173 (vite --host 127.0.0.1)
npm run build          # vite build → dist/
npm run preview        # build + wrangler dev
npm run visual-smoke   # Playwright desktop+mobile render smoke check (needs dev server running)
```

There is no test framework and no linter. Verification is done through standalone scripts in `scripts/`:

- **`verify-*.mjs`** — regression checks. Many have npm aliases (`npm run verify:fixed-step`, `verify:determinism`, `verify:vehicle-suspension`, `verify:city-styles`, `verify:post-effects`, etc. — see package.json). Run a single one directly: `node scripts/verify-<name>.mjs`.
- **`probe-*.mjs` / `diagnose-*.mjs`** — one-off investigation tools for specific systems.

Two script flavors:
1. **Pure node** — import systems directly (`PhysicsSystem`, `VehicleSystem`, level factories), `await RAPIER.init()`, step the sim, assert. Preferred for physics/logic regressions. Note: some harnesses need `chassisOverlayOptions: null` under node.
2. **Playwright browser** — launch Chromium (with `--enable-unsafe-webgpu`) against the dev server, read the `__DREAMFALL_DEBUG__` snapshot, screenshot into `.codex-tmp/`. Caveat: `page.screenshot()` under WebGPU only captures the load-time scene, not runtime-added objects — verify dynamic behavior via snapshot data, not pixels.

When adding a regression check, follow the existing pattern: a self-documenting `scripts/verify-*.mjs` with a comment header explaining the bug it guards, plus an npm script alias.

## Architecture

### Entry and app shell

`src/main.js` → `src/bootstrap.jsx` (Solid mount) → `src/ui/App.jsx`, which switches between views: the game (`GameCanvas` → `GameRuntime`), the Map Builder (`src/map/MapBuilder.js`), the World Map editor, the Garage, and a CSG cut-test scene. `Ctrl/Cmd+M` toggles game ↔ builder. Dev-only tools are injected via the `virtual:dreamfall-dev-tools` module in `vite.config.js` (inert in production builds).

Three.js is aliased to the **WebGPU build** (`three.webgpu.js`) and TSL in `vite.config.js`. Custom procedural addons (CityGenerator, Skyscraper, Sidewalk, TSL helpers) are vendored in `src/three-addons/` — they track a three.js dev branch, don't replace them with npm imports.

### Game runtime

`src/game/core/GameRuntime.js` is a thin facade over `src/game/runtime/createRuntimeKernel.js`, which constructs ~35 systems (`src/game/systems/`) and drives them via `RuntimeFramePipeline` with **explicit, order-dependent** calls. New systems wire through `createRuntimeServices`, lifecycle/loader, `runtimeFramePlan`, features, and debug command modules — not the facade (`npm run verify:game-runtime-boundary`). Ordering contracts that matter:

- **Fixed 1/60 timestep physics** (`PhysicsSystem`): `beginFrame` plans steps → per-step forces run via `stepHooks` → `stepPlanned` → interpolated visual poses. Rendering is decoupled from step cadence; slow-mo scales sim time, not cadence. Guarded by `npm run verify:fixed-step`.
- **VehicleSystem before MountSystem/MovementSystem** (chassis pose must be current before mounting/movement reads it).
- **Movement pipeline**: `MovementSystem.update()` produces a movement result that each traversal system (ledge hang/traversal, wall run, slide, vault, wall climb, rope, wingsuit, hook swing) may override in sequence; `AnimationStateSystem` consumes the final result. Full-body animation overrides go through the `animationOverride` seam in `AnimationStateSystem`.
- Character ground uses **two layers**: Rapier kinematic character controller vs analytic `getGroundHeightAt` — vehicles are dynamic rigid bodies and only see real physics colliders, so terrain must have a heightfield collider (`level.ensureGroundCollider`) wherever a vehicle goes, even though the character works without one.

### Worlds and levels

Level factories live in `src/game/world/` (`createComposedWorldLevel`, `createStreamingTerrainLevel`, `createGeneratorCityLevel`, `createWildsLevel`, ...). Streaming chunked heightfield terrain samples a continuous procedural function; roads (`createRoadworks`), rivers (`createRiverworks`), and trackside layers are spline-driven overlays that carve/conform terrain. City chunks are built in a Web Worker (`cityChunkWorker.js`); collision layout mirrors the CityGenerator's PRNG draw order exactly — the layout builder must replay `random()` draws in lockstep or roof heights drift. Collider queries go through `ColliderSpatialIndex`. The pure terrain modules in `src/world/terrain/` are importable without Solid/Three renderer for tooling.

### Editors and persistence

Editor data persists to SQLite (`data/dreamfall.db`, gitignored) via a `/api/store` REST middleware (`vite/dreamfall-store-plugin.mjs`) hydrated once at boot into `src/store/fileStore.js`, an in-memory synchronous cache. **Keep store module APIs synchronous** — reads/writes hit the cache; disk persistence is async and debounced. Collections: blueprints, worldmaps, mapbuilder, garage. Blueprints authored in the editor are placed on the 2D world map and spawned at runtime by `createBlueprintEntities`.

### Characters and combat

Character model factories live in `src/game/characters/` (Mara player rig with jacket cloth sim, soldier enemies). Animation packs are FBX under `public/assets/animation-packs/`, retargeted via `npm run retarget:animations`. Player models are selected by source-skeleton profile: `?playerModel=mixamo` or `?playerModel=mesh2motion` (default). Combat cuts use CSG (`applyDirectCut`) with Rapier ragdolls for severed enemies (`EnemyCutSystem`).

### Design docs

`docs/*.md` holds design/plan documents for major systems (some implemented, some planned). Check there before redesigning a subsystem — many pitfalls are already written down.

## Gotchas

- WebGPU has a 16-samplers-per-fragment-stage budget; texture-heavy materials use `DataArrayTexture` layers to stay under it.
- Skinned GLBs with interleaved vertex attributes break under WebGPU (`unorm32x4`) — de-interleave via the existing `flattenObjectForWebGPU` path.
- Headless Chromium throttles to ~30fps — measure performance in a real browser, not through the probe scripts' FPS numbers.
- `matrixAutoUpdate = false` alone is not enough to freeze matrix updates on r185 (scene force-cascade still runs `multiplyMatrices`); the runtime uses an opt-in `matrixWorldAutoUpdate` freeze.
- Assets total ~290 MiB; Cloudflare Pages caps files at 25 MiB — run new large models through `scripts/optimize-models.mjs`.
