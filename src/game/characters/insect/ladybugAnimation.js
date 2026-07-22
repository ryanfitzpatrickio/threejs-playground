/**
 * Procedural ladybug animation — ultra-simple FSM.
 *
 *   - idle: antenna twitch, breathing pulse, micro leg sway
 *   - crawl / walk: insect tripod gait (A ↔ B) with speed-based stride
 *   - alert / threat: elytra flare open on hinges
 *   - light verlet-ish antenna springs + breeze
 *
 * Duck-typed to DogSimScene animation contract (same surface as cat/goose).
 */

import * as THREE from 'three';
import {
  LADYBUG_LEG_BONES,
  LADYBUG_TRIPOD_A,
  LADYBUG_TRIPOD_B,
} from './ladybugSkeleton.js';

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();

export const LADYBUG_CLIP_CATALOG = Object.freeze([
  { name: 'Idle', label: 'Idle', loop: true, behavior: 'idle' },
  { name: 'Crawl', label: 'Crawl', loop: true, behavior: 'walk' },
  { name: 'Run', label: 'Run', loop: true, behavior: 'run' },
  { name: 'Alert', label: 'Alert (elytra flare)', loop: true, behavior: 'look' },
  { name: 'Threat', label: 'Threat', loop: true, behavior: 'alert' },
]);

const BEHAVIOR_TO_STATE = {
  idle: 'idle',
  walk: 'crawl',
  trot: 'crawl',
  run: 'run',
  crawl: 'crawl',
  look: 'alert',
  alert: 'threat',
  sit: 'idle',
  lie: 'idle',
};

const STATE_TO_CLIP = Object.freeze({
  idle: 'Idle',
  crawl: 'Crawl',
  run: 'Run',
  alert: 'Alert',
  threat: 'Threat',
});

const CLIP_TO_STATE = Object.freeze({
  Idle: 'idle',
  Crawl: 'crawl',
  Run: 'run',
  Alert: 'alert',
  Threat: 'threat',
});

/**
 * @param {{
 *   root: THREE.Group,
 *   model: THREE.Object3D,
 *   rig: ReturnType<import('./ladybugSkeleton.js').createLadybugSkeleton>,
 *   uniforms: import('./ladybugMaterial.js').LadybugUniforms,
 * }} ctx
 */
