#!/usr/bin/env python3
"""
Prepare an unrigged clothing mesh (e.g. Meshy FBX) for Dreamfall sim outfits.

1. Import clothing (FBX/GLB) + textures
2. Import prepared UBC body (weights + DEF skeleton)
3. Scale/position clothing to match body bind (feet at y≈0, same height space)
4. Transfer vertex groups from body (nearest-face / poly interp)
5. Bind to body armature
6. Optional decimate for file size
7. Export self-contained GLB

Run:
  Blender --background --python scripts/prepare-unrigged-outfit.py -- \\
    --cloth path/to/cloth.fbx \\
    --body public/assets/simhuman/ubc-male.glb \\
    --output public/assets/simoutfits/_raw/male-athleisure.glb
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

# Prepared UBC raw height (matches prepare-sim-outfits / human5 contract).
TARGET_BODY_HEIGHT = 3.49


def log(msg: str) -> None:
    print(f"[prepare-unrigged-outfit] {msg}", flush=True)


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--cloth", type=Path, required=True, help="Unrigged cloth FBX/GLB/OBJ")
    p.add_argument("--body", type=Path, required=True, help="Prepared UBC body GLB (skinned)")
    p.add_argument("--output", type=Path, required=True, help="Output GLB path")
    p.add_argument(
        "--ease",
        type=float,
        default=1.02,
        help="Uniform height scale ease (default 1.02)",
    )
    p.add_argument(
        "--width-ease",
        type=float,
        default=1.08,
        help="Torso radial ease so cloth sits outside body chest (default 1.08)",
    )
    p.add_argument(
        "--no-auto-align",
        action="store_true",
        help="Skip height/width snap — cloth is already aligned in UBC bind space (Import Studio)",
    )
    p.add_argument(
        "--pose",
        type=Path,
        default=None,
        help="JSON map of DEF bone → {x,y,z} local euler degrees for weight-transfer pose",
    )
    p.add_argument(
        "--textures-from",
        type=Path,
        default=None,
        help="Optional FBX/GLB used only as a material/texture donor (geometry comes from --cloth)",
    )
    p.add_argument(
        "--max-verts",
        type=int,
        default=80000,
        help="Decimate cloth if vertex count exceeds this (0 = no decimate)",
    )
    p.add_argument(
        "--max-texture",
        type=int,
        default=2048,
        help="Downscale texture images larger than this edge length",
    )
    p.add_argument(
        "--expected-bind-height",
        type=float,
        default=None,
        help="Expected cloth height in raw UBC bind space (partial garments allowed)",
    )
    return p.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)


def import_asset(path: Path) -> list[bpy.types.Object]:
    before = set(bpy.data.objects)
    suffix = path.suffix.lower()
    log(f"import {path}")
    if suffix == ".fbx":
        bpy.ops.import_scene.fbx(
            filepath=str(path),
            use_image_search=True,
            ignore_leaf_bones=True,
            automatic_bone_orientation=False,
        )
    elif suffix in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(path))
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    else:
        raise RuntimeError(f"Unsupported cloth format: {suffix}")
    return [o for o in bpy.data.objects if o not in before]


def mesh_objects(tag: str | None = None) -> list[bpy.types.Object]:
    out = []
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        if tag is not None and not o.get(tag):
            continue
        out.append(o)
    return out


def world_bounds(objs: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    coords: list[Vector] = []
    for o in objs:
        mw = o.matrix_world
        for v in o.data.vertices:
            coords.append(mw @ v.co)
    if not coords:
        z = Vector((0, 0, 0))
        return z, z
    xs = [c.x for c in coords]
    ys = [c.y for c in coords]
    zs = [c.z for c in coords]
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def height_axis_span(mn: Vector, mx: Vector, prefer_up: bool = False) -> tuple[str, float, float, float]:
    """
    Pick vertical axis.
    For humanoid bodies prefer world Z (glTF→Blender) when it has a real height
    span — arm-span on X can exceed height and would otherwise win max().
    """
    spans = {
        "x": (mx.x - mn.x, mn.x, mx.x),
        "y": (mx.y - mn.y, mn.y, mx.y),
        "z": (mx.z - mn.z, mn.z, mx.z),
    }
    if prefer_up and spans["z"][0] > 0.5:
        axis = "z"
    else:
        # Prefer axis with feet near 0 and largest positive extent.
        def score(k: str) -> float:
            h, lo, hi = spans[k]
            foot = 1.0 / (1.0 + abs(lo))  # prefer lo≈0
            return h * foot
        axis = max(spans, key=score)
    h, lo, hi = spans[axis]
    return axis, h, lo, hi


def apply_object_transforms(objs: list[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
    if bpy.context.selected_objects:
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def band_radial_p90(
    objs: list[bpy.types.Object],
    z_lo: float,
    z_hi: float,
    cx: float,
    cy: float,
    max_r: float | None = None,
) -> float:
    """
    90th-percentile horizontal radius of verts in a Z band about (cx, cy).

    max_r filters outstretched arms on the body so torso girth is measured,
    not arm-span AABB (which previously over-squeezed baggy Meshy cloth).
    """
    rs: list[float] = []
    for o in objs:
        if o.type != "MESH":
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            c = mw @ v.co
            if c.z < z_lo or c.z > z_hi:
                continue
            r = math.hypot(c.x - cx, c.y - cy)
            if max_r is not None and r > max_r:
                continue
            rs.append(r)
    if len(rs) < 16:
        return 0.0
    rs.sort()
    return rs[int(len(rs) * 0.90)]


def cloth_roots(cloth_objs: list[bpy.types.Object]) -> list[bpy.types.Object]:
    roots: list[bpy.types.Object] = []
    for o in cloth_objs:
        r = o
        while r.parent is not None and (r.parent in cloth_objs or r.parent.get("__cloth")):
            r = r.parent
        if r not in roots:
            roots.append(r)
    for o in bpy.data.objects:
        if o.get("__cloth") and o.parent is None and o not in roots:
            roots.append(o)
    return roots


def scale_and_align_cloth(
    cloth_objs: list[bpy.types.Object],
    body_objs: list[bpy.types.Object],
    ease: float,
    width_ease: float = 1.08,
) -> None:
    # Prefer the single densest skinned body mesh (UBC SuperHero_*), not eyes/face helpers.
    skinned = [
        o for o in body_objs
        if o.type == "MESH" and len(o.vertex_groups) > 10 and len(o.data.vertices) > 2000
    ]
    body_for_bounds = [max(skinned, key=lambda o: len(o.data.vertices))] if skinned else body_objs
    log(f"body bounds mesh={body_for_bounds[0].name} verts={len(body_for_bounds[0].data.vertices)}")
    bmin, bmax = world_bounds(body_for_bounds)
    cmin, cmax = world_bounds(cloth_objs)
    b_axis, b_h, b_lo, b_hi = height_axis_span(bmin, bmax, prefer_up=True)
    c_axis, c_h, c_lo, c_hi = height_axis_span(cmin, cmax, prefer_up=False)
    log(f"body height axis={b_axis} span={b_h:.3f} [{b_lo:.3f},{b_hi:.3f}]")
    log(f"cloth height axis={c_axis} span={c_h:.3f} [{c_lo:.3f},{c_hi:.3f}]")

    if c_h < 1e-6:
        raise RuntimeError("Cloth has zero height")

    # Height: match body. Do NOT use arm-span. Slight ease for cloth thickness.
    s_h = (b_h / c_h) * ease
    roots = cloth_roots(cloth_objs)
    for r in roots:
        r.scale *= s_h
    bpy.context.view_layer.update()

    # Feet on body feet + center horizontally.
    cmin, cmax = world_bounds(cloth_objs)
    body_cx = 0.5 * (bmin.x + bmax.x)
    body_cy = 0.5 * (bmin.y + bmax.y)
    cloth_cx = 0.5 * (cmin.x + cmax.x)
    cloth_cy = 0.5 * (cmin.y + cmax.y)
    # Assume Blender Z-up for prepared UBC bodies.
    delta = Vector((
        body_cx - cloth_cx,
        body_cy - cloth_cy,
        b_lo - cmin.z,
    ))
    for r in roots:
        r.location += delta
    bpy.context.view_layer.update()

    # Width fit: mid-torso radial girth (not AABB — AABB + arm-span / baggy
    # sleeves over-squeezed the chest so body poked through side openings).
    # Band is pure ribcage; body verts beyond ~0.55 r are arms.
    chest_lo = b_lo + b_h * 0.55
    chest_hi = b_lo + b_h * 0.68
    body_r = band_radial_p90(body_for_bounds, chest_lo, chest_hi, body_cx, body_cy, max_r=0.55)
    cloth_r = band_radial_p90(cloth_objs, chest_lo, chest_hi, body_cx, body_cy, max_r=None)
    s_w = 1.0
    if body_r > 1e-4 and cloth_r > 1e-4:
        target_r = body_r * max(width_ease, 1.0)
        # Expand-only: baggy Meshy garments are already wider than the torso
        # after height match. Shrinking them (old AABB fit) made the chest too
        # narrow and the body poked through armholes/sides.
        if cloth_r < target_r:
            s_w = min(1.45, target_r / cloth_r)
            log(
                f"chest radial EXPAND body_p90={body_r:.3f} cloth_p90={cloth_r:.3f} "
                f"target={target_r:.3f} s_w={s_w:.4f} width_ease={width_ease}"
            )
            for r in roots:
                r.scale.x *= s_w
                r.scale.y *= s_w
            bpy.context.view_layer.update()
            # Re-center after non-uniform scale.
            cmin, cmax = world_bounds(cloth_objs)
            cloth_cx = 0.5 * (cmin.x + cmax.x)
            cloth_cy = 0.5 * (cmin.y + cmax.y)
            for r in roots:
                r.location.x += body_cx - cloth_cx
                r.location.y += body_cy - cloth_cy
                r.location.z += b_lo - cmin.z
            bpy.context.view_layer.update()
        else:
            log(
                f"chest radial keep baggy body_p90={body_r:.3f} cloth_p90={cloth_r:.3f} "
                f"target={target_r:.3f} s_w=1.0 width_ease={width_ease}"
            )
    else:
        log(f"chest radial skipped body_r={body_r:.3f} cloth_r={cloth_r:.3f}")

    cmin, cmax = world_bounds(cloth_objs)
    log(
        f"aligned cloth s_h={s_h:.4f} s_w={s_w:.4f} ease={ease} "
        f"AABB z[{cmin.z:.3f},{cmax.z:.3f}] x[{cmin.x:.3f},{cmax.x:.3f}] y[{cmin.y:.3f},{cmax.y:.3f}]"
    )


def pick_body_mesh() -> bpy.types.Object:
    meshes = mesh_objects("__body")
    if not meshes:
        raise RuntimeError("No body meshes")
    # Prefer most vertex groups (skinned body).
    return max(meshes, key=lambda o: (len(o.vertex_groups), len(o.data.vertices)))


def pick_body_armature() -> bpy.types.Object:
    for o in bpy.data.objects:
        if o.get("__body") and o.type == "ARMATURE":
            return o
    body = pick_body_mesh()
    arm = body.find_armature()
    if not arm:
        raise RuntimeError("Body has no armature")
    return arm


def join_cloth_meshes(cloth_objs: list[bpy.types.Object]) -> bpy.types.Object:
    meshes = [o for o in cloth_objs if o.type == "MESH" and len(o.data.vertices) > 0]
    if not meshes:
        raise RuntimeError("No cloth meshes")
    if len(meshes) == 1:
        return meshes[0]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def weld_cloth(obj: bpy.types.Object, threshold: float = 1e-5) -> None:
    """
    Merge duplicate vertices. Meshy/FBX cloth arrives as TRIANGLE SOUP (every
    triangle owns 3 private verts). Decimate on soup cannot edge-collapse —
    it deletes whole triangles, moth-eating the fabric. Welding restores
    connectivity (and usually drops the vert count under budget by itself).
    UVs live on face loops in Blender, so texture seams survive the weld.
    """
    import bmesh

    before = len(obj.data.vertices)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=threshold)
    bm.to_mesh(obj.data)
    bm.free()
    # Soup carries flat per-corner normals; without smooth shading the glTF
    # exporter re-splits every face corner and the file balloons back to soup
    # (with faceted lighting). Cloth wants smooth normals anyway.
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.update()
    log(f"weld verts {before} → {len(obj.data.vertices)} (threshold={threshold})")


def strip_emission(obj: bpy.types.Object) -> None:
    """
    Meshy materials often route base color through Emission; exported as-is
    the runtime adds a full-white emissive map on top of the albedo (glowing
    speckles). Zero out every emission input so glTF omits emissive entirely.
    """
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        for node in mat.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                for input_name in ("Emission Strength",):
                    inp = node.inputs.get(input_name)
                    if inp is None:
                        continue
                    for link in list(inp.links):
                        mat.node_tree.links.remove(link)
                    inp.default_value = 0.0
                emission_color = node.inputs.get("Emission Color") or node.inputs.get("Emission")
                if emission_color is not None:
                    for link in list(emission_color.links):
                        mat.node_tree.links.remove(link)
                    if len(emission_color.default_value) == 4:
                        emission_color.default_value = (0.0, 0.0, 0.0, 1.0)
            elif node.type == "EMISSION":
                strength = node.inputs.get("Strength")
                if strength is not None:
                    strength.default_value = 0.0
        log(f"stripped emission on material {mat.name}")


def decimate_if_needed(obj: bpy.types.Object, max_verts: int) -> None:
    if max_verts <= 0:
        return
    n = len(obj.data.vertices)
    if n <= max_verts:
        log(f"cloth verts {n} within budget")
        return
    ratio = max_verts / n
    log(f"decimate {n} → ~{max_verts} (ratio={ratio:.4f})")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new(name="Decimate", type="DECIMATE")
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=mod.name)
    log(f"cloth verts after decimate: {len(obj.data.vertices)}")


def load_pose_json(path: Path | None) -> dict:
    if path is None:
        return {}
    import json
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("Pose JSON must be an object of bone → {x,y,z}")
    return data


def sanitize_three_node_name(name: str) -> str:
    """Mirror THREE.PropertyBinding.sanitizeNodeName: spaces → _, strip []./:"""
    import re

    return re.sub(r"[\[\]\.:/]", "", re.sub(r"\s", "_", str(name)))


_SANITIZED_BONE_LOOKUP: dict[str, dict[str, str]] = {}


def find_pose_bone(arm: bpy.types.Object, raw_name: str):
    name = str(raw_name)
    pb = arm.pose.bones.get(name)
    if pb is None and not name.startswith("DEF-"):
        pb = arm.pose.bones.get(f"DEF-{name}")
    if pb is None and name.startswith("DEF-"):
        pb = arm.pose.bones.get(name[4:])
    if pb is None:
        # Browser pose payloads carry THREE runtime bone names: GLTFLoader
        # sanitizes glTF node names (DEF-upper_arm.L → DEF-upper_armL), while
        # Blender's importer keeps the dots. Match on sanitized forms.
        lookup = _SANITIZED_BONE_LOOKUP.get(arm.name)
        if lookup is None:
            lookup = {}
            for candidate in arm.pose.bones:
                lookup.setdefault(sanitize_three_node_name(candidate.name), candidate.name)
            _SANITIZED_BONE_LOOKUP[arm.name] = lookup
        hit = lookup.get(sanitize_three_node_name(name))
        if hit is not None:
            pb = arm.pose.bones.get(hit)
    return pb


def matrix_from_three_elements(values: list[float]) -> Matrix:
    """Build a mathutils row-major Matrix from Three.js column-major elements."""
    if not isinstance(values, list) or len(values) != 16:
        raise RuntimeError("Bone world-delta matrix must contain 16 numbers")
    return Matrix((
        (float(values[0]), float(values[4]), float(values[8]), float(values[12])),
        (float(values[1]), float(values[5]), float(values[9]), float(values[13])),
        (float(values[2]), float(values[6]), float(values[10]), float(values[14])),
        (float(values[3]), float(values[7]), float(values[11]), float(values[15])),
    ))


def apply_armature_pose(arm: bpy.types.Object, pose: dict) -> int:
    """Apply exact glTF world deltas, with legacy local Euler support."""
    if not pose:
        return 0

    if pose.get("format") == "bone-world-delta-v1":
        if pose.get("space") != "gltf-y-up":
            raise RuntimeError(f"Unsupported pose matrix space: {pose.get('space')}")
        bone_deltas = pose.get("bones")
        if not isinstance(bone_deltas, dict):
            raise RuntimeError("Matrix pose must contain a bones object")

        # glTF/Three: +Y up, Blender: +Z up. Blender's glTF importer also
        # chooses a bone-specific local roll, so apply each delta in armature
        # world space instead of attempting to reuse Three local rotations.
        gltf_to_blender = Matrix.Rotation(math.radians(90.0), 4, "X")
        blender_to_gltf = gltf_to_blender.inverted()
        resolved = []
        skipped = 0
        for raw_name, values in bone_deltas.items():
            pb = find_pose_bone(arm, raw_name)
            if pb is None:
                log(f"pose skip missing bone {raw_name}")
                skipped += 1
                continue
            resolved.append((pb, values))
        if bone_deltas and not resolved:
            # Zero matches means a bone name-space mismatch (browser sanitized
            # vs Blender dotted). Baking anyway transfers weights from a
            # T-pose body and ships a garment frozen in its authored pose.
            raise RuntimeError(
                f"Pose matched 0/{len(bone_deltas)} armature bones — "
                "browser/Blender bone name mismatch; refusing rest-pose bake"
            )
        if skipped:
            log(f"pose skipped {skipped}/{len(bone_deltas)} bones")

        # Parent first, then set every affected bone's absolute pose matrix.
        # Descendant deltas already include their parent's world movement.
        resolved.sort(key=lambda item: len(item[0].parent_recursive))
        for pb, values in resolved:
            delta_gltf = matrix_from_three_elements(values)
            delta_blender = gltf_to_blender @ delta_gltf @ blender_to_gltf
            pb.matrix = delta_blender @ pb.bone.matrix_local
            # pb.matrix assignment converts to matrix_basis using the parent's
            # EVALUATED pose, which is stale until a depsgraph update. Without
            # this, chained bones (forearm/hand under upper_arm) stack the
            # parent rotation twice: the "arms-down" body baked with arms
            # swung up/out (x span ±1.49, z 3.77) and every downstream bake
            # was self-consistently wrong — weights and inverse-skin shared
            # the corrupt matrices, so it only exploded at runtime.
            bpy.context.view_layer.update()
        log(f"applied exact glTF world-delta pose on {len(resolved)} bones")
        return len(resolved)

    # Backward compatibility for older saved pose JSON and verification input.
    arm.rotation_mode = "XYZ"
    applied = 0
    for raw_name, euler in pose.items():
        pb = find_pose_bone(arm, raw_name)
        if pb is None:
            log(f"pose skip missing bone {raw_name}")
            continue
        ex = math.radians(float(euler.get("x", 0) or 0))
        ey = math.radians(float(euler.get("y", 0) or 0))
        ez = math.radians(float(euler.get("z", 0) or 0))
        pb.rotation_mode = "XYZ"
        pb.rotation_euler[0] += ex
        pb.rotation_euler[1] += ey
        pb.rotation_euler[2] += ez
        applied += 1
    bpy.context.view_layer.update()
    log(f"applied pose on {applied} bones")
    return applied


def clear_armature_pose(arm: bpy.types.Object) -> None:
    for pb in arm.pose.bones:
        pb.matrix_basis.identity()
    bpy.context.view_layer.update()


def create_posed_body_transfer_source(
    body: bpy.types.Object,
    arm: bpy.types.Object,
) -> bpy.types.Object:
    """
    Duplicate the body and bake its currently evaluated armature deformation.

    DATA_TRANSFER can sample the source mesh before its Armature modifier, which
    makes a posed import silently transfer weights against the bind-pose body.
    Applying the modifier on a disposable duplicate gives the transfer an
    unambiguous posed surface while preserving the real body's rest rig.
    """
    posed_body = body.copy()
    posed_body.data = body.data.copy()
    posed_body.name = f"{body.name}__POSED_WEIGHT_SOURCE"
    posed_body.data.name = f"{body.data.name}__POSED_WEIGHT_SOURCE"
    posed_body.animation_data_clear()
    bpy.context.collection.objects.link(posed_body)

    bpy.ops.object.select_all(action="DESELECT")
    posed_body.select_set(True)
    bpy.context.view_layer.objects.active = posed_body

    # Blender refuses to apply an Armature modifier while shape keys exist.
    # This is a disposable mesh-data copy, so bake its current key mix and
    # remove the keys here; the real body keeps every morph untouched.
    if posed_body.data.shape_keys is not None:
        key_count = len(posed_body.data.shape_keys.key_blocks)
        mixed_key = posed_body.shape_key_add(name="__POSED_TRANSFER_MIX", from_mix=True)
        mixed_coords = [point.co.copy() for point in mixed_key.data]
        for key_block in reversed(list(posed_body.data.shape_keys.key_blocks)):
            posed_body.shape_key_remove(key_block)
        for vertex, co in zip(posed_body.data.vertices, mixed_coords):
            vertex.co = co
        posed_body.data.update()
        log(f"posed transfer source baked current mix and removed {key_count} shape keys")

    applied = 0
    for mod in list(posed_body.modifiers):
        if mod.type != "ARMATURE" or (mod.object is not None and mod.object != arm):
            continue
        bpy.ops.object.modifier_apply(modifier=mod.name)
        applied += 1
    if applied == 0:
        bpy.data.objects.remove(posed_body, do_unlink=True)
        raise RuntimeError(
            f"Body {body.name} has no armature modifier to bake for posed weight transfer"
        )

    bpy.context.view_layer.update()
    pmin, pmax = world_bounds([posed_body])
    log(
        f"posed transfer source baked modifiers={applied} "
        f"AABB z[{pmin.z:.3f},{pmax.z:.3f}] "
        f"x[{pmin.x:.3f},{pmax.x:.3f}] y[{pmin.y:.3f},{pmax.y:.3f}]"
    )
    return posed_body


def bone_deform_matrix_in_object_space(
    arm: bpy.types.Object,
    obj: bpy.types.Object,
    bone_name: str,
) -> Matrix | None:
    """Return this pose bone's linear-blend skin matrix in ``obj`` local space."""
    pb = arm.pose.bones.get(bone_name)
    if pb is None or not pb.bone.use_deform:
        return None
    # pose.matrix and bone.matrix_local are both armature-object-space.
    bone_pose_from_rest = pb.matrix @ pb.bone.matrix_local.inverted()
    return (
        obj.matrix_world.inverted()
        @ arm.matrix_world
        @ bone_pose_from_rest
        @ arm.matrix_world.inverted()
        @ obj.matrix_world
    )


