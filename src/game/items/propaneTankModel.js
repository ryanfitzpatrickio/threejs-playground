/**
 * Pure propane-tank gameplay state. No THREE/browser imports so the timing,
 * hit sequence, and chain staggering can be exercised from Node.
 */

export const PROPANE_TANK_STATE = Object.freeze({
  INTACT: 'intact',
  LEAKING: 'leaking',
  BURNING: 'burning',
  EXPLODED: 'exploded',
});

export const PROPANE_MAX_HOLES = 4;
export const PROPANE_DETONATE_DAMAGE = 3;

function hash01(seed, salt = 0) {
  let value = (Math.trunc(seed || 1) ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function clonePoint(value, fallback = [0, 0.45, 1]) {
  const component = (entry, index) => (Number.isFinite(Number(entry)) ? Number(entry) : fallback[index]);
  if (Array.isArray(value)) return [0, 1, 2].map((i) => component(value[i], i));
  return [
    component(value?.x, 0),
    component(value?.y, 1),
    component(value?.z, 2),
  ];
}

export function createPropaneTankState({ id, seed = 1 } = {}) {
  return {
    id: String(id ?? `propane-${seed}`),
    seed: Number(seed) || 1,
    state: PROPANE_TANK_STATE.INTACT,
    damage: 0,
    pressure: 1,
    holes: [],
    fuseRemaining: null,
    fuseDuration: null,
    chainRemaining: null,
    chainFuse: null,
    age: 0,
  };
}

export function createPropaneTankModel(entries = []) {
  const states = new Map();
  for (const entry of entries) {
    const state = createPropaneTankState(entry);
    states.set(state.id, state);
  }

  const get = (id) => states.get(String(id)) ?? null;

  function igniteState(state, { fuse = null, cause = 'bullet' } = {}) {
    if (!state || state.state === PROPANE_TANK_STATE.EXPLODED) return [];
    const events = [];
    if (state.state === PROPANE_TANK_STATE.INTACT) {
      state.state = PROPANE_TANK_STATE.LEAKING;
      events.push({ type: 'leakStart', tankId: state.id, cause });
    }
    if (state.state !== PROPANE_TANK_STATE.BURNING) {
      state.state = PROPANE_TANK_STATE.BURNING;
      const authoredFuse = 1.6 + hash01(state.seed, 11) * 0.8;
      state.fuseDuration = Math.max(0.05, Number(fuse) || authoredFuse);
      state.fuseRemaining = state.fuseDuration;
      state.chainRemaining = null;
      state.chainFuse = null;
      events.push({
        type: 'ignite',
        tankId: state.id,
        cause,
        fuse: state.fuseDuration,
      });
    } else if (Number.isFinite(fuse)) {
      state.fuseRemaining = Math.min(state.fuseRemaining, Math.max(0.05, fuse));
    }
    return events;
  }

  function detonateState(state, cause = 'fuse') {
    if (!state || state.state === PROPANE_TANK_STATE.EXPLODED) return [];
    state.state = PROPANE_TANK_STATE.EXPLODED;
    state.fuseRemaining = 0;
    state.chainRemaining = null;
    state.chainFuse = null;
    return [{ type: 'detonate', tankId: state.id, cause }];
  }

  return {
    states,
    get,
    hit(id, {
      localPoint = null,
      localNormal = null,
      damage = 1,
      cause = 'bullet',
    } = {}) {
      const state = get(id);
      if (!state || state.state === PROPANE_TANK_STATE.EXPLODED) return [];
      const events = [];
      if (state.holes.length < PROPANE_MAX_HOLES) {
        const hole = {
          point: clonePoint(localPoint),
          normal: clonePoint(localNormal, [0, 0, 1]),
          index: state.holes.length,
        };
        state.holes.push(hole);
        events.push({ type: 'hole', tankId: state.id, hole });
      }

      const hitDamage = Math.max(0.25, Number(damage) || 1);
      state.damage += hitDamage;
      if (state.state === PROPANE_TANK_STATE.INTACT) {
        state.state = PROPANE_TANK_STATE.LEAKING;
        events.push({ type: 'leakStart', tankId: state.id, cause });
      } else if (state.state === PROPANE_TANK_STATE.LEAKING) {
        events.push(...igniteState(state, { cause }));
      } else if (state.state === PROPANE_TANK_STATE.BURNING) {
        state.fuseRemaining = Math.max(
          0,
          state.fuseRemaining - (0.14 + hitDamage * 0.1),
        );
      }

      if (
        state.state === PROPANE_TANK_STATE.BURNING
        && (state.damage >= PROPANE_DETONATE_DAMAGE || state.fuseRemaining <= 0)
      ) {
        events.push(...detonateState(state, 'damage'));
      }
      return events;
    },
    ignite(id, options = {}) {
      return igniteState(get(id), options);
    },
    detonate(id, cause = 'debug') {
      return detonateState(get(id), cause);
    },
    scheduleChain(id, { delay = 0.2, instant = false } = {}) {
      const state = get(id);
      if (!state || state.state === PROPANE_TANK_STATE.EXPLODED) return false;
      // Even point-blank chains wait for the next update: no recursive same-frame booms.
      const queuedDelay = instant ? 0.001 : Math.max(0.01, Number(delay) || 0.2);
      if (state.state === PROPANE_TANK_STATE.BURNING) {
        state.fuseRemaining = Math.min(state.fuseRemaining, queuedDelay + 0.12);
      } else if (!Number.isFinite(state.chainRemaining) || queuedDelay < state.chainRemaining) {
        state.chainRemaining = queuedDelay;
        state.chainFuse = instant ? 0.05 : 0.45 + hash01(state.seed, 29) * 0.35;
      }
      return true;
    },
    update(delta) {
      const dt = Math.max(0, Number(delta) || 0);
      const events = [];
      for (const state of states.values()) {
        if (state.state === PROPANE_TANK_STATE.EXPLODED) continue;
        state.age += dt;
        if (state.state === PROPANE_TANK_STATE.LEAKING || state.state === PROPANE_TANK_STATE.BURNING) {
          state.pressure = Math.max(0.08, state.pressure - dt / 45);
        }
        if (Number.isFinite(state.chainRemaining)) {
          state.chainRemaining -= dt;
          if (state.chainRemaining <= 0) {
            events.push(...igniteState(state, {
              cause: 'chain',
              fuse: state.chainFuse ?? 0.6,
            }));
          }
        }
        if (state.state === PROPANE_TANK_STATE.BURNING) {
          state.fuseRemaining -= dt;
          if (state.fuseRemaining <= 0) events.push(...detonateState(state, 'fuse'));
        }
      }
      return events;
    },
    snapshot() {
      return [...states.values()].map((state) => ({
        id: state.id,
        state: state.state,
        damage: Number(state.damage.toFixed(2)),
        pressure: Number(state.pressure.toFixed(3)),
        holes: state.holes.length,
        fuse: Number.isFinite(state.fuseRemaining)
          ? Number(state.fuseRemaining.toFixed(3))
          : null,
        chain: Number.isFinite(state.chainRemaining)
          ? Number(state.chainRemaining.toFixed(3))
          : null,
      }));
    },
  };
}
