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
    return v === 'world' || v === 'wilds' || v === 'rally' ? v : 'city';
  } catch {
    return 'city';
  }
}

function formatVehicleCameraMode(mode) {
  switch (mode) {
    case 'medium':
      return 'Medium chase';
    case 'far':
      return 'Far chase';
    case 'firstPerson':
      return 'First person';
    default:
      return 'Close chase';
  }
}

export function App() {
  const [viewMode, setViewMode] = createSignal('game'); // 'game' | 'garage' | dev-tool views
  const [levelMode, setLevelModeSignal] = createSignal(readStoredLevel()); // 'city' | 'world'
  const [gameSnapshot, setGameSnapshot] = createSignal(null);
  const [quality, setQuality] = createSignal(getQualityLevel());
  const [toneMapping, setToneMapping] = createSignal(getToneMappingMode());
  const [postEffect, setPostEffect] = createSignal(getPostEffectMode());
  const [showControls, setShowControls] = createSignal(false);
  const [showDebugPanel, setShowDebugPanel] = createSignal(false);
  const [hudVisible, setHudVisible] = createSignal(true);
  const [showClothEditor, setShowClothEditor] = createSignal(false);
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
        <div class="scene-switcher" style="display: flex; gap: 1px; background: rgb(22 21 18 / 92%); border: 1px solid rgb(247 244 232 / 18%); border-radius: 999px; padding: 2px; pointer-events: auto; box-shadow: 0 6px 18px rgb(0 0 0 / 25%);">
          <button
            class={`mode-btn ${isGame() && levelMode() === 'city' ? 'active' : ''}`}
            onClick={() => setLevelMode('city')}
            title="City — infinite generated city"
          >
            City
          </button>
          <button
            class={`mode-btn ${isGame() && levelMode() === 'world' ? 'active' : ''}`}
            onClick={() => setLevelMode('world')}
            title="World — streaming editable terrain"
          >
            World
          </button>
          <button
            class={`mode-btn rally-mode-btn ${isGame() && levelMode() === 'rally' ? 'active' : ''}`}
            onClick={() => setLevelMode('rally')}
            title="Rally — Pine Ridge dirt stage and rally car"
          >
            Rally
          </button>
          <button
            class={`mode-btn ${isGame() && levelMode() === 'wilds' ? 'active' : ''}`}
            onClick={() => setLevelMode('wilds')}
            title="Wilds — eroded alpine valley with instanced forest"
          >
            Wilds
          </button>
          <button
            class={`mode-btn ${isGarage() ? 'active' : ''}`}
            onClick={() => switchTo('garage')}
            title="Garage — build and save vehicle configurations"
          >
            Garage
          </button>
          <devTools.ModeButtons />
        </div>
        <div class="quality-switcher" style="display: flex; gap: 1px; background: rgb(22 21 18 / 92%); border: 1px solid rgb(247 244 232 / 18%); border-radius: 999px; padding: 2px; pointer-events: auto; box-shadow: 0 6px 18px rgb(0 0 0 / 25%);">
          <button
            class={`mode-btn ${quality() === 'ultra' ? 'active' : ''}`}
            onClick={() => handleQualityChange('ultra')}
            title="Ultra — 2K shadows, extended draw distance, maximum environment quality"
          >
            Ultra
          </button>
          <button
            class={`mode-btn ${quality() === 'high' ? 'active' : ''}`}
            onClick={() => handleQualityChange('high')}
            title="Medium — balanced quality and performance"
          >
            Med
          </button>
          <button
            class={`mode-btn ${quality() === 'low' ? 'active' : ''}`}
            onClick={() => handleQualityChange('low')}
            title="Low Quality (Capped Pixel Ratio, Smaller City Loading)"
          >
            Low
          </button>
          <button
            class={`mode-btn ${toneMapping() === 'ACESFilmic' ? 'active' : ''}`}
            onClick={() => handleToneMappingChange('ACESFilmic')}
            title="ACES Filmic — warmer cinematic highlight rolloff"
          >
            ACES
          </button>
          <button
            class={`mode-btn ${toneMapping() === 'AgX' ? 'active' : ''}`}
            onClick={() => handleToneMappingChange('AgX')}
            title="AgX — more neutral color and highlight handling"
          >
            AgX
          </button>
          <button
            class={`mode-btn ${postEffect() === 'ssao' ? 'active' : ''}`}
            onClick={() => handlePostEffectChange('ssao')}
            title="SSAO — screen-space ambient occlusion darkens indirect light in crevices (Low quality runs Off)"
          >
            SSAO
          </button>
          <button
            class={`mode-btn ${postEffect() === 'ssr' ? 'active' : ''}`}
            onClick={() => handlePostEffectChange('ssr')}
            title="SSR — screen-space reflections on wet/metallic surfaces (Low quality runs Off)"
          >
            SSR
          </button>
          <button
            class={`mode-btn ${postEffect() === 'off' ? 'active' : ''}`}
            onClick={() => handlePostEffectChange('off')}
            title="Off — no screen-space lighting effects"
          >
            Off
          </button>
          <Show when={isGame() && gameSnapshot()?.vehicles?.activeId}>
            <button
              class={`icon-btn camera-mode-btn ${gameSnapshot()?.camera?.vehicleCameraMode !== 'close' ? 'active' : ''}`}
              onClick={() => gameRuntime?.cycleVehicleCameraMode()}
              title={`Driving camera: ${formatVehicleCameraMode(gameSnapshot()?.camera?.vehicleCameraMode)}`}
              aria-label="Cycle driving camera mode"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M12 5c-5 0-9.27 3.11-11 7.5 1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
                />
              </svg>
            </button>
          </Show>
          <button
            class={`mode-btn ${gameSnapshot()?.camera?.photoMode ? 'active' : ''}`}
            onClick={() => gameRuntime?.setPhotoMode(!gameSnapshot()?.camera?.photoMode)}
            title="Camera mode — pause gameplay and fly the camera (K)"
          >
            Camera
          </button>
          <Show when={isJacketClothUiEnabled()}>
            <button
              class={`mode-btn ${showClothEditor() ? 'active' : ''}`}
              onClick={() => setShowClothEditor((value) => !value)}
              title="Edit player cloth collider spheres live"
            >
              Cloth
            </button>
          </Show>
          <button
            class="help-btn"
            onClick={() => setShowControls(true)}
            title="Controls (press ?)"
          >
            ?
          </button>
        </div>
      </div>
      </Show>

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
