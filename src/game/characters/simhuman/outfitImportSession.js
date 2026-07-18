/**
 * Client-side session for Outfit Import Studio: load unrigged cloth, snap/fit,
 * optional plane cuts, export GLB + pose for Blender weight bake.
 */

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { createGltfLoader } from '../../utils/createGltfLoader.js';
import { clipGeometryByPlane } from '../../geometry/clipGeometryByPlane.js';
import {
  OUTFIT_IMPORT_POSE_PRESETS,
} from './outfitImportPose.js';

const gltfLoader = createGltfLoader();
const fbxLoader = new FBXLoader();
const exporter = new GLTFExporter();

/** Default bake export budgets — keep the POST under the prepare endpoint cap. */
export const OUTFIT_BAKE_MAX_VERTS_DEFAULT = 70000;
export const OUTFIT_BAKE_MAX_TEXTURE_DEFAULT = 1024;
/** Soft cap on encoded cloth base64 (~binary × 4/3) before we re-export tighter. */
export const OUTFIT_BAKE_TARGET_CLOTH_BYTES = 28 * 1024 * 1024;

let simplifierReady = null;
async function ensureSimplifier() {
  if (!MeshoptSimplifier.supported) return false;
  if (!simplifierReady) simplifierReady = MeshoptSimplifier.ready.then(() => true).catch(() => false);
  return simplifierReady;
}

/**
 * Verify runtime-world cloth was actually expanded back into raw UBC bind space.
 * Garment height itself is deliberately unrestricted: tops, skirts, and shoes do
 * not span the body's full ~3.49-unit bind height.
 */
export function validateBindSpaceConversion({
  previewHeight,
  bindHeight,
  bodyWorldScaleY,
}) {
  if (!(previewHeight > 1e-6) || !(bindHeight > 1e-6)) {
    throw new Error('Cloth export produced invalid bounds.');
  }
  if (!(bodyWorldScaleY > 0.25 && bodyWorldScaleY < 0.75)) {
    throw new Error(
      `Body bind transform has scale ${Number(bodyWorldScaleY).toFixed(3)} `
      + '(expected the normalized UBC body scale around 0.5). Check that Male/Female is loaded.',
    );
  }

  const expectedScale = 1 / bodyWorldScaleY;
  const observedScale = bindHeight / previewHeight;
  const relativeError = Math.abs(observedScale - expectedScale) / expectedScale;
  if (relativeError > 0.08) {
    throw new Error(
      `Cloth bind conversion scaled height by ${observedScale.toFixed(2)}x `
      + `(expected ${expectedScale.toFixed(2)}x from the body). Re-snap before bake.`,
    );
  }
  return { expectedScale, observedScale, relativeError };
}

/**
 * @typedef {object} OutfitImportSessionState
 * @property {string|null} fileName
 * @property {number} vertCount
 * @property {string} gizmoMode
 * @property {string} editTarget  'cloth' | 'pose'
 * @property {Record<string, number>} macros
 * @property {string} presetId
 * @property {object} pose
 * @property {boolean} hasCloth
 * @property {{x:number,y:number,z:number}|null} clothScale
 * @property {{x:number,y:number,z:number}|null} clothPosition
 */

export class OutfitImportSession {
  constructor() {
    /** @type {THREE.Object3D|null} */
    this.clothRoot = null;
    /** @type {THREE.Object3D|null} */
    this._sourceRoot = null;
    this.fileName = null;
    this.gizmoMode = 'translate';
    this.editTarget = 'cloth';
    this.presetId = 'rest';
    /** @type {Record<string, number>} */
    this.macros = {};
    for (const s of ['armDown', 'armOut', 'elbow', 'spineBend', 'thighSpread', 'kneeBend']) {
      this.macros[s] = 0;
    }
    /** Last model-space bone deltas captured from the viewer after a successful pose apply. */
    this.lastAppliedPose = {};
    this.lastPoseStatus = '';
    /** Geometry undo for cuts */
    this._geoUndo = [];
    this._maxUndo = 8;
    this.heightEase = 1.0;
    this.widthEase = 1.1;
    this.outfitId = '';
    this.outfitName = '';
  }

  get hasCloth() {
    return Boolean(this.clothRoot);
  }

  /** Config for viewer.applyImportPoseConfig (world-space procedures). */
  getPoseConfig() {
    return {
      procedure: this.presetId || 'rest',
      macros: { ...this.macros },
    };
  }

  /**
   * Bake pose = last captured model-space bone deltas from the viewer.
   * @returns {object}
   */
  getPose() {
    return { ...(this.lastAppliedPose || {}) };
  }

  setPreset(presetId) {
    this.presetId = OUTFIT_IMPORT_POSE_PRESETS[presetId] != null ? presetId : 'rest';
    // Clear macros when picking a named preset so the procedure is pure.
    for (const k of Object.keys(this.macros)) this.macros[k] = 0;
    return this.getPoseConfig();
  }

