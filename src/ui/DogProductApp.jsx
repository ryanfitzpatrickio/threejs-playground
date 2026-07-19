import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { mountShaderDebugPane, registerBuiltinShaderDebug } from 'virtual:dreamfall-shader-debug';
import { GameCanvas } from './components/GameCanvas.jsx';
import { DogParkHud, DogCustomizeIcon } from './components/DogParkHud.jsx';
import { DogSimCanvas } from './components/DogSimCanvas.jsx';
import { StatsPanel } from './components/StatsPanel.jsx';

/**
 * Standalone dog product shell (docs/dog-park-standalone-deploy-plan.md).
 * Phase P boots the playable outdoor park by default. The studio remains a
 * focused reference harness at `?dogMode=studio`; App.jsx and the playground
 * chrome stay outside this product graph.
 */
export function DogProductApp() {
  const [mode, setMode] = createSignal(readDogProductMode());
  const [snapshot, setSnapshot] = createSignal(null);
  const [showDogMenu, setShowDogMenu] = createSignal(false);
  const [showDebugMenu, setShowDebugMenu] = createSignal(false);
  let debugPaneHandle = null;

  onMount(() => {
    registerBuiltinShaderDebug(null);
    let cancelled = false;
    void mountShaderDebugPane({ parent: document.body, visible: false }).then((handle) => {
      if (cancelled) {
        handle?.dispose?.();
        return;
      }
      debugPaneHandle = handle;
      handle?.setVisible?.(showDebugMenu());
    });
    const onKeyDown = (event) => {
      const target = event.target;
      if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setShowDebugMenu((open) => !open);
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      cancelled = true;
      globalThis.removeEventListener('keydown', onKeyDown);
      debugPaneHandle?.dispose?.();
      debugPaneHandle = null;
    });
  });

  createEffect(() => {
    // Read the signal before the optional handle access so Solid subscribes
    // even while the async pane is still mounting.
    const visible = showDebugMenu();
    debugPaneHandle?.setVisible?.(visible);
  });

  const switchMode = (nextMode) => {
    const next = nextMode === 'studio' ? 'studio' : 'park';
    const url = new URL(globalThis.location.href);
    if (next === 'studio') url.searchParams.set('dogMode', 'studio');
    else url.searchParams.delete('dogMode');
    globalThis.history.replaceState(null, '', url);
    setSnapshot(null);
    setShowDogMenu(false);
    setMode(next);
  };

  return (
    <main class="app-shell dog-product-shell">
      <Show
        when={mode() === 'park'}
        fallback={(
          <>
            <DogSimCanvas />
            <Show when={import.meta.env.DEV}>
              <button
                type="button"
                class="dog-product-mode-toggle dog-product-debug-toggle"
                classList={{ active: showDebugMenu() }}
                onClick={() => setShowDebugMenu((open) => !open)}
              >
                Debug
              </button>
            </Show>
            <button
              type="button"
              class="dog-product-mode-toggle"
              onClick={() => switchMode('park')}
            >
              Play park
            </button>
          </>
        )}
      >
        <GameCanvas levelMode="dog-park" onSnapshot={setSnapshot} />
        <Show when={snapshot()?.stage !== 'running'}>
          <div class="dog-product-loading" role="status" aria-live="polite">
            <strong>Opening Dog Park</strong>
            <span>{snapshot()?.loadProgress?.label ?? 'Starting…'}</span>
          </div>
        </Show>
        <Show when={snapshot()?.stage === 'running'}>
          <div class="top-bar-switchers dog-product-top-bar">
            <div class="top-bar-actions">
              <Show when={import.meta.env.DEV}>
                <button
                  type="button"
                  class="settings-btn"
                  classList={{ active: showDebugMenu() }}
                  onClick={() => setShowDebugMenu((open) => !open)}
                  title="Dog debug controls (P)"
                >
                  Debug
                </button>
              </Show>
              <button
                type="button"
                class="settings-btn dog-customize-btn"
                classList={{ active: showDogMenu() }}
                onClick={() => setShowDogMenu((open) => !open)}
                title="Customize dog"
                aria-label="Customize dog"
                aria-expanded={showDogMenu()}
              >
                <DogCustomizeIcon />
                Customize
              </button>
            </div>
          </div>
          <StatsPanel snapshot={snapshot()} />
          <DogParkHud
            snapshot={snapshot()?.dogPark}
            open={showDogMenu()}
            onOpenChange={setShowDogMenu}
            onStudio={() => switchMode('studio')}
          />
        </Show>
      </Show>
    </main>
  );
}

function readDogProductMode() {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  return params.get('dogMode') === 'studio' ? 'studio' : 'park';
}
