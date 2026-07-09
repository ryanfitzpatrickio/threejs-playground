import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { getQualityLevel, getQualityPreset } from '../../game/config/qualityPresets.js';
import { RendererSystem } from '../../game/systems/RendererSystem.js';
import { SkySystem } from '../../game/systems/SkySystem.js';
import { BaseVehicle } from '../../game/vehicles/BaseVehicle.js';
import { QuadBikeVehicle, QUAD_BIKE_ASSET_URL, QUAD_BIKE_PAINTS } from '../../game/vehicles/QuadBikeVehicle.js';
import { LightProbeGrid } from '../../three-addons/lighting/LightProbeGrid.js';
import {
  GARAGE_CHASSIS_OPTIONS,
  GARAGE_CHASSIS_SURFACE_MODES,
  GARAGE_ENGINE_OPTIONS,
  GARAGE_FRAME_PRESETS,
  getGarageChassisOption,
  getGarageTireOptionsForVehicleType,
  GARAGE_QUAD_DEFAULT_FRAME,
  GARAGE_QUAD_DEFAULT_WHEELS,
  GARAGE_VEHICLE_TYPES,
  createGarageBuild,
  createFallbackGarageChassisOption,
  deleteGarageBuild,
  getActiveGarageBuild,
  getGarageFramePreset,
  loadGarageBuilds,
  saveGarageBuild,
  setActiveGarageBuild,
  vehicleOptionsFromGarageBuild,
} from '../../game/vehicles/garageBuilds.js';
import { loadGarageChassisOptions } from '../../game/vehicles/bodyshopChassisRegistry.js';
import {
  getChassisPartOverridesForBuild,
  loadChassisMeshPartCatalog,
} from '../../game/vehicles/chassisMeshParts.js';
import {
  GARAGE_MESH_PART_ROLES,
  resolveMeshPartKey,
} from '../../game/materials/createVehicleOverlayMaterials.js';

const FRAME_FIELDS = [
  { key: 'frameWidth', label: 'Frame width', min: 1.6, max: 2.6, step: 0.02, unit: 'm' },
  { key: 'frameLength', label: 'Frame length', min: 3.8, max: 6.4, step: 0.05, unit: 'm' },
  { key: 'frameHeight', label: 'Frame height', min: 0.65, max: 1.25, step: 0.02, unit: 'm' },
  { key: 'wheelTrack', label: 'Wheel track', min: 1.5, max: 2.35, step: 0.02, unit: 'm' },
  { key: 'wheelbase', label: 'Wheelbase', min: 2.3, max: 4.2, step: 0.03, unit: 'm' },
  { key: 'wheelAxleOffset', label: 'Wheel position', min: -0.55, max: 0.55, step: 0.02, unit: 'm' },
  { key: 'rideHeight', label: 'Ride height', min: 0.65, max: 1.25, step: 0.02, unit: 'm' },
  { key: 'offsetFromTires', label: 'Frame offset', min: -0.65, max: 0.1, step: 0.02, unit: 'm' },
];

const PERFORMANCE_FIELDS = [
  { key: 'enginePower', label: 'Engine', min: 4, max: 14, step: 0.1, unit: 'a' },
  { key: 'maxSteerYawRate', label: 'Cornering', min: 0.45, max: 1.1, step: 0.01, unit: 'r/s' },
  { key: 'highSpeedSteerYawRate', label: 'High-speed steer', min: 0.25, max: 0.7, step: 0.01, unit: 'r/s' },
  { key: 'suspensionStiffness', label: 'Spring', min: 16, max: 36, step: 1, unit: '' },
  { key: 'suspensionDamping', label: 'Damping', min: 7, max: 16, step: 0.5, unit: '' },
  { key: 'traction', label: 'Traction (mud/dirt)', min: 0.4, max: 1, step: 0.02, unit: '' },
];

const QUAD_FRAME_FIELDS = [
  { key: 'rideHeight', label: 'Ride height', min: 0.45, max: 1.05, step: 0.02, unit: 'm' },
  { key: 'offsetFromTires', label: 'Frame offset', min: -0.65, max: 0.35, step: 0.02, unit: 'm' },
];

const QUAD_WHEEL_FIELDS = [
  { key: 'radius', label: 'Tire radius', min: 0.25, max: 0.52, step: 0.01, unit: 'm' },
  { key: 'width', label: 'Tire width', min: 0.18, max: 0.45, step: 0.01, unit: 'm' },
];

const WHEEL_FIELDS = [
  { key: 'radius', label: 'Tire radius', min: 0.25, max: 0.62, step: 0.01, unit: 'm' },
  { key: 'width', label: 'Tire width', min: 0.18, max: 0.52, step: 0.01, unit: 'm' },
  { key: 'inset', label: 'Wheel inset', min: 0, max: 0.35, step: 0.01, unit: 'm' },
];

const CHASSIS_TRANSFORM_FIELDS = [
  { group: 'position', index: 0, label: 'Body X', min: -2, max: 2, step: 0.02, unit: 'm' },
  { group: 'position', index: 1, label: 'Body Y', min: -2, max: 2, step: 0.02, unit: 'm' },
  { group: 'position', index: 2, label: 'Body Z', min: -2, max: 2, step: 0.02, unit: 'm' },
  { group: 'rotationDegrees', index: 0, label: 'Body pitch', min: -180, max: 180, step: 1, unit: '°' },
  { group: 'rotationDegrees', index: 1, label: 'Body yaw', min: -360, max: 360, step: 1, unit: '°' },
  { group: 'rotationDegrees', index: 2, label: 'Body roll', min: -180, max: 180, step: 1, unit: '°' },
  { group: 'scale', index: 0, label: 'Body scale X', min: 0.5, max: 50, step: 0.5, unit: '' },
  { group: 'scale', index: 1, label: 'Body scale Y', min: 0.5, max: 50, step: 0.5, unit: '' },
  { group: 'scale', index: 2, label: 'Body scale Z', min: 0.5, max: 50, step: 0.5, unit: '' },
];