  setMacro(id, value) {
    if (!(id in this.macros)) return this.getPoseConfig();
    this.macros[id] = Number(value) || 0;
    return this.getPoseConfig();
  }

  resetPose() {
    this.presetId = 'rest';
    for (const k of Object.keys(this.macros)) this.macros[k] = 0;
    this.lastAppliedPose = {};
    this.lastPoseStatus = '';
    return this.getPoseConfig();
  }

  /** Store viewer apply result for bake + status. */
  rememberAppliedPose(result) {
    this.lastAppliedPose = { ...(result?.pose || {}) };
    this.lastPoseStatus = result?.status || '';
    return this.lastAppliedPose;
  }

  /**
   * @param {File} file
   * @returns {Promise<THREE.Object3D>}
   */
  async loadClothFromFile(file) {
    if (!file) throw new Error('No file');
    const name = file.name || 'cloth';
    const lower = name.toLowerCase();
    const buffer = await file.arrayBuffer();
    let root;
    if (lower.endsWith('.fbx')) {
      root = fbxLoader.parse(buffer, '');
    } else if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
      const gltf = await gltfLoader.parseAsync(buffer, '');
      root = gltf.scene;
    } else if (lower.endsWith('.obj')) {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const text = new TextDecoder().decode(buffer);
      root = new OBJLoader().parse(text);
    } else {
      throw new Error(`Unsupported format: ${name} (use FBX, GLB, or OBJ)`);
    }

