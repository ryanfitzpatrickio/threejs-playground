import {
  flushFileStore,
  getBodyshopAutosave,
  setBodyshopAutosave,
} from '../../store/fileStore.js';

const DRAFT_GLB_URL = '/assets/models/_bodyshop-draft.glb';
const AUTOSAVE_DEBOUNCE_MS = 1500;

let autosaveTimer = null;
let autosaveGeneration = 0;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function getBodyshopDraftUrl() {
  return DRAFT_GLB_URL;
}

export async function saveBodyshopDraftGlb(glbBytes) {
  const response = await fetch('/__editor/bodyshop/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ glbBase64: arrayBufferToBase64(glbBytes) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Draft save failed (${response.status})`);
  }
  return DRAFT_GLB_URL;
}

export function readBodyshopSession() {
  return getBodyshopAutosave();
}

export function writeBodyshopSessionMeta(meta, { debounce = true } = {}) {
  const current = getBodyshopAutosave() ?? {};
  setBodyshopAutosave({
    ...current,
    ...meta,
    updatedAt: Date.now(),
  }, { debounce });
}

export function scheduleBodyshopAutosave({
  meta = {},
  exportGlb = null,
  onStatus = null,
} = {}) {
  if (meta && Object.keys(meta).length > 0) {
    writeBodyshopSessionMeta(meta, { debounce: true });
  }

  if (typeof exportGlb !== 'function') return;

  const generation = ++autosaveGeneration;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    if (generation !== autosaveGeneration) return;
    try {
      onStatus?.('Autosaving draft...');
      const buffer = await exportGlb();
      if (!buffer?.byteLength) return;
      await saveBodyshopDraftGlb(buffer);
      writeBodyshopSessionMeta({ hasDraft: true, draftUrl: DRAFT_GLB_URL }, { debounce: false });
      onStatus?.('Draft saved.');
    } catch (error) {
      onStatus?.(`Draft autosave failed: ${error.message}`);
    }
  }, AUTOSAVE_DEBOUNCE_MS);
}

export async function flushBodyshopAutosave({
  meta = {},
  exportGlb = null,
} = {}) {
  autosaveGeneration += 1;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }

  if (meta && Object.keys(meta).length > 0) {
    writeBodyshopSessionMeta(meta, { debounce: false });
  }

  if (typeof exportGlb === 'function') {
    const buffer = await exportGlb();
    if (buffer?.byteLength) {
      await saveBodyshopDraftGlb(buffer);
      writeBodyshopSessionMeta({ hasDraft: true, draftUrl: DRAFT_GLB_URL }, { debounce: false });
    }
  }

  await flushFileStore();
}
