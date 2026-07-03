#!/usr/bin/env python3
"""
prepare-jacket-cloth.py

Helper for turning a jacket FBX (skinned to same rig as the player) into
something ready for three-simplecloth.

- Adds a vertex color layer ("color") used as the cloth mask.
  Red (1,1,1) = full dynamic cloth
  White-ish (0,0,0) = pinned/stuck to the body (collar, shoulders, cuffs)

- Optional: merge a jacket onto a base player FBX so you end up with one
  GLB containing body + jacket SkinnedMeshes sharing the armature.

Usage (headless Blender):

  # 1) Just paint the jacket and export as GLB (recommended)
  /Applications/Blender.app/Contents/MacOS/blender --background --python scripts/prepare-jacket-cloth.py -- \
      jacket_input.fbx jacket_with_mask.glb

  # 2) Merge player + jacket (both FBX) -> single GLB
  /Applications/Blender.app/Contents/MacOS/blender --background --python scripts/prepare-jacket-cloth.py -- \
      --merge player.fbx jacket.fbx combined_player_jacket.glb

After this you can drop the output .glb into assets and change JACKET_MODEL_URL (or combine into the main player asset).

The mask painting is heuristic (based on local height + center line). 
For best results open the result in Blender, go to Vertex Paint, tweak the red/white areas, and re-export with vertex colors.
"""

import sys
import bpy
from mathutils import Vector

def clear_scene():
    bpy.ops.wm.read_homefile(use_empty=True)

def import_fbx(path):
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, use_image_search=False)
    # Return the imported objects (usually an armature + meshes)
    return [o for o in bpy.context.selected_objects]

def add_vertex_color_cloth_mask(obj, pinned_top_ratio=0.18, pinned_center_width=0.22):
    """
    Paint a color attribute on the mesh.
    High red value = cloth (floppy)
    Low red value = pinned (follows skin exactly)
    """
    if obj.type != 'MESH':
        return

    mesh = obj.data

    # Make sure we have a color attribute
    color_attr_name = 'color'
    if color_attr_name not in mesh.attributes:
        color_layer = mesh.attributes.new(name=color_attr_name, type='FLOAT_COLOR', domain='POINT')
    else:
        color_layer = mesh.attributes[color_attr_name]

    # Compute local bounds for the mesh (in its own object space)
    min_y = min((v.co.y for v in mesh.vertices), default=0)
    max_y = max((v.co.y for v in mesh.vertices), default=1)
    height = max(0.001, max_y - min_y)

    center_x = (min((v.co.x for v in mesh.vertices), default=0) +
                max((v.co.x for v in mesh.vertices), default=0)) * 0.5

    for i, v in enumerate(mesh.vertices):
        t = (v.co.y - min_y) / height   # 0 at bottom, 1 at top of jacket mesh

        # Default = full cloth (red = 1)
        val = 1.0

        # Top band (collar/shoulder) is pinned
        if t > (1.0 - pinned_top_ratio):
            val = 0.08

        # Center strip of upper torso is more attached
        if t > 0.55 and abs(v.co.x - center_x) < pinned_center_width * 0.6:
            val = min(val, 0.18)

        # Cuffs near wrists - make them a little more pinned if they are high |x| and high-ish y
        if abs(v.co.x - center_x) > 0.35 and t > 0.48:
            val = min(val, 0.45)

        # Bottom hem very free
        if t < 0.15:
            val = 1.0

        # Write as RGB (the lib mainly cares about red channel)
        color_layer.data[i].color = (val, val, val, 1.0)

    print(f"[prepare-jacket] Painted cloth mask on {obj.name} ({len(mesh.vertices)} verts)")

def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_animations=True,
        export_vertex_color=True,
    )
    print(f"[prepare-jacket] Exported: {path}")

def main():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = argv[1:]

    if len(argv) < 2:
        print("Usage examples:")
        print("  blender --background --python scripts/prepare-jacket-cloth.py -- jacket.fbx jacket_painted.glb")
        print("  blender --background --python scripts/prepare-jacket-cloth.py -- --merge body.fbx jacket.fbx out.glb")
        sys.exit(1)

    clear_scene()

    merge_mode = False
    if argv[0] == "--merge":
        merge_mode = True
        argv = argv[1:]

    if merge_mode:
        if len(argv) < 3:
            print("Need body.fbx jacket.fbx output.glb for merge mode")
            sys.exit(1)
        body_path, jacket_path, out_path = argv[0], argv[1], argv[2]

        print(f"[prepare] Importing body: {body_path}")
        import_fbx(body_path)
        print(f"[prepare] Importing jacket: {jacket_path}")
        jacket_objs = import_fbx(jacket_path)

        # Try to find the jacket mesh(es)
        for obj in jacket_objs:
            if obj.type == 'MESH':
                add_vertex_color_cloth_mask(obj)
                # Make sure jacket is also parented under the same armature if possible
                # (user should have done proper skinning; this just ensures the color layer)
        export_glb(out_path)

    else:
        # Single jacket -> painted jacket
        jacket_path = argv[0]
        out_path = argv[1] if len(argv) > 1 else jacket_path.replace('.fbx', '_cloth.glb').replace('.FBX', '_cloth.glb')

        print(f"[prepare] Importing jacket: {jacket_path}")
        objs = import_fbx(jacket_path)

        for obj in objs:
            if obj.type == 'MESH':
                add_vertex_color_cloth_mask(obj)

        export_glb(out_path)

if __name__ == "__main__":
    main()
