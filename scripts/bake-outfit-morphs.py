#!/usr/bin/env python3
"""
Offline selective morph projection: body bulk shape keys → outfit meshes.

Projects only outfit-relevant vibe-human morphs from a prepared UBC body onto
a prepared outfit GLB via nearest-surface sampling (same idea as
prepare-simhuman-glb.py transfer_shape_keys).

Selective set (face/skull/nose/mouth excluded):
  id.body.global.mass.neg / .pos
  id.body.global.muscle.neg / .pos
  id.body.global.fat.pos

Run via wrapper:
  node scripts/bake-outfit-morphs.mjs
  node scripts/bake-outfit-morphs.mjs --only male-peasant

Or directly:
  Blender --background --python scripts/bake-outfit-morphs.py -- \\
    --body public/assets/simhuman/ubc-male.glb \\
    --outfit public/assets/simoutfits/male-peasant.glb \\
    --output public/assets/simoutfits/male-peasant.glb
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# Essential clothing morphs only (4–6 target). UBC vibe-human has exactly these
# body bulk keys — no breast/hip/height clothing morphs on this pack.
# Height is overall body scale; face morphs are intentionally excluded.
OUTFIT_MORPH_NAMES = (
    "id.body.global.mass.neg",
    "id.body.global.mass.pos",
    "id.body.global.muscle.neg",
    "id.body.global.muscle.pos",
    "id.body.global.fat.pos",
)


def log(msg: str) -> None:
    print(f"[bake-outfit-morphs] {msg}", flush=True)


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser(description="Project body bulk morphs onto an outfit GLB")
    p.add_argument("--body", type=Path, required=True, help="Prepared UBC body GLB (morph source)")
    p.add_argument("--outfit", type=Path, required=True, help="Prepared outfit GLB (target)")
    p.add_argument("--output", type=Path, required=True, help="Output outfit GLB path")
    p.add_argument(
        "--max-dist",
        type=float,
        default=0.14,
        help="Skip outfit verts farther than this (world units) from the body surface",
    )
    p.add_argument(
        "--ease",
        type=float,
        default=1.08,
        help="Scale projected deltas so clothing sits slightly outside the body",
    )
    p.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Optional JSON report path",
    )
    return p.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


def import_gltf(path: Path) -> None:
    log(f"import {path}")
    bpy.ops.import_scene.gltf(filepath=str(path))


def mesh_objects() -> list[bpy.types.Object]:
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def world_mesh_bounds(objs: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    coords: list[Vector] = []
    for obj in objs:
        mw = obj.matrix_world
        for v in obj.data.vertices:
            coords.append(mw @ v.co)
    if not coords:
        z = Vector((0, 0, 0))
        return z, z
    xs = [c.x for c in coords]
    ys = [c.y for c in coords]
    zs = [c.z for c in coords]
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def pick_body_mesh(tag: str = "__body") -> bpy.types.Object | None:
    meshes = [o for o in mesh_objects() if o.get(tag)]
    if not meshes:
        return None

    def key_count(o: bpy.types.Object) -> int:
        sk = o.data.shape_keys
        return 0 if not sk else len(sk.key_blocks)

    # Prefer the mesh that actually carries the bulk morphs (usually body, not eyes).
    with_keys = [o for o in meshes if key_count(o) > 1]
    pool = with_keys or meshes
    return max(pool, key=lambda o: (key_count(o), len(o.data.vertices)))


def ensure_basis(obj: bpy.types.Object) -> bpy.types.Key:
    if obj.data.shape_keys is None:
        obj.shape_key_add(name="Basis", from_mix=False)
    return obj.data.shape_keys


def mesh_eval_world_coords(obj: bpy.types.Object) -> list[Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    mw = eval_obj.matrix_world
    coords = [mw @ v.co for v in mesh.vertices]
    eval_obj.to_mesh_clear()
    return coords


def zero_shape_keys(obj: bpy.types.Object) -> None:
    sk = obj.data.shape_keys
    if not sk:
        return
    for kb in sk.key_blocks:
        kb.value = 0.0


def align_body_to_outfit(body_objs: list[bpy.types.Object], outfit_objs: list[bpy.types.Object]) -> None:
    """Translate body so feet and mid-XZ match the outfit (scales already match)."""
    tmin, tmax = world_mesh_bounds(outfit_objs)
    rmin, rmax = world_mesh_bounds(body_objs)
    dx = 0.5 * (tmin.x + tmax.x) - 0.5 * (rmin.x + rmax.x)
    dy = 0.5 * (tmin.y + tmax.y) - 0.5 * (rmin.y + rmax.y)
    dz = tmin.z - rmin.z
    roots = {o for o in body_objs}
    # Move top-level body roots only.
    moved = set()
    for o in bpy.data.objects:
        if not o.get("__body"):
            continue
        root = o
        while root.parent is not None:
            root = root.parent
        if root in moved:
            continue
        root.location += Vector((dx, dy, dz))
        moved.add(root)
    bpy.context.view_layer.update()
    log(f"aligned body by delta=({dx:.4f}, {dy:.4f}, {dz:.4f})")


def transfer_selective_shape_keys(
    source: bpy.types.Object,
    target: bpy.types.Object,
    morph_names: tuple[str, ...],
    *,
    max_dist: float,
    ease: float,
) -> dict:
    src_keys = source.data.shape_keys
    if not src_keys or len(src_keys.key_blocks) <= 1:
        return {"transferred": 0, "error": "source has no shape keys", "mesh": target.name}

    available = {kb.name for kb in src_keys.key_blocks}
    names = [n for n in morph_names if n in available]
    missing = [n for n in morph_names if n not in available]
    if not names:
        return {
            "transferred": 0,
            "error": "none of the selective morphs exist on body",
            "missing": missing,
            "mesh": target.name,
        }

    zero_shape_keys(source)
    bpy.context.view_layer.update()

    mw = source.matrix_world
    src_mesh = source.data
    verts = [mw @ v.co for v in src_mesh.vertices]
    polys = [list(p.vertices) for p in src_mesh.polygons]
    bvh = BVHTree.FromPolygons(verts, polys)
    src_basis = mesh_eval_world_coords(source)

    tgt_mw = target.matrix_world
    tgt_imw = tgt_mw.inverted()
    tgt_basis_world = [tgt_mw @ v.co for v in target.data.vertices]

    nearest_src: list[int | None] = []
    distances: list[float] = []
    misses = 0
    far = 0
    for co in tgt_basis_world:
        loc, _normal, index, dist = bvh.find_nearest(co)
        if loc is None or index is None:
            nearest_src.append(None)
            distances.append(1e9)
            misses += 1
            continue
        if dist is not None and dist > max_dist:
            nearest_src.append(None)
            distances.append(float(dist))
            far += 1
            continue
        face = src_mesh.polygons[index]
        best_i = face.vertices[0]
        best_d = (verts[best_i] - co).length_squared
        for vi in face.vertices:
            d = (verts[vi] - co).length_squared
            if d < best_d:
                best_d = d
                best_i = vi
        nearest_src.append(best_i)
        distances.append(float(dist) if dist is not None else 0.0)

    ensure_basis(target)
    # Remove previous projected keys so re-bakes stay clean.
    sk_data = target.data.shape_keys
    if sk_data:
        for name in morph_names:
            kb = sk_data.key_blocks.get(name)
            if kb:
                target.shape_key_remove(kb)

    ensure_basis(target)
    transferred = 0
    max_delta = 0.0
    for name in names:
        kb = src_keys.key_blocks.get(name)
        if not kb:
            continue
        zero_shape_keys(source)
        kb.value = 1.0
        bpy.context.view_layer.update()
        src_posed = mesh_eval_world_coords(source)
        kb.value = 0.0

        sk = target.shape_key_add(name=name, from_mix=False)
        # Start from basis
        for ti, v in enumerate(target.data.vertices):
            sk.data[ti].co = v.co

        for ti, src_i in enumerate(nearest_src):
            if src_i is None:
                continue
            delta_world = (src_posed[src_i] - src_basis[src_i]) * ease
            dlen = delta_world.length
            if dlen > max_delta:
                max_delta = dlen
            world_pos = tgt_basis_world[ti] + delta_world
            sk.data[ti].co = tgt_imw @ world_pos
        transferred += 1

    zero_shape_keys(source)
    bpy.context.view_layer.update()
    mapped = sum(1 for i in nearest_src if i is not None)
    return {
        "mesh": target.name,
        "verts": len(target.data.vertices),
        "transferred": transferred,
        "names": names,
        "missing_on_body": missing,
        "mapped_verts": mapped,
        "misses": misses,
        "far_skipped": far,
        "max_delta": round(max_delta, 5),
        "max_dist": max_dist,
        "ease": ease,
    }


def export_glb(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Export only outfit-tagged objects.
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        o.select_set(bool(o.get("__outfit")))
    # Also select parents of outfit meshes so hierarchy stays intact.
    for o in list(bpy.data.objects):
        if not o.get("__outfit"):
            continue
        p = o.parent
        while p is not None:
            p.select_set(True)
            p = p.parent

    kwargs = dict(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_skins=True,
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_yup=True,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError as exc:
        log(f"export kwargs rejected ({exc}); retry minimal")
        bpy.ops.export_scene.gltf(
            filepath=str(path),
            export_format="GLB",
            use_selection=True,
            export_skins=True,
            export_morph=True,
            export_materials="EXPORT",
            export_animations=False,
            export_yup=True,
        )
    log(f"wrote {path} ({path.stat().st_size / 1024:.1f} KiB)")


def main() -> int:
    args = parse_args()
    if not args.body.is_file():
        log(f"ERROR: body missing {args.body}")
        return 1
    if not args.outfit.is_file():
        log(f"ERROR: outfit missing {args.outfit}")
        return 1

    clear_scene()

    # Import outfit first and tag.
    import_gltf(args.outfit)
    for o in bpy.data.objects:
        o["__outfit"] = True

    outfit_meshes = [o for o in mesh_objects() if o.type == "MESH"]
    if not outfit_meshes:
        log("ERROR: no outfit meshes")
        return 1
    log(f"outfit meshes: {len(outfit_meshes)} ({', '.join(o.name for o in outfit_meshes[:8])})")

    # Import body and tag.
    import_gltf(args.body)
    for o in bpy.data.objects:
        if not o.get("__outfit"):
            o["__body"] = True

    body_mesh = pick_body_mesh("__body")
    if not body_mesh:
        log("ERROR: no body mesh with shape keys")
        return 1
    sk = body_mesh.data.shape_keys
    key_count = 0 if not sk else len(sk.key_blocks)
    log(f"body morph source '{body_mesh.name}' keys={key_count} verts={len(body_mesh.data.vertices)}")

    body_meshes = [o for o in mesh_objects() if o.get("__body")]
    align_body_to_outfit(body_meshes, outfit_meshes)

    reports = []
    for mesh in outfit_meshes:
        # Skip tiny accessory meshes without skin? Still project if skinned.
        if not mesh.vertex_groups and len(mesh.data.vertices) < 8:
            log(f"skip tiny unweighted mesh {mesh.name}")
            continue
        result = transfer_selective_shape_keys(
            body_mesh,
            mesh,
            OUTFIT_MORPH_NAMES,
            max_dist=args.max_dist,
            ease=args.ease,
        )
        reports.append(result)
        log(
            f"  {mesh.name}: transferred={result.get('transferred')} "
            f"mapped={result.get('mapped_verts')}/{result.get('verts')} "
            f"far={result.get('far_skipped')} maxΔ={result.get('max_delta')}"
        )

    # Remove body objects before export.
    for o in list(bpy.data.objects):
        if o.get("__body"):
            bpy.data.objects.remove(o, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)

    # Zero shape-key values so glTF morph weights export as 0 (not fully on).
    for obj in mesh_objects():
        if not obj.get("__outfit") or not obj.data.shape_keys:
            continue
        for kb in obj.data.shape_keys.key_blocks:
            kb.value = 0.0
    bpy.context.view_layer.update()

    export_glb(args.output)

    summary = {
        "body": str(args.body),
        "outfit": str(args.outfit),
        "output": str(args.output),
        "morphs": list(OUTFIT_MORPH_NAMES),
        "meshes": reports,
        "bytes": args.output.stat().st_size if args.output.is_file() else 0,
    }
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        log(f"report {args.report}")

    total = sum(r.get("transferred") or 0 for r in reports)
    if total <= 0:
        log("ERROR: no morphs transferred")
        return 1
    log(f"done — projected {total} shape-key slots across {len(reports)} meshes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
