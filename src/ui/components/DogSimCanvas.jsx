import { createSignal, createMemo, createEffect, onCleanup, onMount, For, Show } from 'solid-js';
import { DogSimScene, DOG_REFERENCE_PRESETS } from '../../game/test/DogSimScene.js';
import { DOG_FAMILIES, getAuthoredDogBreeds } from '../../game/characters/dog/dogCatalog.js';

const BEHAVIORS = [
  { id: 'idle', label: 'Idle' },
  { id: 'walk', label: 'Walk' },
  { id: 'trot', label: 'Trot' },
  { id: 'sit', label: 'Sit' },
  { id: 'look', label: 'Look' },
];

const MOUTH_STATES = [
  { id: 'closed', label: 'Mouth closed' },
  { id: 'open', label: 'Panting' },
  { id: 'alert', label: 'Alert' },
];

/**
 * Procedural dog simulation viewer.
 * Boot: main menu "Dog" or ?view=dog-sim
 * Harness: ?harness — deterministic presets + gallery API.
 */
export function DogSimCanvas(props) {
  let canvas;
  /** @type {DogSimScene | null} */
  let scene = null;
  const [snapshot, setSnapshot] = createSignal(null);
  const [referenceFailed, setReferenceFailed] = createSignal(false);

  onMount(() => {
    scene = new DogSimScene({
      canvas,
      onSnapshot: setSnapshot,
    });
    scene.start().catch((error) => {
      console.error('Dog sim scene failed to start.', error);
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
  const behavior = () => snapshot()?.behavior ?? 'idle';
  const mouthState = () => snapshot()?.mouthState ?? 'closed';
  const activePreset = createMemo(() => {
    const id = snapshot()?.preset;
    return DOG_REFERENCE_PRESETS.find((p) => p.id === id)
      ?? DOG_REFERENCE_PRESETS.find((p) => p.id === 'head-close')
      ?? null;
  });
  const refImageSrc = createMemo(() => snapshot()?.referenceImage ?? activePreset()?.refImage ?? null);
  const familyBreeds = createMemo(() => getAuthoredDogBreeds(snapshot()?.familyId));
  createEffect(() => {
    refImageSrc();
    setReferenceFailed(false);
  });

  return (
    <div class="cut-test-shell horde-viewer-shell dog-sim-shell">
      <canvas
        ref={canvas}
        class="cut-test-canvas"
        aria-label="Procedural dog simulation"
        tabindex="0"
      />

      <Show when={snapshot()?.compareEnabled}>
        <div class="dog-sim-compare">
          <div class="dog-sim-compare__label">
            Reference · {snapshot()?.breedLabel ?? 'Golden Retriever'} · {activePreset()?.label ?? snapshot()?.preset ?? '—'}
          </div>
          <Show
            when={refImageSrc() && !referenceFailed()}
            fallback={(
              <div class="dog-sim-compare__placeholder">
                Missing still — add JPG under
                <code> public/assets/dog-ref/ </code>
                ({snapshot()?.preset})
              </div>
            )}
          >
            <img
              class="dog-sim-compare__img"
              src={refImageSrc()}
              alt={`${snapshot()?.breedLabel ?? 'Dog'} reference ${activePreset()?.label ?? ''}`}
              onError={() => setReferenceFailed(true)}
            />
          </Show>
        </div>
      </Show>

      <div class="cut-test-panel horde-viewer-panel dog-sim-panel">
        <div class="cut-test-header">
          <span>Dog sim</span>
          <strong class={`cut-test-status ${status()}`}>{status()}</strong>
        </div>

        <p class="horde-viewer-hint">
          Data-driven ~{snapshot()?.bones ?? 40}-bone procedural dog with shell fur,
          shared gait rig, seeded conformation, and face features.
          {snapshot()?.harness ? ' Harness mode: frozen blink/breeze, fixed settle.' : ''}
        </p>

        <div class="cut-test-controls">
          <div class="horde-viewer-section-label">Generator</div>
          <div class="dog-sim-generator-grid">
            <label>
              <span>Family</span>
              <select
                value={snapshot()?.familyId ?? 'retriever-sporting'}
                onChange={(event) => scene?.setFamily(event.currentTarget.value)}
              >
                <For each={DOG_FAMILIES}>
                  {(family) => <option value={family.id}>{family.label}</option>}
                </For>
              </select>
            </label>
            <label>
              <span>Breed</span>
              <select
                value={snapshot()?.breedId ?? 'golden-retriever'}
                onChange={(event) => scene?.setBreed(event.currentTarget.value)}
              >
                <For each={familyBreeds()}>
                  {(breed) => <option value={breed.id}>{breed.label}</option>}
                </For>
              </select>
            </label>
          </div>
          <div class="dog-sim-seed-row">
            <span>Seed</span>
            <code>{snapshot()?.seed ?? 1}</code>
            <button type="button" class="tb-btn" onClick={() => scene?.randomize()}>
              Randomize
            </button>
          </div>
          <div class="dog-sim-breed-facts">
            <span>{snapshot()?.akcRank == null ? 'AKC rank —' : `AKC #${snapshot()?.akcRank}`}</span>
            <span>{snapshot()?.breedSummary?.size ?? '—'} · {snapshot()?.breedSummary?.build ?? '—'}</span>
            <span>{snapshot()?.breedSummary?.coat ?? '—'} coat</span>
            <span>Energy {snapshot()?.breedSummary?.energy ?? '—'}/5</span>
            <span>Trainability {snapshot()?.breedSummary?.trainability ?? '—'}/5</span>
          </div>

          <div class="horde-viewer-section-label">Behavior</div>
          <div class="horde-viewer-gate-grid">
            <For each={BEHAVIORS}>
              {(b) => (
                <button
                  type="button"
                  class={`tb-btn horde-gate-btn ${behavior() === b.id ? 'active' : ''}`}
                  onClick={() => scene?.setBehavior(b.id)}
                >
                  {b.label}
                </button>
              )}
            </For>
          </div>

          <div class="horde-viewer-section-label">Mouth</div>
          <div class="horde-viewer-gate-grid">
            <For each={MOUTH_STATES}>
              {(m) => (
                <button
                  type="button"
                  class={`tb-btn horde-gate-btn ${mouthState() === m.id ? 'active' : ''}`}
                  onClick={() => scene?.setMouthState(m.id)}
                >
                  {m.label}
                </button>
              )}
            </For>
          </div>

          <div class="horde-viewer-section-label">Camera presets</div>
          <div class="horde-viewer-clip-list">
            <For each={DOG_REFERENCE_PRESETS}>
              {(p) => (
                <button
                  type="button"
                  class={`horde-clip-chip ${snapshot()?.preset === p.id ? 'active' : ''}`}
                  onClick={() => scene?.applyPreset(p, { settle: snapshot()?.harness })}
                >
                  {p.label}
                </button>
              )}
            </For>
          </div>

          <div class="cut-test-actions">
            <button
              type="button"
              class="tb-btn"
              onClick={() => scene?.setLiveMotion(!snapshot()?.liveMotion)}
            >
              {snapshot()?.liveMotion ? 'Pause motion' : 'Live motion'}
            </button>
            <button
              type="button"
              class="tb-btn"
              onClick={() => scene?.setNakedBody(!snapshot()?.nakedBody)}
            >
              {snapshot()?.nakedBody ? 'Show fur' : 'Naked body'}
            </button>
            <button type="button" class="tb-btn" onClick={() => scene?.petImpulse()}>
              Pet
            </button>
          </div>

          <div class="cut-test-actions">
            <button
              type="button"
              class="tb-btn primary"
              onClick={() => scene?.nextGalleryPair()}
            >
              Gallery pair
            </button>
            <button
              type="button"
              class="tb-btn"
              onClick={() => scene?.setCompareEnabled(!snapshot()?.compareEnabled)}
            >
              {snapshot()?.compareEnabled ? 'Hide compare' : 'Compare panel'}
            </button>
            <Show when={props.onBack}>
              <button type="button" class="tb-btn" onClick={() => props.onBack?.()}>
                Menu
              </button>
            </Show>
          </div>
        </div>

        <div class="cut-test-stats">
          <span>Bones {snapshot()?.bones ?? 0}</span>
          <span>Verts {snapshot()?.verts ?? 0}</span>
          <span>Shells {snapshot()?.shells ?? 0}</span>
          <span>Speed {snapshot()?.speed ?? 0}</span>
        </div>

        <Show when={snapshot()?.error}>
          <div class="horde-viewer-error">{snapshot()?.error}</div>
        </Show>
      </div>
    </div>
  );
}
