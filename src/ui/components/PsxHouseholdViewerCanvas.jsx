import { createSignal, onCleanup, onMount, For, Show, createMemo } from 'solid-js';
import { PsxHouseholdViewerScene } from '../../game/test/PsxHouseholdViewerScene.js';

/**
 * Catalog + WebGPU viewer for PSX household prop packs.
 * Boot: ?view=psx-household (aliases: household-props, psx-props)
 */
export function PsxHouseholdViewerCanvas() {
  let canvas;
  let scene;
  const [snapshot, setSnapshot] = createSignal(null);

  onMount(() => {
    scene = new PsxHouseholdViewerScene({
      canvas,
      onSnapshot: setSnapshot,
    });
    scene.start().catch((error) => {
      console.error('PSX household viewer failed to start.', error);
    });

    const onKey = (e) => {
      const t = e.target;
      if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
        || t.tagName === 'SELECT' || t.isContentEditable)) return;

      if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'n') {
        e.preventDefault();
        scene?.nextMesh(1);
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'b') {
        e.preventDefault();
        scene?.nextMesh(-1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        scene?.nextPack(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        scene?.nextPack(-1);
      } else if (e.key.toLowerCase() === 'a') {
        e.preventDefault();
        scene?.setShowAllMeshes(!scene.showAllMeshes);
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        scene?.setNormalizeSize(!scene.normalizeSize);
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
  const mode = () => snapshot()?.mode ?? 'packs';
  const packList = createMemo(() => (
    mode() === 'characters' ? (snapshot()?.characters ?? []) : (snapshot()?.packs ?? [])
  ));
  const meshList = createMemo(() => snapshot()?.filteredMeshNames ?? []);
  const householdClass = (h) => {
    if (h === 'high') return 'psx-viability high';
    if (h === 'medium') return 'psx-viability medium';
    if (h === 'low') return 'psx-viability low';
    return 'psx-viability';
  };

  return (
    <div class="cut-test-shell horde-viewer-shell psx-household-shell">
      <canvas
        ref={canvas}
        class="cut-test-canvas"
        aria-label="PSX household prop catalog viewer"
        tabindex="0"
      />
      <div class="cut-test-panel horde-viewer-panel psx-household-panel">
        <div class="cut-test-header">
          <span>PSX household</span>
          <strong class={`cut-test-status ${status()}`}>{status()}</strong>
        </div>

        <p class="horde-viewer-hint">
          Catalog of low-poly PSX props for the sims lot. High-viability packs are production
          candidates; characters and the misc cube pack are for reference only.
          Keys: ←/→ mesh · ↑/↓ pack · A show-all · Z normalize
        </p>

        <div class="cut-test-controls">
          <div class="segmented-control two">
            <button
              type="button"
              class={mode() === 'packs' ? 'active' : ''}
              onClick={() => scene?.setMode('packs')}
            >
              Packs
            </button>
            <button
              type="button"
              class={mode() === 'characters' ? 'active' : ''}
              onClick={() => scene?.setMode('characters')}
            >
              Characters
            </button>
          </div>

          <Show when={mode() === 'packs'}>
            <div class="horde-viewer-section-label">Viability filter</div>
            <div class="segmented-control four">
              <For each={['all', 'high', 'medium', 'low']}>
                {(v) => (
                  <button
                    type="button"
                    class={snapshot()?.viabilityFilter === v ? 'active' : ''}
                    onClick={() => scene?.setViabilityFilter(v)}
                  >
                    {v}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <div class="horde-viewer-section-label">
            {mode() === 'characters' ? 'Characters' : 'Packs'}
          </div>
          <div class="psx-pack-list">
            <For each={packList()}>
              {(pack) => (
                <button
                  type="button"
                  classList={{
                    'psx-pack-chip': true,
                    active: snapshot()?.packId === pack.id,
                  }}
                  onClick={() => scene?.setPack(pack.id)}
                  title={pack.notes ?? pack.label}
                >
                  <span class={householdClass(pack.household)}>{pack.household ?? '—'}</span>
                  <span class="psx-pack-label">{pack.label}</span>
                  <span class="psx-pack-meta">
                    {pack.meshCount != null ? `${pack.meshCount}m` : ''}
                    {pack.bytesLabel ? ` · ${pack.bytesLabel}` : ''}
                  </span>
                </button>
              )}
            </For>
          </div>

          <Show when={snapshot()?.notes}>
            <p class="horde-viewer-hint psx-pack-notes">{snapshot()?.notes}</p>
          </Show>

          <div class="cut-test-actions">
            <button
              type="button"
              class={`tb-btn ${snapshot()?.showAllMeshes ? 'primary' : ''}`}
              onClick={() => scene?.setShowAllMeshes(!scene?.showAllMeshes)}
            >
              {snapshot()?.showAllMeshes ? 'All meshes' : 'Single mesh'}
            </button>
            <button
              type="button"
              class={`tb-btn ${snapshot()?.normalizeSize ? 'primary' : ''}`}
              onClick={() => scene?.setNormalizeSize(!scene?.normalizeSize)}
            >
              Normalize
            </button>
            <button type="button" class="tb-btn" onClick={() => scene?.nextMesh(-1)}>Prev</button>
            <button type="button" class="tb-btn" onClick={() => scene?.nextMesh(1)}>Next</button>
          </div>

          <Show when={mode() === 'packs' && !snapshot()?.showAllMeshes}>
            <label class="horde-viewer-section-label" style="display:block;">
              Filter meshes
              <input
                type="search"
                class="psx-mesh-filter"
                value={snapshot()?.filter ?? ''}
                placeholder="chair, fridge, lamp…"
                onInput={(e) => scene?.setFilter(e.currentTarget.value)}
              />
            </label>
            <div class="horde-viewer-clip-list psx-mesh-list">
              <For each={meshList()}>
                {(name) => (
                  <button
                    type="button"
                    classList={{
                      'horde-clip-chip': true,
                      active: snapshot()?.meshId === name,
                    }}
                    onClick={() => scene?.setMesh(name)}
                  >
                    {name}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="cut-test-stats">
          <span title={snapshot()?.packLabel}>{snapshot()?.packLabel ?? '—'}</span>
          <span class={householdClass(snapshot()?.household)}>{snapshot()?.household ?? '—'}</span>
          <span title={snapshot()?.meshId}>{snapshot()?.showAllMeshes ? 'ALL' : (snapshot()?.meshId ?? '—')}</span>
          <span>Meshes {snapshot()?.meshCount ?? 0}</span>
          <span>Vis {snapshot()?.visibleMeshCount ?? 0}</span>
          <span>Verts {(snapshot()?.verts ?? 0).toLocaleString?.() ?? snapshot()?.verts ?? 0}</span>
          <span>{snapshot()?.bytesLabel ?? '—'}</span>
          <span>Norm {snapshot()?.normalizeSize ? 'on' : 'off'}</span>
        </div>

        <Show when={snapshot()?.viability}>
          <div class="psx-viability-summary">
            <div class="horde-viewer-section-label">Household sim viability</div>
            <div class="cut-test-stats">
              <span class="psx-viability high">high {(snapshot()?.viability?.high ?? []).length}</span>
              <span class="psx-viability medium">med {(snapshot()?.viability?.medium ?? []).length}</span>
              <span class="psx-viability low">low {(snapshot()?.viability?.low ?? []).length}</span>
              <span>~{snapshot()?.viability?.recommendedHouseholdMeshEstimate ?? 0} props</span>
            </div>
          </div>
        </Show>

        <Show when={snapshot()?.error}>
          <div class="horde-viewer-error">{snapshot()?.error}</div>
        </Show>
      </div>
    </div>
  );
}
