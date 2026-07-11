/**
 * Shared weapon-locomotion resolver — the single source of truth for which
 * locomotion clip a gun-armed character plays, used by BOTH first-person
 * (FirstPersonWeaponSystem) and third-person (AnimationStateSystem).
 *
 * It maps (weaponKind, stance, aiming, movement direction, tier) onto a manifest
 * state key produced by buildWeaponLocoStates in maraAnimationManifest.js
 * (`${kind}_${slug}`), collapsing requested directions onto the clips a given
 * pack actually ships. Pure + node-importable (verify-weapon-locomotion.mjs).
 *
 * Facing (see MovementSystem / firstPersonRig): `facingMode:'aim'` means the body
 * faces the camera/aim and the returned direction clip expresses the strafe;
 * `facingMode:'velocity'` means the body turns to face travel (hip-carry / TP).
 */

// Per-weapon-kind capability descriptors — mirror the clips wired in the manifest.
const KIND_CAPS = {
  rifle: {
    dirs: new Set(['fwd', 'fwd_left', 'fwd_right', 'bwd', 'bwd_left', 'bwd_right', 'left', 'right']),
    tiers: ['walk', 'run', 'sprint'],
    crouchWalk: true,
    aimIdle: true,
    crouchAimIdle: true,
    strafeClips: false,
    turn: true,
    crouchTurn: true,
    jump: { up: 'jump_up', loop: 'jump_loop', down: 'jump_down', default: 'jump_loop' },
  },
  pistol: {
    dirs: new Set(['fwd', 'fwd_left', 'fwd_right', 'bwd', 'bwd_left', 'bwd_right']),
    tiers: ['walk', 'run'],
    crouchWalk: false,
    aimIdle: false,
    crouchAimIdle: false,
    strafeClips: true,
    turn: false,
    crouchTurn: false,
    jump: { up: 'jump', loop: 'jump', down: 'jump', default: 'jump' },
  },
};

const DIR_DEADZONE = 0.2;

/**
 * Collapse a gun profile / combat kind onto a locomotion family.
 * Rifles, carbines, bullpups, DMRs, SMGs, snipers and shotguns share the rifle
 * pack; pistols/revolvers use the pistol pack. Melee/unarmed return null.
 * @returns {'rifle'|'pistol'|null}
 */
export function normalizeWeaponLocoKind(weaponKind) {
  if (!weaponKind) return null;
  const k = String(weaponKind).toLowerCase();
  if (k === 'pistol' || k === 'handgun' || k === 'revolver') return 'pistol';
  if (['rifle', 'carbine', 'bullpup', 'dmr', 'smg', 'sniper', 'shotgun', 'ar'].includes(k)) return 'rifle';
  return null;
}

/** 8-way direction token from forward/strafe axes, or null when centred. */
export function locomotionDirToken(forward = 0, strafe = 0) {
  const fb = forward > DIR_DEADZONE ? 'fwd' : forward < -DIR_DEADZONE ? 'bwd' : '';
  const lr = strafe > DIR_DEADZONE ? 'right' : strafe < -DIR_DEADZONE ? 'left' : '';
  if (fb && lr) return `${fb}_${lr}`;
  if (fb) return fb;
  if (lr) return lr;
  return null;
}

function idleState(kind, caps, stance, aiming) {
  if (stance === 'crouch') {
    if (aiming && caps.crouchAimIdle) return `${kind}_crouch_aim_idle`;
    return `${kind}_crouch_idle`;
  }
  if (aiming && caps.aimIdle) return `${kind}_aim_idle`;
  return `${kind}_idle`;
}

function movingState(kind, caps, stance, tier, dir) {
  // Crouch locomotion (rifle only ships a crouch walk tier).
  if (stance === 'crouch' && caps.crouchWalk && caps.dirs.has(dir)) {
    return `${kind}_crouch_walk_${dir}`;
  }
  // Dedicated pure-lateral strafe clips (pistol has no left/right in the tiers).
  if (caps.strafeClips && (dir === 'left' || dir === 'right')) {
    return `${kind}_strafe_${dir}`;
  }
  // Pick an available tier (sprint→run when the kind lacks a sprint tier).
  let t = tier;
  if (!caps.tiers.includes(t)) t = caps.tiers.includes('run') ? 'run' : caps.tiers[0];
  // Pick an available direction (alias unsupported pure lateral onto forward).
  const d = caps.dirs.has(dir) ? dir : 'fwd';
  return `${kind}_${t}_${d}`;
}

