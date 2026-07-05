#!/usr/bin/env python3
"""Build the rally spectator model and gesture pack into one optimized GLB.

The base FBX is intentionally configurable so a future crowd2.fbx can replace
crowd1 without changing this script:

  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --python scripts/build-crowd-glb.py -- \
    --model assets-source/models/crowd/crowd2.fbx

All gesture FBXs must use the same bone names as the base model. Each source
action becomes one named NLA clip in the exported GLB. The skinned mesh is
decimated only when it exceeds the requested triangle target, textures are
resized for runtime use, and the final GLB uses Draco compression.
"""

import argparse
import os
import sys

import bpy
from mathutils import Matrix


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DEFAULT_MODEL = os.path.join(REPO_ROOT, "assets-source/models/crowd/crowd1.fbx")
DEFAULT_ANIMATION_DIR = os.path.join(REPO_ROOT, "assets-source/animations/crowd-gestures")
DEFAULT_OUTPUT = os.path.join(REPO_ROOT, "public/assets/models/crowd.glb")

CLIP_MAP = [
    ("Cheering.fbx", "Cheering"),
    ("acknowledging.fbx", "Acknowledging"),
    ("angry gesture.fbx", "Angry Gesture"),
    ("annoyed head shake.fbx", "Annoyed Head Shake"),
    ("being cocky.fbx", "Being Cocky"),
    ("dismissing gesture.fbx", "Dismissing Gesture"),
    ("happy hand gesture.fbx", "Happy Hand Gesture"),
    ("hard head nod.fbx", "Hard Head Nod"),
    ("head nod yes.fbx", "Head Nod Yes"),
    ("lengthy head nod.fbx", "Lengthy Head Nod"),
    ("look away gesture.fbx", "Look Away Gesture"),
    ("Looking.fbx", "Looking"),
    ("relieved sigh.fbx", "Relieved Sigh"),
    ("sarcastic head nod.fbx", "Sarcastic Head Nod"),
    ("shaking head no.fbx", "Shaking Head No"),
    ("Stand To Roll.fbx", "Stand To Roll"),
    ("thoughtful head shake.fbx", "Thoughtful Head Shake"),
    ("weight shift.fbx", "Weight Shift"),
]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--animations-dir", default=DEFAULT_ANIMATION_DIR)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--target-triangles", type=int, default=5500)
    parser.add_argument("--texture-size", type=int, default=1024)
    return parser.parse_args(argv)


def import_fbx(path):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, use_image_search=False)
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    armatures = [obj for obj in imported if obj.type == "ARMATURE"]
    return imported, armatures


def triangle_count(mesh_object):
    return sum(max(0, len(polygon.vertices) - 2) for polygon in mesh_object.data.polygons)


def align_base_rig_to_gesture_basis(armature_object, mesh_object):
    """crowd1 is authored 90 degrees off the gesture pack's local bind basis."""
    correction = Matrix.Rotation(-1.5707963267948966, 4, "X")
    armature_object.data.transform(correction)
    mesh_object.data.transform(correction)
    armature_object.data.update_tag()
    mesh_object.data.update()


def decimate_mesh(mesh_object, target_triangles):
    before = triangle_count(mesh_object)
    if target_triangles <= 0 or before <= target_triangles:
        return before, before

    ratio = max(0.05, min(1.0, target_triangles / before))
    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    bpy.context.view_layer.objects.active = mesh_object
    modifier = mesh_object.modifiers.new(name="CrowdRuntimeDecimate", type="DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    bpy.ops.object.modifier_move_to_index(modifier=modifier.name, index=0)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return before, triangle_count(mesh_object)


def resize_textures(max_size):
    if max_size <= 0:
        return
    for image in bpy.data.images:
        width, height = image.size[:]
        if width <= max_size and height <= max_size:
            continue
        scale = min(max_size / width, max_size / height)
        target_width = max(1, round(width * scale))
        target_height = max(1, round(height * scale))
        image.scale(target_width, target_height)
        image.pack()
        print(f"[crowd] texture {image.name}: {width}x{height} -> {target_width}x{target_height}")


def remove_objects(objects):
    for obj in objects:
        if obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)


