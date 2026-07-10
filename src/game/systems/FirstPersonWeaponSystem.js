/**
 * FirstPersonWeaponSystem (M3 + M4)
 *
 * On-foot first-person: head hide, spine aim, body yaw neck clamp, traversal gate,
 * gun equip, weapon-hand anchor + CCDIK (M4).
 */

import { GAME_CONFIG } from '../config/gameConfig.js';
import {
  applyFirstPersonBodyYaw,
  chooseLocomotion,
  isFirstPersonForwardIntent,
  mapLocomotionToPlaybackState,
  movementToLocomotionAxes,
  resolveSpineAimBones,
  setHeadHidden,
} from '../characters/player/firstPersonRig.js';
import { resolveWeaponLocomotionState } from '../characters/player/weaponLocomotion.js';
import { createFirstPersonHandIk } from '../characters/player/firstPersonHandIk.js';
import { defaultGunIdFromQuery, loadGunView } from '../weapons/loadGunView.js';
import { applyGunSocketPreset } from '../weapons/gunDebugSocket.js';

export class FirstPersonWeaponSystem {
  constructor() {
    this.active = false;
    this.fp = false;
    this.armed = false;
    this.locomotionKey = 'idle';
    this.playbackState = 'armedIdle';
    this.spineAimBones = [];
    this._characterRef = null;
    this._headHidden = false;
    this.gateTraversal = true;

    /** @type {import('../characters/player/firstPersonHandIk.js').HandIkRig|null} */
    this.handIk = null;
    /** @type {import('../weapons/loadGunView.js').GunView|null} */
    this.gunView = null;
    this.equippedGunId = null;
    this._equipPromise = null;
    this._equipToken = 0;
    this._equipAttemptedId = null;
    this._ikSetupFailed = false;
    this.visibleWeapon = false;
    /** When true, gun is put away (Z holster / sword selected). */
    this.holstered = true;
  }

  /**
   * Hide/show the equipped firearm without disposing it.
   * @param {boolean} holstered
   */
  setHolstered(holstered) {
    this.holstered = Boolean(holstered);
    if (this.holstered) {
      this._setWeaponVisible(false);
    } else if (this.active && this.gunView) {
      this._setWeaponVisible(true);
    }
  }

  initialize() {
    // no-op
  }

  start({ character } = {}) {
    this._bindCharacter(character);
  }

  _bindCharacter(character) {
    this._characterRef = character ?? null;
    const root = character?.animationController?.modelRoot
      || character?.modelRoot
      || character?.group;
    this.spineAimBones = root ? resolveSpineAimBones(root) : [];
    this._teardownIk();
    this._ikSetupFailed = false;
  }

  _ensureIk(character) {
    if (this.handIk?.ready) return this.handIk;
    if (this._ikSetupFailed) return null;
    const modelRoot = character?.animationController?.modelRoot
      || character?.modelRoot
      || null;
    if (!modelRoot) return null;
    // Parent weapon anchor to character.group so it tracks world pose with the
    // character; IK targets convert through bodyRoot (= character.group when available).
    const bodyRoot = character.group || modelRoot;
    this.handIk = createFirstPersonHandIk(modelRoot, bodyRoot);
    if (!this.handIk) {
      this._ikSetupFailed = true;
      console.warn('[FirstPersonWeaponSystem] hand IK setup failed');
    }
    return this.handIk;
  }

  _teardownIk() {
    if (this.gunView && this.handIk) {
      this.handIk.setWeapon(null);
    }
    this.handIk?.dispose?.();
    this.handIk = null;
  }

  /**
   * Equip a catalog gun (async). Safe to call repeatedly; last call wins.
   * @param {string} [gunId]
   */
  async equipGun(gunId = defaultGunIdFromQuery()) {
    const token = ++this._equipToken;
    this._equipAttemptedId = gunId;
    this._equipPromise = (async () => {
      try {
        const view = await loadGunView(gunId);
        if (token !== this._equipToken) {
          view.dispose();
          return null;
        }
        if (this.gunView) {
          this.handIk?.setWeapon(null);
          this.gunView.dispose();
        }
        this.gunView = view;
        this.equippedGunId = view.id;
        // Load per-gun hand / support-IK defaults (e.g. midnight-glock fit).
        applyGunSocketPreset(view.id);
        const character = this._characterRef;
        if (character) {
          const ik = this._ensureIk(character);
          ik?.setWeapon(view.root, view.anchors);
          ik?.layoutGunInHand?.({ force: true });
        }
        this._setWeaponVisible(this.active);
        return view;
      } catch (err) {
        console.warn('[FirstPersonWeaponSystem] equipGun failed', gunId, err);
        return null;
      } finally {
        if (token === this._equipToken) {
          this._equipPromise = null;
        }
      }
    })();
    return this._equipPromise;
  }

