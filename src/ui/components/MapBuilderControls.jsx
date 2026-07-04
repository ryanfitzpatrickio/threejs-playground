import { For, Show, createSignal, createEffect, onCleanup, onMount } from 'solid-js';
import { TERRAIN_TEXTURE_LIBRARY } from '../../map/editorTerrainMaterial.js';

const MAP_CODEX_TOOLS = [
  {
    name: 'get_map_summary',
    description: 'Read current Dreamfall map editor terrain stats, selected object, atlas palette, and object transforms.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'select_object',
    description: 'Select the first map object whose name contains the query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_primitive',
    description: 'Add an atlas-textured primitive object to the map.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone', 'plane', 'player_spawn'] },
        name: { type: 'string' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        rotationDegrees: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        tile: { type: ['number', 'string'] },
        zIndex: { type: 'number' },
        textureRepeat: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_object',
    description: 'Move an object to an absolute world position, or move selected object when name is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        relative: { type: 'boolean' },
      },
      required: ['position'],
      additionalProperties: false,
    },
  },
  {
    name: 'scale_object',
    description: 'Set an object scale, or selected object scale when name is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      },
      required: ['scale'],
      additionalProperties: false,
    },
  },
  {
    name: 'rotate_object',
    description: 'Set object Euler rotation in degrees, or selected object rotation when name is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        rotationDegrees: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      },
      required: ['rotationDegrees'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_tile',
    description: 'Apply an atlas tile to an object. Tile may be a semantic label, 0-based index 0-99, or 1-based number 1-100.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, tile: { type: ['number', 'string'] } },
      required: ['tile'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_texture_repeat',
    description: 'Set atlas texture repeat for an object material.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        repeat: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      },
      required: ['repeat'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_z_index',
    description: 'Set layered z-index for flat overlapping objects.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, zIndex: { type: 'number' } },
      required: ['zIndex'],
      additionalProperties: false,
    },
  },
  {
    name: 'duplicate_object',
    description: 'Duplicate an object, or selected object when name is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_object',
    description: 'Delete an object, or selected object when name is omitted.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'paint_terrain',
    description: 'Apply one terrain brush stamp at a world position.',
    inputSchema: {
      type: 'object',
      properties: {
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        mode: { type: 'string', enum: ['raise', 'lower', 'smooth', 'flatten', 'noise', 'set'] },
        radius: { type: 'number' },
        strength: { type: 'number' },
        falloff: { type: 'string', enum: ['smooth', 'linear', 'none'] },
      },
      required: ['position'],
      additionalProperties: false,
    },
  },
];

export function MapBuilderControls(props) {
  const builder = () => props.builder;
  const snapshot = () => props.snapshot ?? {};

  const [brushMode, setBrushMode] = createSignal('raise');
  const [brushRadius, setBrushRadius] = createSignal(7.5);
  const [brushStrength, setBrushStrength] = createSignal(1.4);
  const [falloff, setFalloff] = createSignal('smooth');
  const [tool, setTool] = createSignal('sculpt');
  const [leftTab, setLeftTab] = createSignal('sculpt');
  const [objectTransformMode, setObjectTransformMode] = createSignal('select');
  const [confine, setConfine] = createSignal(false);
  const [status, setStatus] = createSignal('Ready');
  const [aiPrompt, setAiPrompt] = createSignal('');
  const [aiBusy, setAiBusy] = createSignal(false);
  const [aiProvider, setAiProvider] = createSignal('grok'); // 'grok' (headless JSON) | 'codex'
  const [codexThreadId, setCodexThreadId] = createSignal(null);
  const [aiText, setAiText] = createSignal('');
  const [blueprintName, setBlueprintName] = createSignal('');
  const [mapName, setMapName] = createSignal('');
  const [terrainTexBlend, setTerrainTexBlend] = createSignal(0.6);
  const [terrainTexTiling, setTerrainTexTiling] = createSignal(0.08);

  // Prefill the map-name input when a different saved map becomes current
  // (load/save), without clobbering it while the user is typing.
  let lastCurrentMapId;
  createEffect(() => {
    const cm = snapshot().currentMap;
    if (cm?.id === lastCurrentMapId) return;
    lastCurrentMapId = cm?.id;
    if (cm?.name) setMapName(cm.name);
  });

  const saveMap = () => {
    const b = builder();
    if (!b) return;
    const name = mapName().trim() || `Map ${new Date().toLocaleString()}`;
    try {
      const meta = b.saveMap(name);
      setMapName(meta.name);
      setStatus(`Saved map "${meta.name}"`);
    } catch (err) {
      setStatus(err?.message || 'Map save failed');
    }
  };

  const loadMap = (m) => {
    const b = builder();
    if (!b) return;
    const entry = b.loadMap(m.id);
    setStatus(entry ? `Loaded map "${entry.name}"` : 'Map load failed');
  };

  const deleteMap = (m) => {
    builder()?.deleteMap(m.id);
    setStatus(`Deleted map "${m.name}"`);
  };

  const saveBlueprint = () => {
    const b = builder();
    if (!b) return;
    const name = blueprintName().trim() || `Blueprint ${new Date().toLocaleString()}`;
    try {
      const meta = b.saveAsBlueprint(name);
      setStatus(`Saved blueprint "${meta.name}"`);
      setBlueprintName('');
    } catch (err) {
      setStatus(err?.message || 'Blueprint save failed');
    }
  };

  // Push local control values into the real builder when they change
  const pushBrush = () => {
    const b = builder();
    if (!b) return;
    b.setBrush({
      mode: brushMode(),
      radius: brushRadius(),
      strength: brushStrength(),
      falloff: falloff(),
    });
  };

  const pushTool = (t) => {
    setTool(t);
    const b = builder();
    if (b) b.setTool(t);
  };

  const pushConfine = (c) => {
    setConfine(c);
    const b = builder();
    if (b) b.setConfineToSelection(c);
  };

  // React to external snapshot changes (from builder onChange)
  const syncFromSnapshot = () => {
    const s = snapshot();
    if (s.brush) {
      setBrushMode(s.brush.mode ?? brushMode());
      setBrushRadius(s.brush.radius ?? brushRadius());
      setBrushStrength(s.brush.strength ?? brushStrength());
      setFalloff(s.brush.falloff ?? falloff());
    }
    if (s.tool) {
      setTool(s.tool);
      if (s.tool === 'object' || s.tool === 'sculpt' || s.tool === 'road' || s.tool === 'river') setLeftTab(s.tool);
    }
    if (s.objectTransformMode) setObjectTransformMode(s.objectTransformMode);
    if (typeof s.confineToSelection === 'boolean') setConfine(s.confineToSelection);
    if (s.terrainTexture) {
      if (typeof s.terrainTexture.blend === 'number') setTerrainTexBlend(s.terrainTexture.blend);
      if (typeof s.terrainTexture.tiling === 'number') setTerrainTexTiling(s.terrainTexture.tiling);
    }
  };

  // Keep local UI state in sync whenever the builder pushes a snapshot (e.g. after setBrush, loadProject, etc.)
  createEffect(() => {
    syncFromSnapshot();
  });

  const handleModeChange = (mode) => {
    setBrushMode(mode);
    pushBrush();
    if (tool() !== 'sculpt') pushTool('sculpt');
  };

  const handleRadius = (v) => {
    const val = Number(v);
    setBrushRadius(val);
    pushBrush();
  };

  const handleStrength = (v) => {
    const val = Number(v);
    setBrushStrength(val);
    pushBrush();
  };

  const handleFalloff = (v) => {
    setFalloff(v);
    pushBrush();
  };

  const doUndo = () => builder()?.undo();
  const doRedo = () => builder()?.redo();
  const doResetEdges = (scope) => builder()?.resetEdges(scope);

  const terrainTex = () => snapshot().terrainTexture ?? {};

  const selectTerrainTexture = (id) => {
    builder()?.setTerrainTexture(id || null);
    const label = TERRAIN_TEXTURE_LIBRARY.find((t) => t.id === id)?.label;
    setStatus(id ? `Terrain texture: ${label}` : 'Terrain texture cleared');
  };

  const handleTerrainBlend = (v) => {
    const val = Number(v);
    setTerrainTexBlend(val);
    builder()?.setTerrainTextureBlend(val);
  };

  const handleTerrainTiling = (v) => {
    const val = Number(v);
    setTerrainTexTiling(val);
    builder()?.setTerrainTextureTiling(val);
  };

  const doGenerate = (r) => {
    const b = builder();
    if (!b) return;
    // Generate around current camera target roughly
    const t = b.camTarget ?? { x: 0, z: 0 };
    const cx = Math.round(t.x / 32);
    const cz = Math.round(t.z / 32);
    b.generateAround(cx, cz, r);
    setStatus(`Generated ${r * 2 + 1}x${r * 2 + 1} around (${cx},${cz})`);
  };

  const doFrame = () => builder()?.frameAll();
  const doFocusOrigin = () => builder()?.focusChunk(0, 0);
  const doResetOrigin = () => {
    const b = builder();
    if (!b) return;
    b.focusChunk(0, 0);
    setStatus('Returned to origin');
  };
  const doNewLevel = () => {
    const b = builder();
    if (!b) return;
    b.newLevel();
    setAiText('');
    setStatus('New level started');
  };

  const doClearObjects = () => {
    const b = builder();
    if (!b) return;
    b.clearObjects?.();
    setStatus('Cleared all objects');
  };

  const doClearSelection = () => builder()?.clearSelection();
  const palettePreview = () => (snapshot().palette || []).slice(0, 36);
  const selectedObject = () => snapshot().selectedObject;
  const activeTileName = () => snapshot().activeTile ? `${snapshot().activeTile.number} ${snapshot().activeTile.name}` : 'None';

  const pushObjectTransformMode = (mode) => {
    setObjectTransformMode(mode);
    pushTool('object');
    builder()?.setObjectTransformMode?.(mode);
  };

  const addObject = (type) => {
    const b = builder();
    if (!b) return;
    const target = b.camTarget ?? { x: 0, y: 0, z: 0 };
    const isSpawn = type === 'player_spawn';
    const mesh = b.addPrimitive({
      type,
      name: isSpawn ? 'player_spawn' : undefined,
      position: [target.x, target.y + (isSpawn ? 1.1 : 1.5), target.z],
      scale: isSpawn ? [1, 1.5, 1] : (type === 'plane' ? [5, 1, 5] : [2, 1, 2]),
      tile: isSpawn ? 'blue_rune' : (snapshot().activeTile?.index ?? 0),
      textureRepeat: type === 'plane' ? [3, 3] : [1, 1],
    });
    pushTool('object');
    setLeftTab('object');
    setStatus(`Added ${mesh.name}`);
  };

  const setActiveTile = (tile) => {
    try {
      const result = builder()?.setActiveTile(tile);
      if (result?.activeTile) setStatus(`Atlas: ${result.activeTile.number} ${result.activeTile.name}`);
    } catch (err) {
      setStatus(err?.message || 'Tile selection failed');
    }
  };

  const createCodexSystemPrompt = () => {
    const b = builder();
    return `You are editing the Dreamfall map editor live through safe browser tools.
Use get_map_summary first unless the user asks for a tiny direct edit.
Coordinate system: X east/west, Y height, Z north/south. Terrain ground is usually near Y=0.
Prefer atlas-textured primitives for authored level geometry: platforms, walls, bridges, gates, marker planes, props, and blockout volumes.
Palette tiles are a 10x10 atlas. Use semantic tile labels or indices from this catalog:
${b?.formatTileCatalogForPrompt?.() || ''}
After edits, respond with a concise summary of what changed.`;
  };

  const executeCodexTool = (name, args = {}) => {
    const b = builder();
    if (!b) return { success: false, error: 'Map builder is not ready' };

    try {
      if (name === 'get_map_summary') return { success: true, scene: b.getSceneSummary() };
      if (name === 'select_object') return b.selectObjectByQuery(args.query);
      if (name === 'add_primitive') return { success: true, object: b.summarizeObject(b.addPrimitive(args)) };
      if (name === 'move_object') return b.editObjectTransform(args, 'move');
      if (name === 'scale_object') return b.editObjectTransform(args, 'scale');
      if (name === 'rotate_object') return b.editObjectTransform(args, 'rotate');
      if (name === 'set_tile') return b.setObjectTile(args);
      if (name === 'set_texture_repeat') return b.setObjectTextureRepeat(args);
      if (name === 'set_z_index') return b.setObjectZIndex(args);
      if (name === 'duplicate_object') return b.duplicateObject(args);
      if (name === 'delete_object') return b.deleteObject(args);
      if (name === 'paint_terrain') return b.paintTerrainAt(args);
      return { success: false, error: `Unknown tool: ${name}` };
    } catch (err) {
      console.error(err);
      return { success: false, error: err?.message || 'Tool failed' };
    }
  };

  const runCodexEdit = async () => {
    const prompt = aiPrompt().trim();
    if (!prompt || aiBusy()) return;

    setAiBusy(true);
    setAiText('');
    setStatus('Codex: connecting');

    try {
      const availability = await fetch('/api/codex/status', { headers: { Accept: 'application/json' } }).then((r) => r.json());
      if (!availability.available) throw new Error(availability.error || 'Codex CLI unavailable');

      await new Promise((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${location.host}/ws/codex`);
        let assistantText = '';

        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'start',
            model: 'gpt-5.4',
            threadId: codexThreadId(),
            systemPrompt: createCodexSystemPrompt(),
            tools: MAP_CODEX_TOOLS,
            userMessage: prompt,
          }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'thread') {
            setCodexThreadId(msg.threadId);
            return;
          }
          if (msg.type === 'status') {
            setStatus(`Codex: ${msg.status}`);
            return;
          }
          if (msg.type === 'delta') {
            assistantText += msg.text || '';
            setAiText(assistantText);
            return;
          }
          if (msg.type === 'tool_call') {
            const result = executeCodexTool(msg.name, msg.args || {});
            ws.send(JSON.stringify({
              type: 'tool_result',
              id: msg.id,
              result: JSON.stringify(result),
              success: result.success !== false,
            }));
            return;
          }
          if (msg.type === 'turn_complete') {
            setAiText(msg.text || assistantText);
            ws.close();
            resolve();
            return;
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message || 'Codex error'));
          }
        };

        ws.onerror = () => reject(new Error('Codex WebSocket failed'));
      });

      setAiPrompt('');
      setStatus('Codex edit applied');
    } catch (err) {
      console.error(err);
      setStatus(`Codex error: ${err?.message || 'edit failed'}`);
    } finally {
      setAiBusy(false);
    }
  };

  const runGrokEdit = async () => {
    const prompt = aiPrompt().trim();
    if (!prompt || aiBusy()) return;

    setAiBusy(true);
    setAiText('');
    setStatus('Grok: connecting');

    try {
      const availability = await fetch('/api/grok/status', { headers: { Accept: 'application/json' } }).then((r) => r.json());
      if (!availability.available) throw new Error(availability.error || 'Grok CLI unavailable');

      setStatus('Grok: generating (headless)…');

      const b = builder();
      const summary = b ? b.getSceneSummary() : null;

      const res = await fetch('/api/grok/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt, summary, mode: 'blueprint' }),
      }).then((r) => r.json());

      if (!res || res.success === false) {
        const msg = res?.error || 'Grok generation failed';
        if (res?.partial) setAiText(`Partial output:\n${String(res.partial).slice(0, 400)}`);
        throw new Error(msg);
      }

      if (res.project && b && typeof b.loadProjectFromJSON === 'function') {
        try {
          b.loadProjectFromJSON(res.project);
          setStatus('Grok: JSON project loaded into editor');
        } catch (applyErr) {
          console.error(applyErr);
          setStatus(`Grok: loaded with warnings: ${applyErr?.message || ''}`);
        }
      } else {
        setStatus('Grok: received response (no project applied)');
      }

      setAiText(res.summary || 'Grok returned a result.');
      setAiPrompt('');
    } catch (err) {
      console.error(err);
      setStatus(`Grok error: ${err?.message || 'generation failed'}`);
      if (!aiText().startsWith('Partial')) {
        setAiText(err?.message || 'See console');
      }
    } finally {
      setAiBusy(false);
    }
  };

  // Project JSON export/import as files (the primary save/load is the
  // SQLite-backed saved-maps list in the footer).
  let fileInput;

  const exportProjectJSON = () => {
    const b = builder();
    if (!b) return;
    const json = b.getProjectJSON();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dreamfall-terrain-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('Project JSON exported');
  };

  const triggerLoadProject = () => fileInput?.click();

  const onProjectFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const b = builder();
      if (b) {
        b.loadProjectFromJSON(json);
        setStatus(`Loaded project (${json.chunks?.length ?? 0} authored chunks)`);
      }
    } catch (err) {
      console.error('Failed to load project', err);
      setStatus('Load failed — see console');
    } finally {
      e.target.value = ''; // allow re-select same file
    }
  };

  // Runtime JSON export (for the game)
  const exportRuntime = () => {
    const b = builder();
    if (!b) return;
    const json = b.exportRuntimeJSON();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dreamfall-runtime-chunks-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('Runtime JSON exported');
  };

  // GLB export (layered)
  const exportGLB = async (scope) => {
    const b = builder();
    if (!b) return;
    setStatus('Exporting GLB...');
    try {
      const arrayBuffer = await b.exportGLB(scope);
      const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dreamfall-terrain-${scope}-${Date.now()}.glb`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus(`GLB exported (${scope})`);
    } catch (err) {
      console.error('GLB export failed', err);
      setStatus('GLB export failed — see console');
    }
  };

  // Keyboard shortcuts (global, only active when builder is mounted)
  const onKey = (e) => {
    // Don't trigger shortcuts while typing in a form field (e.g. naming a
    // blueprint/object) — 'b' would otherwise toggle the sculpt tool mid-type.
    const t = e.target;
    if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
      || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!builder()) return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    }
    if (e.key.toLowerCase() === 'b') {
      e.preventDefault();
      pushTool(tool() === 'sculpt' ? 'view' : 'sculpt');
    }
    if (e.key === '[') {
      handleRadius(Math.max(1, brushRadius() - 1.5));
    }
    if (e.key === ']') {
      handleRadius(Math.min(48, brushRadius() + 1.5));
    }
    if (e.key.toLowerCase() === 'r' && e.shiftKey) {
      e.preventDefault();
      doResetEdges('visible');
    }
  };

  onMount(() => {
    globalThis.addEventListener('keydown', onKey);
  });
  onCleanup(() => {
    globalThis.removeEventListener('keydown', onKey);
  });

  return (
    <div class="map-builder-ui">
      <aside class="map-editor-panel map-editor-left" aria-label="Map editor tools">
        <div class="panel-title-row">
          <h2>Map Editor</h2>
          <button
            class="tb-btn small"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true }))}
          >
            Play
          </button>
        </div>

        <section class="editor-section editor-tabs-section">
          <div class="segmented-control four">
            <button
              class={leftTab() === 'sculpt' ? 'active' : ''}
              onClick={() => {
                setLeftTab('sculpt');
                pushTool('sculpt');
              }}
            >
              Sculpt
            </button>
            <button
              class={leftTab() === 'object' ? 'active' : ''}
              onClick={() => {
                setLeftTab('object');
                pushTool('object');
              }}
            >
              Object
            </button>
            <button
              class={leftTab() === 'road' ? 'active' : ''}
              onClick={() => {
                setLeftTab('road');
                pushTool('road');
              }}
            >
              Road
            </button>
            <button
              class={leftTab() === 'river' ? 'active' : ''}
              onClick={() => {
                setLeftTab('river');
                pushTool('river');
              }}
            >
              River
            </button>
          </div>
          <button class={`tb-btn full-width ${tool() === 'view' ? 'active' : ''}`} onClick={() => pushTool('view')}>
            View / Orbit
          </button>
        </section>

        {leftTab() === 'sculpt' && (
          <>
            <section class="editor-section">
              <h3>Sculpt</h3>
              <div class="tool-grid">
                {['raise', 'lower', 'smooth', 'flatten', 'noise', 'set'].map((m) => (
                  <button class={`tb-btn ${brushMode() === m ? 'active' : ''}`} onClick={() => handleModeChange(m)}>
                    {m}
                  </button>
                ))}
              </div>
              <label class="field-row">
                <span>Radius</span>
                <input type="range" min="1" max="42" step="0.5" value={brushRadius()} onInput={(e) => handleRadius(e.currentTarget.value)} />
                <strong>{brushRadius().toFixed(1)}</strong>
              </label>
              <label class="field-row">
                <span>Strength</span>
                <input type="range" min="0.1" max="6" step="0.1" value={brushStrength()} onInput={(e) => handleStrength(e.currentTarget.value)} />
                <strong>{brushStrength().toFixed(1)}</strong>
              </label>
              <label class="field-row">
                <span>Falloff</span>
                <select value={falloff()} onChange={(e) => handleFalloff(e.currentTarget.value)}>
                  <option value="smooth">Smooth</option>
                  <option value="linear">Linear</option>
                  <option value="none">None</option>
                </select>
              </label>
            </section>

            <section class="editor-section">
              <h3>Terrain</h3>
              <div class="button-grid">
                <button class="tb-btn" onClick={doUndo} disabled={!snapshot().canUndo}>Undo</button>
                <button class="tb-btn" onClick={doRedo} disabled={!snapshot().canRedo}>Redo</button>
                <button class="tb-btn" onClick={() => doResetEdges('visible')}>Reset Edges</button>
                <button class="tb-btn" onClick={doFrame}>Frame All</button>
                <button class="tb-btn" onClick={doFocusOrigin}>Origin</button>
                <button class="tb-btn" onClick={() => doGenerate(1)}>+3x3</button>
                <button class="tb-btn" onClick={() => doGenerate(2)}>+5x5</button>
              </div>
              <label class="toggle-row">
                <input type="checkbox" checked={confine()} onChange={(e) => pushConfine(e.currentTarget.checked)} />
                <span>Confine to selection</span>
              </label>
              <button class="tb-btn small" onClick={doClearSelection}>Clear Selection</button>
            </section>

            <section class="editor-section">
              <h3>Terrain Texture</h3>
              <p style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4, margin: '2px 0 8px' }}>
                Blend a built-in texture over the whole terrain.
              </p>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', margin: '0 0 8px' }}>
                <div
                  style={{
                    width: '44px', height: '44px', 'border-radius': '5px', 'flex-shrink': 0,
                    border: '1px solid rgb(247 244 232 / 18%)',
                    background: terrainTex().preview ? `center / cover no-repeat url(${terrainTex().preview})` : '#9aa38f',
                  }}
                  aria-hidden="true"
                />
                <select
                  style={{ flex: 1, 'min-width': 0 }}
                  value={terrainTex().id ?? ''}
                  disabled={!builder()}
                  onChange={(e) => selectTerrainTexture(e.currentTarget.value)}
                >
                  <option value="">None (base ground)</option>
                  <For each={TERRAIN_TEXTURE_LIBRARY}>
                    {(t) => <option value={t.id}>{t.label}</option>}
                  </For>
                </select>
              </div>
              <label class="field-row">
                <span>Blend</span>
                <input
                  type="range" min="0" max="1" step="0.01"
                  value={terrainTexBlend()}
                  disabled={!terrainTex().hasTexture}
                  onInput={(e) => handleTerrainBlend(e.currentTarget.value)}
                />
                <strong>{Math.round(terrainTexBlend() * 100)}%</strong>
              </label>
              <label class="field-row">
                <span>Tiling</span>
                <input
                  type="range" min="0.01" max="0.5" step="0.01"
                  value={terrainTexTiling()}
                  disabled={!terrainTex().hasTexture}
                  onInput={(e) => handleTerrainTiling(e.currentTarget.value)}
                />
                <strong>{terrainTexTiling().toFixed(2)}</strong>
              </label>
            </section>
          </>
        )}

        {leftTab() === 'object' && (
          <>
            <section class="editor-section">
              <h3>Select Tool</h3>
              <div class="segmented-control four">
                <button class={objectTransformMode() === 'select' ? 'active' : ''} disabled={!builder()} onClick={() => pushObjectTransformMode('select')}>
                  Select
                </button>
                <button class={objectTransformMode() === 'move' ? 'active' : ''} disabled={!builder()} onClick={() => pushObjectTransformMode('move')}>
                  Move
                </button>
                <button class={objectTransformMode() === 'rotate' ? 'active' : ''} disabled={!builder()} onClick={() => pushObjectTransformMode('rotate')}>
                  Rotate
                </button>
                <button class={objectTransformMode() === 'scale' ? 'active' : ''} disabled={!builder()} onClick={() => pushObjectTransformMode('scale')}>
                  Scale
                </button>
              </div>
            </section>

            <section class="editor-section">
              <h3>Add Object</h3>
              <div class="button-grid">
                <button class="tb-btn" disabled={!builder()} onClick={() => addObject('box')}>Box</button>
                <button class="tb-btn" disabled={!builder()} onClick={() => addObject('plane')}>Plane</button>
                <button class="tb-btn" disabled={!builder()} onClick={() => addObject('cylinder')}>Cylinder</button>
                <button class="tb-btn" disabled={!builder()} onClick={() => addObject('sphere')}>Sphere</button>
                <button class="tb-btn" disabled={!builder()} onClick={() => addObject('cone')}>Cone</button>
                <button class="tb-btn primary" disabled={!builder()} onClick={() => addObject('player_spawn')}>Player Spawn</button>
              </div>
              <button class="tb-btn danger" disabled={!builder()} onClick={doClearObjects} style={{ marginTop: '6px', width: '100%' }}>
                Clear All Objects
              </button>
            </section>

            <section class="editor-section">
              <h3>Scene Objects</h3>
              <Show
                when={(snapshot().objectList ?? []).length > 0}
                fallback={<p style={{ 'font-size': '11px', color: '#6f746a', margin: '2px 0' }}>No objects yet — add one above.</p>}
              >
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '3px', 'max-height': '220px', 'overflow-y': 'auto' }}>
                  <For each={snapshot().objectList}>
                    {(obj) => {
                      const active = () => obj.name === selectedObject()?.name;
                      return (
                        <div
                          style={{
                            display: 'flex',
                            'align-items': 'center',
                            gap: '6px',
                            padding: '4px 6px',
                            background: active() ? 'rgb(74 111 165 / 28%)' : '#262a23',
                            border: `1px solid ${active() ? '#5a7fb5' : 'rgb(247 244 232 / 12%)'}`,
                            'border-radius': '5px',
                            cursor: 'pointer',
                          }}
                          onClick={() => builder()?.selectObjectAt(obj.index)}
                          title="Select this object"
                        >
                          <span style={{ 'font-size': '10px', color: '#7f857a', 'text-transform': 'uppercase', 'min-width': '38px' }}>{obj.type}</span>
                          <span style={{ flex: 1, 'min-width': 0, 'font-size': '12px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{obj.name}</span>
                          <button
                            class="tb-btn small danger"
                            onClick={(e) => { e.stopPropagation(); builder()?.deleteObjectAt(obj.index); }}
                            title="Delete object"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </section>

            <section class="editor-section">
              <h3>Selected Object</h3>
              <dl class="inspector-list compact">
                <div>
                  <dt>Object</dt>
                  <dd>{selectedObject()?.name || 'None'}</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{selectedObject()?.type || '-'}</dd>
                </div>
                <div>
                  <dt>Tile</dt>
                  <dd>{selectedObject()?.tile?.name || activeTileName()}</dd>
                </div>
              </dl>
              <div class="button-grid">
                <button class="tb-btn" onClick={() => builder()?.duplicateObject({})} disabled={!selectedObject()}>Duplicate</button>
                <button class="tb-btn danger" onClick={() => builder()?.deleteObject({})} disabled={!selectedObject()}>Delete</button>
              </div>
            </section>
          </>
        )}

        {leftTab() === 'road' && (
          <section class="editor-section">
            <h3>Road</h3>
            <p style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4, margin: '2px 0 8px' }}>
              Click terrain to add spline points · Enter or double-click to finish · Esc cancels · drag a road to move · Del removes. Roads conform to the terrain they sit on.
            </p>
            <label class="field-row">
              <span>Width</span>
              <input type="range" min="2" max="40" step="1" value={snapshot().roadWidth ?? 8} onInput={(e) => builder()?.setRoadWidth(e.currentTarget.value)} />
              <strong>{(snapshot().roadWidth ?? 8).toFixed(0)}</strong>
            </label>
            <label class="field-row">
              <span>Elevation</span>
              <select value={snapshot().roadElevation == null ? 'terrain' : 'fixed'} onChange={(e) => builder()?.setRoadElevation(e.currentTarget.value === 'fixed' ? 0 : null)}>
                <option value="terrain">Follow terrain</option>
                <option value="fixed">Fixed height</option>
              </select>
            </label>
            {snapshot().roadElevation != null && (
              <label class="field-row">
                <span>World Y</span>
                <input type="number" step="0.5" value={snapshot().roadElevation} onChange={(e) => builder()?.setRoadElevation(e.currentTarget.value)} />
                <strong>m</strong>
              </label>
            )}
            <div class="button-grid">
              <button class="tb-btn" disabled={!snapshot().roadDrafting} onClick={() => builder()?.finishRoadDraft()}>Finish</button>
              <button class="tb-btn" disabled={!snapshot().roadDrafting} onClick={() => builder()?.cancelRoadDraft()}>Cancel</button>
            </div>
            <div class="button-grid">
              <button class="tb-btn" disabled={!snapshot().selectedRoadId} onClick={() => builder()?.selectRoadRiver(null)}>Deselect</button>
              <button class="tb-btn danger" disabled={!snapshot().selectedRoadId} onClick={() => builder()?.deleteSelectedRoadRiver()}>Delete</button>
            </div>
            <p style={{ 'font-size': '11px', color: '#7f857a', margin: '4px 0 0' }}>
              {snapshot().roadDrafting ? 'Drawing… ' : ''}{snapshot().roadsCount ?? 0} road{(snapshot().roadsCount ?? 0) === 1 ? '' : 's'}
              {snapshot().selectedRoadId ? ' · selected' : ''}
            </p>
          </section>
        )}

        {leftTab() === 'river' && (
          <section class="editor-section">
            <h3>River</h3>
            <p style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4, margin: '2px 0 8px' }}>
              Click terrain to add spline points · Enter or double-click to finish · Esc cancels · drag a river to move · Del removes. Rivers carve a channel into the terrain.
            </p>
            <label class="field-row">
              <span>Width</span>
              <input type="range" min="2" max="60" step="1" value={snapshot().riverWidth ?? 10} onInput={(e) => builder()?.setRiverWidth(e.currentTarget.value)} />
              <strong>{(snapshot().riverWidth ?? 10).toFixed(0)}</strong>
            </label>
            <label class="field-row">
              <span>Depth</span>
              <input type="range" min="1" max="30" step="1" value={snapshot().riverDepth ?? 6} onInput={(e) => builder()?.setRiverDepth(e.currentTarget.value)} />
              <strong>{(snapshot().riverDepth ?? 6).toFixed(0)}</strong>
            </label>
            <div class="button-grid">
              <button class="tb-btn" disabled={!snapshot().riverDrafting} onClick={() => builder()?.finishRiverDraft()}>Finish</button>
              <button class="tb-btn" disabled={!snapshot().riverDrafting} onClick={() => builder()?.cancelRiverDraft()}>Cancel</button>
            </div>
            <div class="button-grid">
              <button class="tb-btn" disabled={!snapshot().selectedRiverId} onClick={() => builder()?.selectRoadRiver(null)}>Deselect</button>
              <button class="tb-btn danger" disabled={!snapshot().selectedRiverId} onClick={() => builder()?.deleteSelectedRoadRiver()}>Delete</button>
            </div>
            <p style={{ 'font-size': '11px', color: '#7f857a', margin: '4px 0 0' }}>
              {snapshot().riverDrafting ? 'Drawing… ' : ''}{snapshot().riversCount ?? 0} river{(snapshot().riversCount ?? 0) === 1 ? '' : 's'}
              {snapshot().selectedRiverId ? ' · selected' : ''}
            </p>
          </section>
        )}
      </aside>

      <aside class="map-editor-panel map-editor-right" aria-label="Map editor inspector">
        <section class="editor-section">
          <h3>
            AI CLI
            <select
              value={aiProvider()}
              onChange={(e) => setAiProvider(e.currentTarget.value)}
              style={{ 'margin-left': '6px', 'font-size': '11px', padding: '1px 4px', 'vertical-align': 'middle' }}
              disabled={aiBusy()}
            >
              <option value="grok">Grok (headless)</option>
              <option value="codex">Codex</option>
            </select>
          </h3>
          <textarea
            value={aiPrompt()}
            disabled={aiBusy() || !builder()}
            placeholder={aiProvider() === 'grok' ? 'Describe blueprint/level to build (Grok returns JSON project)' : 'Ask Codex to edit the map'}
            onInput={(e) => setAiPrompt(e.currentTarget.value)}
          />
          <button
            class="tb-btn primary full-width"
            disabled={aiBusy() || !aiPrompt().trim()}
            onClick={() => {
              if (aiProvider() === 'grok') runGrokEdit(); else runCodexEdit();
            }}
          >
            {aiBusy() ? 'Working…' : (aiProvider() === 'grok' ? 'Generate JSON' : 'Apply Edit')}
          </button>
          {aiText() && <p class="codex-result">{aiText()}</p>}
          <p style={{ 'font-size': '10px', color: '#6f746a', margin: '4px 0 0' }}>
            {aiProvider() === 'grok' ? 'Headless: full project JSON replaces editor state.' : 'Live tools: incremental edits.'}
          </p>
        </section>

        <section class="editor-section">
          <h3>Selection</h3>
          <dl class="inspector-list">
            <div>
              <dt>Object</dt>
              <dd>{selectedObject()?.name || 'None'}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{selectedObject()?.type || '-'}</dd>
            </div>
            <div>
              <dt>Tile</dt>
              <dd>{selectedObject()?.tile?.name || activeTileName()}</dd>
            </div>
          </dl>
        </section>

        <section class="editor-section metrics-section">
          <h3>Scene</h3>
          <div class="metric-grid">
            <span><strong>{snapshot().authoredCount ?? 0}</strong> authored</span>
            <span><strong>{snapshot().stats?.liveCount ?? 0}</strong> live</span>
            <span><strong>{snapshot().objectsCount ?? 0}</strong> objects</span>
            <span><strong>{snapshot().roadsCount ?? 0}</strong> roads</span>
            <span><strong>{snapshot().riversCount ?? 0}</strong> rivers</span>
          </div>
        </section>

        <section class="editor-section">
          <h3>Blueprints</h3>
          <input
            style={{ width: '100%', 'box-sizing': 'border-box', padding: '6px 8px', background: '#2c302a', border: '1px solid rgb(247 244 232 / 14%)', 'border-radius': '5px', color: '#e7e9e2', 'font-size': '12px' }}
            placeholder="Blueprint name"
            value={blueprintName()}
            onInput={(e) => setBlueprintName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveBlueprint(); }}
          />
          <button class="tb-btn primary full-width" disabled={!builder()} onClick={saveBlueprint}>
            Save as Blueprint
          </button>
          <p style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4, margin: '2px 0' }}>
            Saved blueprints can be placed into the world map as entities.
          </p>
          <Show
            when={(snapshot().blueprints ?? []).length > 0}
            fallback={<p style={{ 'font-size': '11px', color: '#6f746a' }}>No saved blueprints yet.</p>}
          >
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', 'max-height': '180px', 'overflow-y': 'auto' }}>
              <For each={snapshot().blueprints}>
                {(bp) => (
                  <div
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '5px',
                      padding: '5px 6px',
                      background: '#262a23',
                      border: '1px solid rgb(247 244 232 / 12%)',
                      'border-radius': '5px',
                    }}
                  >
                    <div style={{ flex: 1, 'min-width': 0 }}>
                      <div style={{ 'font-size': '12px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{bp.name}</div>
                      <div style={{ 'font-size': '10px', color: '#7f857a' }}>{bp.chunks} chunks · {bp.objects} objects</div>
                    </div>
                    <button
                      class="tb-btn small"
                      onClick={() => { builder()?.loadBlueprint(bp.id); setStatus(`Loaded "${bp.name}"`); }}
                      title="Load into editor"
                    >
                      Load
                    </button>
                    <button
                      class="tb-btn small danger"
                      onClick={() => builder()?.deleteBlueprint(bp.id)}
                      title="Delete blueprint"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </aside>

      <footer class="map-editor-bottom">
        <div class="status-line">{status()}</div>

        <section class="maps-section" aria-label="Saved maps">
          <div class="maps-header">
            <span>Maps</span>
            <input
              class="maps-name-input"
              placeholder="Map name"
              value={mapName()}
              onInput={(e) => setMapName(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveMap(); }}
            />
            <button class="tb-btn small primary" disabled={!builder()} onClick={saveMap}>
              Save Map
            </button>
          </div>
          <div class="maps-strip">
            <Show
              when={(snapshot().maps ?? []).length > 0}
              fallback={<span class="maps-empty">No saved maps yet.</span>}
            >
              <For each={snapshot().maps}>
                {(m) => (
                  <div class={`map-card ${snapshot().currentMap?.id === m.id ? 'active' : ''}`}>
                    <button class="map-card-load" onClick={() => loadMap(m)} title={`Load "${m.name}"`}>
                      <span class="map-card-name">{m.name}</span>
                      <span class="map-card-meta">{m.chunks} chunks · {m.objects} obj</span>
                    </button>
                    <button
                      class="tb-btn small danger"
                      onClick={() => deleteMap(m)}
                      title="Delete map"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </section>

        <section class="atlas-section" aria-label="Atlas tiles">
          <div class="atlas-header">
            <span>Atlas</span>
            <strong>{activeTileName()}</strong>
          </div>
          <div class="atlas-strip">
            <For each={palettePreview()}>
              {(tile) => (
                <button
                  class={`atlas-swatch ${snapshot().activeTile?.index === tile.index ? 'active' : ''}`}
                  title={`${tile.number}: ${tile.name}`}
                  style={{ '--tile-hue': `${(tile.index * 37) % 360}deg` }}
                  onClick={() => setActiveTile(tile.index)}
                >
                  {tile.number}
                </button>
              )}
            </For>
          </div>
        </section>

        <div class="export-actions">
          <button class="tb-btn small" onClick={doResetOrigin} disabled={!builder()}>Reset Origin</button>
          <button class="tb-btn small danger" onClick={doNewLevel} disabled={!builder()}>New Level</button>
          <button class="tb-btn small" onClick={saveBlueprint} disabled={!builder()}>Save Blueprint</button>
          <button class="tb-btn small" onClick={exportProjectJSON}>Export JSON</button>
          <button class="tb-btn small" onClick={triggerLoadProject}>Import JSON</button>
          <input ref={fileInput} type="file" accept="application/json" style={{ display: 'none' }} onChange={onProjectFile} />
          <button class="tb-btn small primary" onClick={exportRuntime}>Runtime JSON</button>
          <button class="tb-btn small" onClick={() => exportGLB('visible')}>GLB Visible</button>
          <button class="tb-btn small" onClick={() => exportGLB('authored')}>GLB Authored</button>
        </div>
      </footer>
    </div>
  );
}
