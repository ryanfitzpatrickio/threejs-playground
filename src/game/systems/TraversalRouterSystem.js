import { findLedgeTraversalClimbCandidate } from './LedgeTraversalSystem.js';

const LEDGE_CLIMB_INPUT_THRESHOLD = -0.5;
const LEDGE_CLIMB_FORCE_SECONDS = 0.35;
const LEDGE_JUMP_OFF_SPEED = 3.8;
const LEDGE_JUMP_OFF_FREE_FALL_SECONDS = 0.18;

// Order in which findClimbSurfaceCandidate evaluates its filters. A surface that
// fails a later filter passed more of them, so it is "closer" to being a valid
// target — that is the most useful thing to surface first when no candidate is
// found. reject === null means the surface cleared every filter (accepted).
const REJECT_ORDINAL = {
  minOriginY: 0,
  normalDot: 1,
  minTopY: 2,
  edgeDistance: 3,
  verticalDistance: 4,
  minFaceDistance: 5,
  maxFaceDistance: 6,
};

export class TraversalRouterSystem {
  constructor() {
    this.lastDecision = null;
    // Latched copy of the most recent climb/jump decision (wallClimb/jumpOff/
    // stayOnLedge). Persists across idle frames so it can be read from the
    // console after the key is released and the canvas has lost focus.
    this.lastRouting = null;
  }

  update({ input, character, level, wallClimbSystem }) {
    if (!character) {
      this.lastDecision = { state: 'inactive', result: 'passthrough', reason: 'no-character' };
      return { input };
    }

    // Route whenever the player is standing on a topped-out ledge, even on the
    // frame before LedgeTraversalSystem has entered sneak mode — that is the
    // window where W/Space would otherwise fall through to normal grounded
    // movement and walk the player off the ledge. Defer if any other traversal
    // has taken over (hang/wallClimb/etc.) so we never fight another system.
    const activeTraversal = character.wallClimb?.active
      ? 'wallClimb'
      : character.hang?.active
        ? 'hang'
        : character.wallRun?.active
          ? 'wallRun'
          : character.rope?.active
            ? 'rope'
            : null;

    if (character.ledgeStandSupport && !activeTraversal) {
      return this.routeLedgeTraversal({ input, character, level, wallClimbSystem });
    }

    // Always record why routing was skipped, so the snapshot stays diagnostic
    // even on idle frames (otherwise `traversalRouter` reads as null).
    this.lastDecision = {
      state: character.ledgeStandSupport ? 'ledgeSneak' : 'inactive',
      result: 'passthrough',
      reason: activeTraversal ? `blocked-by-${activeTraversal}` : 'no-ledge-stand-support',
      onLedge: Boolean(character.ledgeStandSupport),
      ledgeTraversalActive: Boolean(character.ledgeTraversal?.active),
      grounded: character.grounded !== false,
      position: {
        x: round2(character.group?.position?.x),
        y: round2(character.group?.position?.y),
        z: round2(character.group?.position?.z),
      },
    };
    return { input };
  }

