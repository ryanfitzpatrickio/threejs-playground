import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { WorldMapPreview3D } from '../../map/WorldMapPreview3D.js';

/**
 * Picture-in-picture 3D preview of the world-map vector data, pinned to the
 * bottom-right of the editor. Orbit/pan/zoom via mouse, WASD/QE to fly.
 *
 * Props:
 *   editor   — the WorldMapEditor instance (source of getProjectJSON()).
 *   snapshot — the editor snapshot; changes drive a rebuild of the 3D content.
 */
export function WorldMapPreview(props) {
  let canvas;
  let preview;
  let syncTimer = 0;
  const [collapsed, setCollapsed] = createSignal(false);

  onMount(() => {
    if (!canvas) return;
    preview = new WorldMapPreview3D({ canvas });
    syncMap();
  });

  onCleanup(() => {
    clearTimeout(syncTimer);
    preview?.dispose();
    preview = null;
  });

  const syncMap = () => {
    const editor = props.editor;
    if (!preview || !editor?.getProjectJSON) return;
    preview.setMap(editor.getProjectJSON());
  };

  // Rebuilding the runtime level is heavy, so coalesce rapid edits (drags, etc.)
  // into a single rebuild a short moment after the last change.
  const scheduleSync = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncMap, 450);
  };

  // Rebuild whenever the editor reports a change (snapshot is a fresh object).
  createEffect(() => {
    props.snapshot;
    scheduleSync();
  });

  // Pause rendering while collapsed to save the frame budget.
  createEffect(() => {
    if (!preview) return;
    if (collapsed()) preview.stop();
    else { preview.start(); syncMap(); }
  });

  return (
    <div class={`worldmap-preview ${collapsed() ? 'collapsed' : ''}`}>
      <div class="worldmap-preview-bar">
        <span class="worldmap-preview-title">Runtime Preview</span>
        <span class="worldmap-preview-hint">orbit · pan · zoom · WASD/QE fly</span>
        <button
          class="worldmap-preview-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed() ? 'Expand preview' : 'Collapse preview'}
        >
          {collapsed() ? '▢' : '—'}
        </button>
      </div>
      <canvas ref={canvas} class="worldmap-preview-canvas" aria-label="3D world map preview" />
    </div>
  );
}
