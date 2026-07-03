#!/usr/bin/env python3
"""Slice the generated urban-track atlas and emit transparent textures + metadata."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import median

from PIL import Image, ImageChops, ImageFilter


ASSETS = [
    ("barrier_red_white", "barrier", [2.4, 0.9], True),
    ("barrier_hazard", "barrier", [2.4, 0.9], True),
    ("barrier_blue_white", "barrier", [2.4, 0.9], True),
    ("wall_dark_reflectors", "barrier", [2.4, 0.9], True),
    ("sign_checkpoint", "billboard", [2.4, 1.2], False),
    ("sign_chevron_left", "billboard", [2.0, 1.0], False),
    ("sign_chevron_right", "billboard", [2.0, 1.0], False),
    ("sign_slow", "billboard", [1.8, 1.0], False),
    ("sign_speed_80", "billboard", [1.0, 1.0], False),
    ("sign_turn_warning", "billboard", [1.1, 1.0], False),
    ("billboard_apex", "billboard", [2.4, 1.25], False),
    ("billboard_nightshift", "billboard", [2.4, 1.25], False),
    ("barricade_orange", "billboard", [1.8, 1.1], False),
    ("tire_barrier", "billboard", [2.0, 1.25], False),
    ("fence_chainlink", "billboard", [2.0, 1.8], True),
    ("cone_warning_lamp", "billboard", [0.65, 1.25], False),
]


def border_color(image: Image.Image) -> tuple[int, int, int]:
    rgb = image.convert("RGB")
    samples = []
    for x in range(rgb.width):
        samples.extend((rgb.getpixel((x, 0)), rgb.getpixel((x, rgb.height - 1))))
    for y in range(rgb.height):
        samples.extend((rgb.getpixel((0, y)), rgb.getpixel((rgb.width - 1, y))))
    return tuple(round(median(pixel[channel] for pixel in samples)) for channel in range(3))


def remove_background(image: Image.Image) -> Image.Image:
    """Turn the near-uniform cell background transparent, retaining soft edges."""
    rgb = image.convert("RGB")
    background = Image.new("RGB", rgb.size, border_color(rgb))
    difference = ImageChops.difference(rgb, background)
    channels = difference.split()
    alpha = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    alpha = alpha.point(lambda value: 0 if value < 11 else min(255, (value - 11) * 5))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
    rgba = rgb.convert("RGBA")
    rgba.putalpha(alpha)
    return rgba


def alpha_bbox(image: Image.Image, padding: int = 6) -> tuple[int, int, int, int]:
    bbox = image.getchannel("A").getbbox() or (0, 0, image.width, image.height)
    return (
        max(0, bbox[0] - padding),
        max(0, bbox[1] - padding),
        min(image.width, bbox[2] + padding),
        min(image.height, bbox[3] + padding),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("public/assets/textures/urban-track/urban-track-atlas-source.png"))
    parser.add_argument("--output", type=Path, default=Path("public/assets/textures/urban-track/slices"))
    args = parser.parse_args()

    atlas = Image.open(args.source).convert("RGB")
    if atlas.width != atlas.height:
        raise SystemExit(f"Expected a square 4x4 atlas, got {atlas.size}")

    args.output.mkdir(parents=True, exist_ok=True)
    boundaries = [round(index * atlas.width / 4) for index in range(5)]
    manifest = {
        "schemaVersion": 1,
        "source": args.source.name,
        "sourceSize": [atlas.width, atlas.height],
        "grid": {"columns": 4, "rows": 4, "boundaries": boundaries},
        "coordinateSystem": "top-left origin; pixel rectangles are [x, y, width, height]",
        "assets": {},
    }

    for index, (name, kind, world_size, repeatable) in enumerate(ASSETS):
        column, row = index % 4, index // 4
        source_box = (boundaries[column], boundaries[row], boundaries[column + 1], boundaries[row + 1])
        source_width = source_box[2] - source_box[0]
        source_height = source_box[3] - source_box[1]
        isolated = remove_background(atlas.crop(source_box))
        trim_box = alpha_bbox(isolated)
        texture = isolated.crop(trim_box)
        filename = f"{name}.png"
        texture.save(args.output / filename, optimize=True)
        manifest["assets"][name] = {
            "file": f"slices/{filename}",
            "kind": kind,
            "gridCell": [column, row],
            "sourceRect": [source_box[0], source_box[1], source_width, source_height],
            "trimRectInCell": [trim_box[0], trim_box[1], trim_box[2] - trim_box[0], trim_box[3] - trim_box[1]],
            "pixelSize": [texture.width, texture.height],
            "pivot": [0.5, 0.0],
            "worldSizeMeters": world_size,
            "repeatableHorizontally": repeatable,
            "alphaMode": "blend",
        }

    manifest_path = args.output.parent / "urban-track-atlas.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {len(ASSETS)} textures and {manifest_path}")


if __name__ == "__main__":
    main()
