/**
 * AAA mud particles for WebGPU. CPU writes InstancedMesh instanceMatrix +
 * instanceColor each frame (the proven dynamic-instancing path from
 * DirtDustSystem / createInfiniteCityLevel). TSL supplies only the fragment
 * look: procedural blob, lighting, wet specular, fresnel, life fade.
 *
 * StorageInstancedBufferAttribute + storage() was tried first; on WebGPU those
 * buffers are meant for compute writes and CPU needsUpdate does not re-upload,
 * so the GPU kept reading the initial dead state and nothing rendered.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  uniform,
  uv,
  wgslFn,
  attribute,
} from 'three/tsl';
import {
  uMudLightColor,
  uMudAmbient,
  uMudWetCol,
  uMudDryCol,
  uMudDecalDark,
  uMudDecalLight,
} from './mudParticleUniforms.js';

const DEFAULT_SUN_DIRECTION = new THREE.Vector3(-8, 12, 7).normalize();

const MUD_NOISE_WGSL = wgslFn(/* wgsl */ `
fn mud_hash(coord: vec2f) -> f32 {
  var q = fract(coord * vec2f(123.34, 456.21));
  q += vec2f(dot(q, q + vec2f(45.32)));
  return fract(q.x * q.y);
}

fn mud_vnoise(coord: vec2f) -> f32 {
  let i = floor(coord);
  let f = fract(coord);
  let a = mud_hash(i);
  let b = mud_hash(i + vec2f(1.0, 0.0));
  let c = mud_hash(i + vec2f(0.0, 1.0));
  let d = mud_hash(i + vec2f(1.0, 1.0));
  let u = f * f * (vec2f(3.0) - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn mud_fbm(coord: vec2f) -> f32 {
  var p = coord;
  var v = 0.0;
  var a = 0.5;
  for (var i = 0; i < 4; i++) {
    v += a * mud_vnoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}
`);

const AAA_MUD_WGSL = wgslFn(/* wgsl */ `
fn evaluateAaaMud(
  uvCoord: vec2f,
  life: f32,
  seed: f32,
  lightDirView: vec3f,
  lightColor: vec3f,
  ambient: vec3f,
  wetCol: vec3f,
  dryCol: vec3f
) -> vec4f {
  let c = uvCoord * 2.0 - vec2f(1.0);
  let r = length(c);

  let n = mud_fbm(c * 2.5 + seed * 37.0);
  let edge = 0.95 + (n - 0.5) * 0.55;
  let mask = smoothstep(edge, edge - 0.35, r);
  if (mask <= 0.001) {
    return vec4f(0.0);
  }

  let z = sqrt(max(0.0, 1.0 - min(1.0, r * r)));
  let nrm = normalize(vec3f(c, z));
  let nptr = normalize(nrm + vec3f(
    (mud_fbm(c * 4.0 + seed * 11.0) - 0.5) * 0.6,
    (mud_fbm(c * 4.0 + seed * 23.0) - 0.5) * 0.6,
    0.0
  ));

  let L = normalize(lightDirView);
  let diff = clamp(dot(nptr, L), 0.0, 1.0);
  let wet = 1.0 - smoothstep(0.0, 0.85, life);

  let tone = clamp(life * 0.65 + (n - 0.5) * 0.35 + (mud_hash(vec2f(seed, seed)) - 0.5) * 0.15, 0.0, 1.0);
  let albedo = mix(wetCol, dryCol, tone) * 1.18;
  let ao = mix(0.72, 1.0, n);

  var color = albedo * (ambient * ao + diff * lightColor * 1.12);

  let V = vec3f(0.0, 0.0, 1.0);
  let H = normalize(L + V);
  let spec = pow(clamp(dot(nptr, H), 0.0, 1.0), 48.0);
  color += spec * wet * vec3f(1.0, 0.95, 0.85) * 0.42;

  let fres = pow(1.0 - clamp(nrm.z, 0.0, 1.0), 3.0);
  color += fres * wet * 0.12 * vec3f(0.8, 0.85, 0.9);

  let fadeIn = smoothstep(0.0, 0.06, life);
  let fadeOut = 1.0 - smoothstep(0.7, 1.0, life);
  return vec4f(color, mask * fadeIn * fadeOut);
}
`, [ MUD_NOISE_WGSL ]);

const DECAL_WGSL = wgslFn(/* wgsl */ `
fn evaluateMudDecal(uvCoord: vec2f, birth: f32, now: f32, lifetime: f32, seed: f32, darkCol: vec3f, lightCol: vec3f) -> vec4f {
  let age = (now - birth) / lifetime;
  if (age < 0.0 || age > 1.0) {
    return vec4f(0.0);
  }
  let c = uvCoord * 2.0 - vec2f(1.0);
  let r = length(c);
  let n = mud_vnoise(c * 3.0 + seed * 17.0);
  let edge = 0.9 + (n - 0.5) * 0.5;
  let mask = smoothstep(edge, edge - 0.4, r);
  if (mask <= 0.001) {
    return vec4f(0.0);
  }
  let fade = 1.0 - smoothstep(0.55, 1.0, age);
  let col = mix(darkCol, lightCol, n);
  return vec4f(col, mask * fade * 0.85);
}
`, [ MUD_NOISE_WGSL ]);

