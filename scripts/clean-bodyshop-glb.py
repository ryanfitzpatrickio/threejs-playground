#!/usr/bin/env python3
"""Clean cut / CSG garbage on bodyshop chassis GLBs with Blender.

Ported from dust-and-bullets `scripts/decimate-glb.py` (planar dissolve after cuts).
Cylinder / CSG cuts leave dense coplanar fragments and split verts; this welds
nearby verts, dissolves flat faces, optionally collapse-decimates, then fixes normals.

Run with Blender, not system Python:

  blender --background --python scripts/clean-bodyshop-glb.py -- input.glb output.glb
  blender --background --python scripts/clean-bodyshop-glb.py -- input.glb output.glb \\
      --ratio 1 --planar-angle 5 --merge-distance 0.00005

Defaults keep collapse off (ratio=1) so car shell detail survives; planar dissolve
is what removes the flat cut sludge.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser(
        description="Dissolve flat cut faces and clean bodyshop chassis meshes."
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--ratio",
        type=float,
        default=1.0,
        help="Collapse decimation ratio after planar cleanup. Use 1 to disable (default).",
    )
    parser.add_argument(
        "--planar-angle",
        type=float,
        default=5.0,
        help="Degrees used for planar dissolve. Higher removes more flat cut faces.",
    )
    parser.add_argument(
        "--merge-distance",
        type=float,
        default=0.00005,
        help="Merge vertices closer than this before dissolving. Use 0 to disable.",
    )
    parser.add_argument(
        "--keep-materials",
        action="store_true",
        help="Keep imported material slots even if Blender thinks they are unused.",
    )
    parser.add_argument(
        "--min-size-mb",
        type=float,
        default=0.0,
        help="When input is a directory, skip GLBs smaller than this size.",
    )
    return parser.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def mesh_counts() -> tuple[int, int]:
    vertices = 0
    faces = 0
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj.data:
            vertices += len(obj.data.vertices)
            faces += len(obj.data.polygons)
    return vertices, faces


def select_active(obj: bpy.types.Object) -> None:
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def merge_close_vertices(obj: bpy.types.Object, distance: float) -> None:
    if distance <= 0:
        return
    select_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=distance)
    bpy.ops.object.mode_set(mode="OBJECT")


def apply_modifier(obj: bpy.types.Object, modifier: bpy.types.Modifier) -> None:
    select_active(obj)
    try:
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    except RuntimeError as exc:
        print(f"warning: could not apply {modifier.name} on {obj.name}: {exc}")


def cleanup_mesh(obj: bpy.types.Object, args: argparse.Namespace) -> None:
    merge_close_vertices(obj, args.merge_distance)

    planar = obj.modifiers.new("cut_planar_dissolve", "DECIMATE")
    planar.decimate_type = "DISSOLVE"
    planar.angle_limit = math.radians(args.planar_angle)
    planar.use_dissolve_boundaries = False
    apply_modifier(obj, planar)

    if 0 < args.ratio < 1:
        collapse = obj.modifiers.new("shape_decimate", "DECIMATE")
        collapse.decimate_type = "COLLAPSE"
        collapse.ratio = args.ratio
        collapse.use_collapse_triangulate = True
        apply_modifier(obj, collapse)

    select_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

    obj.data.validate(clean_customdata=False)
    obj.data.update()
    if not args.keep_materials:
        obj.data.materials.update()


def clean_file(input_path: Path, output_path: Path, args: argparse.Namespace) -> str:
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(input_path))
    before_vertices, before_faces = mesh_counts()

    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH" and obj.data:
            cleanup_mesh(obj, args)

    after_vertices, after_faces = mesh_counts()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output_path), export_format="GLB")

    summary = (
        f"vertices {before_vertices:,} -> {after_vertices:,}, "
        f"faces {before_faces:,} -> {after_faces:,}"
    )
    print(f"cleaned {input_path} -> {output_path} | {summary}")
    return summary


def main() -> None:
    args = parse_args()
    if not args.input.exists():
        raise SystemExit(f"input does not exist: {args.input}")
    if args.ratio <= 0:
        raise SystemExit("--ratio must be greater than 0")

    if args.input.is_dir():
        args.output.mkdir(parents=True, exist_ok=True)
        min_bytes = args.min_size_mb * 1024 * 1024
        inputs = sorted(args.input.glob("*.glb"))
        for input_path in inputs:
            output_path = args.output / input_path.name
            if input_path.stat().st_size < min_bytes:
                print(f"skipped {input_path} below {args.min_size_mb:g} MB")
                continue
            clean_file(input_path, output_path, args)
        return

    clean_file(args.input, args.output, args)


if __name__ == "__main__":
    main()
