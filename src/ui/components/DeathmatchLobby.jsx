import { createSignal, Show, onMount } from 'solid-js';
import {
  normalizeRoomCode,
  generateRoomCode,
  roomCodeFromLocation,
} from '../../game/net/deathmatchClientConfig.js';

/**
 * Deathmatch lobby form (M2): choose a display name, then create a new room or
 * join one by code. Emits `onEnter({ displayName, roomCode, host })`; the app
 * owns the socket and arena mount. A `?room=CODE` deep link prefills join.
 */
export function DeathmatchLobby(props) {
  const deepLink = roomCodeFromLocation();
  const [name, setName] = createSignal(props.defaultName ?? 'Player');
  const [code, setCode] = createSignal(deepLink ?? '');
  const [error, setError] = createSignal('');

  let nameInput;
  onMount(() => {
    // Auto-join a deep-linked room once the name is present.
    if (deepLink) queueMicrotask(() => nameInput?.focus());
    else queueMicrotask(() => nameInput?.focus());
  });

  const enter = (roomCode) => {
    const display = name().trim() || 'Player';
    const room = normalizeRoomCode(roomCode);
    if (room.length < 4) {
      setError('Room code needs at least 4 characters.');
      return;
    }
    setError('');
    props.onEnter?.({ displayName: display, roomCode: room });
  };

  const onCreate = () => enter(generateRoomCode());
  const onJoin = () => enter(code());

  return (
    <div class="dm-lobby" data-testid="deathmatch-lobby">
      <div class="dm-lobby__panel">
        <header class="dm-lobby__header">
          <div class="dm-lobby__title">Rail Crucible</div>
          <p class="dm-lobby__subtitle">Free-for-all deathmatch · 2–8 players</p>
        </header>

        <label class="dm-lobby__field">
          <span>Display name</span>
          <input
            ref={nameInput}
            type="text"
            maxLength={24}
            value={name()}
            data-testid="dm-name"
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onCreate(); }}
          />
        </label>

        <div class="dm-lobby__actions">
          <button
            type="button"
            class="dm-lobby__btn dm-lobby__btn--primary"
            data-testid="dm-create"
            onClick={onCreate}
          >
            Create room
          </button>

          <div class="dm-lobby__join">
            <input
              type="text"
              placeholder="ROOM CODE"
              maxLength={12}
              value={code()}
              data-testid="dm-code"
              class="dm-lobby__code"
              onInput={(e) => setCode(normalizeRoomCode(e.currentTarget.value))}
              onKeyDown={(e) => { if (e.key === 'Enter') onJoin(); }}
            />
            <button
              type="button"
              class="dm-lobby__btn"
              data-testid="dm-join"
              disabled={normalizeRoomCode(code()).length < 4}
              onClick={onJoin}
            >
              Join
            </button>
          </div>
        </div>

        <Show when={error()}>
          <p class="dm-lobby__error" role="alert">{error()}</p>
        </Show>

        <button type="button" class="dm-lobby__back" onClick={() => props.onCancel?.()}>
          ← Back to menu
        </button>
      </div>
    </div>
  );
}
