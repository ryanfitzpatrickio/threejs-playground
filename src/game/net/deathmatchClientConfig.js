/**
 * Deathmatch client connection config (M2) — dependency-free.
 *
 * Resolves the PartyKit host and normalizes room codes on the browser side.
 * Kept pure/isomorphic so node verifiers can import it: it reads
 * `import.meta.env.VITE_PARTYKIT_HOST` defensively and falls back to the local
 * `partykit dev` default. Never import Three/Solid here.
 */

import { LIMITS } from './deathmatchProtocol.js';

/** Local default matching `partykit dev`'s bound port. */
export const DEFAULT_PARTYKIT_HOST = '127.0.0.1:1999';

/** Characters allowed in a room code (unambiguous: no O/0/I/1). */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Resolve the PartyKit host from the Vite env with a localhost dev default.
 * @returns {string} host like `127.0.0.1:1999` or `dreamfall.<user>.partykit.dev`
 */
export function resolvePartyKitHost() {
  let host;
  try {
    // `import.meta.env` only exists under Vite; guard for node imports.
    host = import.meta?.env?.VITE_PARTYKIT_HOST;
  } catch {
    host = undefined;
  }
  const trimmed = typeof host === 'string' ? host.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_PARTYKIT_HOST;
}

/**
 * Normalize an arbitrary user-entered room code to the canonical form used as
 * the PartyKit room id: uppercase, alphabet-filtered, length-bounded.
 * @returns {string} normalized code, possibly empty when nothing usable remains
 */
export function normalizeRoomCode(raw) {
  const s = typeof raw === 'string' ? raw : '';
  let out = '';
  for (const ch of s.toUpperCase()) {
    if (ROOM_CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length >= LIMITS.maxRoomCodeLength) break;
  }
  return out;
}

/** True when `code` is a syntactically valid room code (server ignores case). */
export function isValidRoomCode(code) {
  const n = normalizeRoomCode(code);
  return n.length >= 4 && n === (typeof code === 'string' ? code.toUpperCase() : '');
}

/**
 * Generate a fresh random room code. `rand` defaults to `Math.random` and is
 * injectable for deterministic tests.
 * @param {number} [length]
 * @param {() => number} [rand]
 */
export function generateRoomCode(length = 5, rand = Math.random) {
  const n = Math.min(Math.max(length | 0, 4), LIMITS.maxRoomCodeLength);
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

/** Read a room code from the current URL (`?room=CODE`), normalized or null. */
export function roomCodeFromLocation(search) {
  try {
    const params = new URLSearchParams(
      search ?? (typeof location !== 'undefined' ? location.search : ''),
    );
    const code = normalizeRoomCode(params.get('room') ?? '');
    return code.length >= 4 ? code : null;
  } catch {
    return null;
  }
}

/** Build a shareable direct-join URL for a room code. */
export function roomShareUrl(code, origin) {
  const base = origin ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '');
  return `${base}?level=deathmatch&room=${encodeURIComponent(normalizeRoomCode(code))}`;
}