def main():
    args = parse_args()
    model_path = os.path.abspath(args.model)
    animation_dir = os.path.abspath(args.animations_dir)
    output_path = os.path.abspath(args.output)

    required = [model_path] + [os.path.join(animation_dir, filename) for filename, _ in CLIP_MAP]
    missing = [path for path in required if not os.path.exists(path)]
    if missing:
        print("[crowd] Missing input files:\n  " + "\n  ".join(missing), file=sys.stderr)
        sys.exit(1)

    bpy.ops.wm.read_homefile(use_empty=True)
    model_objects, model_armatures = import_fbx(model_path)
    if len(model_armatures) != 1:
        raise RuntimeError(f"Expected one armature in {model_path}, found {len(model_armatures)}")

    crowd_armature = model_armatures[0]
    crowd_armature.name = "CrowdArmature"
    crowd_meshes = [obj for obj in model_objects if obj.type == "MESH"]
    if len(crowd_meshes) != 1:
        raise RuntimeError(f"Expected one crowd mesh, found {len(crowd_meshes)}")
    crowd_mesh = crowd_meshes[0]
    crowd_mesh.name = "CrowdMesh"
    align_base_rig_to_gesture_basis(crowd_armature, crowd_mesh)
    base_bones = tuple(bone.name for bone in crowd_armature.data.bones)
    print(f"[crowd] model {os.path.basename(model_path)}: {len(base_bones)} bones, "
          f"{triangle_count(crowd_mesh)} triangles")

    if crowd_armature.animation_data:
        crowd_armature.animation_data.action = None
    else:
        crowd_armature.animation_data_create()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)

    for filename, clip_name in CLIP_MAP:
        clip_path = os.path.join(animation_dir, filename)
        imported, armatures = import_fbx(clip_path)
        if len(armatures) != 1:
            raise RuntimeError(f"Expected one armature in {filename}, found {len(armatures)}")
        source_armature = armatures[0]
        source_bones = tuple(bone.name for bone in source_armature.data.bones)
        if source_bones != base_bones:
            raise RuntimeError(f"Bone hierarchy mismatch in {filename}")
        action = source_armature.animation_data.action if source_armature.animation_data else None
        if action is None:
            raise RuntimeError(f"No animation action in {filename}")

        source_armature.animation_data.action = None
        action.name = clip_name
        action.use_fake_user = True
        track = crowd_armature.animation_data.nla_tracks.new()
        track.name = clip_name
        strip = track.strips.new(clip_name, 1, action)
        strip.name = clip_name
        print(f"[crowd] clip {clip_name}: frames {action.frame_range[0]:.0f}-{action.frame_range[1]:.0f}")
        remove_objects(imported)

    crowd_armature.animation_data.action = None
    keep_actions = {clip_name for _, clip_name in CLIP_MAP}
    for action in list(bpy.data.actions):
        if action.name not in keep_actions:
            bpy.data.actions.remove(action)

    before_triangles, after_triangles = decimate_mesh(crowd_mesh, args.target_triangles)
    print(f"[crowd] decimation: {before_triangles} -> {after_triangles} triangles")
    resize_textures(args.texture_size)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    crowd_armature.select_set(True)
    crowd_mesh.select_set(True)
    bpy.context.view_layer.objects.active = crowd_armature

    export_kwargs = dict(
        filepath=output_path,
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
        export_animation_mode="NLA_TRACKS",
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=7,
    )
    bpy.ops.export_scene.gltf(**export_kwargs)
    size = os.path.getsize(output_path)
    print(f"[crowd] wrote {output_path} ({size / 1024 / 1024:.2f} MiB)")


if __name__ == "__main__":
    main()
