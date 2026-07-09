/**
 * Prod-safe shader parameter registry for live TSL uniform tweaking.
 *
 * No DOM, no Tweakpane. Providers/systems may import this always and call
 * systemWrite / clearOverridesForFolders. The debug pane (dev-only) binds to
 * the same registry via events.
 *
 * See docs/tsl-shader-debug-tweaking-plan.md
 */

/** @typedef {'float'|'int'|'bool'|'color'|'vec2'|'vec3'|'enum'|'action'|'monitor'} ParamType */
/** @typedef {'init'|'event'|'frame'} WriteCadence */
/** @typedef {'allow'|'monitor'|'never'} PinPolicy */
/** @typedef {'live'|'rebake'|'rebuild'} ParamCost */

/**
 * @typedef {object} ShaderDebugParam
 * @property {string} id
 * @property {string} label
 * @property {string} folder
 * @property {ParamType} type
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {unknown} [default]
 * @property {() => unknown} get
 * @property {(v: unknown) => void} [set]
 * @property {() => void} [action]
 * @property {WriteCadence} [writeCadence]
 * @property {PinPolicy} [pinPolicy]
 * @property {ParamCost} [cost]
 * @property {string} [help]
 * @property {string[]} [options]  // enum labels/values
 */

/** @type {Map<string, ShaderDebugParam>} */
const params = new Map();

/** @type {Map<string, { title?: string, expanded?: boolean }>} */
const folders = new Map();

/** @type {Set<string>} */
const userOverrides = new Set();

