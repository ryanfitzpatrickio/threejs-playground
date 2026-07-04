import { For, Show, createSignal, createMemo, onCleanup, onMount } from 'solid-js';
import { ZONE_TYPES, ZONE_TYPE_ORDER, POI_KINDS, POI_KIND_ORDER, ENTITY_GROUND_MODES, ENTITY_GROUND_MODE_ORDER, TERRAIN_BIOMES, TERRAIN_BIOME_ORDER, CITY_STYLES, CITY_STYLE_ORDER } from '../../world/worldMap/worldMapSchema.js';
import { listScenes, WORLDMAP_DRAFT_ID } from '../../world/worldMap/worldMapScenes.js';
import { listBlueprints } from '../../map/blueprintLibrary.js';
import { getFileStoreRevision, subscribeFileStore, ensureFileStore } from '../../store/fileStore.js';
import { TRACK_CROSS_SECTIONS, TRACK_CROSS_SECTION_ORDER } from '../../game/world/trackCrossSection.js';
import { ROAD_SURFACES, ROAD_SURFACE_ORDER } from '../../world/worldMap/roadSurface.js';

const TOOLS = [
  { id: 'select', label: 'Select' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'city', label: 'City' },
  { id: 'loopout', label: 'Loop-out' },
  { id: 'wilds', label: 'Wilds' },
  { id: 'road', label: 'Road' },
  { id: 'river', label: 'River' },
  { id: 'poi', label: 'POI' },
  { id: 'entity', label: 'Entity' },
  { id: 'spawn', label: 'Spawn' },
  { id: 'district', label: 'District' },
  { id: 'pan', label: 'Pan' },
];

const ZONE_TOOLS = new Set(['terrain', 'city', 'loopout', 'wilds']);

const h2 = {
  'font-size': '11px',
  'text-transform': 'uppercase',
  'letter-spacing': '0.5px',
  color: '#8d9384',
  margin: '4px 0 2px',
};

const btn = (active) => ({
  padding: '6px 9px',
  background: active ? '#4a6fa5' : '#2c302a',
  border: `1px solid ${active ? '#5a7fb5' : 'rgb(247 244 232 / 14%)'}`,
  'border-radius': '5px',
  color: active ? '#fff' : '#cfd2c8',
  cursor: 'pointer',
  'font-size': '12px',
});

const field = {
  width: '100%',
  'box-sizing': 'border-box',
  padding: '6px 8px',
  background: '#2c302a',
  border: '1px solid rgb(247 244 232 / 14%)',
  'border-radius': '5px',
  color: '#e7e9e2',
  'font-size': '12px',
};

