import { createSignal, createMemo, createEffect, onCleanup, onMount, Show } from 'solid-js';
import { GameCanvas } from './components/GameCanvas.jsx';
import { Hud } from './components/Hud.jsx';
import { StatsPanel } from './components/StatsPanel.jsx';
import { ControlsGuide } from './components/ControlsGuide.jsx';
import { CutTestCanvas } from './components/CutTestCanvas.jsx';
import { HordeRobotViewerCanvas } from './components/HordeRobotViewerCanvas.jsx';
import { SimHumanViewerCanvas } from './components/SimHumanViewerCanvas.jsx';
import { PsxHouseholdViewerCanvas } from './components/PsxHouseholdViewerCanvas.jsx';
import { DogSimCanvas } from './components/DogSimCanvas.jsx';
import { DogParkHud, DogCustomizeIcon } from './components/DogParkHud.jsx';
import { SimCreatorScene } from './components/SimCreatorScene.jsx';
import { Minimap } from './components/Minimap.jsx';
import { PhotoModeControls } from './components/PhotoModeControls.jsx';
import { GarageScene } from './components/GarageScene.jsx';
import { ClothColliderEditor } from './components/ClothColliderEditor.jsx';
import { SettingsDialog } from './components/SettingsDialog.jsx';
import { LoadingScreen } from './components/LoadingScreen.jsx';
import { MainMenu } from './components/MainMenu.jsx';
import { DeathmatchLobby } from './components/DeathmatchLobby.jsx';
import { DeathmatchRoomOverlay } from './components/DeathmatchRoomOverlay.jsx';
import { DeathmatchNetworkSystem } from '../game/systems/DeathmatchNetworkSystem.js';
import { resolvePartyKitHost } from '../game/net/deathmatchClientConfig.js';
import { MATCH_PHASE } from '../game/config/deathmatch/deathmatchRules.js';
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
  getQualityPreset,
  getToneMappingMode,
  setPostEffectMode,
  setQualityLevel,
  setToneMappingMode,
} from '../game/config/qualityPresets.js';
import {
  resolveCloudMode,
  setCloudModeOverride,
} from '../game/render/cloud/cloudConfig.js';
import { GAME_CONFIG } from '../game/config/gameConfig.js';
import { runSharedWarmup } from '../game/boot/sharedWarmup.js';
import { createDevTools, BodyshopScene, GunsmithScene } from 'virtual:dreamfall-dev-tools';
import { mountShaderDebugPane } from 'virtual:dreamfall-shader-debug';
import { loadGarageChassisOptions } from '../game/vehicles/bodyshopChassisRegistry.js';

const LEVELS = new Set(['city', 'world', 'wilds', 'rally', 'range', 'horde', 'highway', 'deathmatch', 'sims', 'dog-park']);

/** Resolve experience id from a remount key like `range:3` or `world:id:rev:1`. */
function levelModeFromGameKey(key) {
  if (typeof key !== 'string') return 'city';
  if (key.startsWith('world')) return 'world';
  if (key.startsWith('rally')) return 'rally';
  const mode = key.split(':')[0];
  return LEVELS.has(mode) ? mode : 'city';
}

function readStoredLevel() {
  try {
    const v = localStorage.getItem('dreamfall:level');
    return LEVELS.has(v) ? v : 'rally';
  } catch {
    return 'rally';
  }
}

