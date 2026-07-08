/**
 * MapBuilder.js
 *
 * Self-contained editor for chunk-based heightfield terrain.
 * - Owns its Three scene + WebGPURenderer (WebGPU).
 * - Uses ChunkManager (pure) for all data + deformation logic.
 * - Editor camera (orbit/pan/zoom) + pointer-driven sculpting.
 * - History, seam maintenance, exports, persistence hooks.
 *
 * Designed to be instantiated by MapBuilderCanvas.jsx (Solid wrapper).
 * All heavy logic is here in solid .js; the JSX layer is thin glue.
 */

import * as THREE from 'three';
import { WebGPURenderer, SRGBColorSpace, PCFShadowMap } from 'three/webgpu';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { getMapBuilderAutosave, setMapBuilderAutosave } from '../store/fileStore.js';
import { FrameLoop } from '../game/core/FrameLoop.js';
import { disposeObject3D } from '../game/utils/disposeObject3D.js';
import { ChunkManager } from '../world/terrain/ChunkManager.js';
import { createTerrainChunkMesh, cloneHeights } from '../world/terrain/TerrainChunk.js';
import {
  TILE_PALETTE_CATALOG,
  createAtlasMaterial,
  formatTileCatalogForPrompt,
  getTileDescriptor,
  normalizeTileIndex,
} from './textureAtlas.js';
import { createPrimitiveGeometry as makePrimitiveGeometry } from './primitiveGeometry.js';
import { saveBlueprint, getBlueprint, deleteBlueprint, listBlueprints } from './blueprintLibrary.js';
import { saveMapProject, getMapProject, deleteMapProject, listMapProjects } from './mapProjectLibrary.js';
import {
  createEditorTerrainMaterial,
  terrainTextureUrl,
  DEFAULT_TERRAIN_TILING,
  DEFAULT_TERRAIN_BLEND,
} from './editorTerrainMaterial.js';
import {
  buildRoadProfile,
  applyRoadCorridorHeight,
  clampBridgedRoadFloor,
  sampleCenterline,
} from '../world/worldMap/roadProfile.js';
import { buildRiverProfile, applyRiverCorridorHeight } from '../world/worldMap/riverProfile.js';
import { createRoadworks } from '../game/world/createRoadworks.js';
import { createTracksideLayers } from '../game/world/createTracksideLayers.js';
import { createRiverworks } from '../game/world/createRiverworks.js';
import { normalizeRoad, normalizeRiver, makeId, roadElevationMode } from '../world/worldMap/worldMapSchema.js';

const GLTFExporterPromise = import('three/examples/jsm/exporters/GLTFExporter.js').then(m => m.GLTFExporter);

// Vertical clearance under bridged road decks — must match createStreamingTerrainLevel
// so the editor overlay previews the same carve the world will bake.
const BRIDGE_CLEARANCE = 0.8;

// Editor roads conform to the sculpted terrain faithfully: a tiny smoothing
// window (just enough to kill chunk-grid jitter) and NO grade clamp, so a road
// follows a steep hill / spiral exactly instead of being graded down below the
// spline. The world pipeline passes the SAME values so a placed blueprint road
// matches its editor preview (see createStreamingTerrainLevel).
const ROAD_PROFILE_OPTS = { sampleSpacing: 1, smoothRadius: 4, maxGrade: Infinity };
const RIVER_PROFILE_OPTS = { smoothRadius: 2 };
// How close a click must land to a road/river centerline to pick it (world m).
const PICK_TOLERANCE = 3;

