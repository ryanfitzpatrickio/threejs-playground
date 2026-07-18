import { createProceduralDog } from '../../../characters/dog/createProceduralDog.js';
import { normalizeRenderableDogBreedId } from '../../../characters/dog/dogCatalog.js';
import { DogPlayerController } from '../../../characters/dog/DogPlayerController.js';
import { DogClipPlayer } from '../../../characters/dog/DogClipPlayer.js';
import { DogMudContactHelper } from '../../../characters/dog/DogMudContactHelper.js';
import { DogCameraSystem } from '../../../systems/DogCameraSystem.js';
import { DogMudCoatController } from './DogMudCoatController.js';

const CONFIG_EVENT = 'dreamfall:dog-park-config';

/** @param {unknown} value */
function normalizeMouthState(value) {
  if (value === 'open' || value === 'alert' || value === 'closed') return value;
  return 'closed';
}

export class DogParkRuntimeFeature {
  constructor(host) {
    this.host = host;
    this.active = host.levelMode === 'dog-park';
    this.frameInput = null;
    this.dog = null;
    this.controller = null;
    this.clipPlayer = null;
    this.mudContact = null;
    this.mudCoat = null;
    this.camera = new DogCameraSystem();
    this.config = readDogConfig();
    this._onConfig = (event) => this.applyConfig(event.detail ?? {});
  }

  async initializeAfterLevel() {
    if (!this.active) return;
    this.host.inputSystem.setPointerLockEnabled(false);
    this.parkMainPlayer();
    this.spawnDog(this.config);
    globalThis.addEventListener?.(CONFIG_EVENT, this._onConfig);
  }

  spawnDog(config, { preservePose = false } = {}) {
    const previousPosition = preservePose && this.dog ? this.dog.root.position.clone() : null;
    const previousYaw = preservePose && this.dog ? this.dog.animation.getRootYaw() : 0;
    this.clipPlayer?.dispose?.();
    this.mudCoat?.dispose?.();
    this.mudCoat = null;
    this.dog?.dispose?.();

    const mouthState = normalizeMouthState(config.mouthState);
    const dog = createProceduralDog({
      breedId: normalizeRenderableDogBreedId(config.breedId),
      seed: Number.isFinite(Number(config.seed)) ? Number(config.seed) : 1,
      shellCount: Number.isFinite(Number(config.shellCount)) ? Number(config.shellCount) : undefined,
    });
    dog.setNakedBody(Boolean(config.naked));
    dog.setShowFur(config.showFur !== false);
    dog.animation.setMouthState(mouthState);
    dog.root.position.copy(previousPosition ?? this.host.levelSystem.level?.dogSpawnPoint ?? { x: 0, y: 0, z: 0 });
    dog.animation.setRootPosition(0, 0, 0);
    dog.animation.setRootYaw(previousYaw);
    this.host.sceneSystem.scene.add(dog.root);

    this.dog = dog;
    this.clipPlayer = null;
    if (dogClipModeEnabled()) {
      this.clipPlayer = new DogClipPlayer(dog);
      void this.clipPlayer.initialize();
    }
    if (this.controller) this.controller.setDog(dog);
    else {
      this.controller = new DogPlayerController({
        dog,
        levelSystem: this.host.levelSystem,
        camera: this.host.cameraSystem.camera,
      });
    }
    const level = this.host.levelSystem?.level;
    this.mudCoat = new DogMudCoatController({
      uniforms: dog.furUniforms,
      parent: this.host.sceneSystem.scene,
      camera: this.host.cameraSystem.camera,
      seed: dog.seed,
      groundHeightAt: (x, z, y) => level?.getGroundHeightAt?.({ x, y, z }, 0.02, {
        maxStepUp: 2,
        maxSnapDown: 4,
      }) ?? 0.055,
    });
    if (this.mudContact) this.mudContact.setDog(dog);
    else if (level?.mudField) {
      this.mudContact = new DogMudContactHelper({
        dog,
        levelSystem: this.host.levelSystem,
        mudField: level.mudField,
        onPawStamp: (stamp) => {
          if (level.addDogPawVisual?.(stamp)) this.mudCoat?.depositPawMud?.(stamp);
        },
      });
    }
    this.camera.initialize(this.host.cameraSystem.camera, dog.rig.root, { yaw: previousYaw + Math.PI });
    this.config = {
      ...this.config,
      ...config,
      breedId: dog.breedId,
      seed: dog.seed,
      shellCount: dog.shellCount,
      mouthState,
    };
  }

