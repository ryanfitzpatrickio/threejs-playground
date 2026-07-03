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
  KeyC: 'slide',
  KeyF: 'mount',
  KeyT: 'telekinesis',
  KeyG: 'grabSlam',
  KeyQ: 'wingsuit',
  KeyZ: 'drawSheathe',
  KeyE: 'hookFire',
  KeyR: 'shoulderThrow',
  KeyV: 'cutMode',
  KeyK: 'photoMode',
  Enter: 'cutCommit',
  Escape: 'cutCancel',
};

const JUMP_DOUBLE_TAP_SECONDS = 0.48;
const DODGE_DOUBLE_TAP_SECONDS = 0.3;
const HOOK_DOUBLE_TAP_SECONDS = 0.3;

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
    this.pointerLocked = false;
    this.lastJumpPressTime = -Infinity;
    this.lastHookFirePressTime = -Infinity;
    this.hookFireDoubleTapPending = false; // one-frame edge (dual-rope pull launch)
    this.wallRunJumpHold = false;
    this.lastDirectionPress = { forward: -Infinity, backward: -Infinity, left: -Infinity, right: -Infinity };
    this.dodgeDirectionPending = null; // {x, z} | null — one-frame edge
    this.jumpDoubleTapPending = false; // one-frame edge (air-dash)
    this.wingsuitPressed = false; // one-frame edge (glider deploy via Q)
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseDown = this.handleMouseDown.bind(this);
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
    const hookFirePressed = this.pressedActions.has('hookFire') || this.mouseMiddlePressed;
    const hookFireDoubleTapped = this.hookFireDoubleTapPending;
    this.hookFireDoubleTapPending = false;
    const dodgeDirection = this.dodgeDirectionPending;
    const jumpDoubleTapped = this.jumpDoubleTapPending;
    const wingsuitTogglePressed = this.jumpDoubleTapRaw === true || this.wingsuitPressed === true;
    this.jumpDoubleTapRaw = false;
    this.wingsuitPressed = false;
    this.pressedActions.delete('jump');
    this.pressedActions.delete('left');
    this.pressedActions.delete('right');
    this.pressedActions.delete('brace');
    this.pressedActions.delete('slide');
    this.pressedActions.delete('collisionDebug');
    this.pressedActions.delete('mount');
    this.pressedActions.delete('drawSheathe');
    this.pressedActions.delete('grabSlam');
    this.pressedActions.delete('shoulderThrow');
    this.pressedActions.delete('cutMode');
    this.pressedActions.delete('photoMode');
    this.pressedActions.delete('cutCommit');
    this.pressedActions.delete('cutCancel');
    this.pressedActions.delete('telekinesis');
    this.pressedActions.delete('hookFire');
    this.dodgeDirectionPending = null;
    this.jumpDoubleTapPending = false;
    this.releasedActions.delete('jump');
    this.releasedActions.delete('cutMode');
    this.releasedActions.delete('telekinesis');
    const lookX = this.lookDelta.x;
    const lookY = this.lookDelta.y;
    const zoomDelta = this.zoomDelta;
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
      telekinesisPressed,
      telekinesisReleased,
      telekinesisHeld: this.actions.has('telekinesis'),
      hookFire: this.actions.has('hookFire'),
      hookFirePressed,
      hookFireDoubleTapped,
      hookReleasePressed: jumpPressed,
      dodgeDirection: GAME_CONFIG.character.enableDodge ? dodgeDirection : null,
      jumpDoubleTapped: GAME_CONFIG.character.enableAirDash ? jumpDoubleTapped : false,
      // Raw edge for glider/wingsuit deploy (double-tap jump or single Q press).
      // Independent of air-dash flag.
      wingsuitTogglePressed,
    };
  }

  dispose() {
    globalThis.removeEventListener('keydown', this.handleKeyDown);
    globalThis.removeEventListener('keyup', this.handleKeyUp);
    this.target.removeEventListener('mousedown', this.handleMouseDown);
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
    this.wallRunJumpHold = false;
    this.wingsuitPressed = false;
  }

  handleKeyDown(event) {
    const action = KEY_BINDINGS[event.code];

    if (!action) {
      return;
    }

    const wasActive = this.actions.has(action);

    if (action === 'telekinesis' || action === 'hookFire') {
      this.pressedActions.add(action);
    }

    if (
      (action === 'jump' || action === 'left' || action === 'right' || action === 'brace' || action === 'slide' || action === 'collisionDebug' || action === 'mount' || action === 'drawSheathe' || action === 'grabSlam' || action === 'shoulderThrow' || action === 'cutMode' || action === 'photoMode' || action === 'cutCommit' || action === 'cutCancel' || action === 'telekinesis' || action === 'hookFire') &&
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
        this.jumpDoubleTapRaw = true; // raw edge — consumed by the wingsuit toggle
      }
      if (doubleTap && GAME_CONFIG.character.enableAirDash) {
        this.jumpDoubleTapPending = true; // air-dash edge (yielded to wall-run in MovementSystem)
      }
      this.lastJumpPressTime = now;
    }

    if (action === 'wingsuit' && !event.repeat && !wasActive) {
      this.wingsuitPressed = true;
    }

    if (action === 'hookFire' && !event.repeat && !wasActive) {
      const now = event.timeStamp * 0.001;
      if (now - (this.lastHookFirePressTime ?? -Infinity) <= HOOK_DOUBLE_TAP_SECONDS) {
        this.hookFireDoubleTapPending = true; // dual-rope pull-launch edge
      }
      this.lastHookFirePressTime = now;
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

      if (document.pointerLockElement !== this.target) {
        this.target.requestPointerLock?.();
      }
    } else if (event.button === 1) {
      this.mouseMiddlePressed = true;

      if (document.pointerLockElement !== this.target) {
        this.target.requestPointerLock?.();
      }
    } else if (event.button === 2) {
      // Right-click = heavy attack (combat). Prevent the context menu separately
      // via handleContextMenu so the button-2 press still registers here.
      this.mouseSecondaryPressed = true;
    }
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
    this.wingsuitPressed = false;
  }
}