def inverse_skin_cloth_to_rest(cloth: bpy.types.Object, arm: bpy.types.Object) -> None:
    """
    Convert authored posed cloth vertices into the armature's bind space.

    The garment is aligned to the posed body when weights are sampled. Merely
    clearing the armature afterwards leaves those vertex coordinates in the
    arms-down (or crouched) shape. For each vertex, invert its blended skinning
    matrix so applying the same pose reconstructs the authored cloth exactly;
    the exported mesh then sits correctly in T-pose/rest space.
    """
    group_names = {group.index: group.name for group in cloth.vertex_groups}
    deform_matrices: dict[str, Matrix] = {}
    for name in group_names.values():
        matrix = bone_deform_matrix_in_object_space(arm, cloth, name)
        if matrix is not None:
            deform_matrices[name] = matrix

    converted = 0
    missing = 0
    singular = 0
    max_move = 0.0
    sum_move_sq = 0.0

    for vertex in cloth.data.vertices:
        influences: list[tuple[float, Matrix]] = []
        total = 0.0
        for assignment in vertex.groups:
            name = group_names.get(assignment.group)
            matrix = deform_matrices.get(name) if name else None
            weight = float(assignment.weight)
            if matrix is None or weight <= 1e-8:
                continue
            influences.append((weight, matrix))
            total += weight

        if total <= 1e-8:
            missing += 1
            continue

        blended = Matrix.Identity(4)
        blended.zero()
        inv_total = 1.0 / total
        for weight, matrix in influences:
            normalized_weight = weight * inv_total
            for row in range(4):
                for col in range(4):
                    blended[row][col] += matrix[row][col] * normalized_weight

        posed_co = vertex.co.copy()
        try:
            vertex.co = blended.inverted() @ posed_co
        except ValueError:
            singular += 1
            continue
        move = (vertex.co - posed_co).length
        max_move = max(max_move, move)
        sum_move_sq += move * move
        converted += 1

    cloth.data.update()
    rms_move = math.sqrt(sum_move_sq / max(converted, 1))
    log(
        f"inverse-skinned cloth pose→rest converted={converted}/{len(cloth.data.vertices)} "
        f"missing={missing} singular={singular} rms_move={rms_move:.5f} max_move={max_move:.5f}"
    )
    if missing or singular:
        raise RuntimeError(
            f"Could not inverse-skin all cloth vertices (missing={missing}, singular={singular})"
        )