export class MapBuilder {
  constructor({ canvas, onChange = null } = {}) {
    this.canvas = canvas;
    this.onChange = onChange ?? (() => {});

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.chunksGroup = null;
    this.grid = null;
    this.frameLoop = new FrameLoop((t) => this.tick(t));

    this.manager = new ChunkManager({
      chunkSize: 32,
      resolution: 33,
      seed: 1729,
      amplitude: 2.8,
      octaves: 5,
    });

    // Live mesh handles: key -> { data, mesh, updateHeights }
    this.chunkMeshes = new Map();

    // Shared terrain material (one instance for every chunk) with an optional
    // global texture (from the built-in PBR library) blended over the base.
    // `terrainTexture.id` is a small library key, so it serialises cheaply into
    // the project / autosave / blueprints.
    this.terrainMaterial = createEditorTerrainMaterial();
    this.terrainTexture = {
      id: null,
      blend: DEFAULT_TERRAIN_BLEND,
      tiling: DEFAULT_TERRAIN_TILING,
    };
    this._terrainTextureLoader = new THREE.TextureLoader();
    this.objectMeshes = [];
    this.selectedObject = null;
    this.activeTileIndex = 0;
    // Saved-map identity ({ id, name }) of the last map saved/loaded from the
    // library, so re-saving overwrites instead of forking. null = unsaved.
    this.currentMapMeta = null;
    this.objectTransformMode = 'select'; // 'select' | 'move' | 'rotate' | 'scale'
    this.transformControls = null;
    this.transformControlsHelper = null;
    this.isTransformDragging = false;

    // Editor camera state
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camYaw = 0.7;
    this.camPitch = 0.6;
    this.camDistance = 68;
    this.camMinDist = 8;
    this.camMaxDist = 320;

    // Pointer / interaction state
    this.pointer = { x: 0, y: 0, inside: false };
    this.isPointerDown = false;
    this.dragMode = null; // 'orbit' | 'pan' | 'sculpt'
    this.lastPointer = { x: 0, y: 0 };

    // Brush
    this.brush = {
      mode: 'raise',
      radius: 7.5,
      strength: 1.4,
      falloff: 'smooth',
    };

    // Tool / edit scope
    this.tool = 'sculpt'; // 'sculpt' | 'object' | 'view' | 'road' | 'river'
    this.selectedChunkKeys = new Set(); // for optional "confine to selection"
    this.confineToSelection = false;

    // Roads / rivers (authored in this project's LOCAL frame; stored as plain
    // polylines — XY only, Z re-derived from terrain). At world-build time
    // createBlueprintEntities transforms them to world frame and they flow through
    // the standard road/river carve + ribbon pipeline. In the editor the carve is
    // shown as a NON-DESTRUCTIVE overlay on the chunk meshes (base heights in the
    // ChunkManager stay clean for sculpt/undo/export).
    this.roads = [];            // [{ id, points:[{x,z}], width, type:'road' }]
    this.rivers = [];           // [{ id, points:[{x,z}], width, depth, type:'river' }]
    this.roadDraft = null;      // { points:[{x,z}] } while drawing, else null
    this.riverDraft = null;
    this.selectedRoadId = null;
    this.selectedRiverId = null;
    this.roadWidth = 8;
    this.roadElevation = null;
    this.roadElevationMode = 'terrain';
    this.riverWidth = 10;
    this.riverDepth = 6;
    this.roadCorridor = null;   // corridorAt(x,z) from buildRoadProfile (null = no carve)
    this.riverCorridor = null;
    this.roadworksPreview = null;  // { group, dispose } from createRoadworks
    this.tracksidePreview = null;  // { group, dispose } from createTracksideLayers
    this.riverworksPreview = null; // { group, getWaterHeightAt, dispose }
    this.roadsGroup = null;
    this.riversGroup = null;
    this.roadDraftLine = null;  // THREE.Line preview of the in-progress spline
    this.riverDraftLine = null;
    this.selectionLine = null;  // bright centerline of the selected road/river
    this.roadDrag = null;       // { anchor:{x,z}, snapshot:[{x,z}] } while moving
    this.riverDrag = null;
    this._sculptedSinceRebuild = false;

    // History (array of snapshots: Map<key, Float32Array>)
    this.history = [];
    this.historyIndex = -1;
    this.maxHistory = 24;

    // Rendering / dirty tracking
    this.needsRender = true;
    this.lastResizeW = 0;
    this.lastResizeH = 0;

    // Raycaster reused
    this.raycaster = new THREE.Raycaster();
    this.mouseNDC = new THREE.Vector2();

    // Bound handlers (for cleanup)
    this._onPointerDown = this.onPointerDown.bind(this);
    this._onPointerMove = this.onPointerMove.bind(this);
    this._onPointerUp = this.onPointerUp.bind(this);
    this._onWheel = this.onWheel.bind(this);
    this._onContextMenu = this.onContextMenu.bind(this);
    this._onResize = this.resizeIfNeeded.bind(this);
    this._onTransformDraggingChanged = this.onTransformDraggingChanged.bind(this);
    this._onTransformObjectChange = this.onTransformObjectChange.bind(this);
    this._onKeyDown = this.onKeyDown.bind(this);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async start() {
    if (this.renderer) return;

    // Renderer (match the spirit of RendererSystem)
    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.outputColorSpace = SRGBColorSpace;

    await this.renderer.init();

    this.resizeIfNeeded();

    // Scene
    this.scene = new THREE.Scene();
    this.scene.name = 'MapBuilder Scene';
    this.scene.background = new THREE.Color(0xdfeeea);
    this.scene.fog = new THREE.Fog(0xdfeeea, 80, 380);

    // Lights — editor friendly (a bit brighter, clearer shadows)
    const hemi = new THREE.HemisphereLight(0xf0f7f2, 0x6f6655, 1.8);
    hemi.name = 'Builder Hemi';
    const sun = new THREE.DirectionalLight(0xfff5d9, 2.6);
    sun.name = 'Builder Sun';
    sun.position.set(28, 55, -18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 220;
    sun.shadow.camera.left = -95;
    sun.shadow.camera.right = 95;
    sun.shadow.camera.top = 95;
    sun.shadow.camera.bottom = -95;
    sun.shadow.bias = -0.0006;
    this.scene.add(hemi, sun);

    // Chunks container
    this.chunksGroup = new THREE.Group();
    this.chunksGroup.name = 'TerrainChunks';
    this.scene.add(this.chunksGroup);

    this.objectsGroup = new THREE.Group();
    this.objectsGroup.name = 'MapObjects';
    this.scene.add(this.objectsGroup);

    this.roadsGroup = new THREE.Group();
    this.roadsGroup.name = 'Roads';
    this.scene.add(this.roadsGroup);

    this.riversGroup = new THREE.Group();
    this.riversGroup.name = 'Rivers';
    this.scene.add(this.riversGroup);

    this.overlayGroup = new THREE.Group();
    this.overlayGroup.name = 'RoadRiverOverlay';
    this.scene.add(this.overlayGroup);

    this.selectionHelper = new THREE.BoxHelper(new THREE.Object3D(), 0xd0a15c);
    this.selectionHelper.name = 'ObjectSelection';
    this.selectionHelper.visible = false;
    this.scene.add(this.selectionHelper);

    // Subtle grid for scale reference
    this.grid = new THREE.GridHelper(256, 32, 0x8a8172, 0x9aa38f);
    this.grid.name = 'Reference Grid';
    this.grid.material.opacity = 0.18;
    this.grid.material.transparent = true;
    this.grid.position.y = 0.01;
    this.scene.add(this.grid);

    // Chunk boundary visualization (edges)
    this.chunkEdgesGroup = new THREE.Group();
    this.chunkEdgesGroup.name = 'ChunkEdges';
    this.scene.add(this.chunkEdgesGroup);

    // Live brush preview ring (follows cursor on terrain)
    this.brushPreview = this.createBrushPreview();
    this.scene.add(this.brushPreview);

    // Camera
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 1200);
    this.updateCamera();

    this.transformControls = new TransformControls(this.camera, this.canvas);
    this.transformControls.viewport = new THREE.Vector4(0, 0, 1, 1);
    this.transformControls.setMode('translate');
    this.transformControls.setSize(0.86);
    this.transformControls.enabled = false;
    this.transformControls.visible = false;
    this.transformControls.addEventListener('dragging-changed', this._onTransformDraggingChanged);
    this.transformControls.addEventListener('objectChange', this._onTransformObjectChange);
    this.transformControlsHelper = this.transformControls.getHelper();
    this.transformControlsHelper.name = 'ObjectTransformGizmo';
    this.transformControlsHelper.visible = false;
    this.scene.add(this.transformControlsHelper);

    // Restore last autosave first. If no saved project exists, create starter
    // terrain/objects as the editable baseline.
    let restoredProject = false;
    try {
      const json = getMapBuilderAutosave();
      if (json && ((json.chunks && json.chunks.length > 0) || (json.objects && json.objects.length > 0))) {
        this.loadProjectFromJSON(json);
        restoredProject = true;
      }
    } catch (_) {}

    if (!restoredProject) {
      this.seedInitialChunks();
      this.seedInitialObjects();
    }

    // Push initial state so UI controls reflect the real brush / stats immediately
    this.emitChange();

    // Attach input
    const c = this.canvas;
    c.tabIndex = 0;
    c.addEventListener('pointerdown', this._onPointerDown);
    globalThis.addEventListener('pointermove', this._onPointerMove);
    globalThis.addEventListener('pointerup', this._onPointerUp);
    c.addEventListener('wheel', this._onWheel, { passive: false });
    c.addEventListener('contextmenu', this._onContextMenu);
    c.addEventListener('dblclick', this.onDoubleClick.bind(this));
    globalThis.addEventListener('keydown', this._onKeyDown);
    globalThis.addEventListener('resize', this._onResize);

    this.frameLoop.start();
    this.emitChange();
  }

  dispose() {
    this.flushAutosave();
    this.frameLoop.stop();

    const c = this.canvas;
    c.removeEventListener('pointerdown', this._onPointerDown);
    globalThis.removeEventListener('pointermove', this._onPointerMove);
    globalThis.removeEventListener('pointerup', this._onPointerUp);
    c.removeEventListener('wheel', this._onWheel);
    c.removeEventListener('contextmenu', this._onContextMenu);
    globalThis.removeEventListener('keydown', this._onKeyDown);
    globalThis.removeEventListener('resize', this._onResize);

    if (this.transformControls) {
      this.transformControls.removeEventListener('dragging-changed', this._onTransformDraggingChanged);
      this.transformControls.removeEventListener('objectChange', this._onTransformObjectChange);
      this.transformControls.detach();
      this.transformControls.dispose?.();
    }
    if (this.transformControlsHelper) {
      this.scene?.remove(this.transformControlsHelper);
      disposeObject3D(this.transformControlsHelper);
    }

    // Dispose Three resources
    for (const handle of this.chunkMeshes.values()) {
      if (handle.edgeViz) {
        this.chunkEdgesGroup?.remove(handle.edgeViz);
        disposeObject3D(handle.edgeViz);
      }
      this.disposeChunkMesh(handle.mesh);
    }
    this.chunkMeshes.clear();
    this.terrainMaterial.dispose();
    if (this.chunkEdgesGroup) disposeObject3D(this.chunkEdgesGroup);

    this.selectObject(null);
    for (const mesh of this.objectMeshes) {
      disposeObject3D(mesh);
    }
    this.objectMeshes = [];
    if (this.selectionHelper) disposeObject3D(this.selectionHelper);
    if (this.objectsGroup) disposeObject3D(this.objectsGroup);

    if (this.grid) disposeObject3D(this.grid);
    if (this.chunksGroup) disposeObject3D(this.chunksGroup);

    // Road/river previews + draft/selection overlay lines.
    this.roadworksPreview?.dispose?.();
    this.tracksidePreview?.dispose?.();
    this.riverworksPreview?.dispose?.();
    if (this.roadsGroup) disposeObject3D(this.roadsGroup);
    if (this.riversGroup) disposeObject3D(this.riversGroup);
    if (this.overlayGroup) disposeObject3D(this.overlayGroup);

    if (this.scene) disposeObject3D(this.scene);

    this.renderer?.setAnimationLoop(null);
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
  }

  // ------------------------------------------------------------------
  // Initial content
  // ------------------------------------------------------------------

  seedInitialChunks() {
    const r = 1; // -1..+1
    for (let cx = -r; cx <= r; cx += 1) {
      for (let cz = -r; cz <= r; cz += 1) {
        this.loadOrCreateChunkMesh(cx, cz);
      }
    }
    this.camTarget.set(0, 6, 0);
    this.updateCamera();
    this.needsRender = true;
  }

  seedInitialObjects() {
    if (this.objectMeshes.length > 0) return;
    this.addPrimitive({
      type: 'box',
      name: 'moss_stone_platform',
      position: [0, 2.2, -7],
      scale: [10, 1.2, 4],
      tile: 'moss_stone',
      textureRepeat: [3, 1],
    });
    this.addPrimitive({
      type: 'box',
      name: 'ancient_plank_bridge',
      position: [9, 3.2, -7],
      scale: [7, 0.35, 2.4],
      tile: 'ancient_planks',
      textureRepeat: [4, 1],
    });
    this.addPrimitive({
      type: 'box',
      name: 'blue_rune_marker',
      position: [-5, 3.3, -7],
      scale: [0.35, 2, 2],
      tile: 'blue_rune',
      textureRepeat: [1, 1],
    });
    this.selectObject(this.objectMeshes[0] ?? null);
  }

  // Dispose a terrain chunk mesh WITHOUT freeing the shared terrain material.
  // Every chunk references the one editor terrain material, so letting the
  // generic disposeObject3D() call material.dispose() would break all the other
  // live chunks. We drop the reference first; the material is freed once in
  // destroy().
  disposeChunkMesh(mesh) {
    if (!mesh) return;
    mesh.material = null;
    disposeObject3D(mesh);
  }

  // ------------------------------------------------------------------
  // Global terrain texture (one custom image blended over the whole terrain)
  // ------------------------------------------------------------------

  // (Re)apply blend + tiling to the shared material and (re)load the texture
  // from the built-in library id. Safe to call repeatedly; loading is async.
  _applyTerrainTextureState() {
    const t = this.terrainTexture;
    this.terrainMaterial.setBlend(t.blend);
    this.terrainMaterial.setTiling(t.tiling);
    const url = terrainTextureUrl(t.id);
    if (!url) {
      this.terrainMaterial.setTexture(null);
      this.needsRender = true;
      return;
    }
    this._terrainTextureLoader.load(url, (tex) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      // Ignore a stale load if the selection changed meanwhile.
      if (this.terrainTexture.id !== t.id) { tex.dispose(); return; }
      this.terrainMaterial.setTexture(tex);
      this.needsRender = true;
    });
  }

  // Set the global terrain texture by built-in library id (null clears it).
  setTerrainTexture(id) {
    this.terrainTexture.id = id || null;
    this._applyTerrainTextureState();
    this.emitChange();
  }

  clearTerrainTexture() {
    this.terrainTexture.id = null;
    this.terrainMaterial.setTexture(null);
    this.needsRender = true;
    this.emitChange();
  }

  setTerrainTextureBlend(value) {
    this.terrainTexture.blend = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
    this.terrainMaterial.setBlend(this.terrainTexture.blend);
    this.needsRender = true;
    this.emitChange();
  }

  setTerrainTextureTiling(value) {
    this.terrainTexture.tiling = Math.max(0.001, Number(value) || DEFAULT_TERRAIN_TILING);
    this.terrainMaterial.setTiling(this.terrainTexture.tiling);
    this.needsRender = true;
    this.emitChange();
  }

  // A plain (non-node) standard material that approximates the live terrain look
  // for GLB export. Bakes the base tint and, when set, the custom texture as the
  // albedo map (world tiling re-expressed as per-chunk UV repeat).
  exportTerrainMaterial() {
    const base = new THREE.Color(0x9aa38f);
    const tex = this.terrainTexture.id ? this.terrainMaterial.getTexture() : null;
    const mat = new THREE.MeshStandardMaterial({
      color: base,
      roughness: 0.92,
      metalness: 0.02,
    });
    if (tex) {
      const map = tex.clone();
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.colorSpace = THREE.SRGBColorSpace;
      const repeat = this.terrainTexture.tiling * this.manager.chunkSize;
      map.repeat.set(repeat, repeat);
      map.needsUpdate = true;
      mat.map = map;
      // Lerp the base tint toward white by the blend so a low blend keeps the
      // ground tone and a high blend shows the texture closer to full strength.
      mat.color.lerp(new THREE.Color(0xffffff), this.terrainTexture.blend);
    }
    return mat;
  }

