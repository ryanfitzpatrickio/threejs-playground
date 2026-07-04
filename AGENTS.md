# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

Dreamfall is an exploratory Vite browser playground for real-time 3D gameplay, procedural world generation, animation, physics, terrain editing, vehicles, weather, and rendering experiments. It uses JavaScript modules, Solid UI components, Three.js, Rapier, Vite, Playwright, and Cloudflare/Wrangler tooling.

This is an active prototype workspace, not a polished engine. Prefer focused, locally consistent changes over broad refactors.

## Core Commands

- Install dependencies: `npm install`
- Run locally: `npm run dev`
- Build production assets: `npm run build`
- Preview production build: `npm run preview`
- Visual smoke test: `npm run visual-smoke`
- Deploy: `npm run deploy`

Useful targeted checks from `package.json`:

- `npm run verify:fixed-step`
- `npm run verify:determinism`
- `npm run verify:clouds`
- `npm run verify:post-effects`
- `npm run verify:vehicle-spawn`
- `npm run verify:vehicle-suspension`
- `npm run verify:vehicle-damage`
- `npm run verify:road-intersections`
- `npm run verify:world-road`

Run the smallest relevant verification command for the subsystem you changed. Run `npm run build` when changing shared runtime, rendering, imports, asset loading, Vite config, or deployment behavior.

## Repository Map

- `src/main.js`: application entry loader.
- `src/bootstrap.jsx`: Solid app mount.
- `src/ui/`: Solid app shell, HUD, editor, and canvas components.
- `src/game/core/`: runtime orchestration, frame loop, stats, and render-rate limiting.
- `src/game/systems/`: gameplay, rendering, physics, camera, animation, traversal, vehicle, combat, weather, and level systems.
- `src/game/world/`: runtime level, terrain, road, river, city, and collider construction.
- `src/game/characters/`: player and character model factories, animation controllers, cloth setup.
- `src/game/vehicles/`: vehicle logic, garage builds, audio, tire effects, and deformation.
- `src/game/render/`: post effects, shadows, clouds, weather rendering utilities.
- `src/world/terrain/`: reusable chunked heightfield terrain modules.
- `src/world/worldMap/`: world-map schema, road/river profiles, track frames, and scene data.
- `src/map/`: map builder/editor implementation.
- `src/three-addons/`: vendored Three.js-style helpers, nodes, generators, and utilities.
- `public/`: static runtime assets copied into builds.
- `assets-source/`: source assets used to produce runtime assets.
- `scripts/`: conversion, probing, screenshot, smoke, and targeted verification tools.
- `docs/`: plans, analyses, and subsystem notes.
- `data/`: local editor/database output; treat as generated local state.

## Development Practices

- Preserve existing module style and subsystem boundaries.
- Use existing systems and helpers before adding new global state or duplicate utilities.
- Keep runtime systems deterministic where practical. Be careful with time-step, physics, and animation changes.
- Dispose Three.js resources when replacing meshes, geometries, materials, textures, render targets, or scene-owned objects.
- Avoid blocking the frame loop with expensive generation. Use existing workers, chunking, caches, and probe scripts as examples.
- Treat asset paths in `public/assets` as runtime contracts; check all callers before renaming or moving files.
- Do not commit generated local state from `data/`, `.wrangler/`, `.codex-tmp/`, `dist/`, or editor caches.
- Avoid broad formatting-only edits in large files.

## Frontend and Rendering Notes

- The first screen is the usable playground/editor experience, not a landing page.
- Match the existing dense tool UI style for editor and debug surfaces.
- Verify 3D/rendering changes visually with `npm run visual-smoke` or a targeted Playwright/probe script when possible.
- For canvas or WebGPU/WebGL changes, check both desktop and mobile-sized viewports when the UI surface is affected.

## Asset and Tooling Notes

- Prefer scripted asset transformations in `scripts/` over manual one-off edits when producing GLB/FBX/texture outputs.
- Large runtime assets can affect Cloudflare Pages limits and load time. Consider compression, on-demand loading, or keeping source-only artifacts under `assets-source/`.
- Python scripts are present for some asset workflows, but the main app and verification tooling are Node/Vite based.
- Vite config includes custom development tooling and static data handling. Review `vite.config.js` before changing dev-server or build behavior.

## Agent Workflow

1. Inspect the relevant subsystem and nearby verification scripts before editing.
2. Check working tree state and avoid overwriting unrelated user changes.
3. Make the smallest coherent change.
4. Run targeted verification, or record why it was skipped.
5. Summarize changed files, verification results, and residual risk.