def copy_textures_from_donor(cloth: bpy.types.Object, donor_path: Path) -> None:
    """
    Import a donor FBX/GLB solely for its materials/images and assign the first
    usable material to the cloth mesh. Geometry alignment stays on --cloth.
    """
    if not donor_path or not donor_path.is_file():
        return
    log(f"texture donor {donor_path}")
    before = set(bpy.data.objects)
    before_mats = set(bpy.data.materials)
    before_images = set(bpy.data.images)
    try:
        import_asset(donor_path)
    except Exception as exc:
        log(f"texture donor import failed: {exc}")
        return

    donor_objs = [o for o in bpy.data.objects if o not in before]
    donor_meshes = [o for o in donor_objs if o.type == "MESH"]
    # Prefer a material that actually has an image texture.
    best_mat = None
    for o in donor_meshes:
        for slot in o.material_slots:
            mat = slot.material
            if not mat or not mat.use_nodes:
                continue
            has_img = False
            for node in mat.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image and node.image.size[0] > 0:
                    has_img = True
                    break
            if has_img:
                best_mat = mat
                break
        if best_mat:
            break
    if best_mat is None:
        # Fall back to any material from the donor.
        new_mats = [m for m in bpy.data.materials if m not in before_mats]
        best_mat = new_mats[0] if new_mats else None
    if best_mat is None:
        log("texture donor: no materials found")
    else:
        cloth.data.materials.clear()
        cloth.data.materials.append(best_mat)
        log(f"texture donor: assigned material {best_mat.name}")
        # Log image sizes for debugging corrupted embeds.
        if best_mat.use_nodes:
            for node in best_mat.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image:
                    img = node.image
                    log(f"  image {img.name} {int(img.size[0])}x{int(img.size[1])}")

    # Remove donor objects (keep materials/images they own).
    for o in donor_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    # Drop unused leftover meshes from donor that didn't transfer.
    for img in list(bpy.data.images):
        if img in before_images:
            continue
        # keep images referenced by best_mat
        pass


