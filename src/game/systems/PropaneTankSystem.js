/** Shootable propane tanks: puncture → leak → burn → radial explosion. */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color, float, mix, smoothstep, uv } from 'three/tsl';
import {
  createPropaneTankModel,
  PROPANE_TANK_STATE,
} from '../items/propaneTankModel.js';
import { createPropaneTank } from '../items/createPropaneTank.js';
import { createGasVentRenderer } from '../render/createGasVentRenderer.js';
import { createTankFireRenderer } from '../render/createTankFireRenderer.js';
import { createExplosionRenderer } from '../render/createExplosionRenderer.js';
import { HORDE_EXPLOSION_DEFAULT_RADIUS } from '../config/hordePerformanceConfig.js';

const PLAYER_MAX_DAMAGE = 65;
const CHAIN_INSTANT_RANGE = 1.5;
const _point = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _center = new THREE.Vector3();
const _otherCenter = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _outward = new THREE.Vector3();
const _forward = new THREE.Vector3(0, 0, 1);

class PropaneAudio {
  constructor() {
    this.ctx = null;
    this.hiss = null;
    this.hissGain = null;
    this.hissFilter = null;
    this.fireGain = null;
    this.fireFilter = null;
    this.panner = null;
  }

  ensure() {
    if (this.ctx || typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      brown = brown * 0.92 + white * 0.08;
      data[i] = white * 0.45 + brown * 0.55;
    }
    this.hiss = this.ctx.createBufferSource();
    this.hiss.buffer = buffer;
    this.hiss.loop = true;
    this.hissFilter = this.ctx.createBiquadFilter();
    this.hissFilter.type = 'bandpass';
    this.hissFilter.frequency.value = 1800;
    this.hissFilter.Q.value = 0.7;
    this.hissGain = this.ctx.createGain();
    this.hissGain.gain.value = 0;
    this.fireFilter = this.ctx.createBiquadFilter();
    this.fireFilter.type = 'lowpass';
    this.fireFilter.frequency.value = 700;
    this.fireGain = this.ctx.createGain();
    this.fireGain.gain.value = 0;
    this.panner = this.ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 3;
    this.panner.maxDistance = 45;
    this.panner.rolloffFactor = 1.2;
    this.hiss.connect(this.hissFilter).connect(this.hissGain).connect(this.panner);
    this.hiss.connect(this.fireFilter).connect(this.fireGain).connect(this.panner);
    this.panner.connect(this.ctx.destination);
    this.hiss.start();
  }

  update({ hiss = 0, fire = 0, urgency = 0, position = null, camera = null } = {}) {
    if (hiss > 0.01 || fire > 0.01) {
      this.ensure();
      this.ctx?.resume?.().catch?.(() => {});
    }
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.hissGain.gain.setTargetAtTime(Math.min(0.18, hiss * 0.14), now, 0.12);
    this.fireGain.gain.setTargetAtTime(Math.min(0.24, fire * 0.18), now, 0.09);
    this.hissFilter.frequency.setTargetAtTime(1400 + urgency * 1700, now, 0.08);
    this.fireFilter.frequency.setTargetAtTime(500 + urgency * 900, now, 0.1);
    if (position && this.panner) {
      this.panner.positionX?.setTargetAtTime(position.x, now, 0.05);
      this.panner.positionY?.setTargetAtTime(position.y, now, 0.05);
      this.panner.positionZ?.setTargetAtTime(position.z, now, 0.05);
    }
    if (camera && this.ctx.listener) {
      camera.getWorldPosition?.(_point) ?? _point.copy(camera.position);
      const listener = this.ctx.listener;
      listener.positionX?.setTargetAtTime(_point.x, now, 0.05);
      listener.positionY?.setTargetAtTime(_point.y, now, 0.05);
      listener.positionZ?.setTargetAtTime(_point.z, now, 0.05);
    }
  }

