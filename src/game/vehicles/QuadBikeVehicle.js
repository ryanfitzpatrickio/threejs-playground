import * as THREE from 'three';
import { BaseVehicle } from './BaseVehicle.js';
import { GARAGE_QUAD_DEFAULT_FRAME, GARAGE_QUAD_DEFAULT_WHEELS, getGarageTireOption } from './garageBuilds.js';
import {
  VEHICLE_OVERLAY_PART,
  createVehicleChassisMaterial,
} from '../materials/createVehicleOverlayMaterials.js';
import { pruneQuadHandlebarStray } from '../geometry/pruneDisconnectedComponents.js';

export const QUAD_BIKE_ASSET_URL = '/assets/models/quad-bike.glb';

export const QUAD_BIKE_PAINTS = Object.freeze([
  Object.freeze({ id: 'forest', name: 'Forest green', color: '#315a38' }),
  Object.freeze({ id: 'rally-red', name: 'Rally red', color: '#9d2721' }),
  Object.freeze({ id: 'sand', name: 'Trail sand', color: '#9a7b4f' }),
  Object.freeze({ id: 'black', name: 'Black', color: '#202326' }),
]);

const MODEL_SCALE = 2.5;
const WHEEL_NAMES = ['lf tire', 'rf tire', 'lr tire', 'rr tire'];
const SHOCK_NAMES = [
  ['innershocks', 'shocks4'],
  ['inner shocks2', 'shocks3'],
  ['innershocks3', 'shocks2'],
  ['innershocks4', 'shocks1'],
];

/** A compact, single-seat ATV using BaseVehicle's Rapier raycast suspension. */
export class QuadBikeVehicle extends BaseVehicle {
  constructor(options = {}) {
    const paint = QUAD_BIKE_PAINTS.find((entry) => entry.id === options.paintId)
      ?? QUAD_BIKE_PAINTS[0];
    const overrideConfig = options.config ?? {};
    const overrideGround = overrideConfig.ground ?? {};
    const overrideRayCast = overrideGround.rayCast ?? {};
    const quadTire = getGarageTireOption(options.tireId ?? GARAGE_QUAD_DEFAULT_WHEELS.tireId);
    const useEmbeddedModelTires = options.useEmbeddedModelTires === true || quadTire.id === 'quad-model';
    const wheelVisual = options.wheelVisual ?? (
      !useEmbeddedModelTires && quadTire.url ? { url: quadTire.url } : null
    );
    super({
      ...options,
      wheelVisual,
      name: options.name ?? 'Trail Quad',
      hideEngine: true,
      chassisOverlay: {
        url: QUAD_BIKE_ASSET_URL,
        profileId: 'quad-bike',
        position: [0, -0.68, 0.19],
        rotationDegrees: [0, 180, 0],
        scale: [MODEL_SCALE, MODEL_SCALE, MODEL_SCALE],
        chassisSurfaceMode: 'metallic',
        useAuthoredTexture: false,
        ...(options.chassisOverlay ?? {}),
        chassisPaint: options.chassisOverlay?.chassisPaint ?? {
          color: new THREE.Color(paint.color).getHex(),
          metalness: 0.88,
          roughness: 0.22,
        },
        partOverrides: options.partOverrides ?? options.chassisOverlay?.partOverrides ?? null,
      },
      frameParameters: {
        ...GARAGE_QUAD_DEFAULT_FRAME,
        ...(options.frameParameters ?? {}),
      },
      config: {
        engineProfile: 'quad',
        damping: { linear: 0.08, angular: 1.05 },
        seats: [{
          name: 'quad-rider', offset: [0, 0.28, 0.05], facing: 0, isDriver: true,
          handGrip: { offset: [0, 0.69, -0.2], spacing: 0.58 },
          footGrip: { left: [-0.34, -0.02, -0.12], right: [0.34, -0.02, -0.12] },
        }],
        exitOffset: [-1.15, 0, 0.12],
        controls: { steerSmoothing: 7, throttleSmoothing: 7 },
        ...overrideConfig,
        body: {
          size: [1.22, 0.62, 1.56],
          massOverride: 330,
          friction: 0.45,
          centerOfMassOffset: [0, -0.28, 0.08],
          ...overrideConfig.body,
        },
        ground: {
          wheels: [
            [-0.67, -0.31, -0.68], [0.67, -0.31, -0.68],
            [-0.67, -0.31, 0.68], [0.67, -0.31, 0.68],
          ],
          wheelRadius: 0.35, wheelWidth: 0.27, driveLayout: 'awd',
          enginePower: 8.2, brakeForce: 25, maxSpeed: 32, maxReverseSpeed: 8,
          rollingResistance: 0.8,
          articulation: { wheelSteerAngle: 0.5, steeringWheelTurn: 0.5 },
          ...overrideGround,
          rayCast: {
            chassisColliderSize: [1.05, 0.4, 1.32], chassisColliderOffset: [0, 0.16, 0.05],
            connectionHeight: 0.02, wheelRadius: 0.35,
            suspensionRestLength: 0.34, suspensionStiffness: 27,
            suspensionCompression: 11, suspensionRelaxation: 12,
            maxSuspensionTravel: 0.3, maxSuspensionForce: 5000,
            frictionSlip: 1.75, sideFrictionStiffness: 0.72,
            maxSteerAngle: 0.5, steerWheelbase: 1.36,
            maxSteerYawRate: 1.12, highSpeedSteerYawRate: 0.62,
            steerTaperAt: 7, steerTaperEnd: 28,
            yawAssistMaxSpeed: 7, yawAssistStrength: 2.4, settleSag: 0.1,
            ...overrideRayCast,
          },
        },
      },
    });
    this.vehicleKind = 'quad';
    this.driverAnimationState = 'drivingQuad';
    this.paintId = paint.id;
    this.paintColor = new THREE.Color(paint.color);
    this.handleBars = null;
    this._handleBarsBaseYaw = 0;
    this.authoredEngines = [];
    this.authoredShocks = [];
  }