const _viewVel = new THREE.Vector3();
const _velView = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _roll = new THREE.Quaternion();
const _billboardAxis = new THREE.Vector3(0, 0, 1);
const _cameraRight = new THREE.Vector3();
const _cameraUp = new THREE.Vector3();
const _decalPos = new THREE.Vector3();
const _decalScale = new THREE.Vector3();
const _decalQuat = new THREE.Quaternion();
const _decalEuler = new THREE.Euler();

function smoothstep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function aaaSizeOverLife(life01, baseScale) {
  const grow = smoothstep(0, 0.12, life01);
  const shrink = 1 - 0.35 * smoothstep(0.65, 1, life01);
  return baseScale * THREE.MathUtils.lerp(0.65, 1, grow) * shrink;
}

function composeParticleMatrix(particle, camera) {
  const { x, y, z, vx, vy, vz, life01, scale } = particle;
  const size = aaaSizeOverLife(life01, scale);
  if (size <= 0.001 || !camera) return null;

  const camQuat = camera.quaternion;
  _cameraRight.set(1, 0, 0).applyQuaternion(camQuat);
  _cameraUp.set(0, 1, 0).applyQuaternion(camQuat);

  _viewVel.set(vx, vy, vz);
  _velView.copy(_viewVel).transformDirection(camera.matrixWorldInverse);
  const sp = Math.hypot(_velView.x, _velView.y);
  const stretch = THREE.MathUtils.clamp(sp * 0.075, 0, 1.4);
  const width = size * (1 + stretch);
  const height = size;

  const screenX = _viewVel.dot(_cameraRight);
  const screenY = _viewVel.dot(_cameraUp);
  const roll = Math.atan2(screenY, screenX) - Math.PI * 0.5;
  _roll.setFromAxisAngle(_billboardAxis, roll);
  _q.copy(camQuat).multiply(_roll);

  _p.set(x, y, z);
  _s.set(width, height, 1);
  _m.compose(_p, _q, _s);
  return _m;
}

/**
 * @param {object} opts
 * @param {number} opts.poolSize
 * @param {number} [opts.decalCount]
 * @param {number} [opts.decalLife]
 * @param {THREE.Object3D} [opts.parent]
 * @param {string} [opts.name]
 */