  boom(point, intensity = 1) {
    this.ensure();
    if (!this.ctx) return;
    this.ctx.resume?.().catch?.(() => {});
    const now = this.ctx.currentTime;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 5;
    panner.maxDistance = 90;
    panner.rolloffFactor = 0.9;
    if (panner.positionX) {
      panner.positionX.value = point.x;
      panner.positionY.value = point.y;
      panner.positionZ.value = point.z;
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(Math.min(0.7, 0.42 * intensity), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(82, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.45);
    osc.connect(gain).connect(panner).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 1.3);
  }

  dispose() {
    try { this.hiss?.stop(); } catch { /* already stopped */ }
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.hiss = null;
  }
}

function createHoleMaterial() {
  const radial = uv().sub(0.5).length();
  const rim = smoothstep(0.22, 0.5, radial);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = mix(color(0x080706), color(0x8f4b25), rim).mul(0.7);
  material.opacityNode = float(1).sub(smoothstep(0.44, 0.51, radial));
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  return material;
}

export class PropaneTankSystem {
  constructor({ qualityPreset = {} } = {}) {
    const fx = qualityPreset.propaneFx ?? {};
    this.fxConfig = {
      gasCapacity: fx.gasCapacity ?? 128,
      smokeCapacity: fx.smokeCapacity ?? 72,
      explosionCapacity: fx.explosionCapacity ?? 4,
      heatShimmer: fx.heatShimmer !== false,
      distortion: fx.distortion !== false,
    };
    this.enabled = false;
    this.model = null;
    this.records = [];
    this.recordsById = new Map();
    this.scene = null;
    this.level = null;
    this.vents = null;
    this.fire = null;
    this.explosions = null;
    this.audio = new PropaneAudio();
    this.holeGeometry = new THREE.PlaneGeometry(0.075, 0.075);
    this.holeMaterial = createHoleMaterial();
    this._deps = {};
    this._hits = 0;
    this._detonations = 0;
    this._chainQueued = 0;
  }

  bindLevel({ scene = null, level = null } = {}) {
    this.unbind();
    this.scene = scene;
    this.level = level;
    const tanks = Array.isArray(level?.propaneTanks) ? level.propaneTanks : [];
    if (!scene || !tanks.length) return;
    this.vents = createGasVentRenderer(scene, this.fxConfig);
    this.fire = createTankFireRenderer(scene, {
      capacity: Math.max(8, tanks.length + 2),
      heatShimmer: this.fxConfig.heatShimmer,
    });
    this.explosions = createExplosionRenderer(scene, {
      capacity: this.fxConfig.explosionCapacity,
      distortion: this.fxConfig.distortion,
    });
    const entries = tanks.map((tank, index) => ({
      id: tank.group?.userData?.propaneId ?? `propane-${index + 1}`,
      seed: tank.group?.userData?.propaneSeed ?? index + 1,
    }));
    this.model = createPropaneTankModel(entries);
    for (let i = 0; i < tanks.length; i += 1) this._addRecord(tanks[i], entries[i].id);
    this.enabled = true;
  }

  _addRecord(tank, id) {
    const state = this.model?.get(id);
    if (!tank?.group || !state) return null;
    tank.group.userData.propaneId = id;
    const record = {
      id,
      tank,
      state,
      holes: [],
      gasAccumulator: 0,
      hitEntity: {
        id,
        model: tank.group,
        collisionRadius: tank.radius ?? 0.155,
        collisionHeight: tank.height ?? 0.95,
        health: 1,
        surfaceClass: 'metal',
        propaneTank: true,
        propaneTankRef: null,
      },
    };
    record.hitEntity.propaneTankRef = record;
    this.records.push(record);
    this.recordsById.set(id, record);
    return record;
  }

  getHitEntities() {
    if (!this.enabled) return [];
    const hits = [];
    for (const record of this.records) {
      if (
        record.state.state === PROPANE_TANK_STATE.EXPLODED
        || record.tank.held
        || record.tank.group.visible === false
      ) continue;
      hits.push(record.hitEntity);
    }
    return hits;
  }

