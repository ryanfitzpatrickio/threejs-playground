# Insect reference boards

Source boards for the dog-sim compare panel (`public/assets/insect-ref/`).

Layout (2×2, reading order):

| three-quarter | profile    |
| front-sit     | head-close |

- Source: `assets-source/insect-ref/<breed-id>/board.jpg` (≥800×800)
- Slice: `npm run prepare:insect-ref`
- Runtime: `public/assets/insect-ref/<breed-id>/{three-quarter,profile,front-sit,head-close}.jpg`

Neutral seamless sage-gray studio background, soft lighting, one consistent
adult insect per board, no text, no props. Macro photographic style.

## First-wave boards (most popular / iconic)

| Breed id | Species | Notes |
|----------|---------|-------|
| `seven-spotted-ladybug` | Coccinellidae | Domed red elytra, classic spots |
| `honey-bee` | Apidae | Worker caste, banded abdomen |
| `monarch-butterfly` | Nymphalidae | Orange / black / white wings |
| `praying-mantis` | Mantidae | Green raptorial pose |
| `dragonfly` | Libellulidae | Long abdomen, open wings |

Remaining Insecta catalog breeds can gain boards later using the same layout.
