/**
 * Magazine part extraction / re-attachment (docs/advanced-reload-system-plan.md,
 * AR1). Pure scene-graph bookkeeping — no THREE import, no physics: given a
 * loaded gun root + its profile, locate the live magazine mesh(es) (identity
 * `magazine` + behavior `detaches_on_reload`) and detach/re-attach them while
 * preserving world transforms so the reload can carry the live mag and later
 * restore or replace it.
 *
 * Detach uses THREE's `Object3D.attach` (reparent preserving world transform);
 * re-attach restores the captured gun-local transform, round-tripping to within
 * floating-point tolerance.
 */

/** A part is a detachable magazine when tagged as such in the Gunsmith. */
export function isMagazinePart(part) {
  return part?.identity === 'magazine'
    && Array.isArray(part.behaviors)
    && part.behaviors.includes('detaches_on_reload');
}

/** All detachable-magazine part annotations on a profile. */
export function findMagazineParts(profile) {
  if (!Array.isArray(profile?.parts)) return [];
  return profile.parts.filter(isMagazinePart);
}

/**
 * Resolve the magazine part annotations to their meshes under a loaded gun root.
 * Matches by `part.meshName`; skips parts whose mesh is absent.
 * @returns {Array<{ mesh: object, part: object }>}
 */
export function findMagazineMeshes(gunRoot, profile) {
  const parts = findMagazineParts(profile);
  if (!gunRoot || !parts.length) return [];
  const byName = new Map();
  gunRoot.traverse((obj) => {
    if (obj?.name && !byName.has(obj.name)) byName.set(obj.name, obj);
  });
  const out = [];
  for (const part of parts) {
    const mesh = byName.get(part.meshName);
    if (mesh) out.push({ mesh, part });
  }
  return out;
}

/**
 * Detach the live magazine mesh onto a transient holder, preserving its world
 * transform. Returns a record used to restore (AR1) or discard (AR2 drop) it.
 * @param {object} magMesh the magazine Object3D currently under the gun
 * @param {object} holder  the Object3D that will carry the mag (e.g. left hand)
 * @returns {null|{ magMesh: object, originalParent: object, position, quaternion, scale }}
 */
export function detachMagazine(magMesh, holder) {
  if (!magMesh || !holder || typeof holder.attach !== 'function') return null;
  const record = {
    magMesh,
    originalParent: magMesh.parent ?? null,
    position: magMesh.position.clone(),
    quaternion: magMesh.quaternion.clone(),
    scale: magMesh.scale.clone(),
  };
  // Object3D.attach reparents while keeping the mesh fixed in world space, and
  // updates the world matrices it needs internally.
  holder.attach(magMesh);
  return record;
}

/**
 * Restore a detached magazine to its original parent and gun-local transform.
 * Recovers the pre-detach world transform exactly (within float error).
 * @param {ReturnType<detachMagazine>} record
 * @returns {boolean}
 */
export function reattachMagazine(record) {
  if (!record?.magMesh || !record.originalParent) return false;
  const { magMesh, originalParent } = record;
  originalParent.add(magMesh);
  magMesh.position.copy(record.position);
  magMesh.quaternion.copy(record.quaternion);
  magMesh.scale.copy(record.scale);
  magMesh.updateMatrix();
  magMesh.updateMatrixWorld?.(true);
  return true;
}