  onTankHit(entity, result = {}) {
    const record = entity?.propaneTankRef ?? this.recordsById.get(entity?.id);
    if (!record || record.state.state === PROPANE_TANK_STATE.EXPLODED) return false;
    const group = record.tank.group;
    group.updateMatrixWorld(true);
    _point.set(result.point?.x ?? 0, result.point?.y ?? 0.45, result.point?.z ?? 0);
    group.worldToLocal(_point);
    _normal.set(result.normal?.x ?? 0, result.normal?.y ?? 0, result.normal?.z ?? 1);
    group.getWorldQuaternion(_worldQuat).invert();
    _normal.applyQuaternion(_worldQuat).normalize();
    const events = this.model.hit(record.id, {
      localPoint: _point,
      localNormal: _normal,
      damage: Math.max(1, (Number(result.damage) || 20) / 30),
    });
    this._hits += 1;
    this._consumeEvents(events);
    return true;
  }

  update({
    delta,
    camera = null,
    character = null,
    playerDamageSystem = null,
    cameraSystem = null,
    carryItemSystem = null,
    enemyCutSystem = null,
    physicsSystem = null,
    applyHordeExplosion = null,
  } = {}) {
    if (!this.enabled) return;
    this._deps = {
      camera,
      character,
      playerDamageSystem,
      cameraSystem,
      carryItemSystem,
      enemyCutSystem,
      physicsSystem,
      applyHordeExplosion,
    };
    const dt = Math.max(0, Number(delta) || 0);
    this._consumeEvents(this.model.update(dt));
    const fireSources = [];
    let hiss = 0;
    let fire = 0;
    let urgency = 0;
    let audioCount = 0;
    _center.set(0, 0, 0);

    for (const record of this.records) {
      const state = record.state;
      if (state.state === PROPANE_TANK_STATE.EXPLODED) continue;
      const hole = state.holes[state.holes.length - 1];
      if (!hole) continue;
      const source = this._holeWorld(record, hole);
      const pressure = state.pressure;
      if (state.state === PROPANE_TANK_STATE.LEAKING) {
        record.gasAccumulator += dt * (10 + state.holes.length * 4) * pressure;
        let emitted = 0;
        while (record.gasAccumulator >= 1 && emitted < 4) {
          record.gasAccumulator -= 1;
          this.vents?.emitGas({
            position: source.position,
            direction: source.normal,
            pressure,
          });
          emitted += 1;
        }
        hiss += pressure;
      } else if (state.state === PROPANE_TANK_STATE.BURNING) {
        const fuseRatio = state.fuseDuration > 0 ? state.fuseRemaining / state.fuseDuration : 0;
        const finalRamp = fuseRatio < 0.28 ? 1 + (0.28 - fuseRatio) * 3.8 : 1;
        this._tankCenter(record, _otherCenter);
        fireSources.push({
          position: _otherCenter.clone(),
          holePosition: source.position.clone(),
          direction: source.normal.clone(),
          intensity: (0.8 + pressure * 0.35) * finalRamp,
          floorY: this._tankBaseY(record),
        });
        fire += pressure;
        urgency = Math.max(urgency, 1 - Math.max(0, fuseRatio));
      }
      this._tankCenter(record, _otherCenter);
      _center.add(_otherCenter);
      audioCount += 1;
    }

    if (audioCount > 0) _center.multiplyScalar(1 / audioCount);
    this.audio.update({
      hiss,
      fire,
      urgency,
      position: audioCount > 0 ? _center : null,
      camera,
    });
    this.vents?.update(dt, camera);
    this.fire?.update(dt, fireSources, camera);
    this.explosions?.update(dt);
  }

  _consumeEvents(events = []) {
    for (const event of events) {
      const record = this.recordsById.get(event.tankId);
      if (!record) continue;
      if (event.type === 'hole') this._createHole(record, event.hole);
      if (event.type === 'ignite') this._forceDrop(record);
      if (event.type === 'detonate') this._detonate(record, event.cause);
    }
  }

  _createHole(record, hole) {
    const mesh = new THREE.Mesh(this.holeGeometry, this.holeMaterial);
    mesh.name = `${record.id} Puncture ${hole.index + 1}`;
    mesh.position.fromArray(hole.point).addScaledVector(_normal.fromArray(hole.normal), 0.007);
    mesh.quaternion.setFromUnitVectors(_forward, _normal);
    mesh.renderOrder = 43;
    mesh.userData.noStaticMerge = true;
    record.tank.group.add(mesh);
    record.holes.push(mesh);
  }

