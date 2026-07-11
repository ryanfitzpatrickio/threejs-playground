/**
 * Gun anchor (socket) vocabulary + pure matrix helpers.
 *
 * Ported from dust-and-bullets `gunAssembly.js` socket side only — our guns are
 * fully-assembled Meshy models, so part-mating math is intentionally omitted.
 * Anchor transforms live on gun profiles authored in the Gunsmith.
 */

/** Canonical anchor names used by runtime + Gunsmith. */
export const GUN_ANCHOR_NAMES = Object.freeze([
  'grip_mount',
  'left_hand_ik_target',
  'muzzle',
  'adsCamera',
  'mag_socket',
  // Reload magazine cycle (AR4): the fresh magazine's insertion reference and
  // the authored belt/pouch pickup location.
  'mag_insert',
  'mag_belt_source',
  'ejection_port',
  'stock_shoulder',
]);

/** Required anchors by weapon kind (used by store verification). */
export const REQUIRED_ANCHORS_BY_KIND = Object.freeze({
  rifle: ['grip_mount', 'left_hand_ik_target', 'muzzle', 'adsCamera'],
  pistol: ['grip_mount', 'muzzle', 'adsCamera'],
  shotgun: ['grip_mount', 'left_hand_ik_target', 'muzzle', 'adsCamera'],
});

/**
 * Alias table: when looking up an anchor, try these names in order.
 * Keeps compatibility with dust-and-bullets socket names where useful.
 */
export const ANCHOR_ALIASES = Object.freeze({
  grip_mount: ['grip_mount'],
  left_hand_ik_target: ['left_hand_ik_target', 'support_hand', 'handguard_ik'],
  muzzle: ['muzzle', 'barrel_tip'],
  adsCamera: ['adsCamera', 'sight_camera', 'scope_camera'],
  mag_socket: ['mag_socket', 'magazine_socket'],
  mag_insert: ['mag_insert', 'magazine_insert'],
  mag_belt_source: ['mag_belt_source', 'mag_pouch_source', 'magazine_belt_source'],
  ejection_port: ['ejection_port', 'eject'],
  stock_shoulder: ['stock_shoulder', 'stock_mount'],
  // Reference leftovers (not required for assembled guns, but resolvable)
  barrel_mount: ['barrel_mount', 'attachment_mount'],
  attachment_mount: ['attachment_mount', 'barrel_mount'],
  receiver_front: ['receiver_front'],
  receiver_rear: ['receiver_rear'],
  stock_mount: ['stock_mount', 'stock_shoulder'],
});

/** Default local transforms when a profile is missing an anchor. Units: meters. */
export const DEFAULT_ANCHORS = Object.freeze({
  grip_mount: makeAnchor('grip_mount', [0, 0, 0]),
  left_hand_ik_target: makeAnchor('left_hand_ik_target', [0.05, 0.02, 0.18]),
  muzzle: makeAnchor('muzzle', [0, 0.04, -0.45]),
  adsCamera: makeAnchor('adsCamera', [0, 0.08, 0.02]),
  mag_socket: makeAnchor('mag_socket', [0, -0.06, 0.05]),
  // `mag_insert` is in magazine-local space when AR4 seats a clone; identity is
  // a conservative fallback for assets without an authored insertion socket.
  mag_insert: makeAnchor('mag_insert', [0, 0, 0]),
  mag_belt_source: makeAnchor('mag_belt_source', [0.18, -0.38, 0.10]),
  ejection_port: makeAnchor('ejection_port', [0.03, 0.05, 0.02]),
  stock_shoulder: makeAnchor('stock_shoulder', [0, 0.02, 0.28]),
});

export const PART_IDENTITIES = Object.freeze([
  'receiver',
  'barrel',
  'stock',
  'grip',
  'handguard',
  'foregrip',
  'magazine',
  'scope',
  'sights',
  'trigger',
  'charging_handle',
  'slide',
  'pump',
  'sling',
  'misc',
]);

export const SURFACE_CLASSES = Object.freeze([
  'metal',
  'polymer',
  'wood',
  'rubber',
  'glass',
]);

export const BEHAVIOR_TAGS = Object.freeze([
  'detaches_on_reload',
  'reciprocates',
  'pump_slide',
  'folds',
  'scope_lens',
]);

