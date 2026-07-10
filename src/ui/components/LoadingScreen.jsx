import { createSignal, createEffect, onCleanup, onMount, Show } from 'solid-js';

const MIN_VISIBLE_MS = 400;

/**
 * Full-screen load / prewarm UI. Stays visible until `ready` and at least
 * MIN_VISIBLE_MS have elapsed (avoids flash on hot-cache boots).
 */
export function LoadingScreen(props) {
  const progress = () => {
    const value = typeof props.progress === 'function' ? props.progress() : props.progress;
    return value ?? {};
  };
  const ready = () => {
    if (typeof props.ready === 'function') return props.ready() === true;
    if (props.ready === true) return true;
    return progress().ready === true;
  };

  const [dismissed, setDismissed] = createSignal(false);
  let shownAt = 0;

  onMount(() => {
    shownAt = performance.now();
  });

  createEffect(() => {
    if (!ready() || dismissed()) return;
    const elapsed = performance.now() - (shownAt || performance.now());
    const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
    const timer = setTimeout(() => {
      setDismissed(true);
      props.onDismissed?.();
    }, wait);
    onCleanup(() => clearTimeout(timer));
  });

  const fraction = () => {
    const f = Number(progress().fraction);
    if (!Number.isFinite(f)) return 0;
    return Math.min(1, Math.max(0, f));
  };

  const label = () => {
    const text = progress().label;
    if (typeof text === 'string' && text.trim()) return text;
    return 'Loading…';
  };

  const percent = () => Math.round(fraction() * 100);

  return (
    <Show when={!dismissed()}>
      <div class="loading-screen" role="status" aria-live="polite" aria-busy={!ready()}>
        <div class="loading-screen__panel">
          <div class="loading-screen__wordmark">Dreamfall</div>
          <div class="loading-screen__label">{label()}</div>
          <div
            class="loading-screen__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent()}
            aria-label={label()}
          >
            <div
              class="loading-screen__bar-fill"
              style={{ width: `${percent()}%` }}
            />
          </div>
          <div class="loading-screen__percent">{percent()}%</div>
        </div>
      </div>
    </Show>
  );
}
