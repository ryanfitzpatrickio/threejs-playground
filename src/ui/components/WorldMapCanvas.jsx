import { onCleanup, onMount } from 'solid-js';
import { WorldMapEditor } from '../../map/WorldMapEditor.js';

export function WorldMapCanvas(props) {
  let canvas;
  let editor;

  onMount(async () => {
    if (!canvas) return;

    editor = new WorldMapEditor({
      canvas,
      onChange: (snapshot) => props.onChange?.(snapshot),
    });

    try {
      await editor.start();
      props.onReady?.(editor);
    } catch (err) {
      console.error('WorldMapEditor failed to start', err);
    }
  });

  onCleanup(() => {
    editor?.dispose();
    editor = null;
  });

  return (
    <canvas
      ref={canvas}
      class="map-builder-canvas"
      aria-label="Dreamfall world map editor viewport"
    />
  );
}
