import { createMemo, createSignal, For } from 'solid-js';
import { DOG_FAMILIES, getAuthoredDogBreeds } from '../../game/characters/dog/dogCatalog.js';

const CONFIG_EVENT = 'dreamfall:dog-park-config';

/** Face / mouth expressions — same ids as studio (`dogAnimation` mouth states). */
const FACE_STATES = [
  { id: 'closed', label: 'Neutral' },
  { id: 'open', label: 'Tongue wagging' },
  { id: 'alert', label: 'Alert (ears twinged)' },
];

function normalizeFaceState(value) {
  if (value === 'open' || value === 'alert' || value === 'closed') return value;
  return 'closed';
}

export function DogParkHud(props) {
  const initial = props.snapshot ?? {};
  const [familyId, setFamilyId] = createSignal(initial.familyId ?? 'retriever-sporting');
  const [breedId, setBreedId] = createSignal(initial.breedId ?? 'golden-retriever');
  const [seed, setSeed] = createSignal(initial.seed ?? 1);
  const [shellCount, setShellCount] = createSignal(initial.shellCount ?? 18);
  const [faceState, setFaceState] = createSignal(normalizeFaceState(initial.mouthState ?? initial.faceState));
  const [naked, setNaked] = createSignal(Boolean(initial.naked));
  const breeds = createMemo(() => getAuthoredDogBreeds(familyId()));

  const publish = (detail) => globalThis.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail }));

  const chooseFamily = (id) => {
    setFamilyId(id);
    const nextBreed = getAuthoredDogBreeds(id)[0]?.id ?? 'golden-retriever';
    setBreedId(nextBreed);
    publish({ breedId: nextBreed });
  };

  return (
    <aside class="dog-park-hud" aria-label="Dog park controls">
      <div class="dog-park-hud__title">Dog Park</div>
      <div class="dog-sim-generator-grid">
        <label>
          Family
          <select value={familyId()} onChange={(event) => chooseFamily(event.currentTarget.value)}>
            <For each={DOG_FAMILIES}>{(family) => <option value={family.id}>{family.label}</option>}</For>
          </select>
        </label>
        <label>
          Breed
          <select
            value={breedId()}
            onChange={(event) => {
              setBreedId(event.currentTarget.value);
              publish({ breedId: event.currentTarget.value });
            }}
          >
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
            <option value="8">8</option>
            <option value="12">12</option>
            <option value="18">18</option>
            <option value="24">24</option>
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
      </div>
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
        <button type="button" onClick={() => props.onStudio?.()}>Studio</button>
      </div>
      <p class="dog-park-hud__hint">WASD move · Shift trot · C sit · V look · Z flop · mud splash · K camera mode · LMB orbit · RMB free look · scroll zoom · R behind</p>
    </aside>
  );
}
