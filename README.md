# Dreamfall

An experimental **browser 3D playground** (Vite + Solid + **Three.js r185 WebGPU/TSL** + **Rapier**) for real-time gameplay, procedural worlds, vehicles, combat, animation, and rendering experiments.

This is a **prototype workspace**, not a finished game or drop-in engine. Systems are often complete enough to study, partial, or kept as reference while new ideas are tried. Prefer the scene sections below when looking for a technique to port elsewhere.

| | |
|---|---|
| **Run** | `npm install` → `npm run pull:forest-textures` (once after clone) → `npm run dev` → [http://127.0.0.1:5173](http://127.0.0.1:5173) |
| **Build / smoke** | `npm run build` · `npm run visual-smoke` |
| **Stack** | Three WebGPU + TSL · Rapier · Solid UI · Vite · Cloudflare Pages deploy |
| **Docs** | Deep plans live in [`docs/`](docs/) — this README stays high-level |

---

## Scenes & techniques

Each main-menu experience (and a few tools / modes) is listed with **gameplay ideas** and **graphics ideas**, named features to search for, and **how to research or rebuild the idea in another project**. Details are intentionally approximate—use names as search keys into `src/` and `docs/`.

Shared stack used by most playable modes: fixed-step **PhysicsSystem**, **MovementSystem** + traversal chain, **VehicleSystem**, **WeatherSystem** / **SkySystem**, post stack (SSAO / SSR / bloom / god rays), quality presets.

---

### City — infinite freerun

**What you play:** Endless generated city blocks — streets, rooftops, parkour, grapple, wingsuit, offices, vehicles.

**Level:** `createInfiniteCityLevel` / `createGeneratorCityLevel` · worker `cityChunkWorker.js`  
**Docs:** city performance plans, `hook-swing-system-plan.md`, `wingsuit-plan.md`, `office-interior-wfc-plan.md`

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Chunk-streamed procedural city** | Generate blocks on a grid with a seeded PRNG. Stream skeleton placeholders, then full chunks under a per-frame budget. Keep **collision layout PRNG draws in lockstep** with render so roof heights never drift. |
| **Collider spatial index** | Broadphase queries over many building colliders without scanning the whole city each frame. |
| **Parkour surface extraction** | Derive ledges, wall-run strips, climb faces, and rope anchors from building geometry once per chunk—not from raw mesh every jump. |
| **Traversal stack** | Ordered modes (wall run, climb, ledge hang, vault, slide, rope) each may override the movement result after a base character controller. |
| **Hook / multi-tether swing** | Raycast façades for anchors; momentum swing with re-hook midair (Spider-Man–style research: swing graphs, rope constraint, camera lag). |
| **Wingsuit** | Deploy midair; trade altitude for speed; separate cloth/membrane presentation from flight model. |
| **Enterable interiors (WFC offices)** | Door prompt → teleport into a below-map or cached interior; Wave Function Collapse for layout; keep exterior streaming independent. |
| **Vehicles + mount** | Drive city roads; seat enter/exit then resume freerun. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Procedural skyscraper / sidewalk generators** | Rule-based massing + window grids (Three CityGenerator family). |
| **Wet road / weather-driven materials** | Shared rain wetness uniforms on asphalt materials. |
| **Furniture / prop batching** | Instanced street props; watch **WebGPU sampler limits** (array textures help). |
| **Far skyline LODs** | Cheap lit boxes / window strips for unloaded distance. |
| **Volumetric sky + post** | Atmosphere LUT / clouds when quality allows; SSAO/SSR/bloom gated by preset. |

**Keywords:** procedural city · chunk streaming · PRNG lockstep · parkour extraction · grapple · WFC interiors · wet roads  

---

### World — streaming open world map

**What you play:** Drive and freerun on **streaming heightfield terrain** built from the World Map editor (roads, rivers, forests, optional city zones).

**Level:** `createStreamingTerrainLevel` / `createComposedWorldLevel`  
**Docs:** `terrain-infinite-distance-plan.md`, `hextile-terrain-texture-plan.md`, `forest-zone-plan.md`, road/river plans

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Infinite heightfield streaming** | Continuous procedural height + authored overlays; load/unload chunks; **heightfield colliders** where vehicles go (characters can often use analytic height alone). |
| **Spline road / river corridors** | Flatten or carve terrain along polylines; tunnels, bridges, surface classes (dirt/mud/asphalt). |
| **Composed systems** | One world query API over terrain + city zones + blueprints—don’t run separate disconnected ground samples. |
| **Blueprint entities** | Editor-placed prefabs (props, spawners) hydrate at runtime from store data. |
| **Forest zones** | Polygon masks for instanced trees, trunk colliders, litter. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Biome terrain shading** | Height/slope blends (sand → grass → rock → snow); world-XZ UVs. |
| **Hex-tiling terrain textures** | Mikkelsen-style hex tile blend to hide repetition (`hexTilingNodes`). |
| **Horizon / parallax / distant forest** | Fake infinite distance with layers instead of full geometry. |
| **Mud / dirt road deformation** | GPU deform field driven by tires/feet (shared idea with Rally). |
| **Trackside cross-sections** | Extrude curb/fence/prop bands along road frames. |

**Keywords:** chunked heightfield · spline corridors · biome blend · hex tile · zone forests · blueprints  

---

### Rally — Pine Ridge dirt stage

**What you play:** Timed dirt stage loop with **loose-surface driving**, rain-wet roads, mud ruts, spectators.

**Level:** streaming terrain + built-in rally world map · **mode** `RallyModeController`  
**Docs:** `rally-dirt-road-plan.md`, `rally-mud-tread-plan.md`, `advanced-wet-roads-plan.md`, `spectator-crowd-system-plan.md`, `driving-camera-redesign-plan.md`

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Surface-dependent grip** | Sample road surface class under each tire; scale friction / slip (gravel vs mud vs wet). |
| **Rally vehicle builds** | Garage presets (chassis, tires, tune) as data, not hard-coded per car mesh. |
| **Mud physics ↔ VFX field** | One deform map feeds sink depth, wetness, tread—and visual ruts. |
| **Chase / comfort camera** | Speed-scaled lag, steer offset, FOV pump (GTA/Forza-style chase research). |
| **Stage cross-sections** | Track style (stage vs spectator) swaps ropes, marshals, barriers along the same centerline. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Wet road PBR (TSL)** | Rain + persistent wetness; puddles, graze-angle gloss, optional env reflections on standing water. |
| **Hex-tiled dirt/mud atlases** | Same hex path as terrain; mud brown base + rut darkening. |
| **Tire spray / dust** | Layered particle/instanced VFX driven by slip and surface. |
| **Spectator crowds** | Baked pose flipbooks or instanced characters reacting to the car. |
| **Engine / tire audio** | RPM+load layered loops; gravel/mud tire layers. |

**Keywords:** dirt rally · multi-surface tires · mud GPU field · wet-road TSL · chase camera · trackside dressing  

---

### Wilds — alpine valley & forest

**What you play:** Finite eroded valley with **dense instanced trees**—exploration sandbox, lighter systems than City.

**Level:** `createWildsLevel`  
**Docs:** `wilds-nature-system-plan.md`, forest LOD notes

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Single heightfield sandbox** | One generator grid → one Rapier heightfield; simpler than infinite streaming. |
| **Character exploration** | Standard freerun movement without full city parkour extraction. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Procedural terrain generator materials** | Low-texture or zero-texture TSL looks to save sampler budget under shadow maps. |
| **Mega tree instancing** | Huge `InstancedMesh` forest with distance cull; **exclude trees from expensive BVH raycasts**. |
| **Forest LOD / impostors** (shared forest stack) | Weber–Penn skeletons, leaf cards, billboard impostors (SeedThree lineage). |

**Keywords:** procedural valley · mass instancing · heightfield · foliage LOD  

---

### Shooting Range — warehouse breach

**What you play:** Timed (~60s) **first-person** warehouse course—tag hostiles, spare friendlies.

**Level:** `createShootingRangeLevel` · **mode** `RangeModeController`  
**Docs:** `first-person-weapon-system-plan.md`, `powerful-shooting-feedback-plan.md`, `advanced-reload-system-plan.md`

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Scenario scoring** | Timed run with friend/foe tags and spawn script. |
| **First-person weapons** | Hitscan or projectile; ADS FOV; recoil; ammo; weapon switch; hand/body IK. |
| **Presentation vs damage** | Separate tracers, muzzle flash, shells, audio from pure hit math. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Indoor-ish PBR set** | Brick/wood/concrete atlases; hex-tile large floors. |
| **God rays** | Post volumetric shafts from a sun direction through window bands. |
| **Tight shadow volume** | Shadow camera fitted to arena size for sharper local shadows. |

**Keywords:** FPS range · hitscan · ADS/IK · god rays · scenario AI targets  

---

### Horde — robot wave arena

**What you play:** Mall → shipping → train yard **wave defense**—melee CSG cuts, guns, set pieces.

**Level:** `createHordeModeLevel` · **feature** `HordeRuntimeFeature`  
**Docs:** `horde-mode-plan.md`, `horde-flow-mob-plan.md`, `enemy-sword-csg-cut-plan.md`, `horde-gi-plan.md`, propane/aquarium plans

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Wave spawn + population caps** | Gate spawns; hard limits on live enemies and corpses. |
| **Flow-field / flock AI** | Coarse navigation field + local steering/separation (crowd sim research). |
| **Far enemy proxies** | Impostors or cheap LODs outside combat radius. |
| **Sword CSG limb cuts + ragdoll** | Clip skinned mesh on hit; partial bodies + Rapier ragdolls for severed parts. |
| **Hybrid melee + firearms** | One enemy record accepts blade cuts and bullets. |
| **Destructible set pieces** | Propane tanks, aquarium breach—scripted damage volumes + VFX. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Large static merge + instancing** | Bake arena shells; instance props/furniture. |
| **Local GI probes** | LightProbeGrid-style bounce for atriums without path tracing. |
| **Specialty TSL materials** | Water, glass, emissive storefronts budgeted per arena. |

**Keywords:** wave combat · flow fields · CSG skinned cuts · proxies · probe GI  

---

### Household (Sims) — residential lot

**What you play:** Point-and-click **Sims-like** lot—select agents, click-to-move; main freerun avatar is parked.

**Level:** `createSimLotLevel` · **feature** `SimsRuntimeFeature`  
**Docs:** `sims-scene-plan.md`, `psx-household-assets.md`, garment/creator plans

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **RTS / click-to-move agents** | Hide the FPS/TPP hero; independent actors with pick + path/steer on a flat lot. |
| **Avatar / outfit pipeline** | Presets for body, face, garments as versioned data. |
| **Authored garment cloth** | Pattern → XPBD cloth sim (visual soft body, not full physics engine cloth). |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **TSL skin shading** | Subsurface-style skin materials on humanoid rigs. |
| **Hex-tiled lawn / path PBR** | Shared outdoor surface language with Dog Park / Rally. |
| **PSX household props** | Low-poly furniture packs for dressing prototypes. |
| **Pattern editor + 3D preview** | 2D sewing view beside live 3D human. |

**Keywords:** Sims control · XPBD cloth · character creator · lot prototype  

---

### Dog Park — procedural dog playground

**What you play:** Control a **procedural dog** in a finite lakeside park (breeds, mud, splash, freecam).

**Level:** `createDogParkLevel` · **feature** `DogParkRuntimeFeature`  
**Studio:** Dog Studio (`?view=dog-sim`) for breed gallery  
**Docs:** `dog-park-scene-plan.md`, `dog-breed-variants-plan.md`

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Procedural creature as player** | Phenotype from breed/family/seed; kinematic controller owns world root motion. |
| **Clip-driven gait + soft steer** | Offline retarget (e.g. horse→dog); controller aims body gently; clips drive local bones. |
| **Surface-tagged park** | Grass / dirt / sand / mud zones + agility props under one collider API. |
| **One-shot actions** | Jump/bark/flop clips with hold frames and recover blends. |
| **Mud interaction** | Foot stamps + body flop deform field + coat dirtiness. |
| **Dog chase camera / photo mode** | Close third-person with turn push/pull; freecam (K) without fighting chase cam. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Shell fur / coat fields** | Layered shell meshes + zone length masks (face short, ruff long). |
| **Shared water + forest** | Same water material / SeedThree forest as open world, park-scale. |
| **Scene surface PBR + hex tile** | `createSceneSurfaceMaterial` for lawn/paths/props. |
| **Deformable mud wallows** | Same GPU mud field idea as Rally, footprint-first. |

**Keywords:** procedural animal · retargeted gait · surface materials · mud coat · creature camera  

---

### Deathmatch — Rail Crucible arena

**What you play:** Vertical **arena FPS** layout (solo preview; multiplayer WIP).

**Level:** `createDeathmatchArenaLevel` from pure map data `railCrucibleMap.js`  
**Docs:** `multiplayer-deathmatch-partykit-plan.md`

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Pure map descriptor** | One data table for volumes/spawns/pickups builds client meshes **and** can validate server hits. |
| **Arena loop** | Vertical tiers, ramps, weapon/ammo/health pickups (Quake/Unreal arena research). |
| **Net authority (planned)** | Server health/hits; client predict move; cosmetic ragdolls local-only. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Shared industrial PBR language** | Reuse range/horde materials with distinct layout. |
| **Readable vertical bands** | Landmark color/lighting per tier so routes read at a glance. |

**Keywords:** arena FPS · pure map data · pickups · authoritative multiplayer  

---

### Highway — Matrix freeway chase *(level mode; boot with `?level=highway`)*

**What you play:** Infinite **highway ribbon**—traffic, roof-surf, car leaps, combat on moving beds.

**Level:** `createMatrixHighwayLevel` · **mode** `HighwayModeController`  
**Docs:** `matrix-highway-scene-plan.md`, `matrix-highway-optimization-plan.md`

#### Gameplay techniques

| Feature | Idea to research / replicate |
|---|---|
| **Infinite road recenter** | Visual wrap of segments + move a fixed physics slab so the player never reaches “end of world.” |
| **Pooled traffic convoy** | Object-pool cars at flow speed; relative-velocity combat fantasy. |
| **Roof-surf while steering** | Exterior stance that still drives the vehicle. |
| **Car leap / hijack** | Inherit platform velocity; dedicated leap actions (Just Cause / Mad Max research). |
| **Combat on moving platforms** | Trailers as tiny arenas; ragdolls keep vehicle velocity. |

#### Visual / graphics techniques

| Feature | Idea to research / replicate |
|---|---|
| **Batched road instancing** | Few instanced road batches instead of hundreds of meshes. |
| **Fog to hide recycle edge** | Distance fog/atmosphere masks the seam. |
| **Traffic car presentation** | LODs / shared materials for dense traffic. |

**Keywords:** infinite highway · pooling · moving platforms · roof surf · velocity inheritance  

---

### Editors & tool scenes

#### World Map editor

**Techniques:** Schema-driven **roads / rivers / zones / blueprints** (`worldMapSchema`); 2D authoring with **3D playable preview** via the same level factory as World mode. Research: content pipeline where editor and runtime share one contract.

#### Map Builder (terrain sculpt)

**Techniques:** Chunked height **sculpt** on a continuous procedural base; seam-safe neighbors; export runtime JSON / GLB. Research: “procedural infinity + local paint” terrain editors.

#### Garage & Bodyshop

**Techniques:** Vehicle **builds as data** (chassis, tires, engines); Bodyshop classifies mesh parts for glass/lights; optional LightProbeGrid preview. Research: separate content tools from the driving sim.

#### Dog Studio / Sim Creator / Gunsmith / PSX viewer

**Techniques:** Isolated **product viewers** (breed gallery, human+garment authoring, gun annotation, prop browser) without loading full combat worlds. Research: tool views vs level modes.

#### Cut Test / robot viewers

**Techniques:** Isolated CSG cut and asset harnesses for iteration without Horde load times.

---

## Cross-cutting systems (reuse map)

| Domain | Look for | Appears in |
|---|---|---|
| Fixed-step physics | `PhysicsSystem` 1/60, step hooks | vehicles, mud, ragdolls, highway |
| Freerun character | `MovementSystem` + traversal systems | City, World, partial elsewhere |
| Vehicles | `VehicleSystem`, garage builds, damage/suspension | City, World, Rally, Highway |
| FPS / combat | `WeaponSystem`, `FirstPersonWeaponSystem`, `CombatSystem`, `EnemyCutSystem` | Range, Horde, Deathmatch, Highway |
| Weather / sky | `WeatherSystem`, `SkySystem`, volumetric `cloud/*` | open outdoor modes, Rally rain |
| Post FX | SSAO, SSR, Dual Kawase bloom, god rays | quality tiers; Range god rays |
| Determinism | seeded PRNG, pure level factories | City workers, maps, Horde waves |
| Surface PBR + hex | `createRallySurfaceMaterial`, `createSceneSurfaceMaterial`, `hexTilingNodes` | Rally, World, Range floors, Dog Park, Sims lot |

---

## Quick start & structure

```sh
npm install
npm run pull:forest-textures   # bark + needle PBR for forests (after clone)
npm run dev                    # http://127.0.0.1:5173
npm run build
npm run visual-smoke           # Playwright smoke (dev server running)
```

Useful deep checks (see `package.json`): `verify:fixed-step`, `verify:determinism`, `verify:vehicle-*`, `verify:post-effects`, `verify:game-runtime-boundary`.

| Path | Role |
|---|---|
| `src/main.js` / `src/bootstrap.jsx` | Entry + Solid mount |
| `src/ui/` | App shell, HUD, menus, editors |
| `src/game/core/` | Thin `GameRuntime` facade, frame loop |
| `src/game/runtime/` | Kernel, services, frame plan, mode features |
| `src/game/systems/` | Physics, movement, vehicles, combat, weather, … |
| `src/game/world/` | Level factories (city, terrain, range, horde, dog park, …) |
| `src/game/characters/` | Player, dogs, enemies |
| `src/world/terrain/` | Pure chunk heightfield modules (tooling-friendly) |
| `src/map/` | Map Builder / world map editor |
| `docs/` | Design plans for major systems |
| `scripts/` | Asset pipelines + `verify-*.mjs` regressions |
| `public/assets/` | Runtime GLB/FBX/textures/audio |

**Runtime rule of thumb:** new systems wire through `createRuntimeServices` / lifecycle / `runtimeFramePlan`—not by editing the closed `GameRuntime.js` facade (`npm run verify:game-runtime-boundary`).

### Controls (city freerun baseline)

| Input | Action |
|---|---|
| WASD | Move |
| Shift | Brace / sprint layer |
| Space | Jump |
| Q | Draw / sheathe great sword |
| LMB / RMB | Light / heavy attack (melee) |
| E | Mount / interact (context) |
| K | Photo / freecam camera mode |
| V | Legacy cut-mode debug (hold) |

Vehicle, FPS, dog, and Sims modes remap many of these—use in-game Controls guide and scene HUDs.

---

## Deploy (Cloudflare Pages)

Static Vite build → `dist/`.

```sh
npm ci && npm run build
npx wrangler pages deploy dist --project-name=dreamfall
```

**Limits:** Cloudflare free tier file count + **25 MiB per file**. Large models should go through `scripts/optimize-models.mjs` (or R2 for oversized assets). Total runtime assets are large; first load is heavy—prefer progressive loading for new work.

Dog product can deploy separately (`dog.html`, `deploy/dog-asset-manifest.json`, `og-image-dog.png`).

---

## License

MIT — see [LICENSE](LICENSE).

---

## References & credits

Ports and adaptations (high level). Third-party terms remain with their authors.

| Area | Sources / lineage |
|---|---|
| **Three.js / TSL / WebGPU** | [mrdoob/three.js](https://github.com/mrdoob/three.js); custom generators vendored under `src/three-addons/` |
| **UI** | [Solid](https://github.com/solidjs/solid) · [Vite](https://vitejs.dev) |
| **Physics** | [Rapier](https://rapier.rs) (`@dimforge/rapier3d-compat`) |
| **Rain / wet / lightning** | Adapted from [RainSystemThreeJS](https://github.com/achrefelouafi/RainSystemThreeJS) → weather + wet surface nodes |
| **Parallax occlusion** | [threejs-silhouette-pom](https://github.com/SkyeShark/threejs-silhouette-pom) → `ParallaxOcclusion.js` |
| **Hex tiling** | [mmikk/hextile-demo](https://github.com/mmikk/hextile-demo) → `hexTilingNodes.js` |
| **City generators** | three.js city/skyscraper lineage (e.g. PR #33906 family) in `three-addons/generators/` |
| **Volumetric sky / clouds** | Production WebGPU sky reference notes (`volumetric-sky-cloud-analysis.md`) → `render/cloud/` |
| **Trees** | [SeedThree](https://github.com/SkyeShark/SeedThree) + Weber–Penn; `npm run pull:forest-textures` for leaf PBR |
| **WFC interiors** | Wave Function Collapse family ([mxgmn](https://github.com/mxgmn/WaveFunctionCollapse)); local `office/wfc/` |
| **Engine audio** | Layered RPM model inspired by [engine-audio](https://github.com/markeasting/engine-audio) |
| **Characters / packs** | Mixamo packs, Mesh2Motion routes, Tripo-sourced meshes where noted |

Fuller credit tables and planned audio packs remain in git history / `docs/` if you need the long form.

---

## Development notes

- Player skeleton profile: default mesh2motion; `?playerModel=mixamo` for Mixamo route.
- Jacket cloth: bone colliders + weight mask; Cloth editor button in-game.
- Local editor state: `data/` (gitignored SQLite / caches)—do not commit.
- Prefer targeted `scripts/verify-*.mjs` over full suite when changing one subsystem.
- WebGPU gotchas: 16 samplers/fragment stage; de-interleave skinned attributes when needed; headless Chromium FPS is not production truth.
