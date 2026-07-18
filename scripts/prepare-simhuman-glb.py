#!/usr/bin/env python3
"""
Prepare an arbitrary human GLB for the Dreamfall simhuman / vibe-human contract.

What this CAN automate (Blender headless):
  - Import GLB and report skeleton/mesh/morph inventory
  - Normalize height so raw mesh Y-span ≈ human5 (~3.49 units) with feet at y≈0
  - Detect Mixamo vs Rigify DEF skeletons
  - Rename Mixamo body bones → DEF-* names used by rigify retarget
  - Generate a Rigify human (meta-rig scaled to mesh) + automatic weights
  - Name likely eye meshes Eye_L / Eye_R
  - Transfer shape keys from human5.glb onto the body mesh (nearest-surface)
  - Strip materials/images and export a contract-clean GLB

What this CANNOT invent:
  - Artist-quality identity morphs for a totally different face topology
    (transfer is a geometric projection from human5 — useful baseline, not magic)
  - Perfect face bone placement / FACS without a good face mesh + weights
  - UVs that match the shipped head/body PBR sets (you may need new textures)

Run (prefer the node wrapper):
  node scripts/prepare-simhuman.mjs input.glb -o public/assets/simhuman/custom.glb

Or directly:
  /Applications/Blender.app/Contents/MacOS/Blender --background \\
    --python scripts/prepare-simhuman-glb.py -- \\
    --input path/to/body.glb --output path/to/out.glb --mode full
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REFERENCE = REPO_ROOT / "public/assets/simhuman/human5.glb"

# human5 raw position Y span is ~3.49; runtime scales to 1.75 m.
TARGET_RAW_HEIGHT = 3.49
HEAD_GEOMETRY_MIN_Y = 2.65

# Unreal / Epic-style humanoid (Universal Base Characters, UE mannequin family)
# → Rigify DEF names used by Dreamfall retarget + runtime.
UE_TO_DEF = {
    "root": "root",
    "pelvis": "DEF-spine",
    "spine_01": "DEF-spine.001",
    "spine_02": "DEF-spine.002",
    "spine_03": "DEF-spine.003",
    "neck_01": "DEF-spine.005",
    "neck_02": "DEF-spine.005",
    "Head": "DEF-spine.006",
    "head": "DEF-spine.006",
    "clavicle_l": "DEF-shoulder.L",
    "clavicle_r": "DEF-shoulder.R",
    "upperarm_l": "DEF-upper_arm.L",
    "upperarm_r": "DEF-upper_arm.R",
    "lowerarm_l": "DEF-forearm.L.001",
    "lowerarm_r": "DEF-forearm.R.001",
    "hand_l": "DEF-hand.L",
    "hand_r": "DEF-hand.R",
    "thigh_l": "DEF-thigh.L",
    "thigh_r": "DEF-thigh.R",
    "calf_l": "DEF-thigh.L.001",
    "calf_r": "DEF-thigh.R.001",
    "foot_l": "DEF-foot.L",
    "foot_r": "DEF-foot.R",
    "ball_l": "DEF-toe.L",
    "ball_r": "DEF-toe.R",
    "ball_leaf_l": "DEF-toe.L",
    "ball_leaf_r": "DEF-toe.R",
    # Fingers
    "thumb_01_l": "DEF-thumb.01.L",
    "thumb_02_l": "DEF-thumb.02.L",
    "thumb_03_l": "DEF-thumb.03.L",
    "index_01_l": "DEF-f_index.01.L",
    "index_02_l": "DEF-f_index.02.L",
    "index_03_l": "DEF-f_index.03.L",
    "middle_01_l": "DEF-f_middle.01.L",
    "middle_02_l": "DEF-f_middle.02.L",
    "middle_03_l": "DEF-f_middle.03.L",
    "ring_01_l": "DEF-f_ring.01.L",
    "ring_02_l": "DEF-f_ring.02.L",
    "ring_03_l": "DEF-f_ring.03.L",
    "pinky_01_l": "DEF-f_pinky.01.L",
    "pinky_02_l": "DEF-f_pinky.02.L",
    "pinky_03_l": "DEF-f_pinky.03.L",
    "thumb_01_r": "DEF-thumb.01.R",
    "thumb_02_r": "DEF-thumb.02.R",
    "thumb_03_r": "DEF-thumb.03.R",
    "index_01_r": "DEF-f_index.01.R",
    "index_02_r": "DEF-f_index.02.R",
    "index_03_r": "DEF-f_index.03.R",
    "middle_01_r": "DEF-f_middle.01.R",
    "middle_02_r": "DEF-f_middle.02.R",
    "middle_03_r": "DEF-f_middle.03.R",
    "ring_01_r": "DEF-f_ring.01.R",
    "ring_02_r": "DEF-f_ring.02.R",
    "ring_03_r": "DEF-f_ring.03.R",
    "pinky_01_r": "DEF-f_pinky.01.R",
    "pinky_02_r": "DEF-f_pinky.02.R",
    "pinky_03_r": "DEF-f_pinky.03.R",
}

# Mixamo → Rigify DEF (body only). Face bones stay Mixamo/absent.
MIXAMO_TO_DEF = {
    "mixamorigHips": "DEF-spine",
    "mixamorigSpine": "DEF-spine.001",
    "mixamorigSpine1": "DEF-spine.002",
    "mixamorigSpine2": "DEF-spine.003",
    "mixamorigNeck": "DEF-spine.005",
    "mixamorigHead": "DEF-spine.006",
    "mixamorigLeftShoulder": "DEF-shoulder.L",
    "mixamorigLeftArm": "DEF-upper_arm.L",
    "mixamorigLeftForeArm": "DEF-forearm.L.001",
    "mixamorigLeftHand": "DEF-hand.L",
    "mixamorigRightShoulder": "DEF-shoulder.R",
    "mixamorigRightArm": "DEF-upper_arm.R",
    "mixamorigRightForeArm": "DEF-forearm.R.001",
    "mixamorigRightHand": "DEF-hand.R",
    "mixamorigLeftHandThumb1": "DEF-thumb.01.L",
    "mixamorigLeftHandThumb2": "DEF-thumb.02.L",
    "mixamorigLeftHandThumb3": "DEF-thumb.03.L",
    "mixamorigLeftHandIndex1": "DEF-f_index.01.L",
    "mixamorigLeftHandIndex2": "DEF-f_index.02.L",
    "mixamorigLeftHandIndex3": "DEF-f_index.03.L",
    "mixamorigLeftHandMiddle1": "DEF-f_middle.01.L",
    "mixamorigLeftHandMiddle2": "DEF-f_middle.02.L",
    "mixamorigLeftHandMiddle3": "DEF-f_middle.03.L",
    "mixamorigLeftHandRing1": "DEF-f_ring.01.L",
    "mixamorigLeftHandRing2": "DEF-f_ring.02.L",
    "mixamorigLeftHandRing3": "DEF-f_ring.03.L",
    "mixamorigLeftHandPinky1": "DEF-f_pinky.01.L",
    "mixamorigLeftHandPinky2": "DEF-f_pinky.02.L",
    "mixamorigLeftHandPinky3": "DEF-f_pinky.03.L",
    "mixamorigRightHandThumb1": "DEF-thumb.01.R",
    "mixamorigRightHandThumb2": "DEF-thumb.02.R",
    "mixamorigRightHandThumb3": "DEF-thumb.03.R",
    "mixamorigRightHandIndex1": "DEF-f_index.01.R",
    "mixamorigRightHandIndex2": "DEF-f_index.02.R",
    "mixamorigRightHandIndex3": "DEF-f_index.03.R",
    "mixamorigRightHandMiddle1": "DEF-f_middle.01.R",
    "mixamorigRightHandMiddle2": "DEF-f_middle.02.R",
    "mixamorigRightHandMiddle3": "DEF-f_middle.03.R",
    "mixamorigRightHandRing1": "DEF-f_ring.01.R",
    "mixamorigRightHandRing2": "DEF-f_ring.02.R",
    "mixamorigRightHandRing3": "DEF-f_ring.03.R",
    "mixamorigRightHandPinky1": "DEF-f_pinky.01.R",
    "mixamorigRightHandPinky2": "DEF-f_pinky.02.R",
    "mixamorigRightHandPinky3": "DEF-f_pinky.03.R",
    "mixamorigLeftUpLeg": "DEF-thigh.L",
    "mixamorigLeftLeg": "DEF-thigh.L.001",
    "mixamorigLeftFoot": "DEF-foot.L",
    "mixamorigLeftToeBase": "DEF-toe.L",
    "mixamorigRightUpLeg": "DEF-thigh.R",
    "mixamorigRightLeg": "DEF-thigh.R.001",
    "mixamorigRightFoot": "DEF-foot.R",
    "mixamorigRightToeBase": "DEF-toe.R",
}


def log(msg: str) -> None:
    print(f"[prepare-simhuman] {msg}", flush=True)


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    p = argparse.ArgumentParser(description="Prepare a human GLB for simhuman.")
    p.add_argument("--input", type=Path, required=True, help="Source body GLB/GLTF")
    p.add_argument("--output", type=Path, help="Output GLB path (required except --mode inspect)")
    p.add_argument(
        "--mode",
        choices=("inspect", "normalize", "full"),
        default="full",
        help="inspect=report only; normalize=scale+strip+export; full=rig+morphs+export",
    )
    p.add_argument(
        "--reference",
        type=Path,
        default=DEFAULT_REFERENCE,
        help="human5.glb (or compatible) used as morph/skeleton reference",
    )
    p.add_argument("--target-height", type=float, default=TARGET_RAW_HEIGHT)
    p.add_argument("--no-rigify", action="store_true", help="Skip Rigify generation")
    p.add_argument("--no-rename-mixamo", action="store_true", help="Skip Mixamo→DEF rename")
    p.add_argument("--no-transfer-morphs", action="store_true", help="Skip shape-key transfer")
    p.add_argument(
        "--morph-limit",
        type=int,
        default=0,
        help="Transfer at most N morphs (0 = all). Useful for fast iteration.",
    )
    p.add_argument(
        "--keep-materials",
        action="store_true",
        help="Keep materials (default strips them; runtime assigns skin mats)",
    )
    p.add_argument(
        "--report-json",
        type=Path,
        help="Write a machine-readable inventory/report JSON",
    )
    return p.parse_args(argv)


def reset_scene() -> None:
    bpy.ops.wm.read_homefile(use_empty=True)
    # Blender 4/5 empty templates can still leave a leftover mesh/light/camera.
    try:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=True)
    except Exception:
        pass
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (
        bpy.data.meshes,
        bpy.data.armatures,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for item in list(block):
            try:
                block.remove(item)
            except Exception:
                pass


DEFAULT_JUNK_NAMES = {
    "Cube", "Icosphere", "Sphere", "Plane", "Cylinder", "Cone",
    "Light", "Camera", "Lamp", "Sun",
}


def purge_default_junk() -> int:
    """Remove leftover startup primitives that are not skinned and have no morphs."""
    removed = 0
    for obj in list(bpy.data.objects):
        base = obj.name.split(".")[0]
        if base not in DEFAULT_JUNK_NAMES:
            continue
        if obj.type == "MESH":
            has_morphs = bool(obj.data.shape_keys and len(obj.data.shape_keys.key_blocks) > 1)
            has_skin = any(mod.type == "ARMATURE" for mod in obj.modifiers)
            # human5 eyes are named Sphere / Sphere.001 and ARE skinned — keep those.
            if has_morphs or has_skin or len(obj.data.vertices) > 100:
                continue
        elif obj.type not in ("LIGHT", "CAMERA", "EMPTY"):
            continue
        bpy.data.objects.remove(obj, do_unlink=True)
        removed += 1
    if removed:
        log(f"Purged {removed} default scene leftovers")
    return removed


def enable_rigify() -> None:
    import addon_utils

    # Blender 3–5 module name variants
    for name in ("rigify", "bl_ext.blender_org.rigify"):
        try:
            addon_utils.enable(name, default_set=True, persistent=True)
        except Exception:
            pass
    # Ensure preferences exist
    prefs = bpy.context.preferences.addons
    if "rigify" not in prefs and "bl_ext.blender_org.rigify" not in prefs:
        log("WARNING: could not enable Rigify addon — --rigify steps may fail")


def import_gltf(path: Path) -> None:
    path = path.resolve()
    if not path.exists():
        raise FileNotFoundError(path)
    ext = path.suffix.lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=str(path))
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path), use_anim=False, use_image_search=False)
    else:
        raise ValueError(f"Unsupported input extension: {ext}")


def mesh_objects() -> list[bpy.types.Object]:
    return [o for o in bpy.data.objects if o.type == "MESH" and o.data]


def armature_objects() -> list[bpy.types.Object]:
    return [o for o in bpy.data.objects if o.type == "ARMATURE"]


def world_mesh_bounds(objs: list[bpy.types.Object] | None = None) -> tuple[Vector, Vector]:
    objs = objs or mesh_objects()
    mins = Vector((math.inf, math.inf, math.inf))
    maxs = Vector((-math.inf, -math.inf, -math.inf))
    any_vert = False
    for obj in objs:
        mw = obj.matrix_world
        for v in obj.data.vertices:
            co = mw @ v.co
            any_vert = True
            mins.x = min(mins.x, co.x)
            mins.y = min(mins.y, co.y)
            mins.z = min(mins.z, co.z)
            maxs.x = max(maxs.x, co.x)
            maxs.y = max(maxs.y, co.y)
            maxs.z = max(maxs.z, co.z)
    if not any_vert:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    return mins, maxs


def dominant_up_axis(mins: Vector, maxs: Vector) -> str:
    spans = {"x": maxs.x - mins.x, "y": maxs.y - mins.y, "z": maxs.z - mins.z}
    return max(spans, key=spans.get)


def height_span(mins: Vector, maxs: Vector, up: str) -> float:
    if up == "x":
        return maxs.x - mins.x
    if up == "y":
        return maxs.y - mins.y
    return maxs.z - mins.z


def min_on_axis(mins: Vector, up: str) -> float:
    return getattr(mins, up)


def shift_roots_on_axis(delta: float, up: str) -> None:
    for obj in bpy.data.objects:
        if obj.parent is not None:
            continue
        if up == "x":
            obj.location.x += delta
        elif up == "y":
            obj.location.y += delta
        else:
            obj.location.z += delta


def normalize_height(target_height: float) -> dict:
    """
    Scale the scene so the character's up-axis span ≈ target_height and feet sit at 0.

    Blender is Z-up. The glTF importer converts glTF (+Y up) into Blender (+Z up).
    We stay in Blender space here; export_yup=True rewrites to glTF Y-up on write.
    Do NOT force a Y-up rotation inside Blender — that double-converts glTF imports.
    """
    mins, maxs = world_mesh_bounds()
    up = dominant_up_axis(mins, maxs)
    # Prefer Z when nearly equal (Blender native) to avoid treating wide shoulders as height.
    y_span = maxs.y - mins.y
    z_span = maxs.z - mins.z
    if z_span >= y_span * 0.9:
        up = "z"
    report = {"up_axis": up, "bounds_before": {"min": list(mins), "max": list(maxs)}}

    height = max(1e-6, height_span(mins, maxs, up))
    scale = target_height / height
    log(f"Normalizing height {height:.3f} → {target_height:.3f} along {up.upper()} (scale={scale:.4f})")

    for obj in bpy.data.objects:
        if obj.parent is None:
            obj.scale *= scale
    bpy.context.view_layer.update()
    mins, maxs = world_mesh_bounds()
    shift_roots_on_axis(-min_on_axis(mins, up), up)
    bpy.context.view_layer.update()

    # Apply transforms on armatures/meshes for a clean bind pose export
    for obj in list(bpy.data.objects):
        if obj.type not in ("MESH", "ARMATURE"):
            continue
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        except RuntimeError as exc:
            log(f"transform_apply skipped on {obj.name}: {exc}")

    bpy.context.view_layer.update()
    mins, maxs = world_mesh_bounds()
    report["bounds_after"] = {"min": list(mins), "max": list(maxs)}
    report["height_after"] = height_span(mins, maxs, up)
    report["scale"] = scale
    return report


def bone_inventory(arm: bpy.types.Object) -> dict:
    names = [b.name for b in arm.data.bones]
    def_names = [n for n in names if n.startswith("DEF-")]
    mixamo = [n for n in names if n.lower().startswith("mixamorig")]
    return {
        "name": arm.name,
        "bone_count": len(names),
        "def_count": len(def_names),
        "mixamo_count": len(mixamo),
        "sample": names[:20],
        "def_sample": def_names[:20],
    }


def morph_inventory(obj: bpy.types.Object) -> list[str]:
    keys = obj.data.shape_keys
    if not keys:
        return []
    return [kb.name for kb in keys.key_blocks if kb.name != "Basis"]


def scene_report() -> dict:
    arms = [bone_inventory(a) for a in armature_objects()]
    meshes = []
    for m in mesh_objects():
        mins, maxs = world_mesh_bounds([m])
        meshes.append(
            {
                "name": m.name,
                "verts": len(m.data.vertices),
                "faces": len(m.data.polygons),
                "morphs": morph_inventory(m),
                "morph_count": len(morph_inventory(m)),
                "bounds": {"min": list(mins), "max": list(maxs)},
                "has_armature_mod": any(mod.type == "ARMATURE" for mod in m.modifiers),
            }
        )
    mins, maxs = world_mesh_bounds()
    up = dominant_up_axis(mins, maxs) if math.isfinite(mins.x) else "z"
    if math.isfinite(mins.z) and (maxs.z - mins.z) >= (maxs.y - mins.y) * 0.9:
        up = "z"
    return {
        "armatures": arms,
        "meshes": meshes,
        "bounds": {"min": list(mins), "max": list(maxs)},
        "up_axis": up,
        "height": height_span(mins, maxs, up) if math.isfinite(mins.x) else 0,
        "materials": len(bpy.data.materials),
        "images": len(bpy.data.images),
    }


def strip_name_prefix(name: str) -> str:
    # glTF import sometimes prefixes; normalize mixamo names
    n = name
    for prefix in ("mixamorig:", "mixamorig_", "mixamorig"):
        if n.startswith(prefix) and not n.startswith("mixamorigHips"):
            # keep mixamorigHips style — already correct
            pass
    # Collapse mixamorig:Hips → mixamorigHips
    if n.startswith("mixamorig:"):
        n = "mixamorig" + n[len("mixamorig:") :]
    return n


def _lookup_bone_map(name: str, mapping: dict) -> str | None:
    if name in mapping:
        return mapping[name]
    lower = {k.lower(): v for k, v in mapping.items()}
    return lower.get(name.lower())


def rename_bones_with_map(mapping: dict, label: str) -> dict:
    renamed = 0
    skipped = []
    for arm in armature_objects():
        bpy.ops.object.select_all(action="DESELECT")
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode="EDIT")
        # Two-pass: rename to temps if needed to avoid collisions, then to DEF
        planned = []
        for bone in list(arm.data.edit_bones):
            src = strip_name_prefix(bone.name)
            dest = _lookup_bone_map(src, mapping) or _lookup_bone_map(bone.name, mapping)
            if dest and dest != bone.name and dest != "root":
                planned.append((bone.name, dest))
        # Apply with temp names when dest already exists under another bone
        for old, dest in planned:
            if old not in arm.data.edit_bones:
                continue
            bone = arm.data.edit_bones[old]
            if dest in arm.data.edit_bones and arm.data.edit_bones[dest] != bone:
                skipped.append(f"{old}->{dest} (dest exists)")
                continue
            bone.name = dest
            renamed += 1
        bpy.ops.object.mode_set(mode="OBJECT")
        for obj in mesh_objects():
            for vg in list(obj.vertex_groups):
                dest = _lookup_bone_map(strip_name_prefix(vg.name), mapping) or _lookup_bone_map(
                    vg.name, mapping
                )
                if dest and dest != vg.name and dest != "root":
                    if obj.vertex_groups.get(dest) is not None and obj.vertex_groups.get(dest) != vg:
                        skipped.append(f"vg {vg.name}->{dest} (exists)")
                        continue
                    try:
                        vg.name = dest
                    except RuntimeError:
                        skipped.append(f"vg {vg.name}->{dest}")
    log(f"Renamed {renamed} {label} bones → DEF-* ({len(skipped)} skipped)")
    return {"renamed": renamed, "skipped": skipped[:40], "label": label}


def rename_mixamo_bones() -> dict:
    return rename_bones_with_map(MIXAMO_TO_DEF, "Mixamo")


def rename_ue_bones() -> dict:
    return rename_bones_with_map(UE_TO_DEF, "UE")


def detect_skeleton_family() -> str:
    """Return 'def' | 'mixamo' | 'ue' | 'unknown' from current armatures."""
    names = set()
    for arm in armature_objects():
        for b in arm.data.bones:
            names.add(b.name)
            names.add(b.name.lower())
    def_count = sum(1 for n in names if n.startswith("DEF-") or n.startswith("def-"))
    if def_count >= 20:
        return "def"
    if any(n.startswith("mixamorig") for n in names):
        return "mixamo"
    ue_hits = sum(1 for k in ("pelvis", "spine_01", "thigh_l", "upperarm_l", "hand_l") if k in names)
    if ue_hits >= 3:
        return "ue"
    return "unknown"


def pick_body_mesh() -> bpy.types.Object | None:
    meshes = mesh_objects()
    if not meshes:
        return None

    def score(o: bpy.types.Object) -> tuple:
        name = o.name.lower()
        # Prefer non-overlapping UV variants and "body/human/base" names.
        prefer = 0
        if "notoverlapping" in name or "nonoverlapping" in name or "non_overlap" in name:
            prefer += 100
        if "overlapping" in name and "not" not in name and "non" not in name:
            prefer -= 50
        if any(k in name for k in ("body", "human", "base", "mesh", "character")):
            prefer += 10
        if any(k in name for k in ("eye", "hair", "lash")):
            prefer -= 100
        return (prefer, len(o.data.vertices))

    ranked = sorted(meshes, key=score, reverse=True)
    return ranked[0]


def isolate_body_mesh(body: bpy.types.Object) -> dict:
    """Remove sibling body variants (e.g. Overlapping UV twin) so export is one character."""
    removed = []
    for obj in list(mesh_objects()):
        if obj == body:
            continue
        # Keep likely eye/accessory meshes (small + high)
        bmin, bmax = world_mesh_bounds([body])
        omin, omax = world_mesh_bounds([obj])
        body_h = max(1e-6, bmax.z - bmin.z)
        oh = omax.z - omin.z
        ocz = 0.5 * (omin.z + omax.z)
        is_eye_like = oh < body_h * 0.15 and ocz > bmin.z + body_h * 0.65
        if is_eye_like:
            continue
        # Drop other large meshes (duplicate UV layouts sitting beside the body)
        if len(obj.data.vertices) >= len(body.data.vertices) * 0.5:
            removed.append(obj.name)
            bpy.data.objects.remove(obj, do_unlink=True)
    if removed:
        log(f"Isolated body '{body.name}', removed siblings: {removed}")
    return {"body": body.name, "removed": removed}


def name_eye_meshes() -> dict:
    """Heuristic: eye meshes → Eye_L / Eye_R (Blender Z-up)."""
    body = pick_body_mesh()
    if not body:
        return {"named": []}
    body_mins, body_maxs = world_mesh_bounds([body])
    body_height = body_maxs.z - body_mins.z
    named = []

    # Explicit combined "Eyes" mesh (Universal Base Characters etc.)
    for obj in mesh_objects():
        if obj.name.lower() in ("eyes", "eye", "eye_mesh", "eyeballs"):
            # Single combined mesh: tag as Eye_L so isEyeMesh() finds it
            obj.name = "Eye_L"
            named.append("Eye_L")
            log("Named combined eyes mesh Eye_L")
            return {"named": named}

    candidates = []
    for obj in mesh_objects():
        if obj == body:
            continue
        if obj.name in ("Eye_L", "Eye_R"):
            named.append(obj.name)
            continue
        mins, maxs = world_mesh_bounds([obj])
        h = maxs.z - mins.z
        cz = 0.5 * (mins.z + maxs.z)
        cx = 0.5 * (mins.x + maxs.x)
        if h < body_height * 0.12 and cz > body_mins.z + body_height * 0.7:
            # Skip eyebrows/hair-ish by name
            if any(k in obj.name.lower() for k in ("brow", "hair", "lash", "beard")):
                continue
            candidates.append((cx, obj))
    if len(candidates) >= 2:
        candidates.sort(key=lambda t: t[0])
        right, left = candidates[0][1], candidates[-1][1]
        left.name = "Eye_L"
        right.name = "Eye_R"
        named = ["Eye_L", "Eye_R"]
        log("Named eyes: Eye_L / Eye_R")
    elif candidates:
        candidates[0][1].name = "Eye_L"
        named = ["Eye_L"]
        log("Only one eye candidate found; named Eye_L")
    elif not named:
        log("No eye mesh candidates found (ok if eyes are part of body mesh)")
    return {"named": named}


def largest_def_armature() -> bpy.types.Object | None:
    arms = armature_objects()
    if not arms:
        return None
    return max(arms, key=lambda a: sum(1 for b in a.data.bones if b.name.startswith("DEF-")))


def has_usable_def_rig() -> bool:
    arm = largest_def_armature()
    if not arm:
        return False
    def_count = sum(1 for b in arm.data.bones if b.name.startswith("DEF-"))
    needed = ("DEF-spine", "DEF-upper_arm.L", "DEF-thigh.L", "DEF-hand.L")
    names = {b.name for b in arm.data.bones}
    return def_count >= 40 and all(n in names for n in needed)


def fit_metarig_to_mesh(metarig: bpy.types.Object, body: bpy.types.Object) -> None:
    mins, maxs = world_mesh_bounds([body])
    # Blender Z-up: character height is along Z after glTF import.
    height = max(1e-6, maxs.z - mins.z)
    bpy.ops.object.select_all(action="DESELECT")
    metarig.select_set(True)
    bpy.context.view_layer.objects.active = metarig
    # Place feet at mesh min Z, center XY
    cx = 0.5 * (mins.x + maxs.x)
    cy = 0.5 * (mins.y + maxs.y)
    metarig.location = (cx, cy, mins.z)
    bpy.ops.object.mode_set(mode="EDIT")
    ebones = metarig.data.edit_bones
    zs = []
    for b in ebones:
        zs.append(b.head.z)
        zs.append(b.tail.z)
    bpy.ops.object.mode_set(mode="OBJECT")
    local_span = max(max(zs) - min(zs), 1e-6)
    scale = height / local_span
    metarig.scale = (scale, scale, scale)
    bpy.context.view_layer.update()
    log(f"Meta-rig scaled ×{scale:.3f} to mesh height {height:.3f}")


def ensure_object_in_scene(obj: bpy.types.Object) -> None:
    """Link object into the active view layer collection if missing."""
    scene_coll = bpy.context.scene.collection
    if obj.name not in scene_coll.objects:
        try:
            scene_coll.objects.link(obj)
        except RuntimeError:
            pass
    obj.hide_set(False)
    obj.hide_viewport = False
    obj.hide_render = False


def purge_rigify_widgets() -> int:
    """Delete Rigify widget meshes (WGT-*) so they never export or break selection."""
    removed = 0
    for obj in list(bpy.data.objects):
        if obj.name.startswith("WGT-") or obj.name.startswith("WGT_"):
            bpy.data.objects.remove(obj, do_unlink=True)
            removed += 1
    # Drop empty widget collections
    for coll in list(bpy.data.collections):
        if "wgt" in coll.name.lower() or coll.name.startswith("WGTS_"):
            try:
                bpy.data.collections.remove(coll)
            except Exception:
                pass
    if removed:
        log(f"Purged {removed} Rigify widget objects")
    return removed


def bind_mesh_to_armature(mesh_obj: bpy.types.Object, arm: bpy.types.Object) -> str:
    """Parent mesh to armature with automatic weights; fall back to modifier-only."""
    ensure_object_in_scene(mesh_obj)
    ensure_object_in_scene(arm)
    mesh_obj.vertex_groups.clear()
    # Clear prior armature mods
    for mod in list(mesh_obj.modifiers):
        if mod.type == "ARMATURE":
            mesh_obj.modifiers.remove(mod)

    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        return "ARMATURE_AUTO"
    except RuntimeError as exc:
        log(f"ARMATURE_AUTO failed ({exc}); applying Armature modifier + heat weights")
    # Manual path: parent keep transform + armature modifier + heat map weights
    mesh_obj.parent = arm
    mesh_obj.parent_type = "OBJECT"
    mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm
    mod.use_vertex_groups = True
    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_obj
    try:
        bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
        # Assign automatic weights from active armature (Blender 3–5)
        bpy.ops.paint.weight_from_bones(type="AUTOMATIC")
        bpy.ops.object.mode_set(mode="OBJECT")
        return "weight_from_bones"
    except Exception as exc2:
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass
        log(f"weight_from_bones failed ({exc2}); leaving empty vertex groups")
        return "modifier_only"


def generate_rigify_and_bind(body: bpy.types.Object) -> dict:
    enable_rigify()
    # Remove prior armatures if we're replacing (keep mesh)
    for arm in list(armature_objects()):
        for obj in mesh_objects():
            for mod in list(obj.modifiers):
                if mod.type == "ARMATURE" and mod.object == arm:
                    obj.modifiers.remove(mod)
        bpy.data.objects.remove(arm, do_unlink=True)
    purge_rigify_widgets()

    before = set(o.name for o in bpy.data.objects)
    try:
        bpy.ops.object.armature_human_metarig_add()
    except Exception as exc:
        log(f"armature_human_metarig_add failed ({exc}); trying sample add")
        try:
            bpy.ops.object.armature_metarig_sample_add(meta_type="human")
        except Exception as exc2:
            raise RuntimeError(f"Could not add Rigify meta-rig: {exc2}") from exc2

    metarig = None
    for o in bpy.data.objects:
        if o.name not in before and o.type == "ARMATURE":
            metarig = o
            break
    if metarig is None:
        metarig = bpy.context.view_layer.objects.active
    if not metarig or metarig.type != "ARMATURE":
        raise RuntimeError("Meta-rig not found after add")

    metarig.name = "metarig"
    ensure_object_in_scene(metarig)
    fit_metarig_to_mesh(metarig, body)

    bpy.ops.object.select_all(action="DESELECT")
    metarig.select_set(True)
    bpy.context.view_layer.objects.active = metarig
    before_arms = {o.name for o in armature_objects()}
    try:
        bpy.ops.pose.rigify_generate()
    except Exception as exc:
        raise RuntimeError(f"rigify_generate failed: {exc}") from exc

    generated = None
    for arm in armature_objects():
        if arm != metarig and (arm.name not in before_arms or arm.name in ("rig", "rig.001")):
            generated = arm
    if generated is None:
        generated = bpy.data.objects.get("rig")
    if generated is None:
        raise RuntimeError("Rigify generated armature not found")

    generated.name = "rig.001"
    ensure_object_in_scene(generated)
    log(f"Generated Rigify armature '{generated.name}' "
        f"({len(generated.data.bones)} bones, "
        f"{sum(1 for b in generated.data.bones if b.name.startswith('DEF-'))} DEF-*)")

    # Meta-rig + widgets are editor-only
    if metarig.name in bpy.data.objects:
        bpy.data.objects.remove(metarig, do_unlink=True)
    purge_rigify_widgets()

    # Export-only deform rig: leave DEF bones usable without control constraints.
    # Clear pose constraints that reference deleted MCH/tweak targets after prune.
    bind_mode = bind_mesh_to_armature(body, generated)
    for obj in mesh_objects():
        if obj == body:
            continue
        bind_mesh_to_armature(obj, generated)

    def_count = sum(1 for b in generated.data.bones if b.name.startswith("DEF-"))
    return {
        "armature": generated.name,
        "def_count": def_count,
        "bone_count": len(generated.data.bones),
        "bind": bind_mode,
    }


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


def transfer_shape_keys(
    source: bpy.types.Object,
    target: bpy.types.Object,
    morph_limit: int = 0,
) -> dict:
    """Project source shape-key deltas onto target via nearest source face."""
    src_keys = source.data.shape_keys
    if not src_keys or len(src_keys.key_blocks) <= 1:
        log("Reference has no shape keys to transfer")
        return {"transferred": 0, "skipped": 0}

    # Build BVH on source basis in world space
    ensure_basis(source)
    for kb in src_keys.key_blocks:
        kb.value = 0.0
    bpy.context.view_layer.update()

    src_basis = mesh_eval_world_coords(source)
    # Use source mesh polygons with basis local coords transformed
    mw = source.matrix_world
    src_mesh = source.data
    verts = [mw @ v.co for v in src_mesh.vertices]
    polys = []
    for p in src_mesh.polygons:
        polys.append(list(p.vertices))
    bvh = BVHTree.FromPolygons(verts, polys)

    tgt_mw = target.matrix_world
    tgt_imw = tgt_mw.inverted()
    tgt_basis_world = [tgt_mw @ v.co for v in target.data.vertices]

    # Precompute nearest face + barycentric-ish: store closest source vert for simplicity
    # (faster than full barycentric; good enough for body-level morph transfer)
    nearest_src = []
    misses = 0
    for co in tgt_basis_world:
        loc, _normal, index, dist = bvh.find_nearest(co)
        if loc is None:
            nearest_src.append(None)
            misses += 1
            continue
        # Find closest vertex among face verts for delta sampling
        face = src_mesh.polygons[index]
        best_i = face.vertices[0]
        best_d = (verts[best_i] - co).length_squared
        for vi in face.vertices:
            d = (verts[vi] - co).length_squared
            if d < best_d:
                best_d = d
                best_i = vi
        nearest_src.append(best_i)

    ensure_basis(target)
    names = [kb.name for kb in src_keys.key_blocks if kb.name != "Basis"]
    if morph_limit > 0:
        names = names[:morph_limit]

    transferred = 0
    for name in names:
        kb = src_keys.key_blocks.get(name)
        if not kb:
            continue
        # Isolate this key
        for other in src_keys.key_blocks:
            other.value = 0.0
        kb.value = 1.0
        bpy.context.view_layer.update()
        src_posed = mesh_eval_world_coords(source)
        kb.value = 0.0

        # Create or replace target key
        existing = target.data.shape_keys.key_blocks.get(name) if target.data.shape_keys else None
        if existing:
            sk = existing
        else:
            sk = target.shape_key_add(name=name, from_mix=False)

        for ti, src_i in enumerate(nearest_src):
            if src_i is None:
                continue
            delta_world = src_posed[src_i] - src_basis[src_i]
            # Apply delta in target local space at basis position
            world_pos = tgt_basis_world[ti] + delta_world
            sk.data[ti].co = tgt_imw @ world_pos

        transferred += 1
        if transferred % 25 == 0:
            log(f"  transferred {transferred}/{len(names)} morphs…")

    bpy.context.view_layer.update()
    log(f"Transferred {transferred} shape keys (nearest misses={misses})")
    return {"transferred": transferred, "misses": misses, "source_mesh": source.name, "target_mesh": target.name}


def import_reference_and_transfer(reference: Path, morph_limit: int) -> dict:
    if not reference.exists():
        log(f"Reference missing: {reference} — skip morph transfer")
        return {"transferred": 0, "error": "missing reference"}

    target = pick_body_mesh()
    if not target:
        return {"transferred": 0, "error": "no body mesh"}

    # Tag existing objects so we can find newly imported ones
    for o in bpy.data.objects:
        o["__prep_keep"] = True

    import_gltf(reference)
    ref_meshes = [o for o in mesh_objects() if not o.get("__prep_keep")]
    if not ref_meshes:
        log("No meshes in reference GLB")
        return {"transferred": 0, "error": "no ref meshes"}

    # Prefer mesh with most shape keys
    def key_count(o):
        sk = o.data.shape_keys
        return 0 if not sk else len(sk.key_blocks)

    ref_body = max(ref_meshes, key=key_count)
    log(f"Reference body mesh '{ref_body.name}' with {key_count(ref_body)} keys")

    # Align reference to same height as target (Blender Z-up).
    tmin, tmax = world_mesh_bounds([target])
    rmin, rmax = world_mesh_bounds([ref_body])
    th = max(1e-6, tmax.z - tmin.z)
    rh = max(1e-6, rmax.z - rmin.z)
    s = th / rh
    ref_roots = [o for o in bpy.data.objects if not o.get("__prep_keep") and o.parent is None]
    for o in ref_roots:
        o.scale *= s
    bpy.context.view_layer.update()
    rmin, rmax = world_mesh_bounds([ref_body])
    dx = 0.5 * (tmin.x + tmax.x) - 0.5 * (rmin.x + rmax.x)
    dy = 0.5 * (tmin.y + tmax.y) - 0.5 * (rmin.y + rmax.y)
    dz = tmin.z - rmin.z
    for o in ref_roots:
        o.location += Vector((dx, dy, dz))
    bpy.context.view_layer.update()

    result = transfer_shape_keys(ref_body, target, morph_limit=morph_limit)

    # Delete reference objects
    for o in list(bpy.data.objects):
        if not o.get("__prep_keep"):
            bpy.data.objects.remove(o, do_unlink=True)
    # Cleanup orphan meshes
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)

    return result


def strip_materials_and_images() -> None:
    for obj in mesh_objects():
        obj.data.materials.clear()
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    for img in list(bpy.data.images):
        bpy.data.images.remove(img)
    log("Stripped materials and images")


def pack_and_fix_textures() -> dict:
    """Ensure images used by materials are packed so GLB export embeds them."""
    packed = 0
    missing = []
    for img in list(bpy.data.images):
        if img.size[0] == 0 and img.size[1] == 0:
            # Try to reload from filepath
            fp = bpy.path.abspath(img.filepath) if img.filepath else ""
            if fp and Path(fp).exists():
                try:
                    img.reload()
                except Exception:
                    pass
        if img.size[0] == 0:
            missing.append(img.name or img.filepath or "?")
            continue
        try:
            if not img.packed_file:
                img.pack()
            packed += 1
        except Exception as exc:
            missing.append(f"{img.name}: {exc}")
    log(f"Packed {packed} textures ({len(missing)} missing/failed)")
    return {"packed": packed, "missing": missing[:20]}


def strip_pose_constraints(arm: bpy.types.Object) -> int:
    """Remove all pose-bone constraints (Rigify controls reference bones we may delete)."""
    removed = 0
    for pb in arm.pose.bones:
        for c in list(pb.constraints):
            pb.constraints.remove(c)
            removed += 1
    return removed


# Anatomical DEF parents for a clean deform-only export (no MCH/ORG/tweak parents).
# Keys/values use Rigify DEF names. Missing bones are skipped.
DEF_ANATOMY_PARENTS = {
    # spine chain
    "DEF-spine.001": "DEF-spine",
    "DEF-spine.002": "DEF-spine.001",
    "DEF-spine.003": "DEF-spine.002",
    "DEF-spine.004": "DEF-spine.003",
    "DEF-spine.005": "DEF-spine.004",
    "DEF-spine.006": "DEF-spine.005",
    "DEF-pelvis.L": "DEF-spine",
    "DEF-pelvis.R": "DEF-spine",
    "DEF-breast.L": "DEF-spine.003",
    "DEF-breast.R": "DEF-spine.003",
    "DEF-shoulder.L": "DEF-spine.003",
    "DEF-shoulder.R": "DEF-spine.003",
    "DEF-upper_arm.L": "DEF-shoulder.L",
    "DEF-upper_arm.R": "DEF-shoulder.R",
    "DEF-upper_arm.L.001": "DEF-upper_arm.L",
    "DEF-upper_arm.R.001": "DEF-upper_arm.R",
    "DEF-forearm.L": "DEF-upper_arm.L.001",
    "DEF-forearm.R": "DEF-upper_arm.R.001",
    "DEF-forearm.L.001": "DEF-forearm.L",
    "DEF-forearm.R.001": "DEF-forearm.R",
    "DEF-hand.L": "DEF-forearm.L.001",
    "DEF-hand.R": "DEF-forearm.R.001",
    # legs (modern Rigify: thigh → thigh.001 twist → shin → shin.001 → foot)
    "DEF-thigh.L": "DEF-spine",
    "DEF-thigh.R": "DEF-spine",
    "DEF-thigh.L.001": "DEF-thigh.L",
    "DEF-thigh.R.001": "DEF-thigh.R",
    "DEF-shin.L": "DEF-thigh.L.001",
    "DEF-shin.R": "DEF-thigh.R.001",
    "DEF-shin.L.001": "DEF-shin.L",
    "DEF-shin.R.001": "DEF-shin.R",
    "DEF-foot.L": "DEF-shin.L.001",
    "DEF-foot.R": "DEF-shin.R.001",
    "DEF-toe.L": "DEF-foot.L",
    "DEF-toe.R": "DEF-foot.R",
}


def _finger_chain(side: str, name: str, count: int = 3) -> dict:
    out = {}
    for i in range(1, count + 1):
        bone = f"DEF-{name}.{i:02d}.{side}"
        if i == 1:
            out[bone] = f"DEF-hand.{side}"
        else:
            out[bone] = f"DEF-{name}.{i-1:02d}.{side}"
    return out


for _side in ("L", "R"):
    DEF_ANATOMY_PARENTS.update(_finger_chain(_side, "thumb"))
    DEF_ANATOMY_PARENTS.update(_finger_chain(_side, "f_index"))
    DEF_ANATOMY_PARENTS.update(_finger_chain(_side, "f_middle"))
    DEF_ANATOMY_PARENTS.update(_finger_chain(_side, "f_ring"))
    DEF_ANATOMY_PARENTS.update(_finger_chain(_side, "f_pinky"))
    # palm bones
    for palm in ("palm.01", "palm.02", "palm.03", "palm.04"):
        DEF_ANATOMY_PARENTS[f"DEF-{palm}.{_side}"] = f"DEF-hand.{_side}"


def clear_pose_transforms(arm: bpy.types.Object) -> None:
    ensure_object_in_scene(arm)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.pose.transforms_clear()
    bpy.ops.object.mode_set(mode="OBJECT")


def rebind_meshes_to_def_only(arm: bpy.types.Object) -> None:
    """Drop non-DEF vertex groups and ensure Armature modifier targets arm."""
    def_names = {b.name for b in arm.data.bones if b.name.startswith("DEF-")}
    for obj in mesh_objects():
        # Remove vertex groups that no longer exist on the armature
        for vg in list(obj.vertex_groups):
            if vg.name not in def_names and vg.name != "root":
                obj.vertex_groups.remove(vg)
        # Ensure armature modifier
        arm_mod = None
        for mod in obj.modifiers:
            if mod.type == "ARMATURE":
                arm_mod = mod
                break
        if arm_mod is None:
            arm_mod = obj.modifiers.new(name="Armature", type="ARMATURE")
        arm_mod.object = arm
        arm_mod.use_vertex_groups = True
        obj.parent = arm


def delete_non_deform_bones_optional(arm: bpy.types.Object) -> int:
    """
    Export a human5-style DEF-only deform skeleton.

    Critical: do NOT keep MCH/ORG/tweak parents. After constraints are stripped
    those bones leave DEF bones in a wrong rest pose and the skinned mesh
    collapses / lies flat. Rebuild anatomical DEF parents, then delete the rest.
    """
    ensure_object_in_scene(arm)
    strip_pose_constraints(arm)
    clear_pose_transforms(arm)

    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    bones = arm.data.edit_bones

    # 1) Parent DEF bones to each other anatomically (world poses preserved via head/tail)
    # Use matrix copy: store world matrices, reparent, restore.
    world = {}
    for b in bones:
        if b.name.startswith("DEF-"):
            world[b.name] = b.matrix.copy()

    # Detach all DEF bones to root temporarily
    root = bones.get("root")
    for b in bones:
        if b.name.startswith("DEF-"):
            b.parent = root

    available = {b.name for b in bones if b.name.startswith("DEF-")}
    for child in list(available):
        parent = DEF_ANATOMY_PARENTS.get(child)
        # Walk up if intermediate bones were not generated on this rig
        while parent and parent not in available:
            parent = DEF_ANATOMY_PARENTS.get(parent)
        if child not in bones:
            continue
        if parent and parent in bones:
            bones[child].parent = bones[parent]
        elif root:
            bones[child].parent = root
        bones[child].use_connect = False

    # Restore world matrices so bind pose matches the mesh
    for name, mat in world.items():
        if name in bones:
            bones[name].matrix = mat

    # Face bones: parent any remaining DEF- face bones to head if free-floating
    head = bones.get("DEF-spine.006")
    if head:
        face_prefixes = (
            "DEF-brow", "DEF-cheek", "DEF-chin", "DEF-ear", "DEF-eye",
            "DEF-forehead", "DEF-jaw", "DEF-lid", "DEF-lip", "DEF-nose",
            "DEF-teeth", "DEF-tongue", "DEF-temple",
        )
        for b in bones:
            if not b.name.startswith(face_prefixes):
                continue
            # Keep existing DEF parents; only lift bones parented to non-DEF
            if b.parent is None or not b.parent.name.startswith("DEF-"):
                b.parent = head
                b.use_connect = False

    # 2) Delete everything that is not DEF-* or root
    keep = {b.name for b in bones if b.name.startswith("DEF-")}
    if "root" in bones:
        keep.add("root")
    removed = 0
    changed = True
    while changed:
        changed = False
        for b in list(bones):
            if b.name in keep:
                continue
            if len(b.children) == 0:
                bones.remove(b)
                removed += 1
                changed = True
    # Force-delete any remaining non-DEF with children (reparent kids first)
    for b in list(bones):
        if b.name in keep:
            continue
        for child in list(b.children):
            child.parent = root if root else None
        bones.remove(b)
        removed += 1

    bpy.ops.object.mode_set(mode="OBJECT")

    # Alias modern Rigify shin/forearm names only when human5 expected names are free.
    # Prefer keeping both if both exist (modern rig) — retarget map still has limb roots.
    aliases = {}
    bone_names = {b.name for b in arm.data.bones}
    if "DEF-forearm.L.001" not in bone_names and "DEF-forearm.L" in bone_names:
        aliases["DEF-forearm.L"] = "DEF-forearm.L.001"
    if "DEF-forearm.R.001" not in bone_names and "DEF-forearm.R" in bone_names:
        aliases["DEF-forearm.R"] = "DEF-forearm.R.001"

    if aliases:
        bpy.ops.object.mode_set(mode="EDIT")
        for src, dst in aliases.items():
            if src in arm.data.edit_bones and dst not in arm.data.edit_bones:
                arm.data.edit_bones[src].name = dst
                log(f"Aliased bone {src} → {dst}")
        bpy.ops.object.mode_set(mode="OBJECT")
        for obj in mesh_objects():
            for src, dst in aliases.items():
                vg = obj.vertex_groups.get(src)
                if vg and obj.vertex_groups.get(dst) is None:
                    vg.name = dst

    rebind_meshes_to_def_only(arm)
    clear_pose_transforms(arm)
    def_count = sum(1 for b in arm.data.bones if b.name.startswith("DEF-"))
    log(f"DEF-only skeleton: removed {removed} control bones, {def_count} DEF-* remain")
    return removed


def cleanup_for_export() -> None:
    """Drop widgets/empties and leave meshes + one armature."""
    purge_rigify_widgets()
    for obj in list(bpy.data.objects):
        if obj.type in ("LIGHT", "CAMERA", "SPEAKER", "LATTICE"):
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        if obj.type == "EMPTY" and not obj.children:
            bpy.data.objects.remove(obj, do_unlink=True)
    # Keep only the largest DEF armature
    arms = armature_objects()
    if len(arms) > 1:
        keeper = max(arms, key=lambda a: sum(1 for b in a.data.bones if b.name.startswith("DEF-")))
        for arm in arms:
            if arm != keeper:
                bpy.data.objects.remove(arm, do_unlink=True)


def export_glb(path: Path, keep_materials: bool) -> None:
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    cleanup_for_export()
    bpy.ops.object.select_all(action="SELECT")
    export_kwargs = dict(
        filepath=str(path),
        export_format="GLB",
        use_selection=False,
        export_animations=False,
        export_skins=True,
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_apply=False,
        export_extras=True,
        export_yup=True,
    )
    # Embed textures when keeping materials; omit when stripped.
    if keep_materials:
        export_kwargs["export_image_format"] = "AUTO"
        export_kwargs["export_texcoords"] = True
        export_kwargs["export_normals"] = True
        # Prefer packing into GLB (self-contained runtime asset)
        try:
            export_kwargs["export_keep_originals"] = False
        except Exception:
            pass
    else:
        export_kwargs["export_image_format"] = "NONE"
    try:
        bpy.ops.export_scene.gltf(**export_kwargs)
    except TypeError:
        minimal = {
            "filepath": str(path),
            "export_format": "GLB",
            "export_animations": False,
            "export_skins": True,
            "export_morph": True,
        }
        if keep_materials:
            minimal["export_image_format"] = "AUTO"
        bpy.ops.export_scene.gltf(**minimal)
    size = path.stat().st_size if path.exists() else 0
    log(f"Exported {path} ({size / (1024 * 1024):.2f} MiB)")


def main() -> int:
    args = parse_args()
    if not args.input.exists():
        log(f"Input not found: {args.input}")
        return 1
    if args.mode != "inspect" and not args.output:
        log("--output is required unless --mode inspect")
        return 1

    reset_scene()
    log(f"Importing {args.input}")
    import_gltf(args.input)
    purge_default_junk()

    report: dict = {
        "input": str(args.input.resolve()),
        "mode": args.mode,
        "before": scene_report(),
        "steps": {},
    }
    log(
        f"Imported: {len(mesh_objects())} meshes, {len(armature_objects())} armatures, "
        f"height≈{report['before']['height']:.3f}"
    )

    if args.mode == "inspect":
        print(json.dumps(report, indent=2, default=str))
        if args.report_json:
            args.report_json.write_text(json.dumps(report, indent=2, default=str))
        return 0

    # Always normalize height for runtime classification heuristics
    report["steps"]["normalize"] = normalize_height(args.target_height)

    if args.mode == "full":
        family = detect_skeleton_family()
        report["steps"]["skeleton_family"] = family
        log(f"Skeleton family: {family}")

        if family == "mixamo" and not args.no_rename_mixamo:
            report["steps"]["rename_mixamo"] = rename_mixamo_bones()
        elif family == "ue":
            report["steps"]["rename_ue"] = rename_ue_bones()
        elif family == "unknown" and not args.no_rename_mixamo:
            # Try both; harmless no-ops when maps don't match
            report["steps"]["rename_mixamo"] = rename_mixamo_bones()
            if not has_usable_def_rig():
                report["steps"]["rename_ue"] = rename_ue_bones()

        report["steps"]["eyes"] = name_eye_meshes()

        body = pick_body_mesh()
        if body is None:
            log("No mesh found")
            return 1
        report["steps"]["isolate_body"] = isolate_body_mesh(body)
        body = pick_body_mesh()  # re-resolve after isolation

        # Prefer preserving author weights (UE/Mixamo rename). Only Rigify when needed.
        if not args.no_rigify and not has_usable_def_rig():
            log("No usable DEF rig — generating Rigify human + auto weights")
            try:
                report["steps"]["rigify"] = generate_rigify_and_bind(body)
            except Exception as exc:
                log(f"ERROR: Rigify step failed: {exc}")
                report["steps"]["rigify"] = {"error": str(exc)}
        else:
            if has_usable_def_rig():
                log("Existing DEF rig looks usable — keeping author weights (no Rigify regen)")
                report["steps"]["rigify"] = {"skipped": "usable DEF rig present", "family": family}
            else:
                report["steps"]["rigify"] = {"skipped": "disabled by flag"}

        arm = largest_def_armature()
        if arm and report.get("steps", {}).get("rigify", {}).get("armature"):
            # Only prune control bones when we generated a full Rigify control rig
            try:
                report["steps"]["prune_bones"] = {
                    "removed": delete_non_deform_bones_optional(arm)
                }
            except Exception as exc:
                log(f"Bone prune skipped: {exc}")
        elif arm:
            # Author rig renamed to DEF — strip constraints only, don't reparent-destructively
            try:
                strip_pose_constraints(arm)
                clear_pose_transforms(arm)
                report["steps"]["prune_bones"] = {"removed": 0, "mode": "constraints_only"}
            except Exception as exc:
                log(f"Constraint strip skipped: {exc}")

        if not args.no_transfer_morphs:
            log(f"Transferring morphs from {args.reference}")
            try:
                report["steps"]["transfer_morphs"] = import_reference_and_transfer(
                    args.reference, args.morph_limit
                )
            except Exception as exc:
                log(f"ERROR: morph transfer failed: {exc}")
                report["steps"]["transfer_morphs"] = {"error": str(exc)}
        else:
            report["steps"]["transfer_morphs"] = {"skipped": True}

    if not args.keep_materials:
        strip_materials_and_images()
    else:
        report["steps"]["pack_textures"] = pack_and_fix_textures()

    report["after"] = scene_report()
    export_glb(args.output, keep_materials=args.keep_materials)
    report["output"] = str(args.output.resolve())
    report["output_bytes"] = args.output.stat().st_size if args.output.exists() else 0

    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_text(json.dumps(report, indent=2, default=str))
        log(f"Wrote report {args.report_json}")

    # Human summary
    after = report["after"]
    def_count = max((a.get("def_count", 0) for a in after.get("armatures", [])), default=0)
    morphs = max((m.get("morph_count", 0) for m in after.get("meshes", [])), default=0)
    b = after.get("bounds") or {}
    bmin = b.get("min") or [0, 0, 0]
    bmax = b.get("max") or [0, 0, 0]
    height_z = (bmax[2] - bmin[2]) if len(bmax) > 2 else after.get("height", 0)
    log(
        f"DONE def_bones≈{def_count} morphs≈{morphs} heightZ≈{height_z:.3f} "
        f"→ {args.output}"
    )
    log(
        "Next: node scripts/verify-simhuman-asset.mjs --path "
        f"{args.output} --relaxed"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"FATAL: {exc}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