export function GarageScene(props) {
  let canvas;
  let preview;
  let previewApi = null;
  let mounted = true;
  const [draft, setDraft] = createSignal(createGarageBuild('street'));
  const [savedBuilds, setSavedBuilds] = createSignal(loadGarageBuilds());
  const [chassisOptions, setChassisOptions] = createSignal(GARAGE_CHASSIS_OPTIONS);
  const [status, setStatus] = createSignal('Choose a frame, tune it, then save the build.');
  const [meshPartCatalog, setMeshPartCatalog] = createSignal([]);
  const [meshPartsLoading, setMeshPartsLoading] = createSignal(false);
  const [meshPartsScrollTop, setMeshPartsScrollTop] = createSignal(0);
  let meshPartsListEl = null;
  let meshCatalogKey = '';

  const meshParts = createMemo(() => {
    const catalog = meshPartCatalog();
    if (!catalog.length) return [];
    const build = draft();
    const overrides = getChassisPartOverridesForBuild(build, meshPartProfileId(build));
    return catalog.map((part) => {
      const role = overrides[part.key] ?? 'auto';
      return {
        ...part,
        role,
        effectiveRole: role !== 'auto' ? role : part.autoRole,
      };
    });
  });

  createEffect(() => {
    meshParts();
    const top = meshPartsScrollTop();
    queueMicrotask(() => {
      if (meshPartsListEl) meshPartsListEl.scrollTop = top;
    });
  });

  const bindMeshPartsList = (element) => {
    meshPartsListEl = element;
    if (element) element.scrollTop = meshPartsScrollTop();
  };

  const onMeshPartsListScroll = (event) => {
    setMeshPartsScrollTop(event.currentTarget.scrollTop);
  };

  const scrollMeshPartIntoView = (key) => {
    queueMicrotask(() => {
      if (!meshPartsListEl || !key) return;
      const row = meshPartsListEl.querySelector(`[data-mesh-part-key="${CSS.escape(key)}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    });
  };

  const applyPartHighlight = (key) => {
    const p = previewApi || preview;
    if (!key) {
      p?.clearHighlight?.();
      setHighlightedKey(null);
      return;
    }
    p?.highlightPart?.(key);
    setHighlightedKey(key);
    scrollMeshPartIntoView(key);
  };

  const toggleMeshPartPickMode = () => {
    const next = !meshPartPickMode();
    setMeshPartPickMode(next);
    (previewApi || preview)?.setMeshPartPickMode?.(next);
    setStatus(next ? 'Click a mesh on the vehicle to identify it.' : 'Mesh pick cancelled.');
  };
  const [highlightedKey, setHighlightedKey] = createSignal(null);
  const [meshPartPickMode, setMeshPartPickMode] = createSignal(false);
  const [vehicleTab, setVehicleTab] = createSignal(
    draft().vehicleType === 'car' ? 'cars' : 'rideables',
  );

  const meshPartProfileId = (build = draft()) => (
    build.vehicleType === 'quad' ? 'quad-bike' : build.chassisId
  );

  const refreshChassisOptions = async () => {
    const options = await loadGarageChassisOptions({ force: true });
    setChassisOptions(options);
    return options;
  };

  const displayChassisOptions = createMemo(() => {
    const options = chassisOptions();
    const currentId = draft().chassisId;
    if (!currentId || currentId === 'bare' || options.some((option) => option.id === currentId)) {
      return options;
    }
    const fallback = createFallbackGarageChassisOption(currentId);
    return fallback ? [...options, fallback] : options;
  });

  createEffect(() => {
    props.chassisRefreshToken;
    void refreshChassisOptions();
  });

  createEffect(() => {
    const build = draft();
    if (build.vehicleType !== 'car' && build.vehicleType !== 'quad') {
      meshCatalogKey = '';
      setMeshPartCatalog([]);
      setMeshPartsLoading(false);
      return;
    }
    const profileId = meshPartProfileId(build);
    const url = build.vehicleType === 'quad'
      ? QUAD_BIKE_ASSET_URL
      : getGarageChassisOption(build.chassisId).url;
    const nextCatalogKey = [
      build.vehicleType,
      profileId,
      url ?? '',
      build.disableGlassDetection ? '1' : '0',
    ].join('|');
    if (!url) {
      meshCatalogKey = '';
      setMeshPartCatalog([]);
      setMeshPartsLoading(false);
      return;
    }
    if (nextCatalogKey === meshCatalogKey && meshPartCatalog().length > 0) {
      return;
    }
    meshCatalogKey = nextCatalogKey;
    let cancelled = false;
    setMeshPartsLoading(true);
    loadChassisMeshPartCatalog({
      url,
      profileId,
      partOverrides: {},
      disableGlassDetection: build.disableGlassDetection === true,
    }).then((parts) => {
      if (!cancelled) {
        setMeshPartCatalog(parts.map(({ key, names, autoRole }) => ({ key, names, autoRole })));
        setMeshPartsLoading(false);
        setHighlightedKey(null);
        setMeshPartPickMode(false);
        (previewApi || preview)?.clearHighlight?.();
        (previewApi || preview)?.setMeshPartPickMode?.(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setMeshPartCatalog([]);
        setMeshPartsLoading(false);
        setHighlightedKey(null);
        setMeshPartPickMode(false);
        (previewApi || preview)?.clearHighlight?.();
        (previewApi || preview)?.setMeshPartPickMode?.(false);
      }
    });
    onCleanup(() => { cancelled = true; });
  });

  onMount(async () => {
    await refreshChassisOptions();
    const builds = loadGarageBuilds();
    setSavedBuilds(builds);
    const active = getActiveGarageBuild();
    if (active) {
      const copy = structuredClone(active);
      setDraft(copy);
      setVehicleTab(copy.vehicleType === 'car' ? 'cars' : 'rideables');
    }

    const instance = await createGaragePreview(canvas, active ?? draft(), {
      onMeshPartPicked: (key) => {
        setMeshPartPickMode(false);
        applyPartHighlight(key);
        setStatus(`Highlighted mesh part: ${key}`);
      },
    });
    if (!mounted) instance.dispose();
    else {
      preview = instance;
      previewApi = instance;
      instance.setMeshPartPickMode(meshPartPickMode());
    }
  });
  onCleanup(() => {
    mounted = false;
    previewApi = null;
    preview?.dispose();
  });

  const selectPreset = (preset) => {
    const frame = { ...preset.frame, wheelAxleOffset: preset.frame.wheelAxleOffset ?? 0 };
    setDraft((current) => ({
      ...current,
      presetId: preset.id,
      name: `${preset.name} Build`,
      frame,
    }));
    preview?.setFrame(frame, true);
    setStatus(`${preset.name} frame loaded.`);
  };

  const selectVehicleType = (type) => {
    const next = {
      ...draft(),
      vehicleType: type.id,
      name: type.id === 'quad' ? 'Trail Quad' : type.id === 'horse' ? 'Horse Mount' : draft().name,
      ...(type.id === 'quad'
        ? {
          wheels: { ...GARAGE_QUAD_DEFAULT_WHEELS },
          frame: { ...GARAGE_QUAD_DEFAULT_FRAME },
          performance: { ...(draft().performance || {}), engineProfile: 'quad' },
        }
        : {}),
    };
    setDraft(next);
    preview?.setBuild(next);
    setStatus(`${type.name} selected.`);
  };

  const selectQuadPaint = (paint) => {
    const next = { ...draft(), paintId: paint.id };
    setDraft(next);
    preview?.setBuild(next);
    setStatus(`${paint.name} paint selected.`);
  };

  const updateFrame = (key, value) => {
    const number = Number(value);
    setDraft((current) => ({ ...current, frame: { ...current.frame, [key]: number } }));
    preview?.setFrame({ [key]: number });
  };

  const updateHideBackSeats = (checked) => {
    const next = { ...draft(), hideBackSeats: checked };
    setDraft(next);
    preview?.setBuild(next);
    setHighlightedKey(null);
    setStatus(checked ? 'Two-seat layout enabled.' : 'Rear seats restored.');
  };

  const updateHideEngine = (checked) => {
    const next = { ...draft(), hideEngine: checked };
    setDraft(next);
    preview?.setBuild(next);
    setHighlightedKey(null);
    setStatus(checked ? 'Exposed engine hidden.' : 'Exposed engine restored.');
  };

  const updateDisableGlassDetection = (checked) => {
    const next = { ...draft(), disableGlassDetection: checked };
    setDraft(next);
    preview?.setBuild(next);
    setHighlightedKey(null);
    setStatus(checked ? 'Glass detection disabled for this build.' : 'Glass detection enabled.');
  };

  const updateChassisSurfaceMode = (mode) => {
    const next = { ...draft(), chassisSurfaceMode: mode };
    setDraft(next);
    preview?.setBuild(next);
    setHighlightedKey(null);
    const label = GARAGE_CHASSIS_SURFACE_MODES.find((entry) => entry.id === mode)?.name ?? mode;
    setStatus(`${label} surface selected.`);
  };

  const updateMeshPartRole = (meshKey, role) => {
    if (meshPartsListEl) {
      setMeshPartsScrollTop(meshPartsListEl.scrollTop);
    }
    const chassisId = meshPartProfileId();
    const current = { ...getChassisPartOverridesForBuild(draft(), chassisId) };
    if (role === 'auto') delete current[meshKey];
    else current[meshKey] = role;
    const chassisPartOverrides = { ...(draft().chassisPartOverrides ?? {}) };
    if (Object.keys(current).length > 0) chassisPartOverrides[chassisId] = current;
    else delete chassisPartOverrides[chassisId];
    const next = { ...draft(), chassisPartOverrides };
    setDraft(next);
    preview?.setBuild(next);
    const label = GARAGE_MESH_PART_ROLES.find((entry) => entry.id === role)?.name ?? role;
    setStatus(`${meshKey} → ${label}.`);
  };

  const updatePerformance = (key, value) => {
    const number = Number(value);
    setDraft((current) => ({
      ...current,
      performance: { ...current.performance, [key]: number },
    }));
  };

  const selectEngine = (engine) => {
    setDraft((current) => ({
      ...current,
      performance: { ...current.performance, engineProfile: engine.id },
    }));
    setStatus(`${engine.name} engine selected.`);
  };

  const updateWheel = (key, value) => {
    const number = Number(value);
    const next = { ...draft(), wheels: { ...draft().wheels, [key]: number } };
    setDraft(next);
    preview?.setBuild(next);
    setHighlightedKey(null);
  };

  const selectTire = (tire) => {
    const next = { ...draft(), wheels: { ...draft().wheels, tireId: tire.id } };
    setDraft(next);
    preview?.setBuild(next);
    setHighlightedKey(null);
    setStatus(`${tire.name} tires selected.`);
  };

  const updateChassisTransform = (group, index, value) => {
    const vector = [...draft().chassisTransform[group]];
    vector[index] = Number(value);
    const next = {
      ...draft(),
      chassisTransform: { ...draft().chassisTransform, [group]: vector },
    };
    setDraft(next);
    preview?.setChassisTransform(next.chassisTransform);
  };

  const selectChassis = (chassis) => {
    const defaultTransform = chassis.defaultTransform;
    const next = {
      ...draft(),
      chassisId: chassis.id,
      chassisTransform: defaultTransform
        ? {
            position: [...defaultTransform.position],
            rotationDegrees: [...defaultTransform.rotationDegrees],
            scale: [...defaultTransform.scale],
          }
        : draft().chassisTransform,
    };
    setDraft(next);
    preview?.setBuild(next);
    setHighlightedKey(null);
    setStatus(`${chassis.name} selected.`);
  };

  const save = () => {
    const stored = saveGarageBuild(draft());
    setDraft(stored);
    setSavedBuilds(loadGarageBuilds());
    setStatus(`${stored.name} saved and selected for gameplay.`);
    return stored;
  };

  const newBuild = () => {
    const next = createGarageBuild(draft().presetId);
    setDraft(next);
    preview?.setBuild(next);
    setHighlightedKey(null);
    setStatus('Started a new build.');
  };

  const loadBuild = (build) => {
    const copy = structuredClone(build);
    setDraft(copy);
    setVehicleTab(copy.vehicleType === 'car' ? 'cars' : 'rideables');
    setActiveGarageBuild(copy.id);
    preview?.setBuild(copy);
    setHighlightedKey(null);
    setStatus(`${copy.name} loaded.`);
  };

  const removeBuild = (id) => {
    setSavedBuilds(deleteGarageBuild(id));
    if (draft().id === id) newBuild();
    setStatus('Build deleted.');
  };

  const useBuild = () => {
    const stored = save();
    setActiveGarageBuild(stored.id);
    props.onDrive?.();
  };

  return (
    <section class="garage-shell">
      <canvas ref={canvas} class="garage-canvas" aria-label="Interactive garage vehicle preview" />

      <header class="garage-header">
        <div>
          <span class="garage-kicker">Dreamfall Motorworks</span>
          <h1>Garage</h1>
        </div>
        <div class="garage-header-actions">
          <nav class="garage-type-tabs" aria-label="Vehicle type">
            <button class={vehicleTab() === 'cars' ? 'active' : ''} onClick={() => setVehicleTab('cars')}>Cars</button>
            <button class={vehicleTab() === 'rideables' ? 'active' : ''} onClick={() => setVehicleTab('rideables')}>Rideables</button>
          </nav>
          <Show when={import.meta.env.DEV}>
            <button class="garage-button ghost" type="button" onClick={() => props.onOpenBodyshop?.()}>
              Bodyshop
            </button>
          </Show>
          <button class="garage-button ghost" onClick={newBuild}>New build</button>
          <button class="garage-button primary" onClick={useBuild}>Save &amp; drive</button>
        </div>
      </header>

      <aside class="garage-panel garage-panel--left">
        <Show when={vehicleTab() === 'rideables'}>
          <div class="garage-section-title"><span>00</span> Pick a rideable</div>
          <div class="garage-frame-list">
            <For each={GARAGE_VEHICLE_TYPES.filter((type) => type.tab === 'rideables')}>
              {(type) => (
                <button
                  class={`garage-frame-card ${draft().vehicleType === type.id ? 'active' : ''}`}
                  onClick={() => selectVehicleType(type)}
                >
                  <strong>{type.name}</strong>
                  <small>{type.description}</small>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={vehicleTab() === 'cars'}>
          <button
            class={`garage-frame-card ${draft().vehicleType === 'car' ? 'active' : ''}`}
            onClick={() => selectVehicleType(GARAGE_VEHICLE_TYPES[0])}
          ><strong>Car builds</strong><small>Configure chassis, frame, wheels, and performance.</small></button>
        </Show>
        <Show when={vehicleTab() === 'cars'}>
        <div class="garage-section-title"><span>01</span> Pick a frame</div>
        <div class="garage-frame-list">
          <For each={GARAGE_FRAME_PRESETS}>
            {(preset) => (
              <button
                class={`garage-frame-card ${draft().presetId === preset.id ? 'active' : ''}`}
                onClick={() => selectPreset(preset)}
              >
                <strong>{preset.name}</strong>
                <small>{preset.description}</small>
                <span>{preset.frame.wheelbase.toFixed(2)} m wheelbase</span>
              </button>
            )}
          </For>
        </div>

        <div class="garage-section-title garage-section-title--saved"><span>02</span> Choose a chassis</div>
        <div class="garage-chassis-list">
          <For each={displayChassisOptions()}>
            {(chassis) => (
              <button
                class={`garage-chassis-card ${draft().chassisId === chassis.id ? 'active' : ''}`}
                onClick={() => selectChassis(chassis)}
              >
                <strong>{chassis.name}</strong>
                <small>{chassis.description}</small>
              </button>
            )}
          </For>
        </div>
        </Show>

        <div class="garage-section-title garage-section-title--saved"><span>04</span> Saved builds</div>
        <div class="garage-saved-list">
          <Show when={savedBuilds().length} fallback={<p class="garage-empty">No saved configurations yet.</p>}>
            <For each={savedBuilds()}>
              {(build) => (
                <div class={`garage-saved-card ${draft().id === build.id ? 'active' : ''}`}>
                  <button onClick={() => loadBuild(build)}>
                    <strong>{build.name}</strong>
                    <small>{getGarageFramePreset(build.presetId).name} · {new Date(build.updatedAt).toLocaleDateString()}</small>
                  </button>
                  <button class="garage-delete" title="Delete build" onClick={() => removeBuild(build.id)}>×</button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </aside>

      <aside class="garage-panel garage-panel--right">
        <div class="garage-section-title"><span>03</span> Build specification</div>
        <label class="garage-name-field">
          <span>Build name</span>
          <input
            value={draft().name}
            maxlength="48"
            onInput={(event) => setDraft((current) => ({ ...current, name: event.currentTarget.value }))}
          />
        </label>

        <Show when={draft().vehicleType === 'quad'}>
          <div class="garage-control-group">
            <h2>Quad body color</h2>
            <div class="garage-frame-list">
              <For each={QUAD_BIKE_PAINTS}>
                {(paint) => (
                  <button
                    class={`garage-frame-card ${draft().paintId === paint.id ? 'active' : ''}`}
                    onClick={() => selectQuadPaint(paint)}
                  >
                    <strong>{paint.name}</strong>
                    <span class="garage-paint-chip" style={{ background: paint.color }} />
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={draft().vehicleType === 'quad'}>
          <div class="garage-control-group">
            <h2>Chassis stance</h2>
            <For each={QUAD_FRAME_FIELDS}>
              {(field) => (
                <label class="garage-slider">
                  <span>{field.label}</span>
                  <input
                    type="range" min={field.min} max={field.max} step={field.step}
                    value={draft().frame[field.key]}
                    onInput={(event) => updateFrame(field.key, event.currentTarget.value)}
                  />
                  <output>{Number(draft().frame[field.key]).toFixed(2)} {field.unit}</output>
                </label>
              )}
            </For>
          </div>
        </Show>

        <Show when={draft().vehicleType === 'car' || draft().vehicleType === 'quad'}>
        <div class="garage-control-group">
          <h2>Wheels &amp; tires</h2>
          <div class="garage-frame-list">
            <For each={getGarageTireOptionsForVehicleType(draft().vehicleType)}>
              {(tire) => (
                <button
                  class={`garage-frame-card ${draft().wheels.tireId === tire.id ? 'active' : ''}`}
                  onClick={() => selectTire(tire)}
                >
                  <strong>{tire.name}</strong>
                  <small>{tire.description}</small>
                </button>
              )}
            </For>
          </div>
          <For each={draft().vehicleType === 'quad' ? QUAD_WHEEL_FIELDS : WHEEL_FIELDS}>
            {(field) => (
              <label class="garage-slider">
                <span>{field.label}</span>
                <input
                  type="range" min={field.min} max={field.max} step={field.step}
                  value={draft().wheels[field.key]}
                  onInput={(event) => updateWheel(field.key, event.currentTarget.value)}
                />
                <output>{Number(draft().wheels[field.key]).toFixed(2)} {field.unit}</output>
              </label>
            )}
          </For>
        </div>
        </Show>

        <Show when={draft().vehicleType === 'quad'}>
          <div class="garage-control-group">
            <div class="garage-mesh-parts-header">
              <h2>Body meshes</h2>
              <button
                type="button"
                class={`garage-target-btn garage-mesh-parts-pick ${meshPartPickMode() ? 'active' : ''}`}
                title={meshPartPickMode() ? 'Cancel mesh pick' : 'Pick a mesh on the vehicle'}
                onClick={toggleMeshPartPickMode}
              >⌖</button>
            </div>
            <p class="garage-mesh-parts-hint">
              Chassis panels use the paint color above. Override roles per mesh — saved with this build.
            </p>
            <Show when={meshPartsLoading()}>
              <p class="garage-empty">Loading mesh list…</p>
            </Show>
            <Show when={!meshPartsLoading() && meshParts().length === 0}>
              <p class="garage-empty">No mesh parts found for this ATV shell.</p>
            </Show>
            <Show when={!meshPartsLoading() && meshParts().length > 0}>
              <div
                class="garage-mesh-parts-list"
                ref={bindMeshPartsList}
                onScroll={onMeshPartsListScroll}
              >
                <For each={meshParts()}>
                  {(part) => (
                    <div class="garage-mesh-part-row" data-mesh-part-key={part.key}>
                      <button
                        type="button"
                        class={`garage-target-btn ${highlightedKey() === part.key ? 'active' : ''}`}
                        title="Target / highlight this mesh part in the viewer"
                        onClick={(e) => {
                          e.preventDefault();
                          const k = part.key;
                          if (highlightedKey() === k) applyPartHighlight(null);
                          else applyPartHighlight(k);
                        }}
                      >⌖</button>
                      <span class="garage-mesh-part-name">
                        <strong>{part.key}</strong>
                        <Show when={part.role !== 'auto' && part.autoRole !== part.effectiveRole}>
                          <small>was {part.autoRole}</small>
                        </Show>
                        <Show when={part.role === 'auto' && part.autoRole !== 'auto'}>
                          <small>auto: {part.autoRole}</small>
                        </Show>
                      </span>
                      <select
                        value={part.role}
                        onChange={(event) => {
                          updateMeshPartRole(part.key, event.currentTarget.value);
                        }}
                      >
                        <For each={GARAGE_MESH_PART_ROLES}>
                          {(role) => <option value={role.id}>{role.name}</option>}
                        </For>
                      </select>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={draft().vehicleType === 'car'}>
        <div class="garage-control-group">
          <h2>Frame geometry</h2>
          <For each={FRAME_FIELDS}>
            {(field) => (
              <label class="garage-slider">
                <span>
                  {field.label}
                  <Show when={field.key === 'wheelAxleOffset'}>
                    <small> (+ rear)</small>
                  </Show>
                </span>
                <input
                  type="range" min={field.min} max={field.max} step={field.step}
                  value={draft().frame[field.key]}
                  onInput={(event) => updateFrame(field.key, event.currentTarget.value)}
                />
                <output>{Number(draft().frame[field.key]).toFixed(field.step < 0.1 ? 2 : 1)} {field.unit}</output>
              </label>
            )}
          </For>
          <label class="garage-checkbox">
            <input
              type="checkbox"
              checked={draft().hideBackSeats}
              onChange={(event) => updateHideBackSeats(event.currentTarget.checked)}
            />
            <span>
              <strong>Hide back seats</strong>
              <small>Use a two-seat layout</small>
            </span>
          </label>
          <label class="garage-checkbox">
            <input
              type="checkbox"
              checked={draft().hideEngine}
              onChange={(event) => updateHideEngine(event.currentTarget.checked)}
            />
            <span>
              <strong>Hide exposed engine</strong>
              <small>Remove the procedural engine block and pistons from the frame</small>
            </span>
          </label>
        </div>

        <Show when={draft().chassisId !== 'bare'}>
          <div class="garage-control-group">
            <h2>Chassis shell</h2>
            <label class="garage-checkbox">
              <input
                type="checkbox"
                checked={draft().disableGlassDetection}
                onChange={(event) => updateDisableGlassDetection(event.currentTarget.checked)}
              />
              <span>
                <strong>Disable glass detection</strong>
                <small>Keep all shell parts opaque — fixes misclassified windows on some models</small>
              </span>
            </label>
            <div class="garage-surface-mode-list">
              <For each={GARAGE_CHASSIS_SURFACE_MODES}>
                {(mode) => (
                  <button
                    type="button"
                    class={`garage-chassis-card garage-surface-mode-card ${
                      draft().chassisSurfaceMode === mode.id ? 'active' : ''
                    }`}
                    onClick={() => updateChassisSurfaceMode(mode.id)}
                  >
                    <strong>{mode.name}</strong>
                    <small>{mode.description}</small>
                  </button>
                )}
              </For>
            </div>

            <div class="garage-mesh-parts">
              <div class="garage-mesh-parts-header">
                <h3>Mesh parts</h3>
                <button
                  type="button"
                  class={`garage-target-btn garage-mesh-parts-pick ${meshPartPickMode() ? 'active' : ''}`}
                  title={meshPartPickMode() ? 'Cancel mesh pick' : 'Pick a mesh on the vehicle'}
                  onClick={toggleMeshPartPickMode}
                >⌖</button>
              </div>
              <p class="garage-mesh-parts-hint">
                Override auto-detected roles. Saved per chassis with this build.
              </p>
              <Show when={meshPartsLoading()}>
                <p class="garage-empty">Loading mesh list…</p>
              </Show>
              <Show when={!meshPartsLoading() && meshParts().length === 0}>
                <p class="garage-empty">No mesh parts found for this chassis.</p>
              </Show>
              <Show when={!meshPartsLoading() && meshParts().length > 0}>
                <div
                  class="garage-mesh-parts-list"
                  ref={bindMeshPartsList}
                  onScroll={onMeshPartsListScroll}
                >
                  <For each={meshParts()}>
                    {(part) => (
                      <div class="garage-mesh-part-row" data-mesh-part-key={part.key}>
                        <button
                          type="button"
                          class={`garage-target-btn ${highlightedKey() === part.key ? 'active' : ''}`}
                          title={`Target / highlight this mesh part in the viewer`}
                          onClick={(e) => {
                            e.preventDefault();
                            const k = part.key;
                            if (highlightedKey() === k) applyPartHighlight(null);
                            else applyPartHighlight(k);
                          }}
                        >⌖</button>
                        <span class="garage-mesh-part-name">
                          <strong>{part.key}</strong>
                          <Show when={part.role !== 'auto' && part.autoRole !== part.effectiveRole}>
                            <small>was {part.autoRole}</small>
                          </Show>
                          <Show when={part.role === 'auto' && part.autoRole !== 'auto'}>
                            <small>auto: {part.autoRole}</small>
                          </Show>
                        </span>
                        <select
                          value={part.role}
                          onChange={(event) => {
                            updateMeshPartRole(part.key, event.currentTarget.value);
                          }}
                        >
                          <For each={GARAGE_MESH_PART_ROLES}>
                            {(role) => <option value={role.id}>{role.name}</option>}
                          </For>
                        </select>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={draft().chassisId !== 'bare'}>
          <div class="garage-control-group">
            <h2>Chassis shell transform</h2>
            <For each={CHASSIS_TRANSFORM_FIELDS}>
              {(field) => (
                <label class="garage-slider">
                  <span>{field.label}</span>
                  <input
                    type="range" min={field.min} max={field.max} step={field.step}
                    value={draft().chassisTransform[field.group][field.index]}
                    onInput={(event) => updateChassisTransform(
                      field.group,
                      field.index,
                      event.currentTarget.value,
                    )}
                  />
                  <output>{Number(draft().chassisTransform[field.group][field.index]).toFixed(field.step < 1 ? 2 : 0)} {field.unit}</output>
                </label>
              )}
            </For>
          </div>
        </Show>
        </Show>

        <Show when={draft().vehicleType !== 'horse'}>
        <div class="garage-control-group">
          <h2>Performance</h2>
          <Show when={draft().vehicleType === 'car'}>
          <div class="garage-frame-list">
            <For each={GARAGE_ENGINE_OPTIONS}>
              {(engine) => (
                <button
                  class={`garage-frame-card ${draft().performance.engineProfile === engine.id ? 'active' : ''}`}
                  onClick={() => selectEngine(engine)}
                >
                  <strong>{engine.name}</strong>
                  <small>{engine.description}</small>
                </button>
              )}
            </For>
          </div>
          </Show>
          <For each={PERFORMANCE_FIELDS}>
            {(field) => (
              <label class="garage-slider">
                <span>{field.label}</span>
                <input
                  type="range" min={field.min} max={field.max} step={field.step}
                  value={draft().performance[field.key]}
                  onInput={(event) => updatePerformance(field.key, event.currentTarget.value)}
                />
                <output>{Number(draft().performance[field.key]).toFixed(field.step < 0.1 ? 2 : 1)} {field.unit}</output>
              </label>
            )}
          </For>
        </div>
        </Show>
        <Show when={draft().vehicleType === 'horse'}>
          <div class="garage-control-group">
            <h2>Horse mount</h2>
            <p class="garage-empty">Uses the existing horse, saddle socket, riding animation, and rein IK.</p>
          </div>
        </Show>

        <div class="garage-save-row">
          <button class="garage-button ghost" onClick={save}>Save configuration</button>
          <p>{status()}</p>
        </div>
      </aside>

      <div class="garage-orbit-hint">
        {meshPartPickMode()
          ? 'Click a mesh on the vehicle to select it.'
          : 'Drag to rotate · Cmd+drag to orbit · scroll to zoom'}
      </div>
    </section>
  );
}

async function createGaragePreview(canvas, initialBuild, pickOptions = {}) {
  const worldPreset = getQualityPreset(getQualityLevel());
  const garagePreset = {
    ...worldPreset,
    // Keep the world's active renderer/post stack, while guaranteeing a crisp
    // local hero-light shadow in this compact scene.
    shadows: true,
    shadowMapSize: Math.max(1024, worldPreset.shadowMapSize ?? 1024),
    environment: {
      ...worldPreset.environment,
      weather: 'clear',
      aerialPerspective: false,
    },
  };
  const rendererSystem = new RendererSystem({
    canvas,
    qualityPreset: garagePreset,
  });
  await rendererSystem.initialize();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x151a1d);
  scene.fog = new THREE.Fog(0x151a1d, 18, 32);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  const cameraTarget = new THREE.Vector3(0, 0.65, 0);
  const cameraBaseOffset = new THREE.Vector3(-7.8, 3.7, 8.8).sub(cameraTarget);
  const cameraBaseSpherical = new THREE.Spherical().setFromVector3(cameraBaseOffset);
  const cameraOrbit = {
    theta: cameraBaseSpherical.theta,
    phi: cameraBaseSpherical.phi,
  };
  const cameraRadius = cameraBaseSpherical.radius;
  let cameraZoom = 1;
  const applyCameraZoom = () => {
    const offset = new THREE.Vector3().setFromSpherical({
      radius: cameraRadius * cameraZoom,
      phi: cameraOrbit.phi,
      theta: cameraOrbit.theta,
    });
    camera.position.copy(cameraTarget).add(offset);
    camera.lookAt(cameraTarget);
    canvas.dataset.previewZoom = cameraZoom.toFixed(3);
  };
  const mutateCameraOrbit = (deltaX, deltaY) => {
    cameraOrbit.theta -= deltaX * 0.008;
    cameraOrbit.phi = THREE.MathUtils.clamp(
      cameraOrbit.phi + deltaY * 0.008,
      0.18,
      Math.PI - 0.18,
    );
  };
  applyCameraZoom();

  const onWheel = (event) => {
    event.preventDefault();
    cameraZoom = THREE.MathUtils.clamp(
      cameraZoom * Math.exp(-event.deltaY * 0.0012),
      0.28,
      1.45,
    );
    applyCameraZoom();
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });

  scene.add(new THREE.AmbientLight(0xffffff, 0.28));
  scene.add(new THREE.HemisphereLight(
    garagePreset.environment?.hemisphereSkyColor ?? 0xb9d8ff,
    garagePreset.environment?.hemisphereGroundColor ?? 0x776653,
    garagePreset.environment?.hemisphereIntensity ?? 1.6,
  ));
  const key = new THREE.SpotLight(0xffd8a8, 650, 24, Math.PI * 0.22, 0.45, 1.2);
  key.position.set(-5, 8, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(garagePreset.shadowMapSize, garagePreset.shadowMapSize);
  key.shadow.bias = -0.00035;
  key.shadow.normalBias = 0.025;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 28;
  scene.add(key);
  const rim = new THREE.SpotLight(0x7fc6e8, 420, 20, Math.PI * 0.24, 0.5, 1.2);
  rim.position.set(5, 5, -5);
  scene.add(rim);

  // Give the probe grid real nearby surfaces to capture. The open front keeps
  // the existing camera composition, while the warm/cool side walls and bright
  // ceiling panels produce spatially varying color bounce across the vehicle.
  const roomMaterial = new THREE.MeshStandardMaterial({
    color: 0x25292b,
    roughness: 0.86,
    metalness: 0.04,
  });
  const warmWallMaterial = roomMaterial.clone();
  warmWallMaterial.color.set(0x3a2b25);
  const coolWallMaterial = roomMaterial.clone();
  coolWallMaterial.color.set(0x243138);
  const roomSurfaces = [
    new THREE.Mesh(new THREE.BoxGeometry(0.28, 6.2, 13), warmWallMaterial),
    new THREE.Mesh(new THREE.BoxGeometry(0.28, 6.2, 13), coolWallMaterial),
    new THREE.Mesh(new THREE.BoxGeometry(17, 0.24, 13), roomMaterial),
  ];
  roomSurfaces[0].position.set(-8.25, 3.1, 0.6);
  roomSurfaces[1].position.set(8.25, 3.1, 0.6);
  roomSurfaces[2].position.set(0, 6.15, 0.6);
  for (const surface of roomSurfaces) {
    surface.receiveShadow = true;
    scene.add(surface);
  }

  const panelMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff3da,
    emissive: 0xffd8a8,
    emissiveIntensity: 7,
    roughness: 0.3,
  });
  for (const x of [-4.2, 0, 4.2]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.05, 1.15), panelMaterial);
    panel.position.set(x, 5.98, 0.5);
    scene.add(panel);
  }

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x171a1b, roughness: 0.82, metalness: 0.18 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(34, 34, 0x7c5a35, 0x292d2e);
  grid.position.y = 0.006;
  scene.add(grid);

  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(3.5, 3.65, 0.16, 64),
    new THREE.MeshStandardMaterial({ color: 0x242829, roughness: 0.42, metalness: 0.72 }),
  );
  platform.position.y = 0.08;
  platform.receiveShadow = true;
  scene.add(platform);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(3.48, 0.035, 8, 96),
    new THREE.MeshStandardMaterial({ color: 0xd29b58, emissive: 0x5c3214, emissiveIntensity: 1.8 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.18;
  scene.add(ring);

  const curtain = await createRapierCurtain(scene);
  canvas.dataset.curtainNodes = String(curtain.nodeCount);

  let vehicle = null;
  let model = null;
  let rebuildVersion = 0;
  let probes = null;
  let disposed = false;
  let currentHighlight = null;
  let meshPartPickActive = false;
  const raycaster = new THREE.Raycaster();
  const pickMeshes = [];
  const collectPickMeshes = () => {
    pickMeshes.length = 0;
    const root = vehicle?.chassisOverlay || model;
    if (!root) return pickMeshes;
    root.traverse((child) => {
      if (child.isMesh && child.visible && !child.userData._isHighlightOutline) {
        pickMeshes.push(child);
      }
    });
    return pickMeshes;
  };
  const pickMeshPartAt = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    raycaster.setFromCamera({
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: -((clientY - rect.top) / rect.height) * 2 + 1,
    }, camera);
    const hits = raycaster.intersectObjects(collectPickMeshes(), false);
    if (!hits.length) return null;
    return resolveMeshPartKey(hits[0].object);
  };
  const viewport = createGarageViewportControls(canvas, {
    getModel: () => model,
    applyCamera: applyCameraZoom,
    mutateOrbit: mutateCameraOrbit,
    isMeshPartPickActive: () => meshPartPickActive,
    onMeshPartPick: (clientX, clientY) => {
      const key = pickMeshPartAt(clientX, clientY);
      if (!key) return;
      meshPartPickActive = false;
      viewport.setPickMode(false);
      pickOptions.onMeshPartPicked?.(key);
    },
  });

  function createMeshOutline(mesh) {
    if (!mesh?.geometry) return null;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x39ffaa,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const outline = new THREE.Mesh(mesh.geometry, mat);
    outline.name = `highlight-outline`;
    outline.userData._isHighlightOutline = true;
    outline.position.copy(mesh.position);
    outline.quaternion.copy(mesh.quaternion);
    outline.scale.copy(mesh.scale || { x: 1, y: 1, z: 1 }).multiplyScalar(1.032);
    outline.updateMatrix();
    outline.matrixAutoUpdate = false;
    return outline;
  }

  function clearCurrentHighlight() {
    if (!currentHighlight) return;
    const { matches = [], outlines = [] } = currentHighlight;
    for (const ol of outlines) {
      ol.parent?.remove(ol);
      ol.material?.dispose?.();
      // geometry is shared with source mesh; do not dispose here
    }
    for (const m of matches) {
      if (typeof m.userData._prevVisible !== 'undefined') {
        m.visible = !!m.userData._prevVisible;
        delete m.userData._prevVisible;
      }
      delete m.userData._highlightMat;
    }
    currentHighlight = null;
  }

  const rebuildVehicle = async (build) => {
    clearCurrentHighlight();
    const version = ++rebuildVersion;
    if (model) {
      scene.remove(model);
      disposePreviewObject(model);
    }
    const chassis = getGarageChassisOption(build.chassisId);
    const vehicleOptions = vehicleOptionsFromGarageBuild(build);
    const PreviewVehicle = vehicleOptions.vehicleKind === 'quad' ? QuadBikeVehicle : BaseVehicle;
    const nextVehicle = new PreviewVehicle({
      ...vehicleOptions,
      name: 'Garage Preview',
    });
    const nextModel = nextVehicle.buildMesh();
    nextVehicle.group = nextModel;
    await nextVehicle.assembleGroundVehicleVisuals({ syncParkedWheels: true });
    nextModel.position.y = 1.03;
    viewport.applyTurntable(nextModel);
    scene.add(nextModel);
    vehicle = nextVehicle;
    model = nextModel;
    syncVehicleMetrics();
    canvas.dataset.chassis = chassis.id;
    canvas.dataset.previewObjects = String(nextModel.children.length);
    if (version !== rebuildVersion) {
      scene.remove(nextModel);
      disposePreviewObject(nextModel);
    }
  };
  await rebuildVehicle(initialBuild);
  // Generate the same physical-sky PMREM used by the world without showing an
  // outdoor sky behind the enclosed garage set.
  const environmentSourceScene = new THREE.Scene();
  const environmentSky = new SkySystem().initialize(environmentSourceScene, {
    qualityPreset: garagePreset,
  });
  rendererSystem.installEnvironment(scene, environmentSky);
  environmentSky.dispose();

  // A compact irradiance volume gives the enclosed preview position-dependent
  // diffuse bounce. One extra pass captures a single indirect bounce from the
  // room, platform, curtain, and vehicle; the low-resolution cubemaps keep the
  // one-time bake practical for an interactive UI scene.
  probes = new LightProbeGrid(16, 5.4, 12, 4, 3, 4);
  probes.name = 'Garage Global Illumination';
  probes.position.set(0, 3.05, 0.5);
  probes.intensity = 0.82;
  scene.add(probes);
  bakeGarageGi();
  canvas.dataset.gi = 'baked';

  let renderedFrames = 0;
  const resize = () => {
    rendererSystem.resizeIfNeeded();
    const { aspect } = rendererSystem.getViewport();
    if (Math.abs(camera.aspect - aspect) > 0.0001) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let lastTime = null;
  const tick = (timeMs = performance.now()) => {
    if (disposed) return;
    const dt = lastTime == null ? 1 / 60 : Math.min(0.05, Math.max(0, (timeMs - lastTime) / 1000));
    lastTime = timeMs;
    curtain.update(timeMs / 1000, dt);
    resize();
    rendererSystem.render({ scene, camera });
    renderedFrames += 1;
    if (renderedFrames >= 2) {
      const stats = rendererSystem.snapshot();
      canvas.dataset.renderCalls = String(stats.renderCalls ?? 0);
      canvas.dataset.triangles = String(stats.triangles ?? 0);
      canvas.dataset.cameraAspect = camera.aspect.toFixed(5);
      canvas.dataset.previewReady = 'true';
    }
  };
  await rendererSystem.setAnimationLoop(tick);

  return {
    setFrame(frame, replace = false) {
      if (replace) vehicle.frameParameters = { ...vehicle.frameParameterDefaults, ...frame };
      vehicle.setFrameParameters(frame);
      vehicle._syncParkedWheelVisuals();
      syncVehicleMetrics();
    },
    setBuild(build) {
      rebuildVehicle(build);
    },
    setChassisTransform(transform) {
      if (vehicle.chassisOverlayOptions) {
        vehicle.chassisOverlayOptions.position = [...transform.position];
        vehicle.chassisOverlayOptions.rotationDegrees = [...transform.rotationDegrees];
        vehicle.chassisOverlayOptions.scale = [...transform.scale];
      }
      vehicle.setChassisOverlayTransform(transform);
    },
    highlightPart(key) {
      clearCurrentHighlight();
      if (!key) return;
      const root = vehicle?.chassisOverlay || model;
      if (!root) return;
      const matches = [];
      const findMatches = (obj) => {
        if (!obj) return;
        obj.traverse((child) => {
          if (child.isMesh && resolveMeshPartKey(child) === key) {
            matches.push(child);
          }
        });
      };
      findMatches(root);
      if (matches.length === 0 && model && root !== model) findMatches(model);
      if (!matches.length) return;

      const outlines = [];
      for (const m of matches) {
        m.userData._prevVisible = m.visible;
        m.visible = true;
        const outline = createMeshOutline(m);
        if (outline && m.parent) {
          m.parent.add(outline);
          outlines.push(outline);
        }
      }
      currentHighlight = { key, matches, outlines };
    },
    clearHighlight() {
      clearCurrentHighlight();
    },
    setMeshPartPickMode(active) {
      meshPartPickActive = !!active;
      viewport.setPickMode(meshPartPickActive);
    },
    dispose() {
      disposed = true;
      clearCurrentHighlight();
      delete canvas.dataset.previewReady;
      delete canvas.dataset.previewObjects;
      delete canvas.dataset.chassis;
      delete canvas.dataset.curtainNodes;
      delete canvas.dataset.cameraAspect;
      delete canvas.dataset.previewWheelTrack;
      delete canvas.dataset.previewWheelbase;
      delete canvas.dataset.previewRideDelta;
      delete canvas.dataset.gi;
      delete canvas.dataset.previewZoom;
      canvas.removeEventListener('wheel', onWheel);
      rebuildVersion += 1;
      observer.disconnect();
      viewport.dispose();
      curtain.dispose();
      probes?.dispose();
      scene.traverse(disposePreviewMaterial);
      rendererSystem.dispose();
    },
  };

  function syncVehicleMetrics() {
    if (!vehicle?.wheelAnchors?.length) return;
    canvas.dataset.previewWheelTrack = (
      Math.max(...vehicle.wheelAnchors.map((anchor) => anchor.x))
      - Math.min(...vehicle.wheelAnchors.map((anchor) => anchor.x))
    ).toFixed(4);
    canvas.dataset.previewWheelbase = (
      Math.max(...vehicle.wheelAnchors.map((anchor) => anchor.z))
      - Math.min(...vehicle.wheelAnchors.map((anchor) => anchor.z))
    ).toFixed(4);
    const anchor = vehicle.wheelAnchors[0];
    const node = vehicle.wheelMeshes[0]?.userData.suspNode;
    canvas.dataset.previewRideDelta = String(node ? anchor.y - node.position.y : 0);
  }

  function bakeGarageGi() {
    if (!probes || disposed) return;
    probes.bake(rendererSystem.renderer, scene, {
      cubemapSize: 8,
      near: 0.08,
      far: 30,
      bounces: 1,
      sampleCount: 128,
    });
    probes.visible = true;
    canvas.dataset.gi = 'baked';
  }
}

function createGarageViewportControls(canvas, {
  getModel,
  applyCamera,
  mutateOrbit,
  isMeshPartPickActive,
  onMeshPartPick,
}) {
  let yaw = -0.35;
  let activePointer = null;
  let dragMode = null;
  let pickPointerId = null;
  let pickStartX = 0;
  let pickStartY = 0;
  let pickModeActive = false;
  let lastClientX = 0;
  let lastClientY = 0;
  const PICK_MOVE_THRESHOLD_SQ = 16;

  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';
  canvas.dataset.previewRotation = yaw.toFixed(4);

  const applyTurntable = (object = getModel()) => {
    if (object) object.rotation.y = yaw;
    canvas.dataset.previewRotation = yaw.toFixed(4);
  };

  const refreshCursor = () => {
    if (activePointer !== null) {
      canvas.style.cursor = 'grabbing';
      return;
    }
    canvas.style.cursor = pickModeActive ? 'crosshair' : 'grab';
  };

  const finishDrag = (event) => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = null;
    dragMode = null;
    refreshCursor();
  };

  const finishPick = (event) => {
    if (event.pointerId !== pickPointerId) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const dx = event.clientX - pickStartX;
    const dy = event.clientY - pickStartY;
    if ((dx * dx + dy * dy) <= PICK_MOVE_THRESHOLD_SQ) {
      onMeshPartPick?.(event.clientX, event.clientY);
    }
    pickPointerId = null;
    refreshCursor();
  };

  const onPointerDown = (event) => {
    if (event.button !== 0 || activePointer !== null || pickPointerId !== null) return;
    if (isMeshPartPickActive?.()) {
      pickPointerId = event.pointerId;
      pickStartX = event.clientX;
      pickStartY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'crosshair';
      event.preventDefault();
      return;
    }
    activePointer = event.pointerId;
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    dragMode = event.metaKey ? 'orbit' : 'turntable';
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (event.pointerId !== activePointer) return;
    const deltaX = event.clientX - lastClientX;
    const deltaY = event.clientY - lastClientY;
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    if (dragMode === 'orbit') {
      mutateOrbit(deltaX, deltaY);
      applyCamera();
    } else {
      yaw += deltaX * 0.01;
      applyTurntable();
    }
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    if (pickPointerId !== null) {
      finishPick(event);
      return;
    }
    finishDrag(event);
  };

  const onPointerCancel = (event) => {
    if (pickPointerId !== null) {
      if (event.pointerId === pickPointerId) {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        pickPointerId = null;
        refreshCursor();
      }
      return;
    }
    finishDrag(event);
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  return {
    applyTurntable,
    setPickMode(active) {
      pickModeActive = !!active;
      canvas.dataset.meshPartPick = pickModeActive ? '1' : '';
      refreshCursor();
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.style.cursor = '';
      canvas.style.touchAction = '';
      delete canvas.dataset.previewRotation;
      delete canvas.dataset.meshPartPick;
    },
  };
}

async function createRapierCurtain(scene) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -4.2, z: 0 });
  world.timestep = 1 / 60;
  world.numSolverIterations = 8;

  const columns = 12;
  const rows = 8;
  const width = 8.6;
  const height = 5.0;
  const spacingX = width / (columns - 1);
  const spacingY = height / (rows - 1);
  const originX = -width * 0.5;
  const topY = 5.35;
  const curtainZ = -4.5;
  const bodies = [];
  const dynamicBodies = [];
  const zero = { x: 0, y: 0, z: 0 };

  for (let row = 0; row < rows; row += 1) {
    const bodyRow = [];
    for (let column = 0; column < columns; column += 1) {
      const x = originX + column * spacingX;
      const y = topY - row * spacingY;
      const z = curtainZ + Math.sin((column / (columns - 1)) * Math.PI * 5) * 0.07;
      const desc = row === 0
        ? RAPIER.RigidBodyDesc.fixed()
        : RAPIER.RigidBodyDesc.dynamic()
          .setAdditionalMass(0.045)
          .setLinearDamping(2.8)
          .setAngularDamping(3.5)
          .setCanSleep(false);
      const body = world.createRigidBody(desc.setTranslation(x, y, z));
      bodyRow.push(body);
      if (row > 0) dynamicBodies.push({ body, row, column });
    }
    bodies.push(bodyRow);
  }

  const connect = (a, b, length, stiffness, damping) => {
    world.createImpulseJoint(
      RAPIER.JointData.spring(length, stiffness, damping, zero, zero),
      a,
      b,
      true,
    );
  };
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (column + 1 < columns) {
        connect(bodies[row][column], bodies[row][column + 1], spacingX, 42, 4.8);
      }
      if (row + 1 < rows) {
        connect(bodies[row][column], bodies[row + 1][column], spacingY, 48, 5.2);
      }
      if (row + 1 < rows && column + 1 < columns) {
        const diagonal = Math.hypot(spacingX, spacingY);
        connect(bodies[row][column], bodies[row + 1][column + 1], diagonal, 24, 3.6);
        connect(bodies[row][column + 1], bodies[row + 1][column], diagonal, 24, 3.6);
      }
    }
  }

  const positions = new Float32Array(columns * rows * 3);
  const indices = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x090a0b,
    roughness: 0.96,
    metalness: 0,
    sheen: 0.7,
    sheenColor: new THREE.Color(0x34383b),
    sheenRoughness: 0.82,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Rapier black fabric curtain';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.075, width + 0.55, 18),
    new THREE.MeshStandardMaterial({ color: 0x202326, roughness: 0.35, metalness: 0.82 }),
  );
  rod.name = 'Curtain support';
  rod.rotation.z = Math.PI / 2;
  rod.position.set(0, topY + 0.12, curtainZ);
  rod.castShadow = true;
  scene.add(rod);

  let accumulator = 0;
  let normalFrame = 0;
  const syncMesh = () => {
    const attribute = geometry.getAttribute('position');
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const translation = bodies[row][column].translation();
        const index = (row * columns + column) * 3;
        attribute.array[index] = translation.x;
        attribute.array[index + 1] = translation.y;
        attribute.array[index + 2] = translation.z;
      }
    }
    attribute.needsUpdate = true;
    if ((normalFrame++ & 1) === 0) geometry.computeVertexNormals();
  };
  syncMesh();

  return {
    nodeCount: columns * rows,
    update(time, dt) {
      accumulator = Math.min(accumulator + dt, 1 / 15);
      while (accumulator >= 1 / 60) {
        for (const node of dynamicBodies) {
          node.body.resetForces(false);
          const phase = time * 1.15 + node.column * 0.43 + node.row * 0.19;
          const edgeFade = Math.sin((node.column / (columns - 1)) * Math.PI);
          node.body.addForce({
            x: Math.cos(phase * 0.7) * 0.0015 * edgeFade,
            y: 0,
            z: (0.004 + Math.sin(phase) * 0.003) * edgeFade,
          }, false);
        }
        world.step();
        accumulator -= 1 / 60;
      }
      syncMesh();
    },
    dispose() {
      scene.remove(mesh, rod);
      geometry.dispose();
      material.dispose();
      rod.geometry.dispose();
      rod.material.dispose();
      world.free?.();
    },
  };
}

function disposePreviewObject(root) {
  root.traverse(disposePreviewMaterial);
}

function disposePreviewMaterial(object) {
  object.geometry?.dispose?.();
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    if (!material) continue;
    for (const value of Object.values(material)) value?.isTexture && value.dispose();
    material.dispose?.();
  }
}