  loadOrCreateChunkMesh(cx, cz) {
    const key = `${cx},${cz}`;
    if (this.chunkMeshes.has(key)) return this.chunkMeshes.get(key);

    const data = this.manager.getOrCreateChunk(cx, cz);
    const handle = createTerrainChunkMesh(data, {
      material: this.terrainMaterial.material,
      castShadow: true,
      receiveShadow: true,
    });

    this.chunksGroup.add(handle.mesh);
    this.chunkMeshes.set(key, handle);

    // Add clean edge lines for the chunk (very useful when sculpting seams)
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x3a3f36,
      transparent: true,
      opacity: 0.55,
    });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(handle.geometry), edgeMat);
    edges.name = `edges_${cx}_${cz}`;
    // The geometry is already in local space; position the edges group at the chunk root offset
    edges.position.set(0, 0.015, 0); // tiny lift so it sits on top of the terrain
    // Parent under the chunk's world position by using the same transform as the visual mesh
    const edgeRoot = new THREE.Group();
    edgeRoot.position.set(data.cx * data.size, 0, data.cz * data.size);
    edgeRoot.add(edges);
    this.chunkEdgesGroup.add(edgeRoot);

    // Store for cleanup
    handle.edgeViz = edgeRoot;

    // Apply any active road/river carve overlay onto the freshly-built mesh.
    this.applyOverlayToHandle(handle, data);

    this.needsRender = true;
    return handle;
  }

  unloadFarChunks(thresholdChunks = 5) {
    // Very simple distance-based unload for procedural-only chunks (memory hygiene)
    const cxCenter = Math.round(this.camTarget.x / this.manager.chunkSize);
    const czCenter = Math.round(this.camTarget.z / this.manager.chunkSize);

    for (const [key, handle] of this.chunkMeshes) {
      const [cx, cz] = key.split(',').map(Number);
      const dist = Math.max(Math.abs(cx - cxCenter), Math.abs(cz - czCenter));
      if (dist > thresholdChunks) {
        const chunkData = handle.chunkData;
        if (!this.manager.hasAuthored(cx, cz)) {
          // Safe to drop visual + live entry
          this.chunksGroup.remove(handle.mesh);
          if (handle.edgeViz) {
            this.chunkEdgesGroup.remove(handle.edgeViz);
            disposeObject3D(handle.edgeViz);
          }
          this.disposeChunkMesh(handle.mesh);
          this.chunkMeshes.delete(key);
          this.manager.unloadChunk(cx, cz);
          this.needsRender = true;
        }
      }
    }
  }

  createBrushPreview() {
    const ringGeo = new THREE.RingGeometry(1, 1.04, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xd0a15c,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.name = 'BrushPreview';
    ring.renderOrder = 999;
    ring.visible = false;
    return ring;
  }

  updateBrushPreview() {
    if (!this.brushPreview) return;
    const inSculpt = this.tool === 'sculpt' && this.pointer.inside;
    if (!inSculpt) {
      this.brushPreview.visible = false;
      return;
    }
    const pt = this.getWorldPointUnderPointer(this.pointer.x, this.pointer.y);
    if (pt) {
      this.brushPreview.position.copy(pt);
      this.brushPreview.position.y += 0.03; // sit just above
      const r = this.brush.radius;
      this.brushPreview.scale.set(r, r, r);
      this.brushPreview.visible = true;
    } else {
      this.brushPreview.visible = false;
    }
    this.needsRender = true;
  }

  // ------------------------------------------------------------------
  // Camera
  // ------------------------------------------------------------------

  updateCamera() {
    if (!this.camera) return;

    const dist = Math.max(this.camMinDist, Math.min(this.camDistance, this.camMaxDist));
    const y = Math.sin(this.camPitch) * dist;
    const horiz = Math.cos(this.camPitch) * dist;

    const x = this.camTarget.x + Math.sin(this.camYaw) * horiz;
    const z = this.camTarget.z + Math.cos(this.camYaw) * horiz;

    this.camera.position.set(x, this.camTarget.y + y + 4, z);
    this.camera.lookAt(this.camTarget.x, this.camTarget.y + 1.5, this.camTarget.z);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  orbit(dx, dy) {
    this.camYaw += dx * 0.0042;
    this.camPitch = Math.max(-1.35, Math.min(1.35, this.camPitch + dy * 0.0042));
    this.updateCamera();
  }

  pan(dx, dy) {
    const dist = this.camDistance;
    const factor = dist * 0.00085;
    const right = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    const forward = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));

    this.camTarget.x += right.x * dx * factor - forward.x * dy * factor;
    this.camTarget.z += right.z * dx * factor - forward.z * dy * factor;
    this.updateCamera();
  }

  dolly(delta) {
    this.camDistance = Math.max(this.camMinDist, Math.min(this.camMaxDist, this.camDistance + delta * (this.camDistance * 0.018 + 0.6)));
    this.updateCamera();
  }

  focusAtWorldPoint(point) {
    if (!point) return;
    this.camTarget.set(point.x, point.y, point.z);
    this.updateCamera();
  }

  frameAll() {
    // Rough center on the authored/live bounding area
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let any = false;

    for (const data of this.manager.getLoadedChunks()) {
      const half = data.size * 0.5;
      const wx = data.cx * data.size;
      const wz = data.cz * data.size;
      minX = Math.min(minX, wx - half);
      maxX = Math.max(maxX, wx + half);
      minZ = Math.min(minZ, wz - half);
      maxZ = Math.max(maxZ, wz + half);
      any = true;
    }

    if (!any) {
      this.camTarget.set(0, 0, 0);
      this.camDistance = 68;
    } else {
      this.camTarget.set((minX + maxX) * 0.5, 3, (minZ + maxZ) * 0.5);
      const diag = Math.hypot(maxX - minX, maxZ - minZ);
      this.camDistance = Math.max(28, Math.min(260, diag * 0.72));
    }
    this.updateCamera();
  }

  // ------------------------------------------------------------------
  // Brush + editing
  // ------------------------------------------------------------------

  setBrush(params) {
    this.brush = { ...this.brush, ...params };
    this.emitChange();
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'sculpt' && this.brushPreview) this.brushPreview.visible = false;
    // Leaving the road/river tools cancels any in-progress draft + selection.
    if (tool !== 'road') this.cancelRoadDraft();
    if (tool !== 'river') this.cancelRiverDraft();
    if (tool !== 'road' && tool !== 'river') this.selectRoadRiver(null);
    this.updateTransformControls();
    this.emitChange();
  }

  setObjectTransformMode(mode) {
    const normalized = {
      select: 'select',
      move: 'move',
      translate: 'move',
      rotate: 'rotate',
      scale: 'scale',
    }[mode] || 'select';
    this.objectTransformMode = normalized;
    this.updateTransformControls();
    this.emitChange();
  }

  setConfineToSelection(confine) {
    this.confineToSelection = !!confine;
    this.emitChange();
  }

  toggleChunkSelection(cx, cz) {
    const key = `${cx},${cz}`;
    if (this.selectedChunkKeys.has(key)) {
      this.selectedChunkKeys.delete(key);
    } else {
      this.selectedChunkKeys.add(key);
    }
    this.emitChange();
  }

  clearSelection() {
    this.selectedChunkKeys.clear();
    this.emitChange();
  }

  getSelection() {
    return Array.from(this.selectedChunkKeys).map(k => {
      const [cx, cz] = k.split(',').map(Number);
      return { cx, cz };
    });
  }

  /**
   * Perform a sculpt action at the given world point (from raycast).
   * Records history before mutation.
   */
  sculptAt(worldPoint) {
    if (!worldPoint) return;

    // Optional scope filter
    if (this.confineToSelection && this.selectedChunkKeys.size > 0) {
      const cx = Math.floor((worldPoint.x + this.manager.chunkSize * 0.5) / this.manager.chunkSize);
      const cz = Math.floor((worldPoint.z + this.manager.chunkSize * 0.5) / this.manager.chunkSize);
      const key = `${cx},${cz}`;
      if (!this.selectedChunkKeys.has(key)) {
        return; // ignore click outside selected authored scope
      }
    }

    // Record undo before we change anything
    this.recordHistorySnapshot();

    const mutated = this.manager.applyBrush(worldPoint, this.brush);

    // Push live updates to the Three meshes (overlay-aware: re-applies any
    // road/river carve on top of the freshly-sculpted base heights).
    for (const data of mutated) {
      const key = `${data.cx},${data.cz}`;
      const handle = this.chunkMeshes.get(key);
      if (handle) {
        this.applyOverlayToHandle(handle, data);
      } else {
        // Chunk became live due to brush — create its visual now
        this.loadOrCreateChunkMesh(data.cx, data.cz);
      }
    }

    // If sculpting near roads/rivers, the corridor sample terrain shifted, so
    // the carve profile needs rebuilding after the gesture. Flag it; pointer-up
    // calls rebuildOverlays().
    this._sculptedSinceRebuild = true;

    this.needsRender = true;
    this.emitChange();
  }

  paintTerrainAt({ position, mode = this.brush.mode, radius = this.brush.radius, strength = this.brush.strength, falloff = this.brush.falloff } = {}) {
    const point = this.toVector3(position, 'position');
    const previous = { ...this.brush };
    this.setBrush({ mode, radius: Number(radius) || previous.radius, strength: Number(strength) || previous.strength, falloff });
    this.sculptAt(point);
    this.setBrush(previous);
    return { success: true, brush: { mode, radius: this.brush.radius, strength: this.brush.strength, falloff }, position: this.vectorToArray(point) };
  }

  // ------------------------------------------------------------------
  // Object / atlas editing
  // ------------------------------------------------------------------

  addPrimitive(args = {}) {
    const type = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'player_spawn'].includes(args.type) ? args.type : 'box';
    const position = args.position ? this.toNumberArray(args.position, 3, 'position') : this.vectorToArray(this.camTarget);
    const scale = args.scale ? this.toNumberArray(args.scale, 3, 'scale') : [1, 1, 1];
    const rotationDegrees = args.rotationDegrees ? this.toNumberArray(args.rotationDegrees, 3, 'rotationDegrees') : [0, 0, 0];
    const tileIndex = args.tile === undefined ? this.activeTileIndex : normalizeTileIndex(args.tile);
    const textureRepeat = args.textureRepeat ? this.toNumberArray(args.textureRepeat, 2, 'textureRepeat') : [1, 1];
    const zIndex = Math.round(Number(args.zIndex) || 0);

    const mesh = new THREE.Mesh(
      this.createPrimitiveGeometry(type),
      type === 'player_spawn'
        ? new THREE.MeshStandardMaterial({ color: 0x4ab3ff, emissive: 0x123a58, emissiveIntensity: 0.55, roughness: 0.52 })
        : createAtlasMaterial(tileIndex, textureRepeat, zIndex),
    );
    mesh.name = args.name || `${type}_${this.objectMeshes.length + 1}`;
    mesh.position.set(...position);
    mesh.scale.set(Math.max(0.01, scale[0]), Math.max(0.01, scale[1]), Math.max(0.01, scale[2]));
    mesh.rotation.set(...rotationDegrees.map(THREE.MathUtils.degToRad));
    mesh.renderOrder = zIndex;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      kind: 'mapObject',
      primitiveType: type,
      markerType: type === 'player_spawn' ? 'player_spawn' : null,
      tileIndex,
      textureRepeat,
      zIndex,
    };

    this.objectsGroup.add(mesh);
    this.objectMeshes.push(mesh);
    this.selectObject(mesh);
    this.needsRender = true;
    this.emitChange();
    return mesh;
  }

  createPrimitiveGeometry(type) {
    // Delegates to the shared util (src/map/primitiveGeometry.js) so the runtime
    // blueprint instantiator builds identical meshes.
    return makePrimitiveGeometry(type);
  }

  selectObject(mesh) {
    this.selectedObject = mesh || null;
    if (this.selectionHelper) {
      if (this.selectedObject) {
        this.selectionHelper.visible = true;
        this.selectionHelper.setFromObject(this.selectedObject);
      } else {
        this.selectionHelper.visible = false;
      }
    }
    this.updateTransformControls();
    this.needsRender = true;
    this.emitChange();
  }

  updateTransformControls() {
    if (!this.transformControls || !this.transformControlsHelper) return;

    const mode = this.objectTransformMode;
    const enabled = this.tool === 'object' && Boolean(this.selectedObject) && mode !== 'select';

    if (!enabled) {
      this.transformControls.detach();
      this.transformControls.enabled = false;
      this.transformControls.visible = false;
      this.transformControlsHelper.visible = false;
      this.needsRender = true;
      return;
    }

    this.transformControls.setMode(mode === 'move' ? 'translate' : mode);
    this.transformControls.enabled = true;
    this.transformControls.visible = true;
    this.transformControls.attach(this.selectedObject);
    this.transformControlsHelper.visible = true;
    this.needsRender = true;
  }

  onTransformDraggingChanged(event) {
    this.isTransformDragging = Boolean(event.value);
    if (event.value) {
      this.isPointerDown = false;
      this.dragMode = null;
    }
    this.needsRender = true;
  }

  onTransformObjectChange() {
    this.selectedObject?.updateMatrixWorld(true);
    if (this.selectionHelper?.visible && this.selectedObject) {
      this.selectionHelper.setFromObject(this.selectedObject);
    }
    this.needsRender = true;
    this.emitChange();
  }

  findObject(name) {
    if (!name) return this.selectedObject;
    const query = String(name).toLowerCase();
    return this.objectMeshes.find((mesh) => mesh.name.toLowerCase() === query)
      || this.objectMeshes.find((mesh) => mesh.name.toLowerCase().includes(query));
  }

  requireObject(name) {
    const mesh = this.findObject(name);
    if (!mesh) throw new Error(name ? `No map object matched "${name}"` : 'No selected map object');
    return mesh;
  }

  selectObjectByQuery(query) {
    const mesh = this.requireObject(query);
    this.selectObject(mesh);
    return { success: true, object: this.summarizeObject(mesh) };
  }

  // Lightweight name/type/index list for the Scene Objects tree view. Cheap
  // (no transforms/tile) so it can ride every emitChange without a perf hit.
  getObjectList() {
    return this.objectMeshes.map((mesh, index) => ({
      index,
      name: mesh.name,
      type: mesh.userData.primitiveType || mesh.type,
    }));
  }

  // Index-based select/delete so the tree view is unambiguous even when several
  // objects share a name (selectObjectByQuery matches by name substring).
  selectObjectAt(index) {
    const mesh = this.objectMeshes[index];
    if (!mesh) return { success: false };
    this.selectObject(mesh);
    return { success: true, object: this.summarizeObject(mesh) };
  }

  deleteObjectAt(index) {
    const mesh = this.objectMeshes[index];
    if (!mesh) return { success: false };
    const name = mesh.name;
    this.removeObject(mesh);
    this.selectObject(null);
    return { success: true, deleted: name };
  }

  editObjectTransform(args = {}, mode) {
    const mesh = this.requireObject(args.name);
    if (mode === 'move') {
      const position = this.toNumberArray(args.position, 3, 'position');
      if (args.relative) mesh.position.add(new THREE.Vector3(...position));
      else mesh.position.set(...position);
    }
    if (mode === 'scale') {
      const scale = this.toNumberArray(args.scale, 3, 'scale');
      mesh.scale.set(Math.max(0.01, scale[0]), Math.max(0.01, scale[1]), Math.max(0.01, scale[2]));
    }
    if (mode === 'rotate') {
      const rotation = this.toNumberArray(args.rotationDegrees, 3, 'rotationDegrees').map(THREE.MathUtils.degToRad);
      mesh.rotation.set(...rotation);
    }
    mesh.updateMatrixWorld(true);
    this.selectObject(mesh);
    return { success: true, object: this.summarizeObject(mesh) };
  }

  setObjectTile(args = {}) {
    const mesh = this.requireObject(args.name);
    const tileIndex = normalizeTileIndex(args.tile);
    this.replaceObjectMaterial(mesh, tileIndex, mesh.userData.textureRepeat || [1, 1], mesh.userData.zIndex || 0);
    this.activeTileIndex = tileIndex;
    this.selectObject(mesh);
    return { success: true, object: this.summarizeObject(mesh) };
  }

  setObjectTextureRepeat(args = {}) {
    const mesh = this.requireObject(args.name);
    const repeat = this.toNumberArray(args.repeat, 2, 'repeat').map((value) => Math.max(0.01, value));
    this.replaceObjectMaterial(mesh, mesh.userData.tileIndex ?? this.activeTileIndex, repeat, mesh.userData.zIndex || 0);
    this.selectObject(mesh);
    return { success: true, object: this.summarizeObject(mesh) };
  }

  setObjectZIndex(args = {}) {
    const mesh = this.requireObject(args.name);
    const current = mesh.userData.zIndex || 0;
    const next = Math.round(Number(args.zIndex) || 0);
    mesh.position.y += (next - current) * 0.012;
    mesh.renderOrder = next;
    this.replaceObjectMaterial(mesh, mesh.userData.tileIndex ?? this.activeTileIndex, mesh.userData.textureRepeat || [1, 1], next);
    this.selectObject(mesh);
    return { success: true, object: this.summarizeObject(mesh) };
  }

  duplicateObject(args = {}) {
    const mesh = this.requireObject(args.name);
    const clone = mesh.clone();
    clone.geometry = mesh.geometry.clone();
    clone.material = mesh.userData.primitiveType === 'player_spawn'
      ? mesh.material.clone()
      : createAtlasMaterial(mesh.userData.tileIndex ?? 0, mesh.userData.textureRepeat || [1, 1], mesh.userData.zIndex || 0);
    clone.userData = { ...mesh.userData, textureRepeat: [...(mesh.userData.textureRepeat || [1, 1])] };
    const offset = args.offset ? this.toNumberArray(args.offset, 3, 'offset') : [1.5, 0, 0];
    clone.position.add(new THREE.Vector3(...offset));
    clone.name = args.name ? `${mesh.name}_copy` : `${mesh.name}_copy_${this.objectMeshes.length + 1}`;
    this.objectsGroup.add(clone);
    this.objectMeshes.push(clone);
    this.selectObject(clone);
    return { success: true, object: this.summarizeObject(clone) };
  }

  deleteObject(args = {}) {
    const mesh = this.requireObject(args.name);
    const name = mesh.name;
    this.removeObject(mesh);
    this.selectObject(null);
    return { success: true, deleted: name };
  }

  setActiveTile(tile) {
    this.activeTileIndex = normalizeTileIndex(tile);
    this.emitChange();
    return { success: true, activeTile: getTileDescriptor(this.activeTileIndex) };
  }

  replaceObjectMaterial(mesh, tileIndex, textureRepeat, zIndex) {
    const oldMaterial = mesh.material;
    mesh.material = createAtlasMaterial(tileIndex, textureRepeat, zIndex);
    mesh.userData.tileIndex = tileIndex;
    mesh.userData.textureRepeat = [...textureRepeat];
    mesh.userData.zIndex = zIndex;
    this.disposeMaterial(oldMaterial);
  }

  removeObject(mesh) {
    const index = this.objectMeshes.indexOf(mesh);
    if (index >= 0) this.objectMeshes.splice(index, 1);
    this.objectsGroup?.remove(mesh);
    disposeObject3D(mesh);
    this.needsRender = true;
    this.emitChange();
  }

  getObjectUnderPointer(clientX, clientY) {
    if (!this.camera || !this.objectsGroup) return null;
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.mouseNDC.set(nx, ny);
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const hits = this.raycaster.intersectObjects(this.objectMeshes, false);
    return hits[0]?.object || null;
  }

  getSceneSummary() {
    return {
      terrain: this.manager.getStats(),
      cameraTarget: this.vectorToArray(this.camTarget),
      selectedObject: this.selectedObject?.name || null,
      activeTile: getTileDescriptor(this.activeTileIndex),
      palette: TILE_PALETTE_CATALOG.map(({ index, name, use }) => ({ index, number: index + 1, name, use })),
      objects: this.objectMeshes.map((mesh) => this.summarizeObject(mesh)),
    };
  }

  summarizeObject(mesh) {
    return {
      name: mesh.name,
      type: mesh.userData.primitiveType || mesh.type,
      tile: getTileDescriptor(mesh.userData.tileIndex),
      zIndex: mesh.userData.zIndex || 0,
      position: this.vectorToArray(mesh.position),
      rotationDegrees: [
        THREE.MathUtils.radToDeg(mesh.rotation.x),
        THREE.MathUtils.radToDeg(mesh.rotation.y),
        THREE.MathUtils.radToDeg(mesh.rotation.z),
      ].map((value) => this.roundNumber(value)),
      scale: this.vectorToArray(mesh.scale),
      textureRepeat: mesh.userData.textureRepeat || [1, 1],
    };
  }

  getObjectsJSON() {
    return this.objectMeshes.map((mesh) => ({
      name: mesh.name,
      type: mesh.userData.primitiveType || 'box',
      markerType: mesh.userData.markerType || null,
      tileIndex: mesh.userData.tileIndex ?? 0,
      textureRepeat: mesh.userData.textureRepeat || [1, 1],
      zIndex: mesh.userData.zIndex || 0,
      position: this.vectorToArray(mesh.position),
      rotationDegrees: [
        THREE.MathUtils.radToDeg(mesh.rotation.x),
        THREE.MathUtils.radToDeg(mesh.rotation.y),
        THREE.MathUtils.radToDeg(mesh.rotation.z),
      ].map((value) => this.roundNumber(value)),
      scale: this.vectorToArray(mesh.scale),
    }));
  }

  loadObjectsJSON(objects = []) {
    this.selectObject(null);
    for (const mesh of this.objectMeshes) {
      this.objectsGroup.remove(mesh);
      disposeObject3D(mesh);
    }
    this.objectMeshes = [];

    for (const entry of objects) {
      const type = entry.markerType === 'player_spawn' ? 'player_spawn' : entry.type;
      this.addPrimitive({
        type,
        name: entry.name,
        position: entry.position,
        rotationDegrees: entry.rotationDegrees,
        scale: entry.scale,
        tile: entry.tileIndex,
        textureRepeat: entry.textureRepeat,
        zIndex: entry.zIndex,
      });
    }
    // Removed the forced reseed. Previously `if (length === 0) seedInitialObjects()`
    // made it impossible to permanently remove the 3 default starter shapes.
    // Fresh starts still get the defaults explicitly via start() when there's no autosave.
    // "New Level", manual deletes, and loading projects/blueprints with 0 objects will now stay empty.
    this.needsRender = true;
    this.emitChange();
  }

  formatTileCatalogForPrompt() {
    return formatTileCatalogForPrompt();
  }

  toVector3(value, label) {
    const numbers = this.toNumberArray(value, 3, label);
    return new THREE.Vector3(...numbers);
  }

  toNumberArray(value, length, label) {
    if (!Array.isArray(value) || value.length !== length) {
      throw new Error(`${label} must be an array of ${length} numbers`);
    }
    return value.map((item) => {
      const next = Number(item);
      if (!Number.isFinite(next)) throw new Error(`${label} must contain only numbers`);
      return next;
    });
  }

  vectorToArray(vector) {
    return [this.roundNumber(vector.x), this.roundNumber(vector.y), this.roundNumber(vector.z)];
  }

  roundNumber(value) {
    return Math.round(Number(value) * 1000) / 1000;
  }

  disposeMaterial(material) {
    if (!material) return;
    const materials = Array.isArray(material) ? material : [material];
    for (const item of materials) {
      item.map?.dispose?.();
      item.dispose?.();
    }
  }

  // ------------------------------------------------------------------
  // History (deformation memory)
  // ------------------------------------------------------------------

  recordHistorySnapshot() {
    // Snapshot only the heights of currently live chunks (cheap because small)
    const snap = new Map();
    for (const [key, handle] of this.chunkMeshes) {
      snap.set(key, cloneHeights(handle.chunkData.heights));
    }

    // Truncate redo tail
    if (this.historyIndex < this.history.length - 1) {
      this.history.length = this.historyIndex + 1;
    }

    this.history.push(snap);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    } else {
      this.historyIndex += 1;
    }
  }

  restoreSnapshot(snap) {
    for (const [key, heights] of snap.entries()) {
      const handle = this.chunkMeshes.get(key);
      if (handle) {
        // Restore BASE heights into manager data, then re-apply any active
        // road/river carve overlay on top (overlay never touches base).
        handle.chunkData.heights.set(heights);
        this.applyOverlayToHandle(handle, handle.chunkData);
      }
    }
    // Re-establish seams after a big restore (cheap)
    const loaded = this.manager.getLoadedChunks();
    // Force a full re-sync pass (manager doesn't expose a public one, do a dummy no-op apply? or just sync manually)
    // Simpler: after restore we can just re-sync by calling internal-ish logic via reset on a no-op.
    // Actually the safest is to just let the next brush or explicit "re-seam" handle it.
    // For correctness on undo we do a lightweight pass here:
    for (const data of loaded) {
      const k = `${data.cx},${data.cz}`;
      const h = this.chunkMeshes.get(k);
      if (h) {
        // Touch manager's live reference
        this.manager.liveChunks.set(k, data);
      }
    }
    this.manager.reconcileSeams(loaded); // public seam sync for undo/restore correctness
    this.needsRender = true;
    this.emitChange();
  }

  undo() {
    if (this.historyIndex < 0) return;
    const snap = this.history[this.historyIndex];
    this.historyIndex -= 1;
    this.restoreSnapshot(snap);
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex += 1;
    const snap = this.history[this.historyIndex];
    this.restoreSnapshot(snap);
  }

  resetEdges(scope = 'visible') {
    let targets = [];
    if (scope === 'selected' && this.selectedChunkKeys.size > 0) {
      for (const key of this.selectedChunkKeys) {
        const [cx, cz] = key.split(',').map(Number);
        const data = this.manager.liveChunks.get(key) || this.manager.getOrCreateChunk(cx, cz);
        if (data) targets.push(data);
      }
    } else {
      targets = this.manager.getLoadedChunks();
    }

    this.recordHistorySnapshot();
    const affected = this.manager.resetEdgesToProcedural(targets);

    for (const data of affected) {
      const key = `${data.cx},${data.cz}`;
      const handle = this.chunkMeshes.get(key);
      if (handle) this.applyOverlayToHandle(handle, data);
    }
    this.needsRender = true;
    this.emitChange();
  }

  // ------------------------------------------------------------------
  // Chunk management (extend / focus)
  // ------------------------------------------------------------------

  generateAround(cx, cz, radius = 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        this.loadOrCreateChunkMesh(cx + dx, cz + dz);
      }
    }
    this.needsRender = true;
    this.emitChange();
  }

  focusChunk(cx, cz) {
    const data = this.manager.getOrCreateChunk(cx, cz);
    const wx = cx * data.size;
    const wz = cz * data.size;
    this.camTarget.set(wx, 2, wz);
    this.loadOrCreateChunkMesh(cx, cz); // ensure visible
    this.updateCamera();
  }

  // ------------------------------------------------------------------
  // Input handling
  // ------------------------------------------------------------------

  getWorldPointUnderPointer(clientX, clientY) {
    if (!this.camera || !this.chunksGroup) return null;

    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.mouseNDC.set(nx, ny);
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);

    // Intersect only our chunks (fast enough for small number)
    const meshes = Array.from(this.chunkMeshes.values()).map(h => h.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      return hits[0].point.clone();
    }
    return null;
  }

  onPointerDown(e) {
    if (
      this.tool === 'object' &&
      this.objectTransformMode !== 'select' &&
      (this.isTransformDragging || this.transformControls?.axis)
    ) {
      return;
    }

    this.isPointerDown = true;
    this.lastPointer.x = e.clientX;
    this.lastPointer.y = e.clientY;
    this.pointer.inside = true;

    const alt = e.altKey || e.metaKey;
    const right = e.button === 2;
    const middle = e.button === 1;

    if (this.tool === 'object' && e.button === 0 && !alt) {
      const previousSelection = this.selectedObject;
      const hit = this.getObjectUnderPointer(e.clientX, e.clientY);
      if (hit) {
        this.selectObject(hit);
      } else {
        const pt = this.getWorldPointUnderPointer(e.clientX, e.clientY);
        if (pt && previousSelection && e.shiftKey) {
          previousSelection.position.set(pt.x, pt.y + 0.5, pt.z);
          previousSelection.updateMatrixWorld(true);
          this.selectObject(previousSelection);
        } else {
          this.selectObject(null);
        }
      }
      this.dragMode = null;
    } else if (this.tool === 'view' || alt || right || middle) {
      this.dragMode = (right || middle) ? 'pan' : 'orbit';
    } else if (this.tool === 'sculpt' && e.button === 0) {
      this.dragMode = 'sculpt';
      const pt = this.getWorldPointUnderPointer(e.clientX, e.clientY);
      if (pt) this.sculptAt(pt);
    } else if ((this.tool === 'road' || this.tool === 'river') && e.button === 0) {
      // Drafting a new spline, or selecting + dragging an existing one.
      const pt = this.getWorldPointUnderPointer(e.clientX, e.clientY);
      this.dragMode = null;
      if (!pt) return;
      if (this.tool === 'road') {
        if (this.roadDraft) {
          this.addRoadDraftPoint(pt);
        } else {
          const hit = this.pickRoadAt(pt.x, pt.z);
          if (hit) {
            this.selectRoadRiver({ kind: 'road', id: hit.id });
            this.beginRoadDrag(pt);
          } else {
            this.selectRoadRiver(null);
            this.roadDraft = { points: [] };
            this.addRoadDraftPoint(pt);
          }
        }
      } else {
        if (this.riverDraft) {
          this.addRiverDraftPoint(pt);
        } else {
          const hit = this.pickRiverAt(pt.x, pt.z);
          if (hit) {
            this.selectRoadRiver({ kind: 'river', id: hit.id });
            this.beginRiverDrag(pt);
          } else {
            this.selectRoadRiver(null);
            this.riverDraft = { points: [] };
            this.addRiverDraftPoint(pt);
          }
        }
      }
    }

    this.canvas.focus({ preventScroll: true });
    e.preventDefault();
  }

  onDoubleClick(e) {
    if (this.tool === 'road' || this.tool === 'river') {
      // Finish the in-progress spline (dblclick's extra point was deduped).
      if (this.tool === 'road') this.finishRoadDraft();
      else this.finishRiverDraft();
      return;
    }
    const pt = this.getWorldPointUnderPointer(e.clientX, e.clientY);
    if (pt) {
      this.focusAtWorldPoint(pt);
      this.updateBrushPreview();
    }
  }

  onPointerMove(e) {
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.inside = true;

    if (this.isTransformDragging) {
      return;
    }

    // Always update brush preview when in sculpt mode
    this.updateBrushPreview();

    // Road/river: live rubber-band preview while drafting a spline.
    if ((this.tool === 'road' || this.tool === 'river') && (this.roadDraft || this.riverDraft)) {
      const pt = this.getWorldPointUnderPointer(e.clientX, e.clientY);
      if (pt) this.updateDraftPreviewToCursor(pt);
    }

    // Road/river: terrain-drag move of the selected spline.
    if (this.roadDrag) {
      const pt = this.getWorldPointUnderPointer(e.clientX, e.clientY);
      if (pt) this.updateRoadDrag(pt);
      this.needsRender = true;
      return;
    }
    if (this.riverDrag) {
      const pt = this.getWorldPointUnderPointer(e.clientX, e.clientY);
      if (pt) this.updateRiverDrag(pt);
      this.needsRender = true;
      return;
    }

    if (!this.isPointerDown || !this.dragMode) return;

    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    this.lastPointer.x = e.clientX;
    this.lastPointer.y = e.clientY;

    if (this.dragMode === 'orbit') {
      this.orbit(dx, dy);
    } else if (this.dragMode === 'pan') {
      this.pan(dx, dy);
    } else if (this.dragMode === 'sculpt' && this.tool === 'sculpt') {
      const pt = this.getWorldPointUnderPointer(e.clientX, e.clientY);
      if (pt) this.sculptAt(pt);
    }

    this.needsRender = true;
  }

  onPointerUp() {
    this.isPointerDown = false;
    this.dragMode = null;

    // Commit a deferred road/river move (ribbon rebuild was skipped during drag).
    if (this.roadDrag || this.riverDrag) this.endDrag();

    // Sculpting shifts the corridor sample terrain — rebuild overlays once the
    // gesture ends so road/river carves re-conform to the new base.
    if (this._sculptedSinceRebuild) {
      this._sculptedSinceRebuild = false;
      this.rebuildOverlays();
    }

    this.updateBrushPreview();
  }

  onWheel(e) {
    e.preventDefault();
    const delta = Math.sign(e.deltaY) * (e.shiftKey ? 2.5 : 1);
    this.dolly(delta * 3.2);
  }

  onContextMenu(e) {
    e.preventDefault(); // we use right-drag for pan
  }

  // ------------------------------------------------------------------
  // Render / resize
  // ------------------------------------------------------------------

  resizeIfNeeded() {
    if (!this.renderer || !this.canvas || !this.camera) return;

    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const pr = Math.min(globalThis.devicePixelRatio ?? 1, 2);

    const targetW = Math.floor(w * pr);
    const targetH = Math.floor(h * pr);

    if (targetW === this.lastResizeW && targetH === this.lastResizeH) return;

    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.transformControls?.viewport) {
      this.transformControls.viewport.set(0, 0, w, h);
    }

    this.lastResizeW = targetW;
    this.lastResizeH = targetH;
    this.needsRender = true;
  }

  tick() {
    this.resizeIfNeeded();

    // Occasional hygiene
    if (Math.random() < 0.04) {
      this.unloadFarChunks(6);
    }

    // Keep preview responsive even without pointer events (e.g. after camera move)
    if (this.tool === 'sculpt') {
      this.updateBrushPreview();
    }

    if (this.selectionHelper?.visible && this.selectedObject) {
      this.selectionHelper.setFromObject(this.selectedObject);
    }

    if (this.needsRender && this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  }

  // ------------------------------------------------------------------
  // Exports (the two paths requested)
  // ------------------------------------------------------------------

  exportRuntimeJSON() {
    // Clean, versioned data the game can consume at runtime
    return {
      ...this.manager.toJSON({ includeLoaded: true }),
      objects: this.getObjectsJSON(),
    };
  }

  async exportGLB(scope = 'visible') {
    const { GLTFExporter } = await GLTFExporterPromise;
    const exporter = new GLTFExporter();

    const root = new THREE.Group();
    root.name = 'DreamfallTerrain_v1';

    let toExport = this.manager.getLoadedChunks();
    if (scope === 'selected' && this.selectedChunkKeys.size > 0) {
      toExport = toExport.filter(d => this.selectedChunkKeys.has(`${d.cx},${d.cz}`));
    }
    if (scope === 'authored') {
      toExport = Array.from(this.manager.authored.values());
    }

    for (const data of toExport) {
      const chunkGroup = new THREE.Group();
      chunkGroup.name = `chunk_${data.cx}_${data.cz}`;

      // Visual layer (current sculpted mesh)
      const handle = this.chunkMeshes.get(`${data.cx},${data.cz}`);
      let visual;
      if (handle) {
        visual = handle.mesh.clone(true);
      } else {
        // Fallback: build a fresh mesh from data (no live handle)
        const fresh = createTerrainChunkMesh(data);
        visual = fresh.mesh;
      }
      // The live chunks share a TSL node material (WebGPU) that GLTFExporter
      // can't serialise. Swap in a plain standard material baking the base tint
      // and, if set, the global custom texture as the albedo map.
      visual.material = this.exportTerrainMaterial();
      // Make the mesh local to its chunkGroup (remove the world offset it carries)
      visual.position.set(0, 0, 0);
      visual.name = 'visual';
      visual.castShadow = true;
      visual.receiveShadow = true;
      chunkGroup.add(visual);

      // Collision layer (same geo for now — future can be decimated or a heightfield proxy)
      const collision = visual.clone(true);
      collision.name = 'collision';
      collision.visible = true; // keep it; consumers can hide or use for trimesh
      // Make collision slightly inset or keep identical for simplicity
      chunkGroup.add(collision);

      // Metadata layer (empty object carrying the editable heights for round-tripping)
      const meta = new THREE.Object3D();
      meta.name = 'metadata';
      meta.userData = {
        cx: data.cx,
        cz: data.cz,
        size: data.size,
        resolution: data.resolution,
        heights: Array.from(data.heights),
      };
      chunkGroup.add(meta);

      // Place the chunkGroup at the correct world offset so the whole export is positioned
      chunkGroup.position.set(data.cx * data.size, 0, data.cz * data.size);
      root.add(chunkGroup);
    }

    if (this.objectMeshes.length > 0) {
      const objects = new THREE.Group();
      objects.name = 'atlas_objects';
      for (const mesh of this.objectMeshes) {
        const clone = mesh.clone(true);
        clone.geometry = mesh.geometry.clone();
        clone.material = createAtlasMaterial(mesh.userData.tileIndex ?? 0, mesh.userData.textureRepeat || [1, 1], mesh.userData.zIndex || 0);
        clone.userData = { ...mesh.userData };
        objects.add(clone);
      }
      root.add(objects);
    }

    return new Promise((resolve, reject) => {
      exporter.parse(
        root,
        (result) => {
          // result is either JSON or ArrayBuffer (binary:true)
          resolve(result);
        },
        (error) => reject(error),
        { binary: true, animations: [], includeCustomExtensions: true }
      );
    });
  }

  // ------------------------------------------------------------------
  // Roads + rivers (Edit-editor tools)
  // ------------------------------------------------------------------

  // ---- project save/load (roads/rivers are plain local-frame polylines) ----

  getRoadsJSON() {
    return this.roads.map((r) => ({
      id: r.id, type: 'road', width: r.width,
      points: r.points.map((p) => ({ x: p.x, z: p.z })),
      ...(typeof r.trackStyle === 'string' && r.trackStyle ? { trackStyle: r.trackStyle } : {}),
      ...(typeof r.surface === 'string' && r.surface ? { surface: r.surface } : {}),
      ...(Number.isFinite(r.elevation) ? { elevation: r.elevation } : {}),
      ...(r.elevationMode === 'gentleSlope' ? { elevationMode: 'gentleSlope' } : {}),
    }));
  }

  getRiversJSON() {
    return this.rivers.map((r) => ({
      id: r.id, type: 'river', width: r.width, depth: r.depth,
      points: r.points.map((p) => ({ x: p.x, z: p.z })),
    }));
  }

  loadRoadsJSON(raw = []) {
    this.roads = (Array.isArray(raw) ? raw : [])
      .map((r) => normalizeRoad({ ...r, type: 'road' }))
      .filter(Boolean);
  }

  loadRiversJSON(raw = []) {
    this.rivers = (Array.isArray(raw) ? raw : [])
      .map((r) => normalizeRiver({ ...r, type: 'river' }))
      .filter(Boolean);
  }

  // ---- non-destructive carve overlay on chunk meshes ----
  // Writes OVERLAID heights straight into the chunk geometry's position
  // attribute, leaving manager/data.heights (BASE) untouched — so sculpting,
  // undo, and export stay clean and the road profile can sample base terrain
  // without recursion. updateHeights() would copy back into data.heights, so we
  // bypass it. Mirrors createStreamingTerrainLevel's shapeChunk order:
  // road corridor → river corridor.
  applyOverlayToHandle(handle, data) {
    const geom = handle.geometry;
    if (!geom?.attributes?.position) return;
    const res = data.resolution;
    const size = data.size;
    const step = size / (res - 1);
    const originX = data.cx * size - size * 0.5;
    const originZ = data.cz * size - size * 0.5;
    const pos = geom.attributes.position;
    const base = data.heights;
    const hasRoad = !!this.roadCorridor;
    const hasRiver = !!this.riverCorridor;
    for (let j = 0; j < res; j += 1) {
      for (let i = 0; i < res; i += 1) {
        const idx = j * res + i;
        let h = base[idx];
        if (hasRoad || hasRiver) {
          const wx = originX + i * step;
          const wz = originZ + j * step;
          if (hasRoad) h = applyRoadCorridorHeight(h, this.roadCorridor(wx, wz), BRIDGE_CLEARANCE);
          if (hasRiver) h = applyRiverCorridorHeight(h, this.riverCorridor(wx, wz));
          if (hasRoad) h = clampBridgedRoadFloor(h, this.roadCorridor(wx, wz), BRIDGE_CLEARANCE);
        }
        pos.setY(idx, h);
      }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    geom.boundingBox = null;
  }

  refreshAllChunkDisplays() {
    for (const handle of this.chunkMeshes.values()) {
      this.applyOverlayToHandle(handle, handle.chunkData);
    }
    this.needsRender = true;
  }

  // Rebuild the road/river corridor samplers from current polylines (cheap) +
  // refresh chunk displays. Split from the ribbon rebuild so a move-drag can
  // recompute the carve every frame and defer the heavier ribbon rebuild.
  rebuildCorridors() {
    if (this.roads.length) {
      const profile = buildRoadProfile({
        roads: this.roads,
        sampleHeight: (x, z) => this.manager.getHeightAt(x, z),
        ...ROAD_PROFILE_OPTS,
      });
      this.roadCorridor = profile.corridorAt;
    } else {
      this.roadCorridor = null;
    }
    if (this.rivers.length) {
      const profile = buildRiverProfile({
        rivers: this.rivers,
        sampleHeight: (x, z) => this.manager.getHeightAt(x, z),
        ...RIVER_PROFILE_OPTS,
      });
      this.riverCorridor = profile.corridorAt;
    } else {
      this.riverCorridor = null;
    }
  }

  refreshRibbonPreviews() {
    // Road ribbon (reuses the runtime roadworks builder; colliders ignored here).
    if (this.roadworksPreview) {
      this.roadworksPreview.dispose();
      this.roadworksPreview.group.removeFromParent();
      this.roadworksPreview = null;
    }
    if (this.tracksidePreview) {
      this.tracksidePreview.dispose();
      this.tracksidePreview.group.removeFromParent();
      this.tracksidePreview = null;
    }
    if (this.roads.length) {
      const profile = buildRoadProfile({
        roads: this.roads,
        sampleHeight: (x, z) => this.manager.getHeightAt(x, z),
        ...ROAD_PROFILE_OPTS,
      });
      this.roadworksPreview = createRoadworks({
        profile,
        sampleHeight: (x, z) => this.manager.getHeightAt(x, z),
        riverCorridorAt: this.riverCorridor,
      });
      this.roadsGroup.add(this.roadworksPreview.group);
      // GT3-style trackside layers for any road with a trackStyle (colliders ignored
      // in the editor preview — this is visual only).
      this.tracksidePreview = createTracksideLayers({
        profile,
        sampleHeight: (x, z) => this.manager.getHeightAt(x, z),
      });
      if (this.tracksidePreview.group.children.length) {
        this.roadsGroup.add(this.tracksidePreview.group);
      }
    }
    // River ribbon (animated water surface; getWaterHeightAt unused in editor).
    if (this.riverworksPreview) {
      this.riverworksPreview.dispose();
      this.riverworksPreview.group.removeFromParent();
      this.riverworksPreview = null;
    }
    if (this.rivers.length) {
      const profile = buildRiverProfile({
        rivers: this.rivers,
        sampleHeight: (x, z) => this.manager.getHeightAt(x, z),
        ...RIVER_PROFILE_OPTS,
      });
      this.riverworksPreview = createRiverworks({ profile });
      this.riversGroup.add(this.riverworksPreview.group);
    }
  }

  // Full rebuild: corridors + ribbons + chunk displays + selection/draft overlays.
  rebuildOverlays() {
    this.rebuildCorridors();
    this.refreshRibbonPreviews();
    this.refreshAllChunkDisplays();
    this.updateSelectionLine();
    this.needsRender = true;
  }

  // ---- drafting (spline on terrain) ----

  staticDraftLineMaterial(color) {
    return new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  }

  updateLineFromPoints(line, points) {
    if (!line) return;
    const positions = [];
    for (const p of points) positions.push(p.x, this.manager.getHeightAt(p.x, p.z) + 0.3, p.z);
    const geom = line.geometry;
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.attributes.position.needsUpdate = true;
    geom.computeBoundingSphere();
  }

  ensureDraftLine(kind) {
    const isRoad = kind === 'road';
    if (isRoad ? this.roadDraftLine : this.riverDraftLine) return;
    const geom = new THREE.BufferGeometry();
    const line = new THREE.Line(geom, this.staticDraftLineMaterial(isRoad ? 0xf2e056 : 0x6fb7e8));
    this.overlayGroup.add(line);
    if (isRoad) this.roadDraftLine = line; else this.riverDraftLine = line;
  }

  clearDraftLine(kind) {
    const isRoad = kind === 'road';
    const line = isRoad ? this.roadDraftLine : this.riverDraftLine;
    if (line) {
      this.overlayGroup.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    if (isRoad) this.roadDraftLine = null; else this.riverDraftLine = null;
  }

  addRoadDraftPoint(pt) {
    if (!pt) return;
    if (!this.roadDraft) this.roadDraft = { points: [] };
    const last = this.roadDraft.points[this.roadDraft.points.length - 1];
    if (last && Math.hypot(last.x - pt.x, last.z - pt.z) < 0.5) return; // dedup (dblclick)
    this.roadDraft.points.push({ x: pt.x, z: pt.z });
    this.ensureDraftLine('road');
    this.updateLineFromPoints(this.roadDraftLine, this.roadDraft.points);
    this.needsRender = true;
    this.emitChange();
  }

  addRiverDraftPoint(pt) {
    if (!pt) return;
    if (!this.riverDraft) this.riverDraft = { points: [] };
    const last = this.riverDraft.points[this.riverDraft.points.length - 1];
    if (last && Math.hypot(last.x - pt.x, last.z - pt.z) < 0.5) return; // dedup (dblclick)
    this.riverDraft.points.push({ x: pt.x, z: pt.z });
    this.ensureDraftLine('river');
    this.updateLineFromPoints(this.riverDraftLine, this.riverDraft.points);
    this.needsRender = true;
    this.emitChange();
  }

  // Live rubber-band: extend the draft preview line through the cursor point so
  // the user sees where the next segment will land before clicking.
  updateDraftPreviewToCursor(pt) {
    if (this.tool === 'road' && this.roadDraft) {
      this.ensureDraftLine('road');
      this.updateLineFromPoints(this.roadDraftLine, [...this.roadDraft.points, { x: pt.x, z: pt.z }]);
      this.needsRender = true;
    } else if (this.tool === 'river' && this.riverDraft) {
      this.ensureDraftLine('river');
      this.updateLineFromPoints(this.riverDraftLine, [...this.riverDraft.points, { x: pt.x, z: pt.z }]);
      this.needsRender = true;
    }
  }

  finishRoadDraft() {
    if (!this.roadDraft || this.roadDraft.points.length < 2) { this.cancelRoadDraft(); return null; }
    const road = normalizeRoad({
      id: makeId('r'),
      points: this.roadDraft.points,
      width: this.roadWidth,
      type: 'road',
      elevation: this.roadElevationMode === 'fixed' ? (this.roadElevation ?? 0) : null,
      elevationMode: this.roadElevationMode === 'gentleSlope' ? 'gentleSlope' : null,
    });
    this.roadDraft = null;
    this.clearDraftLine('road');
    if (road) {
      this.roads.push(road);
      this.selectedRoadId = road.id;
      this.selectedRiverId = null;
      this.rebuildOverlays();
    }
    this.emitChange();
    return road;
  }

  finishRiverDraft() {
    if (!this.riverDraft || this.riverDraft.points.length < 2) { this.cancelRiverDraft(); return null; }
    const river = normalizeRiver({
      id: makeId('rv'),
      points: this.riverDraft.points,
      width: this.riverWidth,
      depth: this.riverDepth,
      type: 'river',
    });
    this.riverDraft = null;
    this.clearDraftLine('river');
    if (river) {
      this.rivers.push(river);
      this.selectedRiverId = river.id;
      this.selectedRoadId = null;
      this.rebuildOverlays();
    }
    this.emitChange();
    return river;
  }

  cancelRoadDraft() {
    if (!this.roadDraft && !this.roadDraftLine) return;
    this.roadDraft = null;
    this.clearDraftLine('road');
    this.needsRender = true;
    this.emitChange();
  }

  cancelRiverDraft() {
    if (!this.riverDraft && !this.riverDraftLine) return;
    this.riverDraft = null;
    this.clearDraftLine('river');
    this.needsRender = true;
    this.emitChange();
  }

  // ---- selection + move + width/depth + delete ----

  // Distance from a world XZ point to a polyline's sampled centerline.
  distanceToCenterline(points, x, z) {
    const samples = sampleCenterline(points);
    let best = Infinity;
    for (let i = 0; i < samples.length - 1; i += 1) {
      const a = samples[i], b = samples[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const lenSq = abx * abx + abz * abz;
      let t = lenSq > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (a.x + t * abx), z - (a.z + t * abz));
      if (d < best) best = d;
    }
    return best;
  }

  pickRoadAt(x, z) {
    let best = null, bestDist = Infinity;
    for (const r of this.roads) {
      const d = this.distanceToCenterline(r.points, x, z);
      const reach = Math.max(r.width * 0.75, 4) + PICK_TOLERANCE;
      if (d < reach && d < bestDist) { bestDist = d; best = r; }
    }
    return best;
  }

  pickRiverAt(x, z) {
    let best = null, bestDist = Infinity;
    for (const r of this.rivers) {
      const d = this.distanceToCenterline(r.points, x, z);
      const reach = Math.max(r.width * 0.75, 4) + PICK_TOLERANCE;
      if (d < reach && d < bestDist) { bestDist = d; best = r; }
    }
    return best;
  }

  selectRoadRiver(selection) {
    // selection: { kind:'road'|'river', id } | null
    if (!selection) {
      this.selectedRoadId = null;
      this.selectedRiverId = null;
    } else if (selection.kind === 'road') {
      this.selectedRoadId = selection.id;
      this.selectedRiverId = null;
    } else {
      this.selectedRiverId = selection.id;
      this.selectedRoadId = null;
    }
    this.updateSelectionLine();
    this.needsRender = true;
    this.emitChange();
  }

  currentRoad() { return this.roads.find((r) => r.id === this.selectedRoadId) || null; }
  currentRiver() { return this.rivers.find((r) => r.id === this.selectedRiverId) || null; }

  updateSelectionLine() {
    if (this.selectionLine) {
      this.overlayGroup.remove(this.selectionLine);
      this.selectionLine.geometry.dispose();
      this.selectionLine.material.dispose();
      this.selectionLine = null;
    }
    const road = this.currentRoad();
    const river = this.currentRiver();
    const points = road?.points || river?.points;
    if (!points || points.length < 2) return;
    const geom = new THREE.BufferGeometry();
    this.selectionLine = new THREE.Line(geom, this.staticDraftLineMaterial(0xffffff));
    this.updateLineFromPoints(this.selectionLine, points);
    this.overlayGroup.add(this.selectionLine);
  }

  beginRoadDrag(pt) {
    const road = this.currentRoad();
    if (!road || !pt) return false;
    this.roadDrag = { anchor: { x: pt.x, z: pt.z }, snapshot: road.points.map((p) => ({ x: p.x, z: p.z })) };
    return true;
  }

  beginRiverDrag(pt) {
    const river = this.currentRiver();
    if (!river || !pt) return false;
    this.riverDrag = { anchor: { x: pt.x, z: pt.z }, snapshot: river.points.map((p) => ({ x: p.x, z: p.z })) };
    return true;
  }

  updateRoadDrag(pt) {
    if (!this.roadDrag || !pt) return;
    const dx = pt.x - this.roadDrag.anchor.x;
    const dz = pt.z - this.roadDrag.anchor.z;
    const road = this.currentRoad();
    if (!road) return;
    road.points = this.roadDrag.snapshot.map((p) => ({ x: p.x + dx, z: p.z + dz }));
    this.rebuildCorridors();
    this.refreshAllChunkDisplays(); // defer ribbon rebuild to pointer-up
    this.needsRender = true;
  }

  updateRiverDrag(pt) {
    if (!this.riverDrag || !pt) return;
    const dx = pt.x - this.riverDrag.anchor.x;
    const dz = pt.z - this.riverDrag.anchor.z;
    const river = this.currentRiver();
    if (!river) return;
    river.points = this.riverDrag.snapshot.map((p) => ({ x: p.x + dx, z: p.z + dz }));
    this.rebuildCorridors();
    this.refreshAllChunkDisplays();
    this.needsRender = true;
  }

  endDrag() {
    const dragged = this.roadDrag || this.riverDrag;
    this.roadDrag = null;
    this.riverDrag = null;
    if (dragged) {
      this.refreshRibbonPreviews(); // commit the deferred ribbon rebuild
      this.updateSelectionLine();
      this.needsRender = true;
      this.emitChange();
    }
  }

  setRoadWidth(width) {
    const w = Math.max(2, Number(width) || 8);
    const road = this.currentRoad();
    if (road) road.width = w; else this.roadWidth = w;
    this.rebuildOverlays();
    this.emitChange();
  }

  setRoadElevation(value) {
    const numeric = value === null || value === '' ? NaN : Number(value);
    const next = Number.isFinite(numeric) ? numeric : null;
    const road = this.currentRoad();
    if (road) {
      road.elevation = next;
      delete road.elevationMode;
    } else {
      this.roadElevation = next;
    }
    this.roadElevationMode = next === null ? this.roadElevationMode : 'fixed';
    this.rebuildOverlays();
    this.emitChange();
  }

  setRoadElevationMode(mode) {
    const next = mode === 'gentleSlope' || mode === 'fixed' ? mode : 'terrain';
    this.roadElevationMode = next;
    if (next === 'fixed' && !Number.isFinite(this.roadElevation)) this.roadElevation = 0;
    if (next !== 'fixed') this.roadElevation = null;
    const road = this.currentRoad();
    if (road) {
      if (next === 'gentleSlope') {
        road.elevation = null;
        road.elevationMode = 'gentleSlope';
      } else if (next === 'fixed') {
        road.elevation = this.roadElevation ?? 0;
        delete road.elevationMode;
      } else {
        road.elevation = null;
        delete road.elevationMode;
      }
    }
    this.rebuildOverlays();
    this.emitChange();
  }

  setRiverWidth(width) {
    const w = Math.max(2, Number(width) || 10);
    const river = this.currentRiver();
    if (river) river.width = w; else this.riverWidth = w;
    this.rebuildOverlays();
    this.emitChange();
  }

  setRiverDepth(depth) {
    const d = Math.max(1, Number(depth) || 6);
    const river = this.currentRiver();
    if (river) river.depth = d; else this.riverDepth = d;
    this.rebuildOverlays();
    this.emitChange();
  }

  deleteSelectedRoadRiver() {
    let changed = false;
    if (this.selectedRoadId) {
      this.roads = this.roads.filter((r) => r.id !== this.selectedRoadId);
      this.selectedRoadId = null;
      changed = true;
    }
    if (this.selectedRiverId) {
      this.rivers = this.rivers.filter((r) => r.id !== this.selectedRiverId);
      this.selectedRiverId = null;
      changed = true;
    }
    if (changed) this.rebuildOverlays();
    this.emitChange();
    return changed;
  }

  // ---- keyboard (Enter finishes draft, Esc cancels, Del removes selection) ----

  onKeyDown(e) {
    if (this.tool !== 'road' && this.tool !== 'river') return;
    const drafting = !!(this.roadDraft || this.riverDraft);
    if (e.key === 'Enter') {
      if (this.tool === 'road') this.finishRoadDraft();
      else this.finishRiverDraft();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (drafting) {
        if (this.tool === 'road') this.cancelRoadDraft(); else this.cancelRiverDraft();
      } else {
        this.selectRoadRiver(null);
      }
      e.preventDefault();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!drafting) { this.deleteSelectedRoadRiver(); e.preventDefault(); }
    }
  }

  // ------------------------------------------------------------------
  // Persistence helpers (called by UI)
  // ------------------------------------------------------------------

  getProjectJSON() {
    return {
      ...this.manager.toJSON({ includeLoaded: true }),
      activeTileIndex: this.activeTileIndex,
      objects: this.getObjectsJSON(),
      roads: this.getRoadsJSON(),
      rivers: this.getRiversJSON(),
      terrainTexture: { ...this.terrainTexture },
    };
  }

  // ------------------------------------------------------------------
  // Blueprint library (named, reusable projects placed as map entities)
  // ------------------------------------------------------------------
  saveAsBlueprint(name) {
    const project = this.getProjectJSON();
    const meta = saveBlueprint({ name, project });
    this.emitChange();
    return meta;
  }

  loadBlueprint(id) {
    const entry = getBlueprint(id);
    if (!entry) return null;
    this.loadProjectFromJSON(entry.project);
    return entry;
  }

  deleteBlueprint(id) {
    const removed = deleteBlueprint(id);
    this.emitChange();
    return removed;
  }

  listBlueprints() {
    return listBlueprints();
  }

  // ------------------------------------------------------------------
  // Saved maps (named projects in the SQLite-backed store)
  // ------------------------------------------------------------------
  saveMap(name) {
    const project = this.getProjectJSON();
    const trimmed = String(name ?? '').trim();
    // Same name as the loaded map → overwrite it; new name → save-as (by-name
    // match or a fresh entry, handled by the library).
    const id = this.currentMapMeta && trimmed === this.currentMapMeta.name
      ? this.currentMapMeta.id
      : null;
    const meta = saveMapProject({ id, name: trimmed, project });
    this.currentMapMeta = { id: meta.id, name: meta.name };
    this.emitChange();
    return meta;
  }

  loadMap(id) {
    const entry = getMapProject(id);
    if (!entry) return null;
    this.loadProjectFromJSON(entry.project);
    this.currentMapMeta = { id: entry.id, name: entry.name };
    this.emitChange();
    return entry;
  }

  deleteMap(id) {
    const removed = deleteMapProject(id);
    if (this.currentMapMeta?.id === id) this.currentMapMeta = null;
    this.emitChange();
    return removed;
  }

  listMaps() {
    return listMapProjects();
  }

  clearTerrainVisuals() {
    for (const handle of this.chunkMeshes.values()) {
      this.chunksGroup.remove(handle.mesh);
      if (handle.edgeViz) {
        this.chunkEdgesGroup.remove(handle.edgeViz);
        disposeObject3D(handle.edgeViz);
      }
      this.disposeChunkMesh(handle.mesh);
    }
    this.chunkMeshes.clear();
  }

  clearObjects() {
    this.selectObject(null);
    for (const mesh of this.objectMeshes) {
      this.objectsGroup.remove(mesh);
      disposeObject3D(mesh);
    }
    this.objectMeshes = [];
    this.needsRender = true;
    this.emitChange();
  }

  newLevel() {
    this.loadProjectFromJSON({
      version: 1,
      chunkSize: this.manager.chunkSize,
      resolution: this.manager.resolution,
      seed: this.manager.projectMeta.seed,
      amplitude: this.manager.projectMeta.amplitude,
      octaves: this.manager.projectMeta.octaves,
      createdAt: Date.now(),
      chunks: [],
      objects: [],
      activeTileIndex: 0,
    });
    this.clearObjects();
    this.selectedChunkKeys.clear();
    this.activeTileIndex = 0;
    this.history = [];
    this.historyIndex = -1;
    this.camYaw = 0.7;
    this.camPitch = 0.6;
    this.camDistance = 68;
    this.focusChunk(0, 0);
    this.needsRender = true;
    this.emitChange();
  }

  loadProjectFromJSON(json) {
    // Any freshly loaded project is unsaved until loadMap/saveMap stamp it.
    this.currentMapMeta = null;
    this.clearTerrainVisuals();

    this.manager.loadProject(json);
    this.activeTileIndex = normalizeTileIndex(json.activeTileIndex ?? 0);

    // Global terrain texture (built-in library texture blended over the base).
    const tt = json.terrainTexture ?? {};
    this.terrainTexture = {
      id: tt.id ?? null,
      blend: typeof tt.blend === 'number' ? tt.blend : DEFAULT_TERRAIN_BLEND,
      tiling: typeof tt.tiling === 'number' ? tt.tiling : DEFAULT_TERRAIN_TILING,
    };
    this._applyTerrainTextureState();

    // Rebuild visuals for everything now in the project (authored + a starter ring)
    const authored = Array.from(this.manager.authored.values());
    for (const data of authored) {
      this.loadOrCreateChunkMesh(data.cx, data.cz);
    }

    // If very few, seed a bit more context
    if (authored.length < 5) {
      this.seedInitialChunks();
    }

    this.history = [];
    this.historyIndex = -1;
    this.loadObjectsJSON(Array.isArray(json.objects) ? json.objects : []);

    // Roads + rivers: validate via the shared schema, clear any editor drafts /
    // selection, then rebuild corridors + ribbon previews + chunk carve overlays.
    this.loadRoadsJSON(json.roads);
    this.loadRiversJSON(json.rivers);
    this.roadDraft = null;
    this.riverDraft = null;
    this.selectedRoadId = null;
    this.selectedRiverId = null;
    this.clearDraftLine('road');
    this.clearDraftLine('river');
    this.rebuildOverlays();

    this.frameAll();
    this.needsRender = true;
    this.emitChange();
  }

  // ------------------------------------------------------------------
  // Misc
  // ------------------------------------------------------------------

  emitChange() {
    const stats = this.manager.getStats();
    this.onChange({
      tool: this.tool,
      objectTransformMode: this.objectTransformMode,
      brush: { ...this.brush },
      stats,
      selection: this.getSelection(),
      confineToSelection: this.confineToSelection,
      canUndo: this.historyIndex >= 0,
      canRedo: this.historyIndex < this.history.length - 1,
      authoredCount: stats.authoredCount,
      activeTile: getTileDescriptor(this.activeTileIndex),
      selectedObject: this.selectedObject ? this.summarizeObject(this.selectedObject) : null,
      objectsCount: this.objectMeshes.length,
      objectList: this.getObjectList(),
      roadsCount: this.roads.length,
      riversCount: this.rivers.length,
      roadDrafting: !!this.roadDraft,
      riverDrafting: !!this.riverDraft,
      selectedRoadId: this.selectedRoadId,
      selectedRiverId: this.selectedRiverId,
      roadWidth: this.currentRoad()?.width ?? this.roadWidth,
      roadElevation: this.currentRoad() ? this.currentRoad().elevation : this.roadElevation,
      roadElevationMode: this.currentRoad()
        ? roadElevationMode(this.currentRoad())
        : this.roadElevationMode,
      riverWidth: this.currentRiver()?.width ?? this.riverWidth,
      riverDepth: this.currentRiver()?.depth ?? this.riverDepth,
      blueprints: listBlueprints(),
      maps: listMapProjects(),
      currentMap: this.currentMapMeta ? { ...this.currentMapMeta } : null,
      palette: TILE_PALETTE_CATALOG.map(({ index, name, use }) => ({ index, number: index + 1, name, use })),
      terrainTexture: {
        id: this.terrainTexture.id,
        hasTexture: !!this.terrainTexture.id,
        blend: this.terrainTexture.blend,
        tiling: this.terrainTexture.tiling,
        preview: terrainTextureUrl(this.terrainTexture.id),
      },
    });

    this.scheduleAutosave();
  }

  persistAutosave() {
    const json = this.getProjectJSON();
    setMapBuilderAutosave(json, { debounce: true });
    return json;
  }

  scheduleAutosave() {
    if (this._saveScheduled) return;
    this._saveScheduled = true;
    this._saveFrame = requestAnimationFrame(() => {
      this._saveScheduled = false;
      this._saveFrame = null;
      try {
        this.persistAutosave();
      } catch (_) {}
    });
  }

  flushAutosave() {
    if (this._saveFrame != null) {
      cancelAnimationFrame(this._saveFrame);
      this._saveFrame = null;
    }
    this._saveScheduled = false;
    try {
      return this.persistAutosave();
    } catch (_) {
      return null;
    }
  }

  getCurrentBrushWorldPos() {
    // Used by UI to draw a preview cursor if desired
    if (!this.pointer.inside) return null;
    return this.getWorldPointUnderPointer(this.pointer.x, this.pointer.y);
  }
}
