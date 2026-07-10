import { GAME_CONFIG } from '../config/gameConfig.js';

const KEY_BINDINGS = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'brace',
  ShiftRight: 'brace',
  Space: 'jump',
  // C: crouch (weapon stance / low profile). Slide moved to Ctrl.
  KeyC: 'crouch',
  // F activates the equipped ability (swing / wingsuit — equip like a gun via scroll).
  KeyF: 'ability',
  KeyT: 'telekinesis',
  KeyG: 'grabSlam',
  // Q: cover lean left (armed) + vehicle rear-view hold. Wingsuit is an ability now.
  KeyQ: 'leanLeft',
  // Z: holster / draw equipped weapon (WeaponSystem loadout).
  KeyZ: 'drawSheathe',
  // E: enter/exit vehicle or horse (was F). Cover lean right while held (armed).
  KeyE: 'mount',
  Digit1: 'elevatorFloor1',
  Digit2: 'elevatorFloor2',
  Digit3: 'elevatorFloor3',
  Digit4: 'elevatorFloor4',
  Digit5: 'elevatorFloor5',
  Digit6: 'elevatorFloor6',
  Digit7: 'elevatorFloor7',
  Digit8: 'elevatorFloor8',
  Digit9: 'elevatorFloor9',
  AltLeft: 'hookAim',
  AltRight: 'hookAim',
  // Ctrl: slide (was crouch; crouch is C now).
  ControlLeft: 'slide',
  ControlRight: 'slide',
  // X: inspect equipped gun (hold).
  KeyX: 'inspect',
  KeyR: 'shoulderThrow',
  KeyV: 'cutMode',
  KeyK: 'photoMode',
  Enter: 'cutCommit',
  Escape: 'cutCancel',
};

const JUMP_DOUBLE_TAP_SECONDS = 0.48;
const DODGE_DOUBLE_TAP_SECONDS = 0.3;
// Double-tap F (ability) while swing is equipped → dual-rope pull launch.
const ABILITY_DOUBLE_TAP_SECONDS = 0.3;

// Move-vector (x = right-left, z = backward-forward) for each dodge direction.
const DODGE_VECTORS = {
  forward: { x: 0, z: -1 },
  backward: { x: 0, z: 1 },
  left: { x: -1, z: 0 },
  right: { x: 1, z: 0 },
};

export class InputSystem {
  constructor({ target }) {
    this.target = target;
    this.actions = new Set();
    this.pressedActions = new Set();
    this.releasedActions = new Set();
    this.lookDelta = { x: 0, y: 0 };
    this.zoomDelta = 0;
    this.mousePrimaryPressed = false;
    this.mouseSecondaryPressed = false;
    this.mouseMiddlePressed = false;
    this.mousePrimaryHeld = false;
    this.mouseSecondaryHeld = false;
    this.mouseMiddleHeld = false;
    this.pointerLocked = false;
    this.lastJumpPressTime = -Infinity;
    this.lastAbilityPressTime = -Infinity;
    this.abilityDoubleTapPending = false; // one-frame edge (dual-rope pull when swing equipped)
    this.wallRunJumpHold = false;
    this.lastDirectionPress = { forward: -Infinity, backward: -Infinity, left: -Infinity, right: -Infinity };
    this.dodgeDirectionPending = null; // {x, z} | null — one-frame edge
    this.jumpDoubleTapPending = false; // one-frame edge (air-dash)
    this.jumpDoubleTapRaw = false; // raw double-jump edge for wingsuit (AbilitySystem gates)
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handlePointerLockChange = this.handlePointerLockChange.bind(this);
    this.handleContextMenu = this.handleContextMenu.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
  }

  connect() {
    this.target.tabIndex = 0;
    this.target.focus({ preventScroll: true });
    globalThis.addEventListener('keydown', this.handleKeyDown);
    globalThis.addEventListener('keyup', this.handleKeyUp);
    this.target.addEventListener('mousedown', this.handleMouseDown);
    globalThis.addEventListener('mouseup', this.handleMouseUp);
    this.target.addEventListener('contextmenu', this.handleContextMenu);
    globalThis.addEventListener('mousemove', this.handleMouseMove);
    this.target.addEventListener('wheel', this.handleWheel, { passive: false });
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    globalThis.addEventListener('blur', this.handleBlur);
  }

