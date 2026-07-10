import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';

// Wingsuit flight mode — Part B.
//
// Activates via the equipped wingsuit ability: F (or double-tap Space) while
// airborne sets input.wingsuitTogglePressed (AbilitySystem). Takes over movement
// like the other traversal systems (MovementSystem returns its locked object when
// character.wingsuit.active, and this replaces the movement result).
//
// Arcade wingsuit model: a forward direction defined by heading (yaw) + pitch, and a
// scalar airspeed. Gravity along the forward axis turns dives into speed; quadratic
// drag bleeds it; flaring (S) adds drag + pitches up to brake and climb briefly;
// trim is a gentle nose-down glide. A/D bank-turns. Momentum carries on exit.

const _forward = new THREE.Vector3();
const _move = new THREE.Vector3();
const _dirXZ = new THREE.Vector3();
const _bodyFwd = new THREE.Vector3();
const _bodyRight = new THREE.Vector3();
const _bodyUp = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _roll = new THREE.Quaternion();
const _worldUp = new THREE.Vector3(0, 1, 0);

const TRAVERSAL_BLOCKERS = ['mount', 'hang', 'wallRun', 'wallClimb', 'rope', 'hookSwing', 'vault', 'slide'];

export class WingsuitFlightSystem {
  update({ delta, input, movement, character, level, physics }) {
    if (!character) {
      return movement;
    }

    const cfg = GAME_CONFIG.wingsuit.flight;
    const wingsuit = character.wingsuit;

    // Grapple out of a glide: exit with a forward burst, then let HookSwingSystem
    // (which now runs right after this) fire the same frame off the boosted velocity.
    if (wingsuit?.active && input?.hookFirePressed) {
      this.exitToGrapple(character, wingsuit, cfg);
      return this.buildAirMovement(character, level);
    }

    // Toggle handling: deploy when airborne, retract if pressed again while flying.
    if (input?.wingsuitTogglePressed && !character.vehicle?.active) {
      if (wingsuit?.active) {
        this.deactivate(character, { keepMomentum: true });
        character.forceFreeFallTimer = Math.max(character.forceFreeFallTimer ?? 0, cfg.exitFreeFallSeconds);
        return this.buildAirMovement(character, level);
      }
      if (this.canActivate(character, level)) {
        this.activate(character, cfg);
      }
    }

    if (!character.wingsuit?.active) {
      return movement;
    }

    return this.fly({ delta: Math.min(delta ?? 0, 0.05), input, character, level, physics, cfg });
  }

  // Forward burst when grappling out of a glide. Velocity is set explicitly here, so
  // deactivate() must NOT overwrite it (keepMomentum:false).
  exitToGrapple(character, wingsuit, cfg) {
    _forward.copy(wingsuit.velocity);
    if (_forward.lengthSq() < 1e-6) {
      _forward.set(Math.sin(wingsuit.heading), 0, Math.cos(wingsuit.heading));
    }
    _forward.normalize();

    character.velocity.x = wingsuit.velocity.x + _forward.x * cfg.grappleBurst;
    character.velocity.z = wingsuit.velocity.z + _forward.z * cfg.grappleBurst;
    character.verticalVelocity = wingsuit.velocity.y + cfg.grappleBurstUp;
    character.grounded = false;
    this.deactivate(character, { keepMomentum: false });
  }

  // A clean airborne free-fall movement for the air-exit paths (toggle-off / grapple).
  buildAirMovement(character, level) {
    _dirXZ.set(character.velocity?.x ?? 0, 0, character.velocity?.z ?? 0);
    if (_dirXZ.lengthSq() > 1e-6) _dirXZ.normalize();
    const groundHeight = level?.getGroundHeightAt?.(character.group.position, GAME_CONFIG.character.footRadius) ?? 0;
    return {
      moving: false,
      wantsMove: false,
      speed: character.speed ?? 0,
      direction: _dirXZ.clone(),
      grounded: false,
      airborne: true,
      wingsuitFlying: false,
      justJumped: false,
      justLanded: false,
      groundHeight,
      height: character.group.position.y,
      verticalVelocity: character.verticalVelocity ?? 0,
    };
  }

