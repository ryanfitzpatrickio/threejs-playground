import { createSignal, onCleanup, onMount, For, Show } from 'solid-js';
import { SimHumanViewerScene } from '../../game/test/SimHumanViewerScene.js';
import { MODELING_CONTROLS } from '../../vendor/vibe-human/characterModeling.ts';

// M1 visual gate for the vendored vibe-human character: skin materials +
// morph sliders under the real WebGPU renderer. Boot with ?view=simhuman.
// A handful of representative controls; the full generated panel ships with
// the character creator (M3).
const SAMPLE_CONTROL_IDS = [
  'id.head.width',
  'id.head.scale',
  'id.body.global.mass',
  'id.body.global.muscle',
  'id.skull.browRidge.depth',
  'id.skull.forehead.slope',
];
const SAMPLE_ANIMATIONS = ['idle', 'walk', 'jog', 'turnLeft', 'turnRight'];

export function SimHumanViewerCanvas() {
  let canvas;
  let scene;
  const [snapshot, setSnapshot] = createSignal(null);
  const [values, setValues] = createSignal({});

  const sampleControls = MODELING_CONTROLS.filter((c) => SAMPLE_CONTROL_IDS.includes(c.id));

  onMount(() => {
    scene = new SimHumanViewerScene({
      canvas,
      onSnapshot: setSnapshot,
    });
    scene.start().catch((error) => {
      console.error('Sim human viewer failed to start.', error);
    });

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        scene?.dispose();
        scene = null;
      });
    }

    onCleanup(() => {
      scene?.dispose();
      scene = null;
    });
  });

  const status = () => snapshot()?.status ?? 'booting';

  const onSlider = (controlId, value) => {
    const num = Number(value);
    setValues((prev) => ({ ...prev, [controlId]: num }));
    scene?.setControl(controlId, num);
  };

  return (
    <div class="cut-test-shell horde-viewer-shell">
      <canvas
        ref={canvas}
        class="cut-test-canvas"
        aria-label="Sim human viewer"
        tabindex="0"
      />
      <div class="cut-test-panel horde-viewer-panel">
        <div class="cut-test-header">
          <span>Sim human</span>
          <strong class={`cut-test-status ${status()}`}>{status()}</strong>
        </div>

        <p class="horde-viewer-hint">
          M1/M2 visual gate — vibe-human skin, morphs, and Rigify-retargeted locomotion.
          Full slider panel arrives with the Character Maker.
        </p>

        <div class="cut-test-controls">
          <For each={sampleControls}>
            {(control) => (
              <label class="horde-viewer-section-label" style="display:block; margin-bottom:6px;">
                {control.tab} · {control.label}
                <input
                  type="range"
                  min={control.min}
                  max={control.max}
                  step="0.01"
                  value={values()[control.id] ?? 0}
                  onInput={(e) => onSlider(control.id, e.currentTarget.value)}
                  style="width:100%;"
                />
              </label>
            )}
          </For>
          <div class="cut-test-actions">
            <For each={SAMPLE_ANIMATIONS}>
              {(state) => (
                <button
                  type="button"
                  class="tb-btn"
                  onClick={() => scene?.setAnimation(state)}
                >
                  {state}
                </button>
              )}
            </For>
            <button
              type="button"
              class="tb-btn"
              onClick={() => {
                setValues({});
                scene?.resetControls();
              }}
            >
              Reset
            </button>
          </div>
        </div>

        <div class="cut-test-stats">
          <span>Morph meshes {snapshot()?.morphMeshes ?? 0}</span>
          <span>Bones {snapshot()?.bones ?? 0}</span>
          <span>Raw H {snapshot()?.rawHeight ?? '—'}</span>
          <span>Anim {snapshot()?.animationState ?? '—'}</span>
        </div>

        <Show when={snapshot()?.error}>
          <div class="horde-viewer-error">{snapshot()?.error}</div>
        </Show>
      </div>
    </div>
  );
}
