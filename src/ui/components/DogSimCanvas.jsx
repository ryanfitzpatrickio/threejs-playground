import { createSignal, createMemo, createEffect, onCleanup, onMount, For, Show } from 'solid-js';
import { DogSimScene, DOG_REFERENCE_PRESETS } from '../../game/test/DogSimScene.js';
import {
  ANIMAL_SPECIES,
  getDogBreeds,
  getFamiliesForSpecies,
  isSpeciesPopulated,
} from '../../game/characters/dog/dogCatalog.js';
import {
  DOG_CLIP_CATALOG,
  RODENT_CLIP_CATALOG,
  FARM_CLIP_CATALOG,
} from '../../game/characters/dog/DogClipPlayer.js';
import { GOOSE_CLIP_CATALOG } from '../../game/characters/goose/createProceduralGoose.js';
import { LADYBUG_CLIP_CATALOG } from '../../game/characters/insect/ladybugAnimation.js';
import { registerAnimalBodyDebug } from '../../game/debug/registerAnimalBodyDebug.js';

const BEHAVIORS = [
  { id: 'idle', label: 'Idle' },
  { id: 'walk', label: 'Walk' },
  { id: 'trot', label: 'Trot' },
  { id: 'sit', label: 'Sit' },
  { id: 'look', label: 'Look' },
];

const LADYBUG_BEHAVIORS = [
  { id: 'idle', label: 'Idle' },
  { id: 'walk', label: 'Crawl' },
  { id: 'run', label: 'Run' },
  { id: 'look', label: 'Alert' },
  { id: 'alert', label: 'Threat' },
];

/** Bird-facing labels for the same behavior ids (map to Flap/Glide clips). */
const BIRD_BEHAVIORS = [
  { id: 'idle', label: 'Idle' },
  { id: 'walk', label: 'Walk' },
  { id: 'trot', label: 'Flap' },
  { id: 'sit', label: 'Perch' },
  { id: 'look', label: 'Glide' },
];

/** Canada goose procedural FSM — ground + flight states. */
const GOOSE_BEHAVIORS = [
  { id: 'idle', label: 'Idle' },
  { id: 'walk', label: 'Walk' },
  { id: 'hiss', label: 'Hiss' },
  { id: 'swim', label: 'Swim' },
  { id: 'flap', label: 'Flap' },
  { id: 'takeoff', label: 'Takeoff' },
  { id: 'fly_flap', label: 'Fly Flap' },
  { id: 'fly_glide', label: 'Fly Glide' },
  { id: 'fly_dive', label: 'Fly Dive' },
  { id: 'land_feet', label: 'Land Feet' },
  { id: 'land_water', label: 'Land Water' },
  { id: 'look', label: 'Alert' },
  { id: 'sit', label: 'Rest' },
];

const MOUTH_STATES = [
  { id: 'closed', label: 'Mouth closed' },
  { id: 'open', label: 'Panting' },
  { id: 'alert', label: 'Alert' },
];

/**
 * Procedural animal studio viewer (dogs, birds, rodents, …).
 * Boot: main menu "Dog Studio", dog-park HUD Studio, or ?view=dog-sim
 * Harness: ?harness — deterministic presets + gallery API.
 */