  _holeWorld(record, hole) {
    _point.fromArray(hole.point);
    record.tank.group.localToWorld(_point);
    _normal.fromArray(hole.normal);
    record.tank.group.getWorldQuaternion(_worldQuat);
    _normal.applyQuaternion(_worldQuat).normalize();
    return { position: _point, normal: _normal };
  }

  _tankBaseY(record) {
    record.tank.group.getWorldPosition(_center);
    return _center.y;
  }

  _tankCenter(record, out) {
    record.tank.group.getWorldPosition(out);
    out.y += (record.tank.height ?? 0.95) * 0.46;
    return out;
  }

  _forceDrop(record) {
    const { carryItemSystem, character } = this._deps;
    if (record.tank.held && carryItemSystem?.held === record.tank) {
      carryItemSystem.dropHeld(character);
    }
  }

  _detonate(record, cause) {
    if (record.tank.group.visible === false) return;
    this._forceDrop(record);
    const point = this._tankCenter(record, new THREE.Vector3()).clone();
    const floorY = this._tankBaseY(record);
    const radius = HORDE_EXPLOSION_DEFAULT_RADIUS;
    this.explosions?.spawn({ point, floorY, radius, tank: record.tank });
    this.vents?.burstSmoke({ position: point, count: 14, radius: 1.15 });
    this.audio.boom(point, 1);
    record.tank.group.visible = false;
    record.tank.held = false;
    this._detonations += 1;

    this._deps.applyHordeExplosion?.({ point, radius, damage: 200 });
    this._damagePlayer(point, radius);
    this._shakeCamera(point, radius);
    this._impulseLooseProps(point, radius);
    this._queueChain(record, point, radius);
    void cause;
  }

  _damagePlayer(point, radius) {
    const { character, playerDamageSystem } = this._deps;
    if (!character?.group || !playerDamageSystem) return;
    character.group.getWorldPosition(_otherCenter);
    const distance = _otherCenter.distanceTo(point);
    if (distance >= radius) return;
    const falloff = distance <= 2 ? 1 : 1 - (distance - 2) / Math.max(0.1, radius - 2);
    const amount = PLAYER_MAX_DAMAGE * THREE.MathUtils.clamp(falloff, 0, 1);
    playerDamageSystem.dealPlayerDamage(character, {
      amount,
      kind: 'explosion',
      sourcePosition: point,
    });
    _outward.copy(_otherCenter).sub(point);
    _outward.y = 0;
    if (_outward.lengthSq() < 1e-5) _outward.set(0, 0, 1);
    else _outward.normalize();
    character.pendingImpulse?.addScaledVector(_outward, 5 + falloff * 8);
  }

  _shakeCamera(point, radius) {
    const { camera, cameraSystem } = this._deps;
    if (!camera || !cameraSystem) return;
    camera.getWorldPosition(_otherCenter);
    const distance = _otherCenter.distanceTo(point);
    const strength = THREE.MathUtils.clamp(1 - distance / (radius * 2.4), 0, 1);
    if (strength <= 0) return;
    cameraSystem.addWeaponPresentationImpulse?.({
      pitch: -0.045 * strength,
      yaw: (Math.random() - 0.5) * 0.055 * strength,
      shake: {
        durationMs: 420 + strength * 260,
        frequency: 24,
        amplitude: 0.08 + strength * 0.2,
      },
    });
  }

  _queueChain(sourceRecord, point, radius) {
    for (const record of this.records) {
      if (record === sourceRecord || record.state.state === PROPANE_TANK_STATE.EXPLODED) continue;
      this._tankCenter(record, _otherCenter);
      const distance = _otherCenter.distanceTo(point);
      if (distance > radius * 0.9) continue;
      const instant = distance <= CHAIN_INSTANT_RANGE;
      const delay = 0.15 + Math.min(0.25, distance / Math.max(0.1, radius) * 0.25);
      if (this.model.scheduleChain(record.id, { delay, instant })) {
        this._chainQueued += 1;
        if (record.tank.held) this._forceDrop(record);
      }
    }
  }

