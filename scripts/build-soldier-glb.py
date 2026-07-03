#!/usr/bin/env python3
"""
Blender headless builder for the rifle-soldier enemy GLB.

Assembles:
  assets-source/models/soldier.fbx        (Tripo mesh on a Mixamo armature)
  + selected rifle-pack clip FBXs         (identical Mixamo skeleton -> no retarget)
into a single Draco-compressed GLB with named animations that match the
EnemySystem behavior-tree contract (Idle / Walk / Run / Idle Alert / Bite).

Run:
  /Applications/Blender.app/Contents/MacOS/blender --background \
    --python scripts/build-soldier-glb.py

Multiple animations are exported by giving the soldier armature one NLA track
per clip (the glTF exporter maps each NLA track to a named animation).
"""

import os
import sys
import bpy

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

SOLDIER_FBX = os.path.join(REPO_ROOT, "assets-source/models/soldier.fbx")
RIFLE_DIR = os.path.join(REPO_ROOT, "assets-source/animations/rifle-pack")
DISABILITY_DIR = os.path.join(REPO_ROOT, "assets-source/animations/disability-pack")
OUTPUT_GLB = os.path.join(REPO_ROOT, "public/assets/models/soldier.glb")

# (source clip FBX, exported animation name). The behavior tree references these
# exact names; idle aiming doubles as both the hold and the attack pose (the
# rifle pack has no separate fire/melee clip).
CLIP_MAP = [
    ("idle.fbx", "Idle"),
    ("walk-forward.fbx", "Walk"),
    ("run-forward.fbx", "Run"),
    ("idle-aiming.fbx", "Idle Alert"),
    ("idle-aiming.fbx", "Bite"),
]

# Partial-cut locomotion clips (disability-pack). Filenames are kebab-case;
# exported names match EnemySystem / soldierPartialCut.js.
DISABILITY_CLIP_MAP = [
    ("head-missing.fbx", "Head Missing"),
    ("head-missing-2.fbx", "Head Missing 2"),
    ("left-arm-missing-walk.fbx", "Left Arm Missing Walk"),
    ("right-arm-missing-walk.fbx", "Right Arm Missing Walk"),
    ("left-leg-missing.fbx", "Left Leg Missing"),
    ("right-leg-missing.fbx", "Right Leg Missing"),
    ("crawl-forward.fbx", "Crawl Forward"),
    ("crawl-back.fbx", "Crawl Back"),
]


def reset_scene():
    bpy.ops.wm.read_homefile(use_empty=True)


def armature_objects():
    return [o for o in bpy.data.objects if o.type == "ARMATURE"]


def count_fcurves(action):
    """Count f-curves across both the legacy and the Blender 4.4+ slotted APIs."""
    try:
        return len(action.fcurves)
    except AttributeError:
        pass
    total = 0
    for layer in getattr(action, "layers", ()):
        for strip in getattr(layer, "strips", ()):
            for slot in getattr(strip, "channelbag_slots", ()) or ():
                total += len(getattr(slot, "fcurves", ()) or ())
    return total


def import_fbx(path):
    before = set(o.name for o in armature_objects())
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, use_image_search=False)
    new_armatures = [o for o in armature_objects() if o.name not in before]
    return new_armatures


def main():
    if not os.path.exists(SOLDIER_FBX):
        print(f"[build] MISSING soldier mesh: {SOLDIER_FBX}", file=sys.stderr)
        sys.exit(1)

    reset_scene()

    # 1) Import the soldier mesh + armature (the keeper).
    soldier_armatures = import_fbx(SOLDIER_FBX)
    if not soldier_armatures:
        print("[build] No armature found in soldier.fbx", file=sys.stderr)
        sys.exit(1)
    soldier_arm = soldier_armatures[0]
    soldier_arm.name = "SoldierArmature"
    if not soldier_arm.animation_data:
        soldier_arm.animation_data_create()
    print(f"[build] Soldier armature: {soldier_arm.name} "
          f"({len(soldier_arm.data.bones)} bones)")

    # 2) For each clip: import (own identical-Mixamo armature + action), move the
    #    action onto the soldier armature as a named NLA strip, remove the temp armature.
    all_clips = [(RIFLE_DIR, clip_file, anim_name) for clip_file, anim_name in CLIP_MAP]
    all_clips += [(DISABILITY_DIR, clip_file, anim_name) for clip_file, anim_name in DISABILITY_CLIP_MAP]

    for clip_dir, clip_file, anim_name in all_clips:
        clip_path = os.path.join(clip_dir, clip_file)
        if not os.path.exists(clip_path):
            print(f"[build] MISSING clip: {clip_path}", file=sys.stderr)
            sys.exit(1)

        temp_armatures = import_fbx(clip_path)
        if not temp_armatures:
            print(f"[build] No armature in clip {clip_file}", file=sys.stderr)
            sys.exit(1)
        temp_arm = temp_armatures[0]

        action = temp_arm.animation_data.action if temp_arm.animation_data else None
        if action is None:
            print(f"[build] No action in clip {clip_file}", file=sys.stderr)
            sys.exit(1)

        # Detach from the temp armature, rename to the semantic contract name.
        temp_arm.animation_data.action = None
        action.name = anim_name
        action.use_fake_user = True  # keep it alive after the temp armature is gone

        track = soldier_arm.animation_data.nla_tracks.new()
        track.name = anim_name
        strip = track.strips.new(anim_name, 1, action)
        strip.name = anim_name

        bpy.data.objects.remove(temp_arm, do_unlink=True)
        print(f"[build]   + clip '{anim_name}' <- {clip_file} "
              f"({count_fcurves(action)} fcurves)")

    # 3) Clear the soldier's T-pose active action so only the NLA tracks export.
    soldier_arm.animation_data.action = None

    # Delete any leftover actions (e.g. the imported T-pose "mixamo.com") so the
    # exporter only emits the named clips. NLA strips above hold their own refs.
    keep = {name for _, name in CLIP_MAP} | {name for _, name in DISABILITY_CLIP_MAP}
    for action in list(bpy.data.actions):
        if action.name not in keep:
            bpy.data.actions.remove(action)

    # 4) Select only the soldier armature + its mesh children for export.
    bpy.ops.object.select_all(action="DESELECT")
    soldier_arm.select_set(True)
    for child in soldier_arm.children:
        child.select_set(True)
    bpy.context.view_layer.objects.active = soldier_arm

    # 5) Export Draco GLB with animations.
    export_kwargs = dict(
        filepath=OUTPUT_GLB,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        use_selection=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=True,
        export_force_sampling=True,
        export_optimize_animation_size=True,
    )
    try:
        export_kwargs["export_draco_mesh_compression_enable"] = True
        export_kwargs["export_draco_mesh_compression_level"] = 7
    except Exception:
        pass

    try:
        bpy.ops.export_scene.gltf(**export_kwargs)
    except TypeError as exc:
        print(f"[build] Some export options rejected ({exc}); retrying minimal...")
        minimal = dict(
            filepath=OUTPUT_GLB,
            export_format="GLB",
            export_yup=True,
            export_apply=True,
            use_selection=True,
            export_animations=True,
        )
        try:
            minimal["export_draco_mesh_compression_enable"] = True
            minimal["export_draco_mesh_compression_level"] = 6
        except Exception:
            pass
        bpy.ops.export_scene.gltf(**minimal)

    size = os.path.getsize(OUTPUT_GLB) if os.path.exists(OUTPUT_GLB) else 0
    print(f"[build] Done. Output: {OUTPUT_GLB} ({size/1024:.0f} KB)")


if __name__ == "__main__":
    main()
