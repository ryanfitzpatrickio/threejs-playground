# Dog reference boards

Keep one generated 2×2 studio board at `<breed-id>/board.png` (JPEG and WebP are
also accepted). Use the same neutral sage-gray seamless background as the Golden
Retriever references. Quadrants must be, in reading order:

1. standing three-quarter
2. standing profile
3. front sit
4. head close-up

The board should show one consistent adult dog with neutral studio lighting,
natural conformation, no collar, no text, and no props. Run
`npm run prepare:dog-ref` to create optimized scene JPEGs. Generated output is
written to `public/assets/dog-ref/<breed-id>/`.

Per-breed boards (preferred for new work) live at
`assets-source/dog-ref/<breed-id>/board.(png|jpg|webp)`. Boxer is an example:
`assets-source/dog-ref/boxer/board.jpg` → `npm run prepare:dog-ref -- boxer`.

A single `master-board.png` is also supported. It must contain seven breed rows
in this exact order: French Bulldog, German Shepherd Dog, Dachshund, Rottweiler,
Miniature Schnauzer, Pomeranian, Chihuahua. Each row contains the same four
views in columns: three-quarter, profile, front sit, head close-up.
