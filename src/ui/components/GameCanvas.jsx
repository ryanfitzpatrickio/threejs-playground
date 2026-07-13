import { onCleanup, onMount } from 'solid-js';
import { GameRuntime } from '../../game/core/GameRuntime.js';
import { getQualityLevel, getQualityPreset } from '../../game/config/qualityPresets.js';

export function GameCanvas(props) {
  let canvas;
  let runtime;

  onMount(() => {
    const qualityLevel = getQualityLevel();
    const preset = getQualityPreset(qualityLevel);

    runtime = new GameRuntime({
      canvas,
      qualityPreset: preset,
      qualityLevel,
      onSnapshot: props.onSnapshot,
      levelMode: props.levelMode ?? 'city',
      // Deathmatch M3: App-owned socket; optional for offline / other modes.
      networkSystem: props.networkSystem ?? null,
    });
    // Late bind if the prop arrives after mount or changes identity.
    if (props.networkSystem) {
      runtime.setNetworkSystem?.(props.networkSystem);
    }
    props.onRuntime?.(runtime);

    runtime.start().catch((error) => {
      console.error('Dreamfall runtime failed to start.', error);
    });

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        runtime?.dispose();
        runtime = null;
      });
    }
  });

  onCleanup(() => {
    props.onRuntime?.(null);
    runtime?.dispose();
  });

  return <canvas ref={canvas} class="game-canvas" aria-label="Dreamfall prototype viewport" />;
}
