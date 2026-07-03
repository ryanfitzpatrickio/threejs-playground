import { onCleanup, onMount } from 'solid-js';
import { MapBuilder } from '../../map/MapBuilder.js';

export function MapBuilderCanvas(props) {
  let canvas;
  let builder;

  onMount(async () => {
    if (!canvas) return;

    builder = new MapBuilder({
      canvas,
      onChange: (snapshot) => {
        props.onChange?.(snapshot);
      },
    });

    try {
      await builder.start();
      props.onReady?.(builder);
    } catch (err) {
      console.error('MapBuilder failed to start', err);
    }
  });

  onCleanup(() => {
    builder?.dispose();
    builder = null;
  });

  // Expose imperative handle to parent (for controls to call methods)
  const getBuilder = () => builder;

  // Attach ref for parent access if needed
  if (props.ref) {
    props.ref({ getBuilder });
  }

  return (
    <canvas
      ref={canvas}
      class="map-builder-canvas"
      aria-label="Dreamfall map builder viewport"
    />
  );
}
