/**
 * Mobile / coarse-pointer on-screen controls via nipple.js.
 * Left: dynamic move stick → InputSystem.setVirtualMove
 * Right: action buttons → InputSystem.setVirtualAction
 *
 * Force-show on desktop: ?touch=1 or localStorage dreamfall:touch=1
 */
import { createEffect, createSignal, onCleanup, onMount, Show, For } from 'solid-js';
import nipplejs from 'nipplejs';

const FORCE_TOUCH_KEY = 'dreamfall:touch';

function wantsTouchControls() {
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    if (params.get('touch') === '1' || params.get('touch') === 'true') return true;
    if (params.get('touch') === '0' || params.get('touch') === 'false') return false;
    if (globalThis.localStorage?.getItem(FORCE_TOUCH_KEY) === '1') return true;
  } catch {
    /* ignore */
  }
  const coarse = globalThis.matchMedia?.('(pointer: coarse)')?.matches;
  const noHover = globalThis.matchMedia?.('(hover: none)')?.matches;
  const touchPoints = (globalThis.navigator?.maxTouchPoints ?? 0) > 0;
  return Boolean(coarse || (noHover && touchPoints));
}

/**
 * nipple vector: +x right, +y down (screen). Game: +x right, +z back, −z forward.
 * So moveX = vector.x, moveZ = vector.y (down = back = S).
 */
function stickToMove(data) {
  const vx = data?.vector?.x ?? 0;
  const vy = data?.vector?.y ?? 0;
  const force = Math.min(1, Number(data?.force) || Math.hypot(vx, vy) || 0);
  return { x: vx, z: vy, force };
}

const ACTION_BUTTONS = Object.freeze([
  { action: 'jump', label: 'Jump', title: 'Jump (Space)' },
  { action: 'drawSheathe', label: 'Flop', title: 'Flop / holster (Z)' },
  { action: 'mount', label: 'Use', title: 'Interact (E)' },
  { action: 'brace', label: 'Sprint', title: 'Sprint hold (Shift)' },
]);

/**
 * @param {{
 *   getInputSystem?: () => (object | null | undefined),
 *   enabled?: boolean,
 * }} props
 */
export function VirtualTouchControls(props) {
  const [deviceWants, setDeviceWants] = createSignal(wantsTouchControls());
  let zoneEl = null;
  /** @type {import('nipplejs').JoystickManager | null} */
  let manager = null;

  const visible = () => deviceWants() && props.enabled !== false;
  const input = () => props.getInputSystem?.() ?? null;

  const destroyManager = () => {
    if (!manager) return;
    try {
      manager.destroy();
    } catch {
      /* ignore */
    }
    manager = null;
    input()?.clearVirtualMove?.();
  };

  const bindZone = (el) => {
    zoneEl = el;
  };

  // Create / tear down nipple when the zone is shown and has a DOM node.
  createEffect(() => {
    if (!visible()) {
      destroyManager();
      return;
    }
    // Wait a tick so ref is attached after Show mounts the zone.
    const id = requestAnimationFrame(() => {
      if (!zoneEl || manager) return;
      manager = nipplejs.create({
        zone: zoneEl,
        mode: 'dynamic',
        color: 'rgba(247, 244, 232, 0.92)',
        size: 120,
        threshold: 0.12,
        fadeTime: 120,
        multitouch: false,
        maxNumberOfJoysticks: 1,
        restOpacity: 0.45,
      });
      manager.on('move', (_evt, data) => {
        const sys = input();
        if (!sys?.setVirtualMove) return;
        const { x, z, force } = stickToMove(data);
        sys.setVirtualMove(x, z, force);
      });
      manager.on('end', () => {
        input()?.clearVirtualMove?.();
      });
    });
    onCleanup(() => {
      cancelAnimationFrame(id);
      destroyManager();
    });
  });

  onMount(() => {
    const mq = globalThis.matchMedia?.('(pointer: coarse)');
    const sync = () => setDeviceWants(wantsTouchControls());
    mq?.addEventListener?.('change', sync);
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        input()?.clearVirtualMove?.();
        input()?.clearVirtualActions?.();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    onCleanup(() => {
      mq?.removeEventListener?.('change', sync);
      document.removeEventListener('visibilitychange', onVis);
      destroyManager();
      input()?.clearVirtualActions?.();
    });
  });

  const bindAction = (action) => ({
    onPointerDown: (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      input()?.setVirtualAction?.(action, true);
    },
    onPointerUp: (e) => {
      e.preventDefault();
      input()?.setVirtualAction?.(action, false);
    },
    onPointerCancel: () => {
      input()?.setVirtualAction?.(action, false);
    },
    onLostPointerCapture: () => {
      input()?.setVirtualAction?.(action, false);
    },
    onContextMenu: (e) => e.preventDefault(),
  });

  return (
    <Show when={visible()}>
      <div class="virtual-touch" aria-label="Touch controls">
        <div class="virtual-touch__stick-zone" ref={bindZone} />
        <div class="virtual-touch__actions">
          <For each={ACTION_BUTTONS}>
            {(btn) => (
              <button
                type="button"
                class="virtual-touch__btn"
                data-action={btn.action}
                title={btn.title}
                aria-label={btn.title}
                {...bindAction(btn.action)}
              >
                {btn.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
