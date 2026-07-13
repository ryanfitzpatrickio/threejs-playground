#!/usr/bin/env python3
"""
One-off Blender headless probe for the horde source FBXs.

For each bot it prints:
  - armature bone count + every bone name (raw + normalized) so we can confirm
    the Mixamo canonical names that soldierPartialCut.js resolves;
  - which REQUIRED_REGION bones are present / missing;
  - per-mesh vert / triangle counts and the max skin influences per vertex
    (FBXLoader silently drops >4 influences — we want to know how many we'll lose);
  - every packed image and its pixel size (informs the 1024 cap).

Run:
  /Applications/Blender.app/Contents/MacOS/blender --background \
    --python scripts/probe-horde-fbx.py
"""

import os
import re
import sys
import bpy

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HORDE_DIR = os.path.join(REPO_ROOT, "assets-source/models/horde")
BOTS = ["cyclop", "tessy", "faceless"]

# Mirrors soldierPartialCut.js REGION_SEVERANCE_BONES + the torso bones that
# file reads via bones.get(). All normalized (mixamorig prefix stripped, lower).
REQUIRED_REGION = {
    "head": ["headtop_end", "head", "neck"],
    "armL": ["lefthand", "leftforearm", "leftarm", "leftshoulder"],
    "armR": ["righthand", "rightforearm", "rightarm", "rightshoulder"],
    "legL": ["lefttoe_end", "lefttoebase", "leftfoot", "leftleg", "leftupleg"],
    "legR": ["righttoe_end", "righttoebase", "rightfoot", "rightleg", "rightupleg"],
    "torso": ["hips", "spine1", "spine"],
}
REQUIRED_ALL = sorted({n for group in REQUIRED_REGION.values() for n in group})


def normalize(name):
    # Match normalizeMixamoBoneName in soldierPartialCut.js: strip mixamorig[:]
    # prefix, lowercase. Also tolerate numbered mixamorig1: collisions.
    s = re.sub(r"^mixamorig\d*:?", "", str(name))
    return s.lower()


def armatures():
    return [o for o in bpy.data.objects if o.type == "ARMATURE"]


def max_influences(mesh_obj):
    """Max bones influencing any single vertex (skin weights >4 get dropped)."""
    counts = [0] * len(mesh_obj.data.vertices)
    for v in mesh_obj.data.vertices:
        cnt = sum(1 for g in v.groups if g.weight > 0.0)
        counts[v.index] = cnt
    return max(counts) if counts else 0


def influences_histogram(mesh_obj):
    counts = [0] * len(mesh_obj.data.vertices)
    for v in mesh_obj.data.vertices:
        cnt = sum(1 for g in v.groups if g.weight > 0.0)
        counts[v.index] = cnt
    hist = {}
    for c in counts:
        hist[c] = hist.get(c, 0) + 1
    return dict(sorted(hist.items()))


def probe_bot(name):
    fbx = os.path.join(HORDE_DIR, f"{name}.fbx")
    print(f"\n=== {name} ===  {fbx}")
    if not os.path.exists(fbx):
        print(f"  MISSING: {fbx}", file=sys.stderr)
        return

    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx, use_anim=True, use_image_search=False)

    arms = armatures()
    if not arms:
        print("  NO ARMATURE")
        return
    arm = arms[0]
    bone_names_raw = [b.name for b in arm.data.bones]
    bone_names_norm = {normalize(n): n for n in bone_names_raw}
    print(f"  armature: {arm.name}  bones: {len(bone_names_raw)}")

    missing = [n for n in REQUIRED_ALL if n not in bone_names_norm]
    print(f"  required region bones: {len(REQUIRED_ALL) - len(missing)}/{len(REQUIRED_ALL)} present")
    if missing:
        print(f"  MISSING required: {missing}")
    # Region-level summary
    for region, bones in REQUIRED_REGION.items():
        miss = [b for b in bones if b not in bone_names_norm]
        tag = "OK" if not miss else f"MISSING {miss}"
        print(f"    {region:5}: {tag}")

    # Dump the head/arm/leg/spine bone names raw so we can eyeball Mixamo shape.
    for region, bones in REQUIRED_REGION.items():
        present = [bone_names_norm[b] for b in bones if b in bone_names_norm]
        print(f"    {region:5} raw: {present}")

    # Mesh stats
    total_v = 0
    total_t = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        v = len(mesh.vertices)
        t = len(mesh.polygons)
        total_v += v
        total_t += t
        mi = max_influences(obj)
        hist = influences_histogram(obj)
        over4 = sum(c for n, c in hist.items() if n > 4)
        print(f"  mesh {obj.name:30}: verts={v:>8,} tris~{t:>8,} maxInfluences={mi} over4verts={over4:,} hist={hist}")
    print(f"  TOTAL verts={total_v:,}  tris~{total_t:,}")

    # Images / textures
    imgs = list(bpy.data.images)
    if imgs:
        print(f"  images: {len(imgs)}")
        for im in imgs:
            try:
                w, h = im.size[0], im.size[1]
            except Exception:
                w, h = "?", "?"
            print(f"    {im.name:40} {w}x{h}  packed={im.packed_file is not None}")
    else:
        print("  images: 0")


def main():
    for name in BOTS:
        probe_bot(name)
    print("\n[probe] done")


if __name__ == "__main__":
    main()
