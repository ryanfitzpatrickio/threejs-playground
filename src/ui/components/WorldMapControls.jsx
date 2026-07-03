import { For, Show, createSignal, createMemo, onCleanup, onMount } from 'solid-js';
import { ZONE_TYPES, ZONE_TYPE_ORDER, POI_KINDS, POI_KIND_ORDER, ENTITY_GROUND_MODES, ENTITY_GROUND_MODE_ORDER, TERRAIN_BIOMES, TERRAIN_BIOME_ORDER, CITY_STYLES, CITY_STYLE_ORDER } from '../../world/worldMap/worldMapSchema.js';
import { listScenes, WORLDMAP_DRAFT_ID } from '../../world/worldMap/worldMapScenes.js';
import { listBlueprints } from '../../map/blueprintLibrary.js';
import { getFileStoreRevision, subscribeFileStore, ensureFileStore } from '../../store/fileStore.js';
import { TRACK_CROSS_SECTIONS, TRACK_CROSS_SECTION_ORDER } from '../../game/world/trackCrossSection.js';

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
  { id: 'pan', label: 'Pan' },
];

const ZONE_TOOLS = new Set(['terrain', 'city', 'loopout', 'wilds']);

const panel = {
  position: 'absolute',
  top: 0,
  left: 0,
  bottom: 0,
  width: '264px',
  'box-sizing': 'border-box',
  padding: '14px',
  background: 'rgb(20 22 18 / 96%)',
  'border-right': '1px solid rgb(247 244 232 / 14%)',
  color: '#e7e9e2',
  font: '13px system-ui, sans-serif',
  'overflow-y': 'auto',
  'overflow-x': 'hidden',
  'overscroll-behavior': 'contain',
  'scrollbar-gutter': 'stable',
  'min-height': 0,
  'max-height': '100%',
  // A flex column lets every direct child shrink by default, which compresses
  // long editor contents instead of growing the scroll range. Max-content grid
  // rows keep every control at its natural height and make the panel itself the
  // single vertical scroller.
  display: 'grid',
  'grid-auto-flow': 'row',
  'grid-auto-rows': 'max-content',
  'align-content': 'start',
  gap: '12px',
  'z-index': 10,
};

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

  const blueprints = createMemo(() => {
    storeRevision();
    snap();
    return listBlueprints();
  });

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

  return (
    <div style={panel}>
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
        <div style={h2}>Zones (click row or canvas to select; ↑/↓ = priority; selected rects show corner grips for resize)</div>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px', 'max-height': '120px', 'overflow-y': 'auto', 'font-size': '11px' }}>
          <For each={snap().zones}>
            {(z) => {
              const isSel = snap().selected?.kind === 'zone' && snap().selected.id === z.id;
              return (
                <div
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '4px',
                    padding: '2px 4px',
                    background: isSel ? 'rgb(74 111 165 / 28%)' : '#262a23',
                    border: '1px solid rgb(247 244 232 / 10%)',
                    'border-radius': '3px',
                    cursor: 'pointer',
                  }}
                  onClick={() => editor()?.select('zone', z.id)}
                  title="Select this zone (bypasses canvas hit test)"
                >
                  <span style={{ flex: 1, color: isSel ? '#fff' : '#cfd2c8' }}>{z.label} {z.shape === 'rect' ? '□' : '⬡'}</span>
                  <button style={{ ...btn(false), padding: '1px 4px', 'font-size': '10px' }} onClick={(e) => { e.stopPropagation(); editor()?.bringZoneToFront(z.id); }} title="Bring to front (wins clicks &amp; overrides where overlapping)">↑</button>
                  <button style={{ ...btn(false), padding: '1px 4px', 'font-size': '10px' }} onClick={(e) => { e.stopPropagation(); editor()?.sendZoneToBack(z.id); }} title="Send to back">↓</button>
                </div>
              );
            }}
          </For>
        </div>
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
      <div style={{ display: 'flex', gap: '5px' }}>
        <input
          style={field}
          placeholder={snap().name || 'Scene name'}
          value={sceneName()}
          onInput={(e) => setSceneName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') saveScene(); }}
        />
        <button style={btn(false)} onClick={saveScene}>Save</button>
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
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px', 'max-height': '180px', 'overflow-y': 'auto' }}>
          <For each={scenes()} by="id">
            {(s) => (
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '5px',
                  padding: '5px 6px',
                  background: s.id === snap().currentSceneId ? 'rgb(74 111 165 / 28%)' : '#262a23',
                  border: '1px solid rgb(247 244 232 / 12%)',
                  'border-radius': '5px',
                }}
              >
                <div style={{ flex: 1, 'min-width': 0 }}>
                  <div style={{ 'font-size': '12px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{s.name}</div>
                  <div style={{ 'font-size': '10px', color: '#7f857a' }}>{s.zones}z · {s.pois}p</div>
                </div>
                <button
                  style={{ ...btn(false), padding: '4px 7px', background: '#3a6a3a', 'border-color': '#4a8a4a', color: '#fff' }}
                  onClick={() => play(s.id)}
                  title="Play this scene in the World"
                >
                  ▶
                </button>
                <button style={{ ...btn(false), padding: '4px 7px' }} onClick={() => editor()?.loadSceneById(s.id)} title="Load into editor">Edit</button>
                <button
                  style={{ ...btn(false), padding: '4px 7px', background: '#5a2e2e', 'border-color': '#7a3e3e' }}
                  onClick={() => editor()?.deleteSceneById(s.id)}
                  title="Delete scene"
                >
                  ✕
                </button>
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
