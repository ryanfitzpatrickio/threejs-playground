import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createCutToolState, handleCutClick, undoLastPoint, clearCutPoints, applyCut, applyCylinderCut, disposeCutVisuals, createSliceState, handleSliceClick, updateSlicePreview, clearSlice, disposeSlice, applySlice } from '../game/geometry/bodyshopCutTool.js';
import { publishBodyshopChassis } from '../game/vehicles/bodyshopChassisRegistry.js';
import { GARAGE_DEFAULT_CHASSIS_TRANSFORM } from '../game/vehicles/garageBuilds.js';
import {
  BODYSHOP_REQUIRED_LOCATOR_NAMES,
  addMissingBodyshopLocators,
  analyzeBodyshopScene,
  ensureLocatorHelpers,
  inferBodyshopForwardYawRadians,
  stripBodyshopEditorHelpers,
} from '../game/vehicles/bodyshopValidator.js';
import {
  flushBodyshopAutosave,
  readBodyshopSession,
  scheduleBodyshopAutosave,
} from '../game/vehicles/bodyshopSession.js';
import { createBodyshopVehiclePreview } from './bodyshopVehiclePreview.js';
import {
  configureBodyshopRenderer,
  installBodyshopEnvironment,
  prepareBodyshopGltfMaterials,
} from './bodyshopViewport.js';
import { ensureFileStore } from '../store/fileStore.js';

const loader = new GLTFLoader();
const exporter = new GLTFExporter();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

let nextNodeId = 1;

function generateNodeId() {
  return `node_${nextNodeId++}`;
}

function stripHelperMeshes(root) {
  stripBodyshopEditorHelpers(root);
  const toRemove = [];
  root.traverse((child) => {
    if (child.userData._builderHelper) {
      toRemove.push(child);
    }
  });
  for (const obj of toRemove) {
    obj.parent?.remove(obj);
  }
}

function exportSceneToGlb(root) {
  return new Promise((resolve, reject) => {
    stripHelperMeshes(root);
    exporter.parse(
      root,
      (result) => {
        ensureLocatorHelpers(root);
        if (result instanceof ArrayBuffer) {
          resolve(result);
          return;
        }
        reject(new Error('Expected binary GLB export.'));
      },
      (error) => {
        ensureLocatorHelpers(root);
        reject(error);
      },
      { binary: true, onlyVisible: false }
    );
  });
}