export function createAaaMudParticleRenderer({
  poolSize,
  decalCount = 256,
  decalLife = 5.0,
  parent = null,
  name = 'AAA Mud Particles',
}) {
  const lightDirView = uniform(new THREE.Vector3(0, 0, 1));
  // Shared look uniforms (shader-debug Mud folder) — Vector3 linear, not Color.
  const lightColor = uMudLightColor;
  const ambient = uMudAmbient;
  const wetCol = uMudWetCol;
  const dryCol = uMudDryCol;
  const decalDark = uMudDecalDark;
  const decalLight = uMudDecalLight;
  const decalNow = uniform(0);
  const decalLifetime = uniform(decalLife);

  const geometry = new THREE.PlaneGeometry(1, 1);
  const lifeAttr = new THREE.InstancedBufferAttribute(new Float32Array(poolSize), 1);
  const seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(poolSize), 1);
  lifeAttr.setUsage(THREE.DynamicDrawUsage);
  seedAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aLife', lifeAttr);
  geometry.setAttribute('aSeed', seedAttr);

  const aLife = attribute('aLife', 'float');
  const aSeed = attribute('aSeed', 'float');

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.toneMapped = true;

  const shaded = AAA_MUD_WGSL({
    uvCoord: uv(),
    life: aLife,
    seed: aSeed,
    lightDirView,
    lightColor,
    ambient,
    wetCol,
    dryCol,
  });
  material.colorNode = shaded.xyz;
  material.opacityNode = shaded.w;
  const mesh = new THREE.InstancedMesh(geometry, material, poolSize);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.count = poolSize;

  const collapsed = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < poolSize; i += 1) {
    mesh.setMatrixAt(i, collapsed);
  }
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;

  // ---- decals ----
  const decalGeometry = new THREE.PlaneGeometry(1, 1);
  // Decal transforms and birth times are immutable between spawns. Age them in
  // the shader so a static pool does not re-cross the WebGPU IPC boundary every
  // frame. A slot is uploaded only when the ring buffer reuses it.
  const decalBirthAttr = new THREE.InstancedBufferAttribute(new Float32Array(decalCount).fill(-decalLife), 1);
  const decalSeedAttr = new THREE.InstancedBufferAttribute(new Float32Array(decalCount), 1);
  decalBirthAttr.setUsage(THREE.DynamicDrawUsage);
  decalSeedAttr.setUsage(THREE.DynamicDrawUsage);
  decalGeometry.setAttribute('aDecalBirth', decalBirthAttr);
  decalGeometry.setAttribute('aDecalSeed', decalSeedAttr);

  const dBirth = attribute('aDecalBirth', 'float');
  const dSeed = attribute('aDecalSeed', 'float');

  const decalMaterial = new MeshBasicNodeMaterial();
  decalMaterial.transparent = true;
  decalMaterial.depthWrite = false;
  decalMaterial.depthTest = true;
  decalMaterial.polygonOffset = true;
  decalMaterial.polygonOffsetFactor = -2;
  decalMaterial.polygonOffsetUnits = -2;
  decalMaterial.toneMapped = true;

  const decalShaded = DECAL_WGSL({
    uvCoord: uv(),
    birth: dBirth,
    now: decalNow,
    lifetime: decalLifetime,
    seed: dSeed,
    darkCol: decalDark,
    lightCol: decalLight,
  });
  decalMaterial.colorNode = decalShaded.xyz;
  decalMaterial.opacityNode = decalShaded.w;

  const decalMesh = new THREE.InstancedMesh(decalGeometry, decalMaterial, decalCount);
  decalMesh.name = `${name} Decals`;
  decalMesh.frustumCulled = false;
  decalMesh.renderOrder = 3;
  decalMesh.count = decalCount;
  for (let i = 0; i < decalCount; i += 1) {
    decalMesh.setMatrixAt(i, collapsed);
  }
  decalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  decalMesh.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = `${name} Group`;
  group.add(decalMesh);
  group.add(mesh);
  parent?.add(group);

  const particleState = Array.from({ length: poolSize }, () => ({
    alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life01: 0, scale: 0, seed: 0,
  }));
  const decals = Array.from({ length: decalCount }, () => ({
    birth: -1, x: 0, y: 0, z: 0, scale: 0, rot: 0,
  }));

  let decalCursor = 0;
  const _lightDir = new THREE.Vector3();
  const _sunDir = DEFAULT_SUN_DIRECTION.clone();
  let _camera = null;

  const hideParticle = (index) => {
    particleState[index].alive = false;
    lifeAttr.setX(index, 0);
    seedAttr.setX(index, 0);
    mesh.setMatrixAt(index, collapsed);
  };

  const writeParticle = (index, { x, y, z, vx, vy, vz, life01, scale, seed }) => {
    const p = particleState[index];
    p.alive = scale > 0.001;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life01 = life01; p.scale = scale; p.seed = seed;
    lifeAttr.setX(index, life01);
    seedAttr.setX(index, seed);
  };

  const spawnDecal = (x, y, z, now, scale = 0.14 + Math.random() * 0.22) => {
    const j = decalCursor;
    decalCursor = (decalCursor + 1) % decalCount;
    const d = decals[j];
    d.birth = now;
    d.x = x; d.y = y; d.z = z;
    d.scale = scale;
    d.rot = Math.random() * 6.283185;
    _decalPos.set(x, y, z);
    _decalScale.set(scale, scale, 1);
    _decalEuler.set(-Math.PI * 0.5, d.rot, 0, 'YXZ');
    _decalQuat.setFromEuler(_decalEuler);
    _m.compose(_decalPos, _decalQuat, _decalScale);
    decalMesh.setMatrixAt(j, _m);
    decalBirthAttr.setX(j, now);
    decalSeedAttr.setX(j, d.rot);
    decalMesh.instanceMatrix.addUpdateRange(j * 16, 16);
    decalBirthAttr.addUpdateRange(j, 1);
    decalSeedAttr.addUpdateRange(j, 1);
    decalMesh.instanceMatrix.needsUpdate = true;
    decalBirthAttr.needsUpdate = true;
    decalSeedAttr.needsUpdate = true;
  };

  const flushParticles = () => {
    if (!_camera) return;
    for (let i = 0; i < poolSize; i += 1) {
      const p = particleState[i];
      if (!p.alive) {
        mesh.setMatrixAt(i, collapsed);
        continue;
      }
      const matrix = composeParticleMatrix(p, _camera);
      if (matrix) {
        mesh.setMatrixAt(i, matrix);
      } else {
        mesh.setMatrixAt(i, collapsed);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    lifeAttr.needsUpdate = true;
    seedAttr.needsUpdate = true;
  };

  const update = ({ camera = null, elapsedTime: t = 0, sunDirection = _sunDir } = {}) => {
    decalNow.value = t;
    _camera = camera;
    if (camera) {
      _lightDir.copy(sunDirection).transformDirection(camera.matrixWorldInverse);
      lightDirView.value.copy(_lightDir);
    }
    flushParticles();
  };

  const dispose = () => {
    group.removeFromParent();
    geometry.dispose();
    material.dispose();
    decalGeometry.dispose();
    decalMaterial.dispose();
  };

  return {
    group,
    mesh,
    decalMesh,
    writeParticle,
    hideParticle,
    spawnDecal,
    update,
    dispose,
  };
}