  getState() {
    const jumpPressed = this.pressedActions.has('jump');
    const jumpReleased = this.releasedActions.has('jump');
    const leftPressed = this.pressedActions.has('left');
    const rightPressed = this.pressedActions.has('right');
    const bracePressed = this.pressedActions.has('brace');
    const slidePressed = this.pressedActions.has('slide');
    const collisionDebugPressed = this.pressedActions.has('collisionDebug');
    const mountPressed = this.pressedActions.has('mount');
    const abilityPressed = this.pressedActions.has('ability');
    const abilityDoubleTapped = this.abilityDoubleTapPending;
    const drawSheathePressed = this.pressedActions.has('drawSheathe');
    const grabSlamPressed = this.pressedActions.has('grabSlam');
    const shoulderThrowPressed = this.pressedActions.has('shoulderThrow');
    const cutModePressed = this.pressedActions.has('cutMode');
    const photoModePressed = this.pressedActions.has('photoMode');
    const cutModeReleased = this.releasedActions.has('cutMode');
    const cutCommitPressed = this.pressedActions.has('cutCommit') || this.mousePrimaryPressed;
    // Left-click doubles as light attack when armed (combat and cut mode run in
    // mutually exclusive branches of GameRuntime.update, so sharing the flag is safe).
    const lightAttackPressed = this.mousePrimaryPressed;
    const heavyAttackPressed = this.mouseSecondaryPressed;
    const cutCancelPressed = this.pressedActions.has('cutCancel');
    const telekinesisPressed = this.pressedActions.has('telekinesis');
    const telekinesisReleased = this.releasedActions.has('telekinesis');
    // Hook fire is no longer a dedicated key — AbilitySystem maps F / middle-click
    // onto hookFire* when the swing ability is equipped.
    const elevatorFloors = {};
    for (let i = 1; i <= 9; i += 1) {
      elevatorFloors[`elevatorFloor${i}`] = this.pressedActions.has(`elevatorFloor${i}`);
    }
    this.abilityDoubleTapPending = false;
    const dodgeDirection = this.dodgeDirectionPending;
    const jumpDoubleTapped = this.jumpDoubleTapPending;
    // Double-tap Space raw edge for wingsuit (AbilitySystem only enables while glider equipped).
    const wingsuitTogglePressed = this.jumpDoubleTapRaw === true;
    this.jumpDoubleTapRaw = false;
    this.pressedActions.delete('jump');
    this.pressedActions.delete('left');
    this.pressedActions.delete('right');
    this.pressedActions.delete('brace');
    this.pressedActions.delete('slide');
    this.pressedActions.delete('collisionDebug');
    this.pressedActions.delete('mount');
    this.pressedActions.delete('ability');
    this.pressedActions.delete('drawSheathe');
    this.pressedActions.delete('grabSlam');
    this.pressedActions.delete('shoulderThrow');
    this.pressedActions.delete('cutMode');
    this.pressedActions.delete('photoMode');
    this.pressedActions.delete('cutCommit');
    this.pressedActions.delete('cutCancel');
    this.pressedActions.delete('telekinesis');
    for (let i = 1; i <= 9; i += 1) this.pressedActions.delete(`elevatorFloor${i}`);
    this.dodgeDirectionPending = null;
    this.jumpDoubleTapPending = false;
    this.releasedActions.delete('jump');
    this.releasedActions.delete('cutMode');
    this.releasedActions.delete('telekinesis');
    const lookX = this.lookDelta.x;
    const lookY = this.lookDelta.y;
    const zoomDelta = this.zoomDelta;
    const mouseMiddlePressed = this.mouseMiddlePressed;
    this.lookDelta.x = 0;
    this.lookDelta.y = 0;
    this.zoomDelta = 0;
    this.mousePrimaryPressed = false;
    this.mouseSecondaryPressed = false;
    this.mouseMiddlePressed = false;

    return {
      moveX: Number(this.actions.has('right')) - Number(this.actions.has('left')),
      moveZ: Number(this.actions.has('backward')) - Number(this.actions.has('forward')),
      lookX,
      lookY,
      zoomDelta,
      pointerLocked: this.pointerLocked,
      brace: this.actions.has('brace'),
      bracePressed,
      jump: this.actions.has('jump'),
      wallRunJump: this.wallRunJumpHold && this.actions.has('jump'),
      jumpPressed,
      jumpReleased,
      leftPressed,
      rightPressed,
      slidePressed,
      slide: this.actions.has('slide'),
      collisionDebugPressed,
      mountPressed,
      abilityPressed,
      abilityHeld: this.actions.has('ability'),
      abilityDoubleTapped,
      drawSheathePressed,
      grabSlamPressed,
      shoulderThrowPressed,
      cutModePressed,
      photoModePressed,
      cutModeReleased,
      cutCommitPressed,
      cutCancelPressed,
      lightAttackPressed,
      heavyAttackPressed,
      mousePrimaryHeld: this.mousePrimaryHeld,
      mouseSecondaryHeld: this.mouseSecondaryHeld,
      mouseMiddleHeld: this.mouseMiddleHeld,
      mouseMiddlePressed,
      // Hold C to crouch (weapon-locomotion stance layer).
      crouchHeld: this.actions.has('crouch'),
      // Cover-peek leans (Q/E). Q is lean-only; E is mount/interact + lean-right hold.
      leanLeftHeld: this.actions.has('leanLeft'),
      leanRightHeld: this.actions.has('mount'),
      // X held: inspect gun while firearm is drawn (WeaponSystem).
      inspectHeld: this.actions.has('inspect'),
      telekinesisPressed,
      telekinesisReleased,
      telekinesisHeld: this.actions.has('telekinesis'),
      // Hook flags start false; AbilitySystem fills them when swing is equipped.
      hookFire: false,
      hookFirePressed: false,
      hookFireDoubleTapped: false,
      hookAimHeld: this.actions.has('hookAim'),
      hookReleasePressed: jumpPressed,
      dodgeDirection: GAME_CONFIG.character.enableDodge ? dodgeDirection : null,
      jumpDoubleTapped: GAME_CONFIG.character.enableAirDash ? jumpDoubleTapped : false,
      // Double-tap Space edge for wingsuit (AbilitySystem enables only while glider equipped).
      wingsuitTogglePressed,
      // Q held: vehicle rear-view (GameRuntime) + cover lean left.
      wingsuitHeld: this.actions.has('leanLeft'),
      rearViewHeld: this.actions.has('leanLeft'),
      ...elevatorFloors,
    };
  }

