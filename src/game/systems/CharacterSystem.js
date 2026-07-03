import * as THREE from 'three';
import { createMaraModel } from '../characters/mara/createMaraModel.js';
import { createMaraFbxModel } from '../characters/mara/createMaraFbxModel.js';
import { createGreatSword } from '../characters/mara/createGreatSword.js';
import { createWingsuit } from '../characters/mara/createWingsuit.js';
import { attachJacketCloth, disposeJacketCloth } from '../characters/mara/attachJacketCloth.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { GAME_CONFIG } from '../config/gameConfig.js';

export class CharacterSystem {
  constructor() {
    this.character = null;
  }

  async loadMara(scene) {
    const model = await loadBestMaraModel();
    model.group.position.set(0, 0, 0);
    scene.add(model.group);

    this.character = {
      ...model,
      stamina: 1,
      sway: 0,
      speed: 0,
      verticalVelocity: 0,
      grounded: true,
      // Player damage state (no death — health gates hit-reactions and regenerates).
      health: GAME_CONFIG.character.maxHealth,
      maxHealth: GAME_CONFIG.character.maxHealth,
      invulnerable: false,
      iframeTimer: 0,
      pendingImpulse: new THREE.Vector3(),
      hitReaction: null,
      hitReactionTimer: 0,
      lastHitTime: -Infinity,
    };

    await this.attachSword(this.character);
    this.attachWingsuit(this.character, scene);

    await nextFrame();
    return this.character;
  }

  // Build the wingsuit membrane and add it to the scene as a world-space rig. The
  // membrane vertices are driven each frame by WingsuitSystem from bone world
  // positions, so it lives at the scene root (not under the scaled character object).
  attachWingsuit(character, scene) {
    if (!character || (character.source !== 'fbx' && character.source !== 'glb')) {
      return;
    }
    if (!character.animationController?.modelRoot) {
      return;
    }

    const rig = createWingsuit({
      color: GAME_CONFIG.wingsuit.color,
      opacity: GAME_CONFIG.wingsuit.opacity,
    });
    rig.deployed = GAME_CONFIG.wingsuit.deployByDefault === true;
    rig.group.visible = rig.deployed;
    scene.add(rig.group);

    character.wingsuitRig = rig;
  }

  // Turn the separate jacket FBX into dynamic WebGPU cloth using three-simplecloth.
  // The jacket mesh must share (or be rebound to) the same skeleton as the body.
  // Vertex colors (or a generated mask) control pinned vs. free cloth areas.
  // Call this *after* the renderer is initialized (WebGPU required).
  async attachJacketCloth(renderer) {
    if (!this.character) return;
    try {
      await attachJacketCloth(this.character, renderer);
    } catch (err) {
      console.warn('[jacket] attachJacketCloth failed:', err);
    }
  }

  // Attach the great sword to the right hand bone. The glTF and FBX rigs both have
  // mixamorig bones (after conversion). The procedural fallback has no skeleton.
  // The sword starts hidden (sheathed); CombatSystem toggles visibility on draw.
  async attachSword(character) {
    if (!character || (character.source !== 'fbx' && character.source !== 'glb')) {
      return;
    }

    const hand = character.animationController?.modelRoot?.getObjectByName('mixamorigRightHand');
    if (!hand) {
      return;
    }

    const sword = await createGreatSword();
    sword.group.visible = false;
    hand.add(sword.group);

    // The hand bone lives inside the FBX object, which is scaled to normalize the
    // character to 1.72m (a ~0.017x factor). A unit-scale child would render
    // thumb-sized, so cancel the inherited parent scale to keep the sword at
    // real-world meters. (The factory builds the sword at intended meters.)
    hand.updateWorldMatrix(true, false);
    const he = hand.matrixWorld.elements;
    const inherited = Math.hypot(he[0], he[1], he[2]);
    if (Number.isFinite(inherited) && inherited > 1e-6) {
      sword.group.scale.setScalar(1 / inherited);
    }

    character.sword = sword;
  }

