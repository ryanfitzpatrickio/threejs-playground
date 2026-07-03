import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';
import { TraversalActionSystem } from './TraversalActionSystem.js';

const SLIDE_MIN_SPEED = 2.8;
const SLIDE_COOLDOWN_SECONDS = 0.3;
const SLIDE_COLLISION_HEIGHT = 0.78;
const slideDirection = new THREE.Vector3();

export class SlideSystem {
  constructor() {
    this.traversalActionSystem = new TraversalActionSystem();
  }

  update({ delta, input, movement, character }) {
    character.slideCooldown = Math.max(0, (character.slideCooldown ?? 0) - delta);

    if (character.slide?.active) {
      return this.updateActiveSlide({ delta, movement, character });
    }

    if (!canStartSlide({ input, movement, character })) {
      return movement;
    }

    this.startSlide({ character, movement });
    return this.overrideMovement({ movement, character });
  }

  startSlide({ character, movement }) {
    slideDirection.copy(movement.direction ?? character.velocity).setY(0);

    if (slideDirection.lengthSq() <= 0.0001) {
      slideDirection
        .set(Math.sin(character.group.rotation.y), 0, Math.cos(character.group.rotation.y));
    } else {
      slideDirection.normalize();
    }

    const action = this.traversalActionSystem.start({
      character,
      type: 'slide',
      animationState: 'runningSlide',
      motionWarp: false,
    });

    character.slide = {
      active: true,
      animationState: 'runningSlide',
      action,
      direction: slideDirection.clone(),
    };
    character.group.rotation.y = Math.atan2(slideDirection.x, slideDirection.z);
    character.velocity.copy(slideDirection).multiplyScalar(Math.max(character.speed, GAME_CONFIG.character.jogSpeed));
    character.collisionHeight = SLIDE_COLLISION_HEIGHT;
    character.verticalVelocity = 0;
    character.grounded = true;
  }

  updateActiveSlide({ delta, movement, character }) {
    const slide = character.slide;
    const action = this.traversalActionSystem.update({ character, delta });

    if (!action || this.traversalActionSystem.canFinish(action)) {
      this.finishSlide(character);
      return {
        ...movement,
        sliding: false,
        slideState: null,
        grounded: character.grounded,
        airborne: !character.grounded,
        height: character.group.position.y,
        verticalVelocity: character.verticalVelocity,
      };
    }

    slide.action = action;
    return this.overrideMovement({ movement, character });
  }

  finishSlide(character) {
    const slide = character.slide;
    const finishedAction = this.traversalActionSystem.finish(character);
    const direction = slide?.direction ?? slideDirection.set(0, 0, 1);

    character.slide = null;
    character.collisionHeight = GAME_CONFIG.character.collisionHeight;
    character.grounded = true;
    character.verticalVelocity = 0;
    character.velocity.copy(direction).multiplyScalar(GAME_CONFIG.character.jogSpeed);
    character.traversalRecoveryTimer = finishedAction?.recoverySeconds ?? 0.08;
    character.slideCooldown = SLIDE_COOLDOWN_SECONDS;
  }

  overrideMovement({ movement, character }) {
    return {
      ...movement,
      moving: true,
      wantsMove: true,
      speed: character.speed,
      grounded: true,
      airborne: false,
      sliding: true,
      slideState: character.slide?.animationState ?? 'runningSlide',
      justJumped: false,
      justLanded: false,
      height: character.group.position.y,
      verticalVelocity: 0,
    };
  }
}

function canStartSlide({ input, movement, character }) {
  return input.slidePressed === true
    && character.grounded === true
    && movement.grounded === true
    && movement.moving === true
    && movement.speed >= SLIDE_MIN_SPEED
    && (character.slideCooldown ?? 0) <= 0
    && !character.traversalAction
    && !character.hang?.active
    && !character.wallRun?.active
    && !character.wallClimb?.active
    && !character.rope?.active
    && !character.vault?.active;
}