  _setWeaponVisible(visible) {
    this.visibleWeapon = Boolean(visible);
    if (this.gunView?.root) {
      this.gunView.root.visible = this.visibleWeapon;
    }
  }

  /**
   * Called early in the frame (before traversal/combat) to gate input when FP armed.
   * Gun stance only when a firearm is the drawn loadout weapon (WeaponSystem).
   *
   * @param {{ input: object, character: object, cameraSystem: object, weaponSystem?: object }} ctx
   */
  processInput({ input, character, cameraSystem, weaponSystem = null }) {
    const fp = Boolean(cameraSystem?.usesOnFootFirstPerson?.());
    const driving = Boolean(character?.vehicle);
    const gunDrawn = weaponSystem
      ? weaponSystem.isGunDrawn()
      : (!this.holstered && Boolean(this.gunView));
    // The gun hold (equip / visibility / hand IK / weaponClass / firing) runs in
    // BOTH first and third person. `fp` only gates the FP-camera extras (head hide,
    // FP body yaw, full-body animationOverride).
    this.armed = Boolean(gunDrawn && !driving);
    this.fp = fp && this.armed;
    this.active = this.armed;

    if (!this.armed) {
      this._clearOverride(character);
      this._restoreHead(character);
      this._setWeaponVisible(false);
      return input;
    }

    if (character && character !== this._characterRef) {
      this._bindCharacter(character);
    }

    // Ensure the equipped loadout gun is loaded (WeaponSystem picks the id).
    if (typeof window !== 'undefined' && window?.location) {
      const wantedGun = weaponSystem?.isGunEquipped?.()
        ? weaponSystem.equippedId
        : defaultGunIdFromQuery();
      if (wantedGun && !this.gunView && !this._equipPromise && this._equipAttemptedId !== wantedGun) {
        void this.equipGun(wantedGun);
      } else if (this.gunView && !this.holstered) {
        this._setWeaponVisible(true);
        if (!this.handIk) {
          const ik = this._ensureIk(character);
          ik?.setWeapon(this.gunView.root, this.gunView.anchors);
        }
      }
    }

    // Gate traversal while a firearm is drawn in FP.
    if (this.gateTraversal && input) {
      return {
        ...input,
        vaultPressed: false,
        wallRunPressed: false,
        wallClimbPressed: false,
        ledgeGrabPressed: false,
        slidePressed: false,
        ropePressed: false,
        wingsuitPressed: false,
        wingsuitTogglePressed: false,
        hookPressed: false,
        hookFirePressed: false,
        hookFire: false,
        hookFireDoubleTapped: false,
        abilityPressed: false,
      };
    }

    return input;
  }

