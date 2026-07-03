/**
 * createLightningBolt.js
 *
 * Direct port of github.com/achrefelouafi/RainSystemThreeJS's
 * src/lightningBolt.js. The CPU-side procedural generation (`subdivide`,
 * `grow`, `addRibbon`, `buildBolt`) is copied verbatim — pure JS math, nothing
 * rendering-API-specific about it. Only the two materials are reimplemented
 * in TSL (this project renders through THREE.WebGPURenderer, not the classic
 * `THREE.ShaderMaterial`/GLSL pipeline the reference targets), and both are
 * plain (non-instanced) `THREE.Mesh`es with regular vertex attributes — none
 * of this session's InstancedMesh-specific pitfalls (storage buffers,
 * `varyingProperty`, positionLocal shadowed by an automatic per-instance
 * transform) apply here. Reading a custom attribute like `aBright`/`aSide`
 * again in the fragment stage is safe and needs no special handling: TSL
 * auto-generates the varying for any regular attribute read in the wrong
 * stage. The only attribute that behaves specially is `positionLocal` itself
 * (reassigned when a custom `positionNode` is set) — this file never reads
 * `positionLocal` outside of `positionNode`'s own `Fn()`, so that pitfall
 * doesn't come up.
 *
 * Alpha handling matters here: the reference hardcodes `gl_FragColor.a = 1.0`
 * always and controls visibility entirely through how BRIGHT the additive
 * RGB is (near-zero RGB adds nothing visible). `material.opacityNode` is
 * fixed at `1` on both materials to match — all fading lives in `colorNode`.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  uniform,
  attribute,
  positionLocal,
  cameraPosition,
  normalize,
  cross,
  smoothstep,
  abs,
  uv,
  length,
  float,
  vec3,
} from 'three/tsl';

const MAX_VERTS = 12000;
const MAX_IDX = 20000;

const _v = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _tan = new THREE.Vector3();

// Recursively displaces a straight segment sideways for jaggedness — verbatim
// port, pure math.
function subdivide(pts, disp, levels) {
  let cur = pts;
  let d = disp;
  for (let l = 0; l < levels; l++) {
    const next = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      const mid = a.clone().lerp(b, 0.5);
      const len = a.distanceTo(b);
      _v.subVectors(b, a).normalize();
      _perp.set(-_v.z, 0, _v.x);
      _perp.applyAxisAngle(_v, Math.random() * Math.PI * 2);
      mid.addScaledVector(_perp, (Math.random() - 0.5) * d * len);
      next.push(mid, b);
    }
    cur = next;
    d *= 0.55;
  }
  return cur;
}

export function createLightningBolt({ scene }) {
  const params = {
    enabled: true,
    thickness: 0.12,
    glow: 1.6,
    jaggedness: 0.35,
    branches: 0.5,
    branchDepth: 3,
    impactLight: 80,
    duration: 0.22,
  };

  const color = new THREE.Color(0xbcd2ff);

  /* ---- bolt channel (camera-facing additive HDR ribbons) ---------------- */
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX_VERTS * 3);
  const tangents = new Float32Array(MAX_VERTS * 3);
  const sides = new Float32Array(MAX_VERTS);
  const widths = new Float32Array(MAX_VERTS);
  const bright = new Float32Array(MAX_VERTS);
  const indices = new Uint32Array(MAX_IDX);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aTangent', new THREE.BufferAttribute(tangents, 3));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
  geometry.setAttribute('aWidth', new THREE.BufferAttribute(widths, 1));
  geometry.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);

  const uColor = uniform(color.clone());
  const uOpacity = uniform(0);
  const uWidth = uniform(params.thickness);

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;

  const aSide = attribute('aSide', 'float');
  const aWidth = attribute('aWidth', 'float');
  const aTangent = attribute('aTangent', 'vec3');
  const aBright = attribute('aBright', 'float');

  material.positionNode = Fn(() => {
    const wp = positionLocal;
    const viewDir = normalize(cameraPosition.sub(wp));
    const t = normalize(aTangent);
    const side = normalize(cross(t, viewDir));
    return wp.add(side.mul(aSide.mul(uWidth).mul(aWidth)));
  })();

  // core = smoothstep(1.0, 0.15, abs(vSide)) — bright center, fading to the
  // ribbon's edges. `aSide` here is read again in the fragment stage; safe
  // per the file header (a plain, auto-varied attribute, not positionLocal).
  const core = smoothstep(1.0, 0.15, abs(aSide));
  material.colorNode = uColor.mul(aBright).mul(uOpacity).mul(float(0.35).add(core));
  material.opacityNode = float(1); // additive: alpha fixed at 1, brightness IS the fade

  const boltMesh = new THREE.Mesh(geometry, material);
  boltMesh.frustumCulled = false;
  boltMesh.visible = false;

  /* ---- ground/surface impact glow --------------------------------------- */
  const glowUColor = uniform(color.clone());
  const glowUOpacity = uniform(0);
  const glowMaterial = new MeshBasicNodeMaterial();
  glowMaterial.transparent = true;
  glowMaterial.depthWrite = false;
  glowMaterial.blending = THREE.AdditiveBlending;
  glowMaterial.toneMapped = false;

  const d = length(uv().sub(0.5)).mul(2);
  const a = smoothstep(1.0, 0.0, d);
  glowMaterial.colorNode = glowUColor.mul(a).mul(a).mul(glowUOpacity).mul(3);
  glowMaterial.opacityNode = float(1);

  const glow = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), glowMaterial);
  glow.rotation.x = -Math.PI / 2;
  glow.frustumCulled = false;
  glow.visible = false;

  const impactLight = new THREE.PointLight(color.clone(), 0, 60, 2.0);

  const group = new THREE.Group();
  group.name = 'LightningBolt';
  group.userData.noCollision = true;
  group.add(boltMesh, glow, impactLight);
  scene.add(group);

  /* ---- bolt generation (verbatim CPU-side math) -------------------------- */
  let vCount = 0;
  let iCount = 0;

  function addRibbon(pts, brightFactor, widthFactor) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      if (vCount + 2 > MAX_VERTS || iCount + 6 > MAX_IDX) return;
      if (i < n - 1) _tan.subVectors(pts[i + 1], pts[i]).normalize();
      else _tan.subVectors(pts[i], pts[i - 1]).normalize();
      const tipT = n > 1 ? i / (n - 1) : 0;
      const w = widthFactor * (1.0 - 0.8 * tipT);
      const baseV = vCount;
      for (let s = 0; s < 2; s++) {
        positions[vCount * 3] = pts[i].x;
        positions[vCount * 3 + 1] = pts[i].y;
        positions[vCount * 3 + 2] = pts[i].z;
        tangents[vCount * 3] = _tan.x;
        tangents[vCount * 3 + 1] = _tan.y;
        tangents[vCount * 3 + 2] = _tan.z;
        sides[vCount] = s === 0 ? -1 : 1;
        widths[vCount] = w;
        bright[vCount] = brightFactor;
        vCount++;
      }
      if (i < n - 1) {
        indices[iCount++] = baseV;
        indices[iCount++] = baseV + 1;
        indices[iCount++] = baseV + 2;
        indices[iCount++] = baseV + 1;
        indices[iCount++] = baseV + 3;
        indices[iCount++] = baseV + 2;
      }
    }
  }

  // Recursive tree: a jagged segment, then forks that grow from it.
  function grow(start, dir, length_, depth, widthFactor, brightFactor) {
    const end = start.clone().addScaledVector(dir, length_);
    const jag = params.jaggedness * (1 + (params.branchDepth - depth) * 0.3);
    const pts = subdivide([start.clone(), end], jag, depth >= params.branchDepth ? 5 : 3);
    addRibbon(pts, brightFactor, widthFactor);
    if (depth <= 0) return;
    for (let i = 1; i < pts.length - 1; i++) {
      const t = i / (pts.length - 1);
      if (Math.random() > params.branches * (0.3 + 0.7 * t)) continue;
      const p = pts[i];
      _v.subVectors(pts[i + 1], p).normalize();
      _v.x += (Math.random() - 0.5) * 1.5;
      _v.z += (Math.random() - 0.5) * 1.5;
      _v.y -= 0.3 + Math.random() * 0.5; // bias forks downward
      _v.normalize();
      const clen = length_ * (0.35 + Math.random() * 0.35);
      grow(p, _v.clone(), clen, depth - 1, widthFactor * 0.55, brightFactor * 0.7);
    }
  }

  function buildBolt(origin, impact) {
    vCount = 0;
    iCount = 0;
    _v.subVectors(impact, origin).normalize();
    grow(origin.clone(), _v.clone(), origin.distanceTo(impact), params.branchDepth, 1.0, 1.0);
    geometry.setDrawRange(0, iCount);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aTangent.needsUpdate = true;
    geometry.attributes.aSide.needsUpdate = true;
    geometry.attributes.aWidth.needsUpdate = true;
    geometry.attributes.aBright.needsUpdate = true;
    geometry.index.needsUpdate = true;
  }

  /* ---- public API --------------------------------------------------------*/
  let life = 0;

  function strike(origin, impact) {
    if (!params.enabled) return;
    buildBolt(origin, impact);
    glow.position.set(impact.x, impact.y + 0.05, impact.z);
    impactLight.position.set(impact.x, impact.y + 1.0, impact.z);
    life = params.duration;
    boltMesh.visible = true;
    glow.visible = true;
  }

  function update(dt) {
    uWidth.value = params.thickness;
    if (life <= 0) {
      if (boltMesh.visible) {
        boltMesh.visible = false;
        glow.visible = false;
        impactLight.intensity = 0;
      }
      return;
    }
    life -= dt;
    const k = Math.max(life / params.duration, 0);
    const flicker = 0.5 + 0.5 * Math.random();
    const a_ = k * flicker;
    uOpacity.value = a_ * params.glow;
    glowUOpacity.value = a_;
    impactLight.intensity = a_ * params.impactLight;
  }

  function setColor(hex) {
    color.set(hex);
    uColor.value.copy(color);
    glowUColor.value.copy(color);
    impactLight.color.copy(color);
  }

  function dispose() {
    scene.remove(group);
    geometry.dispose();
    material.dispose();
    glow.geometry.dispose();
    glowMaterial.dispose();
  }

  return { group, params, strike, update, setColor, dispose };
}