  canActivate(character, level) {
    if (!character.wingsuitRig || character.grounded) {
      return false;
    }
    if (TRAVERSAL_BLOCKERS.some((key) => character[key]?.active)) {
      return false;
    }
    // Need clearance below so you can't deploy a meter off the ground.
    const ground = level?.getGroundHeightAt?.(character.group.position, GAME_CONFIG.character.footRadius) ?? -Infinity;
    return character.group.position.y - ground >= GAME_CONFIG.wingsuit.flight.minAltitude;
  }

  activate(character, cfg) {
    const vx = character.velocity?.x ?? 0;
    const vz = character.velocity?.z ?? 0;
    const vy = character.verticalVelocity ?? 0;

    const horiz = Math.hypot(vx, vz);
    const heading = horiz > 0.4 ? Math.atan2(vx, vz) : (character.group.rotation.y ?? 0);
    const speed = Math.max(cfg.minSpeed, Math.hypot(vx, vy, vz));

    character.wingsuit = {
      active: true,
      heading,
      pitch: cfg.pitchTrim,
      bank: 0,
      speed,
      velocity: new THREE.Vector3(vx, vy, vz),
      animationState: 'wingsuitCoast',
      justLanded: false,
    };

    const rig = character.wingsuitRig;
    if (rig) {
      rig.deployed = true;
      rig.group.visible = true;
      // Force bone rebind + cloth history clear on the next WingsuitSystem tick so
      // a deploy after climb/teleport never inherits a stale origin-trail pose.
      rig.bonesResolved = false;
    }
  }

  deactivate(character, { keepMomentum }) {
    const wingsuit = character.wingsuit;
    if (keepMomentum && wingsuit) {
      character.velocity.x = wingsuit.velocity.x;
      character.velocity.z = wingsuit.velocity.z;
      character.verticalVelocity = wingsuit.velocity.y;
    }
    // Level the body (drop the flight pitch/roll), keeping the travel heading.
    // rotation.set zeroes the residual X/Z Euler that MovementSystem never clears
    // (it only writes rotation.y) — otherwise the body stays tilted/upside-down.
    const yaw = wingsuit?.heading ?? character.group.rotation.y ?? 0;
    character.group.rotation.set(0, yaw, 0);
    character.wingsuit = null;

    const rig = character.wingsuitRig;
    if (rig && GAME_CONFIG.wingsuit.deployByDefault !== true) {
      rig.deployed = false;
      rig.group.visible = false;
    }
  }