function isTruthyParam(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

function resolveBootView(params) {
  const view = params.get('view');
  if (view === 'horde-robots' || view === 'hordeRobots') return 'hordeRobots';
  if (view === 'simhuman' || view === 'sim-human') return 'simHuman';
  if (view === 'sim-creator' || view === 'simCreator') return 'simCreator';
  if (view === 'psx-household' || view === 'household-props' || view === 'psx-props') return 'psxHousehold';
  if (view === 'cut-test' || view === 'cutTest') return 'cutTest';
  if (view === 'dog-sim' || view === 'dog' || view === 'dogsim') return 'dogSim';
  return null;
}

function resolveBootIntent() {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const bootView = resolveBootView(params);
  const levelParam = params.get('level');
  const level = LEVELS.has(levelParam) ? levelParam : null;
  const menuEnabled = GAME_CONFIG.boot?.mainMenuEnabled !== false;

  // Query-string level wins over a stale last-played preference (e.g. range).
  // Persist so Continue / skip-menu boots honor ?level= after the first load.
  if (level) {
    try {
      localStorage.setItem('dreamfall:level', level);
    } catch { /* ignore */ }
  }

  let skipLocal = false;
  try {
    skipLocal = localStorage.getItem('dreamfall:skip-menu') === '1';
  } catch {
    skipLocal = false;
  }

  // Debug viewers own the full shell; do not also force a game experience.
  if (bootView) {
    return {
      skipMenu: true,
      forcedLevel: null,
      preferredLevel: level ?? readStoredLevel(),
      bootView,
    };
  }

  const skipMenu = !menuEnabled
    || isTruthyParam(params.get('autostart'))
    || skipLocal;

  return {
    skipMenu,
    forcedLevel: skipMenu ? (level ?? readStoredLevel()) : null,
    preferredLevel: level ?? readStoredLevel(),
    bootView: null,
  };
}

export function App() {
  const bootIntent = resolveBootIntent();
  const initialLevel = bootIntent.forcedLevel ?? bootIntent.preferredLevel;
  const initialView = bootIntent.bootView ?? 'game';

  const [viewMode, setViewMode] = createSignal(initialView); // 'game' | 'garage' | 'simCreator' | editor/dev-tool views
  const [appPhase, setAppPhase] = createSignal(
    bootIntent.bootView
      ? 'menu'
      : (bootIntent.skipMenu ? 'loading_experience' : 'booting'),
  );
  const [sharedProgress, setSharedProgress] = createSignal({
    phase: 'shared',
    label: 'Starting…',
    fraction: 0,
  });
  const [sharedReady, setSharedReady] = createSignal(false);
  const [chassisRefreshToken, setChassisRefreshToken] = createSignal(0);
  const [levelMode, setLevelModeSignal] = createSignal(initialLevel);
  const [gameSnapshot, setGameSnapshot] = createSignal(null);
  // Deathmatch (M2): the app owns the single network socket across the lobby →
  // room → play flow; `dmNet` is the live instance, `dmSnapshot` its UI view.
  /** @type {DeathmatchNetworkSystem | null} */
  let dmNet = null;
  const [dmSnapshot, setDmSnapshot] = createSignal(null);
  const [quality, setQuality] = createSignal(getQualityLevel());
  const [toneMapping, setToneMapping] = createSignal(getToneMappingMode());
  const [postEffect, setPostEffect] = createSignal(getPostEffectMode());
  const [cloudMode, setCloudMode] = createSignal(resolveCloudMode(getQualityPreset(getQualityLevel())));
  const [showControls, setShowControls] = createSignal(false);
  const [showDebugPanel, setShowDebugPanel] = createSignal(false);
  const [hudVisible, setHudVisible] = createSignal(true);
  const [showClothEditor, setShowClothEditor] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [showDogParkMenu, setShowDogParkMenu] = createSignal(false);
  let gameRuntime = null;
  let controlsAutoOpened = false;

  // Shared boot warmup → main menu (skipped when autostart / skip-menu).
  onMount(() => {
    void loadGarageChassisOptions();
    if (bootIntent.skipMenu) {
      return undefined;
    }
    let cancelled = false;
    setAppPhase('warming_shared');
    void runSharedWarmup({
      onProgress: (p) => {
        if (!cancelled) setSharedProgress(p);
      },
    }).then(() => {
      if (!cancelled) setSharedReady(true);
    }).catch((err) => {
      console.warn('[App] shared warmup failed; continuing to menu', err);
      if (!cancelled) setSharedReady(true);
    });
    return () => {
      cancelled = true;
    };
  });

  // Controls guide: only after first transition into playing (not during menu/load).
  createEffect(() => {
    if (appPhase() !== 'playing') return;
    if (controlsAutoOpened) return;
    try {
      if (localStorage.getItem('dreamfall:controls-dismissed') === 'true') {
        controlsAutoOpened = true;
        return;
      }
    } catch {
      // show once
    }
    controlsAutoOpened = true;
    const t = setTimeout(() => setShowControls(true), 620);
    onCleanup(() => clearTimeout(t));
  });

  // Unified render/shader debug Tweakpane (dev-only virtual module; prod stub).
  /** @type {{ setVisible: (v: boolean) => void, dispose: () => void } | null} */
  let shaderPaneHandle = null;
  onMount(() => {
    let cancelled = false;
    void mountShaderDebugPane({ parent: document.body, visible: false }).then((handle) => {
      if (cancelled) {
        handle?.dispose?.();
        return;
      }
      shaderPaneHandle = handle;
      const open = showDebugPanel() && (
        (viewMode() === 'game' && hudVisible() && appPhase() === 'playing')
        || viewMode() === 'dogSim'
      );
      handle?.setVisible?.(open);
    });
    onCleanup(() => {
      cancelled = true;
      shaderPaneHandle?.dispose?.();
      shaderPaneHandle = null;
    });
  });
  createEffect(() => {
    const open = showDebugPanel() && (
      (viewMode() === 'game' && hudVisible() && appPhase() === 'playing')
      || viewMode() === 'dogSim'
    );
    shaderPaneHandle?.setVisible?.(open);
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

  const handleCloudModeChange = (mode) => {
    if (mode === cloudMode()) return;
    setCloudModeOverride(mode);
    setCloudMode(mode);
    window.location.reload();
  };

  const [activeSceneId, setActiveSceneIdSignal] = createSignal(getActiveSceneId());
  const [playRevision, setPlayRevision] = createSignal(0);
  // Bumped on every enterExperience so re-selecting the same level remounts the runtime.
  const [playSession, setPlaySession] = createSignal(bootIntent.skipMenu ? 1 : 0);

  const isGame = () => viewMode() === 'game';
  const isGarage = () => viewMode() === 'garage';
  const isBodyshop = () => viewMode() === 'bodyshop';
  const isGunsmith = () => viewMode() === 'gunsmith';
  const isCutTest = () => viewMode() === 'cutTest';
  const isHordeRobots = () => viewMode() === 'hordeRobots';
  const isSimHuman = () => viewMode() === 'simHuman';
  const isPsxHousehold = () => viewMode() === 'psxHousehold';
  const isDogSim = () => viewMode() === 'dogSim';
  const isSimCreator = () => viewMode() === 'simCreator';

  const gameKey = createMemo(() => {
    const mode = levelMode();
    const session = playSession();
    if (mode === 'world') return `world:${activeSceneId() ?? 'draft'}:${playRevision()}:${session}`;
    if (mode === 'rally') return `rally:${getDefaultRallySceneId() ?? 'builtin'}:${session}`;
    return `${mode}:${session}`;
  });

  createEffect((prevKey) => {
    const key = gameKey();
    if (prevKey != null && prevKey !== key) {
      setGameSnapshot(null);
    }
    return key;
  });

  const showCanvas = createMemo(
    () => isGame()
      && (appPhase() === 'loading_experience' || appPhase() === 'playing'),
  );
  const showMenu = createMemo(() => isGame() && appPhase() === 'menu');
  const showSharedLoader = createMemo(
    () => isGame() && (appPhase() === 'booting' || appPhase() === 'warming_shared'),
  );
  const showExperienceLoader = createMemo(
    () => isGame() && appPhase() === 'loading_experience',
  );
  const isLoadBlocked = createMemo(
    () => appPhase() === 'booting'
      || appPhase() === 'warming_shared'
      || appPhase() === 'loading_experience'
      || appPhase() === 'deathmatch_lobby',
  );
  const isPlaying = createMemo(() => isGame() && appPhase() === 'playing');
  createEffect(() => {
    // Drop the customize popup when leaving dog park or the HUD.
    if (levelMode() !== 'dog-park' || !isPlaying() || !hudVisible()) {
      setShowDogParkMenu(false);
    }
  });
  const showDeathmatchLobby = createMemo(
    () => isGame() && appPhase() === 'deathmatch_lobby',
  );

  const activeWorldMap = createMemo(() =>
    levelMode() === 'world'
      ? (activeSceneId(), playRevision(), getActiveWorldMapSync())
      : levelMode() === 'rally' ? getRallyWorldMapSync() : null,
  );

  // Tear down the deathmatch socket (best-effort leave, no network wait).
  const disposeDmNet = () => {
    if (dmNet) {
      try {
        dmNet.leaveAndDispose();
      } catch { /* ignore */ }
      dmNet = null;
    }
    setDmSnapshot(null);
  };

  const returnToMenu = () => {
    disposeDmNet();
    setShowSettings(false);
    setShowControls(false);
    setGameSnapshot(null);
    setAppPhase('menu');
    // Canvas unmounts via showCanvas; GameCanvas onCleanup disposes runtime.
  };

  // Centralized switch; leaving game disposes any mounted play runtime.
  const switchTo = (mode) => {
    const current = viewMode();
    if (current === mode) return;

    if (current === 'game' && mode !== 'game') {
      // Any exit from the game view drops a live deathmatch socket.
      disposeDmNet();
      if (appPhase() === 'playing' || appPhase() === 'loading_experience') {
        setGameSnapshot(null);
        setAppPhase('menu');
      }
    }

    devTools.beforeSwitch(current, mode);
    setViewMode(mode);
  };

  /**
   * Sole entry that mounts/remounts a playable experience.
   * @param {'city'|'world'|'wilds'|'rally'|'range'|'horde'|'highway'|'deathmatch'} mode
   * @param {{ sceneId?: string|null }} [opts]
   */
  const enterExperience = (mode, opts = {}) => {
    const next = LEVELS.has(mode) ? mode : 'city';
    try {
      localStorage.setItem('dreamfall:level', next);
    } catch { /* ignore */ }

    // Deathmatch needs a room before an arena. Route to the lobby unless the
    // lobby itself is re-entering with a live session (opts.inSession).
    if (next === 'deathmatch' && !opts.inSession) {
      disposeDmNet();
      setLevelModeSignal(next);
      setGameSnapshot(null);
      switchTo('game');
      setAppPhase('deathmatch_lobby');
      return;
    }

    if (next === 'world') {
      const id = opts.sceneId !== undefined
        ? opts.sceneId
        : (getDefaultWorldSceneId() || null);
      setActiveSceneId(id);
      setActiveSceneIdSignal(id);
      setPlayRevision((n) => n + 1);
    }

    setLevelModeSignal(next);
    setGameSnapshot(null);
    setPlaySession((n) => n + 1);
    switchTo('game');
    setAppPhase('loading_experience');
  };

  const playScene = (id) => {
    enterExperience('world', { sceneId: id });
  };

  const setLevelMode = (mode) => {
    enterExperience(mode);
  };

  // Lobby submit: open the single socket, then mount the arena. The combined
  // barrier (`experienceReady`) waits for both network welcome and asset load.
  const startDeathmatchSession = ({ displayName, roomCode }) => {
    disposeDmNet();
    dmNet = new DeathmatchNetworkSystem({
      host: resolvePartyKitHost(),
      room: roomCode,
      displayName,
    });
    dmNet.onChange((snap) => setDmSnapshot(snap));
    setDmSnapshot(dmNet.getSnapshot());
    dmNet.connect();
    enterExperience('deathmatch', { inSession: true });
  };

  const toggleDeathmatchReady = (ready) => {
    dmNet?.sendReady(ready);
  };

  // The LoadingScreen dismisses on arena asset-load so the player always reaches
  // the arena even if PartyKit is unreachable. The network half of the barrier
  // is enforced by the room overlay: it shows connection state and gates Ready
  // (and therefore the RUNNING match) on the server welcome.
  const experienceReady = createMemo(() => gameSnapshot()?.stage === 'running');

  // Room overlay shows until the match is actually running (waiting/countdown).
  const showDeathmatchRoom = createMemo(
    () => levelMode() === 'deathmatch'
      && (dmSnapshot()?.phase ?? MATCH_PHASE.WAITING) !== MATCH_PHASE.RUNNING,
  );

  const toggleMode = () => {
    devTools.toggleMode();
  };

  const onGlobalKey = (e) => {
    const t = e.target;
    if (t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
      || t.tagName === 'SELECT' || t.isContentEditable)) return;

    if (e.key === 'Escape'
      && (appPhase() === 'loading_experience' || appPhase() === 'deathmatch_lobby')
      && isGame()) {
      e.preventDefault();
      returnToMenu();
      return;
    }
    if (e.key === 'Escape' && viewMode() === 'dogSim') {
      e.preventDefault();
      switchTo('game');
      setAppPhase('menu');
      return;
    }
    if (e.key === 'Escape' && showSettings()) {
      e.preventDefault();
      setShowSettings(false);
      return;
    }
    if (e.key === 'Escape' && showDogParkMenu()) {
      e.preventDefault();
      setShowDogParkMenu(false);
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
      if (viewMode() === 'game' && (appPhase() === 'playing' || appPhase() === 'menu')) {
        setShowControls(true);
      } else {
        toggleMode();
      }
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'p') {
      // Game play + Dog Studio both host the Tweakpane debug surface.
      if ((appPhase() === 'playing' && isGame()) || isDogSim()) {
        e.preventDefault();
        setShowDebugPanel((v) => !v);
      }
    }
  };

  globalThis.addEventListener('keydown', onGlobalKey);
  onCleanup(() => globalThis.removeEventListener('keydown', onGlobalKey));
  onCleanup(() => disposeDmNet());

  let bodyshopApi = null;
  let gunsmithApi = null;

  const devTools = createDevTools({
    viewMode,
    switchTo: (mode) => switchTo(mode),
    onPlayScene: (id) => playScene(id),
  });

  return (
    <main class="app-shell">
      <Show when={(!gameSnapshot()?.camera?.photoMode || hudVisible()) && !isLoadBlocked()}>
      <div class="top-bar-switchers" style="position: absolute; top: 10px; right: 12px; z-index: 20; display: flex; gap: 6px; pointer-events: none;">
        <div class="top-bar-actions">
          <Show when={isPlaying() && levelMode() === 'dog-park'}>
            <button
              type="button"
              class="settings-btn dog-customize-btn"
              classList={{ active: showDogParkMenu() }}
              onClick={() => {
                if (isLoadBlocked()) return;
                setShowDogParkMenu((open) => !open);
              }}
              title="Customize dog"
              aria-label="Customize dog"
              aria-expanded={showDogParkMenu()}
            >
              <DogCustomizeIcon />
              Customize
            </button>
          </Show>
          <button
            type="button"
            class="settings-btn"
            onClick={() => {
              if (isLoadBlocked()) return;
              setShowSettings(true);
            }}
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
        open={showSettings() && !isLoadBlocked()}
        onClose={() => setShowSettings(false)}
        snapshot={gameSnapshot()}
        viewMode={viewMode()}
        levelMode={levelMode()}
        quality={quality()}
        toneMapping={toneMapping()}
        postEffect={postEffect()}
        cloudMode={cloudMode()}
        clothEditorEnabled={isJacketClothUiEnabled()}
        clothEditorOpen={showClothEditor()}
        debugPanelOpen={showDebugPanel()}
        devModeButtons={<devTools.ModeButtons />}
        canReturnToMenu={isPlaying()}
        onReturnToMenu={() => {
          setShowSettings(false);
          returnToMenu();
        }}
        onLevelModeChange={setLevelMode}
        onOpenGarage={() => {
          setShowSettings(false);
          switchTo('garage');
        }}
        onOpenSimCreator={() => {
          setShowSettings(false);
          switchTo('simCreator');
        }}
        onQualityChange={handleQualityChange}
        onToneMappingChange={handleToneMappingChange}
        onPostEffectChange={handlePostEffectChange}
        onCloudModeChange={handleCloudModeChange}
        onVehicleCameraModeChange={(mode) => gameRuntime?.setVehicleCameraMode(mode)}
        onComfortChange={(enabled) => gameRuntime?.setCameraComfortEnabled(enabled)}
        onOnFootFirstPersonChange={(enabled) => gameRuntime?.setOnFootFirstPersonEnabled(enabled)}
        onWeaponShakeChange={(enabled) => gameRuntime?.setWeaponShakeScale(enabled ? 1 : 0)}
        onCameraFeelChange={(feel) => gameRuntime?.setCameraFeel(feel)}
        onPhotoModeChange={(enabled) => gameRuntime?.setPhotoMode(enabled)}
        onClothEditorChange={setShowClothEditor}
        onDebugPanelChange={setShowDebugPanel}
      />

      <Show when={showSharedLoader()}>
        <LoadingScreen
          progress={() => sharedProgress()}
          ready={() => sharedReady()}
          onDismissed={() => setAppPhase('menu')}
        />
      </Show>

      <Show when={showMenu()}>
        <MainMenu
          preferredLevel={bootIntent.preferredLevel}
          lastLevel={bootIntent.preferredLevel}
          onSelectExperience={(id) => {
            if (id === 'dog') {
              enterExperience('dog-park');
              return;
            }
            if (id === 'dog-studio') {
              switchTo('dogSim');
              return;
            }
            enterExperience(id);
          }}
          onContinue={() => enterExperience(bootIntent.preferredLevel)}
        />
      </Show>

      <Show when={showDeathmatchLobby()}>
        <DeathmatchLobby
          defaultName={dmSnapshot()?.playerId ?? 'Player'}
          onEnter={startDeathmatchSession}
          onCancel={returnToMenu}
        />
      </Show>

      {isGame() && showCanvas() && (
        <>
          <Show when={gameKey()} keyed>
            {(key) => (
              <>
                <GameCanvas
                  levelMode={levelModeFromGameKey(key)}
                  onSnapshot={setGameSnapshot}
                  networkSystem={levelModeFromGameKey(key) === 'deathmatch' ? dmNet : null}
                  onRuntime={(runtime) => {
                    gameRuntime = runtime;
                    // Ensure the live socket is bound even if GameCanvas mounted first.
                    if (dmNet && levelModeFromGameKey(key) === 'deathmatch') {
                      runtime?.setNetworkSystem?.(dmNet);
                    }
                  }}
                />
                <Show when={showExperienceLoader()}>
                  <LoadingScreen
                    progress={() => gameSnapshot()?.loadProgress}
                    ready={experienceReady}
                    onDismissed={() => setAppPhase('playing')}
                  />
                </Show>
              </>
            )}
          </Show>
          {hudVisible() && isPlaying() && <StatsPanel snapshot={gameSnapshot()} />}
          {hudVisible() && isPlaying() && levelMode() !== 'dog-park' && <Hud snapshot={gameSnapshot()} />}
          <Show when={hudVisible() && isPlaying() && levelMode() === 'dog-park'}>
            <DogParkHud
              snapshot={gameSnapshot()?.dogPark}
              open={showDogParkMenu()}
              onOpenChange={setShowDogParkMenu}
              onStudio={() => {
                setShowDogParkMenu(false);
                switchTo('dogSim');
              }}
            />
          </Show>
          <Show when={isPlaying() && showDeathmatchRoom()}>
            <DeathmatchRoomOverlay
              snapshot={dmSnapshot()}
              assetReady={gameSnapshot()?.stage === 'running'}
              onToggleReady={toggleDeathmatchReady}
              onLeave={returnToMenu}
            />
          </Show>
          <Show when={hudVisible() && isPlaying() && isJacketClothUiEnabled() && showClothEditor()}>
            <ClothColliderEditor
              runtime={() => gameRuntime}
              onClose={() => setShowClothEditor(false)}
            />
          </Show>
          {hudVisible() && isPlaying() && (levelMode() === 'world' || levelMode() === 'rally') && activeWorldMap() && (
            <Minimap map={activeWorldMap()} player={gameSnapshot()?.player} />
          )}
          <Show when={gameSnapshot()?.camera?.photoMode && hudVisible() && isPlaying()}>
            <PhotoModeControls
              snapshot={gameSnapshot()}
              hudVisible={hudVisible()}
              onToggleHud={() => {
                setShowControls(false);
                setHudVisible(false);
              }}
              onToggle={(enabled) => gameRuntime?.setPhotoMode(enabled)}
              onLiveChange={(enabled) => gameRuntime?.setPhotoModeLive(enabled)}
              onSetting={(name, value) => gameRuntime?.setPhotoSetting(name, value)}
            />
          </Show>
          <Show when={hudVisible() && (isPlaying() || showMenu())}>
            <ControlsGuide open={showControls()} onOpenChange={setShowControls} />
          </Show>
        </>
      )}

      {/* Controls guide also available on pure menu (no canvas branch) */}
      <Show when={showMenu() && hudVisible()}>
        <ControlsGuide open={showControls()} onOpenChange={setShowControls} />
      </Show>

      {isCutTest() && <CutTestCanvas />}
      {isHordeRobots() && <HordeRobotViewerCanvas />}
      {isSimHuman() && <SimHumanViewerCanvas />}
      {isPsxHousehold() && <PsxHouseholdViewerCanvas />}
      {isDogSim() && (
        <DogSimCanvas
          onBack={() => {
            switchTo('game');
            setAppPhase('menu');
          }}
        />
      )}

      {isSimCreator() && (
        <SimCreatorScene onPlayLot={() => enterExperience('sims')} />
      )}

      {isGarage() && (
        <GarageScene
          chassisRefreshToken={chassisRefreshToken()}
          onOpenBodyshop={() => switchTo('bodyshop')}
          onDrive={() => enterExperience(levelMode())}
        />
      )}

      {isBodyshop() && (
        <BodyshopScene
          onReady={(api) => {
            bodyshopApi = api;
          }}
          onBack={async () => {
            await bodyshopApi?.flushAutosave?.();
            switchTo('garage');
          }}
          onPublished={async () => {
            await loadGarageChassisOptions({ force: true });
            setChassisRefreshToken((value) => value + 1);
          }}
        />
      )}

      {isGunsmith() && (
        <div style="position:absolute; inset:0; z-index:15;">
          <GunsmithScene
            onReady={(api) => {
              gunsmithApi = api;
            }}
            onBack={async () => {
              await gunsmithApi?.flushAutosave?.();
              switchTo('game');
            }}
          />
        </div>
      )}

      <devTools.Views />
    </main>
  );
}
