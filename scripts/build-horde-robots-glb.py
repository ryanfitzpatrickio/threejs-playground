#!/usr/bin/env python3
"""
Blender headless builder for the three Horde robot enemy GLBs.

For each bot (cyclop / tessy / faceless) it:
  1. imports the source FBX (Mixamo armature + skinned mesh);
  2. validates the mixamorig bone set that soldierPartialCut.js resolves
     (REGION_SEVERANCE_BONES + hips/spine1);
  3. decimates the mesh to <= TARGET_VERTS (Collapse, preserving UV seams +
     boundary) — skipped when already under budget;
  4. limits skin influences to 4 per vertex and renormalizes (FBXLoader
     otherwise silently drops >4);
  5. caps packed textures;
  6. imports animation clip FBXs and binds them as named NLA tracks
     (identical Mixamo skeleton -> direct bind, no retarget);
  7. drops the unusable one-frame embedded `mixamo.com` action;
  8. exports a Draco-compressed GLB and prints a manifest.

Variants:
  full  — gameplay/cut mesh (~40k Blender verts, full clip set, 1024px textures)
          → public/assets/models/horde/{bot}.glb
  proxy — distance InstancedMesh bake source (~10k Blender verts, pose clips
          only, 512px textures) → public/assets/models/horde/{bot}-proxy.glb
          Runtime bakes idle/advance/attack/hit/fallen poses under the 18k
          proxy vertex budget (see HORDE_PROXY_VERTEX_LIMIT).

Mirrors scripts/build-soldier-glb.py. Stats/config live in enemyArchetypes.js,
not here, so balance changes do not rebuild assets.

Run:
  /Applications/Blender.app/Contents/MacOS/blender --background \
    --python scripts/build-horde-robots-glb.py

  # Proxy meshes only (faster when full GLBs already exist):
  /Applications/Blender.app/Contents/MacOS/blender --background \
    --python scripts/build-horde-robots-glb.py -- --proxy

  # Full combat GLBs only:
  ... --python scripts/build-horde-robots-glb.py -- --full
"""

import os
import re
import sys
import bpy

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HORDE_DIR = os.path.join(REPO_ROOT, "assets-source/models/horde")
RIFLE_DIR = os.path.join(REPO_ROOT, "assets-source/animations/rifle-pack")
DISABILITY_DIR = os.path.join(REPO_ROOT, "assets-source/animations/disability-pack")
# Horde-specific locomotion/attack clips (Mixamo), kept separate from rifle-pack
# so the shared soldier build (build-soldier-glb.py) is unaffected.
HORDE_LOCO_DIR = os.path.join(REPO_ROOT, "assets-source/animations/horde-locomotion")
OUT_DIR = os.path.join(REPO_ROOT, "public/assets/models/horde")

BOTS = ["cyclop", "tessy", "faceless"]
# Blender-unique vertex target. The glTF exporter duplicates vertices at UV /
# normal / material boundaries, so the exported (rendered) vert count runs
# ~1.1-1.2x higher than this. 40k Blender -> ~46-48k rendered, under the 50k
# doc budget. Adjust only after profiling proves a higher budget safe.
TARGET_VERTS = 40000
MAX_TEXTURE_PX = 1024
# Proxy: ~10k Blender → ~11–14k rendered after UV splits, under the 18k runtime
# bake budget used by HordeProxySystem (HORDE_PROXY_VERTEX_LIMIT).
PROXY_TARGET_VERTS = 10000
PROXY_MAX_TEXTURE_PX = 512
PROXY_MAX_BYTES = 3 * 1024 * 1024