export function DogSimCanvas(props) {
  let canvas;
  /** @type {DogSimScene | null} */
  let scene = null;
  const [snapshot, setSnapshot] = createSignal(null);
  const [referenceFailed, setReferenceFailed] = createSignal(false);

  onMount(() => {
    // Ensure P-menu Dog Body / Bird Body folders exist even when GameRuntime
    // never booted (playground Dog Studio path).
    try {
      registerAnimalBodyDebug();
    } catch (err) {
      console.warn('[DogSim] animal body debug register failed', err);
    }
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
  // Variant stills often aren't photographed yet: try the variant subfolder
  // first, fall back to the breed's default-variant still, then root aliases.
  // Stabilize on URL *content* — snapshot rebuilds a new array every tick, and
  // resetting the chain index on that identity change made the panel flash and
  // never settle past a 404.
  const refChainKey = createMemo(() => {
    const chain = snapshot()?.referenceImageChain;
    if (chain?.length) return chain.join('\n');
    const fallback = activePreset()?.refImage;
    return fallback ?? '';
  });
  const refChain = createMemo(() => {
    const key = refChainKey();
    if (!key) return [];
    return key.split('\n').filter(Boolean);
  });
  const [refIndex, setRefIndex] = createSignal(0);
  const refImageSrc = createMemo(() => {
    if (referenceFailed()) return null;
    return refChain()[refIndex()] ?? null;
  });
  const speciesFamilies = createMemo(() => getFamiliesForSpecies(snapshot()?.speciesId ?? 'canidae'));
  const familyBreeds = createMemo(() => getDogBreeds(snapshot()?.familyId));
  const speciesHasBreeds = createMemo(() => isSpeciesPopulated(snapshot()?.speciesId ?? 'canidae'));
  const variants = createMemo(() => snapshot()?.variants ?? []);
  const isBird = createMemo(() => snapshot()?.animationClips?.library === 'bird'
    || snapshot()?.animationClips?.library === 'goose'
    || Boolean(snapshot()?.resolvedTraits?.rigKind === 'bird')
    || Boolean(snapshot()?.resolvedTraits?.rigKind === 'goose')
    || Boolean(snapshot()?.isBird));
  // All birds share the goose body + procedural FSM (variety recolors/scales).
  const isGoose = createMemo(() => snapshot()?.animationClips?.library === 'goose'
    || Boolean(snapshot()?.resolvedTraits?.rigKind === 'goose')
    || isBird());
  const isLadybug = createMemo(() => snapshot()?.animationClips?.library === 'ladybug'
    || Boolean(snapshot()?.resolvedTraits?.rigKind === 'insect')
    || Boolean(snapshot()?.isInsect && snapshot()?.breedId === 'seven-spotted-ladybug'));
  /** Prefer live library catalog (dog / rodent / equid / bovid / bird / goose packs). */
  const clipCatalog = createMemo(() => {
    const live = snapshot()?.animationClips?.catalog;
    if (Array.isArray(live) && live.length) return live;
    const lib = snapshot()?.animationClips?.library;
    if (lib === 'ladybug') return LADYBUG_CLIP_CATALOG;
    if (lib === 'bird' || lib === 'goose') return GOOSE_CLIP_CATALOG;
    if (lib === 'rodent') return RODENT_CLIP_CATALOG;
    if (lib === 'equid' || lib === 'bovid') return FARM_CLIP_CATALOG;
    return DOG_CLIP_CATALOG;
  });
  const behaviorButtons = createMemo(() => (
    isLadybug() ? LADYBUG_BEHAVIORS
      : isGoose() ? GOOSE_BEHAVIORS
        : isBird() ? BIRD_BEHAVIORS
          : BEHAVIORS
  ));
  createEffect(() => {
    const key = refChainKey();
    // Depend only on the stable key string.
    void key;
    setRefIndex(0);
    setReferenceFailed(false);
  });

  return (
    <div
      class="cut-test-shell horde-viewer-shell dog-sim-shell"
      classList={{ 'dog-sim-shell--free-roam': snapshot()?.freeRoam }}
    >
      <canvas
        ref={canvas}
        class="cut-test-canvas"
        aria-label="Procedural dog simulation"
        tabindex="0"
      />

      <Show when={snapshot()?.compareEnabled}>
        <div class="dog-sim-compare">
          <div class="dog-sim-compare__label">
            Reference · {snapshot()?.breedLabel ?? 'Golden Retriever'}
            <Show when={snapshot()?.variantId && snapshot()?.variantId !== 'default'}>
              {' · '}{snapshot()?.variantLabel}
            </Show>
            {' · '}{activePreset()?.label ?? snapshot()?.preset ?? '—'}
          </div>
          <Show
            when={refImageSrc()}
            fallback={(
              <div class="dog-sim-compare__placeholder">
                Missing still — add JPG under
                <code> public/assets/dog-ref/ </code>
                (or bird-ref / cat-ref / …)
                ({snapshot()?.preset})
              </div>
            )}
          >
            <img
              class="dog-sim-compare__img"
              src={refImageSrc()}
              alt={`${snapshot()?.breedLabel ?? 'Dog'} reference ${activePreset()?.label ?? ''}`}
              onError={() => {
                const chain = refChain();
                const next = refIndex() + 1;
                if (next < chain.length) setRefIndex(next);
                else setReferenceFailed(true);
              }}
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

        <Show when={!snapshot()?.harness}>
          <div class="horde-viewer-section-label">Mode</div>
          <div class="horde-viewer-gate-grid">
            <button
              type="button"
              class={`tb-btn horde-gate-btn ${snapshot()?.freeRoam ? 'active' : ''}`}
              title="Walk any animal with the dog-park third-person camera (WASD, LMB orbit, RMB free-look, scroll zoom). Esc exits."
              onClick={() => scene?.setFreeRoam(!snapshot()?.freeRoam)}
            >
              Free roam
            </button>
          </div>
          <Show when={snapshot()?.freeRoam}>
            <p class="horde-viewer-hint dog-sim-free-roam-hint">
              <strong>Free roam</strong> — WASD move · Shift sprint · C sit · LMB orbit · RMB look · scroll zoom · R recenter · Esc exit.
              Same chase cam as Dog Park (scale-aware).
              {snapshot()?.speed != null ? ` · ${snapshot()?.speed?.toFixed?.(2) ?? snapshot()?.speed} m/s` : ''}
            </p>
          </Show>
        </Show>

        <div class="cut-test-controls">
          <div class="horde-viewer-section-label">Generator</div>
          <div class="dog-sim-generator-grid dog-sim-generator-grid--species">
            <label class="dog-sim-generator-grid__species">
              <span>Species</span>
              <select
                value={snapshot()?.speciesId ?? 'canidae'}
                onChange={(event) => scene?.setSpecies(event.currentTarget.value)}
              >
                <For each={ANIMAL_SPECIES}>
                  {(species) => (
                    <option value={species.id}>
                      {species.label}
                      {isSpeciesPopulated(species.id) ? '' : ' · soon'}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label>
              <span>Family</span>
              <select
                value={snapshot()?.familyId ?? ''}
                disabled={!speciesFamilies().length}
                onChange={(event) => scene?.setFamily(event.currentTarget.value)}
              >
                <Show when={!speciesFamilies().length}>
                  <option value="">— none yet —</option>
                </Show>
                <For each={speciesFamilies()}>
                  {(family) => <option value={family.id}>{family.label}</option>}
                </For>
              </select>
            </label>
            <label>
              <span>Breed</span>
              <select
                value={snapshot()?.breedId ?? ''}
                disabled={!familyBreeds().length}
                onChange={(event) => scene?.setBreed(event.currentTarget.value)}
              >
                <Show when={!familyBreeds().length}>
                  <option value="">
                    {speciesHasBreeds() ? '— pick family —' : '— none yet —'}
                  </option>
                </Show>
                <For each={familyBreeds()}>
                  {(breed) => <option value={breed.id}>{breed.label}</option>}
                </For>
              </select>
            </label>
            <Show when={variants().length > 1}>
              <label class="dog-sim-generator-grid__variant">
                <span>Variant</span>
                <select
                  value={snapshot()?.variantId ?? 'default'}
                  onChange={(event) => scene?.setVariant(event.currentTarget.value)}
                >
                  <For each={variants()}>
                    {(variant) => <option value={variant.id}>{variant.label}</option>}
                  </For>
                </select>
              </label>
            </Show>
          </div>
          <Show when={!speciesHasBreeds()}>
            <p class="horde-viewer-hint dog-sim-species-empty">
              {snapshot()?.speciesLabel ?? 'This species'} is on the master list but has no
              authored families/breeds yet — planned for the park catalog.
            </p>
          </Show>
          <Show when={snapshot()?.isInsect && snapshot()?.animationClips?.library !== 'ladybug'}>
            <p class="horde-viewer-hint dog-sim-species-empty">
              Insecta catalog entry — breed/variants selectable, mesh/rig not built yet
              (previous animal remains on stage).
            </p>
          </Show>
          <Show when={snapshot()?.animationClips?.library === 'ladybug'}>
            <p class="horde-viewer-hint dog-sim-species-empty">
              Procedural ladybug — 15-bone rig, hard elytra spots, soft belly shells.
              Try Crawl / Alert (elytra flare). Naked body toggles soft shells.
            </p>
          </Show>
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
            <span>
              {(snapshot()?.variantId && snapshot()?.variantId !== 'default')
                ? snapshot()?.variantLabel
                : snapshot()?.breedSummary?.coat ?? '—'} coat
            </span>
            <span>Energy {snapshot()?.breedSummary?.energy ?? '—'}/5</span>
            <span>Trainability {snapshot()?.breedSummary?.trainability ?? '—'}/5</span>
          </div>

          <div class="horde-viewer-section-label">
            Skeleton clips
            <Show when={snapshot()?.animationClips?.ready}>
              <span class="dog-sim-clip-meta">
                {' · '}{snapshot()?.animationClips?.clip ?? '—'}
                {snapshot()?.animationClips?.clips
                  ? ` / ${snapshot()?.animationClips?.clips}`
                  : ''}
              </span>
            </Show>
          </div>
          <Show
            when={snapshot()?.animationClips?.ready}
            fallback={(
              <p class="horde-viewer-hint">
                {snapshot()?.animationClips?.enabled === false
                  || snapshot()?.harness
                  ? 'Clip library off (harness or ?dogAnims=procedural). Procedural gait is fallback only.'
                  : 'Loading skeleton retarget clips…'}
              </p>
            )}
          >
            <div class="horde-viewer-gate-grid dog-sim-clip-grid">
              <For each={clipCatalog()}>
                {(clip) => {
                  const active = () => snapshot()?.animationClips?.clip === clip.name
                    || snapshot()?.animationClips?.pinned === clip.name;
                  return (
                    <button
                      type="button"
                      class={`tb-btn horde-gate-btn ${active() ? 'active' : ''}`}
                      title={clip.loop ? `${clip.name} (loop)` : `${clip.name} (one-shot)`}
                      onClick={() => scene?.setClip(clip.name)}
                    >
                      {clip.label}
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>

          <div class="horde-viewer-section-label">
            {isLadybug() ? 'Ladybug motion' : isGoose() ? 'Goose motion' : isBird() ? 'Bird motion' : 'Procedural behavior'}
          </div>
          <div class="horde-viewer-gate-grid">
            <For each={behaviorButtons()}>
              {(b) => (
                <button
                  type="button"
                  class={`tb-btn horde-gate-btn ${behavior() === b.id && !snapshot()?.animationClips?.pinned ? 'active' : ''}`}
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

          <div class="horde-viewer-section-label">
            Studio lighting
            <Show when={snapshot()?.studioLighting}>
              <span class="dog-sim-clip-meta">
                {' · '}{snapshot()?.studioLighting?.pipeline ?? '—'}
                {snapshot()?.studioLighting?.probes?.status
                  ? ` · probes ${snapshot()?.studioLighting?.probes?.status}`
                  : ''}
              </span>
            </Show>
          </div>
          <div class="horde-viewer-gate-grid">
            <button
              type="button"
              class={`tb-btn horde-gate-btn ${snapshot()?.studioLighting?.settings?.ssgi ? 'active' : ''}`}
              onClick={() => scene?.setStudioLighting({ ssgi: !snapshot()?.studioLighting?.settings?.ssgi })}
            >
              SSGI+AO
            </button>
            <button
              type="button"
              class={`tb-btn horde-gate-btn ${snapshot()?.studioLighting?.settings?.ssr ? 'active' : ''}`}
              onClick={() => scene?.setStudioLighting({ ssr: !snapshot()?.studioLighting?.settings?.ssr })}
            >
              SSR
            </button>
            <button
              type="button"
              class={`tb-btn horde-gate-btn ${snapshot()?.studioLighting?.settings?.denoise ? 'active' : ''}`}
              onClick={() => scene?.setStudioLighting({ denoise: !snapshot()?.studioLighting?.settings?.denoise })}
            >
              Denoise
            </button>
            <button
              type="button"
              class={`tb-btn horde-gate-btn ${snapshot()?.studioLighting?.settings?.probes ? 'active' : ''}`}
              onClick={() => scene?.setStudioLighting(
                { probes: !snapshot()?.studioLighting?.settings?.probes },
                { rebakeProbes: true },
              )}
            >
              Probes
            </button>
            <button
              type="button"
              class={`tb-btn horde-gate-btn ${snapshot()?.studioLighting?.settings?.probeHelper ? 'active' : ''}`}
              onClick={() => scene?.setStudioLighting({
                probeHelper: !snapshot()?.studioLighting?.settings?.probeHelper,
              })}
            >
              Probe spheres
            </button>
            <button
              type="button"
              class="tb-btn"
              onClick={() => scene?.rebakeStudioProbes?.()}
            >
              Rebake probes
            </button>
          </div>
          <div class="dog-sim-lighting-sliders">
            <label>
              <span>Sun elev</span>
              <input
                type="range"
                min="5"
                max="85"
                step="1"
                value={snapshot()?.studioLighting?.settings?.sunElevation ?? 52}
                onInput={(e) => scene?.setStudioLighting({
                  sunElevation: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>Sun azim</span>
              <input
                type="range"
                min="-180"
                max="180"
                step="2"
                value={snapshot()?.studioLighting?.settings?.sunAzimuth ?? 42}
                onInput={(e) => scene?.setStudioLighting({
                  sunAzimuth: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>Sun</span>
              <input
                type="range"
                min="0"
                max="4"
                step="0.05"
                value={snapshot()?.studioLighting?.settings?.sunIntensity ?? 1.55}
                onInput={(e) => scene?.setStudioLighting({
                  sunIntensity: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>Hemi</span>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={snapshot()?.studioLighting?.settings?.hemiIntensity ?? 0.85}
                onInput={(e) => scene?.setStudioLighting({
                  hemiIntensity: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>GI</span>
              <input
                type="range"
                min="0"
                max="20"
                step="0.25"
                value={snapshot()?.studioLighting?.settings?.ssgiGiIntensity ?? 6}
                onInput={(e) => scene?.setStudioLighting({
                  ssgiGiIntensity: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>AO power</span>
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={snapshot()?.studioLighting?.settings?.ssgiAoIntensity ?? 0.85}
                onInput={(e) => scene?.setStudioLighting({
                  ssgiAoIntensity: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>AO blend</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={snapshot()?.studioLighting?.settings?.aoBlend ?? 0.42}
                onInput={(e) => scene?.setStudioLighting({
                  aoBlend: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>SSGI radius</span>
              <input
                type="range"
                min="0.4"
                max="6"
                step="0.1"
                value={snapshot()?.studioLighting?.settings?.ssgiRadius ?? 1.8}
                onInput={(e) => scene?.setStudioLighting({
                  ssgiRadius: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>SSR</span>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                value={snapshot()?.studioLighting?.settings?.ssrIntensity ?? 0.45}
                onInput={(e) => scene?.setStudioLighting({
                  ssrIntensity: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>Exposure</span>
              <input
                type="range"
                min="0.4"
                max="2.2"
                step="0.05"
                value={snapshot()?.studioLighting?.settings?.exposure ?? 1}
                onInput={(e) => scene?.setStudioLighting({
                  exposure: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>Floor rough</span>
              <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                value={snapshot()?.studioLighting?.settings?.floorRoughness ?? 0.55}
                onInput={(e) => scene?.setStudioLighting({
                  floorRoughness: Number(e.currentTarget.value),
                })}
              />
            </label>
            <label>
              <span>Floor metal</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={snapshot()?.studioLighting?.settings?.floorMetalness ?? 0.08}
                onInput={(e) => scene?.setStudioLighting({
                  floorMetalness: Number(e.currentTarget.value),
                })}
              />
            </label>
          </div>
          <div class="dog-sim-lighting-colors">
            <label>
              <span>Sky</span>
              <input
                type="color"
                value={`#${(snapshot()?.studioLighting?.settings?.skyColor ?? 0xc5cdc6).toString(16).padStart(6, '0')}`}
                onInput={(e) => scene?.setStudioLighting({
                  skyColor: parseInt(e.currentTarget.value.slice(1), 16),
                })}
              />
            </label>
            <label>
              <span>Floor</span>
              <input
                type="color"
                value={`#${(snapshot()?.studioLighting?.settings?.groundColor ?? 0xb0b8b2).toString(16).padStart(6, '0')}`}
                onInput={(e) => scene?.setStudioLighting({
                  groundColor: parseInt(e.currentTarget.value.slice(1), 16),
                })}
              />
            </label>
            <label>
              <span>Sun color</span>
              <input
                type="color"
                value={`#${(snapshot()?.studioLighting?.settings?.sunColor ?? 0xfff4e8).toString(16).padStart(6, '0')}`}
                onInput={(e) => scene?.setStudioLighting({
                  sunColor: parseInt(e.currentTarget.value.slice(1), 16),
                })}
              />
            </label>
            <label>
              <span>Hemi sky</span>
              <input
                type="color"
                value={`#${(snapshot()?.studioLighting?.settings?.hemiSky ?? 0xf2f4f0).toString(16).padStart(6, '0')}`}
                onInput={(e) => scene?.setStudioLighting({
                  hemiSky: parseInt(e.currentTarget.value.slice(1), 16),
                })}
              />
            </label>
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