/**
 * Resolve the locomotion state for an armed character.
 *
 * @param {object} p
 * @param {string}  p.weaponKind  gun profile kind (rifle/pistol/shotgun/…)
 * @param {'stand'|'crouch'} [p.stance]
 * @param {boolean} [p.aiming]    ADS held (or forced in first person)
 * @param {number}  [p.forward]   camera-relative forward axis [-1,1]
 * @param {number}  [p.strafe]    camera-relative strafe axis [-1,1] (right +)
 * @param {boolean} [p.sprinting]
 * @param {boolean} [p.grounded]
 * @param {'left'|'right'|null} [p.turning]  turn-in-place request (M5)
 * @returns {{kind:string,state:string,facingMode:'aim'|'velocity',dir:string|null}|null}
 */
export function resolveWeaponLocomotionState({
  weaponKind,
  stance = 'stand',
  aiming = false,
  forward = 0,
  strafe = 0,
  sprinting = false,
  grounded = true,
  turning = null,
} = {}) {
  const kind = normalizeWeaponLocoKind(weaponKind);
  if (!kind) return null;
  const caps = KIND_CAPS[kind];
  const facingMode = aiming ? 'aim' : 'velocity';

  if (!grounded) {
    return { kind, state: `${kind}_${caps.jump.default}`, facingMode, dir: null };
  }

  const dir = locomotionDirToken(forward, strafe);

  // Turn-in-place: only while effectively stationary (no travel direction).
  if (!dir && (turning === 'left' || turning === 'right')) {
    if (stance === 'crouch' && caps.crouchTurn) {
      return { kind, state: `${kind}_crouch_turn_${turning}`, facingMode, dir: null };
    }
    if (caps.turn) {
      return { kind, state: `${kind}_turn_${turning}`, facingMode, dir: null };
    }
  }

  if (!dir) {
    return { kind, state: idleState(kind, caps, stance, aiming), facingMode, dir: null };
  }

  // Aiming slows the gait to a walk (unless sprinting); default carry is a run.
  const tier = sprinting ? 'sprint' : aiming ? 'walk' : 'run';
  return { kind, state: movingState(kind, caps, stance, tier, dir), facingMode, dir };
}

/** Jump/airborne clip for a gun kind (AnimationStateSystem airborne branch). */
export function weaponLocoJumpState(weaponKind, phase = 'default') {
  const kind = normalizeWeaponLocoKind(weaponKind);
  if (!kind) return null;
  const jump = KIND_CAPS[kind].jump;
  return `${kind}_${jump[phase] ?? jump.default}`;
}

/** True when a gun kind maps to a locomotion family (drives the armed branch). */
export function hasWeaponLocoFamily(weaponKind) {
  return normalizeWeaponLocoKind(weaponKind) != null;
}

/**
 * Per-state hand behaviour — which animations should let a hand swing free
 * instead of being pinned to the gun, and whether the gun should ride the right
 * hand (a "carry" socket) instead of being body-anchored. Matched by substring
 * on the resolved playback state (`${kind}_${slug}`).
 *
 * `left`/`right` = whether that hand's IK stays ACTIVE. `carry` = socket the gun
 * to the right hand (frozen from the moment carry begins) so it's held through
 * the clip rather than floating at the chest anchor. Sprint pumps the arms and
 * the reach-clamp fights the swing, so it drops both IK and carries in-hand.
 */
const HAND_IK_GATES = [
  { test: (s) => s.includes('sprint'), left: false, right: false, carry: true },
];

/**
 * @param {string|null|undefined} stateKey  resolved playback state
 * @returns {{ left: boolean, right: boolean, carry: boolean }}
 */
export function resolveWeaponHandIk(stateKey) {
  const s = String(stateKey || '');
  for (const rule of HAND_IK_GATES) {
    if (rule.test(s)) return { left: rule.left, right: rule.right, carry: !!rule.carry };
  }
  return { left: true, right: true, carry: false };
}
