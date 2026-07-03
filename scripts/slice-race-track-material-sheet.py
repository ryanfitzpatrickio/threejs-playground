#!/usr/bin/env python3
"""Cut the generated 3x2 race-track material sheet into tileable atlas sources."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps


ASSETS = (
    "cement_floor",
    "brick_wall",
    "garage_door",
    "asphalt_pit",
    "metal_siding",
    "painted_concrete",
)


def mirrored_tile(image: Image.Image, size: int) -> Image.Image:
    """Make opposite edges identical without smearing structural patterns."""
    half = size // 2
    source = ImageOps.fit(image, (half, half), method=Image.Resampling.LANCZOS)
    tile = Image.new("RGB", (size, size))
    tile.paste(source, (0, 0))
    tile.paste(ImageOps.mirror(source), (half, 0))
    tile.paste(ImageOps.flip(source), (0, half))
    tile.paste(ImageOps.flip(ImageOps.mirror(source)), (half, half))
    return tile


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("public/textures/atlas-sources/race-track-material-sheet.png"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("public/textures/atlas-sources"),
    )
    parser.add_argument("--size", type=int, default=1024)
    args = parser.parse_args()

    sheet = Image.open(args.source).convert("RGB")
    args.output.mkdir(parents=True, exist_ok=True)
    gutter = max(4, round(min(sheet.width / 3, sheet.height / 2) * 0.012))

    for index, name in enumerate(ASSETS):
        column = index % 3
        row = index // 3
        x0 = round(column * sheet.width / 3) + gutter
        x1 = round((column + 1) * sheet.width / 3) - gutter
        y0 = round(row * sheet.height / 2) + gutter
        y1 = round((row + 1) * sheet.height / 2) - gutter
        cell = sheet.crop((x0, y0, x1, y1))
        texture = mirrored_tile(cell, args.size)
        target = args.output / f"{name}.jpg"
        texture.save(target, quality=92, subsampling=0, optimize=True, progressive=True)
        print(f"Wrote {target} ({texture.width}x{texture.height})")


if __name__ == "__main__":
    main()