  dispose() {
    globalThis.removeEventListener('keydown', this.handleKeyDown);
    globalThis.removeEventListener('keyup', this.handleKeyUp);
    this.target.removeEventListener('mousedown', this.handleMouseDown);
    globalThis.removeEventListener('mouseup', this.handleMouseUp);
    this.target.removeEventListener('contextmenu', this.handleContextMenu);
    globalThis.removeEventListener('mousemove', this.handleMouseMove);
    this.target.removeEventListener('wheel', this.handleWheel);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    globalThis.removeEventListener('blur', this.handleBlur);
    this.actions.clear();
    this.pressedActions.clear();
    this.releasedActions.clear();
    this.lookDelta.x = 0;
    this.lookDelta.y = 0;
    this.zoomDelta = 0;
    this.mousePrimaryPressed = false;
    this.mouseSecondaryPressed = false;
    this.mouseMiddlePressed = false;
    this.mousePrimaryHeld = false;
    this.mouseSecondaryHeld = false;
    this.mouseMiddleHeld = false;
    this.wallRunJumpHold = false;
    this.abilityDoubleTapPending = false;
  }

  handleKeyDown(event) {
    const action = KEY_BINDINGS[event.code];

    if (!action) {
      return;
    }

    const wasActive = this.actions.has(action);

    if (action === 'telekinesis') {
      this.pressedActions.add(action);
    }

    if (
      (action === 'jump' || action === 'left' || action === 'right' || action === 'brace' || action === 'slide' || action === 'collisionDebug' || action === 'mount' || action === 'ability' || action === 'drawSheathe' || action === 'grabSlam' || action === 'shoulderThrow' || action === 'cutMode' || action === 'photoMode' || action === 'cutCommit' || action === 'cutCancel' || action === 'telekinesis') &&
      !event.repeat &&
      !wasActive
    ) {
      this.pressedActions.add(action);
    }

    if (action === 'jump' && !event.repeat && !wasActive) {
      const now = event.timeStamp * 0.001;
      const doubleTap = now - this.lastJumpPressTime <= JUMP_DOUBLE_TAP_SECONDS;
      this.wallRunJumpHold = doubleTap;
      if (doubleTap) {
        this.jumpDoubleTapRaw = true; // raw edge — AbilitySystem may use for wingsuit
      }
      if (doubleTap && GAME_CONFIG.character.enableAirDash) {
        this.jumpDoubleTapPending = true; // air-dash edge (yielded to wall-run in MovementSystem)
      }
      this.lastJumpPressTime = now;
    }

    if (action === 'ability' && !event.repeat && !wasActive) {
      const now = event.timeStamp * 0.001;
      if (now - (this.lastAbilityPressTime ?? -Infinity) <= ABILITY_DOUBLE_TAP_SECONDS) {
        this.abilityDoubleTapPending = true; // dual-rope pull-launch when swing equipped
      }
      this.lastAbilityPressTime = now;
    }

    if ((action === 'forward' || action === 'backward' || action === 'left' || action === 'right') && !event.repeat && !wasActive) {
      const now = event.timeStamp * 0.001;
      if (now - (this.lastDirectionPress[action] ?? -Infinity) <= DODGE_DOUBLE_TAP_SECONDS && GAME_CONFIG.character.enableDodge) {
        this.dodgeDirectionPending = DODGE_VECTORS[action];
      }
      this.lastDirectionPress[action] = now;
    }

    this.actions.add(action);
    event.preventDefault();
  }