# (source dir, source clip FBX, exported animation name). The exported names are
# the runtime contract — EnemySystem / soldierPartialCut.js / hordeProxyPoses.js
# reference these exact strings, so only the *source* clips change here, not the
# names. Horde locomotion + the melee attack ("Bite") come from HORDE_LOCO_DIR;
# "Idle Alert" (the proxy display pose) stays on the rifle-pack aiming clip.
# Note: "Bite" now holds a punch (Punching (2)); the name is kept for compat.
CLIP_MAP = [
    (HORDE_LOCO_DIR, "briefcase-idle.fbx", "Idle"),
    (HORDE_LOCO_DIR, "walking-3.fbx", "Walk"),
    (HORDE_LOCO_DIR, "fast-run-2.fbx", "Run"),
    (RIFLE_DIR, "idle-aiming.fbx", "Idle Alert"),
    (HORDE_LOCO_DIR, "punching-2.fbx", "Bite"),
]
DISABILITY_CLIP_MAP = [
    (DISABILITY_DIR, "head-missing.fbx", "Head Missing"),
    (DISABILITY_DIR, "head-missing-2.fbx", "Head Missing 2"),
    (DISABILITY_DIR, "left-arm-missing-walk.fbx", "Left Arm Missing Walk"),
    (DISABILITY_DIR, "right-arm-missing-walk.fbx", "Right Arm Missing Walk"),
    (DISABILITY_DIR, "left-leg-missing.fbx", "Left Leg Missing"),
    (DISABILITY_DIR, "right-leg-missing.fbx", "Right Leg Missing"),
    (DISABILITY_DIR, "crawl-forward.fbx", "Crawl Forward"),
    (DISABILITY_DIR, "crawl-back.fbx", "Crawl Back"),
]
# Only the clips HordeProxySystem samples for pose buckets (see hordeProxyPoses.js).
PROXY_CLIP_MAP = [
    (HORDE_LOCO_DIR, "briefcase-idle.fbx", "Idle"),
    (HORDE_LOCO_DIR, "walking-3.fbx", "Walk"),
    (HORDE_LOCO_DIR, "fast-run-2.fbx", "Run"),
    (RIFLE_DIR, "idle-aiming.fbx", "Idle Alert"),
    (HORDE_LOCO_DIR, "punching-2.fbx", "Bite"),
]
PROXY_DISABILITY_CLIP_MAP = [
    (DISABILITY_DIR, "crawl-forward.fbx", "Crawl Forward"),
]

# Mirrors soldierPartialCut.js REGION_SEVERANCE_BONES + torso bones. Normalized
# (mixamorig prefix stripped, lowercased) exactly like normalizeMixamoBoneName.
REQUIRED_REGION = {
    "head": ["headtop_end", "head", "neck"],
    "armL": ["lefthand", "leftforearm", "leftarm", "leftshoulder"],
    "armR": ["righthand", "rightforearm", "rightarm", "rightshoulder"],
    "legL": ["lefttoe_end", "lefttoebase", "leftfoot", "leftleg", "leftupleg"],
    "legR": ["righttoe_end", "righttoebase", "rightfoot", "rightleg", "rightupleg"],
    "torso": ["hips", "spine1", "spine"],
}
REQUIRED_ALL = sorted({n for g in REQUIRED_REGION.values() for n in g})


def normalize(name):
    return re.sub(r"^mixamorig\d*:?", "", str(name)).lower()


def reset_scene():
    bpy.ops.wm.read_homefile(use_empty=True)


def armature_objects():
    return [o for o in bpy.data.objects if o.type == "ARMATURE"]


def count_fcurves(action):
    """Count f-curves across both the legacy and Blender 4.4+ slotted APIs.

    On 4.4+ a slotted action's `action.fcurves` returns an empty collection
    (without raising), so fall through to the layers/strips/channelbag_slots
    walk when the legacy accessor is empty.
    """
    try:
        n = len(action.fcurves)
        if n > 0:
            return n
    except AttributeError:
        pass
    total = 0
    for layer in getattr(action, "layers", ()) or ():
        for strip in getattr(layer, "strips", ()) or ():
            for slot in getattr(strip, "channelbag_slots", ()) or ():
                total += len(getattr(slot, "fcurves", ()) or ())
    return total


def import_fbx(path):
    before = set(o.name for o in armature_objects())
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True, use_image_search=False)
    return [o for o in armature_objects() if o.name not in before]


def validate_bones(arm):
    present = {normalize(b.name) for b in arm.data.bones}
    missing = [n for n in REQUIRED_ALL if n not in present]
    if missing:
        print(f"[build]   FAIL: missing required bones: {missing}", file=sys.stderr)
        sys.exit(1)
    return len(present)


def skinned_meshes(arm):
    """Mesh objects skinned to the armature (its children + any with an armature modifier)."""
    out = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if obj.parent is arm or any(m.type == "ARMATURE" for m in obj.modifiers):
            out.append(obj)
    return out or [o for o in arm.children if o.type == "MESH"]