export function WorldMapControls(props) {
  const snap = () => {
    const value = props.snapshot;
    return typeof value === 'function' ? (value() ?? {}) : (value ?? {});
  };
  const editor = () => props.editor;

  const [storeRevision, setStoreRevision] = createSignal(getFileStoreRevision());
  onMount(() => { void ensureFileStore().then(() => setStoreRevision(getFileStoreRevision())); });
  onCleanup(subscribeFileStore(() => setStoreRevision(getFileStoreRevision())));

  const scenes = createMemo(() => {
    storeRevision();
    snap();
    return listScenes();
  });

  const defaultWorldScene = createMemo(() => scenes().find((s) => s.defaultRole === 'world') ?? null);
  const defaultRallyScene = createMemo(() => scenes().find((s) => s.defaultRole === 'rally') ?? null);

  const blueprints = createMemo(() => {
    storeRevision();
    snap();
    return listBlueprints();
  });

  // AI CLI (Codex live tools or Grok headless JSON) — same UX as blueprint editor
  const [aiPrompt, setAiPrompt] = createSignal('');
  const [aiBusy, setAiBusy] = createSignal(false);
  const [aiProvider, setAiProvider] = createSignal('grok'); // grok | codex
  const [aiText, setAiText] = createSignal('');
  const [aiCodexThreadId, setAiCodexThreadId] = createSignal(null);

  let fileInput;

  const [sceneName, setSceneName] = createSignal('');
  const saveScene = () => {
    const e = editor();
    if (!e) return;
    const name = (sceneName().trim() || snap().name || 'Untitled World');
    e.saveSceneAs(name);
    setSceneName('');
  };

  // Play the current working draft: flush the autosave first so the World builds
  // exactly what's on the canvas, then ask the app to enter World on the draft.
  const playDraft = () => {
    editor()?.flushAutosave?.();
    props.onPlayScene?.(WORLDMAP_DRAFT_ID);
  };
  const play = (id) => props.onPlayScene?.(id);

  const call = (fn) => () => { const e = editor(); if (e) fn(e); };
  const num = (e) => (e.target.value === '' ? undefined : Number(e.target.value));

  // --- AI Codex / Grok support (parallel to MapBuilderControls) ---
  const WORLD_MAP_CODEX_TOOLS = [
    {
      name: 'get_map_summary',
      description: 'Return full current world map state including bounds, existing POIs (with exact positions and kinds — use these as anchors to steer roads, zones and entities), zones, roads, rivers, entities and available blueprints. Always call this first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'add_rect_zone',
      description: 'Add a rectangular zone. type one of terrain,city,wilds,loopout. rect in world units inside current bounds.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          rect: { type: 'object', properties: { minX: { type: 'number' }, minZ: { type: 'number' }, maxX: { type: 'number' }, maxZ: { type: 'number' } }, required: ['minX', 'minZ', 'maxX', 'maxZ'] },
          props: { type: 'object' },
        },
        required: ['type', 'rect'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_poly_zone',
      description: 'Add a polygon zone (3+ points).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          points: { type: 'array' },
          props: { type: 'object' },
        },
        required: ['type', 'points'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_road',
      description: 'Add a road spline. points is array of {x,z} or [x,z]. Must stay inside map bounds. Use multiple points to span the map.',
      inputSchema: {
        type: 'object',
        properties: {
          points: { type: 'array', items: { oneOf: [{ type: 'array', minItems: 2, maxItems: 2 }, { type: 'object' }] } },
          width: { type: 'number' },
        },
        required: ['points'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_river',
      description: 'Add a river spline (carves down). points array, optional width/depth/oceanLeft/oceanRight.',
      inputSchema: {
        type: 'object',
        properties: {
          points: { type: 'array' },
          width: { type: 'number' },
          depth: { type: 'number' },
          oceanLeft: { type: 'boolean' },
          oceanRight: { type: 'boolean' },
        },
        required: ['points'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_poi',
      description: 'Add a POI (spawn/landmark/city_gate).',
      inputSchema: {
        type: 'object',
        properties: { kind: { type: 'string' }, name: { type: 'string' }, x: { type: 'number' }, z: { type: 'number' } },
        required: ['x', 'z'],
        additionalProperties: false,
      },
    },
    {
      name: 'place_entity',
      description: 'Place a blueprint entity at world (x,z). Use blueprintId from get_map_summary availableBlueprints.',
      inputSchema: {
        type: 'object',
        properties: {
          blueprintId: { type: 'string' },
          x: { type: 'number' }, z: { type: 'number' },
          yaw: { type: 'number' }, scale: { type: 'number' },
          groundMode: { type: 'string' },
        },
        required: ['blueprintId', 'x', 'z'],
        additionalProperties: false,
      },
    },
    {
      name: 'set_spawn',
      description: 'Set the player spawn point.',
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'number' }, z: { type: 'number' }, yaw: { type: 'number' } },
        required: ['x', 'z'],
        additionalProperties: false,
      },
    },
    {
      name: 'connect_road_to_poi',
      description: 'Add a road (or extend points) that connects to an existing POI. Use POI id or name/kind substring to target it. Provide optional prefix points.',
      inputSchema: {
        type: 'object',
        properties: {
          points: { type: 'array', items: { oneOf: [{ type: 'array', minItems: 2, maxItems: 2 }, { type: 'object' }] } },
          poi: { type: 'string', description: 'POI id or name/kind to connect to' },
          width: { type: 'number' },
        },
        required: ['poi'],
        additionalProperties: false,
      },
    },
    {
      name: 'place_near_poi',
      description: 'Place a blueprint entity near an existing POI (by id or name). Optional offset [dx, dz] in meters.',
      inputSchema: {
        type: 'object',
        properties: {
          blueprintId: { type: 'string' },
          poi: { type: 'string' },
          offset: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          yaw: { type: 'number' },
          scale: { type: 'number' },
          groundMode: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['blueprintId', 'poi'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_district',
      description: 'Add a named district (for LLM guidance and in-game labels). Supports rect (with rect), polygon/triangle (with points array), circle (with center + radius).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          shape: { type: 'string' },
          rect: { type: 'object' },
          points: { type: 'array' },
          center: { type: 'object' },
          radius: { type: 'number' },
        },
        required: ['name', 'shape'],
        additionalProperties: false,
      },
    },
  ];

  const createWorldMapCodexSystemPrompt = () => {
    const s = editor()?.getMapSummary?.() || {};
    const bpList = (s.availableBlueprints || []).map((b) => `${b.id} (${b.name})`).join(', ') || 'none';
    const poiList = (s.poiAnchors && s.poiAnchors.length) ? s.poiAnchors.join(' | ') : 'none yet';
    return `You are editing a Dreamfall vector world map (2D top-down) live through safe tools.
Map bounds: ${JSON.stringify(s.bounds || {})} sizeMeters: ${JSON.stringify(s.sizeMeters || {})}.
**Existing POIs (key anchors — use them to steer what and where you place things):**
${poiList}

Rules:
- Preserve existing POIs (copy ids/kinds/positions when doing large changes).
- Use POIs to steer: connect roads to landmarks/city_gates, place cities near city_gates, cluster interesting content near landmarks, respect the spawn POI.
- Special tools: connect_road_to_poi and place_near_poi make it easy to build directly around existing POIs (pass poi id or name substring).
- Districts (named areas) are great for guiding generation: put themed content inside named districts (e.g. "Downtown" gets tall buildings, "Docks" gets industrial).
- Always keep added features INSIDE the current bounds.
- Prefer rect zones that cover large areas; roads/rivers should have 3+ points and traverse significant distance.
- Entities must use exact blueprintId values from availableBlueprints.
Coordinate system: X horizontal, Z vertical on the 2D map (same as world X/Z).
After edits respond with a short summary of what you changed or added.

Available blueprints: ${bpList}
Current summary (use for context):
${JSON.stringify({ zones: (s.zones||[]).length, roads: (s.roads||[]).length, entities: (s.entities||[]).length, pois: (s.pois||[]).length, bounds: s.bounds }, null, 0)}
`;
  };

  const executeWorldMapTool = (name, args = {}) => {
    const e = editor();
    if (!e) return { success: false, error: 'editor not ready' };
    try {
      if (name === 'get_map_summary') return { success: true, summary: e.getMapSummary() };
      if (name === 'add_rect_zone') return e.addZone({ type: args.type, rect: args.rect, props: args.props });
      if (name === 'add_poly_zone') return e.addZone({ type: args.type, points: args.points, props: args.props });
      if (name === 'add_road') return e.addRoad(args.points, { width: args.width });
      if (name === 'add_river') return e.addRiver(args.points, { width: args.width, depth: args.depth, oceanLeft: args.oceanLeft, oceanRight: args.oceanRight });
      if (name === 'add_poi') return e.addPoi(args);
      if (name === 'place_entity') return e.addEntity(args);
      if (name === 'set_spawn') return e.setSpawn(args.x, args.z, args.yaw);

      if (name === 'connect_road_to_poi') {
        const sum = e.getMapSummary();
        const q = String(args.poi || '').toLowerCase();
        const target = (sum.pois || []).find((p) =>
          p.id === args.poi || (p.name && p.name.toLowerCase().includes(q)) || p.kind.toLowerCase().includes(q)
        );
        if (!target) return { success: false, error: `POI not found for query: ${args.poi}` };
        let pts = Array.isArray(args.points) && args.points.length > 0 ? [...args.points] : [];
        pts.push({ x: target.x, z: target.z });
        return e.addRoad(pts, { width: args.width });
      }

      if (name === 'place_near_poi') {
        const sum = e.getMapSummary();
        const q = String(args.poi || '').toLowerCase();
        const target = (sum.pois || []).find((p) =>
          p.id === args.poi || (p.name && p.name.toLowerCase().includes(q)) || p.kind.toLowerCase().includes(q)
        );
        if (!target) return { success: false, error: `POI not found for query: ${args.poi}` };
        const ox = Array.isArray(args.offset) ? (args.offset[0] || 0) : 0;
        const oz = Array.isArray(args.offset) ? (args.offset[1] || 0) : 0;
        return e.addEntity({
          blueprintId: args.blueprintId,
          x: target.x + ox,
          z: target.z + oz,
          yaw: args.yaw,
          scale: args.scale,
          groundMode: args.groundMode,
          name: args.name,
        });
      }

      if (name === 'add_district') {
        return e.addDistrict(args);
      }

      return { success: false, error: `Unknown tool ${name}` };
    } catch (err) {
      return { success: false, error: err?.message || 'tool failed' };
    }
  };

  const runCodexWorldEdit = async () => {
    const prompt = aiPrompt().trim();
    if (!prompt || aiBusy()) return;
    setAiBusy(true);
    setAiText('');
    try {
      const availability = await fetch('/api/codex/status', { headers: { Accept: 'application/json' } }).then((r) => r.json());
      if (!availability.available) throw new Error(availability.error || 'Codex unavailable');

      await new Promise((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${location.host}/ws/codex`);
        let assistantText = '';
        ws.onopen = () => {
          ws.send(JSON.stringify({
            type: 'start',
            model: 'gpt-5.4',
            threadId: aiCodexThreadId(),
            systemPrompt: createWorldMapCodexSystemPrompt(),
            tools: WORLD_MAP_CODEX_TOOLS,
            userMessage: prompt,
          }));
        };
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'thread') { setAiCodexThreadId(msg.threadId); return; }
          if (msg.type === 'status') { /* could surface */ return; }
          if (msg.type === 'delta') { assistantText += msg.text || ''; setAiText(assistantText); return; }
          if (msg.type === 'tool_call') {
            const result = executeWorldMapTool(msg.name, msg.args || {});
            ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, result: JSON.stringify(result), success: result.success !== false }));
            return;
          }
          if (msg.type === 'turn_complete') {
            setAiText(msg.text || assistantText);
            ws.close(); resolve(); return;
          }
          if (msg.type === 'error') { ws.close(); reject(new Error(msg.message || 'Codex error')); }
        };
        ws.onerror = () => reject(new Error('Codex WS failed'));
      });
      setAiPrompt('');
    } catch (err) {
      console.error(err);
      setAiText(`Codex error: ${err?.message || err}`);
    } finally {
      setAiBusy(false);
    }
  };

  const runGrokWorldEdit = async () => {
    const prompt = aiPrompt().trim();
    if (!prompt || aiBusy()) return;
    setAiBusy(true);
    setAiText('');
    try {
      const availability = await fetch('/api/grok/status', { headers: { Accept: 'application/json' } }).then((r) => r.json());
      if (!availability.available) throw new Error(availability.error || 'Grok CLI unavailable');
      const e = editor();
      const summary = e ? e.getMapSummary() : null;

      // Capture original POIs before generation so we can safeguard them
      const originalPois = summary?.pois ? JSON.parse(JSON.stringify(summary.pois)) : [];

      const res = await fetch('/api/grok/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt, summary, mode: 'worldmap' }),
      }).then((r) => r.json());
      if (!res || res.success === false) {
        const msg = res?.error || 'Grok generation failed';
        if (res?.partial) setAiText(`Partial output:\n${String(res.partial).slice(0, 400)}`);
        throw new Error(msg);
      }
      let mapData = res.map || res.project;

      // Safeguard: merge back any original POIs the model may have omitted
      if (mapData && originalPois.length > 0) {
        const generatedPois = Array.isArray(mapData.pois) ? mapData.pois : [];
        const keptIds = new Set(generatedPois.map((p) => p && p.id).filter(Boolean));
        const missing = originalPois.filter((p) => p && p.id && !keptIds.has(p.id));
        if (missing.length > 0) {
          mapData = {
            ...mapData,
            pois: [...generatedPois, ...missing],
          };
        }
      }

      if (mapData && e && typeof e.loadJSON === 'function') {
        try {
          e.loadJSON(mapData);
        } catch (loadErr) {
          console.error(loadErr);
        }
      }
      setAiText(res.summary || 'Grok world map generated.');
      setAiPrompt('');
    } catch (err) {
      console.error(err);
      // If we already set partial output above, don't clobber it completely
      if (!aiText().startsWith('Partial')) {
        setAiText(`Grok error: ${err?.message || 'failed'}`);
      }
    } finally {
      setAiBusy(false);
    }
  };

  const runAiWorld = () => {
    if (aiProvider() === 'grok') runGrokWorldEdit(); else runCodexWorldEdit();
  };

  // Small status helper (WorldMapControls doesn't have a setStatus prop in same way; we just use aiText for results)
  // We can update a transient message via aiText.

  return (
    <div class="worldmap-editor-panel">
      <div style={{ 'font-size': '15px', 'font-weight': 600 }}>World Map Editor</div>

      <div style={h2}>Tools</div>
      <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '5px' }}>
        <For each={TOOLS}>
          {(t) => (
            <button
              style={btn(snap().tool === t.id)}
              onClick={call((e) => (ZONE_TYPES[t.id] ? e.setActiveZoneType(t.id) : e.setTool(t.id)))}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>

      {/* AI CLI — Grok (default, headless full map JSON) or Codex (live tools). Responds to map size/bounds and fills. */}
      <div style={h2}>AI CLI</div>
      <select
        style={field}
        value={aiProvider()}
        onChange={(e) => setAiProvider(e.currentTarget.value)}
        disabled={aiBusy()}
      >
        <option value="grok">Grok (headless JSON — fills map)</option>
        <option value="codex">Codex (live)</option>
      </select>
      <textarea
        style={{ ...field, height: '52px', 'margin-top': '4px', 'font-family': 'monospace', 'font-size': '11px' }}
        value={aiPrompt()}
        disabled={aiBusy() || !editor()}
        placeholder={aiProvider() === 'grok' ? 'Describe a filled world map (Grok will return full vector map JSON respecting current bounds)' : 'Ask Codex to edit the world map (tools)'}
        onInput={(e) => setAiPrompt(e.currentTarget.value)}
      />
      <button
        style={{ ...btn(false), width: '100%', 'margin-top': '4px', background: aiBusy() ? '#444' : '#3a5a3a' }}
        disabled={aiBusy() || !aiPrompt().trim()}
        onClick={runAiWorld}
      >
        {aiBusy() ? 'Working…' : (aiProvider() === 'grok' ? 'Generate Map JSON' : 'Apply with Codex')}
      </button>
      {aiText() && <div style={{ 'font-size': '11px', color: '#a8b09f', 'margin-top': '3px', 'white-space': 'pre-wrap' }}>{aiText()}</div>}
      <div style={{ 'font-size': '10px', color: '#6f746a' }}>Grok: returns complete map (zones+roads+entities) sized to bounds. Codex: incremental via tools.</div>

      <Show when={ZONE_TOOLS.has(snap().tool)}>
        <div style={h2}>Zone shape</div>
        <div style={{ display: 'flex', gap: '5px' }}>
          <button style={btn(snap().drawShape !== 'poly')} onClick={() => editor()?.setDrawShape('rect')}>Rectangle</button>
          <button style={btn(snap().drawShape === 'poly')} onClick={() => editor()?.setDrawShape('poly')}>Polygon</button>
        </div>
        <Show when={snap().drawShape === 'poly'}>
          <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
            Click to add points · double-click or Enter to close · Esc to cancel.
          </div>
        </Show>
      </Show>

      <Show when={snap().tool === 'city'}>
        <div style={h2}>City style</div>
        <select style={field} value={snap().activeCityStyle ?? 'downtown'} onChange={(e) => editor()?.setActiveCityStyle(e.target.value)}>
          <For each={CITY_STYLE_ORDER}>{(s) => <option value={s}>{CITY_STYLES[s].label}</option>}</For>
        </select>
      </Show>

      <Show when={snap().tool === 'road' || snap().selected?.kind === 'road'}>
        <div style={h2}>Road</div>
        <label style={{ 'font-size': '11px', color: '#8d9384' }}>Width (m)</label>
        <input
          style={field}
          type="number"
          value={snap().selected?.kind === 'road' ? snap().selected.width : (snap().roadWidth ?? 8)}
          onChange={(e) => editor()?.setRoadWidth(Number(e.target.value))}
        />
        <label style={{ 'font-size': '11px', color: '#8d9384', 'margin-top': '6px', display: 'block' }}>Track style</label>
        <select
          style={field}
          value={snap().selected?.kind === 'road' ? (snap().selected.trackStyle ?? '') : (snap().roadTrackStyle ?? '')}
          onChange={(e) => editor()?.setRoadTrackStyle(e.target.value)}
        >
          <option value="">Plain road</option>
          <For each={TRACK_CROSS_SECTION_ORDER}>
            {(id) => <option value={id}>{TRACK_CROSS_SECTIONS[id]?.label ?? id}</option>}
          </For>
        </select>
        <label style={{ 'font-size': '11px', color: '#8d9384', 'margin-top': '6px', display: 'block' }}>Surface</label>
        <select
          style={field}
          value={snap().selected?.kind === 'road' ? (snap().selected.surface ?? '') : (snap().roadSurface ?? '')}
          onChange={(e) => editor()?.setRoadSurface(e.target.value)}
        >
          <option value="">Automatic from style</option>
          <For each={ROAD_SURFACE_ORDER}>
            {(id) => <option value={id}>{ROAD_SURFACES[id]?.label ?? id}</option>}
          </For>
        </select>
        <label style={{ 'font-size': '11px', color: '#8d9384', 'margin-top': '6px', display: 'block' }}>Elevation</label>
        <select
          style={field}
          value={(snap().selected?.kind === 'road' ? snap().selected.elevation : snap().roadElevation) == null ? 'terrain' : 'fixed'}
          onChange={(e) => editor()?.setRoadElevation(e.target.value === 'fixed' ? 0 : null)}
        >
          <option value="terrain">Follow terrain</option>
          <option value="fixed">Fixed height</option>
        </select>
        <Show when={(snap().selected?.kind === 'road' ? snap().selected.elevation : snap().roadElevation) != null}>
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>World Y (m)</label>
          <input
            style={field}
            type="number"
            step="0.5"
            value={snap().selected?.kind === 'road' ? snap().selected.elevation : snap().roadElevation}
            onChange={(e) => editor()?.setRoadElevation(Number(e.target.value))}
          />
          <Show when={(snap().selected?.kind === 'road' ? snap().selected.trackStyle : snap().roadTrackStyle) === 'tunnel'}>
            <div style={{ 'font-size': '11px', color: '#8d9384' }}>Fixed height + tunnel creates a flat bore.</div>
          </Show>
        </Show>
        <Show when={snap().tool === 'road'}>
          <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
            Click to add points · double-click or Enter to finish · Esc to cancel. Terrain
            grades to the road; it bridges over wilds/gaps and meets cities flat.
          </div>
        </Show>
        <Show when={snap().tool === 'select' && snap().selected?.kind === 'road'}>
          <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
            Drag a handle (small dot, glows gold on hover) to fine-tune that end or bend —
            drag anywhere else on the road to move the whole thing.
          </div>
        </Show>
      </Show>

      <Show when={snap().tool === 'river' || snap().selected?.kind === 'river'}>
        <div style={h2}>River</div>
        <label style={{ 'font-size': '11px', color: '#8d9384' }}>Width (m)</label>
        <input
          style={field}
          type="number"
          value={snap().selected?.kind === 'river' ? snap().selected.width : (snap().riverWidth ?? 10)}
          onChange={(e) => editor()?.setRiverWidth(Number(e.target.value))}
        />
        <label style={{ 'font-size': '11px', color: '#8d9384' }}>Depth (m)</label>
        <input
          style={field}
          type="number"
          value={snap().selected?.kind === 'river' ? snap().selected.depth : (snap().riverDepth ?? 6)}
          onChange={(e) => editor()?.setRiverDepth(Number(e.target.value))}
        />
        <label style={{ 'font-size': '11px', color: '#8d9384', 'margin-top': '6px', display: 'block' }}>Ocean fill</label>
        <label style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'font-size': '12px', color: '#cfd2c8' }}>
          <input
            type="checkbox"
            checked={snap().selected?.kind === 'river' ? !!snap().selected.oceanLeft : !!snap().riverOceanLeft}
            onChange={(e) => editor()?.setRiverOceanLeft(e.target.checked)}
          />
          Left is infinite ocean
        </label>
        <label style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'font-size': '12px', color: '#cfd2c8' }}>
          <input
            type="checkbox"
            checked={snap().selected?.kind === 'river' ? !!snap().selected.oceanRight : !!snap().riverOceanRight}
            onChange={(e) => editor()?.setRiverOceanRight(e.target.checked)}
          />
          Right is infinite ocean
        </label>
        <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
          Left/right are relative to the direction you drew the river (first point → last).
          A checked side never fades back to land — it becomes ocean out to the map's edge,
          including past both ends of the river.
        </div>
        <Show when={snap().tool === 'river'}>
          <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
            Click to add points · double-click or Enter to finish · Esc to cancel. Terrain
            carves DOWN into a channel; the character swims when their feet drop below the surface.
          </div>
        </Show>
        <Show when={snap().tool === 'select' && snap().selected?.kind === 'river'}>
          <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
            Drag a handle (small dot, glows gold on hover) to fine-tune that end or bend —
            drag anywhere else on the river to move the whole thing.
          </div>
        </Show>
      </Show>

      <Show when={snap().tool === 'poi'}>
        <div style={h2}>POI Kind</div>
        <select style={field} value={snap().activePoiKind} onChange={(e) => editor()?.setActivePoiKind(e.target.value)}>
          <For each={POI_KIND_ORDER}>{(k) => <option value={k}>{POI_KINDS[k].label}</option>}</For>
        </select>
      </Show>

      <Show when={snap().tool === 'entity'}>
        <div style={h2}>Entity (Blueprint)</div>
        <label style={{ 'font-size': '11px', color: '#8d9384' }}>Blueprint</label>
        <select style={field} value={snap().activeBlueprintId ?? ''} onChange={(e) => editor()?.setActiveBlueprint(e.target.value)}>
          <option value="">— pick a blueprint —</option>
          <For each={blueprints()}>{(bp) => <option value={bp.id}>{bp.name} ({bp.chunks}c · {bp.objects}o)</option>}</For>
        </select>
        <label style={{ 'font-size': '11px', color: '#8d9384' }}>Ground mode</label>
        <select style={field} value={snap().activeEntityGroundMode ?? 'none'} onChange={(e) => editor()?.setActiveEntityGroundMode(e.target.value)}>
          <For each={ENTITY_GROUND_MODE_ORDER}>{(m) => <option value={m}>{ENTITY_GROUND_MODES[m].label} — {ENTITY_GROUND_MODES[m].desc}</option>}</For>
        </select>
        <Show when={!snap().activeBlueprintId}>
          <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
            Pick a blueprint, then click the map to place it. Build blueprints in the Edit editor ("Save as Blueprint").
          </div>
        </Show>
      </Show>

      <Show when={snap().tool === 'district'}>
        <div style={h2}>District (named area for LLM + in-game labels)</div>
        <label style={{ 'font-size': '11px', color: '#8d9384' }}>Name</label>
        <input style={field} value={snap().districtName ?? 'District'} onInput={(e) => editor()?.setDistrictName(e.currentTarget.value)} />
        <label style={{ 'font-size': '11px', color: '#8d9384', 'margin-top': '4px', display: 'block' }}>Color</label>
        <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
          <input type="color" value={snap().selected?.kind === 'district' ? (snap().selected.color || '#4fc3f7') : '#4fc3f7'} onInput={(e) => editor()?.setSelectedDistrictColor?.(e.currentTarget.value)} style={{ width: '32px', height: '20px', padding: 0, border: 'none', background: 'transparent' }} />
          <For each={['#4fc3f7','#81c784','#ffb74d','#e57373','#ba68c8','#4db6ac']}>{(c) => (
            <button style={{ ...btn(false), width: '18px', height: '18px', background: c, padding: 0, border: '1px solid #444' }} onClick={() => editor()?.setSelectedDistrictColor?.(c)} />
          )}</For>
        </div>
        <label style={{ 'font-size': '11px', color: '#8d9384', 'margin-top': '4px', display: 'block' }}>Shape</label>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          <For each={['rect','polygon','circle','triangle']}>{(sh) => (
            <button style={btn(snap().activeDistrictShape === sh)} onClick={() => editor()?.setActiveDistrictShape(sh)}>{sh}</button>
          )}</For>
        </div>
        <Show when={snap().selected?.kind === 'district' && snap().selected.shape !== 'circle'}>
          <label style={{ 'font-size': '11px', color: '#8d9384', 'margin-top': '4px', display: 'block' }}>City Style (affects runtime gen)</label>
          <select style={field} value={snap().selected?.props?.cityStyle || ''} onChange={(e) => editor()?.setSelectedDistrictProp?.('cityStyle', e.currentTarget.value || null)}>
            <option value="">Auto / from zone</option>
            <For each={CITY_STYLE_ORDER}>{(s) => <option value={s}>{CITY_STYLES[s].label}</option>}</For>
          </select>
        </Show>
        <div style={{ 'font-size': '10px', color: '#8d9384', 'line-height': 1.3, marginTop: '4px' }}>
          Draw to add named district. Color for editor. City Style for deeper runtime influence. Use in prompts.
        </div>
      </Show>

      <div style={{ display: 'flex', gap: '5px' }}>
        <button style={btn(snap().showGrid)} onClick={call((e) => e.toggleGrid())}>Grid</button>
        <button style={btn(snap().snap)} onClick={call((e) => e.toggleSnap())}>Snap</button>
        <button style={btn(false)} onClick={call((e) => e.fitView())}>Fit</button>
      </div>

      <Show when={snap().selected}>
        <div style={h2}>Selected ({snap().selected.kind})</div>
        <Show when={snap().selected.kind === 'poi'}>
          <input
            style={field}
            value={snap().selected.name}
            placeholder="POI name"
            onInput={(e) => editor()?.setSelectedName(e.target.value)}
          />
        </Show>
        <Show when={snap().selected.kind === 'zone' && snap().selected.type === 'terrain'}>
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>Biome</label>
          <select style={field} value={snap().selected.biome ?? ''} onChange={(e) => editor()?.setSelectedBiome(e.target.value)}>
            <option value="">Base (gentle)</option>
            <For each={TERRAIN_BIOME_ORDER}>{(b) => <option value={b}>{TERRAIN_BIOMES[b].label}</option>}</For>
          </select>
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>Min elevation (m)</label>
          <input
            style={field}
            type="number"
            placeholder="Unconstrained"
            value={snap().selected.minHeight ?? ''}
            onInput={(e) => editor()?.setSelectedMinHeight(e.target.value)}
          />
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>Max elevation (m)</label>
          <input
            style={field}
            type="number"
            placeholder="Unconstrained"
            value={snap().selected.maxHeight ?? ''}
            onInput={(e) => editor()?.setSelectedMaxHeight(e.target.value)}
          />
          <Show when={(snap().selected.minHeight !== '') !== (snap().selected.maxHeight !== '')}>
            <label style={{ 'font-size': '11px', color: '#8d9384' }}>Relief above/below (m)</label>
            <input
              style={field}
              type="number"
              placeholder="Auto (biome amplitude)"
              value={snap().selected.relief ?? ''}
              onInput={(e) => editor()?.setSelectedRelief(e.target.value)}
            />
          </Show>
          <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
            Set min &gt; 0 to guarantee a mountain (never dips to sea level); set max &lt; 0 to guarantee a canyon/valley (never rises above it). The noise is remapped (not clamped) so the whole zone keeps natural rolling relief instead of a flat plateau — Relief controls how many metres of that variation to keep above the floor / below the ceiling (defaults to the biome's own amplitude). Eases in over ~24m at the zone edge.
          </div>
        </Show>
        <Show when={snap().selected.kind === 'zone' && snap().selected.type === 'city'}>
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>City style</label>
          <select style={field} value={snap().selected.cityStyle ?? 'downtown'} onChange={(e) => editor()?.setSelectedCityStyle(e.target.value)}>
            <For each={CITY_STYLE_ORDER}>{(s) => <option value={s}>{CITY_STYLES[s].label}</option>}</For>
          </select>
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>City seed</label>
          <input
            style={field}
            type="number"
            value={snap().selected.seed ?? 0}
            onChange={(e) => editor()?.setSelectedCitySeed(Number(e.target.value))}
          />
        </Show>
        <Show when={snap().selected.kind === 'entity'}>
          <input
            style={field}
            value={snap().selected.name}
            placeholder="Entity name"
            onInput={(e) => editor()?.setSelectedName(e.target.value)}
          />
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>Blueprint</label>
          <select style={field} value={snap().selected.blueprintId} onChange={(e) => editor()?.setSelectedEntityBlueprint(e.target.value)}>
            <For each={blueprints()}>{(bp) => <option value={bp.id}>{bp.name}</option>}</For>
          </select>
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>Yaw°</label>
          <input style={field} type="number" value={snap().selected.yaw} onChange={(e) => editor()?.setSelectedEntityYaw(Number(e.target.value))} />
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>Scale</label>
          <input style={field} type="number" step="0.1" value={snap().selected.scale} onChange={(e) => editor()?.setSelectedEntityScale(Number(e.target.value))} />
          <label style={{ 'font-size': '11px', color: '#8d9384' }}>Ground mode</label>
          <select style={field} value={snap().selected.groundMode} onChange={(e) => editor()?.setSelectedEntityGroundMode(e.target.value)}>
            <For each={ENTITY_GROUND_MODE_ORDER}>{(m) => <option value={m}>{ENTITY_GROUND_MODES[m].label}</option>}</For>
          </select>
        </Show>
        <button style={{ ...btn(false), background: '#7a3a3a', 'border-color': '#9a4a4a' }} onClick={call((e) => e.deleteSelected())}>
          Delete
        </button>
      </Show>

      <div style={h2}>Map</div>
      <input style={field} value={snap().name ?? ''} placeholder="Map name" onInput={(e) => editor()?.setName(e.target.value)} />
      <label style={{ 'font-size': '11px', color: '#8d9384' }}>Chunk size</label>
      <input style={field} type="number" value={snap().chunkSize ?? 32} onChange={(e) => editor()?.setChunkSize(Number(e.target.value))} />
      <label style={{ 'font-size': '11px', color: '#8d9384' }}>Bounds (minX, minZ, maxX, maxZ)</label>
      <div style={{ display: 'grid', 'grid-template-columns': '1fr 1fr', gap: '5px' }}>
        <input style={field} type="number" value={snap().bounds?.minX ?? -512} onChange={(e) => editor()?.setBounds({ minX: num(e) })} />
        <input style={field} type="number" value={snap().bounds?.minZ ?? -512} onChange={(e) => editor()?.setBounds({ minZ: num(e) })} />
        <input style={field} type="number" value={snap().bounds?.maxX ?? 512} onChange={(e) => editor()?.setBounds({ maxX: num(e) })} />
        <input style={field} type="number" value={snap().bounds?.maxZ ?? 512} onChange={(e) => editor()?.setBounds({ maxZ: num(e) })} />
      </div>

      <div style={h2}>Stats</div>
      <div style={{ 'font-size': '12px', color: '#b9bcb1', 'line-height': 1.6 }}>
        Zones: {snap().stats?.zones ?? 0} (terrain {snap().stats?.byType?.terrain ?? 0}, city {snap().stats?.byType?.city ?? 0}, loop {snap().stats?.byType?.loopout ?? 0}, wilds {snap().stats?.byType?.wilds ?? 0})<br />
        Roads: {snap().stats?.roads ?? 0}<br />
        Rivers: {snap().stats?.rivers ?? 0}<br />
        POIs: {snap().stats?.pois ?? 0}<br />
        Entities: {snap().stats?.entities ?? 0}<br />
        Spawn: {Math.round(snap().spawn?.x ?? 0)}, {Math.round(snap().spawn?.z ?? 0)}
      </div>

      <Show when={snap().zones?.length}>
        <div style={h2}>Zones</div>
        <div class="worldmap-zone-list">
          <For each={snap().zones}>
            {(z) => {
              const isSel = snap().selected?.kind === 'zone' && snap().selected.id === z.id;
              return (
                <div
                  class={`worldmap-zone-row${isSel ? ' is-selected' : ''}`}
                  onClick={() => editor()?.select('zone', z.id)}
                  title="Select this zone"
                >
                  <span class="worldmap-zone-row__label">{z.label} {z.shape === 'rect' ? '□' : '⬡'}</span>
                  <button style={{ ...btn(false), padding: '2px 6px', 'font-size': '11px', 'flex-shrink': 0 }} onClick={(e) => { e.stopPropagation(); editor()?.bringZoneToFront(z.id); }} title="Bring to front">↑</button>
                  <button style={{ ...btn(false), padding: '2px 6px', 'font-size': '11px', 'flex-shrink': 0 }} onClick={(e) => { e.stopPropagation(); editor()?.sendZoneToBack(z.id); }} title="Send to back">↓</button>
                </div>
              );
            }}
          </For>
        </div>
        <div style={{ 'font-size': '11px', color: '#8d9384', 'line-height': 1.4 }}>
          Click a row or the canvas to select. ↑/↓ sets overlap priority.
        </div>
      </Show>

      <Show when={(snap().districts ?? []).length}>
        <div style={h2}>Districts (named areas for AI + GTA-style labels)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '90px', overflow: 'auto' }}>
          <For each={snap().districts}>
            {(dd) => {
              const isSel = snap().selected?.kind === 'district' && snap().selected.id === dd.id;
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 4px', background: isSel ? '#1e3a5f' : '#262a23', border: '1px solid #3a4a5a', borderRadius: '3px', fontSize: '11px', cursor: 'pointer' }}
                  onClick={() => editor()?.select('district', dd.id)}>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dd.name} <span style={{opacity:0.6}}>({dd.shape})</span></span>
                  <button style={{ ...btn(false), padding: '0 4px', fontSize: '10px' }} onClick={(e) => { e.stopPropagation(); editor()?.select('district', dd.id); editor()?.deleteSelected?.(); }}>del</button>
                </div>
              );
            }}
          </For>
        </div>
        <div style={{ fontSize: '10px', color: '#8d9384' }}>Districts steer LLM gen and trigger on-screen name when player enters/exits.</div>
      </Show>

      <div style={h2}>Actions</div>
      <div style={{ display: 'flex', gap: '5px' }}>
        <button style={{ ...btn(false), opacity: snap().canUndo ? 1 : 0.4 }} onClick={call((e) => e.undo())}>Undo</button>
        <button style={{ ...btn(false), opacity: snap().canRedo ? 1 : 0.4 }} onClick={call((e) => e.redo())}>Redo</button>
        <button style={{ ...btn(false), background: '#7a3a3a', 'border-color': '#9a4a4a' }} onClick={call((e) => e.clearAll())}>Clear</button>
      </div>

      <div style={h2}>Import / Export</div>
      <div style={{ display: 'flex', gap: '5px' }}>
        <button style={btn(false)} onClick={call((e) => e.exportJSON())}>Export JSON</button>
        <button style={btn(false)} onClick={() => fileInput?.click()}>Import</button>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) editor()?.importJSON(file).catch((err) => console.error('Import failed', err));
          e.target.value = '';
        }}
      />

      <div style={h2}>Scenes</div>
      <Show when={defaultWorldScene() || defaultRallyScene()}>
        <div style={{ 'font-size': '10px', color: '#7f857a', 'line-height': 1.45 }}>
          <Show when={defaultWorldScene()}>
            <div>World default: {defaultWorldScene().name}</div>
          </Show>
          <Show when={defaultRallyScene()}>
            <div>Rally default: {defaultRallyScene().name}</div>
          </Show>
        </div>
      </Show>
      <div style={{ display: 'flex', gap: '5px', 'flex-wrap': 'wrap' }}>
        <input
          style={{ ...field, flex: '1 1 120px' }}
          placeholder={snap().name || 'Scene name'}
          value={sceneName()}
          onInput={(e) => setSceneName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveScene(); }}
        />
        <button style={btn(false)} onClick={saveScene}>Save</button>
        <button
          style={btn(false)}
          onClick={() => editor()?.importBuiltinRallyScene()}
          title="Save the built-in Pine Ridge rally stage to your scenes"
        >
          + Pine Ridge
        </button>
      </div>
      <button
        style={{ ...btn(false), background: '#3a6a3a', 'border-color': '#4a8a4a', color: '#fff' }}
        onClick={playDraft}
        title="Play the current canvas in the World scene"
      >
        ▶ Play this map
      </button>
      <Show
        when={scenes().length > 0}
        fallback={<div style={{ 'font-size': '11px', color: '#6f746a' }}>No saved scenes yet.</div>}
      >
        <div class="worldmap-scene-list">
          <For each={scenes()} by="id">
            {(s) => (
              <div class={`worldmap-scene-card${s.id === snap().currentSceneId ? ' is-current' : ''}`}>
                <div>
                  <div class="worldmap-scene-card__name">
                    {s.name}
                    <Show when={s.defaultRole === 'world'}>
                      <span class="worldmap-scene-card__badge worldmap-scene-card__badge--world">WORLD</span>
                    </Show>
                    <Show when={s.defaultRole === 'rally'}>
                      <span class="worldmap-scene-card__badge worldmap-scene-card__badge--rally">RALLY</span>
                    </Show>
                  </div>
                  <div class="worldmap-scene-card__meta">{s.zones} zones · {s.pois} POIs</div>
                </div>
                <div class="worldmap-scene-card__row">
                  <select
                    class="worldmap-scene-card__default"
                    style={field}
                    value={s.defaultRole ?? ''}
                    onChange={(e) => editor()?.setSceneDefaultRole(s.id, e.target.value || null)}
                    title="Default map for World or Rally mode"
                  >
                    <option value="">No default</option>
                    <option value="world">World default</option>
                    <option value="rally">Rally default</option>
                  </select>
                  <div class="worldmap-scene-card__buttons">
                    <button
                      style={{ ...btn(false), padding: '5px 9px', background: '#3a6a3a', 'border-color': '#4a8a4a', color: '#fff' }}
                      onClick={() => play(s.id)}
                      title="Play this scene"
                    >
                      Play
                    </button>
                    <button style={{ ...btn(false), padding: '5px 9px' }} onClick={() => editor()?.loadSceneById(s.id)} title="Load into editor">Edit</button>
                    <button
                      style={{ ...btn(false), padding: '5px 9px', background: '#5a2e2e', 'border-color': '#7a3e3e' }}
                      onClick={() => editor()?.deleteSceneById(s.id)}
                      title="Delete scene"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <div style={{ 'font-size': '11px', color: '#6f746a', 'margin-top': 'auto', 'line-height': 1.5 }}>
        Click zones list (or canvas) to select · ↑/↓ in list sets click/runtime priority (terrain is lowest) · drag to draw · Del to remove.
      </div>
    </div>
  );
}