export function createLadybugAnimation(ctx) {
  const { rig } = ctx;
  const bones = rig.bonesByName;

  const restLocalPos = new Map();
  bones.forEach((b, name) => {
    if (name === 'Head') return;
    restLocalPos.set(name, b.position.clone());
  });

  function resetPose() {
    bones.forEach((b, name) => {
      if (name === 'Head') return;
      b.quaternion.identity();
      b.scale.setScalar(1);
      const p = restLocalPos.get(name);
      if (p) b.position.copy(p);
    });
  }

  function spin(boneName, axis, angle) {
    if (Math.abs(angle) < 1e-6) return;
    const bone = bones.get(boneName);
    if (!bone) return;
    _q.setFromAxisAngle(axis, angle);
    bone.quaternion.multiply(_q);
  }

  let behavior = 'idle';
  let fsmState = 'idle';
  let currentClip = 'Idle';
  let autopilot = false;
  let autopilotTimer = 0;
  let mouthState = 'closed';
  let time = 0;
  let rootYaw = 0;
  const rootPos = new THREE.Vector3();
  let frozenBlink = false;
  let frozenBreeze = false;
  let externalRootMotion = false;
  /** @type {{ x:number, z:number, moving:boolean } | null} */
  let moveIntent = null;

  let gaitPhase = 0;
  let elytraOpen = 0;
  let elytraOpenT = 0;
  let walkAmp = 0;
  let walkAmpT = 0;
  // Antenna springs
  let antL = 0; let antLv = 0;
  let antR = 0; let antRv = 0;
  // Abdomen breath
  let breath = 0;

  function setBehavior(id) {
    const key = String(id ?? 'idle');
    behavior = key;
    fsmState = BEHAVIOR_TO_STATE[key] ?? 'idle';
    currentClip = STATE_TO_CLIP[fsmState] ?? 'Idle';
    // Pose targets
    if (fsmState === 'crawl') {
      walkAmpT = 0.85;
      elytraOpenT = 0;
    } else if (fsmState === 'run') {
      walkAmpT = 1;
      elytraOpenT = 0.15;
    } else if (fsmState === 'alert') {
      walkAmpT = 0;
      elytraOpenT = 0.55;
    } else if (fsmState === 'threat') {
      walkAmpT = 0.2;
      elytraOpenT = 1;
    } else {
      walkAmpT = 0;
      elytraOpenT = 0;
    }
  }

  function setClip(name) {
    const state = CLIP_TO_STATE[name];
    if (!state) return;
    currentClip = name;
    fsmState = state;
    behavior = state === 'crawl' ? 'walk' : state === 'threat' ? 'alert' : state;
    setBehavior(behavior);
    currentClip = name;
  }

  function damp(current, target, rate, dt) {
    return current + (target - current) * (1 - Math.exp(-rate * dt));
  }

  function spring(pos, vel, target, stiffness, damping, dt) {
    const a = (target - pos) * stiffness - vel * damping;
    const nv = vel + a * dt;
    return { p: pos + nv * dt, v: nv };
  }

  function update(dt) {
    const h = Math.min(0.05, Math.max(0, dt));
    if (h <= 0) return;
    time += h;

    if (autopilot) {
      autopilotTimer -= h;
      if (autopilotTimer <= 0) {
        const picks = ['idle', 'walk', 'look', 'idle', 'run'];
        setBehavior(picks[Math.floor(Math.random() * picks.length)]);
        autopilotTimer = 2.5 + Math.random() * 3.5;
      }
    }

    // Intent overrides walk amplitude when free-roam drives movement
    if (moveIntent?.moving) {
      walkAmpT = Math.max(walkAmpT, 0.9);
      if (fsmState === 'idle' || fsmState === 'alert') {
        fsmState = 'crawl';
        currentClip = 'Crawl';
        behavior = 'walk';
      }
    }

    walkAmp = damp(walkAmp, walkAmpT, 6, h);
    elytraOpen = damp(elytraOpen, elytraOpenT, 5, h);
    breath = Math.sin(time * 2.4) * 0.5 + 0.5;

    resetPose();

    // ---- breathing / abdomen pulse ----------------------------------------
    spin('abdomen_0', AXIS_X, Math.sin(time * 2.4) * 0.04 * (1 - walkAmp * 0.5));
    spin('abdomen_1', AXIS_X, Math.sin(time * 2.4 + 0.4) * 0.05);

    // ---- elytra hinges (open about body Z / outward) ----------------------
    // Closed = 0; fully open ≈ 1.1 rad flare up-out.
    const open = elytraOpen;
    spin('elytra_L', AXIS_Z, open * 1.05);
    spin('elytra_L', AXIS_X, open * -0.25);
    spin('elytra_R', AXIS_Z, open * -1.05);
    spin('elytra_R', AXIS_X, open * -0.25);
    // Micro tremble when open or in breeze
    if (!frozenBreeze && open > 0.05) {
      const tremble = Math.sin(time * 28) * 0.012 * open;
      spin('elytra_L', AXIS_Y, tremble);
      spin('elytra_R', AXIS_Y, -tremble);
    }

    // ---- antenna springs --------------------------------------------------
    const breeze = frozenBreeze ? 0 : (0.15 + Math.sin(time * 0.7) * 0.05);
    if (ctx.uniforms?.breeze) ctx.uniforms.breeze.value = breeze;
    const twitch = frozenBlink ? 0 : (Math.sin(time * 9.1) > 0.92 ? 0.35 : 0);
    const antTargetL = Math.sin(time * 1.7) * 0.12 + twitch + breeze * 0.2;
    const antTargetR = Math.sin(time * 1.9 + 1.1) * 0.12 - twitch * 0.7 + breeze * 0.15;
    ({ p: antL, v: antLv } = spring(antL, antLv, antTargetL, 40, 8, h));
    ({ p: antR, v: antRv } = spring(antR, antRv, antTargetR, 40, 8, h));
    spin('ant_L', AXIS_X, -0.35 + antL);
    spin('ant_L', AXIS_Z, 0.25 + antL * 0.3);
    spin('ant_R', AXIS_X, -0.35 + antR);
    spin('ant_R', AXIS_Z, -0.25 - antR * 0.3);

    // ---- head micro look --------------------------------------------------
    spin('head', AXIS_Y, Math.sin(time * 0.6) * 0.08 * (1 - walkAmp));
    spin('head', AXIS_X, Math.sin(time * 1.1) * 0.05);

    // ---- tripod gait ------------------------------------------------------
    if (walkAmp > 0.02) {
      const speed = fsmState === 'run' ? 14 : 8;
      gaitPhase += h * speed * walkAmp;
      const swing = Math.sin(gaitPhase);
      const amp = 0.55 * walkAmp;

      for (const name of LADYBUG_TRIPOD_A) {
        const lift = Math.max(0, swing) * amp;
        const plant = Math.min(0, swing) * amp * 0.35;
        spin(name, AXIS_X, -lift * 0.9 + plant * 0.4);
        spin(name, AXIS_Z, (name.endsWith('L') ? 1 : -1) * (lift * 0.25));
        spin(name, AXIS_Y, swing * amp * 0.2 * (name.endsWith('L') ? 1 : -1));
      }
      for (const name of LADYBUG_TRIPOD_B) {
        const lift = Math.max(0, -swing) * amp;
        const plant = Math.min(0, -swing) * amp * 0.35;
        spin(name, AXIS_X, -lift * 0.9 + plant * 0.4);
        spin(name, AXIS_Z, (name.endsWith('L') ? 1 : -1) * (lift * 0.25));
        spin(name, AXIS_Y, -swing * amp * 0.2 * (name.endsWith('L') ? 1 : -1));
      }

      // Body bob + yaw sway
      spin('thorax', AXIS_X, Math.sin(gaitPhase * 2) * 0.04 * walkAmp);
      spin('thorax', AXIS_Z, Math.sin(gaitPhase) * 0.05 * walkAmp);

      // Root forward motion when not externally driven
      if (!externalRootMotion) {
        const step = (fsmState === 'run' ? 0.12 : 0.06) * walkAmp * h;
        rootPos.x += Math.sin(rootYaw) * step;
        rootPos.z += Math.cos(rootYaw) * step;
      }
    } else {
      // Idle leg micro-sway
      for (let i = 0; i < LADYBUG_LEG_BONES.length; i += 1) {
        const name = LADYBUG_LEG_BONES[i];
        spin(name, AXIS_X, Math.sin(time * 2.2 + i * 0.9) * 0.04);
        spin(name, AXIS_Z, Math.sin(time * 1.7 + i) * 0.03 * (name.endsWith('L') ? 1 : -1));
      }
    }

    // Apply root transform
    ctx.root.position.set(rootPos.x, rootPos.y, rootPos.z);
    ctx.root.rotation.set(0, rootYaw, 0);
    rig.root.updateMatrixWorld(true);

    if (ctx.uniforms?.time) ctx.uniforms.time.value = time;
  }

  return {
    setBehavior,
    getBehavior: () => behavior,
    setClip,
    getCurrentClip: () => currentClip,
    getAutopilot: () => autopilot,
    setAutopilot(on) {
      autopilot = Boolean(on);
      autopilotTimer = 1;
    },
    getMouthState: () => mouthState,
    setMouthState(id) { mouthState = id ?? 'closed'; },
    getTime: () => time,
    setTime(t) { time = Number(t) || 0; },
    getRootPosition: () => rootPos.clone(),
    setRootPosition(x, y, z) {
      rootPos.set(x, y ?? 0, z);
      ctx.root.position.copy(rootPos);
    },
    getRootYaw: () => rootYaw,
    setRootYaw(y) {
      rootYaw = y;
      ctx.root.rotation.y = rootYaw;
    },
    isFrozenBlink: () => frozenBlink,
    setFrozenBlink(on) { frozenBlink = Boolean(on); },
    isFrozenBreeze: () => frozenBreeze,
    setFrozenBreeze(on) { frozenBreeze = Boolean(on); },
    setExternalRootMotion(on) { externalRootMotion = Boolean(on); },
    setMoveIntent(intent) { moveIntent = intent; },
    update,
    // Clip-catalog compatibility for studio panel
    clipCatalog: LADYBUG_CLIP_CATALOG,
  };
}