def decimate_mesh(mesh_obj, target_verts):
    before = len(mesh_obj.data.vertices)
    if before <= target_verts:
        print(f"[build]   decimate: skip ({before:,} verts already <= {target_verts:,})")
        return before, before
    ratio = max(0.02, target_verts / before)
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    mod = mesh_obj.modifiers.new(name="HordeDecimate", type="DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = False
    # Preserve UVs + boundary (Blender preserves vertex groups / UVs by default
    # in COLLAPSE; boundary protection is on by default).
    bpy.ops.object.modifier_apply(modifier=mod.name)
    after = len(mesh_obj.data.vertices)
    print(f"[build]   decimate: {before:,} -> {after:,} verts (ratio {ratio:.3f})")
    return before, after


def limit_weights(mesh_obj, limit=4):
    """Limit each vertex to `limit` bone influences and renormalize."""
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    # Limit total keeps the `limit` highest-weight groups per vertex and
    # renormalizes the rest. Mode ALL covers every vertex group (bone).
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=limit)


def cap_textures(max_px):
    scaled = 0
    for img in bpy.data.images:
        w, h = img.size[0], img.size[1]
        if not w or not h:
            continue
        if w <= max_px and h <= max_px:
            continue
        scale = max_px / float(max(w, h))
        nw = max(1, int(round(w * scale)))
        nh = max(1, int(round(h * scale)))
        img.scale(nw, nh)
        img.update()
        scaled += 1
        print(f"[build]   texture {img.name}: {w}x{h} -> {nw}x{nh}")
    return scaled


def attach_clips(arm, rifle_map=None, disability_map=None):
    """Import each clip FBX, move its action onto `arm` as a named NLA strip."""
    if not arm.animation_data:
        arm.animation_data_create()
    rifle_map = CLIP_MAP if rifle_map is None else rifle_map
    disability_map = DISABILITY_CLIP_MAP if disability_map is None else disability_map
    # Maps are (source_dir, clip_file, anim_name) tuples.
    all_clips = list(rifle_map) + list(disability_map)
    keep = {n for _, _, n in all_clips}
    for clip_dir, clip_file, anim_name in all_clips:
        clip_path = os.path.join(clip_dir, clip_file)
        if not os.path.exists(clip_path):
            print(f"[build]   FAIL: missing clip {clip_path}", file=sys.stderr)
            sys.exit(1)
        temp = import_fbx(clip_path)
        if not temp:
            print(f"[build]   FAIL: no armature in clip {clip_file}", file=sys.stderr)
            sys.exit(1)
        tarm = temp[0]
        action = tarm.animation_data.action if tarm.animation_data else None
        if action is None:
            print(f"[build]   FAIL: no action in clip {clip_file}", file=sys.stderr)
            sys.exit(1)
        tarm.animation_data.action = None
        action.name = anim_name
        action.use_fake_user = True
        track = arm.animation_data.nla_tracks.new()
        track.name = anim_name
        strip = track.strips.new(anim_name, 1, action)
        strip.name = anim_name
        bpy.data.objects.remove(tarm, do_unlink=True)
        print(f"[build]   + clip '{anim_name}' <- {clip_file} ({count_fcurves(action)} fcurves)")
    # Clear the keeper's active action (T-pose) so only NLA tracks export.
    arm.animation_data.action = None
    # Drop any leftover actions (e.g. the embedded one-frame mixamo.com T-pose).
    for action in list(bpy.data.actions):
        if action.name not in keep:
            bpy.data.actions.remove(action)
    return list(keep)


