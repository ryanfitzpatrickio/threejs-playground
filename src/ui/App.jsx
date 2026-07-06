import { createSignal, createMemo, onCleanup, onMount, Show } from 'solid-js';
import { GameCanvas } from './components/GameCanvas.jsx';
import { Hud } from './components/Hud.jsx';
import { StatsPanel } from './components/StatsPanel.jsx';
import { DebugPanel } from './components/DebugPanel.jsx';
import { ControlsGuide, ControlsHelpButton } from './components/ControlsGuide.jsx';
import { CutTestCanvas } from './components/CutTestCanvas.jsx';
import { Minimap } from './components/Minimap.jsx';
import { PhotoModeControls } from './components/PhotoModeControls.jsx';
import { GarageScene } from './components/GarageScene.jsx';
import { ClothColliderEditor } from './components/ClothColliderEditor.jsx';
import { SettingsDialog } from './components/SettingsDialog.jsx';
import { isJacketClothUiEnabled } from '../game/characters/mara/jacketConfig.js';
import {
  setActiveSceneId,
  getActiveSceneId,
  getActiveWorldMapSync,
  getDefaultWorldSceneId,
  getDefaultRallySceneId,
  getRallyWorldMapSync,
} from '../world/worldMap/worldMapScenes.js';
import {
  getPostEffectMode,
  getQualityLevel,
  getToneMappingMode,
  setPostEffectMode,
  setQualityLevel,
  setToneMappingMode,
} from '../game/config/qualityPresets.js';
import { createDevTools } from 'virtual:dreamfall-dev-tools';

function readStoredLevel() {
  try {
    const v = localStorage.getItem('dreamfall:level');
    return v === 'world' || v === 'wilds' || v === 'rally' || v === 'city' ? v : 'rally';
  } catch {
    return 'rally';
  }
}

