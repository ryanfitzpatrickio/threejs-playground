import { createSignal } from 'solid-js';
import { MapBuilderCanvas } from '../ui/components/MapBuilderCanvas.jsx';
import { MapBuilderControls } from '../ui/components/MapBuilderControls.jsx';
import { WorldMapCanvas } from '../ui/components/WorldMapCanvas.jsx';
import { WorldMapControls } from '../ui/components/WorldMapControls.jsx';
import { WorldMapPreview } from '../ui/components/WorldMapPreview.jsx';
import { flushFileStore, setMapBuilderAutosave } from '../store/fileStore.js';

export function createDevTools({ viewMode, switchTo, onPlayScene }) {
  const [builderSnapshot, setBuilderSnapshot] = createSignal(null);
  const [builderInstance, setBuilderInstance] = createSignal(null);
  const [worldMapSnapshot, setWorldMapSnapshot] = createSignal(null);
  const [worldMapInstance, setWorldMapInstance] = createSignal(null);

  const handleBuilderReady = (builder) => {
    setBuilderInstance(builder);
    // Do not setBuilderSnapshot here.
    //
    // The MapBuilder.start() already calls emitChange() (which includes the full
    // snapshot with blueprints, maps, etc.) *before* onReady is invoked.
    // Previously this handler was overwriting the rich snapshot with a partial
    // object that omitted `blueprints` (and maps), causing the Blueprints list
    // in the Edit tab to always show the "No saved blueprints yet." fallback
    // by default.
    //
    // We rely on the emitChange() snapshot for initial state (and all future
    // updates). This makes saved blueprints (and maps) appear immediately.
  };

  const handleWorldMapReady = (editor) => {
    setWorldMapInstance(editor);
    setWorldMapSnapshot(editor.getSnapshot?.() ?? null);
  };

  const beforeSwitch = (current, next) => {
    if (current === 'mapBuilder' && next !== 'mapBuilder') {
      try {
        const builder = builderInstance();
        if (builder && typeof builder.getProjectJSON === 'function') {
          const latest = typeof builder.flushAutosave === 'function'
            ? builder.flushAutosave()
            : builder.getProjectJSON();
          if (latest && ((latest.chunks?.length ?? 0) > 0 || (latest.objects?.length ?? 0) > 0)) {
            setMapBuilderAutosave(latest, { debounce: false });
          }
        }
      } catch {}
      void flushFileStore();
    }

    if (current === 'worldMap' && next !== 'worldMap') {
      try {
        worldMapInstance()?.flushAutosave?.();
      } catch {}
    }
  };

  const ModeButtons = () => (
    <>
      <button
        class={`mode-btn ${viewMode() === 'mapBuilder' ? 'active' : ''}`}
        onClick={() => switchTo('mapBuilder')}
        title="Edit — sculpt the World terrain (Map Builder)"
      >
        Edit
      </button>
      <button
        class={`mode-btn ${viewMode() === 'worldMap' ? 'active' : ''}`}
        onClick={() => switchTo('worldMap')}
        title="Map — draw world zones & POIs (2D World-Map Editor)"
      >
        Map
      </button>
    </>
  );

  const Views = () => (
    <>
      {viewMode() === 'mapBuilder' && (
        <div class="map-builder-shell">
          <MapBuilderCanvas onChange={setBuilderSnapshot} onReady={handleBuilderReady} />
          <MapBuilderControls builder={builderInstance()} snapshot={builderSnapshot()} />
        </div>
      )}
      {viewMode() === 'worldMap' && (
        <div class="map-builder-shell">
          <WorldMapCanvas onChange={setWorldMapSnapshot} onReady={handleWorldMapReady} />
          <WorldMapControls
            editor={worldMapInstance()}
            snapshot={worldMapSnapshot}
            onPlayScene={onPlayScene}
          />
          {worldMapInstance() && (
            <WorldMapPreview editor={worldMapInstance()} snapshot={worldMapSnapshot()} />
          )}
        </div>
      )}
    </>
  );

  return {
    beforeSwitch,
    toggleMode: () => switchTo(viewMode() === 'game' ? 'mapBuilder' : 'game'),
    ModeButtons,
    Views,
  };
}