  handleKeyUp(event) {
    const action = KEY_BINDINGS[event.code];

    if (!action) {
      return;
    }

    if ((action === 'jump' || action === 'cutMode' || action === 'telekinesis') && this.actions.has(action)) {
      this.releasedActions.add(action);
    }

    if (action === 'jump' && this.actions.has(action)) {
      this.wallRunJumpHold = false;
    }

    this.actions.delete(action);
    event.preventDefault();
  }

  handleMouseDown(event) {
    this.target.focus({ preventScroll: true });

    if (event.button === 0) {
      this.mousePrimaryPressed = true;
      this.mousePrimaryHeld = true;

      if (document.pointerLockElement !== this.target) {
        this.target.requestPointerLock?.();
      }
    } else if (event.button === 1) {
      this.mouseMiddlePressed = true;
      this.mouseMiddleHeld = true;

      if (document.pointerLockElement !== this.target) {
        this.target.requestPointerLock?.();
      }
    } else if (event.button === 2) {
      // Right-click = heavy attack (combat) / ADS when gun out.
      // Prevent the context menu separately via handleContextMenu.
      this.mouseSecondaryPressed = true;
      this.mouseSecondaryHeld = true;
    }
  }

  handleMouseUp(event) {
    if (event.button === 0) this.mousePrimaryHeld = false;
    else if (event.button === 1) this.mouseMiddleHeld = false;
    else if (event.button === 2) this.mouseSecondaryHeld = false;
  }

  handleContextMenu(event) {
    // Right-click is a combat input; suppress the browser context menu over the canvas.
    event.preventDefault();
  }

  handleMouseMove(event) {
    const pointerLocked = document.pointerLockElement === this.target;
    const dragging = event.buttons > 0 && event.target === this.target;

    if (!pointerLocked && !dragging) {
      return;
    }

    this.lookDelta.x += event.movementX;
    this.lookDelta.y += event.movementY;
  }

  handleWheel(event) {
    this.zoomDelta += Math.sign(event.deltaY);
    event.preventDefault();
  }

  handlePointerLockChange() {
    this.pointerLocked = document.pointerLockElement === this.target;
    if (!this.pointerLocked) {
      this.mousePrimaryHeld = false;
      this.mouseSecondaryHeld = false;
      this.mouseMiddleHeld = false;
    }
  }

  handleBlur() {
    this.actions.clear();
    this.pressedActions.clear();
    this.releasedActions.clear();
    this.wallRunJumpHold = false;
    this.lookDelta.x = 0;
    this.lookDelta.y = 0;
    this.zoomDelta = 0;
    this.mousePrimaryPressed = false;
    this.mouseSecondaryPressed = false;
    this.mouseMiddlePressed = false;
    this.mousePrimaryHeld = false;
    this.mouseSecondaryHeld = false;
    this.mouseMiddleHeld = false;
    this.abilityDoubleTapPending = false;
    this.jumpDoubleTapRaw = false;
  }
}