def transfer_weights(body: bpy.types.Object, cloth: bpy.types.Object) -> None:
    log(f"transfer weights {body.name} → {cloth.name}")
    # Ensure cloth is selectable mesh.
    bpy.ops.object.select_all(action="DESELECT")
    cloth.select_set(True)
    bpy.context.view_layer.objects.active = cloth

    # Create matching empty groups.
    existing = {g.name for g in cloth.vertex_groups}
    for vg in body.vertex_groups:
        if vg.name not in existing:
            cloth.vertex_groups.new(name=vg.name)

    mod = cloth.modifiers.new(name="WeightTransfer", type="DATA_TRANSFER")
    mod.object = body
    mod.use_vert_data = True
    mod.data_types_verts = {"VGROUP_WEIGHTS"}
    # Poly-interp nearest is more stable than nearest vertex for dense Meshy meshes.
    mod.vert_mapping = "POLYINTERP_NEAREST"
    mod.layers_vgroup_select_src = "ALL"
    mod.mix_mode = "REPLACE"
    mod.mix_factor = 1.0

    bpy.ops.object.datalayout_transfer(modifier=mod.name)
    bpy.ops.object.modifier_apply(modifier=mod.name)

    # Normalize weights (sum to 1, max 4 influences).
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    try:
        bpy.ops.object.vertex_group_limit_total(limit=4)
        # limit_total can remove low influences; normalize the kept four again
        # so inverse skinning and glTF runtime deformation use the same sum.
        bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    except Exception as exc:
        log(f"limit_total skipped: {exc}")

    # Report coverage.
    assigned = 0
    for v in cloth.data.vertices:
        if v.groups:
            assigned += 1
    log(f"weight coverage {assigned}/{len(cloth.data.vertices)} verts")


