/**
 * Dev-only Tweakpane shell for ShaderDebugRegistry.
 *
 * Dynamic-imports tweakpane so production never sees the package name when
 * this module is excluded via virtual:dreamfall-shader-debug stubs.
 *
 * Important: do NOT full-rebuild the pane on every param-changed (slider drag).
 * Rebuilding mid-pointer-down remounts DOM under the cursor and makes folder
 * headers toggle when you meant to grab a slider.
 */

import {
  listShaderDebugParams,
  listShaderDebugFolders,
  onShaderDebugEvent,
  isUserOverride,
} from './shaderDebugRegistry.js';

/** @type {null | {
 *   root: HTMLElement,
 *   pane: import('tweakpane').Pane,
 *   folders: Map<string, import('tweakpane').FolderApi>,
 *   unsub: () => void,
 *   monitorTimer: number | null,
 *   visible: boolean,
 *   bindings: Map<string, { blade?: object, holder?: object, param: object, kind: string }>,
 * }} */
let state = null;

/**
 * Mount (or re-use) the Tweakpane shell.
 * @param {{ parent?: HTMLElement, visible?: boolean }} [opts]
 * @returns {Promise<{ setVisible: (v: boolean) => void, dispose: () => void, refresh: () => void } | null>}
 */
export async function mountShaderDebugPane(opts = {}) {
  const parent = opts.parent ?? (typeof document !== 'undefined' ? document.body : null);
  if (!parent) return null;

  if (state) {
    if (opts.visible !== undefined) setVisible(opts.visible);
    return getHandle();
  }

  let Tweakpane;
  try {
    Tweakpane = await import('tweakpane');
  } catch (err) {
    console.warn('[shader-debug] tweakpane unavailable', err);
    return null;
  }

  const root = document.createElement('div');
  root.className = 'shader-debug-pane';
  root.dataset.shaderDebug = '1';
  isolatePointerEvents(root);
  parent.appendChild(root);

  const pane = new Tweakpane.Pane({
    container: root,
    title: 'Render Debug',
    expanded: true,
  });

  state = {
    root,
    pane,
    folders: new Map(),
    /** @type {Map<string, { title: string, haystack: string }>} */
    folderIndex: new Map(),
    bindings: new Map(),
    unsub: () => {},
    monitorTimer: null,
    visible: opts.visible !== false,
    filterQuery: '',
  };

  setVisible(state.visible);
  rebuildPane();

  state.unsub = onShaderDebugEvent((type) => {
    // Full rebuild only when the *schema* changes — never on live value edits.
    if (type === 'registry-ready' || type === 'param-registered') {
      rebuildPane();
      return;
    }
    if (
      type === 'param-changed'
      || type === 'overrides-cleared'
      || type === 'rebind'
      || type === 'lut-dirty'
    ) {
      softRefresh();
    }
  });

  // ≤10 Hz: refresh monitor readouts only (no DOM rebuild).
  state.monitorTimer = globalThis.setInterval(() => {
    if (state?.visible) softRefresh({ monitorsOnly: true });
  }, 100);

  return getHandle();
}

function getHandle() {
  return {
    setVisible,
    dispose,
    refresh: rebuildPane,
  };
}

function setVisible(visible) {
  if (!state) return;
  state.visible = Boolean(visible);
  state.root.style.display = state.visible ? '' : 'none';
  state.root.setAttribute('aria-hidden', state.visible ? 'false' : 'true');
}

function dispose() {
  if (!state) return;
  state.unsub?.();
  if (state.monitorTimer != null) {
    globalThis.clearInterval(state.monitorTimer);
  }
  try {
    state.pane.dispose();
  } catch {
    /* ignore */
  }
  state.root.remove();
  state = null;
}

