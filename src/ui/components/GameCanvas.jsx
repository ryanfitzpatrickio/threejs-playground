import { createSignal, onCleanup, onMount } from 'solid-js';
import { GameRuntime } from '../../game/core/GameRuntime.js';
import { getQualityLevel, getQualityPreset } from '../../game/config/qualityPresets.js';
import { VirtualTouchControls } from './VirtualTouchControls.jsx';

export function GameCanvas(props) {
  let canvas;
  let runtime;
  const [runtimeReady, setRuntimeReady] = createSignal(false);

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
    setRuntimeReady(true);
    props.onRuntime?.(runtime);

    runtime.start().catch((error) => {
      console.error('Dreamfall runtime failed to start.', error);
    });

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        runtime?.dispose();
        runtime = null;
        setRuntimeReady(false);
      });
    }
  });

  onCleanup(() => {
    props.onRuntime?.(null);
    runtime?.dispose();
    runtime = null;
    setRuntimeReady(false);
  });

  return (
    <div class="game-canvas-host">
      <canvas ref={canvas} class="game-canvas" aria-label="Dreamfall prototype viewport" />
      <VirtualTouchControls
        enabled={runtimeReady()}
        getInputSystem={() => runtime?.inputSystem ?? null}
      />
    </div>
  );
}