def bind_armature(cloth: bpy.types.Object, arm: bpy.types.Object) -> None:
    log(f"bind armature {arm.name}")
    # Clear parent keep transform then parent to armature.
    bpy.ops.object.select_all(action="DESELECT")
    cloth.select_set(True)
    bpy.context.view_layer.objects.active = cloth
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")

    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    cloth.select_set(True)
    bpy.ops.object.parent_set(type="ARMATURE_NAME")

    # Ensure armature modifier exists and uses groups.
    arm_mod = None
    for m in cloth.modifiers:
        if m.type == "ARMATURE":
            arm_mod = m
            break
    if arm_mod is None:
        arm_mod = cloth.modifiers.new(name="Armature", type="ARMATURE")
    arm_mod.object = arm
    arm_mod.use_vertex_groups = True
    arm_mod.use_deform_preserve_volume = True


def downscale_images(max_edge: int) -> None:
    if max_edge <= 0:
        return
    for img in bpy.data.images:
        if img.size[0] <= 0 or img.size[1] <= 0:
            continue
        w, h = int(img.size[0]), int(img.size[1])
        if w <= max_edge and h <= max_edge:
            continue
        scale = max_edge / max(w, h)
        nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
        log(f"resize image {img.name} {w}x{h} → {nw}x{nh}")
        img.scale(nw, nh)