  async _attachChassisOverlay() {
    const overlay = await super._attachChassisOverlay();
    if (!overlay) return null;

    this.frameVisual.visible = false;
    if (this.wheelAxleGroup) this.wheelAxleGroup.visible = false;

    this.handleBars = findNamed(overlay, 'handle bars');
    if (this.handleBars?.isMesh) pruneQuadHandlebarStray(this.handleBars);
    this._handleBarsBaseYaw = this.handleBars?.rotation.y ?? 0;
    this.authoredEngines = ['engine', 'engine2', 'engine3']
      .map((name) => findNamed(overlay, name))
      .filter(Boolean)
      .map((node, index) => ({ node, index, rest: node.position.clone() }));

    this.authoredShocks = SHOCK_NAMES.map((names, wheelIndex) => ({
      wheelIndex,
      parts: names.map((name) => findNamed(overlay, name)).filter(Boolean).map((node) => ({
        node,
        restPosition: node.position.clone(),
        restScale: node.scale.clone(),
      })),
    }));

    this._applyQuadChassisPaint();

    for (let index = 0; index < this.wheelMeshes.length; index += 1) {
      const source = findNamed(overlay, WHEEL_NAMES[index]);
      if (!source) continue;
      if (this.wheelVisualOptions?.url) {
        source.visible = false;
        continue;
      }
      const wheel = this.wheelMeshes[index];
      if (!wheel) continue;
      const visual = source.clone(false);
      visual.name = `${WHEEL_NAMES[index]} articulated`;
      visual.visible = true;
      visual.position.set(0, 0, 0);
      visual.rotation.set(0, 0, 0);
      visual.scale.setScalar(MODEL_SCALE);
      visual.castShadow = true;
      wheel.add(visual);
      for (const material of Array.isArray(wheel.material) ? wheel.material : [wheel.material]) {
        material.visible = false;
      }
      source.visible = false;
    }
    return overlay;
  }

