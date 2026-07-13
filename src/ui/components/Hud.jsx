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
  const staminaRatio = () => Math.max(0, Math.min(1, snapshot().character?.stamina ?? 1));
  const healthRatio = () => {
    const c = snapshot().character ?? {};
    return Math.max(0, Math.min(1, (c.health ?? 1) / (c.maxHealth ?? 1)));
  };
  const swayAmount = () => Math.abs(snapshot().character?.sway ?? 0);

  const combat = () => snapshot().combat;
  const fpWeapon = () => snapshot().firstPersonWeapon;
  const gunHud = () => {
    const fp = fpWeapon();
    const gun = fp?.gun;
    if (!fp?.active || !fp?.weaponVisible || !gun) return null;
    return gun;
  };

  /** Loadout / combat mode only — no locomotion override spam. */
  const loadoutLabel = () => {
    const w = snapshot().weapon;
    const c = combat();
    const gun = gunHud();
    const holstered = Boolean(w?.holstered);
    const short = w?.equippedShortLabel
      || (gun ? (gun.label || gun.id || 'Gun').toString().slice(0, 14) : null)
      || (c?.armed ? 'Sword' : null);
    if (!short && !c?.active) return null;
    const name = short || 'Unarmed';
    if (holstered && short) return `${name} · stowed`;
    if (gun && !holstered) {
      if (gun.state === 'reloading') return `${name} · reload`;
      if ((w?.inspectBlend ?? 0) > 0.4) return `${name} · inspect`;
      if (gun.ads > 0.5) return `${name} · ads`;
      if (gun.state === 'firing') return `${name} · fire`;
    }
    if (c?.attack?.kind) return `${name} · ${c.attack.kind}`;
    // Meaningful combat acts only (skip armedIdle / fp_walk locomotion noise).
    const raw = c?.animationOverride;
    if (raw && isCombatActionOverride(raw)) {
      return `${name} · ${formatCombatAct(raw)}`;
    }
    return name;
  };

  const statusPrimary = () => loadoutLabel() || snapshot().level?.name || 'Dreamfall';
  const statusSecondary = () => {
    const ability = snapshot().ability?.shortLabel;
    const holstered = Boolean(snapshot().weapon?.holstered);
    const showAbility = ability && (holstered || !gunHud());
    const district = snapshot().character?.district;
    const parts = [];
    if (showAbility) parts.push(`[F] ${ability}`);
    if (district) parts.push(district);
    return parts.length ? parts.join(' · ') : null;
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
              <span class="hud__range-hint">Red = hostile · Blue = friendly · 1 sword · 2 pistol · 3 random rifle</span>
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
            <Show when={range().breachPrompt}>
              <div class="hud__range-breach">
                Press <kbd>E</kbd> to breach door
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

      <Show when={snapshot().vehicles?.hijackPrompt}>
        <div class="hud__roof-surf" role="status" aria-label="Hijack available">
          <span class="hud__roof-surf-title">Hijack</span>
          <span class="hud__roof-surf-hint">
            <kbd>F</kbd>
            {' '}take the driver seat
          </span>
        </div>
      </Show>

      <Show when={!snapshot().vehicles?.hijackPrompt && (snapshot().vehicles?.roofSurfing || snapshot().carLeap?.aiming)}>
        <div class="hud__roof-surf" role="status" aria-label="Roof surf mode">
          <span class="hud__roof-surf-title">
            {snapshot().carLeap?.aiming
              ? (snapshot().carLeap?.hasTarget ? 'Leap ready' : 'Aiming leap…')
              : 'Roof-surf'}
          </span>
          <span class="hud__roof-surf-hint">
            {snapshot().carLeap?.aiming ? (
              <>
                <kbd>Space</kbd>
                {' '}release to leap
                {snapshot().carLeap?.hasTarget ? ' · target locked' : ' · no target'}
              </>
            ) : (
              <>
                <kbd>H</kbd>
                {' '}seat ·
                {' '}
                <kbd>Space</kbd>
                {' '}hold leap · hard turns can throw you
              </>
            )}
          </span>
          <Show when={(snapshot().vehicles?.roofStability ?? 0) > 0.25 && !snapshot().carLeap?.aiming}>
            <span class="hud__roof-surf-meter">
              <span
                class="hud__roof-surf-meter-fill"
                classList={{
                  'hud__roof-surf-meter-fill--warn': (snapshot().vehicles?.roofStability ?? 0) > 0.75,
                }}
                style={{
                  width: `${Math.min(100, Math.round((snapshot().vehicles?.roofStability ?? 0) * 100))}%`,
                }}
              />
            </span>
          </Show>
          <Show when={snapshot().carLeap}>
            <span class="hud__roof-surf-meter" title="Bullet time">
              <span
                class="hud__roof-surf-meter-fill"
                style={{
                  width: `${Math.min(100, Math.round((snapshot().carLeap?.bulletTime ?? 0) * 100))}%`,
                  background: '#7ec8ff',
                }}
              />
            </span>
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
            <div
              class={ads ? 'hud__crosshair hud__crosshair--ads' : 'hud__crosshair'}
              aria-hidden="true"
            >
              <span class="hud__crosshair-h" />
              <span class="hud__crosshair-v" />
              <span class="hud__crosshair-dot" />
            </div>
          );
        })()}
      </Show>
      <Show when={snapshot().timing?.showHud}>
        <div class="hud__timing" role="status">
          sim {Number(snapshot().timing?.simTime ?? 0).toFixed(2)}s · steps {snapshot().timing?.stepsPerFrame ?? 0} · α {Number(snapshot().timing?.alpha ?? 0).toFixed(2)}
        </div>
      </Show>

      {/* Bottom-right dock: ammo + vitals + status (single column, no overlap). */}
      <div class="hud__dock">
        <Show when={gunHud()}>
          {(() => {
            const gun = gunHud();
            return (
              <div
                class="hud__ammo"
                role="status"
                aria-label={`Ammo ${gun.ammoInMag} of ${gun.magazineSize}, reserve ${gun.reserveAmmo}`}
              >
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
            );
          })()}
        </Show>

        <div class="hud__vitals" aria-hidden="true">
          <div class="hud__bar hud__bar--health" title="Health">
            <span class="hud__bar-fill" style={{ width: `${Math.round(healthRatio() * 100)}%` }} />
          </div>
          <div class="hud__bar hud__bar--stamina" title="Stamina">
            <span class="hud__bar-fill" style={{ width: `${Math.round(staminaRatio() * 100)}%` }} />
          </div>
          <Show when={swayAmount() > 0.04}>
            <div class="hud__bar hud__bar--sway" title="Sway">
              <span
                class="hud__bar-fill"
                style={{ width: `${Math.round(Math.min(1, swayAmount()) * 100)}%` }}
              />
            </div>
          </Show>
        </div>

        <div class="hud__status" role="status">
          <span class="hud__status-primary">{statusPrimary()}</span>
          <Show when={statusSecondary()}>
            <span class="hud__status-secondary">{statusSecondary()}</span>
          </Show>
        </div>
      </div>
    </section>
  );
}

/** Combat / draw acts only — not armed locomotion keys. */
function isCombatActionOverride(raw) {
  if (!raw || typeof raw !== 'string') return false;
  if (raw.startsWith('fp_') || raw.startsWith('rifle_') || raw.startsWith('pistol_')) return false;
  if (raw.startsWith('armed') || raw === 'runningSlide') return false;
  return true;
}

function formatCombatAct(raw) {
  if (raw === 'unarmedLight') return 'light';
  if (raw === 'butterflyTwirl') return 'twirl';
  if (raw.startsWith('lightSlash')) return 'slash';
  if (raw === 'heavyAttack') return 'heavy';
  if (raw === 'dropKick') return 'kick';
  if (raw === 'drawSword') return 'draw';
  if (raw === 'sheatheSword') return 'sheath';
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().slice(0, 10);
}

function formatRangeTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
