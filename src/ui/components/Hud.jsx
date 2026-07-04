import { Show } from 'solid-js';
import { GROUND_VEHICLE_MAX_SPEED_MS } from '../../game/config/vehicleConfig.js';

const EMPTY_SNAPSHOT = {
  stage: 'booting',
  level: {
    name: 'Base Level',
    status: 'loading',
  },
  animation: {
    state: 'loading',
    status: 'waiting',
  },
  character: {
    stamina: 1,
    health: 1,
    maxHealth: 1,
    sway: 0,
  },
};

export function Hud(props) {
  const snapshot = () => props.snapshot ?? EMPTY_SNAPSHOT;
  const staminaPercent = () => `${Math.round((snapshot().character?.stamina ?? 1) * 100)}%`;
  const healthPercent = () => {
    const c = snapshot().character ?? {};
    const ratio = (c.health ?? 1) / (c.maxHealth ?? 1);
    return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  };
  const swayDegrees = () => `${(snapshot().character?.sway ?? 0) * 12}deg`;

  const combat = () => snapshot().combat;
  const combatLabel = () => {
    const c = combat();
    if (!c?.active) return null;
    const mode = c.armed ? 'SWORD' : 'UNARMED';
    let act = '';
    if (c.animationOverride) {
      const raw = c.animationOverride;
      // Short human friendly labels for the common ones
      if (raw === 'unarmedLight') act = 'LIGHT';
      else if (raw === 'butterflyTwirl') act = 'TWIRL';
      else if (raw.startsWith('lightSlash')) act = 'SLASH';
      else if (raw === 'heavyAttack') act = 'HEAVY';
      else if (raw === 'dropKick') act = 'KICK';
      else act = formatState(raw).slice(0, 8).toUpperCase();
    } else if (c.attack?.kind) {
      act = c.attack.kind.toUpperCase();
    }
    return act ? `${mode} · ${act}` : mode;
  };

  const drivingVehicle = () => {
    const vs = snapshot().vehicles;
    if (!vs?.activeId) return null;
    return vs.vehicles?.find((v) => v.id === vs.activeId) ?? null;
  };

  const speedMph = () => {
    const veh = drivingVehicle();
    if (!veh) return 0;
    const ms = veh.groundSpeed ?? veh.speed ?? 0;
    return Math.round(ms * 2.236936);
  };

  const speedRatio = () => {
    const veh = drivingVehicle();
    if (!veh) return 0;
    const ms = veh.groundSpeed ?? veh.speed ?? 0;
    return Math.max(0, Math.min(1, ms / GROUND_VEHICLE_MAX_SPEED_MS));
  };

  return (
    <section class="hud" aria-live="polite">
      <Show when={snapshot().buildingEntry?.prompt}>
        <div
          class="hud__enter-prompt"
          role="status"
          style="position: absolute; left: 50%; bottom: 24%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: rgb(22 21 18 / 82%); border: 1px solid rgb(247 244 232 / 22%); border-radius: 999px; color: rgb(247 244 232 / 95%); font-size: 14px; letter-spacing: 0.02em; box-shadow: 0 8px 24px rgb(0 0 0 / 35%); pointer-events: none;"
        >
          <kbd style="display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px; background: rgb(247 244 232 / 92%); color: rgb(22 21 18); border-radius: 5px; font-weight: 700; font-size: 12px;">E</kbd>
          <span>{snapshot().buildingEntry?.action === 'exit' ? 'Exit building' : 'Enter building'}</span>
        </div>
      </Show>
      <Show when={drivingVehicle()}>
        <div
          class="hud__speedometer"
          role="status"
          aria-label={`Speed ${speedMph()} miles per hour`}
          style={{ '--speed-ratio': speedRatio() }}
        >
          <div class="hud__speed-ring" aria-hidden="true" />
          <span class="hud__speed-value">{speedMph()}</span>
          <span class="hud__speed-unit">mph</span>
        </div>
      </Show>
      <Show when={snapshot().timing?.showHud}>
        <div class="hud__timing" role="status">
          sim {Number(snapshot().timing?.simTime ?? 0).toFixed(2)}s · steps {snapshot().timing?.stepsPerFrame ?? 0} · α {Number(snapshot().timing?.alpha ?? 0).toFixed(2)}
        </div>
      </Show>

      <div class="hud__cluster">
      <div class="hud__indicators">
        <div class="hud__grip" style={{ '--stamina': staminaPercent() }}>
          <span />
        </div>
        <div class="hud__health" style={{ '--health': healthPercent() }}>
          <span />
        </div>
        <div class="hud__sway" style={{ '--sway': swayDegrees() }}>
          <span />
        </div>
      </div>

      <div class="hud__panel">
        <div class="hud__readout">
          <span>{combatLabel() || snapshot().level?.name || 'Base Level'}</span>
          <span>{formatState(snapshot().animation?.state)}</span>
          <Show when={snapshot().character?.district}>
            <span style={{ color: '#a0d0ff', marginLeft: '8px', fontSize: '11px' }}>📍 {snapshot().character.district}</span>
          </Show>
        </div>
      </div>
      </div>
    </section>
  );
}

function formatState(state) {
  if (!state) {
    return 'Loading';
  }

  const label = state.replace(/([a-z])([A-Z])/g, '$1 $2');

  return label.charAt(0).toUpperCase() + label.slice(1);
}