def export_glb(arm, out_path):
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    for child in arm.children:
        child.select_set(True)
    bpy.context.view_layer.objects.active = arm
    export_kwargs = dict(
        filepath=out_path,
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
        print(f"[build]   export options rejected ({exc}); retrying minimal...")
        minimal = dict(
            filepath=out_path, export_format="GLB", export_yup=True,
            export_apply=True, use_selection=True, export_animations=True,
        )
        try:
            minimal["export_draco_mesh_compression_enable"] = True
            minimal["export_draco_mesh_compression_level"] = 6
        except Exception:
            pass
        bpy.ops.export_scene.gltf(**minimal)


def manifest(bot, arm, verts_before, verts_after, clips, out_path, *, variant, target_verts, max_bytes):
    mats = len(bpy.data.materials)
    imgs = [(i.name, i.size[0], i.size[1]) for i in bpy.data.images if i.size[0]]
    bones = len(arm.data.bones)
    # Clip durations from the kept actions.
    clip_info = []
    for name in clips:
        act = bpy.data.actions.get(name)
        if act:
            fr = act.frame_range
            dur = (fr[1] - fr[0]) / 30.0 if fr[1] > fr[0] else 0.0
            clip_info.append((name, round(dur, 3)))
        else:
            clip_info.append((name, None))
    size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    print(f"\n[manifest] {bot} ({variant})")
    print(f"  verts: {verts_before:,} -> {verts_after:,}  (target {target_verts:,})")
    print(f"  bones: {bones}  materials: {mats}  textures: {len(imgs)}")
    for nm, w, h in imgs:
        print(f"    tex {nm}: {w}x{h}")
    print(f"  clips ({len(clip_info)}): {clip_info}")
    print(f"  output: {out_path}  ({size/1024:.0f} KB)")
    over_budget = []
    if verts_after > target_verts:
        over_budget.append(f"verts {verts_after} > {target_verts}")
    if size > max_bytes:
        over_budget.append(f"bytes {size} > {max_bytes}")
    if over_budget:
        print(f"  [WARN] over budget: {over_budget}")


def build_bot(bot, variant="full"):
    """
    variant:
      full  — combat/cut GLB ({bot}.glb)
      proxy — distance-instancing bake source ({bot}-proxy.glb)
    """
    if variant not in ("full", "proxy"):
        raise ValueError(f"unknown variant {variant!r}")

    fbx = os.path.join(HORDE_DIR, f"{bot}.fbx")
    if variant == "proxy":
        out_name = f"{bot}-proxy.glb"
        target_verts = PROXY_TARGET_VERTS
        max_tex = PROXY_MAX_TEXTURE_PX
        max_bytes = PROXY_MAX_BYTES
        rifle_map = PROXY_CLIP_MAP
        disability_map = PROXY_DISABILITY_CLIP_MAP
    else:
        out_name = f"{bot}.glb"
        target_verts = TARGET_VERTS
        max_tex = MAX_TEXTURE_PX
        max_bytes = 8 * 1024 * 1024
        rifle_map = CLIP_MAP
        disability_map = DISABILITY_CLIP_MAP

    out_path = os.path.join(OUT_DIR, out_name)
    print(f"\n[build] === {bot} ({variant}) ===  {fbx}")
    print(f"[build]   target verts={target_verts:,}  tex<={max_tex}px  -> {out_path}")

    reset_scene()
    arms = import_fbx(fbx)
    if not arms:
        print(f"[build] FAIL: no armature in {fbx}", file=sys.stderr)
        sys.exit(1)
    arm = arms[0]
    arm.name = f"{bot.capitalize()}{'Proxy' if variant == 'proxy' else ''}Armature"
    nbones = validate_bones(arm)
    print(f"[build]   armature {arm.name}: {nbones} bones (required OK)")

    meshes = skinned_meshes(arm)
    verts_before = 0
    verts_after = 0
    per_mesh_target = target_verts if len(meshes) == 1 else max(500, target_verts // len(meshes))
    for m in meshes:
        vb = len(m.data.vertices)
        verts_before += vb
        before, after = decimate_mesh(m, per_mesh_target)
        limit_weights(m, 4)
        verts_after += after
    if len(meshes) != 1:
        print(f"[build]   note: {len(meshes)} meshes; total verts {verts_before:,} -> {verts_after:,}")

    # If multi-mesh total still overshoots, decimate the densest mesh again.
    if verts_after > target_verts and meshes:
        densest = max(meshes, key=lambda m: len(m.data.vertices))
        extra_target = max(500, target_verts - (verts_after - len(densest.data.vertices)))
        print(f"[build]   re-decimate densest mesh to hit total target {target_verts:,}")
        _, after = decimate_mesh(densest, extra_target)
        verts_after = sum(len(m.data.vertices) for m in meshes)

    capped = cap_textures(max_tex)
    if capped == 0:
        print(f"[build]   textures: all <= {max_tex}px")

    clips = attach_clips(arm, rifle_map=rifle_map, disability_map=disability_map)
    export_glb(arm, out_path)
    manifest(
        bot, arm, verts_before, verts_after, clips, out_path,
        variant=variant, target_verts=target_verts, max_bytes=max_bytes,
    )


def parse_variants(argv):
    """Blender passes script args after `--`."""
    if "--proxy" in argv and "--full" in argv:
        return ["full", "proxy"]
    if "--proxy" in argv:
        return ["proxy"]
    if "--full" in argv:
        return ["full"]
    # Default: both so a clean rebuild is self-contained.
    return ["full", "proxy"]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    # When launched via `blender --python this.py -- --proxy`, args after `--`
    # land in sys.argv. Also accept bare flags for direct `python` debugging.
    variants = parse_variants(sys.argv)
    print(f"[build] variants: {variants}")
    for bot in BOTS:
        for variant in variants:
            build_bot(bot, variant=variant)
    print("\n[build] all bots done.")


if __name__ == "__main__":
    main()