/** @type {Set<(type: string, detail?: unknown) => void>} */
const listeners = new Set();

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function onShaderDebugEvent(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitShaderDebugEvent(type, detail) {
  for (const fn of listeners) {
    try {
      fn(type, detail);
    } catch (err) {
      console.warn('[shaderDebugRegistry] event listener error', type, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * @param {string} folder
 * @param {{ title?: string, expanded?: boolean }} [meta]
 */
export function registerShaderDebugFolder(folder, meta = {}) {
  if (!folder || typeof folder !== 'string') return;
  const prev = folders.get(folder) ?? {};
  folders.set(folder, {
    title: meta.title ?? prev.title ?? folder,
    expanded: meta.expanded ?? prev.expanded ?? false,
  });
}

/**
 * @param {ShaderDebugParam} param
 */
export function registerShaderDebugParam(param) {
  if (!param || typeof param.id !== 'string' || !param.id) {
    console.warn('[shaderDebugRegistry] reject param without id', param);
    return;
  }
  if (param.pinPolicy === 'never') return;
  if (typeof param.get !== 'function' && param.type !== 'action') {
    console.warn('[shaderDebugRegistry] reject param without get', param.id);
    return;
  }
  if (params.has(param.id)) {
    console.warn('[shaderDebugRegistry] duplicate id, replacing', param.id);
  }
  const entry = {
    writeCadence: 'event',
    pinPolicy: 'allow',
    cost: 'live',
    ...param,
  };
  params.set(entry.id, entry);
  if (entry.folder) {
    if (!folders.has(entry.folder)) {
      registerShaderDebugFolder(entry.folder, {
        expanded: entry.folder === 'Session' || entry.folder === 'Clouds Shape',
      });
    }
  }
  emitShaderDebugEvent('param-registered', { id: entry.id });
}

/**
 * Update get/set closures after pipeline rebuild without changing schema.
 * @param {string} id
 * @param {{ get?: () => unknown, set?: (v: unknown) => void }} bindings
 */
export function rebindShaderDebugParam(id, bindings = {}) {
  const entry = params.get(id);
  if (!entry) return false;
  if (typeof bindings.get === 'function') entry.get = bindings.get;
  if (typeof bindings.set === 'function') entry.set = bindings.set;
  emitShaderDebugEvent('rebind', { id });
  return true;
}

/**
 * @param {string} [folderOrPrefix]
 */
export function refreshShaderDebugBindings(folderOrPrefix) {
  emitShaderDebugEvent('rebind', { folderOrPrefix: folderOrPrefix ?? null });
}

// ---------------------------------------------------------------------------
// Uniform helpers (K10 — mutate in place for Color / Vector3)
// ---------------------------------------------------------------------------

function colorToRgb(value) {
  if (!value) return [1, 1, 1];
  if (Array.isArray(value)) return [value[0] ?? 1, value[1] ?? 1, value[2] ?? 1];
  if (typeof value === 'object' && 'r' in value) {
    return [value.r ?? 1, value.g ?? 1, value.b ?? 1];
  }
  return [1, 1, 1];
}

/** @param {unknown} v */
function normalizeColorInput(v) {
  if (typeof v === 'string' && v.startsWith('#')) {
    const hex = v.slice(1);
    const full = hex.length === 3
      ? hex.split('').map((c) => c + c).join('')
      : hex.padStart(6, '0');
    const n = Number.parseInt(full, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  if (v && typeof v === 'object') {
    if ('r' in v) return [v.r ?? 0, v.g ?? 0, v.b ?? 0];
    if ('x' in v) return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
  }
  return [0, 0, 0];
}

function vecToArr(value) {
  if (!value) return [0, 0, 0];
  if (Array.isArray(value)) return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
  return [value.x ?? 0, value.y ?? 0, value.z ?? 0];
}

/**
 * @param {string} id
 * @param {string} folder
 * @param {string} label
 * @param {{ value: number }} uNode
 * @param {object} [opts]
 */
export function registerUniformFloat(id, folder, label, uNode, opts = {}) {
  registerShaderDebugParam({
    id,
    folder,
    label,
    type: 'float',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    default: opts.default ?? uNode?.value,
    writeCadence: opts.writeCadence ?? 'event',
    pinPolicy: opts.pinPolicy ?? 'allow',
    cost: opts.cost ?? 'live',
    help: opts.help,
    get: () => uNode.value,
    set: (v) => {
      const n = Number(v);
      markUserOverride(id, n);
      uNode.value = n;
    },
  });
}

/**
 * @param {string} id
 * @param {string} folder
 * @param {string} label
 * @param {{ value: { setRGB: (r: number, g: number, b: number) => void, r: number, g: number, b: number } }} uNode
 * @param {object} [opts]
 */
export function registerUniformColor(id, folder, label, uNode, opts = {}) {
  registerShaderDebugParam({
    id,
    folder,
    label,
    type: 'color',
    default: opts.default ?? colorToRgb(uNode?.value),
    writeCadence: opts.writeCadence ?? 'event',
    pinPolicy: opts.pinPolicy ?? 'allow',
    cost: opts.cost ?? 'live',
    help: opts.help,
    get: () => colorToRgb(uNode.value),
    set: (v) => {
      const [r, g, b] = normalizeColorInput(v);
      markUserOverride(id, [r, g, b]);
      uNode.value.setRGB(r, g, b);
    },
  });
}

/**
 * @param {string} id
 * @param {string} folder
 * @param {string} label
 * @param {{ value: { set: (x: number, y: number, z: number) => void, x: number, y: number, z: number } }} uNode
 * @param {object} [opts]
 */
export function registerUniformVec3(id, folder, label, uNode, opts = {}) {
  registerShaderDebugParam({
    id,
    folder,
    label,
    type: 'vec3',
    default: opts.default ?? vecToArr(uNode?.value),
    writeCadence: opts.writeCadence ?? 'event',
    pinPolicy: opts.pinPolicy ?? 'allow',
    cost: opts.cost ?? 'live',
    help: opts.help,
    get: () => vecToArr(uNode.value),
    set: (v) => {
      const arr = Array.isArray(v)
        ? v
        : [v?.x ?? 0, v?.y ?? 0, v?.z ?? 0];
      const triple = [arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0];
      markUserOverride(id, triple);
      uNode.value.set(triple[0], triple[1], triple[2]);
    },
  });
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export function markUserOverride(id, lastValue) {
  if (!params.has(id)) return;
  userOverrides.add(id);
  if (lastValue !== undefined) {
    const entry = params.get(id);
    if (entry) entry.lastUserValue = lastValue;
  }
  emitShaderDebugEvent('param-changed', { id, override: true });
}

/**
 * Re-apply stored user values after nodes/materials are rebuilt (e.g. post pipeline).
 * @param {string} [idPrefix] only ids starting with this prefix (e.g. 'post.')
 * @returns {number} reapplied count
 */
export function reapplyShaderDebugOverrides(idPrefix = '') {
  let n = 0;
  for (const id of userOverrides) {
    if (idPrefix && !id.startsWith(idPrefix)) continue;
    const p = params.get(id);
    if (!p || p.lastUserValue === undefined || typeof p.set !== 'function') continue;
    try {
      p.set(p.lastUserValue);
      n += 1;
    } catch (err) {
      console.warn('[shaderDebugRegistry] reapply failed', id, err);
    }
  }
  if (n) emitShaderDebugEvent('rebind', { prefix: idPrefix, reapplied: n });
  return n;
}

export function isUserOverride(id) {
  return userOverrides.has(id);
}

/**
 * Exact match on registration `folder` field.
 * @param {string} folder
 */
export function hasAnyUserOverrideInFolder(folder) {
  if (!folder) return false;
  for (const id of userOverrides) {
    const p = params.get(id);
    if (p && p.folder === folder) return true;
  }
  return false;
}

export function clearUserOverride(id) {
  if (!userOverrides.has(id)) return false;
  userOverrides.delete(id);
  emitShaderDebugEvent('overrides-cleared', { ids: [id] });
  return true;
}

export function clearAllUserOverrides() {
  if (userOverrides.size === 0) return 0;
  const ids = [...userOverrides];
  userOverrides.clear();
  emitShaderDebugEvent('overrides-cleared', { ids, all: true });
  return ids.length;
}

/**
 * Clear overrides whose param.folder is in `folders` (exact string match).
 * @param {string[]} folderList
 */
export function clearOverridesForFolders(folderList) {
  if (!Array.isArray(folderList) || folderList.length === 0) return 0;
  const set = new Set(folderList);
  const cleared = [];
  for (const id of [...userOverrides]) {
    const p = params.get(id);
    if (p && set.has(p.folder)) {
      userOverrides.delete(id);
      cleared.push(id);
    }
  }
  if (cleared.length) {
    emitShaderDebugEvent('overrides-cleared', { ids: cleared, folders: folderList });
  }
  return cleared.length;
}

/**
 * Systems stamp through this so user pins are not clobbered.
 * Unknown / unregistered ids always apply (never treated as pinned) so providers
 * can wrap future ids (e.g. aerial.hazeColor) before registration.
 * @param {string} id
 * @param {() => void} writeFn
 * @returns {boolean} true if write applied
 */
export function systemWrite(id, writeFn) {
  if (params.has(id) && isUserOverride(id)) return false;
  writeFn();
  return true;
}

// ---------------------------------------------------------------------------
// Atmosphere LUT dirty badge (K5)
// ---------------------------------------------------------------------------

let lutDirty = false;

export function markLutDirty() {
  if (lutDirty) return;
  lutDirty = true;
  emitShaderDebugEvent('lut-dirty', { dirty: true });
}

export function clearLutDirty() {
  if (!lutDirty) return;
  lutDirty = false;
  emitShaderDebugEvent('lut-dirty', { dirty: false });
}

export function isLutDirty() {
  return lutDirty;
}

/** localStorage key for override persistence (K6). */
export const SHADER_DEBUG_STORAGE_KEY = 'dreamfall:shader-debug-overrides';

/**
 * Persist current override values (not full snapshot) to localStorage.
 * @returns {boolean}
 */
export function saveOverridesToLocalStorage() {
  try {
    const map = {};
    for (const id of userOverrides) {
      const param = params.get(id);
      if (!param || typeof param.get !== 'function' || param.type === 'action') continue;
      try {
        map[id] = serializeValue(param, param.get());
      } catch {
        /* skip */
      }
    }
    localStorage.setItem(SHADER_DEBUG_STORAGE_KEY, JSON.stringify({ version: 1, overrides: map }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load and apply overrides from localStorage (as pins).
 * @returns {number} applied count
 */
export function loadOverridesFromLocalStorage() {
  try {
    const raw = localStorage.getItem(SHADER_DEBUG_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    const map = parsed?.overrides && typeof parsed.overrides === 'object'
      ? parsed.overrides
      : (parsed && typeof parsed === 'object' ? parsed : null);
    if (!map) return 0;
    return applyShaderDebugSnapshot({ params: Object.fromEntries(
      Object.entries(map).map(([id, value]) => [id, { value }]),
    ) }, { asOverride: true });
  } catch {
    return 0;
  }
}

export function clearOverridesLocalStorage() {
  try {
    localStorage.removeItem(SHADER_DEBUG_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Snapshot / apply / reset / export
// ---------------------------------------------------------------------------

function serializeValue(param, value) {
  if (param.type === 'color') return colorToRgb(value);
  if (param.type === 'vec2' || param.type === 'vec3') {
    if (Array.isArray(value)) return [...value];
    if (value && typeof value === 'object') {
      if ('x' in value) {
        return param.type === 'vec2'
          ? [value.x ?? 0, value.y ?? 0]
          : [value.x ?? 0, value.y ?? 0, value.z ?? 0];
      }
      if ('r' in value) return [value.r ?? 0, value.g ?? 0, value.b ?? 0];
    }
  }
  return value;
}

export function getShaderDebugSnapshot() {
  /** @type {Record<string, { value: unknown, override: boolean, folder: string, type: string }>} */
  const out = {};
  for (const [id, param] of params) {
    if (param.type === 'action') continue;
    let value;
    try {
      value = param.get?.();
    } catch {
      value = null;
    }
    out[id] = {
      value: serializeValue(param, value),
      override: userOverrides.has(id),
      folder: param.folder,
      type: param.type,
    };
  }
  return {
    version: 1,
    params: out,
    overrideIds: [...userOverrides],
  };
}

/**
 * @param {object} obj
 * @param {{ asOverride?: boolean }} [opts]
 */
export function applyShaderDebugSnapshot(obj, opts = {}) {
  const asOverride = opts.asOverride !== false;
  if (!obj || typeof obj !== 'object') return 0;
  const entries = obj.params && typeof obj.params === 'object' ? obj.params : obj;
  let applied = 0;
  for (const [id, raw] of Object.entries(entries)) {
    const param = params.get(id);
    if (!param || typeof param.set !== 'function') continue;
    const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    try {
      if (asOverride) markUserOverride(id);
      else userOverrides.delete(id);
      // markUserOverride already sets; set() also marks — call underlying carefully
      if (asOverride) {
        param.set(value);
      } else {
        // set() always marks override; write without pin when asOverride false
        userOverrides.delete(id);
        const prevSet = param.set;
        // Invoke set which re-marks — then clear if not wanted
        prevSet(value);
        if (!asOverride) userOverrides.delete(id);
      }
      applied += 1;
    } catch (err) {
      console.warn('[shaderDebugRegistry] apply failed', id, err);
    }
  }
  emitShaderDebugEvent('param-changed', { snapshot: true, applied });
  return applied;
}

export function resetShaderDebugFolder(folder) {
  const ids = [];
  for (const [id, param] of params) {
    if (param.folder !== folder) continue;
    if (userOverrides.has(id)) {
      userOverrides.delete(id);
      ids.push(id);
    }
    if (param.default !== undefined && typeof param.set === 'function') {
      try {
        // Write default without leaving an override pin
        param.set(param.default);
        userOverrides.delete(id);
      } catch {
        /* ignore */
      }
    }
  }
  if (ids.length) emitShaderDebugEvent('overrides-cleared', { ids, folder });
  emitShaderDebugEvent('param-changed', { resetFolder: folder });
  return ids.length;
}

export function resetShaderDebugAll() {
  const ids = [...userOverrides];
  for (const [id, param] of params) {
    if (param.default !== undefined && typeof param.set === 'function') {
      try {
        param.set(param.default);
      } catch {
        /* ignore */
      }
    }
  }
  userOverrides.clear();
  emitShaderDebugEvent('overrides-cleared', { ids, all: true });
  emitShaderDebugEvent('param-changed', { resetAll: true });
  return ids.length;
}

/**
 * Clipboard-friendly JS. Delegates to structured formatters (cloudConfig shapes).
 * @param {string|null} [folderOrAll]
 */
export function exportShaderDebugAsJs(folderOrAll = null) {
  // Lazy import avoided: export module is pure and depends only on this registry.
  // Implemented in shaderDebugExport.js and re-exported for Session actions.
  return _exportAsJsImpl(folderOrAll);
}

/** @type {(folder: string|null) => string} */
let _exportAsJsImpl = (folderOrAll) => {
  const snap = getShaderDebugSnapshot();
  const filtered = {};
  for (const [id, entry] of Object.entries(snap.params)) {
    if (folderOrAll && entry.folder !== folderOrAll) continue;
    filtered[id] = entry.value;
  }
  return `// dreamfall shader debug snapshot\nexport const shaderDebugOverrides = ${JSON.stringify(filtered, null, 2)};\n`;
};

/** Install structured export implementation (called from shaderDebugExport / register). */
export function setShaderDebugExportImpl(fn) {
  if (typeof fn === 'function') _exportAsJsImpl = fn;
}

// ---------------------------------------------------------------------------
// Introspection (pane + tests)
// ---------------------------------------------------------------------------

export function listShaderDebugParams() {
  return [...params.values()];
}

export function listShaderDebugFolders() {
  return [...folders.entries()].map(([name, meta]) => ({ name, ...meta }));
}

export function getShaderDebugParam(id) {
  return params.get(id) ?? null;
}

/**
 * Test / hot-reload helper — clears all registration state.
 * Not for production runtime use.
 */
export function __resetShaderDebugRegistryForTests() {
  params.clear();
  folders.clear();
  userOverrides.clear();
  listeners.clear();
}