    this.disposeCloth();
    this.fileName = name;
    /** @type {ArrayBuffer|null} Original file bytes for Blender (keeps FBX textures). */
    this.sourceFileBuffer = buffer.slice(0);
    this.sourceFileExt = lower.endsWith('.fbx')
      ? '.fbx'
      : (lower.endsWith('.glb') ? '.glb' : (lower.endsWith('.gltf') ? '.gltf' : '.obj'));
    this._sourceRoot = root;
    this.clothRoot = this._prepareClothRoot(root);
    this.outfitId = this.outfitId || suggestOutfitId(name);
    this.outfitName = this.outfitName || suggestOutfitName(name);
    this._geoUndo = [];
    return this.clothRoot;
  }

  /**
   * @param {THREE.Object3D} root
   */
  _prepareClothRoot(root) {
    // Strip lights/cameras; keep meshes under a group we can transform.
    const group = new THREE.Group();
    group.name = 'outfit-import-cloth';
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse((o) => {
      if (o.isMesh && o.geometry) meshes.push(o);
    });
    if (!meshes.length) throw new Error('No mesh found in file');
    const previewMaterialCache = new Map();

    // Reparent mesh clones with baked world transform into group.
    for (const mesh of meshes) {
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      if (!geo.getAttribute('normal')) geo.computeVertexNormals();
      // Promote every source slot to MeshStandardMaterial. Geometry groups
      // retain their materialIndex, so collapsing an array to slot 0 would
      // map unrelated atlas/material regions onto the whole garment.
      const sourceMaterials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      const previewMaterials = sourceMaterials.map((srcMat) => {
        const cached = previewMaterialCache.get(srcMat);
        if (cached) return cached;
        const color = srcMat?.color?.clone?.() ?? new THREE.Color(0x2c2c2c);
        const std = new THREE.MeshStandardMaterial({
          color,
          map: srcMat?.map ?? null,
          normalMap: srcMat?.normalMap ?? null,
          roughnessMap: srcMat?.roughnessMap ?? null,
          metalnessMap: srcMat?.metalnessMap ?? null,
          roughness: srcMat?.roughness ?? 0.82,
          metalness: srcMat?.metalness ?? 0.05,
          transparent: Boolean(srcMat?.transparent),
          opacity: srcMat?.opacity ?? 1,
          alphaTest: srcMat?.alphaTest ?? 0,
          side: THREE.DoubleSide,
        });
        if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
        previewMaterialCache.set(srcMat, std);
        return std;
      });
      const m = new THREE.Mesh(
        geo,
        Array.isArray(mesh.material) ? previewMaterials : previewMaterials[0],
      );
      m.name = mesh.name || 'Cloth';
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    return group;
  }

  disposeCloth() {
    if (this.clothRoot) {
      this.clothRoot.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            // Don't dispose shared textures aggressively if cloned maps — OK for import session.
            m?.dispose?.();
          }
        }
      });
      this.clothRoot.removeFromParent();
    }
    this.clothRoot = null;
    this._sourceRoot = null;
    this.sourceFileBuffer = null;
    this.sourceFileExt = null;
    this._geoUndo = [];
  }

  dispose() {
    this.disposeCloth();
  }

  /**
   * Snap cloth to body world AABB: feet align, height match, expand-only width.
   * @param {THREE.Object3D} bodyObject - model.group or model.object
   */
  autoFitToBody(bodyObject, { heightEase = this.heightEase, widthEase = this.widthEase } = {}) {
    if (!this.clothRoot || !bodyObject) return null;
    this.heightEase = heightEase;
    this.widthEase = widthEase;

    bodyObject.updateMatrixWorld(true);
    this.clothRoot.updateMatrixWorld(true);

    const bodyBox = worldMeshBox(bodyObject, { preferDenseBody: true });
    const clothBox = worldMeshBox(this.clothRoot);
    if (!bodyBox || !clothBox) return null;

    const bodyH = bodyBox.max.y - bodyBox.min.y;
    const clothH = clothBox.max.y - clothBox.min.y;
    if (clothH < 1e-6) throw new Error('Cloth has zero height');

    // Reset transform then scale uniformly by height.
    this.clothRoot.position.set(0, 0, 0);
    this.clothRoot.rotation.set(0, 0, 0);
    this.clothRoot.scale.setScalar(1);
    this.clothRoot.updateMatrixWorld(true);

    // Recompute local bounds after reset (geometry already baked world at load).
    const localBox = new THREE.Box3().setFromObject(this.clothRoot);
    const localH = localBox.max.y - localBox.min.y;
    const sH = (bodyH / Math.max(localH, 1e-6)) * heightEase;
    this.clothRoot.scale.setScalar(sH);
    this.clothRoot.updateMatrixWorld(true);

    // Feet on body feet + center XZ.
    const fitted = new THREE.Box3().setFromObject(this.clothRoot);
    const bodyCx = 0.5 * (bodyBox.min.x + bodyBox.max.x);
    const bodyCz = 0.5 * (bodyBox.min.z + bodyBox.max.z);
    const clothCx = 0.5 * (fitted.min.x + fitted.max.x);
    const clothCz = 0.5 * (fitted.min.z + fitted.max.z);
    this.clothRoot.position.x += bodyCx - clothCx;
    this.clothRoot.position.y += bodyBox.min.y - fitted.min.y;
    this.clothRoot.position.z += bodyCz - clothCz;
    this.clothRoot.updateMatrixWorld(true);

    // Expand-only XY if cloth torso thinner than body.
    const bodyR = bandRadialP90(bodyObject, bodyBox, 0.55, 0.68, 0.55 * bodyH);
    const clothR = bandRadialP90(this.clothRoot, bodyBox, 0.55, 0.68, null);
    if (bodyR > 1e-4 && clothR > 1e-4) {
      const target = bodyR * Math.max(widthEase, 1);
      if (clothR < target) {
        const sW = Math.min(1.45, target / clothR);
        this.clothRoot.scale.x *= sW;
        this.clothRoot.scale.z *= sW;
        this.clothRoot.updateMatrixWorld(true);
        const refit = new THREE.Box3().setFromObject(this.clothRoot);
        const cCx = 0.5 * (refit.min.x + refit.max.x);
        const cCz = 0.5 * (refit.min.z + refit.max.z);
        this.clothRoot.position.x += bodyCx - cCx;
        this.clothRoot.position.y += bodyBox.min.y - refit.min.y;
        this.clothRoot.position.z += bodyCz - cCz;
      }
    }

    this.clothRoot.updateMatrixWorld(true);
    return {
      bodyH,
      scale: this.clothRoot.scale.x,
      box: new THREE.Box3().setFromObject(this.clothRoot),
    };
  }

  /**
   * Plane-cut cloth. plane is THREE.Plane in world space.
   * sideSign: keep positive half-space (1) or negative (-1).
   */
  applyPlaneCut(plane, sideSign = 1) {
    if (!this.clothRoot) return 0;
    this._pushGeoUndo();
    let cutCount = 0;
    this.clothRoot.updateMatrixWorld(true);
    this.clothRoot.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const localPlane = plane.clone();
      // clipGeometryByPlane expects plane in geometry/local space of the attributes.
      // Our geometry is in cloth-root local after bake-at-load; mesh may have identity.
      o.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(o.matrixWorld).invert();
      const nMat = new THREE.Matrix3().getNormalMatrix(inv);
      localPlane.applyMatrix4(inv, nMat);
      const clipped = clipGeometryByPlane(o.geometry, localPlane, sideSign, { includeCap: false });
      if (clipped) {
        o.geometry.dispose();
        o.geometry = clipped;
        cutCount += 1;
      }
    });
    return cutCount;
  }

  /**
   * Sleeve cut presets using bone world matrices.
   * @param {'sleeve.L'|'sleeve.R'|'forearm.L'|'forearm.R'} preset
   * @param {(name: string) => THREE.Bone|null} getBone
   */
  applyBoneCutPreset(preset, getBone) {
    const map = {
      'sleeve.L': { bone: 'DEF-upper_arm.L', keepToward: 'torso' },
      'sleeve.R': { bone: 'DEF-upper_arm.R', keepToward: 'torso' },
      'forearm.L': { bone: 'DEF-forearm.L', keepToward: 'torso', alt: 'DEF-forearm.L.001' },
      'forearm.R': { bone: 'DEF-forearm.R', keepToward: 'torso', alt: 'DEF-forearm.R.001' },
    };
    const cfg = map[preset];
    if (!cfg) throw new Error(`Unknown cut preset ${preset}`);
    let bone = getBone(cfg.bone) || (cfg.alt ? getBone(cfg.alt) : null);
    if (!bone) throw new Error(`Bone not found for cut: ${cfg.bone}`);
    bone.updateWorldMatrix(true, false);
    const origin = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
    // Plane normal along bone +X (arm out) projected; use bone's local Y or X.
    const xAxis = new THREE.Vector3().setFromMatrixColumn(bone.matrixWorld, 0).normalize();
    const yAxis = new THREE.Vector3().setFromMatrixColumn(bone.matrixWorld, 1).normalize();
    // Prefer axis more horizontal for sleeve chop (perpendicular to arm chain).
    // Use bone primary axis (Y in many DEF rigs is along bone).
    const along = yAxis.clone();
    // Cut plane faces along the arm away from torso: keep torso side.
    const torso = new THREE.Vector3(0, origin.y, 0);
    const toTorso = torso.sub(origin).normalize();
    // Normal should point toward hand (drop hand side) → keep sideSign for torso.
    let normal = along.clone();
    if (normal.dot(toTorso) > 0) normal.negate();
    // Place plane near mid-upper-arm.
    const planePoint = origin.clone().addScaledVector(along, 0.12);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePoint);
    // Keep half-space containing torso (origin 0, body center).
    const torsoPt = new THREE.Vector3(0, origin.y, 0);
    const sideSign = plane.distanceToPoint(torsoPt) >= 0 ? 1 : -1;
    return this.applyPlaneCut(plane, sideSign);
  }

  undoCut() {
    if (!this._geoUndo.length || !this.clothRoot) return false;
    const snapshot = this._geoUndo.pop();
    let i = 0;
    this.clothRoot.traverse((o) => {
      if (!o.isMesh) return;
      const geo = snapshot[i++];
      if (geo) {
        o.geometry?.dispose?.();
        o.geometry = geo;
      }
    });
    return true;
  }

  _pushGeoUndo() {
    if (!this.clothRoot) return;
    const snap = [];
    this.clothRoot.traverse((o) => {
      if (o.isMesh && o.geometry) snap.push(o.geometry.clone());
    });
    this._geoUndo.push(snap);
    while (this._geoUndo.length > this._maxUndo) {
      const old = this._geoUndo.shift();
      for (const g of old) g.dispose?.();
    }
  }

  vertCount() {
    let n = 0;
    this.clothRoot?.traverse((o) => {
      if (o.isMesh) n += o.geometry?.attributes?.position?.count ?? 0;
    });
    return n;
  }

  /**
   * Export cloth with transforms baked into geometry.
   *
   * CRITICAL: Viewer fits cloth in **runtime** space (body Object3D already
   * scaled ~1.75 m). Authored outfits + Blender prepare use **raw UBC bind**
   * space (~3.49 units). We convert cloth → body object local (bind) so
   * weight transfer and runtime `group.scale = body.scale` both line up.
   *
   * Textures from FBXLoader often fail to embed via GLTFExporter (blob/Image
   * paths). We rasterize maps to canvas before export; if that fails, use a
   * solid charcoal material so Blender never ships a corrupted noise map.
   *
   * @param {{
   *   bodyObject?: THREE.Object3D|null,
   *   maxVerts?: number,
   *   maxTexture?: number,
   * }} [opts]
   * @returns {Promise<ArrayBuffer>}
   */
  async exportClothGlb(opts = {}) {
    if (!this.clothRoot) throw new Error('No cloth loaded');
    this.clothRoot.updateMatrixWorld(true);

    const maxVerts = Number.isFinite(Number(opts.maxVerts)) && Number(opts.maxVerts) > 500
      ? Math.floor(Number(opts.maxVerts))
      : OUTFIT_BAKE_MAX_VERTS_DEFAULT;
    const maxTexture = Number.isFinite(Number(opts.maxTexture)) && Number(opts.maxTexture) >= 64
      ? Math.floor(Number(opts.maxTexture))
      : OUTFIT_BAKE_MAX_TEXTURE_DEFAULT;

    const previewBound = new THREE.Box3().setFromObject(this.clothRoot);
    const previewHeight = previewBound.max.y - previewBound.min.y;

    const bodyObject = opts.bodyObject ?? null;
    bodyObject?.updateMatrixWorld?.(true);

    // World → body local (raw bind). If no body, fall back to world (legacy).
    const invBodyWorld = new THREE.Matrix4();
    if (bodyObject) {
      invBodyWorld.copy(bodyObject.matrixWorld).invert();
    } else {
      invBodyWorld.identity();
    }
    const bakeMatrix = new THREE.Matrix4();

    const exportRoot = new THREE.Group();
    exportRoot.name = 'Athleisure';
    let sourceVertCount = 0;
    let texturesEmbedded = 0;
    let texturesFailed = 0;
    let vertsBeforeOpt = 0;
    let vertsAfterOpt = 0;
    const bound = new THREE.Box3();
    const tmp = new THREE.Vector3();
    /** @type {THREE.Texture[]} */
    const ownedTextures = [];
    const exportMaterialCache = new Map();
    /** @type {{ mesh: THREE.Mesh, sourceVerts: number }[]} */
    const staged = [];

    const canSimplify = await ensureSimplifier();

    for (const o of collectMeshes(this.clothRoot)) {
      let geo = o.geometry.clone();
      // cloth local → world → body bind local
      bakeMatrix.multiplyMatrices(invBodyWorld, o.matrixWorld);
      geo.applyMatrix4(bakeMatrix);
      // Slight outward ease so fabric sits outside body (reduces z-fight noise).
      inflateGeometryRadial(geo, 1.025);
      // Keep geometry UVs byte-for-byte. GLB/GLTFLoader maps already use
      // flipY=false and were previously corrupted by an unconditional V flip.
      // FBX flipY normalization happens per texture in rasterizeTexture().
      if (!geo.getAttribute('normal')) geo.computeVertexNormals();

      const rawPos = geo.getAttribute('position');
      const sourceVerts = rawPos?.count ?? 0;
      sourceVertCount += sourceVerts;
      vertsBeforeOpt += sourceVerts;

      // Weld triangle-soup (Meshy/FBX) before decimate so edge-collapse works.
      try {
        const welded = mergeVertices(geo, 1e-4);
        if (welded !== geo) {
          geo.dispose?.();
          geo = welded;
        }
      } catch {
        /* keep unwelded clone */
      }

      const sourceMaterials = Array.isArray(o.material) ? o.material : [o.material];
      const builtMaterials = [];
      for (const srcMat of sourceMaterials) {
        const cacheKey = `${srcMat?.uuid ?? 'mat'}:${maxTexture}`;
        let built = exportMaterialCache.get(cacheKey);
        if (!built) {
          built = await buildExportMaterial(srcMat, maxTexture);
          exportMaterialCache.set(cacheKey, built);
          texturesEmbedded += built.embedded;
          texturesFailed += built.failed;
          ownedTextures.push(...built.textures);
        }
        builtMaterials.push(built.material);
      }
      const material = Array.isArray(o.material) ? builtMaterials : builtMaterials[0];
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = o.name || 'Cloth';
      exportRoot.add(mesh);
      staged.push({ mesh, sourceVerts });
    }

    // Distribute the vertex budget across pieces (proportional to pre-weld size).
    const totalSource = Math.max(1, staged.reduce((s, e) => s + e.sourceVerts, 0));
    for (const entry of staged) {
      const share = Math.max(
        256,
        Math.floor(maxVerts * (entry.sourceVerts / totalSource)),
      );
      if (canSimplify) {
        const before = entry.mesh.geometry.getAttribute('position')?.count ?? 0;
        const next = simplifyGeometryToBudget(entry.mesh.geometry, share);
        if (next && next !== entry.mesh.geometry) {
          entry.mesh.geometry.dispose?.();
          entry.mesh.geometry = next;
        }
        const after = entry.mesh.geometry.getAttribute('position')?.count ?? before;
        vertsAfterOpt += after;
      } else {
        vertsAfterOpt += entry.mesh.geometry.getAttribute('position')?.count ?? 0;
      }
      const pos = entry.mesh.geometry.getAttribute('position');
      if (pos) {
        for (let i = 0; i < pos.count; i += 1) {
          tmp.fromBufferAttribute(pos, i);
          bound.expandByPoint(tmp);
        }
      }
    }

    if (bound.isEmpty()) throw new Error('Cloth export produced empty bounds');
    const height = bound.max.y - bound.min.y;
    let bindConversion = null;
    let bodyWorldScaleY = null;
    if (bodyObject) {
      const bodyWorldScale = new THREE.Vector3();
      bodyObject.matrixWorld.decompose(
        new THREE.Vector3(),
        new THREE.Quaternion(),
        bodyWorldScale,
      );
      bodyWorldScaleY = Math.abs(bodyWorldScale.y);
      bindConversion = validateBindSpaceConversion({
        previewHeight,
        bindHeight: height,
        bodyWorldScaleY,
      });
    }

    this._lastExportMeta = {
      vertCount: vertsAfterOpt,
      sourceVertCount,
      vertsBeforeOpt,
      vertsAfterOpt,
      maxVerts,
      maxTexture,
      simplified: canSimplify && vertsAfterOpt < vertsBeforeOpt,
      previewHeight,
      bindHeight: height,
      bindMinY: bound.min.y,
      bindMaxY: bound.max.y,
      bodyWorldScaleY,
      bindScale: bindConversion?.observedScale ?? 1,
      usedBodyBind: Boolean(bodyObject),
      texturesEmbedded,
      texturesFailed,
    };

    let glb;
    try {
      glb = await new Promise((resolve, reject) => {
        exporter.parse(
          exportRoot,
          (result) => resolve(result),
          (err) => reject(err),
          { binary: true, onlyVisible: true },
        );
      });
    } finally {
      exportRoot.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) m?.dispose?.();
        }
      });
      for (const t of ownedTextures) t.dispose?.();
    }

    this._lastExportMeta.bytes = glb?.byteLength ?? 0;
    return glb;
  }

  /**
   * @param {{
   *   bodyObject?: THREE.Object3D|null,
   *   maxVerts?: number,
   *   maxTexture?: number,
   *   includeSourceFile?: boolean,
   *   targetClothBytes?: number,
   * }} [opts]
   * @returns {Promise<{ clothGlbBase64: string, pose: object, meta: object, sourceFileBase64?: string, sourceFileExt?: string }>}
   */
  async exportBakePayload(opts = {}) {
    let maxVerts = Number(opts.maxVerts) > 0 ? Number(opts.maxVerts) : OUTFIT_BAKE_MAX_VERTS_DEFAULT;
    let maxTexture = Number(opts.maxTexture) > 0 ? Number(opts.maxTexture) : OUTFIT_BAKE_MAX_TEXTURE_DEFAULT;
    const targetBytes = Number(opts.targetClothBytes) > 0
      ? Number(opts.targetClothBytes)
      : OUTFIT_BAKE_TARGET_CLOTH_BYTES;
    const includeSourceRequested = opts.includeSourceFile !== false;

    let buffer = await this.exportClothGlb({
      bodyObject: opts.bodyObject,
      maxVerts,
      maxTexture,
    });

    // If still too big for a reliable POST, re-export tighter (texture first, then verts).
    const retries = [
      { maxVerts, maxTexture: Math.min(maxTexture, 768) },
      { maxVerts: Math.min(maxVerts, 45000), maxTexture: 512 },
      { maxVerts: Math.min(maxVerts, 30000), maxTexture: 512 },
    ];
    for (const next of retries) {
      if ((buffer?.byteLength ?? 0) <= targetBytes) break;
      if (next.maxVerts === maxVerts && next.maxTexture === maxTexture) continue;
      maxVerts = next.maxVerts;
      maxTexture = next.maxTexture;
      buffer = await this.exportClothGlb({
        bodyObject: opts.bodyObject,
        maxVerts,
        maxTexture,
      });
    }

    const clothGlbBase64 = arrayBufferToBase64(buffer);
    const pose = this.getPose();
    const payload = {
      clothGlbBase64,
      pose,
      meta: {
        fileName: this.fileName,
        vertCount: this.vertCount(),
        outfitId: this.outfitId,
        outfitName: this.outfitName,
        heightEase: this.heightEase,
        widthEase: this.widthEase,
        presetId: this.presetId,
        macros: { ...this.macros },
        poseStatus: this.lastPoseStatus,
        poseBoneCount: pose?.bones ? Object.keys(pose.bones).length : Object.keys(pose).length,
        export: this._lastExportMeta ?? null,
      },
    };
    // Prefer original FBX on the server so Blender can load real textures — but
    // only when the cloth payload already fits; source FBX is often the bulk.
    const clothBytes = buffer?.byteLength ?? 0;
    const sourceBytes = this.sourceFileBuffer?.byteLength ?? 0;
    const canFitSource = includeSourceRequested
      && this.sourceFileBuffer
      && this.sourceFileExt === '.fbx'
      && clothBytes + sourceBytes < targetBytes * 1.35;
    if (canFitSource) {
      payload.sourceFileBase64 = arrayBufferToBase64(this.sourceFileBuffer);
      payload.sourceFileExt = this.sourceFileExt;
      payload.meta.export = {
        ...(payload.meta.export ?? {}),
        sourceFileIncluded: true,
        sourceFileBytes: sourceBytes,
      };
    } else if (this.sourceFileBuffer && this.sourceFileExt === '.fbx') {
      payload.meta.export = {
        ...(payload.meta.export ?? {}),
        sourceFileIncluded: false,
        sourceFileSkippedBytes: sourceBytes,
        sourceFileSkipReason: includeSourceRequested
          ? 'payload budget'
          : 'disabled',
      };
    }
    return payload;
  }

  snapshot() {
    const p = this.clothRoot?.position;
    const s = this.clothRoot?.scale;
    return {
      fileName: this.fileName,
      vertCount: this.vertCount(),
      gizmoMode: this.gizmoMode,
      editTarget: this.editTarget,
      macros: { ...this.macros },
      presetId: this.presetId,
      pose: this.getPose(),
      poseStatus: this.lastPoseStatus,
      hasCloth: this.hasCloth,
      clothScale: s ? { x: s.x, y: s.y, z: s.z } : null,
      clothPosition: p ? { x: p.x, y: p.y, z: p.z } : null,
      outfitId: this.outfitId,
      outfitName: this.outfitName,
      undoCuts: this._geoUndo.length,
    };
  }
}

