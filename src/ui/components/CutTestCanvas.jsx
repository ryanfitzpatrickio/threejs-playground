import { createSignal, onCleanup, onMount } from 'solid-js';
import { CsgCutTestScene } from '../../game/test/CsgCutTestScene.js';

const PLANE_OPTIONS = [
  { id: 'vertical', label: 'Vertical' },
  { id: 'diagonal', label: 'Diagonal' },
  { id: 'shoulder', label: 'Shoulder' },
];

export function CutTestCanvas() {
  let canvas;
  let scene;
  const [snapshot, setSnapshot] = createSignal(null);
  const [planePreset, setPlanePreset] = createSignal('vertical');

  onMount(() => {
    scene = new CsgCutTestScene({
      canvas,
      onSnapshot: setSnapshot,
    });
    scene.start().catch((error) => {
      console.error('Cut test scene failed to start.', error);
    });

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        scene?.dispose();
        scene = null;
      });
    }
  });

  onCleanup(() => {
    scene?.dispose();
    scene = null;
  });

  const selectPreset = (preset) => {
    setPlanePreset(preset);
    scene?.setPlanePreset(preset);
  };

  const status = () => snapshot()?.status ?? 'ready';

  return (
    <div class="cut-test-shell">
      <canvas
        ref={canvas}
        class="cut-test-canvas"
        aria-label="CSG cut test viewport"
      />
      <div class="cut-test-panel">
        <div class="cut-test-header">
          <span>Cut Lab</span>
          <strong class={`cut-test-status ${status()}`}>{status()}</strong>
        </div>

        <div class="cut-test-controls">
          <div class="segmented-control three">
            {PLANE_OPTIONS.map((option) => (
              <button
                type="button"
                class={planePreset() === option.id ? 'active' : ''}
                onClick={() => selectPreset(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div class="cut-test-actions">
            <button type="button" class="tb-btn primary" onClick={() => scene?.cut()}>
              Cut
            </button>
            <button type="button" class="tb-btn" onClick={() => scene?.reset()}>
              Reset
            </button>
          </div>
        </div>

        <div class="cut-test-stats">
          <span>Phase {snapshot()?.phase ?? 1}</span>
          <span>Mode {snapshot()?.mode ?? 'aim'}</span>
          <span>Target {snapshot()?.target ?? 'enemy'}</span>
          <span>Render {snapshot()?.renderMode ?? 'static'}</span>
          <span>Anim {snapshot()?.animation ?? 'none'}</span>
          <span>Skinned {snapshot()?.skinnedMeshes ?? 0}</span>
          <span>Texture {snapshot()?.texture ?? 'no'}</span>
          <span>Preset {snapshot()?.preset ?? 'Vertical'}</span>
          <span>Angle {snapshot()?.aimAngle ?? '-'}</span>
          <span>Source {snapshot()?.sourceVertices ?? 0}</span>
          <span>Physics {snapshot()?.physics ?? 'ready'}</span>
          <span>Collider {snapshot()?.collider ?? '-'}</span>
          <span>Props {snapshot()?.propCount ?? 0}</span>
          <span>Rig {snapshot()?.rigMeshes ?? 0}</span>
          <span>Bodies {snapshot()?.ragdollBodies ?? 0}</span>
          <span>Joints {snapshot()?.ragdollJoints ?? 0}</span>
          <span>Motion {snapshot()?.ragdollMotion ?? 0}</span>
          <span>Low Y {snapshot()?.lowestPropY ?? '-'}</span>
          <span>Positive {snapshot()?.positiveVertices ?? 0}</span>
          <span>Negative {snapshot()?.negativeVertices ?? 0}</span>
          <span>Groups {(snapshot()?.positiveGroups ?? 0) + (snapshot()?.negativeGroups ?? 0)}</span>
          <span>Cut {snapshot()?.planeCutsSource ? 'yes' : 'no'}</span>
          <span>Viable {snapshot()?.viable ? 'yes' : 'no'}</span>
        </div>
      </div>
    </div>
  );
}