  /**
   * After movement, set combat.animationOverride from locomotion key when FP packs exist.
   */
  update({ delta, input, movement, character, cameraSystem, weaponSystem = null }) {
    const fp = Boolean(cameraSystem?.usesOnFootFirstPerson?.());
    const driving = Boolean(character?.vehicle);
    const gunDrawn = weaponSystem
      ? weaponSystem.isGunDrawn()
      : (!this.holstered && Boolean(this.gunView));
    this.armed = Boolean(gunDrawn && !driving);
    this.fp = fp && this.armed;
    this.active = this.armed;

    if (!character) return;

    if (!this.armed) {
      this._clearOverride(character);
      this._restoreHead(character);
      this._setWeaponVisible(false);
      return;
    }

    if (character !== this._characterRef || this.spineAimBones.length === 0) {
      this._bindCharacter(character);
      if (this.gunView) {
        const ik = this._ensureIk(character);
        ik?.setWeapon(this.gunView.root, this.gunView.anchors);
      }
    }

    // Don't fight sword combat overrides mid-attack/draw.
    const combat = character.combat;
    if (combat?.attack || (combat?.weapon && combat.weapon !== 'sheathed' && combat.weapon !== 'armed')) {
      if (this.fp) this._ensureHeadHidden(character);
      else this._restoreHead(character);
      this._setWeaponVisible(false);
      return;
    }

    const { forward, strafe } = movementToLocomotionAxes(movement, input);
    const sprinting = Boolean(
      input?.sprint
      || input?.sprintHeld
      || input?.brace
      || (movement?.speed ?? 0) > 5.5,
    );
    const grounded = !(movement?.airborne);
    // Any equipped gun animates; default an unknown/kindless view to the rifle
    // family (never fall back to open-handed unarmed with a visible gun).
    const weaponKind = this.gunView?.gun?.weaponKind
      ?? (this.gunView?.root ? 'rifle' : null);
    const aiming = Boolean(character.combat?.aiming);
    const stance = character.combat?.stance === 'crouch' ? 'crouch' : 'stand';

    // Shared FP/TP resolver drives the 8-way / crouch / aim clip choice.
    const resolved = weaponKind
      ? resolveWeaponLocomotionState({
        weaponKind, stance, aiming, forward, strafe, sprinting, grounded,
        turning: character.combat?.turning ?? null,
      })
      : null;
    this.locomotionKey = resolved?.state ?? 'idle';

    if (!character.combat) {
      character.combat = {
        weapon: 'sheathed',
        armed: false,
        animationOverride: null,
        comboStep: 0,
        attack: null,
        lockMovement: false,
        bufferedLight: false,
        sword: null,
      };
    }

    const hasGun = Boolean(this.gunView?.root);
    const ctrl = character.animationController;
    // Gun out → weapon locomotion (rifle_/pistol_ 8-way) with a graceful fallback
    // to the legacy fp_*/armed* pack while the richer clips stream in. Never leave
    // unarmed idle/jog playing with a visible gun (open palms + floating rifle).
    if (hasGun && resolved) {
      let state = resolved.state;
      if (!ctrl?.hasState?.(state)) {
        // Not loaded yet → legacy single-direction fallback.
        const hasWeaponPack = Boolean(ctrl?.hasState?.('fp_idle'));
        const legacyKey = chooseLocomotion({ forward, strafe, running: sprinting, grounded });
        state = mapLocomotionToPlaybackState(legacyKey, { hasWeaponPack });
        if (!ctrl?.hasState?.(state)) {
          state = ctrl?.hasState?.('fp_idle')
            ? 'fp_idle'
            : (ctrl?.hasState?.('armedIdle') ? 'armedIdle' : 'idle');
        }
      }
      this.playbackState = state;
      // weaponClass drives the shared resolver in BOTH modes (third person via the
      // AnimationStateSystem weaponClass branch + MovementSystem aim/turn).
      character.combat.weaponClass = resolved.kind;
      if (this.fp) {
        // First person owns a full-body clip via animationOverride (short-circuits
        // AnimationStateSystem). Third person leaves it null so that system's own
        // weaponClass branch resolves (correct velocity/aim facing + footwork/reload).
        character.combat.fpWeaponStance = true;
        character.combat.animationOverride = state;
      } else {
        character.combat.fpWeaponStance = false;
        const ov = character.combat.animationOverride;
        if (ov && (ov.startsWith('fp_') || ov.startsWith('armed') || ov.startsWith('rifle_') || ov.startsWith('pistol_'))) {
          character.combat.animationOverride = null;
        }
      }
      if (character.combat.weapon === 'sheathed') {
        character.combat.armed = false;
      }
    } else {
      this.playbackState = 'locomotion';
      character.combat.fpWeaponStance = false;
      character.combat.weaponClass = null;
      const ov = character.combat.animationOverride;
      if (ov && (ov.startsWith('fp_') || ov.startsWith('armed') || ov.startsWith('rifle_') || ov.startsWith('pistol_'))) {
        character.combat.animationOverride = null;
      }
      if (character.combat.weapon === 'sheathed') {
        character.combat.armed = false;
      }
    }

    if (this.fp) this._ensureHeadHidden(character);
    else this._restoreHead(character);
    this._setWeaponVisible(true);
  }

