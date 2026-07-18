# Vendored: vibe-stack/vibe-human

- Upstream: https://github.com/vibe-stack/vibe-human
- Commit: `6a61d0e770a6fb7039a96b32021cbbb3e5dd18a4` (vendored 2026-07-13)
- License: **MIT (author-confirmed)** — the Dreamfall project owner received
  direct confirmation from the upstream author on 2026-07-13. The vendored
  upstream commit does not contain a LICENSE file, so retain the original
  confirmation with the project's provenance records.

## What is vendored

Framework-free TS only; directory layout mirrors upstream `src/` so relative
imports work unchanged:

- `skinMaterial.ts` — TSL head/body skin + eye materials (WebGPU node materials)
- `characterModeling.ts` — MODELING_CONTROLS slider→morph-target mapping
- `facs.ts` — FACS facial action-unit → morph mapping
- `utils/nanoid.ts`
- `features/clothing/` — garment system core:
  - `geometry/` (bezier, earcut triangulation, pattern sampling, seam utils)
  - `compiler/` (pattern doc → sim mesh, seam/tack constraints, render embedding)
  - `simulation/` (XPBD solver, distance/bend/pin constraints, custom
    triangle BVH avatar collision, self-collision)
  - `avatar-collision/` (collider snapshot from skinned mesh + skeleton)
  - `document/`, `editor/`, `state/` (valtio-vanilla store + actions — no React)
  - `pixi/` (2D pattern editor renderer + tools; framework-agnostic)
  - `demo/createDemoGarment.ts`

## Excluded (rebuild in dreamfall instead)

- All React `.tsx` (UI is rewritten in Solid), incl. `pixi/PatternCanvas.tsx`
- `rendering/useGarmentSimulation.ts` (React hook — its solver/render/collision
  lifecycle is extracted into Dreamfall's framework-free
  `src/game/characters/simhuman/GarmentSimulationRuntime.ts`)
- `features/clothing/cloth/` (legacy cloth stack, unused by the live
  compiler/simulation pipeline)
- `features/groom/` (hair grooming — future milestone)

## Assets

- `public/assets/simhuman/human5.glb` — 20.1 MB, Rigify skeleton (163 DEF-*
  bones), 217 morph targets on the main mesh (FACS + `id.*` modeling), no
  animation clips, no embedded textures, **no named materials** (material
  assignment uses mesh-name/geometry-bounds heuristics from upstream
  HumanModel.tsx). Shipped unoptimized: Draco+prune risk with 217 morph
  accessors outweighs the gain while under the 25 MiB Cloudflare cap.
- `public/assets/simhuman/textures/` — head skin set (colorfinal4k, subdermal,
  epidermal_bad, roughnessv5, specular, wrinklenormalhd, poremap2k, sss, eyes)
  + `body/` set (albedo, epidermal, subdermal, normal) + ao.png.

## Local modifications

(keep this list current; prefer wrapping over editing vendored files)

- `features/clothing/state/clothingStore.ts`: `from 'valtio'` →
  `from 'valtio/vanilla'` (the valtio root entry re-exports React bindings,
  which fails to resolve here since dreamfall has no React).
- `skinMaterial.ts`: added `setSkinTextureBasePath()`; `resolveTextureUrl`
  uses it instead of `import.meta.env.BASE_URL`, and `createEyeMaterial`
  routes through `resolveTextureUrl`. Dreamfall calls
  `setSkinTextureBasePath('/assets/simhuman/')` before creating materials.

## Notes

- Upstream `resolveTextureUrl` passes through absolute URLs, so callers pass
  `/assets/simhuman/textures/...` instead of relying on its relative defaults.
- `state/` uses only `proxy` from valtio (vanilla) — Solid UI subscribes via
  `valtio/vanilla` `subscribe`, no React binding needed.
- New deps added for this vendor: `earcut`, `valtio`, `pixi.js`,
  `pixi-viewport` (+ dev: `tsx`).
- Upstream tests were kept (`node:test`-based). Node can't resolve the
  extensionless TS imports natively, so they run via tsx:
  `npm run verify:simhuman-vendor`.
- Vite transpiles the vendored `.ts` in the app graph; verified additionally
  via a standalone esbuild bundle over the main entry points (skinMaterial,
  compileGarmentRuntime, solver, AvatarCollisionRegistry, clothingActions,
  pixi CanvasController, createDemoGarment).
- The upstream hook's global avatar-collision registry is not used by the Sims
  runtime: each garment owns a separate solver, fixed-step accumulator, posed
  mesh snapshot, and refittable triangle BVH so two avatars remain isolated.