  applyConfig(next) {
    if (!this.active || !next || typeof next !== 'object') return;
    const merged = {
      ...this.config,
      ...next,
      mouthState: normalizeMouthState(next.mouthState ?? next.faceState ?? this.config.mouthState),
    };
    const needsRebuild = merged.breedId !== this.config.breedId
      || Number(merged.seed) !== Number(this.config.seed)
      || Number(merged.shellCount) !== Number(this.config.shellCount);
    if (needsRebuild) this.spawnDog(merged, { preservePose: true });
    else {
      this.config = merged;
      this.dog?.setNakedBody?.(Boolean(merged.naked));
      this.dog?.setShowFur?.(merged.showFur !== false);
      if (merged.behavior) this.dog?.animation?.setBehavior?.(merged.behavior);
      this.dog?.animation?.setMouthState?.(merged.mouthState);
    }
  }

  parkMainPlayer() {
    if (!this.active) return;
    const character = this.host.characterSystem?.character;
    if (!character) return;
    character.hiddenForDogPark = true;
    const park = this.host.levelSystem?.level?.spawnPoint;
    if (park && character.group) {
      character.group.position.copy(park);
      character.velocity?.set?.(0, 0, 0);
      if (typeof character.verticalVelocity === 'number') character.verticalVelocity = 0;
    }
    if (character.group) character.group.visible = false;
    if (character.wingsuitRig?.group) character.wingsuitRig.group.visible = false;
    if (character.proceduralJacket?.group) character.proceduralJacket.group.visible = false;
    const clothMesh = character.jacketCloth?.mesh ?? character.jacketCloth?.object ?? null;
    if (clothMesh) clothMesh.visible = false;
  }

  prepareInput(input) {
    if (!this.active) return input;
    const photoMode = Boolean(this.host.cameraSystem?.photoMode);
    // Freecam (K / Camera mode) needs look + WASD on the pipeline input.
    // The dog controller always reads frameInput — lock the dog while freecamming.
    this.frameInput = photoMode
      ? {
          ...input,
          moveX: 0,
          moveZ: 0,
          jump: false,
          jumpPressed: false,
          brace: false,
          bracePressed: false,
          crouchHeld: false,
          crouchPressed: false,
          drawSheathePressed: false,
          mountPressed: false,
          cutModePressed: false,
        }
      : input;

    if (photoMode) {
      // Pass freecam controls through; strip combat so Mara stays inert.
      return {
        ...input,
        lightAttackPressed: false,
        heavyAttackPressed: false,
        mousePrimaryPressed: false,
        drawSheathePressed: false,
        shoulderThrowPressed: false,
        cutModePressed: false,
        telekinesisPressed: false,
        hookFirePressed: false,
        abilityPressed: false,
        abilityDoubleTapped: false,
        wingsuitTogglePressed: false,
        mountPressed: false,
        gunSlotPressed: null,
        dodgeDirection: null,
      };
    }

    return {
      ...input,
      moveX: 0,
      moveZ: 0,
      lookX: 0,
      lookY: 0,
      zoomDelta: 0,
      lightAttackPressed: false,
      heavyAttackPressed: false,
      mousePrimaryHeld: false,
      mouseSecondaryHeld: false,
      mouseMiddleHeld: false,
      jump: false,
      jumpPressed: false,
      brace: false,
      bracePressed: false,
      crouchHeld: false,
      crouchPressed: false,
      slide: false,
      slidePressed: false,
      drawSheathePressed: false,
      shoulderThrowPressed: false,
      cutModePressed: false,
      telekinesisPressed: false,
      hookFirePressed: false,
      hookAimHeld: false,
      abilityPressed: false,
      abilityDoubleTapped: false,
      wingsuitTogglePressed: false,
      dodgeDirection: null,
      mountPressed: false,
      gunSlotPressed: null,
    };
  }