  routeLedgeTraversal({ input, character, level, wallClimbSystem }) {
    const wantsClimbUp = input.moveZ < LEDGE_CLIMB_INPUT_THRESHOLD;
    const wantsJump = input.jumpPressed === true;

    // Pure shimmy (A/D, no W/Space): pass input through untouched so
    // LedgeTraversalSystem handles left/right movement along the ledge. Record
    // the idle state so the snapshot explains why no climb/jump happened.
    if (!wantsClimbUp && !wantsJump) {
      this.lastDecision = {
        state: 'ledgeSneak',
        intent: 'none',
        result: 'idle',
        reason: 'no-climb-or-jump-input',
      };
      return { input };
    }

    const support = character.ledgeStandSupport;
    const { candidate: climbCandidate, trace, probe } =
      findLedgeTraversalClimbCandidate({ level, character, support });

    const diagnostics = {
      probe: summarizeProbe(probe),
      considered: summarizeTrace(trace),
      poolSize: countClimbPool(level, support),
    };

    if (climbCandidate && wallClimbSystem?.attach) {
      character.ledgeTraversal = null;
      character.ledgeStandSupport = null;
      wallClimbSystem.attach({ character, surface: climbCandidate, input });
      if (character.wallClimb) {
        character.wallClimb.ignoreJumpPressed = wantsJump;
        character.wallClimb.forceClimbUpTimer = LEDGE_CLIMB_FORCE_SECONDS;
      }
      // finishClimb (which produced this ledgeStandSupport) arms a recovery
      // timer; clear it so it can't gate the climb-start animation.
      character.traversalRecoveryTimer = 0;
      wallClimbSystem.snapActiveClimbToSurface?.(character);
      this.lastDecision = {
        state: 'ledgeSneak',
        intent: wantsJump ? 'jump' : 'climbUp',
        result: 'wallClimb',
        candidate: climbCandidate.name ?? null,
        ...diagnostics,
      };
      this.lastRouting = this.lastDecision;
      return { input };
    }

    if (wantsJump) {
      character.ledgeTraversal = null;
      character.ledgeStandSupport = null;
      character.verticalVelocity = LEDGE_JUMP_OFF_SPEED;
      character.grounded = false;
      character.forceFreeFallTimer = LEDGE_JUMP_OFF_FREE_FALL_SECONDS;
      this.lastDecision = {
        state: 'ledgeSneak',
        intent: 'jump',
        result: 'jumpOff',
        reason: 'no-climb-candidate',
        verticalVelocity: LEDGE_JUMP_OFF_SPEED,
        ...diagnostics,
      };
      this.lastRouting = this.lastDecision;
      return { input };
    }

    this.lastDecision = {
      state: 'ledgeSneak',
      intent: 'climbUp',
      result: 'stayOnLedge',
      reason: 'no-climb-candidate',
      ...diagnostics,
    };
    this.lastRouting = this.lastDecision;
    // No climb target and no jump: hold position on the ledge by consuming
    // forward input. moveX is left intact so A/D shimmy still works.
    return {
      input: {
        ...input,
        moveZ: 0,
      },
    };
  }

  snapshot() {
    return {
      ...this.lastDecision,
      lastRouting: this.lastRouting,
    };
  }
}

function summarizeProbe(probe) {
  if (!probe) {
    return null;
  }

  return {
    x: round2(probe.x),
    y: round2(probe.y),
    z: round2(probe.z),
    yOffsetsTried: probe.yOffsetsTried ?? [],
  };
}

// Collapse the per-probe trace into the few most-informative surfaces: dedupe
// by name (keeping the record that got furthest through the filters), then take
// the top 3. This is what makes a `stayOnLedge` decision self-explanatory.
function summarizeTrace(trace) {
  if (!Array.isArray(trace) || trace.length === 0) {
    return [];
  }

  const bestByName = new Map();

  for (const record of trace) {
    const ordinal = record.reject == null ? 7 : (REJECT_ORDINAL[record.reject] ?? 0);
    const existing = bestByName.get(record.name);

    if (!existing || ordinal > existing.ordinal) {
      bestByName.set(record.name, { ...record, ordinal });
    }
  }

  return [...bestByName.values()]
    .sort((a, b) => b.ordinal - a.ordinal)
    .slice(0, 3)
    .map(roundTraceRecord);
}

function roundTraceRecord(record) {
  return {
    name: record.name,
    reject: record.reject,
    originY: round2(record.originY),
    topY: round2(record.topY),
    edgeDist: round2(record.edgeDist),
    vertDist: round2(record.vertDist),
    faceDist: round2(record.faceDist),
    score: round2(record.score),
  };
}

function countClimbPool(level, support) {
  const surfaces = level?.level?.climbSurfaces ?? [];

  if (!support?.blockName || !support?.face) {
    return surfaces.length;
  }

  return surfaces.filter(
    (surface) => surface.blockName === support.blockName && surface.face === support.face,
  ).length;
}

function round2(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}
