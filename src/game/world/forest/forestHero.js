import * as THREE from 'three';

const _Y = new THREE.Vector3(0, 1, 0);
const _MATRIX = new THREE.Matrix4();
const MAX_HERO_INSTANCES_PER_DRAW = 512;

function sliceInstancedAttribute(attribute, start, count) {
  const offset = start * attribute.itemSize;
  const sliced = new THREE.InstancedBufferAttribute(
    attribute.array.slice(offset, offset + count * attribute.itemSize),
    attribute.itemSize,
    attribute.normalized,
    attribute.meshPerAttribute,
  );
  sliced.setUsage(attribute.usage);
  sliced.needsUpdate = true;
  return sliced;
}

/** Split full-leaf hero meshes into WebGPU-safe, internally consistent draws. */
export function splitHeroInstancedMeshes(root, limit = MAX_HERO_INSTANCES_PER_DRAW) {
  const oversized = [];
  root.traverse((object) => {
    if (object.isInstancedMesh && object.count > limit) oversized.push(object);
  });

  for (const source of oversized) {
    const parent = source.parent;
    if (!parent) continue;

    for (let start = 0; start < source.count; start += limit) {
      const count = Math.min(limit, source.count - start);
      const geometry = source.geometry.clone();
      geometry.userData.forestHeroChunkGeometry = true;
      for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
        if (attribute.isInstancedBufferAttribute) {
          geometry.setAttribute(name, sliceInstancedAttribute(attribute, start, count));
        }
      }

      const chunk = new THREE.InstancedMesh(geometry, source.material, count);
      chunk.name = `${source.name || 'Hero Foliage'} ${start}-${start + count - 1}`;
      chunk.position.copy(source.position);
      chunk.quaternion.copy(source.quaternion);
      chunk.scale.copy(source.scale);
      chunk.castShadow = source.castShadow;
      chunk.receiveShadow = source.receiveShadow;
      chunk.renderOrder = source.renderOrder;
      chunk.frustumCulled = false;
      chunk.userData = { ...source.userData, forestHeroChunk: true };
      for (let index = 0; index < count; index += 1) {
        source.getMatrixAt(start + index, _MATRIX);
        chunk.setMatrixAt(index, _MATRIX);
      }
      chunk.instanceMatrix.needsUpdate = true;
      parent.add(chunk);
    }

    parent.remove(source);
    source.dispose?.();
  }

  return oversized.length;
}

/**
 * Real (non-forest-bucket) LOD1 hero trees for the closest N placements.
 *
 * The instanced forest buckets merge every tree of an archetype into one
 * InstancedMesh and add a `aTreeOrigin` instance attribute to drive wind; that
 * extra buffer blows WebGPU's 8-vertex-buffer budget, so three falls back to a
 * 64 KiB uniform buffer for instance data — capping a bucket at ~512 instances.
 * Single-leaf foliage is ~5–7k cards/tree, so the bucket path is forced to
 * subsample to a handful of cards (the cluster-card LOD). That is why the live
 * forest never showed the crisp single-leaf SeedThree look.
 *
 * Hero trees preserve every leaf card but split oversized foliage into bounded
 * InstancedMeshes. Each draw owns matching matrix and custom-attribute ranges.
 *
 * `lod1Group.clone(true)` shares geometry + material with the archetype source
 * (clone only copies Object3D wrappers + the per-leaf instanceMatrix buffer), so
 * the pool is bounded to `heroCount` clones regardless of how many species are
 * mixed. Per-tree placement is a parent group transform; wind runs through the
 * shared per-leaf `aAnchorPos`/`aWindVec`/`aThickness` attributes.
 *
 * @param {Array} archetypes  archetype pack entries (needs `.lod1Group`)
 * @param {object} opts
 * @param {number} opts.heroCount   max simultaneously visible hero trees
 * @param {boolean} opts.castShadow hero foliage casts + receives shadows
 */
export function createHeroForestPool(archetypes, {
  heroCount = 24,
  castShadow = false,
  foliageShadows = false,
} = {}) {
  const group = new THREE.Group();
  group.name = 'Forest Hero Trees';
  group.userData.noCollision = true;
  group.frustumCulled = false; // children carry their own (off) cull flag

  const slots = [];
  for (let i = 0; i < heroCount; i += 1) {
    const slotGroup = new THREE.Group();
    slotGroup.userData.noCollision = true;
    slotGroup.visible = false;
    // Slot bounds are stale the moment a rebin repositions the group; culling is
    // handled on the child meshes (frustumCulled=false), so never cull the slot.
    slotGroup.frustumCulled = false;
    group.add(slotGroup);
    slots.push({ group: slotGroup, archetypeIndex: -1, clone: null, clones: new Map() });
  }

  const disposeClone = (clone) => {
    clone.removeFromParent();
    // InstancedMesh.dispose() frees only its own instanceMatrix buffer — shared
    // source geometry/material remain owned by the archetype pack.
    clone.traverse((o) => {
      if (!o.isInstancedMesh) return;
      if (o.geometry?.userData?.forestHeroChunkGeometry) o.geometry.dispose();
      o.dispose?.();
    });
  };

  const createClone = (slot, archetypeIndex) => {
    const arch = archetypes[archetypeIndex];
    if (!arch?.lod1Group) return null;
    const clone = arch.lod1Group.clone(true);
    splitHeroInstancedMeshes(clone);
    clone.visible = false;
    clone.traverse((o) => {
      // Bark (plain Mesh) shadows are cheap and safe; foliage (InstancedMesh
      // SSS node material) shadows are gated separately — the depth/shadow pass
      // for the wind positionNode is the fragile path, opt in via foliageShadows.
      if (o.isInstancedMesh) {
        o.castShadow = foliageShadows;
        o.receiveShadow = foliageShadows;
      } else if (o.isMesh) {
        o.castShadow = castShadow;
        o.receiveShadow = castShadow;
      }
      if (o.isMesh || o.isInstancedMesh) o.frustumCulled = false;
    });
    slot.group.add(clone);
    slot.clones.set(archetypeIndex, clone);
    return clone;
  };

  const attachClone = (slot, archetypeIndex) => {
    if (slot.archetypeIndex === archetypeIndex && slot.clone) return true;
    if (slot.clone) slot.clone.visible = false;
    const clone = slot.clones.get(archetypeIndex) ?? createClone(slot, archetypeIndex);
    if (!clone) return false;
    clone.visible = true;
    slot.clone = clone;
    slot.archetypeIndex = archetypeIndex;
    return true;
  };

  /**
   * Assign the closest `heroCount` placements (call already sorts near→far and
   * radius-gates). Each slot maps to one placement; leftover slots hide.
   * @param {Array} heroSlots  placements sorted nearest first (or null to clear)
   */
  const assign = (heroSlots) => {
    const list = heroSlots ?? [];
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      const p = list[i];
      if (!p) {
        slot.group.visible = false;
        continue;
      }
      if (!attachClone(slot, p.archetypeIndex)) {
        slot.group.visible = false;
        continue;
      }
      slot.group.position.set(p.x, p.y, p.z);
      slot.group.quaternion.setFromAxisAngle(_Y, p.rotY ?? 0);
      slot.group.scale.setScalar(p.scale ?? 1);
      slot.group.visible = true;
    }
  };

  const dispose = () => {
    for (const slot of slots) {
      for (const clone of slot.clones.values()) disposeClone(clone);
      slot.clones.clear();
      slot.clone = null;
      slot.archetypeIndex = -1;
    }
  };

  return { group, assign, dispose, heroCount };
}