  updateDog(delta) {
    if (!this.active || !this.dog) return;
    this.parkMainPlayer();
    // Paused freecam freezes the sim earlier in the frame; live freecam still
    // advances the dog but locks player-driven actions (see frameInput above).
    if (this.host.cameraSystem?.photoMode && !this.host.cameraSystem?.photoModeLive) {
      return;
    }
    const input = this.frameInput ?? {};
    const photoMode = Boolean(this.host.cameraSystem?.photoMode);
    // Z (draw/sheathe on foot) → playful puddle splash (Death → hold → Idle).
    if (input.drawSheathePressed && !this.clipPlayer?.isBusy?.()) {
      this.clipPlayer?.playPuddleSplash?.();
    }
    const clipBusy = Boolean(this.clipPlayer?.isBusy?.());
    const actionLocked = clipBusy || photoMode;
    // While a clip one-shot owns the body, procedural pose must not reset bones
    // (that was wiping the held Death final frame every tick).
    this.dog.animation?.setClipDriven?.(clipBusy);
    this.controller.update(delta, { ...input, actionLocked });
    // The controller owns the jump arc; fire the (rotation-only) clip in sync.
    if (!actionLocked) {
      if (this.controller.jumpStartedThisFrame) this.clipPlayer?.playOneShot?.('Jump');
      else if (input.mountPressed) this.clipPlayer?.playOneShot?.('Bark');
    }
    this.clipPlayer?.update?.(delta, this.dog.animation.getBehavior());
    const yaw = this.dog.animation.getRootYaw();
    const headingX = Math.sin(yaw);
    const headingZ = Math.cos(yaw);
    if (this.clipPlayer?.consumePuddleImpact?.()) {
      const accepted = this.host.levelSystem?.level?.applyDogFlopImpact?.({
        position: this.dog.root.position,
        headingX,
        headingZ,
      });
      if (accepted) {
        this.mudCoat?.depositFlopMud?.({
          position: this.dog.root.position,
          headingX,
          headingZ,
          scale: this.dog.phenotype?.skeleton?.scale ?? 1,
        });
      }
    }
    // Paw bones must be sampled after the clip mixer has written the final pose.
    this.mudContact?.update?.(delta, {
      moving: !actionLocked && (this.controller.horizontalSpeed > 0.12
        || ['walk', 'trot'].includes(this.dog.animation.getBehavior())),
      airborne: this.controller.jumpPhase !== 'none',
      surfaceClass: this.controller.surfaceClass,
      headingX,
      headingZ,
      movementIntensity: Math.min(1, (this.controller.horizontalSpeed ?? 0) / 4.5),
    });
    this.mudCoat?.update?.(delta, { camera: this.host.cameraSystem.camera });
    this.host.levelSystem?.level?.updateMud?.(delta, this.dog.root.position);
  }

  updateCamera(delta) {
    if (!this.active) return;
    // Camera mode freecam owns the view — do not fight it with chase cam.
    if (this.host.cameraSystem?.photoMode) return;
    this.parkMainPlayer();
    const anim = this.dog?.animation;
    const controller = this.controller;
    this.camera.update(delta, this.frameInput ?? {}, {
      headingYaw: anim?.getRootYaw?.() ?? 0,
      yawRate: anim?.getYawRate?.() ?? 0,
      moving: (controller?.horizontalSpeed ?? 0) > 0.08
        || (anim?.getBehavior?.() === 'walk')
        || (anim?.getBehavior?.() === 'trot'),
      speed: controller?.horizontalSpeed
        ?? anim?.getMoveSpeed?.()
        ?? 0,
      forwardIntent: controller?.forwardIntent ?? 0,
    });
  }

  snapshot() {
    return {
      active: this.active,
      breedId: this.dog?.breedId ?? this.config.breedId,
      familyId: this.dog?.familyId ?? null,
      seed: this.dog?.seed ?? this.config.seed,
      shellCount: this.dog?.shellCount ?? this.config.shellCount,
      mouthState: this.dog?.animation?.getMouthState?.() ?? this.config.mouthState ?? 'closed',
      naked: this.dog?.getNakedBody?.() ?? Boolean(this.config.naked),
      dog: this.controller?.snapshot?.() ?? null,
      animationClips: this.clipPlayer?.snapshot?.() ?? { enabled: false, ready: false, clip: null, clips: 0 },
      mud: this.host.levelSystem?.level?.snapshot?.()?.mud ?? null,
      mudCoat: this.mudCoat?.snapshot?.() ?? null,
      camera: this.camera.snapshot(),
    };
  }

  dispose() {
    globalThis.removeEventListener?.(CONFIG_EVENT, this._onConfig);
    this.camera.dispose();
    this.controller = null;
    this.mudContact = null;
    this.mudCoat?.dispose?.();
    this.mudCoat = null;
    this.clipPlayer?.dispose?.();
    this.clipPlayer = null;
    this.dog?.dispose?.();
    this.dog = null;
  }
}

function dogClipModeEnabled() {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  return params.get('dogAnims') !== 'procedural';
}

function readDogConfig() {
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  return {
    breedId: normalizeRenderableDogBreedId(params.get('breed') ?? 'golden-retriever'),
    seed: Number(params.get('dogSeed') ?? params.get('seed') ?? 1) || 1,
    shellCount: Number(params.get('dogShells') ?? 18) || 18,
    mouthState: normalizeMouthState(params.get('dogMouth') ?? params.get('mouth') ?? 'closed'),
    naked: params.get('dogNaked') === '1',
    showFur: params.get('dogFur') !== '0',
  };
}
