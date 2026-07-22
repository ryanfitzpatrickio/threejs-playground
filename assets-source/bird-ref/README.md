# Bird reference boards

Source boards for the dog-sim compare panel (`public/assets/bird-ref/`).

Layout (2×2, reading order):

| three-quarter | profile    |
| front-sit     | head-close |

- Source: `assets-source/bird-ref/<breed-id>/board.jpg` (≥800×800)
- Slice: `npm run prepare:bird-ref`
- Runtime: `public/assets/bird-ref/<breed-id>/{three-quarter,profile,front-sit,head-close}.jpg`

All MVP breeds are **varieties of the procedural Canada-goose body**
(`src/game/characters/goose/`): shared ~53-bone rig, ring-loft mesh, shell
plumage, flight feathers, and procedural FSM.

Per-breed identity (`birdVarietyProfile.js` + `gooseMorph.js`):
- **scale** + plumage palette / field-mark knobs
- **neckLen** (1 = full S-neck → 0 ≈ no neck)
- **bodyUpright** (0 = horizontal waterfowl → 1 = upright passerine)
- **bodyFat**, **beakStyle** (goose/flat/point/cone/needle/hook)
- **footStyle** (web/perch/talon/zygodactyl), **eyeStyle** (beady/large/raptor/soft)

Reference boards are for silhouette / field-mark comparison only — display
geometry is never a copy of a source GLB mesh.

`canada-goose` is the reference variety (scale 1, full neck, horizontal) and
keeps measurement extracts under `assets-source/bird-ref/canada-goose/`.

The older `bird-rigged.glb` + `createAuthoredBird` path remains in-tree as a
legacy fallback but is no longer used by Dog Studio / Dog Park.