  fly({ delta, input, character, level, physics, cfg }) {
    const wingsuit = character.wingsuit;
    const moveX = input?.moveX ?? 0; // bank / turn
    const moveZ = input?.moveZ ?? 0; // pitch (W=-1 dive, S=+1 flare)

    // Ease pitch toward the commanded target.
    const targetPitch = moveZ < -0.1 ? cfg.pitchDive : moveZ > 0.1 ? cfg.pitchFlare : cfg.pitchTrim;
    wingsuit.pitch += (targetPitch - wingsuit.pitch) * (1 - Math.exp(-cfg.pitchRate * delta));

    // Bank-turn: steer heading and lean the body visually.
    wingsuit.heading -= moveX * cfg.turnRate * delta;
    const targetBank = -moveX * cfg.maxBank;
    wingsuit.bank += (targetBank - wingsuit.bank) * (1 - Math.exp(-cfg.bankRate * delta));

    // Forward direction from heading + pitch.
    const cosP = Math.cos(wingsuit.pitch);
    const sinP = Math.sin(wingsuit.pitch);
    _forward.set(cosP * Math.sin(wingsuit.heading), sinP, cosP * Math.cos(wingsuit.heading));

    // Airspeed: gravity along the forward axis (dive => gain), quadratic drag,
    // extra drag while flaring, a touch of turn bleed.
    let spd = wingsuit.speed;
    spd += -cfg.gravity * _forward.y * delta;
    const drag = cfg.dragBase + cfg.dragFlare * Math.max(0, sinP);
    spd -= drag * spd * spd * delta;
    spd *= 1 - Math.abs(moveX) * cfg.turnDrag * delta;
    spd = Math.min(cfg.maxSpeed, Math.max(cfg.minSpeed, spd));
    wingsuit.speed = spd;

    wingsuit.velocity.copy(_forward).multiplyScalar(spd);

    // Pose: blend to the dive clip as the nose drops past the threshold, else coast.
    // The controller crossfades between them (and in/out of flying) automatically.
    wingsuit.animationState = wingsuit.pitch < cfg.diveAnimPitch ? 'wingsuitDive' : 'wingsuitCoast';

    // Integrate position through the character controller so we collide with the city.
    _move.copy(wingsuit.velocity).multiplyScalar(delta);
    const result = physics.moveCharacter({
      character,
      movement: _move,
      controllerOptions: { allowAutostep: false, allowGroundSnap: false },
    });
    character.group.position.add(result.movement);

    // Orientation: tilt the whole body to the climb/dive arc (exaggerated by gain),
    // face travel, and bank into turns. Built from a forward+up basis so yaw, pitch,
    // and roll compose cleanly without Euler-order surprises.
    const horizSpeed = Math.hypot(wingsuit.velocity.x, wingsuit.velocity.z);
    const arc = Math.atan2(wingsuit.velocity.y, Math.max(horizSpeed, 1e-3));
    const visualPitch = THREE.MathUtils.clamp(arc * cfg.pitchVisualGain, -cfg.maxVisualPitch, cfg.maxVisualPitch);
    const cvp = Math.cos(visualPitch);
    _bodyFwd.set(cvp * Math.sin(wingsuit.heading), Math.sin(visualPitch), cvp * Math.cos(wingsuit.heading)).normalize();
    _bodyRight.crossVectors(_worldUp, _bodyFwd).normalize();
    _bodyUp.crossVectors(_bodyFwd, _bodyRight).normalize();
    _basis.makeBasis(_bodyRight, _bodyUp, _bodyFwd);
    character.group.quaternion.setFromRotationMatrix(_basis);
    // Roll about the body's forward axis for the bank lean.
    _roll.setFromAxisAngle(_bodyFwd, wingsuit.bank);
    character.group.quaternion.premultiply(_roll);

    // Keep base locomotion fields coherent for a clean hand-off.
    character.velocity.x = wingsuit.velocity.x;
    character.velocity.z = wingsuit.velocity.z;
    character.verticalVelocity = wingsuit.velocity.y;
    character.speed = spd;

    const groundHeight = level?.getGroundHeightAt?.(character.group.position, GAME_CONFIG.character.footRadius) ?? 0;
    const landed = result.grounded || character.group.position.y <= groundHeight + 0.02;

    if (landed) {
      if (character.group.position.y < groundHeight) {
        character.group.position.y = groundHeight;
      }
      character.grounded = true;
      this.deactivate(character, { keepMomentum: true });
      _dirXZ.set(wingsuit.velocity.x, 0, wingsuit.velocity.z);
      if (_dirXZ.lengthSq() > 1e-6) _dirXZ.normalize();
      return {
        moving: spd > 0.08,
        wantsMove: false,
        speed: spd,
        direction: _dirXZ.clone(),
        grounded: true,
        airborne: false,
        wingsuitFlying: false,
        justJumped: false,
        justLanded: true,
        groundHeight,
        height: character.group.position.y,
        verticalVelocity: 0,
      };
    }

    character.grounded = false;
    _dirXZ.set(wingsuit.velocity.x, 0, wingsuit.velocity.z);
    if (_dirXZ.lengthSq() > 1e-6) _dirXZ.normalize();

    return {
      moving: true,
      wantsMove: false,
      speed: spd,
      direction: _dirXZ.clone(),
      grounded: false,
      airborne: true,
      wingsuitFlying: true,
      wingsuitState: wingsuit.animationState,
      justJumped: false,
      justLanded: false,
      groundHeight,
      height: character.group.position.y,
      verticalVelocity: wingsuit.velocity.y,
    };
  }
}
