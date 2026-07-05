import { Show, For, createSignal } from 'solid-js';
import { listCloudTypePresets, DEFAULT_CLOUD_TYPE } from '../../game/render/cloud/cloudConfig.js';
import { listPhotorealismPresets } from '../../game/config/photorealismPresets.js';

const EMPTY = { renderer: null, scene: null };

export function DebugPanel(props) {
  const snap = () => props.snapshot ?? EMPTY;
  const renderer = () => snap().renderer;
  const scene = () => snap().scene;
  const vehicles = () => snap().vehicles;
  const sky = () => scene()?.sky;
  const timeOfDay = () => sky()?.timeOfDay ?? 0.72;

  const dbg = () => globalThis.__DREAMFALL_DEBUG__;

  // Debug-only toggles are not in the snapshot; track locally.
  const [collisionDebug, setCollisionDebug] = createSignal(false);
  const [bladeDebug, setBladeDebug] = createSignal(false);
  const [worldZones, setWorldZones] = createSignal(false);
  const [cloudType, setCloudType] = createSignal(DEFAULT_CLOUD_TYPE);
  const cloudPresets = listCloudTypePresets();
  const lookPresets = listPhotorealismPresets();

  // Experimental volumetric sky (CloudSkyProvider) is opt-in and off by default;
  // the default sky uses the simple SkyMesh dome clouds. Switching pipelines
  // means rebuilding the sky + render pipeline, so this reloads the page.
  const readVolumetric = () => {
    try { return localStorage.getItem('dreamfall:clouds') === 'volumetric'; } catch { return false; }
  };
  const [volumetricSky, setVolumetricSky] = createSignal(readVolumetric());
  const toggleVolumetricSky = (on) => {
    setVolumetricSky(on);
    try { localStorage.setItem('dreamfall:clouds', on ? 'volumetric' : 'dome'); } catch { /* ignore */ }
    location.reload();
  };

  const readSpectatorCrowd = () => {
    try { return localStorage.getItem('dreamfall:spectator-crowd') === 'true'; } catch { return false; }
  };
  const [spectatorCrowd, setSpectatorCrowd] = createSignal(readSpectatorCrowd());
  const toggleSpectatorCrowd = (on) => {
    setSpectatorCrowd(on);
    try { localStorage.setItem('dreamfall:spectator-crowd', on ? 'true' : 'false'); } catch { /* ignore */ }
    location.reload();
  };

  const apply = (key, checked) => {
    const bridge = dbg();
    if (!bridge) return;
    switch (key) {
      case 'lighting':
        bridge.setLightMode(checked ? 'clustered' : 'hemisphere');
        break;
      case 'heightFog':
        bridge.setFog(checked);
        break;
      case 'photorealismPreset':
        bridge.setPhotorealismPreset?.(checked || null);
        break;
      case 'weather':
        bridge.setWeather(checked);
        break;
      case 'cloudPreset':
        bridge.setCloudPreset?.(checked);
        setCloudType(checked);
        break;
      case 'distanceFog':
        bridge.setSceneFog(checked);
        break;
      case 'shadows':
        bridge.setShadows(checked);
        break;
      case 'streetLights':
        bridge.setStreetLights(checked);
        break;
      case 'sun':
        bridge.setSun(checked);
        break;
      case 'hemisphere':
        bridge.setHemisphere(checked);
        break;
      case 'headlights':
        bridge.setHeadlights(checked);
        break;
      case 'collision':
        bridge.setCollisionDebugVisible(checked);
        setCollisionDebug(checked);
        break;
      case 'blade':
        bridge.setBladeDebug(checked);
        setBladeDebug(checked);
        break;
      case 'worldZones':
        bridge.setWorldZoneOverlay?.(checked);
        setWorldZones(checked);
        break;
      case 'renderCap60':
        bridge.setRenderCap60?.(checked);
        break;
      case 'timingHud':
        bridge.setTimingHud?.(checked);
        break;
      default:
        break;
    }
  };

  return (
    <Show when={props.open}>
      <div class="debug-panel">
        <div class="debug-head">
          <span class="debug-title">Render Debug</span>
          <span class="debug-hint">P to close</span>
        </div>

        <Toggle
          label="Clustered lighting"
          checked={() => renderer()?.lightingMode === 'clustered'}
          onChange={(v) => apply('lighting', v)}
        />
        <Toggle
          label="Height fog (volumetric)"
          checked={() => renderer()?.fogEnabled ?? false}
          onChange={(v) => apply('heightFog', v)}
        />
        <Toggle
          label="Distance fog (scene)"
          checked={() => scene()?.sceneFogEnabled ?? true}
          onChange={(v) => apply('distanceFog', v)}
        />
        <Toggle
          label="Shadows"
          checked={() => renderer()?.shadows ?? false}
          onChange={(v) => apply('shadows', v)}
        />
        <Toggle
          label="Street lights"
          checked={() => scene()?.streetLightsVisible ?? false}
          onChange={(v) => apply('streetLights', v)}
        />
        <Toggle
          label="Sun (directional)"
          checked={() => scene()?.sunUserEnabled ?? true}
          onChange={(v) => apply('sun', v)}
        />
        <Toggle
          label="Hemisphere light"
          checked={() => scene()?.hemisphereVisible ?? true}
          onChange={(v) => apply('hemisphere', v)}
        />
        <Toggle
          label="Xenon headlights"
          checked={() => vehicles()?.headlightsEnabled ?? false}
          onChange={(v) => apply('headlights', v)}
        />

        <div class="debug-section">Session timing</div>
        <Toggle
          label="Cap render to 60 fps"
          checked={() => snap().timing?.renderCap60 ?? false}
          onChange={(v) => apply('renderCap60', v)}
        />
        <Toggle
          label="Timing HUD"
          checked={() => snap().timing?.showHud ?? false}
          onChange={(v) => apply('timingHud', v)}
        />
        <button
          type="button"
          class="dbg-select"
          onClick={() => {
            const bridge = dbg();
            if (!bridge?.startAllocationSample) return;
            bridge.startAllocationSample(3000);
            globalThis.setTimeout(() => {
              console.info('[dreamfall] allocation sample', bridge.allocationSampleReport?.());
            }, 3200);
          }}
        >
          Sample allocation (3s → console)
        </button>

        <div class="debug-section">Look preset</div>
        <select
          class="dbg-select"
          value={snap().photorealismPreset ?? ''}
          onChange={(e) => apply('photorealismPreset', e.currentTarget.value)}
        >
          <option value="">Quality default</option>
          <For each={lookPresets}>
            {(preset) => <option value={preset.id}>{preset.label}</option>}
          </For>
        </select>

        <div class="debug-section">Weather</div>
        <select
          class="dbg-select"
          value={renderer()?.weather ?? 'clear'}
          onChange={(e) => apply('weather', e.currentTarget.value)}
        >
          <option value="clear">Clear</option>
          <option value="overcast">Overcast</option>
          <option value="fog">Fog</option>
          <option value="rain">Rain</option>
        </select>

        <div class="debug-section">Clouds</div>
        <Toggle
          label="Volumetric sky (experimental)"
          checked={volumetricSky}
          onChange={(v) => toggleVolumetricSky(v)}
        />
        <Show when={volumetricSky()}>
          <select
            class="dbg-select"
            value={cloudType()}
            onChange={(e) => apply('cloudPreset', e.currentTarget.value)}
          >
            <For each={cloudPresets}>
              {(preset) => <option value={preset.id}>{preset.label}</option>}
            </For>
          </select>
        </Show>

        <div class="debug-section">Sky</div>
        <div class="dbg-slider-row">
          <span class="dbg-label">Time of day</span>
          <output class="dbg-slider-value">{formatTimeOfDay(timeOfDay())}</output>
        </div>
        <input
          type="range"
          class="dbg-slider"
          min="0"
          max="1"
          step="0.001"
          value={timeOfDay()}
          onInput={(e) => dbg()?.setTimeOfDay(Number(e.currentTarget.value))}
        />

        <div class="debug-section">Rally</div>
        <Toggle
          label="Animated spectator crowd (GLB)"
          checked={spectatorCrowd}
          onChange={(v) => toggleSpectatorCrowd(v)}
        />

        <div class="debug-section">Debug overlays</div>
        <Toggle
          label="Collision overlays"
          checked={collisionDebug}
          onChange={(v) => apply('collision', v)}
        />
        <Toggle
          label="Blade trace"
          checked={bladeDebug}
          onChange={(v) => apply('blade', v)}
        />
        <Toggle
          label="World zone overlay"
          checked={worldZones}
          onChange={(v) => apply('worldZones', v)}
        />
      </div>
    </Show>
  );
}

function formatTimeOfDay(timeOfDay) {
  const wrapped = ((Number(timeOfDay) % 1) + 1) % 1;
  const totalMinutes = Math.round(wrapped * 24 * 60) % (24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function Toggle(props) {
  return (
    <label class="dbg-row">
      <input
        type="checkbox"
        class="dbg-check"
        checked={props.checked()}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span class="dbg-label">{props.label}</span>
      </label>
  );
}
