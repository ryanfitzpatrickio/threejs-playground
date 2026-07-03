#!/usr/bin/env python3
"""
Blender headless FBX -> optimized GLB converter.
Used via:
  /Applications/Blender.app/Contents/MacOS/blender --background --python scripts/convert-fbx-to-glb.py -- input.fbx output.glb

Options for size:
- Draco compression (built into Blender glTF exporter)
- We can apply limited decimation for very heavy meshes (disabled by default)
"""

import sys
import bpy

def main():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    if len(argv) < 2:
        print("Usage: blender --background --python convert-fbx-to-glb.py -- <input.fbx> <output.glb>")
        sys.exit(1)

    input_path = argv[0]
    output_path = argv[1]

    print(f"[blender] Clearing scene...")
    bpy.ops.wm.read_homefile(use_empty=True)

    print(f"[blender] Importing FBX: {input_path}")
    bpy.ops.import_scene.fbx(
        filepath=input_path,
        use_anim=True,
        use_image_search=False,   # avoid missing texture errors
    )

    # Select everything
    bpy.ops.object.select_all(action='DESELECT')
    for obj in bpy.context.scene.objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = bpy.context.selected_objects[0] if bpy.context.selected_objects else None

    # Optional light cleanup / normalize (safe for character rigs)
    for obj in bpy.context.selected_objects:
        if obj.type == 'MESH':
            # Ensure proper normals
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.normals_make_consistent(inside=False)
            bpy.ops.object.mode_set(mode='OBJECT')

    # Export as GLB with Draco where available
    print(f"[blender] Exporting GLB: {output_path}")
    export_kwargs = dict(
        filepath=output_path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=True,
        export_force_sampling=True,
        export_optimize_animation_size=True,
    )

    # Draco mesh compression (names vary slightly by Blender version)
    try:
        export_kwargs["export_draco_mesh_compression_enable"] = True
        export_kwargs["export_draco_mesh_compression_level"] = 7
    except Exception:
        pass

    try:
        bpy.ops.export_scene.gltf(**export_kwargs)
    except TypeError as e:
        print(f"[blender] Some export options rejected ({e}); retrying minimal + draco...")
        minimal = dict(
            filepath=output_path,
            export_format='GLB',
            export_yup=True,
            export_apply=True,
            export_animations=True,
        )
        try:
            minimal["export_draco_mesh_compression_enable"] = True
            minimal["export_draco_mesh_compression_level"] = 6
        except Exception:
            pass
        bpy.ops.export_scene.gltf(**minimal)

    print(f"[blender] Done. Output: {output_path}")

if __name__ == "__main__":
    main()
