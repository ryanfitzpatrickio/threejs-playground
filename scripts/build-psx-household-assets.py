#!/usr/bin/env python3
"""
Convert PSX-style household FBX packs into runtime GLBs + catalog.json.

Run via Blender:
  /Applications/Blender.app/Contents/MacOS/Blender --background \\
    --python scripts/build-psx-household-assets.py -- \\
    --src /path/to/extract --out public/assets/psx-household

Each pack FBX becomes one GLB with separate mesh objects preserved so the
viewer can isolate individual props by name.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector

# Packs that are useful for the sims residential lot / household dressing.
# "All" is a union of category packs (redundant but handy as a single atlas).
# "Models pack psx" uses generic Cube.* names — still converted, marked low usability.
# Characters are PSX horror/cartoon NPCs, not sim-human rigs.
PACK_DEFS = [
    {
        "id": "armchair",
        "label": "Armchairs",
        "category": "seating",
        "household": "high",
        "notes": "Living-room armchairs; good seat props for the lot.",
        "src_glob": "**/Armchair/Models/Armchair.fbx",
        "preview_glob": "**/Armchair/PSX2.png",
    },
    {
        "id": "chairs",
        "label": "Chairs",
        "category": "seating",
        "household": "high",
        "notes": "Dining/desk chairs; high priority furniture.",
        "src_glob": "**/Chairs/Models/Chairs.fbx",
        "preview_glob": "**/Chairs/PSX4.png",
    },
    {
        "id": "bath-hygiene",
        "label": "Bath & Hygiene",
        "category": "bathroom",
        "household": "high",
        "notes": "Washers, shelves, toiletries, mops, trash cans.",
        "src_glob": "**/Bath_Hygiene/Models/Bath_Hygiene.fbx",
        "preview_glob": "**/Bath_Hygiene/PSX8.png",
    },
    {
        "id": "electronics-kitchen",
        "label": "Electronics & Kitchen",
        "category": "kitchen",
        "household": "high",
        "notes": "Fridge, microwave, toaster, cookware, utensils.",
        "src_glob": "**/Electronics_kitchen/Models/Electronics_kitchen.fbx",
        "preview_glob": "**/Electronics_kitchen/PSX5.png",
    },
    {
        "id": "entertainment",
        "label": "Entertainment",
        "category": "living",
        "household": "high",
        "notes": "TVs, radios, remotes, books, magazines.",
        "src_glob": "**/Entertainment/Models/Entertainment.fbx",
        "preview_glob": "**/Entertainment/PSX3.png",
    },
    {
        "id": "foods",
        "label": "Foods",
        "category": "kitchen",
        "household": "high",
        "notes": "Groceries and prepared food props for counters/fridges.",
        "src_glob": "**/Foods/Models/Foods.fbx",
        "preview_glob": "**/Foods/PSX7.png",
    },
    {
        "id": "beds-others",
        "label": "Beds & Decor",
        "category": "bedroom",
        "household": "high",
        "notes": "Beds, pillows, drawers, lamps, plants, paintings (pack folder is Deds_others).",
        "src_glob": "**/Deds_others/Models/Deds_others.fbx",
        "preview_glob": "**/Deds_others/PSX6.png",
    },
    {
        "id": "all",
        "label": "All (combined)",
        "category": "bundle",
        "household": "medium",
        "notes": "Single mega-scene of most household props. Heavy to load; prefer category packs at runtime.",
        "src_glob": "**/All/Models/All.fbx",
        "preview_glob": "**/All/PSXFo.png",
    },
    {
        "id": "models-pack-psx",
        "label": "Models pack PSX (misc)",
        "category": "misc",
        "household": "low",
        "notes": "Large mixed set with mostly generic Cube/Cylinder names — needs manual rename before production use.",
        "src_glob": "**/Models pack psx/Models/models.fbx",
        "preview_glob": None,
    },
]


def parse_args(argv: list[str]) -> argparse.Namespace:
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True, help="Extract root containing unpacked RARs")
    p.add_argument("--out", required=True, help="Output directory (public/assets/psx-household)")
    p.add_argument("--only", default="", help="Comma-separated pack ids to convert")
    p.add_argument("--skip-convert", action="store_true", help="Only rebuild catalog from existing GLBs")
    return p.parse_args(argv)


def find_one(root: Path, pattern: str | None) -> Path | None:
    if not pattern:
        return None
    hits = sorted(root.glob(pattern))
    return hits[0] if hits else None


def clear_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


def import_fbx(path: Path) -> None:
    # Image search alone is not enough: these FBX files store absolute Windows
    # paths (C:/Users/srkak/...) so Blender creates zero-size image stubs.
    bpy.ops.import_scene.fbx(
        filepath=str(path),
        use_anim=False,
        use_image_search=True,
        ignore_leaf_bones=True,
        automatic_bone_orientation=True,
    )
    rebind_missing_textures(path)


def build_texture_index(search_roots: list[Path]) -> dict[str, Path]:
    """Map lowercased filename and stem -> first matching texture file."""
    index: dict[str, Path] = {}
    exts = {".jpg", ".jpeg", ".png", ".tga", ".bmp", ".webp"}
    for root in search_roots:
        if not root or not root.exists():
            continue
        for p in root.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in exts:
                continue
            index.setdefault(p.name.lower(), p)
            index.setdefault(p.stem.lower(), p)
    return index


def texture_search_roots(src_fbx: Path) -> list[Path]:
    """Typical pack layout: Models/*.fbx next to Textures/ or Texture/."""
    model_dir = src_fbx.parent
    pack_dir = model_dir.parent
    char_dir = model_dir  # character FBXs sit in their own folder with nearby maps
    roots = [
        pack_dir / "Textures",
        pack_dir / "Texture",
        pack_dir / "textures",
        pack_dir / "texture",
        model_dir / "Textures",
        model_dir / "Texture",
        model_dir,
        pack_dir,
        char_dir,
        # Mega-pack and character trees also stash maps one level up.
        pack_dir.parent,
        src_fbx.parent.parent,
    ]
    # Character subfolders often keep maps beside the FBX or under Textures.
    if src_fbx.parent.name not in {"Models", "models"}:
        roots.insert(0, src_fbx.parent)
        roots.insert(1, src_fbx.parent / "Textures")
    # Deduplicate while preserving order.
    seen: set[str] = set()
    out: list[Path] = []
    for r in roots:
        key = str(r.resolve()) if r.exists() else str(r)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _image_name_candidates(img) -> list[str]:
    """Possible on-disk texture names for a Blender image datablock."""
    candidates: list[str] = []
    raw_name = img.name or ""
    # Blender may append .001 when names collide (e.g. Metal.jpg.001).
    base = re.sub(r"\.\d{3}$", "", raw_name)
    candidates.append(base)
    candidates.append(Path(base).name)
    # Also strip a second .001 style if name was Image.001
    candidates.append(re.sub(r"\.\d{3}$", "", Path(base).stem) + Path(base).suffix)
    if img.filepath:
        # Broken path looks like .../Models/C:/Users/.../Fabric.jpg
        fp = img.filepath.replace("\\", "/")
        candidates.append(Path(fp).name)
        m = re.search(
            r"([^/\\]+\.(?:jpg|jpeg|png|tga|bmp|webp))$",
            fp,
            re.I,
        )
        if m:
            candidates.append(m.group(1))
    # Deduplicate preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for c in candidates:
        key = c.strip()
        if not key or key.lower() in seen:
            continue
        seen.add(key.lower())
        out.append(key)
    return out


def _resolve_texture_path(candidates: list[str], index: dict[str, Path]) -> Path | None:
    for c in candidates:
        key = c.lower().strip()
        if key in index:
            return index[key]
        stem = Path(key).stem.lower()
        if stem in index:
            return index[stem]
        # Spaces / underscores variants: "Wood 7.jpg" <-> "Wood_7.jpg"
        alt = key.replace(" ", "_")
        if alt in index:
            return index[alt]
        alt2 = key.replace("_", " ")
        if alt2 in index:
            return index[alt2]
        # Parenthesized: "Wood (4).jpg" <-> "Wood_4.jpg" / "Wood4.jpg"
        bare = re.sub(r"[\s_\-]*\((\d+)\)", r"_\1", key)
        if bare in index:
            return index[bare]
        bare2 = re.sub(r"[\s_\-]*\((\d+)\)", r"\1", key)
        if bare2 in index:
            return index[bare2]
    return None


def rebind_missing_textures(src_fbx: Path) -> int:
    """
    Reload image stubs that have no pixel data by matching filename against
    nearby Textures/ folders. Returns number of images successfully rebound.
    """
    # Prefer pack-local textures, but fall back to the whole extract tree so
    # shared maps like Metal.jpg can be borrowed from sibling packs.
    roots = texture_search_roots(src_fbx)
    extract_root = src_fbx
    for _ in range(8):
        if extract_root.name == "psx-household-extract" or (extract_root / "Chairs").exists():
            break
        if extract_root.parent == extract_root:
            break
        extract_root = extract_root.parent
    if extract_root.exists():
        roots.append(extract_root)

    index = build_texture_index(roots)
    if not index:
        print(f"[psx-household] WARNING: no texture files found near {src_fbx}")
        return 0

    fixed = 0
    missing: list[str] = []
    for img in bpy.data.images:
        has_pixels = img.size[0] > 0 and img.size[1] > 0
        if has_pixels:
            continue

        raw_name = img.name or ""
        candidates = _image_name_candidates(img)
        found = _resolve_texture_path(candidates, index)

        # Share filepath from another already-loaded image with the same basename.
        if not found:
            base = re.sub(r"\.\d{3}$", "", raw_name).lower()
            for other in bpy.data.images:
                if other is img or other.size[0] <= 0 or not other.filepath:
                    continue
                other_base = re.sub(r"\.\d{3}$", "", other.name or "").lower()
                if other_base == base or Path(other_base).name == Path(base).name:
                    found = Path(bpy.path.abspath(other.filepath))
                    break

        if not found:
            missing.append(raw_name)
            continue

        try:
            img.filepath = str(Path(found).resolve())
            img.source = "FILE"
            img.reload()
        except Exception as exc:  # noqa: BLE001 — surface and continue
            print(f"[psx-household] reload failed {raw_name}: {exc}")
            missing.append(raw_name)
            continue

        if img.size[0] > 0 and img.size[1] > 0:
            fixed += 1
            try:
                img.colorspace_settings.name = "sRGB"
            except Exception:
                pass
        else:
            missing.append(f"{raw_name} (still empty after {found})")

    # Drop unrecoverable stubs so pack_all / glTF export do not choke on them.
    for img in list(bpy.data.images):
        if img.size[0] > 0 and img.size[1] > 0:
            continue
        if img.users == 0:
            bpy.data.images.remove(img)
            continue
        # Neutral 1x1 so materials still export; better than a broken path.
        try:
            img.source = "GENERATED"
            img.generated_width = 1
            img.generated_height = 1
            img.generated_color = (0.55, 0.55, 0.55, 1.0)
            img.pack()
        except Exception:
            pass

    print(f"[psx-household] textures rebound: {fixed}, missing: {len(missing)}")
    if missing:
        print(f"[psx-household] missing samples: {missing[:12]}")
    return fixed


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def object_bounds(obj) -> dict:
    coords = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    xs = [c.x for c in coords]
    ys = [c.y for c in coords]
    zs = [c.z for c in coords]
    size = [max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)]
    center = [(max(xs) + min(xs)) * 0.5, (max(ys) + min(ys)) * 0.5, (max(zs) + min(zs)) * 0.5]
    return {
        "size": [round(v, 4) for v in size],
        "center": [round(v, 4) for v in center],
        "longestAxis": round(max(size), 4),
        "verts": len(obj.data.vertices) if obj.data else 0,
        "faces": len(obj.data.polygons) if obj.data else 0,
    }


def sanitize_mesh_name(name: str) -> str:
    # Keep readable prop ids; collapse whitespace.
    return re.sub(r"\s+", " ", name).strip()


def convert_pack(src_fbx: Path, out_glb: Path) -> list[dict]:
    clear_scene()
    print(f"[psx-household] import {src_fbx}")
    import_fbx(src_fbx)

    meshes = mesh_objects()
    if not meshes:
        raise RuntimeError(f"No meshes in {src_fbx}")

    # Ensure unique readable names for isolation in the viewer.
    used = set()
    items = []
    for obj in meshes:
        base = sanitize_mesh_name(obj.name) or "prop"
        name = base
        n = 2
        while name.lower() in used:
            name = f"{base}_{n}"
            n += 1
        used.add(name.lower())
        if obj.name != name:
            obj.name = name
        if obj.data and obj.data.name != name:
            obj.data.name = name
        stats = object_bounds(obj)
        items.append(
            {
                "id": name,
                "label": name.replace("_", " "),
                **stats,
            }
        )

    out_glb.parent.mkdir(parents=True, exist_ok=True)
    # Pack individually so one bad path cannot abort the whole export.
    packed = 0
    for img in bpy.data.images:
        if img.size[0] <= 0 or img.size[1] <= 0:
            continue
        try:
            if not img.packed_file:
                img.pack()
            packed += 1
        except Exception as exc:  # noqa: BLE001
            print(f"[psx-household] pack skip {img.name}: {exc}")

    loaded = sum(1 for img in bpy.data.images if img.size[0] > 0 and img.size[1] > 0)
    print(
        f"[psx-household] export {out_glb} "
        f"({len(items)} meshes, {loaded} images with pixels, {packed} packed)"
    )

    export_kwargs = dict(
        filepath=str(out_glb),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=False,
    )
    # Draco when available (Blender 3/4/5 flag names vary slightly).
    for key, val in (
        ("export_draco_mesh_compression_enable", True),
        ("export_draco_mesh_compression_level", 6),
    ):
        export_kwargs[key] = val

    try:
        bpy.ops.export_scene.gltf(**export_kwargs)
    except TypeError as exc:
        print(f"[psx-household] export kwargs rejected ({exc}); retry minimal")
        bpy.ops.export_scene.gltf(
            filepath=str(out_glb),
            export_format="GLB",
            export_yup=True,
            export_apply=True,
            export_animations=False,
        )

    if not out_glb.is_file():
        raise RuntimeError(f"GLB not written: {out_glb}")
    return items


def convert_character(src_fbx: Path, out_glb: Path) -> dict:
    clear_scene()
    print(f"[psx-household] character import {src_fbx}")
    import_fbx(src_fbx)
    meshes = mesh_objects()
    if not meshes:
        raise RuntimeError(f"No meshes in {src_fbx}")

    out_glb.parent.mkdir(parents=True, exist_ok=True)
    export_kwargs = dict(
        filepath=str(out_glb),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_animations=True,
        export_cameras=False,
        export_lights=False,
    )
    try:
        export_kwargs["export_draco_mesh_compression_enable"] = True
        export_kwargs["export_draco_mesh_compression_level"] = 6
    except Exception:
        pass
    try:
        bpy.ops.export_scene.gltf(**export_kwargs)
    except TypeError:
        bpy.ops.export_scene.gltf(
            filepath=str(out_glb),
            export_format="GLB",
            export_yup=True,
            export_apply=True,
            export_materials="EXPORT",
            export_animations=True,
        )
    verts = sum(len(m.data.vertices) for m in meshes if m.data)
    faces = sum(len(m.data.polygons) for m in meshes if m.data)
    return {
        "id": out_glb.stem,
        "label": out_glb.stem.replace("_", " "),
        "meshCount": len(meshes),
        "verts": verts,
        "faces": faces,
        "url": f"/assets/psx-household/characters/{out_glb.name}",
    }


def human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    for unit, div in (("KiB", 1024), ("MiB", 1024**2), ("GiB", 1024**3)):
        v = n / div
        if v < 1024 or unit == "GiB":
            return f"{v:.1f} {unit}"
    return f"{n} B"


def main() -> int:
    args = parse_args(sys.argv)
    src = Path(args.src).resolve()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    packs = []
    for pack in PACK_DEFS:
        if only and pack["id"] not in only:
            continue
        fbx = find_one(src, pack["src_glob"])
        if not fbx:
            print(f"[psx-household] SKIP missing {pack['id']} ({pack['src_glob']})")
            continue

        glb_path = out / f"{pack['id']}.glb"
        preview_src = find_one(src, pack["preview_glob"]) if pack.get("preview_glob") else None
        preview_url = None
        if preview_src:
            preview_dest = out / "previews" / f"{pack['id']}.png"
            preview_dest.parent.mkdir(parents=True, exist_ok=True)
            preview_dest.write_bytes(preview_src.read_bytes())
            preview_url = f"/assets/psx-household/previews/{pack['id']}.png"

        if args.skip_convert and glb_path.is_file():
            items = []
            print(f"[psx-household] reuse existing {glb_path.name}")
        else:
            items = convert_pack(fbx, glb_path)

        # Sort items by name for stable UI.
        items = sorted(items, key=lambda it: it["id"].lower()) if items else items
        packs.append(
            {
                "id": pack["id"],
                "label": pack["label"],
                "category": pack["category"],
                "household": pack["household"],
                "notes": pack["notes"],
                "url": f"/assets/psx-household/{pack['id']}.glb",
                "previewUrl": preview_url,
                "bytes": glb_path.stat().st_size if glb_path.is_file() else 0,
                "bytesLabel": human_bytes(glb_path.stat().st_size) if glb_path.is_file() else "?",
                "meshCount": len(items) if items else None,
                "meshes": items,
                "sourceFbx": str(fbx.relative_to(src)),
            }
        )

    # Characters (optional, low household viability)
    characters = []
    char_root = None
    for cand in src.glob("**/Characters"):
        if cand.is_dir() and any(cand.rglob("*.fbx")):
            char_root = cand
            break
    if char_root and (not only or "characters" in only):
        char_out = out / "characters"
        char_out.mkdir(parents=True, exist_ok=True)
        for fbx in sorted(char_root.rglob("*.fbx")):
            if only and only != {"characters"} and "characters" not in only:
                break
            dest = char_out / f"{fbx.stem}.glb"
            if args.skip_convert and dest.is_file():
                entry = {
                    "id": fbx.stem,
                    "label": fbx.stem.replace("_", " "),
                    "url": f"/assets/psx-household/characters/{dest.name}",
                    "bytes": dest.stat().st_size,
                }
            else:
                entry = convert_character(fbx, dest)
                entry["bytes"] = dest.stat().st_size
            entry["bytesLabel"] = human_bytes(entry["bytes"])
            entry["household"] = "low"
            entry["notes"] = "PSX low-poly character; not compatible with simhuman Rigify pipeline."
            characters.append(entry)

    # Viability summary for the household sim.
    high = [p for p in packs if p["household"] == "high"]
    medium = [p for p in packs if p["household"] == "medium"]
    low = [p for p in packs if p["household"] == "low"]
    total_meshes = sum((p.get("meshCount") or 0) for p in packs if p["id"] != "all")
    total_bytes = sum(p.get("bytes") or 0 for p in packs) + sum(c.get("bytes") or 0 for c in characters)

    catalog = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "title": "PSX Household Prop Packs",
        "description": (
            "Low-poly PSX-style household props converted from FBX category packs. "
            "High-viability packs are suitable for dressing the sims residential lot. "
            "Characters and the misc cube pack are included for completeness only."
        ),
        "runtimeNotes": [
            "Prefer category GLBs over the combined 'all' pack at runtime.",
            "Units are author-scale; normalize longestAxis ~1m per prop in the viewer/placer.",
            "Materials are baked albedo-style; use MeshStandardMaterial / source maps.",
            "WebGPU: flatten interleaved attributes if any pack fails to draw.",
            "Characters are not simhuman-compatible (no Rigify DEF bones).",
        ],
        "viability": {
            "high": [p["id"] for p in high],
            "medium": [p["id"] for p in medium],
            "low": [p["id"] for p in low] + (["characters"] if characters else []),
            "recommendedHouseholdMeshEstimate": total_meshes,
        },
        "totals": {
            "packs": len(packs),
            "characters": len(characters),
            "bytes": total_bytes,
            "bytesLabel": human_bytes(total_bytes),
        },
        "packs": packs,
        "characters": characters,
    }

    catalog_path = out / "catalog.json"
    catalog_path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"[psx-household] wrote {catalog_path}")
    print(f"[psx-household] packs={len(packs)} characters={len(characters)} total={human_bytes(total_bytes)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