  /**
   * After AnimationStateSystem mixer write:
   * gun on right hand, optional left-hand IK onto support (debug-tunable).
   * No spine-aim curl (camera-only look pitch).
   */
  postAnimation({ character, cameraSystem }) {
    if (!this.active || !character) return;

    // Intentionally skip applySpineAimPitch while a gun is out — look pitch is
    // camera-only so the torso doesn't fold into the view frustum.
    void cameraSystem;

    const root = character.animationController?.modelRoot || character.group;
    root?.updateMatrixWorld?.(true);

    if (!this.gunView) return;
    const ik = this.handIk || this._ensureIk(character);
    if (!ik?.ready) return;

    if (this.gunView.root && this.gunView.root.parent !== ik.weaponAnchor) {
      ik.setWeapon(this.gunView.root, this.gunView.anchors);
    }

    ik.updateWeaponFromRightHand?.();
    // Left support after gun is laid out so left_hand_ik_target is current. During
    // a reload the support hand grabs the magazine (from the reload clip), so don't
    // pin it back onto the gun's foregrip.
    if (!character.combat?.reloading) {
      ik.updateLeftHandIk?.();
    }
    root?.updateMatrixWorld?.(true);
  }

  /**
   * After CameraSystem look input: body yaw neck clamp / forward straighten.
   */
  postCamera({ character, cameraSystem, input = null, delta = 1 / 60 }) {
    // FP-only: the third-person aim-facing yaw is owned by MovementSystem.
    if (!this.fp || !character?.group || !cameraSystem) return;
    const cam = GAME_CONFIG.camera;
    const maxNeckYaw = cam.onFootFirstPersonMaxNeckYaw ?? 0.72;
    // A visible shoulder weapon must follow the view yaw. Leaving the body at
    // the unarmed neck-limit offset aims the rifle ~40 degrees off-camera and
    // pushes the entire hold out of frame even when the clip itself is valid.
    const weaponAimLocked = Boolean(this.gunView && this.visibleWeapon);
    applyFirstPersonBodyYaw(character.group, cameraSystem.yaw, {
      maxNeckYaw,
      straighten: weaponAimLocked || isFirstPersonForwardIntent(input, character),
      delta,
      straightenSmoothing: cam.onFootFirstPersonStraightenSmoothing ?? 16,
    });
    character.fpBodyYawLocked = true;
  }

  _ensureHeadHidden(character) {
    const root = character?.animationController?.modelRoot || character?.group;
    if (!root) return;
    setHeadHidden(root, true);
    this._headHidden = true;
    if (character.group) character.group.visible = true;
  }

  _restoreHead(character) {
    if (!this._headHidden) return;
    const root = character?.animationController?.modelRoot
      || character?.group
      || this._characterRef?.animationController?.modelRoot
      || this._characterRef?.group;
    if (root) setHeadHidden(root, false);
    this._headHidden = false;
  }

  _clearOverride(character) {
    if (!character?.combat?.fpWeaponStance) return;
    character.combat.fpWeaponStance = false;
    character.combat.weaponClass = null;
    if (!character.combat.attack
      && (character.combat.animationOverride === this.playbackState
        || character.combat.animationOverride?.startsWith?.('armed')
        || character.combat.animationOverride?.startsWith?.('fp_')
        || character.combat.animationOverride?.startsWith?.('rifle_')
        || character.combat.animationOverride?.startsWith?.('pistol_'))) {
      character.combat.animationOverride = null;
    }
    if (character.combat.weapon === 'sheathed') {
      character.combat.armed = false;
    }
  }

  snapshot() {
    const ikMeasure = this.handIk?.measure?.() ?? null;
    return {
      active: this.active,
      locomotionKey: this.locomotionKey,
      playbackState: this.playbackState,
      spineBones: this.spineAimBones.length,
      headHidden: this._headHidden,
      gateTraversal: this.gateTraversal,
      equippedGunId: this.equippedGunId,
      weaponVisible: this.visibleWeapon,
      handIk: ikMeasure,
      gun: this.gunView?.gun?.snapshot?.() ?? null,
    };
  }

  dispose() {
    this._equipToken += 1;
    this._restoreHead(this._characterRef);
    if (this.gunView) {
      this.handIk?.setWeapon(null);
      this.gunView.dispose();
      this.gunView = null;
    }
    this._teardownIk();
    this._characterRef = null;
    this.spineAimBones = [];
    this.equippedGunId = null;
  }
}