function suggestOutfitId(fileName) {
  const base = String(fileName || 'import')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'import-outfit';
}

function suggestOutfitName(fileName) {
  const base = String(fileName || 'Import').replace(/\.[^.]+$/, '');
  return base.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
}

function worldMeshBox(root, { preferDenseBody = false } = {}) {
  let best = null;
  let bestVerts = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (/ico|eye|brow|face/i.test(o.name || '')) return;
    const n = o.geometry.attributes?.position?.count ?? 0;
    if (preferDenseBody && n < 2000) return;
    const box = new THREE.Box3().setFromObject(o);
    if (preferDenseBody) {
      if (n >= bestVerts) {
        bestVerts = n;
        best = box;
      }
    } else if (!best) {
      best = box;
    } else {
      best.union(box);
    }
  });
  if (!best && !preferDenseBody) {
    best = new THREE.Box3().setFromObject(root);
  }
  if (!best || best.isEmpty()) return null;
  return best;
}

function bandRadialP90(root, bodyBox, loFrac, hiFrac, maxR) {
  const y0 = bodyBox.min.y;
  const h = bodyBox.max.y - bodyBox.min.y;
  const yLo = y0 + h * loFrac;
  const yHi = y0 + h * hiFrac;
  const cx = 0.5 * (bodyBox.min.x + bodyBox.max.x);
  const cz = 0.5 * (bodyBox.min.z + bodyBox.max.z);
  const rs = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (/ico|eye|brow|face/i.test(o.name || '')) return;
    const pos = o.geometry.attributes.position;
    if (!pos) return;
    o.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y < yLo || v.y > yHi) continue;
      const r = Math.hypot(v.x - cx, v.z - cz);
      if (maxR != null && r > maxR) continue;
      rs.push(r);
    }
  });
  if (rs.length < 16) return 0;
  rs.sort((a, b) => a - b);
  return rs[Math.floor(rs.length * 0.9)];
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** @param {THREE.Object3D} root */
function collectMeshes(root) {
  const out = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry) out.push(o);
  });
  return out;
}

