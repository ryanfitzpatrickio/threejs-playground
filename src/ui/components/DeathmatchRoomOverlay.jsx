import { For, Show, createMemo } from 'solid-js';
import { NET_STATUS } from '../../game/systems/DeathmatchNetworkSystem.js';
import { MATCH_PHASE } from '../../game/config/deathmatch/deathmatchRules.js';
import { roomShareUrl } from '../../game/net/deathmatchClientConfig.js';

/** Human-readable connection line for the room header. */
function statusLabel(net, assetReady) {
  if (!net) return 'Connecting…';
  if (net.error && net.status === NET_STATUS.ERROR) return `Error: ${net.error.message}`;
  switch (net.status) {
    case NET_STATUS.CONNECTING: return 'Connecting to room…';
    case NET_STATUS.RECONNECTING: return 'Reconnecting…';
    case NET_STATUS.CLOSED: return 'Disconnected';
    case NET_STATUS.WELCOMED:
      return assetReady ? 'In room' : 'Loading arena…';
    default: return 'Connecting…';
  }
}

/**
 * Room overlay (M2): the combined network + asset ready barrier and the ready
 * flow. Shown while the match phase is not RUNNING (waiting/countdown) or while
 * still connecting/loading. Reads the network snapshot; owns no socket.
 */
export function DeathmatchRoomOverlay(props) {
  const net = () => props.snapshot;
  const assetReady = () => !!props.assetReady;

  const players = createMemo(() => net()?.players ?? []);
  const phase = () => net()?.phase ?? null;
  const localId = () => net()?.playerId ?? null;
  const localReady = () => !!net()?.localReady;

  const countdownSeconds = createMemo(() => {
    const n = net();
    if (!n || n.phase !== MATCH_PHASE.COUNTDOWN) return null;
    const remaining = (n.phaseEndsAt ?? 0) + (n.clockOffsetMs ?? 0) - Date.now();
    return Math.max(0, Math.ceil(remaining / 1000));
  });

  const canReady = createMemo(
    () => net()?.status === NET_STATUS.WELCOMED && assetReady() && phase() === MATCH_PHASE.WAITING,
  );

  const shareUrl = createMemo(() => (net()?.roomId ? roomShareUrl(net().roomId) : ''));

  const copyShare = async () => {
    try {
      await navigator.clipboard?.writeText(shareUrl());
    } catch { /* clipboard may be blocked; the code is shown regardless */ }
  };

  return (
    <div class="dm-room" data-testid="deathmatch-room-overlay">
      <div class="dm-room__panel">
        <header class="dm-room__header">
          <div class="dm-room__code" data-testid="dm-room-code">
            Room <strong>{net()?.roomId ?? '—'}</strong>
            <button type="button" class="dm-room__copy" onClick={copyShare} title="Copy invite link">
              copy link
            </button>
          </div>
          <div class="dm-room__status">{statusLabel(net(), assetReady())}</div>
        </header>

        <Show when={countdownSeconds() != null}>
          <div class="dm-room__countdown" data-testid="dm-countdown">
            Match starts in {countdownSeconds()}…
          </div>
        </Show>

        <ul class="dm-room__players">
          <For each={players()}>
            {(p) => (
              <li
                class="dm-room__player"
                classList={{ 'dm-room__player--self': p.playerId === localId() }}
              >
                <span class="dm-room__dot" classList={{ 'is-ready': p.ready, 'is-off': !p.connected }} />
                <span class="dm-room__name">{p.displayName ?? p.playerId}</span>
                <span class="dm-room__frags">{p.frags ?? 0}</span>
              </li>
            )}
          </For>
          <Show when={players().length === 0}>
            <li class="dm-room__empty">Waiting for players…</li>
          </Show>
        </ul>

        <div class="dm-room__actions">
          <button
            type="button"
            class="dm-room__btn dm-room__btn--primary"
            data-testid="dm-ready"
            disabled={!canReady()}
            onClick={() => props.onToggleReady?.(!localReady())}
          >
            {localReady() ? 'Not ready' : 'Ready'}
          </button>
          <button
            type="button"
            class="dm-room__btn"
            data-testid="dm-leave"
            onClick={() => props.onLeave?.()}
          >
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