function isolatePointerEvents(el) {
  // Bubble-phase only — do not capture. Stopping on the root after children
  // handle the event keeps the game canvas from zooming/looking, without
  // interfering with Tweakpane's own pointer handling.
  //
  // Wheel: stopPropagation only — never preventDefault. The pane uses
  // overflow:auto; preventDefault blocked its own scrollbar/trackpad scroll
  // while the Horde folder (and other long folders) grew past max-height.
  const stop = (e) => {
    e.stopPropagation();
  };
  el.addEventListener('pointerdown', stop);
  el.addEventListener('pointermove', stop);
  el.addEventListener('pointerup', stop);
  el.addEventListener('wheel', stop, { passive: true });
  el.addEventListener('keydown', stop);
}

/** Remember folder expand state across rebuilds. */
function snapshotFolderExpanded() {
  /** @type {Map<string, boolean>} */
  const map = new Map();
  if (!state) return map;
  for (const [name, folder] of state.folders) {
    try {
      if (typeof folder.expanded === 'boolean') map.set(name, folder.expanded);
    } catch {
      /* ignore */
    }
  }
  // Root pane title bar
  try {
    if (typeof state.pane.expanded === 'boolean') {
      map.set('__root__', state.pane.expanded);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function ensureFolder(name, expandedFallback, expandedSnapshot) {
  if (!state) return null;
  if (state.folders.has(name)) return state.folders.get(name);
  const meta = listShaderDebugFolders().find((f) => f.name === name);
  const expanded = expandedSnapshot.has(name)
    ? expandedSnapshot.get(name)
    : (meta?.expanded ?? expandedFallback);
  const folder = state.pane.addFolder({
    title: meta?.title ?? name,
    expanded: Boolean(expanded),
  });
  state.folders.set(name, folder);
  return folder;
}

function rebuildPane() {
  if (!state) return;

  const expandedSnapshot = snapshotFolderExpanded();
  const preservedQuery = state.filterQuery ?? '';

  // Clear previous blades (keep pane shell)
  try {
    const children = [...(state.pane.children ?? [])];
    for (const child of children) {
      try {
        child.dispose?.();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  state.folders.clear();
  state.folderIndex.clear();
  state.bindings.clear();

  // Search always sits at the top (re-added after every rebuild).
  addFolderSearchBlade(preservedQuery);

  const params = listShaderDebugParams();
  if (params.length === 0) {
    const holder = { status: 'Waiting for registry…' };
    state.pane.addBinding(holder, 'status', { label: 'status', readonly: true });
    return;
  }

  const byFolder = new Map();
  for (const p of params) {
    const folder = p.folder || 'Other';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(p);
  }

  const folderPriority = {
    Dog: -1,
    Session: 0,
    Runtime: 1,
    Horde: 1.5,
    Look: 2,
    'Weather Control': 3,
    'Cloud Mode': 4,
    Rally: 5,
    Overlays: 6,
    'Sky / Sun': 10,
    Atmosphere: 11,
    'Clouds Shape': 12,
  };
  const order = [...byFolder.keys()].sort((a, b) => {
    const pa = folderPriority[a] ?? 50;
    const pb = folderPriority[b] ?? 50;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });

  for (const folderName of order) {
    const defaultExpanded = folderName === 'Dog'
      || folderName === 'Session'
      || folderName === 'Runtime'
      || folderName === 'Horde'
      || folderName === 'Weather Control'
      || folderName === 'Clouds Shape';
    const folderApi = ensureFolder(folderName, defaultExpanded, expandedSnapshot);
    const list = byFolder.get(folderName);
    for (const param of list) {
      bindParam(folderApi, param);
    }

    // Index folder title only (not control labels/help — searching "gun"
    // should not surface Horde via "gun-style sever" help text).
    const meta = listShaderDebugFolders().find((f) => f.name === folderName);
    const title = meta?.title ?? folderName;
    state.folderIndex.set(folderName, {
      title,
      haystack: `${folderName} ${title}`.toLowerCase(),
    });
  }

  applyFolderFilter();
}

/**
 * Search box at the top of the pane. Filters folders by folder title/name only.
 * @param {string} [initial]
 */
function addFolderSearchBlade(initial = '') {
  if (!state) return;
  state.filterQuery = String(initial ?? '');
  const holder = { query: state.filterQuery };
  const blade = state.pane.addBinding(holder, 'query', {
    label: 'Search folders',
  });
  blade.on('change', (ev) => {
    if (!state) return;
    // Prefer last event so we don't fight intermediate commits.
    if (ev?.last === false) {
      // Still update live while typing when Tweakpane emits continuous changes.
    }
    state.filterQuery = String(ev?.value ?? holder.query ?? '');
    applyFolderFilter();
  });
  // Keep a handle so softRefresh never treats this as a registry param.
  state.searchHolder = holder;
  state.searchBlade = blade;
}

/**
 * Show/hide folders by search string. Empty query shows everything.
 * Matching folders auto-expand so hits are visible.
 */
function applyFolderFilter() {
  if (!state) return;
  const q = String(state.filterQuery ?? '').trim().toLowerCase();
  for (const [name, folder] of state.folders) {
    const index = state.folderIndex.get(name);
    const haystack = index?.haystack ?? name.toLowerCase();
    const match = !q || haystack.includes(q);
    try {
      folder.hidden = !match;
      if (match && q) {
        folder.expanded = true;
      }
    } catch {
      // Fallback if FolderApi.hidden is unavailable.
      try {
        const el = folder.controller_?.view?.element ?? folder.element;
        if (el?.style) el.style.display = match ? '' : 'none';
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Update labels / monitor values in place — never remount blades.
 * @param {{ monitorsOnly?: boolean }} [opts]
 */
function softRefresh(opts = {}) {
  if (!state) return;
  for (const [id, binding] of state.bindings) {
    const { blade, holder, param, kind } = binding;
    if (!param) continue;
    try {
      if (kind === 'monitor') {
        if (holder) holder.value = formatMonitor(param);
        blade?.refresh?.();
      } else if (!opts.monitorsOnly) {
        // Pin marker on label (●) without tearing down the control.
        if (blade && kind !== 'action' && kind !== 'vec3') {
          try {
            blade.label = paramLabel(param);
          } catch {
            /* some blades are read-only label */
          }
        }
        // Keep binding holder in sync if external systemWrite changed the value
        // and this id is not user-pinned (or even if pinned, monitor-ish enums
        // from snapshot can drift — only refresh non-pinned to avoid fighting drag).
        if (holder && typeof param.get === 'function' && !isUserOverride(id)) {
          if (kind === 'float' || kind === 'int' || kind === 'bool' || kind === 'enum') {
            holder.value = param.get();
            blade?.refresh?.();
          } else if (kind === 'color') {
            holder.value = toColorObj(param.get());
            blade?.refresh?.();
          }
        }
      }
    } catch {
      /* ignore single binding failures */
    }
  }
}

/**
 * @param {import('tweakpane').FolderApi} folderApi
 * @param {import('./shaderDebugRegistry.js').ShaderDebugParam} param
 */
function bindParam(folderApi, param) {
  if (param.type === 'action') {
    const blade = folderApi
      .addButton({ title: param.label })
      .on('click', () => {
        try {
          param.action?.();
        } catch (err) {
          console.warn('[shader-debug] action failed', param.id, err);
        }
      });
    state.bindings.set(param.id, { blade, param, kind: 'action' });
    return;
  }

  if (param.type === 'monitor' || typeof param.set !== 'function') {
    const holder = { value: formatMonitor(param) };
    const blade = folderApi.addBinding(holder, 'value', {
      label: param.label,
      readonly: true,
    });
    blade.element.dataset.paramId = param.id;
    blade.element.dataset.monitor = '1';
    state.bindings.set(param.id, { blade, holder, param, kind: 'monitor' });
    return;
  }

  if (param.type === 'float' || param.type === 'int') {
    const holder = { value: Number(param.get()) };
    const opts = {
      label: paramLabel(param),
      min: param.min,
      max: param.max,
      step: param.step ?? (param.type === 'int' ? 1 : undefined),
    };
    const blade = folderApi.addBinding(holder, 'value', opts);
    blade.on('change', (ev) => {
      // Ignore Tweakpane's initial sync emit if any — only user/last.
      try {
        param.set(ev.value);
        // Update pin marker only; never rebuild.
        try { blade.label = paramLabel(param); } catch { /* ignore */ }
      } catch (err) {
        console.warn('[shader-debug] set failed', param.id, err);
      }
    });
    state.bindings.set(param.id, { blade, holder, param, kind: param.type });
    return;
  }

  if (param.type === 'bool') {
    const holder = { value: Boolean(param.get()) };
    const blade = folderApi.addBinding(holder, 'value', { label: paramLabel(param) });
    blade.on('change', (ev) => {
      try {
        param.set(ev.value);
        try { blade.label = paramLabel(param); } catch { /* ignore */ }
      } catch (err) {
        console.warn('[shader-debug] set failed', param.id, err);
      }
    });
    state.bindings.set(param.id, { blade, holder, param, kind: 'bool' });
    return;
  }

  if (param.type === 'enum') {
    const options = param.options && typeof param.options === 'object'
      ? param.options
      : {};
    let current = param.get?.();
    const values = Object.values(options);
    if (!values.includes(current) && values.length) {
      current = values[0];
    }
    const holder = { value: current };
    const blade = folderApi.addBinding(holder, 'value', {
      label: paramLabel(param),
      options,
    });
    blade.on('change', (ev) => {
      try {
        param.set(ev.value);
        try { blade.label = paramLabel(param); } catch { /* ignore */ }
      } catch (err) {
        console.warn('[shader-debug] set failed', param.id, err);
      }
    });
    state.bindings.set(param.id, { blade, holder, param, kind: 'enum' });
    return;
  }

  if (param.type === 'color') {
    const rgb = toColorObj(param.get());
    const holder = { value: rgb };
    const blade = folderApi.addBinding(holder, 'value', {
      label: paramLabel(param),
      color: { type: 'float' },
    });
    blade.on('change', (ev) => {
      try {
        const c = ev.value;
        param.set([c.r ?? c[0], c.g ?? c[1], c.b ?? c[2]]);
        try { blade.label = paramLabel(param); } catch { /* ignore */ }
      } catch (err) {
        console.warn('[shader-debug] set failed', param.id, err);
      }
    });
    state.bindings.set(param.id, { blade, holder, param, kind: 'color' });
    return;
  }

  if (param.type === 'vec3') {
    const arr = toVec3(param.get());
    const holder = { x: arr[0], y: arr[1], z: arr[2] };
    const blades = [];
    for (const axis of ['x', 'y', 'z']) {
      const blade = folderApi.addBinding(holder, axis, {
        label: `${paramLabel(param)}.${axis}`,
        min: param.min,
        max: param.max,
        step: param.step,
      });
      blade.on('change', () => {
        try {
          param.set([holder.x, holder.y, holder.z]);
        } catch (err) {
          console.warn('[shader-debug] set failed', param.id, err);
        }
      });
      blades.push(blade);
    }
    state.bindings.set(param.id, { blade: blades[0], holder, param, kind: 'vec3' });
    return;
  }

  const holder = { value: String(param.get?.() ?? '') };
  const blade = folderApi.addBinding(holder, 'value', { label: param.label, readonly: true });
  state.bindings.set(param.id, { blade, holder, param, kind: 'monitor' });
}

function paramLabel(param) {
  const pin = isUserOverride(param.id) ? ' ●' : '';
  return `${param.label}${pin}`;
}

function formatMonitor(param) {
  try {
    const v = param.get?.();
    if (v == null) return '—';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  } catch {
    return 'err';
  }
}

function toColorObj(v) {
  if (Array.isArray(v)) return { r: v[0] ?? 1, g: v[1] ?? 1, b: v[2] ?? 1 };
  if (v && typeof v === 'object' && 'r' in v) return { r: v.r, g: v.g, b: v.b };
  return { r: 1, g: 1, b: 1 };
}

function toVec3(v) {
  if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  if (v && typeof v === 'object') return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
  return [0, 0, 0];
}
