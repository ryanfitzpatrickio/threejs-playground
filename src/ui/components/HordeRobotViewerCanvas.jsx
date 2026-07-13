import { createSignal, onCleanup, onMount, For, Show } from 'solid-js';
import {
  HordeRobotViewerScene,
  HORDE_BOTS,
  GATE_CLIPS,
  ALL_CLIPS,
} from '../../game/test/HordeRobotViewerScene.js';

/**
 * M0 human-gate viewer: load each public/assets/models/horde/*.glb and cycle
 * the gate clips (idle / run / attack / arm-missing / one-leg / crawl) plus
 * the full 13-clip contract. Boot with ?view=horde-robots.
 */
export function HordeRobotViewerCanvas() {
  let canvas;
  let scene;
  const [snapshot, setSnapshot] = createSignal(null);

  onMount(() => {
    scene = new HordeRobotViewerScene({
      canvas,
      onSnapshot: setSnapshot,
    });
    scene.start().catch((error) => {
      console.error('Horde robot viewer failed to start.', error);
    });

    const onKey = (e) => {
      const t = e.target;
      if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || t.tagName === 'SELECT' || t.isContentEditable)) return;

      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault();
        scene?.setBot(HORDE_BOTS[Number(e.key) - 1]);
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'n') {
        e.preventDefault();
        scene?.nextClip(1);
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'b') {
        e.preventDefault();
        scene?.nextClip(-1);
      } else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'g') {
        e.preventDefault();
        scene?.nextGateClip(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        scene?.nextGateClip(-1);
      } else if (e.key.toLowerCase() === 'c') {
        e.preventDefault();
        scene?.setAutoCycle(!scene.autoCycle);
      } else if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        scene?.setOrientationFlip(!scene.orientationFlip);
      }
    };
    globalThis.addEventListener('keydown', onKey);

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        globalThis.removeEventListener('keydown', onKey);
        scene?.dispose();
        scene = null;
      });
    }

    onCleanup(() => {
      globalThis.removeEventListener('keydown', onKey);
      scene?.dispose();
      scene = null;
    });
  });

  const status = () => snapshot()?.status ?? 'booting';
  const activeClip = () => snapshot()?.clipName ?? '—';
  const activeBot = () => snapshot()?.botId ?? HORDE_BOTS[0];

  return (
    <div class="cut-test-shell horde-viewer-shell">
      <canvas
        ref={canvas}
        class="cut-test-canvas"
        aria-label="Horde robot animation viewer"
        tabindex="0"
      />
      <div class="cut-test-panel horde-viewer-panel">
        <div class="cut-test-header">
          <span>Horde robots</span>
          <strong class={`cut-test-status ${status()}`}>{status()}</strong>
        </div>

        <p class="horde-viewer-hint">
          M0 visual gate — confirm deformation on the 6 highlighted clips before M2.
          Keys: 1–3 bots · ←/→ clip · ↓ gate · C auto-cycle · O flip orient
        </p>

        <div class="cut-test-controls">
          <div class="segmented-control three">
            <For each={HORDE_BOTS}>
              {(bot) => (
                <button
                  type="button"
                  class={activeBot() === bot ? 'active' : ''}
                  onClick={() => scene?.setBot(bot)}
                >
                  {bot}
                </button>
              )}
            </For>
          </div>

          <div class="horde-viewer-section-label">Gate clips</div>
          <div class="horde-viewer-gate-grid">
            <For each={GATE_CLIPS}>
              {(gate) => (
                <button
                  type="button"
                  class={`tb-btn horde-gate-btn ${activeClip() === gate.clip ? 'primary' : ''}`}
                  onClick={() => scene?.setClip(gate.clip)}
                  title={gate.clip}
                >
                  {gate.label}
                </button>
              )}
            </For>
          </div>

          <div class="horde-viewer-section-label">All clips</div>
          <div class="horde-viewer-clip-list">
            <For each={ALL_CLIPS}>
              {(name) => {
                const present = () => (snapshot()?.clipNames ?? []).includes(name);
                const isGate = () => GATE_CLIPS.some((g) => g.clip === name);
                return (
                  <button
                    type="button"
                    classList={{
                      'horde-clip-chip': true,
                      active: activeClip() === name,
                      gate: isGate(),
                      missing: !present(),
                    }}
                    disabled={!present()}
                    onClick={() => scene?.setClip(name)}
                  >
                    {name}
                  </button>
                );
              }}
            </For>
          </div>

          <div class="cut-test-actions">
            <button
              type="button"
              class={`tb-btn ${snapshot()?.autoCycle ? 'primary' : ''}`}
              onClick={() => scene?.setAutoCycle(!scene?.autoCycle)}
            >
              {snapshot()?.autoCycle ? 'Auto on' : 'Auto cycle'}
            </button>
            <button
              type="button"
              class={`tb-btn ${snapshot()?.orientationFlip ? 'primary' : ''}`}
              onClick={() => scene?.setOrientationFlip(!scene?.orientationFlip)}
              title="Add −90° X (soldier-style) orientation fix"
            >
              Flip orient
            </button>
            <button type="button" class="tb-btn" onClick={() => scene?.nextClip(-1)}>
              Prev
            </button>
            <button type="button" class="tb-btn" onClick={() => scene?.nextClip(1)}>
              Next
            </button>
          </div>
        </div>

        <div class="cut-test-stats">
          <span>Bot {activeBot()}</span>
          <span title={activeClip()}>Clip {activeClip()}</span>
          <span>Dur {snapshot()?.clipDuration ?? '—'}s</span>
          <span>Gate {snapshot()?.isGateClip ? 'yes' : 'no'}</span>
          <span>Skinned {snapshot()?.skinnedMeshes ?? 0}</span>
          <span>Bones {snapshot()?.bones ?? 0}</span>
          <span>Verts {(snapshot()?.verts ?? 0).toLocaleString?.() ?? snapshot()?.verts ?? 0}</span>
          <span>H {snapshot()?.targetHeight ?? '—'}</span>
          <span>Ori {snapshot()?.orientationFixX ?? 0}</span>
          <span>Flip {snapshot()?.orientationFlip ? 'on' : 'off'}</span>
          <span>Clips {(snapshot()?.clipNames ?? []).length}</span>
          <span>Auto {snapshot()?.autoCycle ? 'on' : 'off'}</span>
        </div>

        <Show when={snapshot()?.error}>
          <div class="horde-viewer-error">{snapshot()?.error}</div>
        </Show>
      </div>
    </div>
  );
}
