# Sim outfits

## Fantasy (Quaternius)

- Author: Quaternius (@Quaternius)
- Source: https://quaternius.com/packs/modularcharacteroutfitsfantasy.html
- License: CC0 1.0 Universal (see LICENSE.txt)
- Catalog: `fantasy-peasant`, `fantasy-ranger` (male + female)

## Showcase wardrobe

| Id | Name | Bodies | Notes |
|----|------|--------|--------|
| `charcoal-suit` | Charcoal Suit | male | Showcase Male |
| `executive-suit` | Executive Suit | human5, male | Base 5 |
| `rose-sequin-cocktail` | Rose Sequin Cocktail | female | Showcase Female |

Each ships `standard/` + `morph/` under `public/assets/simoutfits/`.

Legacy Meshy hash ids alias to these clean ids in `simOutfitCatalog.js`.

## Variants

| Folder | Purpose | Morphs |
|---|---|---|
| `standard/` | Small default for lots / many NPCs | None |
| `morph/` | Creator + bulk body fit | 5 essential bulk keys |

## Runtime

- Catalog: `src/game/characters/simhuman/simOutfitCatalog.js`
- Showcase presets: `src/game/characters/simhuman/showcasePresets.json`