  _impulseLooseProps(point, radius) {
    const props = this._deps.enemyCutSystem?.props ?? [];
    let visited = 0;
    for (const prop of props) {
      const records = prop.type === 'rigRagdoll'
        ? (prop.ragdollBodies ?? []).map((entry) => entry.body)
        : [prop.body].filter(Boolean);
      for (const body of records) {
        if (visited >= 64) return;
        visited += 1;
        try {
          const t = body.translation();
          _otherCenter.set(t.x, t.y, t.z);
          const distance = _otherCenter.distanceTo(point);
          if (distance >= radius) continue;
          _outward.copy(_otherCenter).sub(point);
          if (_outward.lengthSq() < 1e-5) _outward.set(0, 1, 0);
          else _outward.normalize();
          const strength = (1 - distance / radius) * 8;
          const v = body.linvel();
          body.setLinvel({
            x: v.x + _outward.x * strength,
            y: v.y + Math.max(2, _outward.y * strength + strength * 0.45),
            z: v.z + _outward.z * strength,
          }, true);
        } catch { /* stale Rapier handle */ }
      }
    }
  }

  _nearestRecord(position = null) {
    let nearest = null;
    let distanceSq = Infinity;
    for (const record of this.records) {
      if (record.state.state === PROPANE_TANK_STATE.EXPLODED) continue;
      if (!position) return record;
      record.tank.group.getWorldPosition(_otherCenter);
      const d = _otherCenter.distanceToSquared(position);
      if (d < distanceSq) {
        distanceSq = d;
        nearest = record;
      }
    }
    return nearest;
  }

  igniteTank(id = null, position = null) {
    const record = id ? this.recordsById.get(String(id)) : this._nearestRecord(position);
    if (!record) return { ok: false, reason: 'no-tank' };
    this._consumeEvents(this.model.ignite(record.id, { cause: 'debug' }));
    return { ok: true, id: record.id, state: record.state.state };
  }

  detonateTank(id = null, position = null) {
    const record = id ? this.recordsById.get(String(id)) : this._nearestRecord(position);
    if (!record) return { ok: false, reason: 'no-tank' };
    this._consumeEvents(this.model.detonate(record.id, 'debug'));
    return { ok: true, id: record.id, state: record.state.state };
  }

  spawnTank({ x = 0, y = 0, z = 0, seed = Date.now() } = {}) {
    if (!this.scene || !this.level || !this.model) return { ok: false, reason: 'not-bound' };
    const tank = createPropaneTank({ seed });
    tank.group.position.set(Number(x) || 0, Number(y) || 0, Number(z) || 0);
    (this.level.group ?? this.scene).add(tank.group);
    this.level.propaneTanks ??= [];
    this.level.propaneTanks.push(tank);
    const id = `propane-debug-${Math.trunc(seed)}-${this.records.length + 1}`;
    const state = this.model.states.set(id, {
      ...createPropaneTankModel([{ id, seed }]).get(id),
    }).get(id);
    const record = this._addRecord(tank, id);
    this._deps.carryItemSystem?.worldPickups?.push?.(tank);
    return { ok: Boolean(record && state), id, position: { x, y, z } };
  }

  snapshot() {
    const counts = { intact: 0, leaking: 0, burning: 0, exploded: 0 };
    for (const record of this.records) counts[record.state.state] += 1;
    return {
      enabled: this.enabled,
      tanks: this.records.length,
      counts,
      hits: this._hits,
      detonations: this._detonations,
      chainQueued: this._chainQueued,
      states: this.model?.snapshot?.() ?? [],
    };
  }

  unbind() {
    for (const record of this.records) {
      for (const hole of record.holes) hole.removeFromParent();
      record.holes.length = 0;
    }
    this.vents?.dispose();
    this.fire?.dispose();
    this.explosions?.dispose();
    this.vents = null;
    this.fire = null;
    this.explosions = null;
    this.records = [];
    this.recordsById.clear();
    this.model = null;
    this.enabled = false;
    this.scene = null;
    this.level = null;
  }

  dispose() {
    this.unbind();
    this.audio.dispose();
    this.holeGeometry.dispose();
    this.holeMaterial.dispose();
  }
}
