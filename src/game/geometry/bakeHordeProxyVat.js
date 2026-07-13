/**
 * Bake multi-pose proxy geometry for GPU walk + attack blend (Horde M5).
 *
 * Base `position` = mid-stride walk. Extra attributes carry DELTA offsets that
 * the vertex shader (MeshStandardNodeMaterial.positionNode) adds on top of the
 * base per instance + time — no InstancedMesh hopping (avoids the WebGPU strobe
 * from the old multi-mesh pose buckets):
 *   - `pose1` = alternate walk frame delta → advancing agents cycle a stride.
 *   - `pose2` = melee strike delta (the 'Bite' clip holds a punch) → agents that
 *     reach the player play a strike instead of freezing mid-stride.
 * The two are mutually exclusive at runtime (an agent is advancing OR attacking),
 * driven by per-instance walk/attack weights.
 */

import * as THREE from 'three';
import { prepareBakedCrowdPoseCatalog } from './prepareBakedCrowdPoses.js';

/** Walk frames used for the GPU cycle (same clip, different sample times). */
export const HORDE_VAT_WALK_POSES = Object.freeze([
  { key: 'advance_0', anim: 'advance', clipName: 'Walk', sampleTime: 0 },
  { key: 'advance_1', anim: 'advance', clipName: 'Walk', sampleTime: 0.33 },
  { key: 'advance_2', anim: 'advance', clipName: 'Walk', sampleTime: 0.66 },
]);

/** Melee strike pose. 'Bite' holds a punch (kept for name compat). */
export const HORDE_VAT_ATTACK_POSE = Object.freeze(
  { key: 'attack_0', anim: 'attack', clipName: 'Bite', sampleTime: 0.4 },
);

/** Walk limb motion is small; anything larger is failed root lock / junk. */
const WALK_DELTA_CAP = 0.55;
/** A punch reaches out ~0.7 m at the hand — allow more travel than a stride. */
const ATTACK_DELTA_CAP = 1.0;

/**
 * @returns {{
 *   geometry: THREE.BufferGeometry,
 *   poses: object[],
 *   vertexCount: number,
 *   frameCount: number,
 * } | null}
 */
export function bakeHordeProxyVatGeometry({
  sceneRoot,
  clips,
  targetHeight,
  orientationFixX = 0,
  vertexLimit = 18_000,
} = {}) {
  if (!sceneRoot) return null;

  const catalog = prepareBakedCrowdPoseCatalog(sceneRoot, clips, {
    entries: [...HORDE_VAT_WALK_POSES, HORDE_VAT_ATTACK_POSE],
    targetHeight,
    orientationFixX,
  });
  if (catalog.length < 2) {
    for (const entry of catalog) entry.geometry?.dispose?.();
    return null;
  }

  // Prefer mid-stride as the base pose (stable idle silhouette when mix weight → 0).
  const baseEntry = catalog.find((e) => e.key === 'advance_1') ?? catalog[0];
  const altEntry = catalog.find((e) => e.key === 'advance_2')
    ?? catalog.find((e) => e.anim === 'advance' && e !== baseEntry)
    ?? catalog[1];
  const attackEntry = catalog.find((e) => e.key === 'attack_0') ?? null;

  const basePos = baseEntry.geometry?.getAttribute('position');
  const altPos = altEntry.geometry?.getAttribute('position');
  if (!basePos || !altPos || basePos.count !== altPos.count || basePos.count <= 0) {
    for (const entry of catalog) entry.geometry?.dispose?.();
    return null;
  }
  if (basePos.count > vertexLimit) {
    for (const entry of catalog) entry.geometry?.dispose?.();
    return null;
  }

  const geometry = baseEntry.geometry.clone();
  const baseArr = basePos.array;

  // Store poses as DELTAS from the base pose, not absolute positions. Absolute
  // mix reintroduces residual root translation between sample times and makes
  // some instances "hyperspeed" as the whole mesh lerps metres of root motion.
  const walk = buildCappedDelta(altPos.array, baseArr, WALK_DELTA_CAP);
  geometry.setAttribute('pose1', new THREE.BufferAttribute(walk.array, 3));

  // Attack delta (strike pose - base). Zero-filled if the clip is missing so
  // the shader's pose2 term stays inert (agents just fall back to no strike).
  let attackMaxAbs = 0;
  const attackPos = attackEntry?.geometry?.getAttribute('position');
  if (attackPos && attackPos.count === basePos.count) {
    const attack = buildCappedDelta(attackPos.array, baseArr, ATTACK_DELTA_CAP);
    geometry.setAttribute('pose2', new THREE.BufferAttribute(attack.array, 3));
    attackMaxAbs = attack.maxAbs;
  } else {
    geometry.setAttribute('pose2', new THREE.BufferAttribute(new Float32Array(baseArr.length), 3));
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  // The strike reaches beyond the base silhouette; pad the cull sphere so an
  // extended punch is not frustum-culled at the arena edge.
  if (geometry.boundingSphere && attackMaxAbs > 0) {
    geometry.boundingSphere.radius += attackMaxAbs;
  }

  for (const entry of catalog) {
    if (entry.geometry !== geometry) entry.geometry?.dispose?.();
  }

  return {
    geometry,
    poses: catalog.map((e) => ({ key: e.key, anim: e.anim, sampleTime: e.sampleTime })),
    vertexCount: basePos.count,
    frameCount: attackPos ? 3 : 2,
    pose1IsDelta: true,
    maxPoseDelta: walk.maxAbs,
    maxAttackDelta: attackMaxAbs,
  };
}

/**
 * Component-wise `alt - base`, hard-capped so pathological deltas (failed root
 * lock / mismatched topology) can't fling the mesh. Returns the (possibly
 * scaled) delta array plus its final peak magnitude.
 */
function buildCappedDelta(altArr, baseArr, cap) {
  const array = new Float32Array(altArr.length);
  let maxAbs = 0;
  for (let i = 0; i < array.length; i += 1) {
    const d = altArr[i] - baseArr[i];
    array[i] = d;
    const a = Math.abs(d);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs > cap) {
    const scale = cap / maxAbs;
    for (let i = 0; i < array.length; i += 1) array[i] *= scale;
    maxAbs = cap;
  }
  return { array, maxAbs };
}
