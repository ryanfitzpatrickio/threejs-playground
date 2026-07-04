import { createSignal, onMount, onCleanup, Show } from 'solid-js';

const STORAGE_KEY = 'dreamfall:controls-dismissed';

const CONTROL_SECTIONS = [
  {
    title: 'Driving',
    fullWidth: true,
    intro: 'Rally drops you in the car ready to go. On foot, walk up to a vehicle and press F. Tune builds in Garage from Settings.',
    items: [
      ['W / S', 'Accelerate / reverse'],
      ['A / D', 'Steer'],
      ['Space', 'Brake'],
      ['Shift', 'Handbrake / kick the tail out'],
      ['F', 'Enter / exit vehicle'],
      ['R (stuck)', 'Flip / recover onto the road'],
      ['Mouse', 'Look around (chase camera)'],
      ['Eye (Settings → Camera)', 'Driving camera: close · medium · far · cockpit'],
    ],
  },
  {
    title: 'On Foot',
    items: [
      ['WASD / Arrows', 'Move'],
      ['Mouse', 'Look (click the world to lock pointer)'],
      ['Space', 'Jump (double-tap for air dash or glider)'],
      ['Q', 'Deploy / retract glider'],
      ['Shift', 'Brace (wall-run, hang, climb, horse sprint)'],
      ['C', 'Slide'],
      ['Double-tap direction', 'Dodge'],
      ['F', 'Mount / dismount horse'],
    ],
  },
  {
    title: 'Combat',
    intro: 'The great sword auto-chops on contact. Heavy and light finishers always cut. Unarmed specials need a nearby target.',
    items: [
      ['Z', 'Draw / sheathe great sword'],
      ['Left click', 'Light attack / unarmed punch'],
      ['Shift + click', 'Drop kick (unarmed)'],
      ['Right click', 'Heavy attack / Butterfly Twirl (unarmed)'],
      ['G (near enemy)', 'Grab & slam'],
      ['R (near enemy)', 'Flying shoulder throw'],
    ],
  },
  {
    title: 'Chop (Precision Cut)',
    intro: 'Aim a cut plane on an enemy, then release to sever it into physics pieces.',
    items: [
      ['V (hold)', 'Slow-mo aim on nearest enemy'],
      ['Mouse', 'Move the cut plane'],
      ['A / D', 'Rotate cut angle'],
      ['Left click', 'Queue another cut plane'],
      ['Release V', 'Execute the chop'],
      ['Esc', 'Cancel'],
    ],
  },
  {
    title: 'Traversal & Powers',
    items: [
      ['T', 'Telekinesis (hold to grab, release to throw)'],
      ['Hold Alt', 'Show grapple target'],
      ['E / middle-click', 'Fire grappling hook'],
      ['Double-tap E', 'Dual-hook yank launch'],
      ['Space (hooked)', 'Release hook'],
    ],
  },
  {
    title: 'Modes & UI',
    items: [
      ['Settings (top right)', 'Scenes, graphics, camera comfort, photo mode, tools'],
      ['K', 'Photo mode (pause + free-fly camera)'],
      ['?', 'Open this guide'],
      ['Esc', 'Close menus / cancel aim'],
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
              <span class="controls-guide-sub">Rally starts in the car — here's everything else.</span>
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
              <div class={`controls-section${section.fullWidth ? ' controls-section--wide' : ''}`}>
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
              Click the world to lock the mouse. While driving, open Settings → Camera to change distance and comfort.
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