def export_glb(path: Path, cloth: bpy.types.Object, arm: bpy.types.Object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    cloth.select_set(True)
    arm.select_set(True)
    # Select armature hierarchy roots
    for o in bpy.data.objects:
        if o.type == "ARMATURE" and o.get("__body"):
            o.select_set(True)

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
        export_morph=False,
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
            export_materials="EXPORT",
            export_yup=True,
        )
    log(f"wrote {path} ({path.stat().st_size / 1024 / 1024:.2f} MiB)")


def rebind_missing_textures(cloth_dir: Path) -> None:
    """Point empty images at files next to the FBX."""
    if not cloth_dir.is_dir():
        return
    index = {}
    for p in cloth_dir.rglob("*"):
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".tga"}:
            index[p.name.lower()] = p
            index[p.stem.lower()] = p
    for img in bpy.data.images:
        if img.size[0] > 0 and img.size[1] > 0:
            continue
        name = Path(img.name).name
        stem = Path(name).stem
        hit = index.get(name.lower()) or index.get(stem.lower())
        if not hit:
            # fuzzy: contains
            for k, p in index.items():
                if stem.lower() in k or k in stem.lower():
                    hit = p
                    break
        if hit:
            img.filepath = str(hit.resolve())
            img.source = "FILE"
            img.reload()
            log(f"rebound texture {img.name} → {hit.name}")


