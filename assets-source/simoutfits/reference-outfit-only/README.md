# Sim outfit reference plates

Neutral **default body size** (all modeling morphs at 0) reference stills for:

- fantasy-peasant (male / female)
- fantasy-ranger (male / female)

Generated: 2026-07-14T00:48:53.777Z
Outfit-only body hide: yes

## Angles

- `front` — camera +Z
- `threequarter` — ~50°
- `side` — profile
- `back`
- `threequarter-back`

## Intended use

1. Use these plates as **style / silhouette / proportion** reference for 3D gen AI clothes.
2. Target the **UBC skeleton** (65 joints, DEF-* after prepare — same as current outfits).
3. Author at the same bind height as prepared UBC (~3.49 raw → 1.75 m runtime).
4. After import, run:

```sh
# normalize / keep materials (see prepare-sim-outfits.mjs)
# then bake selective bulk morphs + dual variants:
npm run bake:outfit-morphs
npm run verify:sim-outfits
```

## Skeleton contract

Joints follow prepared UBC → Rigify DEF mapping (`simOutfitBoneMap.js`):

- pelvis → DEF-spine … head → DEF-spine.006
- arms: clavicle / upperarm / lowerarm / hand + fingers
- legs: thigh / calf / foot / ball

Keep mesh pieces skinned to those bones. Prefer one outfit root with separate
meshes per layer (body / arms / legs / boots / acc) matching the Quaternius layout.

## Files

- `male-peasant-front.png`
- `male-peasant-threequarter.png`
- `male-peasant-side.png`
- `male-peasant-back.png`
- `male-peasant-threequarter-back.png`
- `male-ranger-front.png`
- `male-ranger-threequarter.png`
- `male-ranger-side.png`
- `male-ranger-back.png`
- `male-ranger-threequarter-back.png`
- `female-peasant-front.png`
- `female-peasant-threequarter.png`
- `female-peasant-side.png`
- `female-peasant-back.png`
- `female-peasant-threequarter-back.png`
- `female-ranger-front.png`
- `female-ranger-threequarter.png`
- `female-ranger-side.png`
- `female-ranger-back.png`
- `female-ranger-threequarter-back.png`