  snapshot() {
    const sword = this.character?.sword;
    // Lightweight sword debug only — the per-call Box3 / getWorldPosition that
    // used to live here ran every snapshot (120ms) for a scale bug that's fixed.
    const swordDebug = sword?.group
      ? {
          source: sword.source ?? null,
          visible: sword.group.visible,
          parent: sword.group.parent?.name ?? null,
        }
      : null;
    return {
      source: this.character?.source ?? 'loading',
      swordSource: sword?.source ?? null,
      sword: swordDebug,
      animation: this.character?.animationController?.snapshot?.() ?? null,
      stamina: this.character?.stamina ?? 1,
      health: this.character?.health ?? 1,
      maxHealth: this.character?.maxHealth ?? 1,
      hitReaction: this.character?.hitReaction ?? null,
      sway: this.character?.sway ?? 0,
      speed: this.character?.speed ?? 0,
      verticalVelocity: this.character?.verticalVelocity ?? 0,
      collisionHeight: this.character?.collisionHeight ?? null,
      grounded: this.character?.grounded ?? true,
      rootMotion: this.character?.lastRootMotion ?? null,
      ledgeApproach: this.character?.ledgeApproach?.intent ?? null,
      mount: this.character?.mount
        ? {
            active: this.character.mount.active,
            state: this.character.mount.state,
            animationState: this.character.mount.animationState,
            socketBone: this.character.mount.socketBone,
            anchorBone: this.character.mount.anchorBone ?? null,
            gripBone: this.character.mount.gripBone ?? null,
            gripSpacing: Number((this.character.mount.gripSpacing ?? 0).toFixed(3)),
            gripCenter: vectorSnapshot(this.character.mount.handTargets?.center),
            locomotion: this.character.mount.locomotion
              ? {
                  moving: this.character.mount.locomotion.moving,
                  running: this.character.mount.locomotion.running,
                  speed: Number((this.character.mount.locomotion.speed ?? 0).toFixed(3)),
                  throttle: Number((this.character.mount.locomotion.throttle ?? 0).toFixed(3)),
                  turn: Number((this.character.mount.locomotion.turn ?? 0).toFixed(3)),
                }
              : null,
          }
        : null,
      hang: this.character?.hang
        ? {
            active: this.character.hang.active,
            mode: this.character.hang.mode,
            state: this.character.hang.animationState,
            approach: this.character.hang.approach ?? null,
            transition: this.character.hang.transition ?? null,
            idleCycle: this.character.hang.idleCycle
              ? {
                  state: this.character.hang.idleCycle.state,
                  index: this.character.hang.idleCycle.index,
                  timer: Number((this.character.hang.idleCycle.timer ?? 0).toFixed(3)),
                }
              : null,
            ledge: this.character.hang.ledge?.name ?? null,
            ledgeY: Number((this.character.hang.ledge?.y ?? 0).toFixed(3)),
            along: Number((this.character.hang.along ?? 0).toFixed(3)),
            action: this.character.hang.action
              ? {
                  type: this.character.hang.action.type,
                  progress: Number((this.character.hang.action.progress ?? 0).toFixed(3)),
                  elapsed: Number((this.character.hang.action.elapsed ?? 0).toFixed(3)),
                }
              : null,
          }
        : null,
      wallClimb: this.character?.wallClimb
        ? {
            active: this.character.wallClimb.active,
            state: this.character.wallClimb.animationState,
            surface: this.character.wallClimb.surface?.name ?? null,
            u: Number((this.character.wallClimb.u ?? 0).toFixed(3)),
            v: Number((this.character.wallClimb.v ?? 0).toFixed(3)),
          }
        : null,
      wallRun: this.character?.wallRun
        ? {
            active: this.character.wallRun.active,
            state: this.character.wallRun.animationState,
            surface: this.character.wallRun.surface?.name ?? null,
            u: Number((this.character.wallRun.u ?? 0).toFixed(3)),
            v: Number((this.character.wallRun.v ?? 0).toFixed(3)),
            direction: this.character.wallRun.direction ?? 0,
            handSide: this.character.wallRun.handSide ?? null,
          }
        : null,
      rope: this.character?.rope
        ? {
            active: this.character.rope.active,
            state: this.character.rope.animationState,
            rope: this.character.rope.rope?.name ?? null,
            grabDistance: Number((this.character.rope.grabDistance ?? 0).toFixed(3)),
            angle: Number((this.character.rope.angle ?? 0).toFixed(3)),
            angularVelocity: Number((this.character.rope.angularVelocity ?? 0).toFixed(3)),
        }
        : null,
      vault: this.character?.vault
        ? {
            active: this.character.vault.active,
            state: this.character.vault.animationState,
            obstacle: this.character.vault.candidate?.collider?.name ?? null,
            progress: Number((this.character.vault.action?.progress ?? 0).toFixed(3)),
          }
        : null,
      slide: this.character?.slide
        ? {
            active: this.character.slide.active,
            state: this.character.slide.animationState,
            progress: Number((this.character.slide.action?.progress ?? 0).toFixed(3)),
          }
        : null,
      position: this.character
        ? {
            x: Number(this.character.group.position.x.toFixed(3)),
            y: Number(this.character.group.position.y.toFixed(3)),
            z: Number(this.character.group.position.z.toFixed(3)),
          }
        : { x: 0, y: 0, z: 0 },
    };
  }

  dispose() {
    if (!this.character) {
      return;
    }

    if (this.character.wingsuitRig?.group) {
      disposeObject3D(this.character.wingsuitRig.group);
      this.character.wingsuitRig.group.removeFromParent();
    }

    // Clean up jacket cloth sim + mesh
    try {
      disposeJacketCloth(this.character);
    } catch {}

    disposeObject3D(this.character.group);
    this.character.animationController?.dispose?.();
    this.character.group.removeFromParent();
    this.character = null;
  }
}

async function loadBestMaraModel() {
  try {
    return await createMaraFbxModel();
  } catch (error) {
    console.warn('Falling back to procedural Mara model after model load failed.', error);
    return createMaraModel();
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function vectorSnapshot(vector) {
  if (!vector) {
    return null;
  }

  return {
    x: Number(vector.x.toFixed(3)),
    y: Number(vector.y.toFixed(3)),
    z: Number(vector.z.toFixed(3)),
  };
}
