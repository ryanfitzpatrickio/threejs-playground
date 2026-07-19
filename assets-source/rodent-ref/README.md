# Rodent reference boards

Keep one generated 2×2 studio board at `<breed-id>/board.(png|jpg|webp)`.
Use a neutral sage-gray seamless background (same as dog/cat stills). Quadrants
in reading order:

1. standing three-quarter
2. standing profile
3. front sit
4. head close-up

One consistent adult animal, soft studio lighting, natural conformation, no
collar, no text, no props. Run `npm run prepare:rodent-ref` to write optimized
scene JPEGs under `public/assets/rodent-ref/<breed-id>/`.

## Authored boards

| Species | Family | Breed id |
|---------|--------|----------|
| Sciuridae | squirrel | `grey-squirrel`, `eastern-chipmunk` |
| Muridae | mouse-rat | `norway-rat`, `house-mouse` |
| Cricetidae | hamster-vole | `syrian-hamster` |
| **Caviidae** | **cavid** | `guinea-pig` |
| **Caviidae** | **hydrochoerine** | `capybara` |
| **Caviidae** | **mara** | `patagonian-mara` |
