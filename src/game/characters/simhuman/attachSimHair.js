import * as THREE from 'three';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import { flattenObjectForWebGPU } from '../../geometry/prepareWebGPUGeometry.js';
import { disposeObject3D } from '../../utils/disposeObject3D.js';
import {
  DEFAULT_HAIR_FIT,
  sanitizeHairColor as schemaSanitizeHairColor,
  sanitizeHairFit,
} from './simAppearanceSchema.js';
import {
  DEFAULT_SIM_HAIR_COLOR,
  resolveSimHairAsset,
} from './simHairCatalog.js';
import {
  RIGIFY_HEAD_BONE,
  toRuntimeRigifyBoneName,
} from './rigifySkeleton.js';

const templatePromises = new Map();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _deg = THREE.MathUtils.degToRad;

/**
 * Attach a static hair-cap mesh to a sim actor / viewer model.
 *
 * Hierarchy:
 *   headBone (DEF-spine.006 / RIGIFY_HEAD_BONE)
 *     socket  ← user hairFit (scale / position / rotation in head space)
 *       base  ← auto-normalized so mesh top sits at the bone origin
 *
 * @param {object} options
 * @param {{ group: THREE.Object3D, model?: object, preset?: object }} options.actor
 * @param {THREE.Scene} [options.scene]
 * @param {string|null} [options.hairStyleId]
 * @param {string} [options.hairColor]
 * @param {object} [options.hairFit]
 * @param {number} [options.targetHeight]
 */
export async function attachSimHair({
  actor,
  scene,
  hairStyleId,
  hairColor,
  hairFit,
  targetHeight,
} = {}) {
  const styleId = hairStyleId
    ?? actor?.preset?.hairStyleId
    ?? null;
  if (!styleId) return null;

  const asset = resolveSimHairAsset(styleId);
  if (!asset) {
    throw new Error(`Unknown hair style: ${styleId}`);
  }

  const headBone = resolveHeadBone(actor);
  const parent = headBone ?? actor?.group ?? scene;
  if (!parent) {
    throw new Error('attachSimHair requires a head bone, actor.group, or scene');
  }
  if (!headBone) {
    console.warn('[sims] hair: no head bone found — parenting to character root');
  }

  const template = await loadHairTemplate(asset.url);
  const base = template.clone(true);
  base.name = `Sim Hair Base:${styleId}`;

  // Hide / drop every mesh except the authored keep set.
  const keep = new Set(asset.keepMeshIndices ?? []);
  const meshes = [];
  let meshIndex = 0;
  base.traverse((node) => {
    if (!node.isMesh) return;
    const keepThis = keep.size === 0 || keep.has(meshIndex);
    meshIndex += 1;
    if (!keepThis) {
      node.visible = false;
      return;
    }
    node.visible = true;
    node.castShadow = true;
    node.receiveShadow = true;
    node.frustumCulled = false;
    meshes.push(node);
  });

  if (meshes.length === 0) {
    disposeObject3D(base);
    throw new Error(`Hair ${styleId} has no kept meshes`);
  }

  const colorHex = sanitizeHairColor(hairColor
    ?? actor?.preset?.hairColor
    ?? asset.defaultColor
    ?? DEFAULT_SIM_HAIR_COLOR);
  const ownedMaterials = [];
  for (const mesh of meshes) {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      roughness: 0.62,
      metalness: 0.02,
      side: THREE.FrontSide,
    });
    ownedMaterials.push(mat);
    mesh.material = mat;
    mesh.name = mesh.name || `hair-${styleId}`;
  }

  // Auto-normalize in head space: scale to body height (cascade can hang long),
  // then pin the TOP of the mesh to the head-bone origin so the socket is the scalp.
  const bodyHeight = Number.isFinite(targetHeight) && targetHeight > 0
    ? targetHeight
    : resolveActorHeight(actor);
  normalizeHairToHeadSocket(base, bodyHeight);

  // Socket carries user fit so sliders never fight the auto-normalize bake.
  const socket = new THREE.Group();
  socket.name = `Sim Hair:${actor?.id ?? 'viewer'}:${styleId}`;
  socket.add(base);
  parent.add(socket);

  let currentColor = colorHex;
  let currentFit = sanitizeHairFit(hairFit ?? actor?.preset?.hairFit ?? DEFAULT_HAIR_FIT);
  applyHairFitToSocket(socket, currentFit);

  return {
    id: styleId,
    group: socket,
    base,
    headBone: headBone ?? null,
    parentedTo: headBone ? 'head' : 'root',
    meshes,
    get color() {
      return currentColor;
    },
    get fit() {
      return {
        scale: currentFit.scale,
        position: { ...currentFit.position },
        rotation: { ...currentFit.rotation },
      };
    },
    setColor(nextColor) {
      currentColor = sanitizeHairColor(nextColor ?? asset.defaultColor ?? DEFAULT_SIM_HAIR_COLOR);
      for (const mat of ownedMaterials) {
        mat.color.set(currentColor);
      }
    },
    /**
     * Live socket transform (scale / position m / rotation deg) in head space.
     * Safe to call every slider frame — no mesh reload.
     */
    applyFit(nextFit) {
      currentFit = sanitizeHairFit(nextFit ?? DEFAULT_HAIR_FIT);
      applyHairFitToSocket(socket, currentFit);
      return currentFit;
    },
    snapshot() {
      return {
        id: styleId,
        color: currentColor,
        parentedTo: headBone ? 'head' : 'root',
        headBone: headBone?.name ?? null,
        fit: {
          scale: currentFit.scale,
          position: { ...currentFit.position },
          rotation: { ...currentFit.rotation },
        },
        meshes: meshes.length,
        visible: socket.visible,
      };
    },
    dispose() {
      socket.removeFromParent();
      for (const mat of ownedMaterials) mat.dispose?.();
      disposeObject3D(socket);
    },
  };
}

