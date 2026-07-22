/**
 * Ladybug materials — hard chitin (elytra/pronotum) + soft underside shells.
 *
 * Body mesh: MeshStandardNodeMaterial with zone-gated albedo (red base + black
 * spots from baked spotMask, black head, dark legs, glossy eyes).
 *
 * Soft shells: few MeshBasicNodeMaterial layers extruded along normals for
 * belly/joint setae (kept light for performance).
 */

import * as THREE from 'three';
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import {
  attribute,
  clamp,
  float,
  Fn,
  mix,
  normalLocal,
  positionLocal,
  smoothstep,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { LADYBUG_ZONE } from './ladybugBodyGeometry.js';

export const LADYBUG_SHELL_COUNT = 12;

/** sRGB palette for seven-spotted ladybug. */
export const LADYBUG_COLORS = Object.freeze({
  red: [0.78, 0.12, 0.08],
  redDark: [0.55, 0.06, 0.04],
  black: [0.04, 0.035, 0.04],
  spot: [0.02, 0.02, 0.022],
  belly: [0.55, 0.42, 0.28],
  bellySoft: [0.62, 0.48, 0.32],
  head: [0.06, 0.05, 0.055],
  cheek: [0.92, 0.90, 0.86],
  leg: [0.08, 0.07, 0.07],
  eye: [0.02, 0.02, 0.025],
  eyeHighlight: [0.35, 0.38, 0.42],
});

/**
 * @typedef {object} LadybugUniforms
 * @property {import('three/tsl').ShaderNodeObject} time
 * @property {import('three/tsl').ShaderNodeObject} breeze
 * @property {import('three/tsl').ShaderNodeObject} spotStrength
 * @property {import('three/tsl').ShaderNodeObject} redTint
 * @property {import('three/tsl').ShaderNodeObject} naked
 * @property {import('three/tsl').ShaderNodeObject} shellScale
 */

export function createLadybugUniforms() {
  return {
    time: uniform(0),
    breeze: uniform(0.15),
    spotStrength: uniform(1),
    redTint: uniform(1),
    naked: uniform(0),
    shellScale: uniform(1),
  };
}

/**
 * Soft-shell dynamics: time + light breeze for setae sway uniforms.
 */
export class LadybugShellDynamics {
  /**
   * @param {ReturnType<typeof createLadybugUniforms>} uniforms
   */
  constructor(uniforms) {
    this.uniforms = uniforms;
    this._t = 0;
  }

  setNaked(on) {
    this.uniforms.naked.value = on ? 1 : 0;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} _worldRoot
   * @param {{ time?: number, breeze?: number }} [opts]
   */
  update(dt, _worldRoot, opts = {}) {
    this._t = opts.time ?? (this._t + dt);
    this.uniforms.time.value = this._t;
    if (opts.breeze != null) this.uniforms.breeze.value = opts.breeze;
  }
}

function zoneAlbedo(zone, spot, u) {
  const red = vec3(...LADYBUG_COLORS.red).mul(u.redTint);
  const redDark = vec3(...LADYBUG_COLORS.redDark).mul(u.redTint);
  const black = vec3(...LADYBUG_COLORS.black);
  const spotCol = vec3(...LADYBUG_COLORS.spot);
  const belly = vec3(...LADYBUG_COLORS.belly);
  const head = vec3(...LADYBUG_COLORS.head);
  const cheek = vec3(...LADYBUG_COLORS.cheek);
  const leg = vec3(...LADYBUG_COLORS.leg);
  const eye = vec3(...LADYBUG_COLORS.eye);

  // Elytra: red → black spots
  const elytraBase = mix(red, redDark, float(0.25));
  const elytra = mix(elytraBase, spotCol, clamp(spot.mul(u.spotStrength), 0, 1));

  // Pronotum: mostly black with white cheek patches (approx via spot mask unused)
  const pronotum = mix(black, cheek, float(0.08));

  const z = zone;
  // zone gates via smoothstep bands
  let col = elytra;
  col = mix(col, pronotum, smoothstep(float(0.5), float(1.5), z).mul(
    float(1).sub(smoothstep(float(1.5), float(2.5), z)),
  ));
  col = mix(col, belly, smoothstep(float(1.5), float(2.5), z).mul(
    float(1).sub(smoothstep(float(2.5), float(3.5), z)),
  ));
  col = mix(col, head, smoothstep(float(2.5), float(3.5), z).mul(
    float(1).sub(smoothstep(float(3.5), float(4.5), z)),
  ));
  col = mix(col, eye, smoothstep(float(3.5), float(4.5), z).mul(
    float(1).sub(smoothstep(float(4.5), float(5.5), z)),
  ));
  col = mix(col, leg, smoothstep(float(4.5), float(5.5), z).mul(
    float(1).sub(smoothstep(float(6.5), float(7.5), z)),
  ));
  // antenna + joint stay dark
  col = mix(col, leg, smoothstep(float(5.5), float(6.5), z));
  return col;
}

/**
 * Hard-body material (chitin + spots).
 * @param {ReturnType<typeof createLadybugUniforms>} uniforms
 */
export function createLadybugBodyMaterial(uniforms) {
  const mat = new MeshStandardNodeMaterial();
  mat.name = 'LadybugBody';
  mat.metalness = 0.05;
  mat.roughness = 0.35;

  const vSpot = varying(float(0), 'vLadySpot');
  const vZone = varying(float(0), 'vLadyZone');

  mat.positionNode = Fn(() => {
    vSpot.assign(attribute('spotMask', 'float'));
    vZone.assign(attribute('zoneId', 'float'));
    return positionLocal;
  })();

  mat.colorNode = Fn(() => {
    const zone = vZone;
    const spot = vSpot;
    const col = zoneAlbedo(zone, spot, uniforms);
    // Eyes slightly brighter specular via emissive-ish boost in color
    const eyeBoost = smoothstep(float(3.5), float(4.5), zone)
      .mul(float(1).sub(smoothstep(float(4.5), float(5.5), zone)));
    return mix(col, vec3(...LADYBUG_COLORS.eyeHighlight), eyeBoost.mul(0.15));
  })();

  mat.roughnessNode = Fn(() => {
    const zone = vZone;
    // Glossy elytra / eyes; matte belly
    const glossy = smoothstep(float(-0.5), float(0.5), zone)
      .mul(float(1).sub(smoothstep(float(1.5), float(2.5), zone)));
    const eye = smoothstep(float(3.5), float(4.5), zone)
      .mul(float(1).sub(smoothstep(float(4.5), float(5.5), zone)));
    return mix(float(0.55), float(0.22), glossy.add(eye.mul(0.5)));
  })();

  return mat;
}

/**
 * Soft underside / joint shell layer.
 * @param {ReturnType<typeof createLadybugUniforms>} uniforms
 * @param {number} layerIndex 1..N
 * @param {number} layerCount
 */
export function createLadybugShellMaterial(uniforms, layerIndex, layerCount) {
  const mat = new MeshBasicNodeMaterial();
  mat.name = `LadybugShell_${layerIndex}`;
  mat.transparent = true;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;

  const t = layerIndex / Math.max(1, layerCount);
  const vShell = varying(float(0), 'vLadyShell');

  mat.positionNode = Fn(() => {
    const shellLen = attribute('shellLen', 'float');
    vShell.assign(shellLen);
    const n = normalLocal;
    const extrude = shellLen
      .mul(uniforms.shellScale)
      .mul(float(t))
      .mul(float(1).sub(uniforms.naked));
    return positionLocal.add(n.mul(extrude));
  })();

  mat.colorNode = Fn(() => {
    const zone = attribute('zoneId', 'float');
    const belly = vec3(...LADYBUG_COLORS.bellySoft);
    const joint = vec3(...LADYBUG_COLORS.leg).mul(1.4);
    const isBelly = smoothstep(float(1.5), float(2.5), zone)
      .mul(float(1).sub(smoothstep(float(2.5), float(3.5), zone)));
    const col = mix(joint, belly, isBelly);
    // Fade shells with no length / naked / outer layers
    const alpha = vShell
      .mul(float(40))
      .clamp(0, 1)
      .mul(float(1).sub(uniforms.naked))
      .mul(float(1).sub(float(t).mul(0.55)));
    return vec4(col, alpha.mul(0.55));
  })();

  mat.opacityNode = Fn(() => {
    const shellLen = attribute('shellLen', 'float');
    return shellLen
      .mul(float(40))
      .clamp(0, 1)
      .mul(float(1).sub(uniforms.naked))
      .mul(float(0.5).mul(float(1).sub(float(t).mul(0.4))));
  })();

  return mat;
}