/**
 * Uniform radial inflate in XZ about origin (bind-space body axis).
 * Keeps fabric slightly outside the body shell to reduce z-fighting speckles.
 */
function inflateGeometryRadial(geometry, scale = 1.02) {
  if (!geometry || !(scale > 1)) return;
  const pos = geometry.getAttribute('position');
  if (!pos) return;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i) * scale;
    const z = pos.getZ(i) * scale;
    pos.setX(i, x);
    pos.setZ(i, z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

/**
 * Welded + meshopt-simplified geometry for bake export size control.
 * Returns the input geometry when already under budget or simplify fails.
 * @param {THREE.BufferGeometry} geometry
 * @param {number} targetVerts
 * @returns {THREE.BufferGeometry}
 */
function simplifyGeometryToBudget(geometry, targetVerts) {
  const posAttr = geometry?.getAttribute?.('position');
  if (!posAttr || posAttr.count <= targetVerts || targetVerts < 64) return geometry;
  if (!MeshoptSimplifier.supported) return geometry;

  try {
    let working = geometry;
    let indexAttr = working.getIndex();
    if (!indexAttr) {
      const sequential = new Uint32Array(posAttr.count);
      for (let i = 0; i < sequential.length; i += 1) sequential[i] = i;
      working = working.clone();
      working.setIndex(new THREE.BufferAttribute(sequential, 1));
      indexAttr = working.getIndex();
    }

    const indexCount = indexAttr.count;
    if (indexCount < 6) return geometry;
    const indices = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i += 1) indices[i] = indexAttr.getX(i) >>> 0;

    const vertCount = posAttr.count;
    const positions = new Float32Array(vertCount * 3);
    for (let i = 0; i < vertCount; i += 1) {
      positions[i * 3] = posAttr.getX(i);
      positions[i * 3 + 1] = posAttr.getY(i);
      positions[i * 3 + 2] = posAttr.getZ(i);
    }

    const ratio = Math.min(1, Math.max(0.05, targetVerts / vertCount));
    const targetIndexCount = Math.max(3, Math.floor((indexCount * ratio) / 3) * 3);
    if (targetIndexCount >= indexCount) return geometry;

    const [simplified] = MeshoptSimplifier.simplify(
      indices,
      positions,
      3,
      targetIndexCount,
      0.02,
      ['LockBorder', 'Prune'],
    );
    if (!simplified?.length || simplified.length >= indexCount) return geometry;

    // compactMesh rewrites indices in place — mark used verts first (old index space).
    const usedOld = new Uint8Array(vertCount);
    for (let i = 0; i < simplified.length; i += 1) {
      const old = simplified[i];
      if (old < vertCount) usedOld[old] = 1;
    }
    const [destination, unique] = MeshoptSimplifier.compactMesh(simplified);
    if (!(unique > 0) || unique > vertCount) return geometry;

    const next = new THREE.BufferGeometry();
    for (const name of Object.keys(working.attributes)) {
      const attr = working.getAttribute(name);
      if (!attr) continue;
      const itemSize = attr.itemSize;
      const ArrayType = attr.array.constructor;
      const out = new ArrayType(unique * itemSize);
      const normalized = attr.normalized;
      for (let old = 0; old < vertCount; old += 1) {
        if (!usedOld[old]) continue;
        const neu = destination[old];
        if (neu === undefined || neu < 0 || neu >= unique) continue;
        for (let k = 0; k < itemSize; k += 1) {
          out[neu * itemSize + k] = attr.getComponent(old, k);
        }
      }
      next.setAttribute(name, new THREE.BufferAttribute(out, itemSize, normalized));
    }
    next.setIndex(new THREE.BufferAttribute(simplified, 1));
    next.computeVertexNormals();
    return next;
  } catch {
    return geometry;
  }
}

