import { createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import {
  ANIMAL_SPECIES,
  getDogBreeds,
  getFamiliesForSpecies,
  getPopulatedFamiliesForSpecies,
  getSpeciesIdForFamily,
  isSpeciesPopulated,
} from '../../game/characters/dog/dogCatalog.js';

const CONFIG_EVENT = 'dreamfall:dog-park-config';

/** Face / mouth expressions — same ids as studio (`dogAnimation` mouth states). */
const FACE_STATES = [
  { id: 'closed', label: 'Neutral' },
  { id: 'open', label: 'Tongue wagging' },
  { id: 'alert', label: 'Alert (ears twinged)' },
];

/** Park chase-camera focus (mirrors DogParkRuntimeFeature.normalizeCameraMode). */
const CAMERA_MODES = [
  { id: 'player', label: 'Your dog' },
  { id: 'squirrel-chase', label: 'Squirrel chase' },
  { id: 'cinematic', label: 'Cinematic tour' },
];

function normalizeFaceState(value) {
  if (value === 'open' || value === 'alert' || value === 'closed') return value;
  return 'closed';
}

function normalizeCameraMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'cinematic' || raw === 'tour' || raw === 'cinema') {
    return 'cinematic';
  }
  if (
    raw === 'squirrel-chase'
    || raw === 'squirrel'
    || raw === 'chase'
  ) {
    return 'squirrel-chase';
  }
  return 'player';
}

/**
 * Dog park animal customization popup.
 *
 * @param {{
 *   snapshot?: object,
 *   open?: boolean,
 *   onOpenChange?: (open: boolean) => void,
 *   onStudio?: () => void,
 * }} props
 */
