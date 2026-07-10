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
  const fpWeapon = () => snapshot().firstPersonWeapon;
  const gunHud = () => {
    const fp = fpWeapon();
    const gun = fp?.gun;
    if (!fp?.active || !fp?.weaponVisible || !gun) return null;
    return gun;
  };
  const combatLabel = () => {
    const c = combat();
    if (!c?.active) return null;
    const w = snapshot().weapon;
    const gun = gunHud();
    const holstered = Boolean(w?.holstered);
    const short = w?.equippedShortLabel
      || (gun ? (gun.label || gun.id || 'GUN').toUpperCase().slice(0, 14) : null)
      || (c.armed ? 'SWORD' : 'UNARMED');
    const mode = holstered ? `${short} · STOW` : short;
    let act = '';
    if (gun && !holstered) {
      if (gun.state === 'reloading') act = 'RELOAD';
      else if ((w?.inspectBlend ?? 0) > 0.4) act = 'INSPECT';
      else if (gun.ads > 0.5) act = 'ADS';
      else if (gun.state === 'firing') act = 'FIRE';
    } else if (c.animationOverride) {
      const raw = c.animationOverride;
      // Short human friendly labels for the common ones
      if (raw === 'unarmedLight') act = 'LIGHT';
      else if (raw === 'butterflyTwirl') act = 'TWIRL';
      else if (raw.startsWith('lightSlash')) act = 'SLASH';
      else if (raw === 'heavyAttack') act = 'HEAVY';
      else if (raw === 'dropKick') act = 'KICK';
      else if (raw === 'drawSword') act = 'DRAW';
      else if (raw === 'sheatheSword') act = 'SHEATH';
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

  const range = () => snapshot().shootingRange;

  return (
    <section class="hud" aria-live="polite">
      <Show when={range()?.active}>
        <div class="hud__range" role="status" aria-label="Shooting range status">
          <Show when={range().phase === 'countdown'}>
            <div class="hud__range-banner hud__range-banner--countdown">
              <span class="hud__range-title">Breach course</span>
              <span class="hud__range-big">{Math.ceil(range().countdownLeft || 0) || 'GO'}</span>
              <span class="hud__range-hint">Red = hostile · Blue = friendly · Scroll to switch guns</span>
            </div>
          </Show>
          <Show when={range().phase === 'running'}>
            <div class="hud__range-strip">
              <div class="hud__range-timer">
                <span class="hud__range-label">Time</span>
                <span class="hud__range-value">{formatRangeTime(range().timeLeft)}</span>
              </div>
              <div class="hud__range-score">
                <span class="hud__range-label">Score</span>
                <span class="hud__range-value">{range().score ?? 0}</span>
              </div>
              <div class="hud__range-hits">
                <span class="hud__range-hostile">
                  {range().hostileHits ?? 0}/{range().hostilesTotal ?? 0}
                </span>
                <span class="hud__range-sep">·</span>
                <span class="hud__range-friendly">
                  FF {range().friendlyHits ?? 0}
                </span>
              </div>
              <Show when={(range().bestForGun ?? 0) > 0}>
                <div class="hud__range-best">
                  Best {range().bestForGun}
                </div>
              </Show>
            </div>
            <Show when={(range().hitFlash ?? 0) > 0.05}>
              <div
                classList={{
                  'hud__range-flash': true,
                  'hud__range-flash--friendly': range().lastHitKind === 'friendly',
                  'hud__range-flash--head': range().lastHitKind === 'head',
                }}
              >
                {range().lastHitKind === 'friendly'
                  ? 'FRIENDLY FIRE'
                  : range().lastHitKind === 'head'
                    ? 'HEADSHOT'
                    : 'HIT'}
              </div>
            </Show>
          </Show>
          <Show when={range().phase === 'finished' && range().result}>
            <div class="hud__range-banner hud__range-banner--results">
              <span class="hud__range-title">Course complete</span>
              <span class="hud__range-big">{range().result.score}</span>
              <Show when={range().result.isNewBest}>
                <span class="hud__range-new-best">New best for this gun</span>
              </Show>
              <span class="hud__range-hint">
                Hostiles {range().result.hostileHits}/{range().result.hostilesTotal}
                {' · '}
                Friendly fire {range().result.friendlyHits}
                {' · '}
                Best {range().result.best}
              </span>
              <span class="hud__range-restart">Space or E to run again</span>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={snapshot().buildingEntry?.prompt}>
        <div
          class="hud__enter-prompt"
          role="status"
          style="position: absolute; left: 50%; bottom: 24%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: rgb(22 21 18 / 82%); border: 1px solid rgb(247 244 232 / 22%); border-radius: 999px; color: rgb(247 244 232 / 95%); font-size: 14px; letter-spacing: 0.02em; box-shadow: 0 8px 24px rgb(0 0 0 / 35%); pointer-events: none;"
        >
          <kbd style="display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px; background: rgb(247 244 232 / 92%); color: rgb(22 21 18); border-radius: 5px; font-weight: 700; font-size: 12px;">E</kbd>
          <span>
            {snapshot().buildingEntry?.action === 'exit'
              ? 'Exit building'
              : snapshot().buildingEntry?.action === 'elevator'
                ? `Elevator · floor ${(snapshot().buildingEntry?.floor ?? 0) + 1}/${snapshot().buildingEntry?.floorCount ?? 1} — E up · Shift down · 1-9`
                : snapshot().buildingEntry?.action === 'open-door'
                  ? 'Open door'
                  : snapshot().buildingEntry?.action === 'close-door'
                    ? 'Close door'
                : 'Enter building'}
          </span>
        </div>
      </Show>

      <Show when={(snapshot().screenFade?.alpha ?? 0) > 0.01}>
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            'background-color': '#090a0d',
            opacity: snapshot().screenFade?.alpha ?? 0,
            'pointer-events': 'none',
            'z-index': 200,
          }}
        />
      </Show>

      <Show when={snapshot().character?.districtNotification}>
        {(() => {
          const notif = snapshot().character.districtNotification;
          const age = Date.now() - (notif.time || 0);
          if (age > 4200) return null; // auto clear
          const isEnter = notif.action === 'enter';
          const opacity = Math.max(0, 1 - (age / 4200));
          const scale = 0.8 + (Math.min(age, 400) / 400) * 0.2;
          return (
            <div
              role="status"
              aria-live="polite"
              style={{
                position: 'absolute',
                left: '50%',
                top: '18%',
                transform: `translate(-50%, -50%) scale(${scale})`,
                opacity,
                transition: 'opacity 0.3s ease, transform 0.25s cubic-bezier(0.23,1,0.32,1)',
                padding: '6px 18px',
                background: isEnter ? 'rgba(30, 60, 90, 0.92)' : 'rgba(60, 30, 30, 0.85)',
                border: `1px solid ${isEnter ? '#4fc3f7' : '#ff8a80'}`,
                borderRadius: '4px',
                color: '#e0f7fa',
                fontSize: '13px',
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
                fontWeight: 600,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {isEnter ? '► ' : '◄ '}{notif.name}
            </div>
          );
        })()}
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
      <Show when={snapshot().camera?.focusReticle}>
        <div class="hud__focus-reticle" aria-hidden="true" />
      </Show>

      <Show when={gunHud()}>
        {(() => {
          const gun = gunHud();
          const ads = gun.ads > 0.55;
          return (
            <>
              <div
                class={ads ? 'hud__crosshair hud__crosshair--ads' : 'hud__crosshair'}
                aria-hidden="true"
              >
                <span class="hud__crosshair-h" />
                <span class="hud__crosshair-v" />
                <span class="hud__crosshair-dot" />
              </div>
              <div class="hud__ammo" role="status" aria-label={`Ammo ${gun.ammoInMag} of ${gun.magazineSize}, reserve ${gun.reserveAmmo}`}>
                <span class="hud__ammo-mag">{gun.ammoInMag}</span>
                <span class="hud__ammo-sep">/</span>
                <span class="hud__ammo-reserve">{gun.reserveAmmo}</span>
                <Show when={gun.state === 'reloading'}>
                  <span class="hud__ammo-state">RELOAD</span>
                </Show>
                <Show when={gun.ammoInMag <= 0 && gun.state !== 'reloading'}>
                  <span class="hud__ammo-state hud__ammo-state--empty">EMPTY</span>
                </Show>
              </div>
            </>
          );
        })()}
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
          <Show when={snapshot().ability?.shortLabel && (snapshot().weapon?.holstered || !gunHud())}>
            <span
              style={{ color: '#c8e6c9', marginLeft: '8px', fontSize: '11px' }}
              title="F to use ability · Z holsters weapon"
            >
              [F] {snapshot().ability.shortLabel}
            </span>
          </Show>
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

function formatRangeTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