function makeAnchor(name, position = [0, 0, 0], quaternion = [0, 0, 0, 1], scale = [1, 1, 1]) {
  return {
    name,
    position: [...position],
    quaternion: [...quaternion],
    scale: [...scale],
  };
}

export function createDefaultAnchor(name, overrides = {}) {
  const base = DEFAULT_ANCHORS[name] ?? makeAnchor(name);
  return {
    name,
    position: [...(overrides.position ?? base.position)],
    quaternion: [...(overrides.quaternion ?? base.quaternion)],
    scale: [...(overrides.scale ?? base.scale)],
  };
}

/**
 * @param {Array<{name:string}>|Record<string, object>|null} anchors
 * @param {string} anchorName
 * @param {object|null} fallback
 */
export function findAnchor(anchors, anchorName, fallback = null) {
  const names = ANCHOR_ALIASES[anchorName] || [anchorName];
  const list = normalizeAnchorList(anchors);

  for (const name of names) {
    const hit = list.find((a) => a?.name === name);
    if (hit) return hit;
  }

  if (fallback) return fallback;
  return DEFAULT_ANCHORS[anchorName] ?? null;
}

export function normalizeAnchorList(anchors) {
  if (!anchors) return [];
  if (Array.isArray(anchors)) return anchors.filter(Boolean);
  if (typeof anchors === 'object') {
    return Object.entries(anchors).map(([name, value]) => ({
      name,
      position: value?.position ?? [0, 0, 0],
      quaternion: value?.quaternion ?? [0, 0, 0, 1],
      scale: value?.scale ?? [1, 1, 1],
      ...value,
    }));
  }
  return [];
}

/** Build a Matrix4 from an anchor {position, quaternion, scale}. */
export function anchorToMatrix(anchor, outMatrix, THREE) {
  const pos = anchor?.position || [0, 0, 0];
  const quat = anchor?.quaternion || [0, 0, 0, 1];
  const scale = anchor?.scale || [1, 1, 1];
  const p = new THREE.Vector3(pos[0], pos[1], pos[2]);
  const q = new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3]);
  const s = new THREE.Vector3(scale[0], scale[1], scale[2]);
  return outMatrix.compose(p, q, s);
}

export function applyAnchorObjectTransform(object, anchor) {
  if (!object) return;
  const pos = anchor?.position || [0, 0, 0];
  const quat = anchor?.quaternion || [0, 0, 0, 1];
  const scale = anchor?.scale || [1, 1, 1];
  object.position.set(pos[0], pos[1], pos[2]);
  object.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
  object.scale.set(scale[0], scale[1], scale[2]);
}

/**
 * Place `object` so that its local `objectAnchor` coincides with `targetMatrix`
 * in the parent's space (same math as dust-and-bullets alignObjectSocketToMatrix).
 */
export function alignObjectAnchorToMatrix(object, objectAnchor, targetMatrix, THREE) {
  const socketMatrix = anchorToMatrix(objectAnchor, new THREE.Matrix4(), THREE);
  const objectMatrix = targetMatrix.clone().multiply(socketMatrix.invert());
  objectMatrix.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrix();
  object.updateMatrixWorld?.(true);
}

/** Validate that a profile has the required anchors for its kind. */
export function validateRequiredAnchors(profile) {
  const kind = profile?.weaponKind || profile?.kind || 'rifle';
  const required = REQUIRED_ANCHORS_BY_KIND[kind] || REQUIRED_ANCHORS_BY_KIND.rifle;
  const missing = [];
  for (const name of required) {
    if (!findAnchor(profile?.anchors, name, null)) {
      // findAnchor falls back to DEFAULT_ANCHORS — for validation we need authored
      // or explicit stubs. Check raw list only.
      const list = normalizeAnchorList(profile?.anchors);
      const aliases = ANCHOR_ALIASES[name] || [name];
      const has = list.some((a) => aliases.includes(a?.name));
      if (!has) missing.push(name);
    }
  }
  return { ok: missing.length === 0, missing, kind };
}

export function createStubAnchors(kind = 'rifle') {
  const required = REQUIRED_ANCHORS_BY_KIND[kind] || REQUIRED_ANCHORS_BY_KIND.rifle;
  const extras = GUN_ANCHOR_NAMES.filter((n) => !required.includes(n));
  return [...required, ...extras].map((name) => createDefaultAnchor(name));
}
