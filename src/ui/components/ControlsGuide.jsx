import { createSignal, onMount, onCleanup, Show } from 'solid-js';

const STORAGE_KEY = 'dreamfall:controls-dismissed';

const CONTROL_SECTIONS = [
  {
    title: 'Movement',
    items: [
      ['WASD / Arrows', 'Move'],
      ['Mouse', 'Look (click to lock pointer)'],
      ['Space', 'Jump (double-tap for air dash or glider)'],
      ['Q', 'Deploy / retract glider (wingsuit)'],
      ['Shift', 'Brace (wall-run, hang, climb, horse gallop)'],
      ['C', 'Slide'],
      ['Double-tap direction', 'Dodge'],
    ],
  },
  {
    title: 'Combat',
    intro: 'Sword swings automatically chop enemies (heavy + light finishers always cut). Unarmed specials require a nearby target.',
    items: [
      ['Z', 'Draw / sheathe great sword'],
      ['Left click', 'Light attack (combo) / unarmed punch or Shift+click Drop Kick'],
      ['Right click', 'Heavy attack (finisher) or unarmed Butterfly Twirl'],
      ['G (near enemy)', 'Grab & Slam'],
      ['R (near enemy)', 'Flying Shoulder Throw'],
    ],
  },
  {
    title: 'Chop (Precision Cut)',
    intro: 'Aim a manual cut plane on an enemy, then release V to perform a special slash that severs it into physics pieces.',
    items: [
      ['V (hold)', 'Slow-mo aim mode on nearest enemy (shows plane + slash guide)'],
      ['Mouse', 'Move the cut plane position'],
      ['A / D (left/right)', 'Rotate the cut angle (horizontal vs vertical slash)'],
      ['Left click', 'Queue another cut plane'],
      ['Release V', 'Execute aimed chop animation (cuts apply during swing)'],
      ['Esc', 'Cancel'],
    ],
  },
  {
    title: 'Abilities',
    items: [
      ['T', 'Telekinesis (hold to grab & orbit, release to throw)'],
      ['E or middle-click', 'Fire grappling hook (double-tap E to yank with 2 hooks)'],
      ['Space (while hooked)', 'Release hook'],
      ['F', 'Mount / dismount horse'],
    ],
  },
];

export function ControlsGuide(props) {
  // Internal visibility state when not controlled externally
  const [visible, setVisible] = createSignal(false);

  const isOpen = () => (props.open != null ? props.open : visible());
  const setOpen = (v) => {
    if (props.onOpenChange) {
      props.onOpenChange(v);
    } else {
      setVisible(v);
    }
  };

  const dismiss = (remember = true) => {
    if (remember) {
      try {
        localStorage.setItem(STORAGE_KEY, 'true');
      } catch {}
    }
    setOpen(false);
  };

  // On mount, decide whether to auto-show (only if not externally controlled)
  onMount(() => {
    if (props.open != null) return; // externally controlled

    try {
      const dismissed = localStorage.getItem(STORAGE_KEY) === 'true';
      if (!dismissed) {
        // Small delay so the scene can breathe on first load
        const t = setTimeout(() => setVisible(true), 650);
        onCleanup(() => clearTimeout(t));
      }
    } catch {
      // If localStorage blocked, still show once per session
      setVisible(true);
    }
  });

  // Listen for Escape to close the dialog (opening is handled at App level for ?)
  const onKey = (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      dismiss(false); // escape does not "remember" permanently if they just want to peek
    }
  };

  onMount(() => {
    globalThis.addEventListener('keydown', onKey);
  });
  onCleanup(() => {
    globalThis.removeEventListener('keydown', onKey);
  });

  return (
    <Show when={isOpen()}>
      <div
        class="controls-guide-overlay"
        onClick={(e) => {
          // Click on backdrop dismisses without permanent flag
          if (e.target === e.currentTarget) dismiss(false);
        }}
      >
        <div
          class="controls-guide"
          role="dialog"
          aria-modal="true"
          aria-label="Controls guide"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="controls-guide-header">
            <div>
              <span class="controls-guide-title">Controls</span>
              <span class="controls-guide-sub">First time playing? Here's what you need.</span>
            </div>
            <button
              class="controls-close"
              onClick={() => dismiss(true)}
              aria-label="Close controls guide"
            >
              ✕
            </button>
          </div>

          <div class="controls-guide-body">
            {CONTROL_SECTIONS.map((section) => (
              <div class="controls-section">
                <div class="controls-section-title">{section.title}</div>
                {section.intro && <div class="controls-intro">{section.intro}</div>}
                <div class="controls-list">
                  {section.items.map(([key, desc]) => (
                    <div class="controls-row">
                      <span class="controls-key">{key}</span>
                      <span class="controls-desc">{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div class="controls-guide-footer">
            <div class="controls-note">
              Click the world to lock your mouse for smooth look controls.
            </div>
            <button
              class="controls-gotit"
              onClick={() => dismiss(true)}
            >
              Got it
            </button>
          </div>

          <div class="controls-guide-hint">
            Press <span class="controls-key">?</span> anytime to see this again
          </div>
        </div>
      </div>
    </Show>
  );
}

// Small always-available trigger button you can place in the UI
export function ControlsHelpButton(props) {
  const [show, setShow] = createSignal(false);

  const open = () => setShow(true);
  const close = () => setShow(false);

  return (
    <>
      <button
        class="help-btn"
        onClick={open}
        title="Show controls (or press ?)"
        aria-label="Show controls guide"
      >
        ?
      </button>
      <ControlsGuide open={show()} onOpenChange={(v) => (v ? open() : close())} />
    </>
  );
}
