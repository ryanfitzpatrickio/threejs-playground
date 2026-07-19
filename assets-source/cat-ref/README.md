# Cat reference boards

Keep one generated 2×2 studio board at `<breed-id>/board.png` (JPEG and WebP are
also accepted). Use the same neutral sage-gray seamless background as the dog
and existing cat stills. Quadrants must be, in reading order:

1. standing three-quarter
2. standing profile
3. front sit
4. head close-up

The board should show one consistent adult cat with neutral studio lighting,
natural conformation, no collar, no text, and no props. Run
`npm run prepare:cat-ref` to create optimized scene JPEGs. Generated output is
written to `public/assets/cat-ref/<breed-id>/`.

Per-breed boards live at
`assets-source/cat-ref/<breed-id>/board.(png|jpg|webp)`.

Khao Manee eye variants may also store discrete head stills as
`public/assets/cat-ref/khao-manee/head-close-<variant>.jpg`
(`odd-eye`, `blue`, `regular`).
