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
  // C: crouch hold when slow; tap while running/sprinting starts a slide
  // (SlideSystem promotes crouchPressed → slide when speed ≥ threshold).
  KeyC: 'crouch',
  // F activates the equipped ability (swing / wingsuit).
  KeyF: 'ability',
  KeyT: 'telekinesis',
  KeyG: 'grabSlam',
  // Q: lean modifier (hold + A/D to peek left/right when armed) + vehicle rear-view hold.
  KeyQ: 'leanMod',
  // Z: holster / draw equipped weapon (WeaponSystem loadout).
  KeyZ: 'drawSheathe',
  // E: enter/exit vehicle, horse, doors, and other use/interact actions.
  KeyE: 'mount',
  // H: roof-surf seat swap while driving (cabin ↔ roof stunt position).
  KeyH: 'roofSurf',
  // Optional alias for car leap (primary is Space while roof-surfing).
  KeyL: 'carLeap',
  // 1–3: loadout (sword / pistol / random rifle). 1–9 also elevator floors at a cab.
  Digit1: 'gunSlot1',
  Digit2: 'gunSlot2',
  Digit3: 'gunSlot3',
  Digit4: 'gunSlot4',
  Digit5: 'gunSlot5',
  Digit6: 'gunSlot6',
  Digit7: 'gunSlot7',
  Digit8: 'gunSlot8',
  Digit9: 'gunSlot9',
  Digit0: 'gunSlot0',
  AltLeft: 'hookAim',
  AltRight: 'hookAim',
  // Ctrl: dedicated slide (same as tap-C while running).
  ControlLeft: 'slide',
  ControlRight: 'slide',
  // X: inspect equipped gun (hold).
  KeyX: 'inspect',
  KeyR: 'reload',
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
    this.mousePrimaryReleased = false;
    this.pointerLocked = false;
    this.pointerLockEnabled = true;
    this.pointerNdc = { x: 0, y: 0 };
    this.pointerClickNdc = { x: 0, y: 0 };
    this.mousePrimaryReleased = false;
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

  setPointerLockEnabled(enabled) {
    this.pointerLockEnabled = enabled !== false;
    if (!this.pointerLockEnabled && document.pointerLockElement === this.target) {
      document.exitPointerLock?.();
    }
  }

  getState() {
    const jumpPressed = this.pressedActions.has('jump');
    const jumpReleased = this.releasedActions.has('jump');
    const leftPressed = this.pressedActions.has('left');
    const rightPressed = this.pressedActions.has('right');
    const bracePressed = this.pressedActions.has('brace');
    const slidePressed = this.pressedActions.has('slide');
    const crouchPressed = this.pressedActions.has('crouch');
    const collisionDebugPressed = this.pressedActions.has('collisionDebug');
    const mountPressed = this.pressedActions.has('mount');
    const roofSurfPressed = this.pressedActions.has('roofSurf');
    const carLeapPressed = this.pressedActions.has('carLeap');
    const carLeapReleased = this.releasedActions.has('carLeap');
    const abilityPressed = this.pressedActions.has('ability');
    const abilityDoubleTapped = this.abilityDoubleTapPending;
    const drawSheathePressed = this.pressedActions.has('drawSheathe');
    const grabSlamPressed = this.pressedActions.has('grabSlam');
    const reloadPressed = this.pressedActions.has('reload');
    // Preserve R's legacy unarmed shoulder throw outside camera mode, while
    // keeping reload as a separately routable action for locked live-camera play.
    const shoulderThrowPressed = reloadPressed;
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
    // Gun hotkeys 1–9 → slots 0–8, 0 → slot 9. Elevators still use 1–9 as floor picks.
    let gunSlotPressed = null;
    for (let i = 1; i <= 9; i += 1) {
      if (this.pressedActions.has(`gunSlot${i}`)) gunSlotPressed = i - 1;
    }
    if (this.pressedActions.has('gunSlot0')) gunSlotPressed = 9;
    const elevatorFloors = {};
    for (let i = 1; i <= 9; i += 1) {
      elevatorFloors[`elevatorFloor${i}`] = this.pressedActions.has(`gunSlot${i}`);
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
    this.pressedActions.delete('crouch');
    this.pressedActions.delete('collisionDebug');
    this.pressedActions.delete('mount');
    this.pressedActions.delete('roofSurf');
    this.pressedActions.delete('carLeap');
    this.pressedActions.delete('ability');
    this.pressedActions.delete('drawSheathe');
    this.pressedActions.delete('grabSlam');
    this.pressedActions.delete('reload');
    this.pressedActions.delete('shoulderThrow');
    this.pressedActions.delete('cutMode');
    this.pressedActions.delete('photoMode');
    this.pressedActions.delete('cutCommit');
    this.pressedActions.delete('cutCancel');
    this.pressedActions.delete('telekinesis');
    for (let i = 1; i <= 9; i += 1) this.pressedActions.delete(`gunSlot${i}`);
    this.pressedActions.delete('gunSlot0');
    this.dodgeDirectionPending = null;
    this.jumpDoubleTapPending = false;
    this.releasedActions.delete('jump');
    this.releasedActions.delete('carLeap');
    this.releasedActions.delete('cutMode');
    this.releasedActions.delete('telekinesis');
    const lookX = this.lookDelta.x;
    const lookY = this.lookDelta.y;
    const zoomDelta = this.zoomDelta;
    const mouseMiddlePressed = this.mouseMiddlePressed;
    const mousePrimaryReleased = this.mousePrimaryReleased;
    const pointerNdc = { ...this.pointerNdc };
    const pointerClickNdc = { ...this.pointerClickNdc };
    this.lookDelta.x = 0;
    this.lookDelta.y = 0;
    this.zoomDelta = 0;
    this.mousePrimaryPressed = false;
    this.mouseSecondaryPressed = false;
    this.mouseMiddlePressed = false;
    this.mousePrimaryReleased = false;

    // Hold Q: A/D lean instead of strafe (and vehicle rear-view). W/S stay free.
    const leanModHeld = this.actions.has('leanMod');
    const leftHeld = this.actions.has('left');
    const rightHeld = this.actions.has('right');

    return {
      moveX: leanModHeld ? 0 : Number(rightHeld) - Number(leftHeld),
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
      leftPressed: leanModHeld ? false : leftPressed,
      rightPressed: leanModHeld ? false : rightPressed,
      slidePressed,
      slide: this.actions.has('slide'),
      // Edge for C: SlideSystem may promote to slide when running.
      crouchPressed,
      collisionDebugPressed,
      mountPressed,
      roofSurfPressed,
      carLeapPressed,
      carLeapHeld: this.actions.has('carLeap'),
      carLeapReleased,
      abilityPressed,
      abilityHeld: this.actions.has('ability'),
      abilityDoubleTapped,
      drawSheathePressed,
      grabSlamPressed,
      shoulderThrowPressed,
      reloadPressed,
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
      mousePrimaryPressed: lightAttackPressed,
      mousePrimaryReleased,
      pointerNdc,
      pointerClickNdc,
      // Hold C to crouch when not at slide speed (weapon-locomotion stance layer).
      crouchHeld: this.actions.has('crouch'),
      // Cover-peek: hold Q, then A/D lean left/right (armed). E stays pure use/interact.
      leanLeftHeld: leanModHeld && leftHeld,
      leanRightHeld: leanModHeld && rightHeld,
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
      // Q-held A/D is lean only — don't also fire a dodge from the same press.
      dodgeDirection: (!leanModHeld && GAME_CONFIG.character.enableDodge) ? dodgeDirection : null,
      jumpDoubleTapped: GAME_CONFIG.character.enableAirDash ? jumpDoubleTapped : false,
      // Double-tap Space edge for wingsuit (AbilitySystem enables only while glider equipped).
      wingsuitTogglePressed,
      // Q held: vehicle rear-view (GameRuntime). Legacy alias kept for rear-view fallback.
      wingsuitHeld: this.actions.has('leanMod'),
      rearViewHeld: this.actions.has('leanMod'),
      // Catalog gun hotkey (0–9 index into GUN_CATALOG), or null.
      gunSlotPressed,
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
    this.mousePrimaryReleased = false;
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
      (action === 'jump' || action === 'left' || action === 'right' || action === 'brace' || action === 'slide' || action === 'crouch' || action === 'collisionDebug' || action === 'mount' || action === 'roofSurf' || action === 'carLeap' || action === 'ability' || action === 'drawSheathe' || action === 'grabSlam' || action === 'reload' || action === 'shoulderThrow' || action === 'cutMode' || action === 'photoMode' || action === 'cutCommit' || action === 'cutCancel' || action === 'telekinesis'
        || action === 'gunSlot0' || action === 'gunSlot1' || action === 'gunSlot2' || action === 'gunSlot3'
        || action === 'gunSlot4' || action === 'gunSlot5' || action === 'gunSlot6' || action === 'gunSlot7'
        || action === 'gunSlot8' || action === 'gunSlot9') &&
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

    // Edge-triggered releases used by hold-to-commit actions (jump, cut, leap…).
    if (
      (action === 'jump'
        || action === 'cutMode'
        || action === 'telekinesis'
        || action === 'carLeap')
      && this.actions.has(action)
    ) {
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
    this.updatePointerNdc(event);

    if (event.button === 0) {
      this.mousePrimaryPressed = true;
      this.mousePrimaryHeld = true;

      if (this.pointerLockEnabled && document.pointerLockElement !== this.target) {
        this.target.requestPointerLock?.();
      }
    } else if (event.button === 1) {
      this.mouseMiddlePressed = true;
      this.mouseMiddleHeld = true;

      if (this.pointerLockEnabled && document.pointerLockElement !== this.target) {
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
    if (event.button === 0) {
      this.mousePrimaryHeld = false;
      this.mousePrimaryReleased = true;
    }
    else if (event.button === 1) this.mouseMiddleHeld = false;
    else if (event.button === 2) this.mouseSecondaryHeld = false;
  }

  handleContextMenu(event) {
    // Right-click is a combat input; suppress the browser context menu over the canvas.
    event.preventDefault();
  }

  handleMouseMove(event) {
    this.updatePointerNdc(event);
    const pointerLocked = document.pointerLockElement === this.target;
    const dragging = event.buttons > 0 && event.target === this.target;

    if (!pointerLocked && !dragging) {
      return;
    }

    this.lookDelta.x += event.movementX;
    this.lookDelta.y += event.movementY;
  }

  updatePointerNdc(event) {
    const rect = this.target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    if (event.type === 'mousedown' && event.button === 0) {
      this.pointerClickNdc = { ...this.pointerNdc };
    }
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