/**
 * Build a MeshStandardMaterial safe for GLTFExporter.
 * FBXLoader maps are often non-exportable (blob/HTMLImage not yet complete);
 * rasterize to canvas or fall back to solid charcoal.
 * @param {THREE.Material|null|undefined} srcMat
 * @param {number} [maxTexture]
 */
async function buildExportMaterial(srcMat, maxTexture = OUTFIT_BAKE_MAX_TEXTURE_DEFAULT) {
  const owned = [];
  let embedded = 0;
  let failed = 0;
  const color = srcMat?.color?.isColor
    ? srcMat.color.clone()
    : new THREE.Color(0x2a2a2a);

  let map = null;
  if (srcMat?.map) {
    try {
      map = await rasterizeTexture(srcMat.map, maxTexture);
      if (map) {
        owned.push(map);
        embedded += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
      map = null;
    }
  }

  const material = new THREE.MeshStandardMaterial({
    // Base-color textures multiply by the material factor in both Three and
    // glTF; forcing white changed tinted source materials after re-export.
    color,
    map,
    roughness: 0.85,
    metalness: 0.04,
    transparent: Boolean(srcMat?.transparent),
    opacity: srcMat?.opacity ?? 1,
    alphaTest: srcMat?.alphaTest ?? 0,
    side: THREE.DoubleSide,
  });
  return { material, embedded, failed, textures: owned };
}

/**
 * @param {THREE.Texture} texture
 * @param {number} [maxSize] longest edge cap for bake payload size
 * @returns {Promise<THREE.CanvasTexture|null>}
 */
async function rasterizeTexture(texture, maxSize = OUTFIT_BAKE_MAX_TEXTURE_DEFAULT) {
  if (typeof document === 'undefined') return null;
  const image = texture.image;
  if (!image) return null;

  // Wait a frame if image is still loading.
  if (typeof image.decode === 'function') {
    try {
      await image.decode();
    } catch {
      /* continue — may still be drawable */
    }
  }

  const srcW = image.naturalWidth || image.width || image.videoWidth || 0;
  const srcH = image.naturalHeight || image.height || image.videoHeight || 0;
  if (srcW < 2 || srcH < 2) return null;

  const cap = Math.max(64, Math.min(4096, Number(maxSize) || OUTFIT_BAKE_MAX_TEXTURE_DEFAULT));
  const scale = Math.min(1, cap / Math.max(srcW, srcH));
  const w = Math.max(2, Math.round(srcW * scale));
  const h = Math.max(2, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    // Preserve the source texture's effective GPU orientation while emitting
    // a glTF-safe CanvasTexture with flipY=false. FBXLoader commonly sets
    // flipY=true; GLTFLoader correctly sets false and must remain untouched.
    if (texture.flipY) {
      ctx.translate(0, h);
      ctx.scale(1, -1);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, srcW, srcH, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } catch {
    return null;
  }

  // Reject near-empty / garbage rasters (all black or salt-and-pepper noise
  // from failed FBX embeds often has extreme stdev with tiny mean structure).
  try {
    const sample = ctx.getImageData(0, 0, Math.min(64, w), Math.min(64, h)).data;
    let sum = 0;
    let sum2 = 0;
    const n = sample.length / 4;
    for (let i = 0; i < sample.length; i += 4) {
      const g = (sample[i] + sample[i + 1] + sample[i + 2]) / 3;
      sum += g;
      sum2 += g * g;
    }
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    const stdev = Math.sqrt(Math.max(0, variance));
    // Empty texture or pure noise: prefer solid color over shipping garbage.
    if (mean < 2 && stdev < 2) return null;
    if (stdev > 90 && mean < 50) {
      // High-noise dark map is almost always a failed embed — skip it.
      return null;
    }
  } catch {
    /* if sampling fails, still try exporting the canvas */
  }

  const out = new THREE.CanvasTexture(canvas);
  out.colorSpace = THREE.SRGBColorSpace;
  out.flipY = false;
  out.wrapS = texture.wrapS ?? THREE.RepeatWrapping;
  out.wrapT = texture.wrapT ?? THREE.RepeatWrapping;
  out.offset.copy(texture.offset);
  out.repeat.copy(texture.repeat);
  out.center.copy(texture.center);
  out.rotation = texture.rotation;
  out.matrixAutoUpdate = texture.matrixAutoUpdate;
  out.matrix.copy(texture.matrix);
  out.needsUpdate = true;
  return out;
}
