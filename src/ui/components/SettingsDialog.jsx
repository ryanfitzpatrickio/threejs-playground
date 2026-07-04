import { createSignal, Show, For } from 'solid-js';
import { CAMERA_FEEL_ORDER, formatCameraFeel } from '../../game/config/cameraComfort.js';
import { GAME_CONFIG } from '../../game/config/gameConfig.js';

const TABS = [
  { id: 'scenes', label: 'Scenes' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'camera', label: 'Camera' },
  { id: 'tools', label: 'Tools' },
];

const VEHICLE_CAMERA_MODES = GAME_CONFIG.camera.vehicleCameraModeOrder;

function formatVehicleCameraMode(mode) {
  switch (mode) {
    case 'medium':
      return 'Medium chase';
    case 'far':
      return 'Far chase';
    case 'firstPerson':
      return 'First person';
    default:
      return 'Close chase';
  }
}

function SettingSection(props) {
  return (
    <section class="settings-section">
      <div class="settings-section__head">
        <h3>{props.title}</h3>
        <Show when={props.hint}>
          <p>{props.hint}</p>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

function readValue(value) {
  return typeof value === 'function' ? value() : value;
}

function ChipGroup(props) {
  return (
    <div class="settings-chip-group" role="group" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class="settings-chip"
            classList={{
              active: readValue(props.value) === option.id,
              disabled: option.disabled,
              'settings-chip--accent': option.accent,
            }}
            disabled={option.disabled}
            title={option.title}
            onClick={() => props.onChange(option.id)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function SettingsDialog(props) {
  const [tab, setTab] = createSignal('scenes');
  const snapshot = () => props.snapshot ?? null;
  const comfortEnabled = () => snapshot()?.camera?.comfortEnabled !== false;
  const driving = () => Boolean(snapshot()?.vehicles?.activeId);

  return (
    <Show when={props.open}>
      <div
        class="settings-dialog-overlay"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            props.onClose?.();
          }
        }}
      >
        <div
          class="settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={(event) => event.stopPropagation()}
        >
          <header class="settings-dialog__header">
            <div>
              <strong>Settings</strong>
              <span>Scene, graphics, camera, and tools</span>
            </div>
            <button
              type="button"
              class="settings-dialog__close"
              aria-label="Close settings"
              onClick={() => props.onClose?.()}
            >
              ✕
            </button>
          </header>

          <div class="settings-dialog__body">
            <nav class="settings-dialog__tabs" aria-label="Settings sections">
              <For each={TABS}>
                {(item) => (
                  <button
                    type="button"
                    class="settings-dialog__tab"
                    classList={{ active: tab() === item.id }}
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </nav>

            <div class="settings-dialog__panel">
              <Show when={tab() === 'scenes'}>
                <SettingSection
                  title="Playable scenes"
                  hint="Switching scenes reloads the active world."
                >
                  <ChipGroup
                    label="Scene"
                    value={props.levelMode}
                    onChange={props.onLevelModeChange}
                    options={[
                      { id: 'city', label: 'City', title: 'Infinite generated city' },
                      { id: 'world', label: 'World', title: 'Streaming editable terrain' },
                      { id: 'rally', label: 'Rally', title: 'Pine Ridge dirt stage', accent: true },
                      { id: 'wilds', label: 'Wilds', title: 'Eroded alpine valley' },
                    ]}
                  />
                </SettingSection>

                <SettingSection
                  title="Garage"
                  hint="Build and save vehicle configurations."
                >
                  <ChipGroup
                    label="Garage"
                    value={props.viewMode === 'garage' ? 'garage' : ''}
                    onChange={() => props.onOpenGarage?.()}
                    options={[
                      { id: 'garage', label: 'Open Garage', title: 'Vehicle builder' },
                    ]}
                  />
                </SettingSection>

                <Show when={props.devModeButtons}>
                  <SettingSection title="Editor modes" hint="Developer tooling views.">
                    <div class="settings-dev-modes">{props.devModeButtons}</div>
                  </SettingSection>
                </Show>
              </Show>

              <Show when={tab() === 'graphics'}>
                <SettingSection
                  title="Quality preset"
                  hint="Reloads the page to apply draw distance, shadows, and post-processing limits."
                >
                  <ChipGroup
                    label="Quality"
                    value={props.quality}
                    onChange={props.onQualityChange}
                    options={[
                      { id: 'ultra', label: 'Ultra', title: 'Maximum quality' },
                      { id: 'high', label: 'Medium', title: 'Balanced quality and performance' },
                      { id: 'low', label: 'Low', title: 'Capped pixel ratio, smaller city loading' },
                    ]}
                  />
                </SettingSection>

                <SettingSection
                  title="Tone mapping"
                  hint="Reloads the page. Affects highlight rolloff and color response."
                >
                  <ChipGroup
                    label="Tone mapping"
                    value={props.toneMapping}
                    onChange={props.onToneMappingChange}
                    options={[
                      { id: 'ACESFilmic', label: 'ACES', title: 'Warmer cinematic highlight rolloff' },
                      { id: 'AgX', label: 'AgX', title: 'More neutral color and highlight handling' },
                    ]}
                  />
                </SettingSection>

                <SettingSection
                  title="Screen-space effects"
                  hint="Reloads the page. Low quality forces Off regardless of this choice."
                >
                  <ChipGroup
                    label="Post effects"
                    value={props.postEffect}
                    onChange={props.onPostEffectChange}
                    options={[
                      { id: 'ssao', label: 'SSAO', title: 'Ambient occlusion in crevices' },
                      { id: 'ssr', label: 'SSR', title: 'Screen-space reflections' },
                      { id: 'off', label: 'Off', title: 'No screen-space lighting effects' },
                    ]}
                  />
                </SettingSection>
              </Show>

              <Show when={tab() === 'camera'}>
                <SettingSection
                  title="Driving camera"
                  hint={driving()
                    ? 'Applies immediately while you are in a vehicle.'
                    : 'Enter a vehicle for live preview. Selection is remembered for your next drive.'}
                >
                  <ChipGroup
                    label="Driving camera mode"
                    value={snapshot()?.camera?.vehicleCameraMode ?? 'close'}
                    onChange={(mode) => props.onVehicleCameraModeChange?.(mode)}
                    options={VEHICLE_CAMERA_MODES.map((mode) => ({
                      id: mode,
                      label: formatVehicleCameraMode(mode).replace(' chase', ''),
                      title: formatVehicleCameraMode(mode),
                    }))}
                  />
                </SettingSection>

                <SettingSection
                  title="Motion comfort"
                  hint="Comfort reduces steer-coupled sway, FOV pump, and cockpit head-toss. Disable for the classic dramatic camera."
                >
                  <ChipGroup
                    label="Camera comfort"
                    value={comfortEnabled() ? 'on' : 'off'}
                    onChange={(value) => props.onComfortChange?.(value === 'on')}
                    options={[
                      { id: 'on', label: 'Comfort on', title: 'Reduced motion-sickness triggers' },
                      { id: 'off', label: 'Comfort off', title: 'Restore cinematic camera behavior' },
                    ]}
                  />
                </SettingSection>

                <SettingSection
                  title="Camera feel"
                  hint="Only applies while comfort is on. Cinematic restores the old dramatic chase and cockpit."
                >
                  <ChipGroup
                    label="Camera feel"
                    value={snapshot()?.camera?.cameraFeel ?? 'comfort'}
                    onChange={(feel) => props.onCameraFeelChange?.(feel)}
                    options={CAMERA_FEEL_ORDER.map((feel) => ({
                      id: feel,
                      label: formatCameraFeel(feel),
                      title: `Camera feel: ${formatCameraFeel(feel)}`,
                      disabled: !comfortEnabled(),
                    }))}
                  />
                </SettingSection>

                <SettingSection
                  title="Photo mode"
                  hint="Pause gameplay and fly a free camera. Shortcut: K"
                >
                  <ChipGroup
                    label="Photo mode"
                    value={snapshot()?.camera?.photoMode ? 'on' : 'off'}
                    onChange={(value) => props.onPhotoModeChange?.(value === 'on')}
                    options={[
                      { id: 'off', label: 'Play', title: 'Return to gameplay camera' },
                      { id: 'on', label: 'Photo mode', title: 'Free-fly debug camera' },
                    ]}
                  />
                </SettingSection>
              </Show>

              <Show when={tab() === 'tools'}>
                <SettingSection
                  title="Cloth collider editor"
                  hint="Live-edit player jacket collider spheres. Requires jacket experiments."
                >
                  <ChipGroup
                    label="Cloth editor"
                    value={props.clothEditorOpen ? 'on' : 'off'}
                    onChange={(value) => props.onClothEditorChange?.(value === 'on')}
                    options={[
                      { id: 'off', label: 'Closed', title: 'Hide cloth editor' },
                      {
                        id: 'on',
                        label: 'Open editor',
                        title: 'Edit cloth colliders',
                        disabled: !props.clothEditorEnabled,
                      },
                    ]}
                  />
                </SettingSection>

                <SettingSection
                  title="Debug panel"
                  hint="Render and lighting diagnostics. Shortcut: P"
                >
                  <ChipGroup
                    label="Debug panel"
                    value={props.debugPanelOpen ? 'on' : 'off'}
                    onChange={(value) => props.onDebugPanelChange?.(value === 'on')}
                    options={[
                      { id: 'off', label: 'Hidden', title: 'Hide debug panel' },
                      { id: 'on', label: 'Visible', title: 'Show debug panel overlay' },
                    ]}
                  />
                </SettingSection>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
