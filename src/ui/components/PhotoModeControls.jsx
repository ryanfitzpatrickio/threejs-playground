import { For } from 'solid-js';

const CONTROLS = [
  { key: 'fov', label: 'Zoom / FOV', min: 15, max: 100, step: 1, unit: '°' },
  { key: 'aperture', label: 'Aperture', min: 1.2, max: 22, step: 0.1, unit: ' f' },
  { key: 'focusDistance', label: 'Focus', min: 0.5, max: 250, step: 0.5, unit: ' m' },
  { key: 'speed', label: 'Fly speed', min: 1, max: 60, step: 1, unit: ' m/s' },
];

export function PhotoModeControls(props) {
  const camera = () => props.snapshot?.camera;
  const settings = () => camera()?.photoSettings ?? {};
  const live = () => Boolean(camera()?.photoModeLive);

  return (
    <aside class="photo-mode" aria-label="Camera mode controls">
      <div class="photo-mode__header">
        <div>
          <strong>CAMERA MODE</strong>
          <span>{live() ? 'Physics live · player locked' : 'Game paused'} · K to exit</span>
        </div>
        <button onClick={() => props.onToggle(false)}>Exit</button>
      </div>
      <p>Click the view for mouse look · WASD move · Space up · Shift down · Esc releases mouse</p>
      <label class="photo-mode__check">
        <input
          type="checkbox"
          checked={live()}
          onChange={(event) => props.onLiveChange?.(event.currentTarget.checked)}
        />
        <span>Run live</span>
        <small>Physics + IK keep running; player move/turn locked</small>
      </label>
      <For each={CONTROLS}>{(control) => (
        <label>
          <span>{control.label}</span>
          <output>{settings()[control.key]}{control.unit}</output>
          <input
            type="range"
            min={control.min}
            max={control.max}
            step={control.step}
            value={settings()[control.key]}
            onInput={(event) => props.onSetting(control.key, event.currentTarget.value)}
          />
        </label>
      )}</For>
      <button class="photo-mode__hud" onClick={props.onToggleHud}>
        {props.hudVisible ? 'Hide HUD' : 'Show HUD'}
      </button>
    </aside>
  );
}