export function App() {
  const [viewMode, setViewMode] = createSignal('game'); // 'game' | 'garage' | dev-tool views
  const [levelMode, setLevelModeSignal] = createSignal(readStoredLevel());
  const [gameSnapshot, setGameSnapshot] = createSignal(null);
  const [quality, setQuality] = createSignal(getQualityLevel());
  const [toneMapping, setToneMapping] = createSignal(getToneMappingMode());
  const [postEffect, setPostEffect] = createSignal(getPostEffectMode());
  const [showControls, setShowControls] = createSignal(false);
  const [showDebugPanel, setShowDebugPanel] = createSignal(false);
  const [hudVisible, setHudVisible] = createSignal(true);
  const [showClothEditor, setShowClothEditor] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  let gameRuntime = null;

  // First-time player guide: show automatically unless previously dismissed
  onMount(() => {
    try {
      const dismissed = localStorage.getItem('dreamfall:controls-dismissed') === 'true';
      if (!dismissed) {
        // small delay so the world has time to appear
        const t = setTimeout(() => setShowControls(true), 620);
        onCleanup(() => clearTimeout(t));
      }
    } catch {
      // localStorage may be unavailable; show once
      setTimeout(() => setShowControls(true), 620);
    }
  });

  const handleQualityChange = (level) => {
    if (level === quality()) return;
    setQualityLevel(level);
    setQuality(level);
    window.location.reload();
  };

  const handleToneMappingChange = (mode) => {
    if (mode === toneMapping()) return;
    setToneMappingMode(mode);
    setToneMapping(mode);
    window.location.reload();
  };

  const handlePostEffectChange = (mode) => {
    if (mode === postEffect()) return;
    setPostEffectMode(mode);
    setPostEffect(mode);
    window.location.reload();
  };

  // Which saved scene the World scene plays; bumps the GameCanvas key so picking
  // a scene rebuilds the runtime with that map.
  const [activeSceneId, setActiveSceneIdSignal] = createSignal(getActiveSceneId());
  // Bumped on every explicit "play" so replaying the SAME scene id (the usual
  // draft loop: edit → ▶ Play) still remounts GameCanvas. Without this, the keyed
  // Show sees an unchanged `world:__draft__` key and keeps the stale level built
  // from the draft as it was when the canvas first mounted.
  const [playRevision, setPlayRevision] = createSignal(0);

  // Load a saved world-map scene into the playable World scene.
  const playScene = (id) => {
    setActiveSceneId(id);              // persist for LevelSystem.getActiveWorldMap
    setActiveSceneIdSignal(id);
    setPlayRevision((n) => n + 1);
    try { localStorage.setItem('dreamfall:level', 'world'); } catch {}
    setLevelModeSignal('world');
    switchTo('game');
  };

  const toggleMode = () => {
    devTools.toggleMode();
  };

  // Global hotkey for mode switch (works from either canvas)
  const onGlobalKey = (e) => {
    // Don't hijack typing in form fields (e.g. 'p' toggling the debug panel, 'm'
    // switching mode) while the focus is in an input/textarea/select/contentEditable.
    const t = e.target;
    if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
      || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'Escape' && showSettings()) {
      e.preventDefault();
      setShowSettings(false);
      return;
    }
    if (e.key === 'Escape' && gameSnapshot()?.camera?.photoMode && !hudVisible()) {
      e.preventDefault();
      setHudVisible(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      toggleMode();
    }
    if (e.key === '?') {
      e.preventDefault();
      if (viewMode() === 'game') {
        setShowControls(true);
      } else {
        toggleMode();
      }
    }
    // 'p' toggles the render-feature debug panel (game mode only).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      setShowDebugPanel((v) => !v);
    }
  };

  // Attach once
  globalThis.addEventListener('keydown', onGlobalKey);
  onCleanup(() => globalThis.removeEventListener('keydown', onGlobalKey));

  const isGame = () => viewMode() === 'game';
  const isGarage = () => viewMode() === 'garage';
  const isCutTest = () => viewMode() === 'cutTest';

  // Stable key for the playable canvas: changes only when the scene actually
  // changes (City⇄World, or a different World map). Memoized so equal values
  // don't re-fire — and the keyed child must NOT read signals, or it remounts
  // on every game snapshot.
  const gameKey = createMemo(() => {
    const mode = levelMode();
    if (mode === 'world') return `world:${activeSceneId() ?? 'draft'}:${playRevision()}`;
    if (mode === 'rally') return `rally:${getDefaultRallySceneId() ?? 'builtin'}`;
    return mode;
  });

  // The world map currently being played (for the minimap). Recomputed when the
  // active scene changes; null in City mode.
  const activeWorldMap = createMemo(() =>
    levelMode() === 'world'
      ? (activeSceneId(), playRevision(), getActiveWorldMapSync())
      : levelMode() === 'rally' ? getRallyWorldMapSync() : null,
  );

  // Centralized switch that forces terrain save when leaving the editor
  const switchTo = (mode) => {
    const current = viewMode();
    if (current === mode) return;

    devTools.beforeSwitch(current, mode);

    setViewMode(mode);
  };

  // Switch the playable scene (City ⇄ World). Persisted so reloads restore it.
  // Changing levelMode while in game remounts GameCanvas (keyed Show below), so a
  // fresh GameRuntime builds the chosen level.
  const setLevelMode = (mode) => {
    const next = ['world', 'wilds', 'rally'].includes(mode) ? mode : 'city';
    try {
      localStorage.setItem('dreamfall:level', next);
    } catch {}
    if (next === 'world') {
      const defId = getDefaultWorldSceneId();
      setActiveSceneId(defId || null);
      setActiveSceneIdSignal(defId || null);
      setPlayRevision((n) => n + 1);
    }
    setLevelModeSignal(next);
    switchTo('game');
  };

  const devTools = createDevTools({
    viewMode,
    switchTo: (mode) => switchTo(mode),
    onPlayScene: (id) => playScene(id),
  });

  return (
    <main class="app-shell">
      {/* Persistent minimal switchers (visible on both "pages") */}
      <Show when={!gameSnapshot()?.camera?.photoMode || hudVisible()}>
      <div class="top-bar-switchers" style="position: absolute; top: 10px; right: 12px; z-index: 20; display: flex; gap: 6px; pointer-events: none;">
        <div class="top-bar-actions">
          <button
            type="button"
            class="settings-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
            aria-label="Open settings"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54A.484.484 0 0 0 14.94 2h-3.88c-.24 0-.44.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.63.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.24.41.47.41h3.88c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
              />
            </svg>
            Settings
          </button>
          <button
            class="help-btn"
            onClick={() => setShowControls(true)}
            title="Controls (press ?)"
            aria-label="Show controls guide"
          >
            ?
          </button>
        </div>
      </div>
      </Show>

      <SettingsDialog
        open={showSettings()}
        onClose={() => setShowSettings(false)}
        snapshot={gameSnapshot()}
        viewMode={viewMode()}
        levelMode={levelMode()}
        quality={quality()}
        toneMapping={toneMapping()}
        postEffect={postEffect()}
        clothEditorEnabled={isJacketClothUiEnabled()}
        clothEditorOpen={showClothEditor()}
        debugPanelOpen={showDebugPanel()}
        devModeButtons={<devTools.ModeButtons />}
        onLevelModeChange={setLevelMode}
        onOpenGarage={() => {
          setShowSettings(false);
          switchTo('garage');
        }}
        onQualityChange={handleQualityChange}
        onToneMappingChange={handleToneMappingChange}
        onPostEffectChange={handlePostEffectChange}
        onVehicleCameraModeChange={(mode) => gameRuntime?.setVehicleCameraMode(mode)}
        onComfortChange={(enabled) => gameRuntime?.setCameraComfortEnabled(enabled)}
        onOnFootFirstPersonChange={(enabled) => gameRuntime?.setOnFootFirstPersonEnabled(enabled)}
        onCameraFeelChange={(feel) => gameRuntime?.setCameraFeel(feel)}
        onPhotoModeChange={(enabled) => gameRuntime?.setPhotoMode(enabled)}
        onClothEditorChange={setShowClothEditor}
        onDebugPanelChange={setShowDebugPanel}
      />

      {isGame() && (
        <>
          {/* keyed so switching City⇄World (or picking a different World scene)
              remounts GameCanvas, disposing the old GameRuntime and building the
              chosen level fresh. The child derives mode from the key value and
              reads NO signals — reading one here caused an infinite remount loop. */}
          <Show when={gameKey()} keyed>
            {(key) => (
              <GameCanvas
                levelMode={key.startsWith('world') ? 'world' : key.startsWith('rally') ? 'rally' : key}
                onSnapshot={setGameSnapshot}
                onRuntime={(runtime) => { gameRuntime = runtime; }}
              />
            )}
          </Show>
          {hudVisible() && <StatsPanel snapshot={gameSnapshot()} />}
          {hudVisible() && <DebugPanel snapshot={gameSnapshot()} open={showDebugPanel()} />}
          {hudVisible() && <Hud snapshot={gameSnapshot()} />}
          <Show when={hudVisible() && isJacketClothUiEnabled() && showClothEditor()}>
            <ClothColliderEditor
              runtime={() => gameRuntime}
              onClose={() => setShowClothEditor(false)}
            />
          </Show>
          {hudVisible() && (levelMode() === 'world' || levelMode() === 'rally') && activeWorldMap() && (
            <Minimap map={activeWorldMap()} player={gameSnapshot()?.player} />
          )}
          <Show when={gameSnapshot()?.camera?.photoMode && hudVisible()}>
            <PhotoModeControls
              snapshot={gameSnapshot()}
              hudVisible={hudVisible()}
              onToggleHud={() => {
                setShowControls(false);
                setHudVisible(false);
              }}
              onToggle={(enabled) => gameRuntime?.setPhotoMode(enabled)}
              onSetting={(name, value) => gameRuntime?.setPhotoSetting(name, value)}
            />
          </Show>
          <Show when={hudVisible()}>
            <ControlsGuide open={showControls()} onOpenChange={setShowControls} />
          </Show>
          {gameSnapshot()?.stage === 'prewarming' && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.75)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'system-ui, sans-serif',
                fontSize: '18px',
                zIndex: 9999,
                pointerEvents: 'none'
              }}
            >
              Warming shaders...
            </div>
          )}
        </>
      )}

      {isCutTest() && <CutTestCanvas />}

      {isGarage() && <GarageScene onDrive={() => setLevelMode(levelMode())} />}

      <devTools.Views />
    </main>
  );
}
