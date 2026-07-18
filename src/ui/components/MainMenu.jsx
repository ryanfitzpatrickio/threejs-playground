import { For, Show, onMount, onCleanup } from 'solid-js';

const EXPERIENCES = [
  {
    id: 'city',
    label: 'City',
    blurb: 'Infinite generated city — rooftops, streets, and freerun.',
  },
  {
    id: 'world',
    label: 'World',
    blurb: 'Streaming terrain from the world map editor.',
  },
  {
    id: 'rally',
    label: 'Rally',
    blurb: 'Pine Ridge dirt stage — drive the wet loop.',
    accent: true,
  },
  {
    id: 'wilds',
    label: 'Wilds',
    blurb: 'Eroded alpine valley and dense forest.',
  },
  {
    id: 'range',
    label: 'Shooting Range',
    blurb: '60s warehouse breach — hit hostiles, spare friendlies.',
    accent: true,
  },
  {
    id: 'horde',
    label: 'Horde',
    blurb: 'Robot wave arena — sword cuts and firearms.',
    accent: true,
  },
  {
    id: 'sims',
    label: 'Household',
    blurb: 'A residential lot with selectable Sims and point-and-click play.',
    accent: true,
  },
  {
    id: 'dog',
    label: 'Dog',
    blurb: 'Run a procedural dog through a sunny lakeside park.',
    accent: true,
  },
  {
    id: 'deathmatch',
    label: 'Deathmatch',
    blurb: 'Rail Crucible arena — solo route preview (multiplayer WIP).',
    accent: true,
  },
];

/**
 * Experience tiles + optional Continue for last-played.
 */
export function MainMenu(props) {
  const preferred = () => props.preferredLevel ?? 'rally';
  const lastLevel = () => props.lastLevel ?? preferred();

  let rootEl;
  /** @type {HTMLButtonElement[]} */
  let cardButtons = [];

  const select = (id) => {
    props.onSelectExperience?.(id);
  };

  const onKeyDown = (e) => {
    if (!rootEl?.contains(document.activeElement) && document.activeElement !== document.body) {
      // Allow when focus is inside menu; also handle when nothing focused yet.
    }
    const order = EXPERIENCES.map((x) => x.id);
    const activeId = document.activeElement?.getAttribute?.('data-experience-id');
    let idx = order.indexOf(activeId);
    if (idx < 0) idx = order.indexOf(preferred());

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      idx = (idx + 1) % order.length;
      cardButtons[idx]?.focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx - 1 + order.length) % order.length;
      cardButtons[idx]?.focus();
    } else if (e.key === 'Enter' && activeId && order.includes(activeId)) {
      e.preventDefault();
      select(activeId);
    } else if (e.key === 'c' || e.key === 'C') {
      if (props.onContinue) {
        e.preventDefault();
        props.onContinue();
      }
    } else if (e.key >= '1' && e.key <= String(order.length)) {
      e.preventDefault();
      select(order[Number(e.key) - 1]);
    }
  };

  onMount(() => {
    globalThis.addEventListener('keydown', onKeyDown);
    // Focus preferred (or first) card for keyboard UX.
    const preferIdx = Math.max(0, EXPERIENCES.findIndex((x) => x.id === preferred()));
    queueMicrotask(() => cardButtons[preferIdx]?.focus());
    onCleanup(() => globalThis.removeEventListener('keydown', onKeyDown));
  });

  return (
    <div class="main-menu" data-testid="main-menu" ref={rootEl}>
      <div class="main-menu__inner">
        <header class="main-menu__header">
          <div class="main-menu__wordmark">Dreamfall</div>
          <p class="main-menu__tagline">Choose an experience</p>
        </header>

        <Show when={props.onContinue && lastLevel()}>
          <button
            type="button"
            class="main-menu__continue"
            data-testid="continue-experience"
            onClick={() => props.onContinue?.()}
          >
            Continue — {labelFor(lastLevel())}
          </button>
        </Show>

        <div class="main-menu__grid" role="group" aria-label="Experiences">
          <For each={EXPERIENCES}>
            {(exp, i) => (
              <button
                type="button"
                class="main-menu__card"
                classList={{
                  'main-menu__card--accent': exp.accent,
                  'main-menu__card--preferred': exp.id === preferred(),
                }}
                data-testid={`experience-${exp.id}`}
                data-experience-id={exp.id}
                ref={(el) => {
                  cardButtons[i()] = el;
                }}
                onClick={() => select(exp.id)}
              >
                <span class="main-menu__card-label">{exp.label}</span>
                <span class="main-menu__card-blurb">{exp.blurb}</span>
              </button>
            )}
          </For>
        </div>

        <p class="main-menu__hint">
          Settings for graphics, garage, and editors · keys 1–{EXPERIENCES.length} select · C continue
        </p>
      </div>
    </div>
  );
}

function labelFor(id) {
  if (id === 'dog-park') return 'Dog Park';
  return EXPERIENCES.find((x) => x.id === id)?.label ?? id;
}
