# Sim hair caps

## Chestnut Cascade

- Source: Meshy AI part-segmentation export
  `Meshy_AI_Chestnut Cascade_1784167305_part-segmentation.glb`
- Runtime: `chestnut-cascade.glb` (Draco, **mesh 7 only** — 0-based index 6)
- Rebuild:

```sh
npm run prepare:sim-hair
# or
node scripts/prepare-sim-hair.mjs --input /path/to/pack.glb --id chestnut-cascade --keep-mesh 6
```

Raw source (optional archive): `assets-source/simhair/chestnut-cascade.raw.glb`

Catalog: `src/game/characters/simhuman/simHairCatalog.js`