export async function attachPresetHair({ actor, scene }) {
  if (!actor?.preset?.hairStyleId) return null;
  try {
    return await attachSimHair({
      actor,
      scene,
      hairStyleId: actor.preset.hairStyleId,
      hairColor: actor.preset.hairColor,
      hairFit: actor.preset.hairFit,
    });
  } catch (error) {
    console.warn(`[sims] failed to attach hair ${actor.preset.hairStyleId} to ${actor.id}`, error);
    return null;
  }
}

/**
 * Scale hair to character height and put mesh-top at local origin (head bone).
 * Cascade strands hang down −Y in head space after this.
 */
function normalizeHairToHeadSocket(base, bodyHeight) {
  base.updateMatrixWorld(true);
  _box.setFromObject(base);
  if (_box.isEmpty()) return;

  _box.getSize(_size);
  const height = Math.max(_size.y, 1e-6);
  const s = Math.max(0.05, bodyHeight) / height;
  base.scale.multiplyScalar(s);
  base.updateMatrixWorld(true);
  _box.setFromObject(base);
  _box.getCenter(_center);

  // Top of hair → bone origin; centered on XZ so offset 0,0,0 is a sensible scalp seat.
  base.position.x += -_center.x;
  base.position.y += -_box.max.y;
  base.position.z += -_center.z;
  base.updateMatrixWorld(true);
}

function applyHairFitToSocket(socket, fit) {
  const scale = Number.isFinite(fit?.scale) ? fit.scale : 1;
  const pos = fit?.position ?? DEFAULT_HAIR_FIT.position;
  const rot = fit?.rotation ?? DEFAULT_HAIR_FIT.rotation;
  socket.scale.setScalar(scale);
  socket.position.set(pos.x ?? 0, pos.y ?? 0, pos.z ?? 0);
  socket.rotation.set(
    _deg(rot.x ?? 0),
    _deg(rot.y ?? 0),
    _deg(rot.z ?? 0),
    'XYZ',
  );
  socket.updateMatrixWorld(true);
}

/**
 * Prefer Rigify head (DEF-spine.006 → runtime DEFspine006), then common aliases.
 */
export function resolveHeadBone(actor) {
  const bones = actor?.model?.bones ?? {};
  const candidates = [
    RIGIFY_HEAD_BONE,
    toRuntimeRigifyBoneName('DEF-spine.006'),
    'DEF-spine.006',
    'DEFspine006',
    'Head',
    'head',
    'mixamorigHead',
  ];
  for (const name of candidates) {
    if (bones[name]) return bones[name];
  }
  for (const mesh of actor?.model?.skinnedMeshes ?? []) {
    for (const bone of mesh.skeleton?.bones ?? []) {
      const n = bone.name || '';
      if (/^DEF-?spine\.?006$/i.test(n) || /^mixamorigHead$/i.test(n) || n === 'Head') {
        return bone;
      }
    }
  }
  // Last resort: any bone whose name is exactly head-like (not forehead).
  for (const bone of Object.values(bones)) {
    const n = String(bone?.name || '');
    if (/head/i.test(n) && !/forehead|headtop|overhead/i.test(n)) return bone;
  }
  return null;
}

function resolveActorHeight(actor) {
  const model = actor?.model;
  if (model && Number.isFinite(model.rawHeight) && Number.isFinite(model.scale)) {
    return model.rawHeight * model.scale;
  }
  return 1.75;
}

function sanitizeHairColor(raw) {
  return schemaSanitizeHairColor(raw);
}

async function loadHairTemplate(url) {
  if (!templatePromises.has(url)) {
    templatePromises.set(url, createGltfLoader().loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      flattenObjectForWebGPU(root);
      root.updateMatrixWorld(true);
      return root;
    }).catch((error) => {
      templatePromises.delete(url);
      throw error;
    }));
  }
  return templatePromises.get(url);
}

export function clearHairTemplateCache() {
  templatePromises.clear();
}