export function DogParkHud(props) {
  const controlled = () => typeof props.open === 'boolean';
  const [internalOpen, setInternalOpen] = createSignal(false);
  const open = () => (controlled() ? Boolean(props.open) : internalOpen());
  const setOpen = (next) => {
    if (!controlled()) setInternalOpen(next);
    props.onOpenChange?.(next);
  };

  const initial = props.snapshot ?? {};
  const [speciesId, setSpeciesId] = createSignal(
    initial.speciesId
      ?? getSpeciesIdForFamily(initial.familyId)
      ?? 'canidae',
  );
  const [familyId, setFamilyId] = createSignal(initial.familyId ?? 'retriever-sporting');
  const [breedId, setBreedId] = createSignal(initial.breedId ?? 'golden-retriever');
  const [seed, setSeed] = createSignal(initial.seed ?? 1);
  const [shellCount, setShellCount] = createSignal(initial.shellCount ?? 18);
  const [faceState, setFaceState] = createSignal(normalizeFaceState(initial.mouthState ?? initial.faceState));
  const [cameraMode, setCameraMode] = createSignal(
    normalizeCameraMode(initial.cameraMode ?? initial.camera?.mode),
  );
  const [naked, setNaked] = createSignal(Boolean(initial.naked));
  const speciesFamilies = createMemo(() => getFamiliesForSpecies(speciesId()));
  const breeds = createMemo(() => getDogBreeds(familyId()));
  /** Live mode from runtime snapshot, falling back to the local control. */
  const activeCameraMode = createMemo(() => normalizeCameraMode(
    props.snapshot?.cameraMode
      ?? props.snapshot?.camera?.mode
      ?? cameraMode(),
  ));

  const publish = (detail) => globalThis.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail }));

  const chooseSpecies = (id) => {
    setSpeciesId(id);
    const populated = getPopulatedFamiliesForSpecies(id);
    const nextFamily = populated[0]?.id ?? getFamiliesForSpecies(id)[0]?.id ?? '';
    setFamilyId(nextFamily);
    const nextBreed = nextFamily
      ? (getDogBreeds(nextFamily)[0]?.id ?? '')
      : '';
    setBreedId(nextBreed);
    if (nextBreed) publish({ breedId: nextBreed });
  };

  const chooseFamily = (id) => {
    setFamilyId(id);
    setSpeciesId(getSpeciesIdForFamily(id) ?? speciesId());
    const nextBreed = getDogBreeds(id)[0]?.id ?? '';
    setBreedId(nextBreed);
    if (nextBreed) publish({ breedId: nextBreed });
  };

  // Escape closes when open (and not handled higher up).
  const onKey = (event) => {
    if (event.key === 'Escape' && open()) {
      event.stopPropagation();
      setOpen(false);
    }
  };
  globalThis.addEventListener?.('keydown', onKey);
  onCleanup(() => globalThis.removeEventListener?.('keydown', onKey));

  return (
    <>
      {/* Compact always-visible control reminder (no big panel). */}
      <div class="dog-park-hint" aria-hidden="true">
        {activeCameraMode() === 'cinematic'
          ? (
            props.snapshot?.camera?.cinematic?.shotLabel
              ? `Cinematic · ${props.snapshot.camera.cinematic.shotLabel}`
              : 'Cinematic tour · rotating park cameras'
          )
          : activeCameraMode() === 'squirrel-chase'
            ? 'Squirrel cam · LMB orbit · RMB free look · scroll zoom · R behind'
            : (props.snapshot?.isGoose || props.snapshot?.isBird)
              ? 'Bird · WASD · Space takeoff/flap · C dive · Shift sprint · land on ground · K camera'
              : 'WASD · Shift trot · C sit · V look · Z flop · K camera'}
      </div>

      <Show when={open()}>
        <div
          class="dog-park-hud-overlay"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <aside
            class="dog-park-hud dog-park-hud--popup"
            role="dialog"
            aria-modal="true"
            aria-label="Customize dog"
          >
            <header class="dog-park-hud__header">
              <div>
                <div class="dog-park-hud__title">Customize</div>
                <p class="dog-park-hud__subtitle">Species, breed, fur, face, and camera</p>
              </div>
              <button
                type="button"
                class="dog-park-hud__close"
                aria-label="Close customize menu"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>

            <div class="dog-sim-generator-grid dog-sim-generator-grid--species">
              <label class="dog-sim-generator-grid__species">
                Species
                <select value={speciesId()} onChange={(event) => chooseSpecies(event.currentTarget.value)}>
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
                Family
                <select
                  value={familyId()}
                  disabled={!speciesFamilies().length}
                  onChange={(event) => chooseFamily(event.currentTarget.value)}
                >
                  <Show when={!speciesFamilies().length}>
                    <option value="">— none yet —</option>
                  </Show>
                  <For each={speciesFamilies()}>{(family) => <option value={family.id}>{family.label}</option>}</For>
                </select>
              </label>
              <label>
                Breed
                <select
                  value={breedId()}
                  disabled={!breeds().length}
                  onChange={(event) => {
                    setBreedId(event.currentTarget.value);
                    publish({ breedId: event.currentTarget.value });
                  }}
                >
                  <Show when={!breeds().length}>
                    <option value="">— none yet —</option>
                  </Show>
                  <For each={breeds()}>{(breed) => <option value={breed.id}>{breed.label}</option>}</For>
                </select>
              </label>
            </div>

            <div class="dog-park-hud__row">
              <label>
                Seed
                <input
                  type="number"
                  min="1"
                  max="999999"
                  value={seed()}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value) || 1;
                    setSeed(value);
                    publish({ seed: value });
                  }}
                />
              </label>
              <label>
                Fur shells
                <select
                  value={shellCount()}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    setShellCount(value);
                    publish({ shellCount: value });
                  }}
                >
                  <option value="6">6</option>
                  <option value="8">8</option>
                  <option value="12">12</option>
                  <option value="18">18</option>
                </select>
              </label>
            </div>

            <div class="dog-park-hud__row dog-park-hud__row--face">
              <label>
                Face
                <select
                  value={faceState()}
                  onChange={(event) => {
                    const value = normalizeFaceState(event.currentTarget.value);
                    setFaceState(value);
                    publish({ mouthState: value });
                  }}
                >
                  <For each={FACE_STATES}>{(face) => <option value={face.id}>{face.label}</option>}</For>
                </select>
              </label>
              <label>
                Camera
                <select
                  value={cameraMode()}
                  onChange={(event) => {
                    const value = normalizeCameraMode(event.currentTarget.value);
                    setCameraMode(value);
                    publish({ cameraMode: value });
                  }}
                >
                  <For each={CAMERA_MODES}>{(mode) => <option value={mode.id}>{mode.label}</option>}</For>
                </select>
              </label>
            </div>

            <Show when={cameraMode() === 'squirrel-chase'}>
              <p class="dog-park-hud__hint dog-park-hud__hint--cinematic">
                Orbit the grey squirrel while the golden chases.
                LMB orbit · RMB free look · scroll zoom · R behind · your dog waits.
              </p>
            </Show>
            <Show when={cameraMode() === 'cinematic'}>
              <p class="dog-park-hud__hint dog-park-hud__hint--cinematic">
                Auto tour: geese V → squirrel drive-by → canopy pigeons → lake → cat fight.
                Your dog waits; freecam (K) still works.
              </p>
            </Show>

            <div class="dog-park-hud__actions">
              <button
                type="button"
                onClick={() => {
                  setNaked(!naked());
                  publish({ naked: naked() });
                }}
              >
                {naked() ? 'Show fur' : 'Naked mesh'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  props.onStudio?.();
                }}
              >
                Studio
              </button>
            </div>

            <p class="dog-park-hud__hint">
              WASD move · Shift trot · C sit · V look · Z flop · mud splash · K freecam · LMB orbit · RMB free look · scroll zoom · R behind
              · Customize → Camera for squirrel chase or cinematic tour
            </p>
          </aside>
        </div>
      </Show>
    </>
  );
}

/** Sliders icon — “change / customize” next to Settings. */
export function DogCustomizeIcon(props) {
  const size = props.size ?? 14;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 6h2.18a3 3 0 0 0 5.64 0H20a1 1 0 1 0 0-2h-8.18a3 3 0 0 0-5.64 0H4a1 1 0 0 0 0 2zm5-1a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm5 7a3 3 0 0 0-2.82 2H4a1 1 0 1 0 0 2h7.18a3 3 0 0 0 5.64 0H20a1 1 0 1 0 0-2h-3.18A3 3 0 0 0 14 12zm0 1a1 1 0 1 1 0 2 1 1 0 0 1 0-2zM4 20h2.18a3 3 0 0 0 5.64 0H20a1 1 0 1 0 0-2h-8.18a3 3 0 0 0-5.64 0H4a1 1 0 1 0 0 2zm5-1a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"
      />
    </svg>
  );
}
