import { subscribe } from 'valtio/vanilla';
import { clothingStore } from '../../../vendor/vibe-human/features/clothing/state/clothingStore.ts';
import {
  loadDemoGarment,
  markPreviewDirty,
  redo,
  setActiveClothingTool,
  undo,
} from '../../../vendor/vibe-human/features/clothing/state/clothingActions.ts';
import { pushHistory } from '../../../vendor/vibe-human/features/clothing/state/historyActions.ts';
import { createDemoGarment } from '../../../vendor/vibe-human/features/clothing/demo/createDemoGarment.ts';
import { toPatternDocument } from '../../../vendor/vibe-human/features/clothing/document/legacyAdapter.ts';
import { compileGarmentRuntime } from '../../../vendor/vibe-human/features/clothing/compiler/compileGarmentRuntime.ts';
import {
  loadSimGarments,
  saveSimGarment,
} from './simGarmentStore.js';

/**
 * Framework-neutral editor facade. Vendored tools continue to mutate their
 * document directly; this class exposes callback subscriptions and plain CRUD
 * methods so Solid never depends on Valtio's React bindings.
 */
export class GarmentEditorStore {
  constructor() {
    this.listeners = new Set();
    this.unsubscribeVendor = subscribe(clothingStore, () => this.emit(), true);
    this.newDemo();
  }

  get state() {
    return clothingStore;
  }

  get garment() {
    return clothingStore.garment;
  }

  get selectedPanel() {
    const id = clothingStore.garment.selectedPatternId;
    return id ? clothingStore.garment.patterns[id] ?? null : null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener();
  }

  newDemo() {
    const garment = createDemoGarment();
    garment.id = `garment-${Math.random().toString(36).slice(2, 10)}`;
    garment.name = 'Everyday T-Shirt';
    loadDemoGarment(garment);
    this.emit();
    return garment;
  }

  load(id) {
    const garment = loadSimGarments().find((entry) => entry.id === id);
    if (!garment) return null;
    loadDemoGarment(structuredClone(garment));
    if (garment.placements) clothingStore.placements = structuredClone(garment.placements);
    this.emit();
    return clothingStore.garment;
  }

  savedGarments() {
    return loadSimGarments().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  setTool(tool) {
    setActiveClothingTool(tool);
  }

  undo() { undo(); }
  redo() { redo(); }

  renameGarment(name) {
    clothingStore.garment.name = String(name).slice(0, 80) || 'Untitled Garment';
  }

  updateSelectedPanel(patch) {
    const panel = this.selectedPanel;
    if (!panel) return false;
    pushHistory();
    Object.assign(panel, patch);
    markPreviewDirty();
    return true;
  }

  compile(quality = 'low') {
    const garment = this.plainGarment();
    const document = toPatternDocument(garment, garment.placements ?? {});
    const result = compileGarmentRuntime(document, { quality, seamSamples: 18 });
    return { garment, document, ...result };
  }

  save() {
    return saveSimGarment(this.plainGarment());
  }

  plainGarment() {
    const garment = JSON.parse(JSON.stringify(clothingStore.garment));
    garment.placements = JSON.parse(JSON.stringify(clothingStore.placements));
    return garment;
  }

  dispose() {
    this.unsubscribeVendor?.();
    this.unsubscribeVendor = null;
    this.listeners.clear();
  }
}