export function BodyshopScene(props) {
  let viewportRef;
  let fileInputRef;
  let importInputRef;
  let renderer = null;
  let scene = null;
  let camera = null;
  let orbitControls = null;
  let transformControls = null;
  let transformHelper = null;
  let resizeObserver = null;
  let animationFrame = 0;
  let sceneRoot = null;
  let cutState = null;
  let sliceState = null;
  let cylinderHelper = null;
  let previewHandle = null;
  let previewBlobUrl = null;
  let editPaused = false;
  let sessionRestored = false;

  const objectMap = new Map();
  const undoStack = [];
  const redoStack = [];
  let activeWires = [];
  const MAX_UNDO = 10;

  const [publishId, setPublishId] = createSignal(props.chassisId || '');
  const [publishName, setPublishName] = createSignal('');
  const [publishDescription, setPublishDescription] = createSignal('');
  const [publishDevOnly, setPublishDevOnly] = createSignal(true);
  const [locatorValidation, setLocatorValidation] = createSignal(null);
  const [selectedLocatorName, setSelectedLocatorName] = createSignal(BODYSHOP_REQUIRED_LOCATOR_NAMES[0]);
  const [nudgeStep, setNudgeStep] = createSignal(0.02);
  const [previewMode, setPreviewMode] = createSignal(false);
  const [previewSteer, setPreviewSteer] = createSignal(0);
  const [previewDoor, setPreviewDoor] = createSignal(0);
  const [status, setStatus] = createSignal('Load a GLB to begin.');
  const [busy, setBusy] = createSignal(false);
  const [undoCount, setUndoCount] = createSignal(0);
  const [redoCount, setRedoCount] = createSignal(0);

  function stripSelectionWires() {
    for (const w of activeWires) {
      w.parent?.remove(w);
      w.geometry?.dispose();
      w.material?.dispose();
    }
    activeWires = [];
    // Also sweep any orphans from the scene (e.g. from restored snapshots)
    const orphans = [];
    scene?.traverse((c) => { if (c.userData._selectionWire) orphans.push(c); });
    for (const w of orphans) {
      w.parent?.remove(w);
      w.geometry?.dispose();
      w.material?.dispose();
    }
  }

  function snapshotScene() {
    if (!sceneRoot) return;
    // Clean selection wireframes before cloning so they don't get baked in
    stripSelectionWires();
    const snapshot = [];
    for (const child of sceneRoot.children) {
      if (child.userData._builderHelper) continue;
      snapshot.push(child.clone(true));
    }
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    setUndoCount(undoStack.length);
    setRedoCount(0);
    queueAutosave();
  }

  function restoreSnapshot(snapshot) {
    if (!sceneRoot) return;
    // Remove all non-helper children
    const toRemove = [];
    for (const child of sceneRoot.children) {
      if (!child.userData._builderHelper) toRemove.push(child);
    }
    for (const child of toRemove) sceneRoot.remove(child);

    // Add snapshot children
    for (const child of snapshot) {
      sceneRoot.add(child.clone(true));
    }

    // Clean any stale selection wires from cloned snapshot
    stripSelectionWires();
    prepareBodyshopGltfMaterials(sceneRoot);

    clearSelection();
    syncHierarchy();
  }

  function undo() {
    if (undoStack.length === 0) return;
    // Strip wires before cloning so they don't get baked into redo stack
    stripSelectionWires();
    const current = [];
    for (const child of sceneRoot.children) {
      if (child.userData._builderHelper) continue;
      current.push(child.clone(true));
    }
    redoStack.push(current);

    const snapshot = undoStack.pop();
    restoreSnapshot(snapshot);
    setUndoCount(undoStack.length);
    setRedoCount(redoStack.length);
    setStatus('Undo.');
  }

  function redo() {
    if (redoStack.length === 0) return;
    // Strip wires before cloning so they don't get baked into undo stack
    stripSelectionWires();
    const current = [];
    for (const child of sceneRoot.children) {
      if (child.userData._builderHelper) continue;
      current.push(child.clone(true));
    }
    undoStack.push(current);

    const snapshot = redoStack.pop();
    restoreSnapshot(snapshot);
    setUndoCount(undoStack.length);
    setRedoCount(redoStack.length);
    setStatus('Redo.');
  }
  const [mode, setMode] = createSignal('select');
  const [sceneItems, setSceneItems] = createSignal([]);
  const [selectedIds, setSelectedIds] = createSignal([]);
  const [renamingId, setRenamingId] = createSignal(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [selectedTransform, setSelectedTransform] = createSignal(null);

  function syncHierarchy() {
    const items = [];
    objectMap.clear();

    if (!sceneRoot) {
      setSceneItems([]);
      return;
    }

    sceneRoot.traverse((child) => {
      if (child === sceneRoot) return;
      if (child.userData._builderHelper) return;
      if (!child.isMesh && !child.isGroup) return;
      if (child.isMesh && child.parent?.isMesh) return;

      let id = child.userData._builderId;
      if (!id || objectMap.has(id)) {
        // No ID or duplicate (from clone) — assign a fresh unique one
        id = generateNodeId();
        child.userData._builderId = id;
      }

      objectMap.set(id, child);
      items.push({
        id,
        name: child.name || (child.isMesh ? 'mesh' : 'group'),
        visible: child.visible,
        type: child.isMesh ? 'mesh' : 'group',
        depth: getDepth(child)
      });
    });

    setSceneItems(items);

    // Prune selectedIds that no longer exist in the scene
    const currentIds = selectedIds();
    if (currentIds.length > 0) {
      const validIds = currentIds.filter((id) => objectMap.has(id));
      if (validIds.length !== currentIds.length) {
        setSelectedIds(validIds);
        highlightSelected();
      }
    }

    updateValidation();
  }

  function getDepth(obj) {
    let depth = 0;
    let current = obj.parent;
    while (current && current !== sceneRoot) {
      depth++;
      current = current.parent;
    }
    return depth;
  }

  function autosaveMeta() {
    return {
      publishId: publishId(),
      publishName: publishName(),
      publishDescription: publishDescription(),
      publishDevOnly: publishDevOnly(),
    };
  }

  function queueAutosave({ includeGlb = true } = {}) {
    scheduleBodyshopAutosave({
      meta: autosaveMeta(),
      exportGlb: includeGlb && sceneRoot && sceneItems().length > 0
        ? () => exportSceneToGlb(sceneRoot)
        : null,
      onStatus: (message) => {
        if (message?.startsWith('Autosaving')) return;
        if (message === 'Draft saved.') return;
        setStatus(message);
      },
    });
  }

  async function restoreBodyshopSession() {
    if (sessionRestored || !sceneRoot) return;
    sessionRestored = true;
    await ensureFileStore();
    const session = readBodyshopSession();
    if (!session) return;

    if (session.publishId) setPublishId(session.publishId);
    if (session.publishName) setPublishName(session.publishName);
    if (session.publishDescription) setPublishDescription(session.publishDescription);
    if (typeof session.publishDevOnly === 'boolean') setPublishDevOnly(session.publishDevOnly);

    if (!session.hasDraft || !session.draftUrl) return;

    try {
      setBusy(true);
      const gltf = await loader.loadAsync(`${session.draftUrl}?v=${session.updatedAt || 0}`);
      sceneRoot.clear();
      const model = gltf.scene;
      sceneRoot.add(model);
      prepareBodyshopGltfMaterials(model);

      syncHierarchy();
      frameCamera();
      setStatus('Restored bodyshop draft.');
    } catch (error) {
      setStatus(`Could not restore draft: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function exitVehiclePreview() {
    previewHandle?.dispose();
    previewHandle = null;
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      previewBlobUrl = null;
    }
    editPaused = false;
    if (renderer?.domElement && viewportRef) {
      viewportRef.replaceChildren(renderer.domElement);
    }
    setPreviewMode(false);
    setPreviewSteer(0);
    setPreviewDoor(0);
  }

  async function enterVehiclePreview() {
    if (!sceneRoot || sceneItems().length === 0) {
      setStatus('Load or build a body before previewing.');
      return;
    }

    setBusy(true);
    setStatus('Building vehicle preview...');
    try {
      const buffer = await exportSceneToGlb(sceneRoot);
      previewBlobUrl = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
      if (renderer?.domElement) renderer.domElement.remove();
      editPaused = true;
      previewHandle = await createBodyshopVehiclePreview({
        container: viewportRef,
        glbUrl: previewBlobUrl,
        chassisId: publishId().trim() || 'bodyshop-preview',
      });
      previewHandle.setSteer(previewSteer());
      previewHandle.setDoorOpen(previewDoor());
      setPreviewMode(true);
      setStatus('Vehicle preview — steer/door sliders exercise runtime rigs.');
    } catch (error) {
      editPaused = false;
      if (renderer?.domElement && viewportRef) viewportRef.append(renderer.domElement);
      setStatus(`Preview failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleVehiclePreview() {
    if (previewMode()) await exitVehiclePreview();
    else await enterVehiclePreview();
  }

  onMount(() => {
    props.onReady?.({
      flushAutosave: () => flushBodyshopAutosave({
        meta: autosaveMeta(),
        exportGlb: sceneRoot && sceneItems().length > 0
          ? () => exportSceneToGlb(sceneRoot)
          : null,
      }),
    });
  });

  createEffect(() => {
    publishId();
    publishName();
    publishDescription();
    publishDevOnly();
    queueAutosave({ includeGlb: false });
  });

  createEffect(() => {
    const steer = previewSteer();
    const door = previewDoor();
    if (!previewHandle) return;
    previewHandle.setSteer(steer);
    previewHandle.setDoorOpen(door);
  });

  function updateValidation() {
    if (!sceneRoot) {
      setLocatorValidation(null);
      return;
    }
    ensureLocatorHelpers(sceneRoot);
    setLocatorValidation(analyzeBodyshopScene(sceneRoot));
  }

  function getSelectedLocator() {
    if (!sceneRoot) return null;
    return sceneRoot.getObjectByName(selectedLocatorName()) || null;
  }

  function selectLocator(locatorName) {
    setSelectedLocatorName(locatorName);
    if (mode() === 'locator') {
      attachLocatorTransform(locatorName);
    }
  }

  function attachLocatorTransform(locatorName = selectedLocatorName()) {
    if (!camera || !renderer?.domElement || !scene || !sceneRoot) return;
    const locator = sceneRoot.getObjectByName(locatorName);
    detachTransform();
    if (!locator) return;

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('local');
    transformControls.size = 0.9;
    transformControls.addEventListener('dragging-changed', (event) => {
      orbitControls.enabled = !event.value;
    });
    transformControls.addEventListener('objectChange', () => {
      updateValidation();
      queueAutosave();
    });
    transformHelper = transformControls.getHelper();
    scene.add(transformHelper);
    transformControls.attach(locator);
  }

  function handleAddMissingLocators() {
    if (!sceneRoot) return;
    snapshotScene();
    const added = addMissingBodyshopLocators(sceneRoot);
    syncHierarchy();
    if (added.length > 0) {
      selectLocator(added[0].name);
      setStatus(`Added ${added.length} locator(s).`);
    } else {
      setStatus('All required locators are already present.');
    }
  }

  function nudgeLocator(axis, delta) {
    const locator = getSelectedLocator();
    if (!locator) return;
    snapshotScene();
    locator.position[axis] += delta;
    locator.updateMatrixWorld(true);
    updateValidation();
    queueAutosave();
  }

  function rotateBodyYaw(degrees) {
    if (!sceneRoot) return;
    snapshotScene();
    sceneRoot.rotation.y += THREE.MathUtils.degToRad(degrees);
    sceneRoot.updateMatrixWorld(true);
    frameCamera();
    setStatus(`Rotated body ${degrees > 0 ? '+' : ''}${degrees}°.`);
  }

  function alignBodyForward() {
    if (!sceneRoot) return;
    snapshotScene();
    const yaw = inferBodyshopForwardYawRadians(sceneRoot);
    sceneRoot.rotation.y += yaw;
    sceneRoot.updateMatrixWorld(true);
    frameCamera();
    setStatus('Aligned body forward axis to +Z.');
  }

  function refreshSelectedTransform() {
    const ids = selectedIds();
    if (ids.length !== 1) {
      setSelectedTransform(null);
      return;
    }

    const id = ids[0];
    const obj = objectMap.get(id);
    if (!obj) {
      setSelectedTransform(null);
      return;
    }

    setSelectedTransform({
      px: obj.position.x.toFixed(4),
      py: obj.position.y.toFixed(4),
      pz: obj.position.z.toFixed(4),
      rx: THREE.MathUtils.radToDeg(obj.rotation.x).toFixed(1),
      ry: THREE.MathUtils.radToDeg(obj.rotation.y).toFixed(1),
      rz: THREE.MathUtils.radToDeg(obj.rotation.z).toFixed(1),
      sx: obj.scale.x.toFixed(4),
      sy: obj.scale.y.toFixed(4),
      sz: obj.scale.z.toFixed(4)
    });
  }

  function getSelectedObject() {
    const ids = selectedIds();
    if (ids.length !== 1) return null;
    return objectMap.get(ids[0]) || null;
  }

  function selectObject(id, additive = false) {
    if (additive) {
      setSelectedIds((prev) => {
        if (prev.includes(id)) {
          return prev.filter((x) => x !== id);
        }
        return [...prev, id];
      });
    } else {
      setSelectedIds([id]);
    }
    refreshSelectedTransform();
    attachTransformToSelected();
  }

  function clearSelection() {
    setSelectedIds([]);
    setSelectedTransform(null);
    detachTransform();
    highlightSelected();
  }

  function attachTransformToSelected() {
    const currentMode = mode();
    if (currentMode === 'locator') {
      attachLocatorTransform();
      highlightSelected();
      return;
    }
    if (currentMode === 'select' || currentMode === 'cut' || currentMode === 'slice' || currentMode === 'cylinder') {
      detachTransform();
      highlightSelected();
      return;
    }

    const obj = getSelectedObject();
    if (!obj || !camera || !renderer?.domElement || !scene) {
      detachTransform();
      return;
    }

    // Only pass valid TransformControls modes
    const gizmoMode = (currentMode === 'translate' || currentMode === 'rotate' || currentMode === 'scale')
      ? currentMode : 'translate';

    if (transformHelper) {
      scene.remove(transformHelper);
      transformHelper = null;
    }
    if (transformControls) {
      transformControls.detach();
      transformControls.dispose?.();
      transformControls = null;
    }

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode(gizmoMode);
    transformControls.setSpace('local');
    transformControls.size = 0.9;
    transformControls.addEventListener('dragging-changed', (event) => {
      orbitControls.enabled = !event.value;
    });
    transformControls.addEventListener('objectChange', () => {
      refreshSelectedTransform();
    });
    transformHelper = transformControls.getHelper();
    scene.add(transformHelper);
    transformControls.attach(obj);
    highlightSelected();
  }

  function detachTransform() {
    if (transformHelper) {
      scene?.remove(transformHelper);
      transformHelper = null;
    }
    if (transformControls) {
      transformControls.detach();
      transformControls.dispose?.();
      transformControls = null;
    }
  }

  function highlightSelected() {
    if (!sceneRoot) return;

    // Remove old highlight wireframes directly from tracked array
    for (const w of activeWires) {
      w.parent?.remove(w);
      w.geometry?.dispose();
      w.material?.dispose();
    }
    activeWires = [];

    // Safety sweep: catch any orphaned wires not in activeWires
    if (scene) {
      const orphans = [];
      scene.traverse((c) => { if (c.userData._selectionWire) orphans.push(c); });
      for (const w of orphans) {
        w.parent?.remove(w);
        w.geometry?.dispose();
        w.material?.dispose();
      }
    }

    const ids = selectedIds();
    for (const id of ids) {
      const obj = objectMap.get(id);
      if (!obj) continue;

      const meshes = [];
      if (obj.isMesh) {
        meshes.push(obj);
      } else {
        obj.traverse((c) => {
          if (c.isMesh && !c.userData._builderHelper) meshes.push(c);
        });
      }

      for (const mesh of meshes) {
        const wire = new THREE.LineSegments(
          new THREE.WireframeGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.35, depthTest: true })
        );
        wire.userData._builderHelper = true;
        wire.userData._selectionWire = true;
        wire.renderOrder = 900;
        mesh.add(wire);
        activeWires.push(wire);
      }
    }
  }

  function frameCamera() {
    if (!sceneRoot || !camera || !orbitControls) return;

    sceneRoot.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(sceneRoot);
    if (bounds.isEmpty()) return;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 1) * 0.5;

    orbitControls.target.copy(center);
    camera.position.copy(center.clone().add(new THREE.Vector3(radius * 1.9, radius * 0.95, radius * 1.9)));
    camera.near = 0.05;
    camera.far = Math.max(200, radius * 40);
    camera.updateProjectionMatrix();
    orbitControls.update();
  }

  async function loadGlb(file) {
    snapshotScene();
    setBusy(true);
    setStatus(`Loading ${file.name}...`);

    try {
      const buffer = await fileToArrayBuffer(file);
      const url = URL.createObjectURL(new Blob([buffer]));
      const gltf = await loader.loadAsync(url);
      URL.revokeObjectURL(url);

      if (sceneRoot) {
        sceneRoot.clear();
      }

      const model = gltf.scene;
      sceneRoot.add(model);
      prepareBodyshopGltfMaterials(model);

      syncHierarchy();
      frameCamera();
      setStatus(`Loaded ${file.name}`);
      queueAutosave();
    } catch (error) {
      setStatus(`Failed to load: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function importGlb(file) {
    snapshotScene();
    setBusy(true);
    setStatus(`Importing ${file.name}...`);

    try {
      const buffer = await fileToArrayBuffer(file);
      const url = URL.createObjectURL(new Blob([buffer]));
      const gltf = await loader.loadAsync(url);
      URL.revokeObjectURL(url);

      const model = gltf.scene;
      model.name = file.name.replace(/\.glb$/i, '');
      prepareBodyshopGltfMaterials(model);

      sceneRoot.add(model);
      syncHierarchy();

      const id = model.userData._builderId;
      if (id) {
        selectObject(id);
      }

      setStatus(`Imported ${file.name}`);
      queueAutosave();
    } catch (error) {
      setStatus(`Failed to import: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function publishToGarage() {
    if (!sceneRoot || sceneItems().length === 0) {
      setStatus('Load or build a body before publishing.');
      return;
    }

    const id = publishId().trim();
    if (!id) {
      setStatus('Enter a chassis id (letters, numbers, dashes).');
      return;
    }

    const report = locatorValidation();
    if (report && !report.approved) {
      const proceed = window.confirm(
        'Validation is incomplete (locators, door, or steering mesh missing). Publish anyway?',
      );
      if (!proceed) return;
    }

    setBusy(true);
    setStatus('Publishing to garage...');

    try {
      const buffer = await exportSceneToGlb(sceneRoot);
      const entry = await publishBodyshopChassis({
        id,
        name: publishName().trim() || id,
        description: publishDescription().trim() || 'Authored in Bodyshop.',
        glbBytes: buffer,
        defaultTransform: GARAGE_DEFAULT_CHASSIS_TRANSFORM,
        devOnly: publishDevOnly(),
      });
      props.onPublished?.(entry);
      setStatus(`Published ${entry.name} — available in Garage.`);
      queueAutosave({ includeGlb: false });
    } catch (error) {
      setStatus(`Publish failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportGlb() {
    if (!sceneRoot) return;
    setBusy(true);
    setStatus('Exporting GLB...');

    try {
      const buffer = await exportSceneToGlb(sceneRoot);
      const blob = new Blob([buffer], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'car-build.glb';
      link.click();
      URL.revokeObjectURL(url);
      setStatus('Exported car-build.glb');
    } catch (error) {
      setStatus(`Export failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleVisibility(id) {
    const obj = objectMap.get(id);
    if (!obj) return;
    obj.visible = !obj.visible;
    syncHierarchy();
  }

  function deleteSelected() {
    snapshotScene();
    const ids = selectedIds();
    for (const id of ids) {
      const obj = objectMap.get(id);
      if (obj) {
        obj.parent?.remove(obj);
      }
    }
    clearSelection();
    syncHierarchy();
    setStatus(`Deleted ${ids.length} object(s).`);
  }

  function startRename(id) {
    const item = sceneItems().find((i) => i.id === id);
    if (!item) return;
    setRenamingId(id);
    setRenameValue(item.name);
  }

  function applyRename() {
    const id = renamingId();
    if (!id) return;
    snapshotScene();
    const obj = objectMap.get(id);
    if (obj) {
      obj.name = renameValue();
    }
    setRenamingId(null);
    syncHierarchy();
  }

  function joinSelected() {
    const ids = selectedIds();
    if (ids.length < 2) {
      setStatus('Select at least 2 meshes to join.');
      return;
    }

    snapshotScene();

    const meshes = [];
    for (const id of ids) {
      const obj = objectMap.get(id);
      if (!obj) continue;
      if (obj.isMesh) {
        meshes.push(obj);
      } else {
        obj.traverse((c) => {
          if (c.isMesh && !c.userData._builderHelper) meshes.push(c);
        });
      }
    }

    if (meshes.length < 2) {
      setStatus('Need at least 2 meshes to join.');
      return;
    }

    const materialBuckets = new Map();
    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true);
      const key = mesh.material.uuid;
      if (!materialBuckets.has(key)) {
        materialBuckets.set(key, { material: mesh.material, geometries: [] });
      }
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      materialBuckets.get(key).geometries.push(geo);
    }

    const parent = meshes[0].parent || sceneRoot;

    for (const mesh of meshes) {
      mesh.parent?.remove(mesh);
    }

    for (const bucket of materialBuckets.values()) {
      const merged = mergeGeometries(bucket.geometries, false);
      for (const geo of bucket.geometries) geo.dispose();
      if (!merged) continue;

      const inverseParent = new THREE.Matrix4();
      inverseParent.copy(parent.matrixWorld).invert();
      merged.applyMatrix4(inverseParent);

      const joinedMesh = new THREE.Mesh(merged, bucket.material);
      joinedMesh.name = 'joined';
      parent.add(joinedMesh);
    }

    clearSelection();
    syncHierarchy();
    setStatus(`Joined ${meshes.length} meshes.`);
  }

  function updateTransformProperty(axis, component, value) {
    const obj = getSelectedObject();
    if (!obj) return;
    const num = Number(value);
    if (Number.isNaN(num)) return;

    if (component === 'position') {
      obj.position[axis] = num;
    } else if (component === 'rotation') {
      obj.rotation[axis] = THREE.MathUtils.degToRad(num);
    } else if (component === 'scale') {
      obj.scale[axis] = num;
    }

    obj.updateMatrixWorld(true);
    refreshSelectedTransform();
  }

  function raycastSceneMeshes() {
    const meshes = [];
    sceneRoot.traverse((child) => {
      if (child.isMesh && child.visible && !child.userData._builderHelper) {
        meshes.push(child);
      }
    });
    return raycaster.intersectObjects(meshes, false);
  }

  function handleViewportClick(event) {
    if (!renderer || !camera || !sceneRoot) return;

    const currentMode = mode();
    if (currentMode === 'cylinder') return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const intersections = raycastSceneMeshes();

    if (currentMode === 'cut') {
      if (intersections.length > 0 && cutState) {
        const hit = intersections[0];
        const result = handleCutClick(cutState, hit);
        if (result.closed) {
          setStatus('Boundary closed. Click "Apply Cut" to split.');
        } else {
          setStatus(`Cut point ${result.pointCount} placed.`);
        }
      }
      return;
    }

    if (currentMode === 'slice') {
      if (intersections.length > 0 && sliceState) {
        handleSliceViewportClick(intersections[0]);
      }
      return;
    }

    if (intersections.length > 0) {
      const hit = intersections[0].object;
      let target = hit;
      while (target.parent && target.parent !== sceneRoot) {
        if (target.userData._builderId) break;
        target = target.parent;
      }

      const id = target.userData._builderId;
      if (id) {
        selectObject(id, event.shiftKey);
      }
    } else {
      clearSelection();
    }
  }

  function handleViewportMouseMove(event) {
    if (mode() === 'slice') {
      handleSliceViewportMove(event);
    }
  }

  function setToolMode(newMode) {
    // Clean up previous mode
    detachTransform();
    stripSelectionWires();
    if (cutState) { disposeCutVisuals(cutState); cutState = null; }
    if (sliceState) { disposeSlice(sliceState); sliceState = null; setSliceReady(false); setSliceFlip(false); }
    if (newMode !== 'cylinder') { removeCylinder(); removeWheelAlignment(); }

    setMode(newMode);

    if (newMode === 'locator') {
      attachLocatorTransform();
      setStatus('Select a locator chip, then drag the gizmo or nudge with the panel.');
      return;
    }

    if (newMode === 'cut') {
      cutState = createCutToolState(scene);
      setStatus('Click on mesh to place cut boundary points.');
    } else if (newMode === 'slice') {
      sliceState = createSliceState(scene);
      setStatus('Click first point on mesh to start slice line.');
    } else if (newMode === 'cylinder') {
      spawnCylinder();
      return; // spawnCylinder sets up its own transform controls
    }

    attachTransformToSelected();
  }

  function handleApplyCut() {
    if (!cutState || !cutState.closed) {
      setStatus('Close the boundary first by clicking the first point.');
      return;
    }

    const obj = getSelectedObject();
    let targetMesh = null;

    if (obj?.isMesh) {
      targetMesh = obj;
    } else if (obj) {
      obj.traverse((c) => {
        if (c.isMesh && !targetMesh && !c.userData._builderHelper) {
          targetMesh = c;
        }
      });
    }

    if (!targetMesh && cutState.targetMesh) {
      targetMesh = cutState.targetMesh;
    }

    if (!targetMesh) {
      setStatus('Select a mesh to cut.');
      return;
    }

    snapshotScene();
    setBusy(true);
    setStatus('Applying cut...');

    try {
      const result = applyCut(cutState, targetMesh, camera);

      const parent = targetMesh.parent || sceneRoot;
      const material = targetMesh.material;

      // Compute world transform so we can re-add at sceneRoot level
      targetMesh.updateMatrixWorld(true);
      const worldMatrix = targetMesh.matrixWorld.clone();

      parent.remove(targetMesh);

      // Decompose world transform for top-level placement
      const wPos = new THREE.Vector3();
      const wQuat = new THREE.Quaternion();
      const wScl = new THREE.Vector3();
      worldMatrix.decompose(wPos, wQuat, wScl);
      const wRot = new THREE.Euler().setFromQuaternion(wQuat);

      const bodyMesh = new THREE.Mesh(result.body, material.clone());
      bodyMesh.name = targetMesh.name || 'body';
      bodyMesh.material.side = THREE.DoubleSide;
      bodyMesh.position.copy(wPos);
      bodyMesh.rotation.copy(wRot);
      bodyMesh.scale.copy(wScl);
      sceneRoot.add(bodyMesh);

      const cutoutMesh = new THREE.Mesh(result.cutout, material.clone());
      cutoutMesh.name = 'cutout';
      cutoutMesh.material.side = THREE.DoubleSide;
      cutoutMesh.position.copy(wPos);
      cutoutMesh.rotation.copy(wRot);
      cutoutMesh.scale.copy(wScl);
      sceneRoot.add(cutoutMesh);

      disposeCutVisuals(cutState);
      cutState = createCutToolState(scene);

      clearSelection();
      syncHierarchy();
      setStatus('Cut applied. Rename the cutout piece (e.g. "window", "door").');
    } catch (error) {
      setStatus(`Cut failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function handleUndoCutPoint() {
    if (cutState) {
      undoLastPoint(cutState);
      setStatus(`Point removed. ${cutState.points.length} points remaining.`);
    }
  }

  function handleClearCut() {
    if (cutState) {
      clearCutPoints(cutState);
      setStatus('Cut points cleared.');
    }
  }

  // --- Slice tool ---
  const [sliceReady, setSliceReady] = createSignal(false);
  const [sliceFlip, setSliceFlip] = createSignal(false);

  function handleSliceViewportClick(intersection) {
    if (!sliceState) return;
    const result = handleSliceClick(sliceState, intersection);
    if (result.ready) {
      setSliceReady(true);
      setStatus('Slice line set. Click "Apply Slice" to remove one side, or "Flip Side" to switch.');
    } else {
      setStatus('Click second point to complete the slice line.');
    }
  }

  function handleSliceViewportMove(event) {
    if (!sliceState || !sliceState.pointA || sliceState.pointB) return;
    if (!renderer || !camera || !sceneRoot) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    const meshes = [];
    sceneRoot.traverse((child) => {
      if (child.isMesh && child.visible && !child.userData._builderHelper) {
        meshes.push(child);
      }
    });

    const intersections = raycaster.intersectObjects(meshes, false);
    if (intersections.length > 0) {
      updateSlicePreview(sliceState, intersections[0].point);
    }
  }

  function handleApplySlice() {
    if (!sliceState || !sliceState.pointA || !sliceState.pointB) {
      setStatus('Place two points first.');
      return;
    }

    let targetMesh = null;
    const obj = getSelectedObject();
    if (obj?.isMesh && !obj.userData._builderHelper) {
      targetMesh = obj;
    } else if (sliceState.targetMesh) {
      targetMesh = sliceState.targetMesh;
    }

    if (!targetMesh) {
      setStatus('No mesh to slice.');
      return;
    }

    snapshotScene();
    setBusy(true);
    setStatus('Applying slice...');

    try {
      sliceState.flipSide = sliceFlip();
      const resultGeo = applySlice(sliceState, targetMesh, camera);

      const parent = targetMesh.parent || sceneRoot;
      const material = targetMesh.material;

      targetMesh.updateMatrixWorld(true);
      const worldMatrix = targetMesh.matrixWorld.clone();
      parent.remove(targetMesh);

      const wPos = new THREE.Vector3();
      const wQuat = new THREE.Quaternion();
      const wScl = new THREE.Vector3();
      worldMatrix.decompose(wPos, wQuat, wScl);
      const wRot = new THREE.Euler().setFromQuaternion(wQuat);

      const resultMesh = new THREE.Mesh(resultGeo, material.clone());
      resultMesh.name = targetMesh.name || 'sliced';
      resultMesh.material.side = THREE.DoubleSide;
      resultMesh.position.copy(wPos);
      resultMesh.rotation.copy(wRot);
      resultMesh.scale.copy(wScl);
      sceneRoot.add(resultMesh);

      clearSlice(sliceState);
      setSliceReady(false);
      setSliceFlip(false);
      clearSelection();
      syncHierarchy();
      setStatus('Slice applied. Removed side is gone, cut edge is capped.');
    } catch (error) {
      setStatus(`Slice failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function handleFlipSlice() {
    setSliceFlip(!sliceFlip());
  }

  function handleClearSlice() {
    if (sliceState) {
      clearSlice(sliceState);
      setSliceReady(false);
      setSliceFlip(false);
      setStatus('Slice cleared. Click to place first point.');
    }
  }

  // --- Cylinder cutter ---
  const [cylinderTransform, setCylinderTransform] = createSignal(null);

  function spawnCylinder() {
    removeCylinder();

    const geo = new THREE.CylinderGeometry(0.35, 0.35, 0.25, 32, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x44aaff,
      wireframe: true,
      transparent: true,
      opacity: 0.6,
      depthTest: true
    });
    cylinderHelper = new THREE.Mesh(geo, mat);
    cylinderHelper.name = '__cylinder_cutter__';
    cylinderHelper.userData._builderHelper = true;
    cylinderHelper.userData._builderId = generateNodeId();

    // Default transform tuned for typical car wheel wells
    cylinderHelper.rotation.set(0, THREE.MathUtils.degToRad(90), THREE.MathUtils.degToRad(90));
    cylinderHelper.scale.set(0.23, 0.30, 0.23);

    // Position at scene center as starting point
    if (sceneRoot) {
      sceneRoot.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(sceneRoot);
      if (!bounds.isEmpty()) {
        const center = bounds.getCenter(new THREE.Vector3());
        cylinderHelper.position.copy(center);
      }
    }

    scene.add(cylinderHelper);
    refreshCylinderTransform();

    // Select and attach gizmo to cylinder
    if (transformHelper) {
      scene.remove(transformHelper);
      transformHelper = null;
    }
    if (transformControls) {
      transformControls.detach();
      transformControls.dispose?.();
      transformControls = null;
    }

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('local');
    transformControls.size = 0.9;
    transformControls.addEventListener('dragging-changed', (event) => {
      orbitControls.enabled = !event.value;
    });
    transformControls.addEventListener('objectChange', () => {
      refreshCylinderTransform();
    });
    transformHelper = transformControls.getHelper();
    scene.add(transformHelper);
    transformControls.attach(cylinderHelper);

    setStatus('Position the cylinder over a wheel, then Apply Cylinder Cut.');
  }

  function removeCylinder() {
    if (cylinderHelper) {
      scene?.remove(cylinderHelper);
      cylinderHelper.geometry?.dispose();
      cylinderHelper.material?.dispose();
      cylinderHelper = null;
    }
    setCylinderTransform(null);
  }

  function refreshCylinderTransform() {
    if (!cylinderHelper) {
      setCylinderTransform(null);
      return;
    }
    setCylinderTransform({
      px: cylinderHelper.position.x.toFixed(4),
      py: cylinderHelper.position.y.toFixed(4),
      pz: cylinderHelper.position.z.toFixed(4),
      rx: THREE.MathUtils.radToDeg(cylinderHelper.rotation.x).toFixed(1),
      ry: THREE.MathUtils.radToDeg(cylinderHelper.rotation.y).toFixed(1),
      rz: THREE.MathUtils.radToDeg(cylinderHelper.rotation.z).toFixed(1),
      sx: cylinderHelper.scale.x.toFixed(4),
      sy: cylinderHelper.scale.y.toFixed(4),
      sz: cylinderHelper.scale.z.toFixed(4)
    });
  }

  function updateCylinderProperty(axis, component, value) {
    if (!cylinderHelper) return;
    const num = Number(value);
    if (Number.isNaN(num)) return;

    if (component === 'position') {
      cylinderHelper.position[axis] = num;
    } else if (component === 'rotation') {
      cylinderHelper.rotation[axis] = THREE.MathUtils.degToRad(num);
    } else if (component === 'scale') {
      cylinderHelper.scale[axis] = num;
    }

    cylinderHelper.updateMatrixWorld(true);
    refreshCylinderTransform();
  }

  function setCylinderGizmoMode(gizmoMode) {
    if (transformControls && cylinderHelper) {
      transformControls.setMode(gizmoMode);
    }
  }

  function handleApplyCylinderCut() {
    if (!cylinderHelper || !sceneRoot) {
      setStatus('Spawn a cylinder first.');
      return;
    }

    // Find the target mesh: use selected, or find nearest mesh
    const obj = getSelectedObject();
    let targetMesh = null;

    if (obj?.isMesh && !obj.userData._builderHelper) {
      targetMesh = obj;
    } else {
      // Find all non-helper meshes
      const candidates = [];
      sceneRoot.traverse((c) => {
        if (c.isMesh && !c.userData._builderHelper && c.visible) {
          candidates.push(c);
        }
      });
      if (candidates.length === 1) {
        targetMesh = candidates[0];
      } else if (candidates.length > 1) {
        setStatus('Select which mesh to cut (multiple meshes in scene).');
        return;
      }
    }

    if (!targetMesh) {
      setStatus('No mesh to cut. Select a mesh first.');
      return;
    }

    snapshotScene();
    setBusy(true);
    setStatus('Applying cylinder cut...');

    try {
      const result = applyCylinderCut(cylinderHelper, targetMesh);

      const parent = targetMesh.parent || sceneRoot;
      const material = targetMesh.material;

      targetMesh.updateMatrixWorld(true);
      const worldMatrix = targetMesh.matrixWorld.clone();
      parent.remove(targetMesh);

      const wPos = new THREE.Vector3();
      const wQuat = new THREE.Quaternion();
      const wScl = new THREE.Vector3();
      worldMatrix.decompose(wPos, wQuat, wScl);
      const wRot = new THREE.Euler().setFromQuaternion(wQuat);

      const bodyMesh = new THREE.Mesh(result.body, material.clone());
      bodyMesh.name = targetMesh.name || 'body';
      bodyMesh.material.side = THREE.DoubleSide;
      bodyMesh.position.copy(wPos);
      bodyMesh.rotation.copy(wRot);
      bodyMesh.scale.copy(wScl);
      sceneRoot.add(bodyMesh);

      const cutoutMesh = new THREE.Mesh(result.cutout, material.clone());
      cutoutMesh.name = 'wheel-cutout';
      cutoutMesh.material.side = THREE.DoubleSide;
      cutoutMesh.position.copy(wPos);
      cutoutMesh.rotation.copy(wRot);
      cutoutMesh.scale.copy(wScl);
      sceneRoot.add(cutoutMesh);

      // Don't remove cylinder - user likely wants to reposition for next wheel
      clearSelection();
      syncHierarchy();
      setStatus('Cylinder cut applied. Reposition cylinder for next wheel or remove it.');
    } catch (error) {
      setStatus(`Cylinder cut failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  // --- 4-Wheel alignment ---
  const WHEEL_NAMES = ['front-left', 'front-right', 'rear-left', 'rear-right'];
  const WHEEL_COLORS = [0x44aaff, 0x44ffaa, 0xffaa44, 0xff44aa];
  let wheelCylinders = [null, null, null, null];
  let wheelAlignRect = null;

  const [wheelAlignActive, setWheelAlignActive] = createSignal(false);
  const [wheelWidth, setWheelWidth] = createSignal(1.5);
  const [wheelLength, setWheelLength] = createSignal(2.6);
  const [activeWheelIndex, setActiveWheelIndex] = createSignal(0);

  function createWheelCylinder(color) {
    const geo = new THREE.CylinderGeometry(0.35, 0.35, 0.25, 32, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.6,
      depthTest: true
    });
    const cyl = new THREE.Mesh(geo, mat);
    cyl.userData._builderHelper = true;
    return cyl;
  }

  function createAlignRect() {
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.4,
      depthTest: false
    });
    const line = new THREE.LineLoop(geo, mat);
    line.userData._builderHelper = true;
    line.renderOrder = 997;
    return line;
  }

  function updateAlignRectGeometry() {
    if (!wheelAlignRect) return;
    const positions = [];
    for (const cyl of wheelCylinders) {
      if (!cyl) return;
      positions.push(cyl.position.x, cyl.position.y, cyl.position.z);
    }
    // Order: FL, FR, RR, RL (loop)
    const fl = wheelCylinders[0].position;
    const fr = wheelCylinders[1].position;
    const rl = wheelCylinders[2].position;
    const rr = wheelCylinders[3].position;
    const verts = new Float32Array([
      fl.x, fl.y, fl.z,
      fr.x, fr.y, fr.z,
      rr.x, rr.y, rr.z,
      rl.x, rl.y, rl.z
    ]);
    wheelAlignRect.geometry.dispose();
    wheelAlignRect.geometry = new THREE.BufferGeometry();
    wheelAlignRect.geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  }

  function spawnWheelAlignment() {
    if (!cylinderHelper) {
      setStatus('Position the primary cylinder on a tire first.');
      return;
    }

    removeWheelAlignment();

    // Use the current cylinder as the front-left reference
    const refPos = cylinderHelper.position.clone();
    const refRot = cylinderHelper.rotation.clone();
    const refScale = cylinderHelper.scale.clone();

    // Use the car bounding box to figure out the car's center and long axis
    sceneRoot.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(sceneRoot);
    const carCenter = bounds.getCenter(new THREE.Vector3());
    const carSize = bounds.getSize(new THREE.Vector3());

    // Determine which horizontal axis is the car's length (longer) vs width (shorter)
    // Cars are longer than wide, so the long axis = forward/back
    const xSpan = carSize.x;
    const zSpan = carSize.z;
    const carLongAxisIsZ = zSpan >= xSpan;

    // The "width axis" is the shorter one (side-to-side)
    // The "length axis" is the longer one (front-to-back)
    // FR = mirror the FL across the car center on the width axis
    // RL = offset along the length axis toward the rear
    // RR = both

    const w = wheelWidth();
    const l = wheelLength();

    // Compute FR position: mirror FL across car center on the width axis
    const frPos = refPos.clone();
    if (carLongAxisIsZ) {
      // Width is X axis: mirror X around car center
      frPos.x = carCenter.x + (carCenter.x - refPos.x);
    } else {
      // Width is Z axis: mirror Z around car center
      frPos.z = carCenter.z + (carCenter.z - refPos.z);
    }

    // Width = distance between FL and FR
    const measuredWidth = refPos.distanceTo(frPos);
    if (measuredWidth > 0.01) {
      setWheelWidth(parseFloat(measuredWidth.toFixed(2)));
    }

    // Compute rear positions: offset along the length axis
    const rlPos = refPos.clone();
    const rrPos = frPos.clone();
    if (carLongAxisIsZ) {
      // Length is Z axis: offset Z toward rear
      // Determine which direction is "rear" — FL is at the front, so rear is away from front
      const frontZ = refPos.z;
      const rearDir = (carCenter.z - frontZ) >= 0 ? 1 : -1;
      rlPos.z += rearDir * l;
      rrPos.z += rearDir * l;
    } else {
      // Length is X axis
      const frontX = refPos.x;
      const rearDir = (carCenter.x - frontX) >= 0 ? 1 : -1;
      rlPos.x += rearDir * l;
      rrPos.x += rearDir * l;
    }

    // Store the car orientation for updateWheelSpread
    cylinderHelper.userData._carLongAxisIsZ = carLongAxisIsZ;
    cylinderHelper.userData._carCenter = carCenter.clone();

    const positions = [refPos, frPos, rlPos, rrPos];

    for (let i = 0; i < 4; i++) {
      const cyl = createWheelCylinder(WHEEL_COLORS[i]);
      cyl.position.copy(positions[i]);
      cyl.rotation.copy(refRot);
      cyl.scale.copy(refScale);
      cyl.name = `__wheel_cyl_${WHEEL_NAMES[i]}__`;
      scene.add(cyl);
      wheelCylinders[i] = cyl;
    }

    // Hide the original reference cylinder — FL takes its place
    cylinderHelper.visible = false;

    // Create the alignment rectangle
    wheelAlignRect = createAlignRect();
    scene.add(wheelAlignRect);
    updateAlignRectGeometry();

    setWheelAlignActive(true);
    setActiveWheelIndex(0);
    attachGizmoToWheel(0);
    setStatus('Adjust width/length sliders. Click a wheel to fine-tune.');
  }

  function removeWheelAlignment() {
    for (let i = 0; i < 4; i++) {
      if (wheelCylinders[i]) {
        scene?.remove(wheelCylinders[i]);
        wheelCylinders[i].geometry?.dispose();
        wheelCylinders[i].material?.dispose();
        wheelCylinders[i] = null;
      }
    }
    if (wheelAlignRect) {
      scene?.remove(wheelAlignRect);
      wheelAlignRect.geometry?.dispose();
      wheelAlignRect.material?.dispose();
      wheelAlignRect = null;
    }
    setWheelAlignActive(false);
  }

  function attachGizmoToWheel(index) {
    const cyl = wheelCylinders[index];
    if (!cyl || !camera || !renderer?.domElement || !scene) return;

    if (transformHelper) {
      scene.remove(transformHelper);
      transformHelper = null;
    }
    if (transformControls) {
      transformControls.detach();
      transformControls.dispose?.();
      transformControls = null;
    }

    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setMode('translate');
    transformControls.setSpace('local');
    transformControls.size = 0.9;
    transformControls.addEventListener('dragging-changed', (event) => {
      orbitControls.enabled = !event.value;
    });
    transformControls.addEventListener('objectChange', () => {
      updateAlignRectGeometry();
    });
    transformHelper = transformControls.getHelper();
    scene.add(transformHelper);
    transformControls.attach(cyl);
    setActiveWheelIndex(index);
  }

  function updateWheelSpread() {
    // Recalculate FR, RL, RR from the front-left reference
    const fl = wheelCylinders[0];
    if (!fl || !cylinderHelper) return;

    const w = wheelWidth();
    const l = wheelLength();

    const carLongAxisIsZ = cylinderHelper.userData._carLongAxisIsZ ?? true;
    const carCenter = cylinderHelper.userData._carCenter;
    if (!carCenter) return;

    const refPos = fl.position;

    // FR: mirror FL across car center on the width axis
    const frPos = refPos.clone();
    if (carLongAxisIsZ) {
      frPos.x = carCenter.x + (carCenter.x - refPos.x);
      // Adjust to match the desired width
      const currentWidth = Math.abs(frPos.x - refPos.x);
      if (currentWidth > 0.001) {
        const widthDir = Math.sign(frPos.x - refPos.x);
        frPos.x = refPos.x + widthDir * w;
      }
    } else {
      frPos.z = carCenter.z + (carCenter.z - refPos.z);
      const currentWidth = Math.abs(frPos.z - refPos.z);
      if (currentWidth > 0.001) {
        const widthDir = Math.sign(frPos.z - refPos.z);
        frPos.z = refPos.z + widthDir * w;
      }
    }

    // Rear direction: from FL toward car center on the length axis
    const rlPos = refPos.clone();
    const rrPos = frPos.clone();
    if (carLongAxisIsZ) {
      const rearDir = Math.sign(carCenter.z - refPos.z) || 1;
      rlPos.z = refPos.z + rearDir * l;
      rrPos.z = frPos.z + rearDir * l;
    } else {
      const rearDir = Math.sign(carCenter.x - refPos.x) || 1;
      rlPos.x = refPos.x + rearDir * l;
      rrPos.x = frPos.x + rearDir * l;
    }

    if (wheelCylinders[1]) wheelCylinders[1].position.copy(frPos);
    if (wheelCylinders[2]) wheelCylinders[2].position.copy(rlPos);
    if (wheelCylinders[3]) wheelCylinders[3].position.copy(rrPos);

    updateAlignRectGeometry();
  }

  function handleWheelWidthChange(value) {
    setWheelWidth(Number(value));
    updateWheelSpread();
  }

  function handleWheelLengthChange(value) {
    setWheelLength(Number(value));
    updateWheelSpread();
  }

  function findCylinderCutTarget() {
    const obj = getSelectedObject();
    if (obj?.isMesh && !obj.userData._builderHelper) return obj;

    const candidates = [];
    sceneRoot.traverse((c) => {
      if (c.isMesh && !c.userData._builderHelper && c.visible) {
        candidates.push(c);
      }
    });
    if (candidates.length === 1) return candidates[0];
    return null;
  }

  function handleApply4WheelCut() {
    if (!wheelCylinders.every(Boolean) || !sceneRoot) {
      setStatus('All 4 wheel cylinders required.');
      return;
    }

    let targetMesh = findCylinderCutTarget();
    if (!targetMesh) {
      setStatus('Select which mesh to cut (multiple meshes in scene).');
      return;
    }

    snapshotScene();
    setBusy(true);
    setStatus('Cutting 4 wheels...');

    try {
      const parent = targetMesh.parent || sceneRoot;
      const material = targetMesh.material;

      targetMesh.updateMatrixWorld(true);
      const worldMatrix = targetMesh.matrixWorld.clone();
      const wPos = new THREE.Vector3();
      const wQuat = new THREE.Quaternion();
      const wScl = new THREE.Vector3();
      worldMatrix.decompose(wPos, wQuat, wScl);
      const wRot = new THREE.Euler().setFromQuaternion(wQuat);

      let currentBody = targetMesh;

      for (let i = 0; i < 4; i++) {
        const cyl = wheelCylinders[i];
        const result = applyCylinderCut(cyl, currentBody);

        // Create the cutout mesh at sceneRoot level
        const cutoutMesh = new THREE.Mesh(result.cutout, material.clone());
        cutoutMesh.name = `wheel-${WHEEL_NAMES[i]}`;
        cutoutMesh.material.side = THREE.DoubleSide;
        cutoutMesh.position.copy(wPos);
        cutoutMesh.rotation.copy(wRot);
        cutoutMesh.scale.copy(wScl);
        sceneRoot.add(cutoutMesh);

        // Replace currentBody with the subtracted result for the next iteration
        const bodyMesh = new THREE.Mesh(result.body, material.clone());
        bodyMesh.name = currentBody.name || 'body';
        bodyMesh.material.side = THREE.DoubleSide;
        bodyMesh.position.copy(wPos);
        bodyMesh.rotation.copy(wRot);
        bodyMesh.scale.copy(wScl);

        parent.remove(currentBody);
        sceneRoot.add(bodyMesh);
        currentBody = bodyMesh;

        setStatus(`Cut wheel ${i + 1}/4 (${WHEEL_NAMES[i]})...`);
      }

      removeWheelAlignment();
      removeCylinder();
      clearSelection();
      syncHierarchy();
      setStatus('All 4 wheels cut. Meshes named wheel-front-left, wheel-front-right, etc.');
    } catch (error) {
      setStatus(`4-wheel cut failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  // Component checklist
  const COMPONENT_PATTERNS = [
    { key: 'body', label: 'Body', pattern: /body|chassis/i },
    { key: 'window', label: 'Glass', pattern: /windshield|window|glass/i },
    { key: 'headlight', label: 'Headlights', pattern: /headlight|head[\s_]?lamp/i },
    { key: 'tail', label: 'Tail lights', pattern: /tail[\s_]?light|tail[\s_]?lamp/i },
    { key: 'door', label: 'Door', pattern: /(driver.*door|door.*driver|^door$)/i },
    { key: 'interior', label: 'Interior', pattern: /interior/i },
    { key: 'steering', label: 'Steering Wheel', pattern: /steering/i },
  ];

  function getComponentChecklist() {
    const items = sceneItems();
    return COMPONENT_PATTERNS.map((comp) => {
      const matched = items.some((item) => comp.pattern.test(item.name));
      return { ...comp, matched };
    });
  }

  // Viewport setup
  createEffect(() => {
    if (!viewportRef) return;

    if (!renderer) {
      let cancelled = false;

      const initializeViewport = async () => {
        scene = new THREE.Scene();
        scene.background = new THREE.Color('#d6dbde');

        camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
        camera.position.set(4.5, 2.2, 4.6);

        renderer = new THREE.WebGPURenderer({
          antialias: true,
          forceWebGL: true
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(viewportRef.clientWidth || 640, viewportRef.clientHeight || 420);
        configureBodyshopRenderer(renderer);
        renderer.domElement.className = 'builder-canvas';
        viewportRef.append(renderer.domElement);
        await renderer.init();

        if (cancelled) return;

        await installBodyshopEnvironment(renderer, scene);

        const ambient = new THREE.AmbientLight(0xffffff, 0.34);
        const hemi = new THREE.HemisphereLight('#fff7d8', '#73806e', 1.7);
        const sun = new THREE.DirectionalLight('#fff4db', 2.1);
        sun.position.set(4, 7, 5);
        scene.add(ambient, hemi, sun);

        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(18, 18),
          new THREE.MeshStandardMaterial({ color: '#c7cfca', roughness: 0.95, metalness: 0.02 })
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -0.02;
        floor.userData._builderHelper = true;
        scene.add(floor);

        sceneRoot = new THREE.Group();
        sceneRoot.name = '__builder_root__';
        scene.add(sceneRoot);

        orbitControls = new OrbitControls(camera, renderer.domElement);
        orbitControls.enableDamping = true;
        orbitControls.target.set(0, 0.8, 0);

        resizeObserver = new ResizeObserver((entries) => {
          const entry = entries[0];
          const width = Math.max(entry.contentRect.width, 320);
          const height = Math.max(entry.contentRect.height, 320);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.setSize(width, height);
        });
        resizeObserver.observe(viewportRef);

        const tick = () => {
          animationFrame = requestAnimationFrame(tick);
          if (editPaused) return;
          orbitControls.update();
          renderer.render(scene, camera);
        };
        tick();

        void restoreBodyshopSession();
      };

      void initializeViewport();

      onCleanup(() => {
        cancelled = true;
      });
    }
  });

  // Keyboard shortcuts
  function handleKeyDown(event) {
    if (event.key === 'z' && (event.metaKey || event.ctrlKey) && event.shiftKey) {
      event.preventDefault();
      redo();
    } else if (event.key === 'z' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      undo();
    }
  }
  window.addEventListener('keydown', handleKeyDown);

  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown);
    void exitVehiclePreview();
    void flushBodyshopAutosave({
      meta: autosaveMeta(),
      exportGlb: sceneRoot && sceneItems().length > 0
        ? () => exportSceneToGlb(sceneRoot)
        : null,
    });
    cancelAnimationFrame(animationFrame);
    resizeObserver?.disconnect();
    transformControls?.dispose?.();
    if (sliceState) { disposeSlice(sliceState); sliceState = null; }
    if (transformHelper) {
      scene?.remove(transformHelper);
    }
    if (cylinderHelper) {
      scene?.remove(cylinderHelper);
      cylinderHelper.geometry?.dispose();
      cylinderHelper.material?.dispose();
    }
    for (const cyl of wheelCylinders) {
      if (cyl) {
        scene?.remove(cyl);
        cyl.geometry?.dispose();
        cyl.material?.dispose();
      }
    }
    if (wheelAlignRect) {
      scene?.remove(wheelAlignRect);
      wheelAlignRect.geometry?.dispose();
      wheelAlignRect.material?.dispose();
    }
    orbitControls?.dispose?.();
    renderer?.dispose?.();
  });

  // React to mode changes
  createEffect(() => {
    const currentMode = mode();
    if (currentMode === 'translate' || currentMode === 'rotate' || currentMode === 'scale') {
      attachTransformToSelected();
    }
  });

  return (
    <div class="bodyshop-shell builder-shell">
      <header class="builder-toolbar">
        <div class="builder-toolbar-left">
          <button type="button" class="ghost-button" onClick={() => props.onBack?.()}>
            Back to Garage
          </button>
          <span class="builder-divider" />
          <strong class="bodyshop-title">Bodyshop</strong>
          <button type="button" class="builder-mode-btn" onClick={undo} disabled={undoCount() === 0}>
            Undo
          </button>
          <button type="button" class="builder-mode-btn" onClick={redo} disabled={redoCount() === 0}>
            Redo
          </button>
          <span class="builder-divider" />
          <button
            type="button"
            class={`builder-mode-btn${mode() === 'select' ? ' is-active' : ''}`}
            onClick={() => setToolMode('select')}
          >
            Select
          </button>
          <button
            type="button"
            class={`builder-mode-btn${mode() === 'cut' ? ' is-active' : ''}`}
            onClick={() => setToolMode('cut')}
          >
            Cut
          </button>
          <button
            type="button"
            class={`builder-mode-btn${mode() === 'slice' ? ' is-active' : ''}`}
            onClick={() => setToolMode('slice')}
          >
            Slice
          </button>
          <button
            type="button"
            class={`builder-mode-btn${mode() === 'cylinder' ? ' is-active' : ''}`}
            onClick={() => setToolMode('cylinder')}
          >
            Cylinder
          </button>
          <span class="builder-divider" />
          <button
            type="button"
            class={`builder-mode-btn${mode() === 'translate' ? ' is-active' : ''}`}
            onClick={() => setToolMode('translate')}
          >
            Move
          </button>
          <button
            type="button"
            class={`builder-mode-btn${mode() === 'rotate' ? ' is-active' : ''}`}
            onClick={() => setToolMode('rotate')}
          >
            Rotate
          </button>
          <button
            type="button"
            class={`builder-mode-btn${mode() === 'scale' ? ' is-active' : ''}`}
            onClick={() => setToolMode('scale')}
          >
            Scale
          </button>
          <button
            type="button"
            class={`builder-mode-btn${mode() === 'locator' ? ' is-active' : ''}`}
            onClick={() => setToolMode('locator')}
          >
            Locators
          </button>
        </div>
        <div class="builder-toolbar-right">
          <button type="button" class="ghost-button" onClick={() => fileInputRef?.click()} disabled={busy() || previewMode()}>
            Load GLB
          </button>
          <button type="button" class="ghost-button" onClick={() => importInputRef?.click()} disabled={busy() || previewMode()}>
            Import GLB
          </button>
          <button type="button" class={`ghost-button${previewMode() ? ' is-active' : ''}`} onClick={toggleVehiclePreview} disabled={busy() || sceneItems().length === 0}>
            {previewMode() ? 'Back to edit' : 'Preview vehicle'}
          </button>
          <button type="button" class="solid-button" onClick={exportGlb} disabled={busy() || previewMode() || sceneItems().length === 0}>
            Download GLB
          </button>
          <button type="button" class="solid-button" onClick={publishToGarage} disabled={busy() || previewMode() || sceneItems().length === 0}>
            Publish to Garage
          </button>
        </div>
      </header>

      <input
        ref={(el) => { fileInputRef = el; }}
        class="hidden-file-input"
        type="file"
        accept=".glb"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void loadGlb(file);
          event.currentTarget.value = '';
        }}
      />
      <input
        ref={(el) => { importInputRef = el; }}
        class="hidden-file-input"
        type="file"
        accept=".glb"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void importGlb(file);
          event.currentTarget.value = '';
        }}
      />

      <div class="builder-status-bar">
        <span>{status()}</span>
      </div>

      <div class="builder-layout">
        {/* Left panel - hierarchy */}
        <aside class="builder-panel builder-left-panel">
          <div class="builder-section">
            <h3 class="builder-section-title">Components</h3>
            <div class="builder-checklist">
              <For each={getComponentChecklist()}>
                {(comp) => (
                  <div class={`builder-check-item${comp.matched ? ' is-matched' : ''}`}>
                    <span>{comp.matched ? '[x]' : '[ ]'}</span>
                    <span>{comp.label}</span>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="builder-section">
            <h3 class="builder-section-title">Validation</h3>
            <Show when={locatorValidation()} fallback={<span class="bodyshop-hint">Load a body to validate locators.</span>}>
              {(report) => (
                <>
                  <div class={`builder-check-item${report.approved ? ' is-matched' : ''}`}>
                    <span>{report.approved ? '[x]' : '[ ]'}</span>
                    <span>{report.approved ? 'Ready for garage publish' : 'Missing locators or key parts'}</span>
                  </div>
                  <For each={report.requiredLocators}>
                    {(entry) => (
                      <div class={`builder-check-item${entry.object ? ' is-matched' : ''}`}>
                        <span>{entry.object ? '[x]' : '[ ]'}</span>
                        <span>{entry.name}</span>
                      </div>
                    )}
                  </For>
                  <div class={`builder-check-item${report.optionalParts.door.present ? ' is-matched' : ''}`}>
                    <span>{report.optionalParts.door.present ? '[x]' : '[ ]'}</span>
                    <span>Door mesh</span>
                  </div>
                  <div class={`builder-check-item${report.optionalParts.steeringWheel.present ? ' is-matched' : ''}`}>
                    <span>{report.optionalParts.steeringWheel.present ? '[x]' : '[ ]'}</span>
                    <span>Steering mesh</span>
                  </div>
                </>
              )}
            </Show>
          </div>

          <div class="builder-section">
            <h3 class="builder-section-title">Scene</h3>
            <div class="builder-scene-list">
              <For each={sceneItems()}>
                {(item) => (
                  <div
                    class={`builder-scene-item${selectedIds().includes(item.id) ? ' is-selected' : ''}`}
                    style={{ 'padding-left': `${8 + item.depth * 12}px` }}
                    onClick={(event) => selectObject(item.id, event.shiftKey)}
                    onDblClick={() => startRename(item.id)}
                  >
                    <button
                      type="button"
                      class="builder-vis-toggle"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleVisibility(item.id);
                      }}
                    >
                      {item.visible ? 'V' : '-'}
                    </button>
                    <Show
                      when={renamingId() === item.id}
                      fallback={<span class="builder-item-name">{item.name}</span>}
                    >
                      <input
                        class="builder-rename-input"
                        type="text"
                        value={renameValue()}
                        onInput={(event) => setRenameValue(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') applyRename();
                          if (event.key === 'Escape') setRenamingId(null);
                        }}
                        onBlur={applyRename}
                        ref={(el) => setTimeout(() => el.focus(), 0)}
                      />
                    </Show>
                    <span class="builder-item-type">{item.type}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </aside>

        {/* Center - 3D viewport */}
        <div class="builder-viewport" ref={viewportRef} onClick={handleViewportClick} onMouseMove={handleViewportMouseMove} />

        {/* Right panel - properties & tools */}
        <aside class="builder-panel builder-right-panel">
          <Show when={previewMode()}>
            <div class="builder-section">
              <h3 class="builder-section-title">Vehicle preview</h3>
              <p class="bodyshop-hint">Full garage frame + authored overlay through BaseVehicle ingest.</p>
              <div class="builder-transform-group">
                <label>Steer: {previewSteer().toFixed(2)}</label>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.01"
                  value={previewSteer()}
                  onInput={(event) => setPreviewSteer(Number(event.currentTarget.value))}
                  class="builder-slider"
                />
              </div>
              <div class="builder-transform-group">
                <label>Door: {previewDoor().toFixed(2)}</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={previewDoor()}
                  onInput={(event) => setPreviewDoor(Number(event.currentTarget.value))}
                  class="builder-slider"
                />
              </div>
            </div>
          </Show>

          <Show when={mode() === 'locator' && !previewMode()}>
            <div class="builder-section">
              <h3 class="builder-section-title">Locators</h3>
              <div class="builder-actions">
                <button type="button" class="ghost-button" onClick={handleAddMissingLocators}>Add missing locators</button>
                <button type="button" class="ghost-button" onClick={alignBodyForward}>Align forward to +Z</button>
                <button type="button" class="ghost-button" onClick={() => rotateBodyYaw(-90)}>Rotate -90°</button>
                <button type="button" class="ghost-button" onClick={() => rotateBodyYaw(90)}>Rotate +90°</button>
              </div>
              <div class="bodyshop-locator-list">
                <For each={BODYSHOP_REQUIRED_LOCATOR_NAMES}>
                  {(locatorName) => (
                    <button
                      type="button"
                      class={`builder-wheel-btn${selectedLocatorName() === locatorName ? ' is-active' : ''}${locatorValidation()?.requiredLocators.find((entry) => entry.name === locatorName)?.object ? '' : ' is-missing'}`}
                      onClick={() => selectLocator(locatorName)}
                    >
                      {locatorName.replace('Locator_', '')}
                    </button>
                  )}
                </For>
              </div>
              <div class="builder-transform-group">
                <label>Nudge step: {nudgeStep().toFixed(3)} m</label>
                <input
                  type="range"
                  min="0.005"
                  max="0.2"
                  step="0.005"
                  value={nudgeStep()}
                  onInput={(event) => setNudgeStep(Number(event.currentTarget.value))}
                  class="builder-slider"
                />
              </div>
              <div class="builder-actions">
                <button type="button" class="ghost-button" onClick={() => nudgeLocator('x', nudgeStep())}>+X</button>
                <button type="button" class="ghost-button" onClick={() => nudgeLocator('x', -nudgeStep())}>-X</button>
                <button type="button" class="ghost-button" onClick={() => nudgeLocator('y', nudgeStep())}>+Y</button>
                <button type="button" class="ghost-button" onClick={() => nudgeLocator('y', -nudgeStep())}>-Y</button>
                <button type="button" class="ghost-button" onClick={() => nudgeLocator('z', nudgeStep())}>+Z</button>
                <button type="button" class="ghost-button" onClick={() => nudgeLocator('z', -nudgeStep())}>-Z</button>
              </div>
            </div>
          </Show>

          <Show when={selectedTransform() && !previewMode()}>
            <div class="builder-section">
              <h3 class="builder-section-title">Transform</h3>
              <div class="builder-transform-group">
                <label>Position</label>
                <div class="builder-vec3">
                  <input type="number" step="0.01" value={selectedTransform().px}
                    onChange={(e) => updateTransformProperty('x', 'position', e.currentTarget.value)} />
                  <input type="number" step="0.01" value={selectedTransform().py}
                    onChange={(e) => updateTransformProperty('y', 'position', e.currentTarget.value)} />
                  <input type="number" step="0.01" value={selectedTransform().pz}
                    onChange={(e) => updateTransformProperty('z', 'position', e.currentTarget.value)} />
                </div>
              </div>
              <div class="builder-transform-group">
                <label>Rotation</label>
                <div class="builder-vec3">
                  <input type="number" step="1" value={selectedTransform().rx}
                    onChange={(e) => updateTransformProperty('x', 'rotation', e.currentTarget.value)} />
                  <input type="number" step="1" value={selectedTransform().ry}
                    onChange={(e) => updateTransformProperty('y', 'rotation', e.currentTarget.value)} />
                  <input type="number" step="1" value={selectedTransform().rz}
                    onChange={(e) => updateTransformProperty('z', 'rotation', e.currentTarget.value)} />
                </div>
              </div>
              <div class="builder-transform-group">
                <label>Scale</label>
                <div class="builder-vec3">
                  <input type="number" step="0.01" value={selectedTransform().sx}
                    onChange={(e) => updateTransformProperty('x', 'scale', e.currentTarget.value)} />
                  <input type="number" step="0.01" value={selectedTransform().sy}
                    onChange={(e) => updateTransformProperty('y', 'scale', e.currentTarget.value)} />
                  <input type="number" step="0.01" value={selectedTransform().sz}
                    onChange={(e) => updateTransformProperty('z', 'scale', e.currentTarget.value)} />
                </div>
              </div>
            </div>
          </Show>

          <Show when={mode() === 'cut' && !previewMode()}>
            <div class="builder-section">
              <h3 class="builder-section-title">Cut Tool</h3>
              <div class="builder-actions">
                <button type="button" class="ghost-button" onClick={handleUndoCutPoint}>Undo Point</button>
                <button type="button" class="ghost-button" onClick={handleClearCut}>Clear</button>
                <button type="button" class="solid-button" onClick={handleApplyCut} disabled={busy()}>Apply Cut</button>
              </div>
            </div>
          </Show>

          <Show when={mode() === 'slice' && !previewMode()}>
            <div class="builder-section">
              <h3 class="builder-section-title">Slice Tool</h3>
              <p style={{ 'font-size': '0.72rem', color: '#888', margin: '0 0 6px' }}>
                Click two points on the mesh. Everything on one side of the line gets removed.
              </p>
              <div class="builder-actions">
                <button type="button" class="ghost-button" onClick={handleFlipSlice}
                  disabled={!sliceReady()}>
                  Flip Side{sliceFlip() ? ' (flipped)' : ''}
                </button>
                <button type="button" class="ghost-button" onClick={handleClearSlice}>Clear</button>
                <button type="button" class="solid-button" onClick={handleApplySlice}
                  disabled={busy() || !sliceReady()}>
                  Apply Slice
                </button>
              </div>
            </div>
          </Show>

          <Show when={mode() === 'cylinder' && cylinderTransform() && !previewMode()}>
            <div class="builder-section">
              <h3 class="builder-section-title">Cylinder Cutter</h3>
              <div class="builder-actions" style={{ 'flex-direction': 'row', 'flex-wrap': 'wrap' }}>
                <button type="button" class={`builder-mode-btn${transformControls?.mode === 'translate' ? ' is-active' : ''}`}
                  onClick={() => setCylinderGizmoMode('translate')}>Move</button>
                <button type="button" class={`builder-mode-btn${transformControls?.mode === 'rotate' ? ' is-active' : ''}`}
                  onClick={() => setCylinderGizmoMode('rotate')}>Rotate</button>
                <button type="button" class={`builder-mode-btn${transformControls?.mode === 'scale' ? ' is-active' : ''}`}
                  onClick={() => setCylinderGizmoMode('scale')}>Scale</button>
              </div>
              <div class="builder-transform-group">
                <label>Position</label>
                <div class="builder-vec3">
                  <input type="number" step="0.01" value={cylinderTransform().px}
                    onChange={(e) => updateCylinderProperty('x', 'position', e.currentTarget.value)} />
                  <input type="number" step="0.01" value={cylinderTransform().py}
                    onChange={(e) => updateCylinderProperty('y', 'position', e.currentTarget.value)} />
                  <input type="number" step="0.01" value={cylinderTransform().pz}
                    onChange={(e) => updateCylinderProperty('z', 'position', e.currentTarget.value)} />
                </div>
              </div>
              <div class="builder-transform-group">
                <label>Rotation</label>
                <div class="builder-vec3">
                  <input type="number" step="1" value={cylinderTransform().rx}
                    onChange={(e) => updateCylinderProperty('x', 'rotation', e.currentTarget.value)} />
                  <input type="number" step="1" value={cylinderTransform().ry}
                    onChange={(e) => updateCylinderProperty('y', 'rotation', e.currentTarget.value)} />
                  <input type="number" step="1" value={cylinderTransform().rz}
                    onChange={(e) => updateCylinderProperty('z', 'rotation', e.currentTarget.value)} />
                </div>
              </div>
              <div class="builder-transform-group">
                <label>Scale</label>
                <div class="builder-vec3">
                  <input type="number" step="0.01" value={cylinderTransform().sx}
                    onChange={(e) => updateCylinderProperty('x', 'scale', e.currentTarget.value)} />
                  <input type="number" step="0.01" value={cylinderTransform().sy}
                    onChange={(e) => updateCylinderProperty('y', 'scale', e.currentTarget.value)} />
                  <input type="number" step="0.01" value={cylinderTransform().sz}
                    onChange={(e) => updateCylinderProperty('z', 'scale', e.currentTarget.value)} />
                </div>
              </div>
              <div class="builder-actions">
                <button type="button" class="solid-button" onClick={handleApplyCylinderCut} disabled={busy()}>
                  Apply Cylinder Cut
                </button>
                <button type="button" class="ghost-button" onClick={spawnWheelAlignment}
                  disabled={!cylinderHelper}>
                  Align 4 Wheels
                </button>
                <button type="button" class="ghost-button" onClick={removeCylinder}>
                  Remove Cylinder
                </button>
              </div>
            </div>
          </Show>

          <Show when={mode() === 'cylinder' && wheelAlignActive() && !previewMode()}>
            <div class="builder-section">
              <h3 class="builder-section-title">4-Wheel Alignment</h3>
              <div class="builder-transform-group">
                <label>Width (left-right): {wheelWidth().toFixed(2)}</label>
                <input type="range" min="0" max="3.0" step="0.01"
                  value={wheelWidth()}
                  onInput={(e) => handleWheelWidthChange(e.currentTarget.value)}
                  class="builder-slider" />
              </div>
              <div class="builder-transform-group">
                <label>Length (front-rear): {wheelLength().toFixed(2)}</label>
                <input type="range" min="0" max="5.0" step="0.01"
                  value={wheelLength()}
                  onInput={(e) => handleWheelLengthChange(e.currentTarget.value)}
                  class="builder-slider" />
              </div>
              <div class="builder-transform-group">
                <label>Select wheel to fine-tune</label>
                <div class="builder-wheel-selector">
                  <For each={WHEEL_NAMES}>
                    {(name, i) => (
                      <button type="button"
                        class={`builder-wheel-btn${activeWheelIndex() === i() ? ' is-active' : ''}`}
                        style={{ 'border-color': `#${WHEEL_COLORS[i()].toString(16).padStart(6, '0')}` }}
                        onClick={() => attachGizmoToWheel(i())}>
                        {name}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <div class="builder-actions">
                <button type="button" class="solid-button" onClick={handleApply4WheelCut} disabled={busy()}>
                  Cut All 4 Wheels
                </button>
                <button type="button" class="ghost-button" onClick={removeWheelAlignment}>
                  Remove Alignment
                </button>
              </div>
            </div>
          </Show>

          <div class="builder-section">
            <h3 class="builder-section-title">Publish</h3>
            <div class="builder-transform-group">
              <label>Chassis id</label>
              <input
                class="builder-rename-input bodyshop-field"
                type="text"
                value={publishId()}
                placeholder="orange-car-v2"
                onInput={(event) => setPublishId(event.currentTarget.value)}
              />
            </div>
            <div class="builder-transform-group">
              <label>Garage name</label>
              <input
                class="builder-rename-input bodyshop-field"
                type="text"
                value={publishName()}
                placeholder="Orange EV Mk II"
                onInput={(event) => setPublishName(event.currentTarget.value)}
              />
            </div>
            <div class="builder-transform-group">
              <label>Description</label>
              <input
                class="builder-rename-input bodyshop-field"
                type="text"
                value={publishDescription()}
                placeholder="Short garage blurb"
                onInput={(event) => setPublishDescription(event.currentTarget.value)}
              />
            </div>
            <label class="bodyshop-checkbox">
              <input
                type="checkbox"
                checked={publishDevOnly()}
                onChange={(event) => setPublishDevOnly(event.currentTarget.checked)}
              />
              <span>Dev-only in garage (omit for production builds)</span>
            </label>
          </div>

          <div class="builder-section">
            <h3 class="builder-section-title">Actions</h3>
            <div class="builder-actions">
              <button type="button" class="ghost-button" onClick={joinSelected}
                disabled={selectedIds().length < 2}>
                Join Selected
              </button>
              <button type="button" class="danger-button" onClick={deleteSelected}
                disabled={selectedIds().length === 0}>
                Delete Selected
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function fileToArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsArrayBuffer(file);
  });
}