  _applyQuadChassisPaint() {
    const paint = this.chassisOverlayOptions?.chassisPaint ?? {
      color: this.paintColor.getHex(),
      metalness: 0.88,
      roughness: 0.22,
    };
    if (this.chassisOverlayOptions) {
      this.chassisOverlayOptions.chassisPaint = { ...paint, color: this.paintColor.getHex() };
    }
    if (!this.chassisOverlay) return;
    this.chassisOverlay.traverse((child) => {
      if (!child.isMesh || child.userData.vehicleOverlayPart !== VEHICLE_OVERLAY_PART.CHASSIS) return;
      const previous = child.material;
      child.material = createVehicleChassisMaterial({
        name: 'Vehicle chassis paint',
        ...paint,
        color: this.paintColor.getHex(),
      });
      if (child.material.wetnessUniform) {
        this.wetnessMaterials.push(child.material);
      }
      disposeQuadMaterial(previous);
    });
  }

  setQuadPaint(paintId) {
    const paint = QUAD_BIKE_PAINTS.find((entry) => entry.id === paintId) ?? QUAD_BIKE_PAINTS[0];
    this.paintId = paint.id;
    this.paintColor.set(paint.color);
    this._applyQuadChassisPaint();
  }

  _articulate(steerInput) {
    // Fixed-step mode smooths physics controls after the render update. Use the
    // current latched input for immediate visual response while physics catches up.
    const visualSteer = Number.isFinite(this.controls?.steer) ? this.controls.steer : steerInput;
    super._articulate(visualSteer);
    this._lastQuadSteer = THREE.MathUtils.clamp(visualSteer, -1, 1);
    if (this.handleBars) {
      this.handleBars.rotation.y = this._handleBarsBaseYaw
        - this._lastQuadSteer * 0.42;
    }
    for (const shock of this.authoredShocks) {
      const wheel = this.wheelMeshes[shock.wheelIndex];
      const nodeY = wheel?.userData.suspNode?.position.y;
      const restY = wheel?.userData.restY;
      if (!Number.isFinite(nodeY) || !Number.isFinite(restY)) continue;
      const travel = (nodeY - restY) / MODEL_SCALE;
      for (const part of shock.parts) {
        part.node.position.y = part.restPosition.y + travel * 0.42;
        part.node.scale.y = part.restScale.y * THREE.MathUtils.clamp(1 + travel * 0.8, 0.78, 1.18);
      }
    }
  }

  _updateVibrations(dt, controls, speed) {
    super._updateVibrations(dt, controls, speed);
    const intensity = this.parkedMode ? 0 : 0.0005 + Math.abs(controls?.throttle ?? 0) * 0.0016;
    for (const { node, index, rest } of this.authoredEngines) {
      const phase = this._vibrationTime * (43 + index * 7) + index * 1.9;
      node.position.set(
        rest.x + Math.sin(phase) * intensity,
        rest.y + Math.cos(phase * 1.17) * intensity * 1.4,
        rest.z,
      );
    }
  }

  snapshot() {
    return {
      ...super.snapshot(),
      vehicleKind: this.vehicleKind,
      paintId: this.paintId,
      authoredParts: {
        handleBars: Boolean(this.handleBars),
        handleBarYaw: Number((this.handleBars?.rotation.y ?? 0).toFixed(3)),
        steerInput: Number((this._lastQuadSteer ?? 0).toFixed(3)),
        engineMeshes: this.authoredEngines.length,
        shockMeshes: this.authoredShocks.reduce((count, shock) => count + shock.parts.length, 0),
        wheelMeshes: this.wheelMeshes.filter((wheel) => wheel.children.some((child) => /articulated$/.test(child.name))).length,
      },
    };
  }
}

function findNamed(root, name) {
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const target = normalize(name);
  let found = null;
  root.traverse((node) => {
    if (!found && normalize(node.name) === target) found = node;
  });
  return found;
}

function disposeQuadMaterial(material) {
  if (!material) return;
  for (const entry of Array.isArray(material) ? material : [material]) {
    entry.dispose?.();
  }
}