def main() -> int:
    args = parse_args()
    if not args.cloth.is_file():
        log(f"ERROR missing cloth {args.cloth}")
        return 1
    if not args.body.is_file():
        log(f"ERROR missing body {args.body}")
        return 1

    clear_scene()

    # Body first.
    body_new = import_asset(args.body)
    for o in body_new:
        o["__body"] = True
    body_meshes = mesh_objects("__body")
    if not body_meshes:
        log("ERROR: no body meshes after import")
        return 1
    body = pick_body_mesh()
    arm = pick_body_armature()
    log(f"body mesh={body.name} verts={len(body.data.vertices)} groups={len(body.vertex_groups)}")
    log(f"armature={arm.name} bones={len(arm.data.bones)}")

    # Cloth.
    cloth_new = import_asset(args.cloth)
    for o in cloth_new:
        o["__cloth"] = True
    rebind_missing_textures(args.cloth.parent)
    cloth_meshes = [o for o in mesh_objects() if o.get("__cloth") and o.type == "MESH"]
    if not cloth_meshes:
        log("ERROR: no cloth meshes")
        return 1

    if args.no_auto_align:
        log("skip auto-align (cloth already in bind space)")
    else:
        scale_and_align_cloth(
            cloth_meshes,
            body_meshes,
            ease=args.ease,
            width_ease=args.width_ease,
        )
    apply_object_transforms([o for o in bpy.data.objects if o.get("__cloth") and o.type == "MESH"])

    cloth = join_cloth_meshes([o for o in bpy.data.objects if o.get("__cloth") and o.type == "MESH"])
    cloth.name = "Athleisure"
    cloth["__cloth"] = True

    # Prefer real textures from the original Meshy FBX when the client GLB lost them.
    if args.textures_from:
        copy_textures_from_donor(cloth, args.textures_from)

    # Weld BEFORE decimate: triangle-soup input (FBX/Meshy) must regain shared
    # vertices or decimate deletes whole triangles instead of collapsing edges.
    weld_cloth(cloth)
    strip_emission(cloth)
    decimate_if_needed(cloth, args.max_verts)
    downscale_images(args.max_texture)

    pose = load_pose_json(args.pose)
    posed = apply_armature_pose(arm, pose) > 0

    # DATA_TRANSFER may read the source before its Armature modifier. Bake the
    # evaluated pose onto a disposable body duplicate so the sampled surface
    # definitely matches the authored garment pose.
    transfer_source = body
    if posed:
        transfer_source = create_posed_body_transfer_source(body, arm)
    try:
        transfer_weights(transfer_source, cloth)
    finally:
        if transfer_source != body and transfer_source.name in bpy.data.objects:
            bpy.data.objects.remove(transfer_source, do_unlink=True)

    # Weight lookup happened in posed space. Backsolve the garment into bind
    # space before resetting the real armature; at runtime the same pose will
    # reconstruct the imported arms-down/crouched shape.
    if posed:
        inverse_skin_cloth_to_rest(cloth, arm)

    # Always return armature to rest before bind/export so inverse-bind
    # matrices match runtime rest skeletons.
    clear_armature_pose(arm)
    bpy.context.view_layer.update()

    bind_armature(cloth, arm)

    # Drop body meshes + any leftover helpers (Icosphere, eyes) from the scene
    # so they cannot pollute the export selection.
    for o in list(bpy.data.objects):
        if o.get("__body") and o.type == "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
        elif o.type == "MESH" and not o.get("__cloth") and o != cloth:
            if "ico" in o.name.lower() or o.name.startswith("Sphere"):
                bpy.data.objects.remove(o, do_unlink=True)

    # Sanity: compare to this garment's client-measured bind height when the
    # Import Studio supplied one. Partial garments need not span the full body.
    cmin, cmax = world_bounds([cloth])
    ch = cmax.z - cmin.z
    log(f"pre-export cloth AABB z[{cmin.z:.3f},{cmax.z:.3f}] h={ch:.3f} posed_transfer={posed}")
    if args.expected_bind_height is not None:
        tolerance = max(0.12, args.expected_bind_height * 0.35)
        if abs(ch - args.expected_bind_height) > tolerance:
            log(
                f"WARNING: cloth height {ch:.3f} differs from expected partial/full "
                f"garment height {args.expected_bind_height:.3f}"
            )
    elif ch < 2.0 or ch > 5.5:
        log(f"WARNING: cloth height {ch:.3f} looks wrong for UBC bind (~3.49)")

    export_glb(args.output, cloth, arm)

    if not args.output.is_file():
        log("ERROR: output missing")
        return 1
    if args.output.stat().st_size >= 25 * 1024 * 1024:
        log("WARNING: output exceeds 25 MiB Cloudflare limit — consider lower --max-verts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
