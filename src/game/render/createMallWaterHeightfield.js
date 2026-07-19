/**
 * Blobby "meatball" ground water — ported from wine's createPuddleHeightfield
 * (early gallery wine versions). Soft heightfield that:
 *   - deposits volume where jets hit / tanks drain
 *   - diffuses amount across neighbors (spreading puddle)
 *   - jiggles height via a springy Laplacian (metaball/meatball feel)
 *
 * Look: pale translucent wet-glass (fresnel + low roughness), not solid blue.
 * WebGPU-safe: MeshPhysicalNodeMaterial + CPU vertex Y / aAmount updates.
 */

import * as THREE from 'three';
import { MUD_DRY_SRGB, MUD_WET_SRGB } from '../materials/rallyMudPalette.js';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';
import {
  attribute,
  color,
  float,
  mix,
  normalView,
  positionViewDirection,
  smoothstep,
} from 'three/tsl';

// Desaturated wet-floor palette (mall concrete showing through).
const WATER_BODY = 0xb8c8cc;
const WATER_SHEEN = 0xf2f8fa;
const WATER_TINT = 0x9eb8bc;

/**
 * @param {object} [opts]
 * @param {number} [opts.centerX]
 * @param {number} [opts.centerZ]
 * @param {number} [opts.width]
 * @param {number} [opts.depth]
 * @param {number} [opts.columns]
 * @param {number} [opts.rows]
 * @param {number} [opts.floorY]
 * @param {THREE.Object3D} [opts.parent]
 * @param {string} [opts.name]
 * @param {'water'|'mud'} [opts.appearance]
 */
export function createMallWaterHeightfield({
  centerX = -82,
  centerZ = 0,
  width = 28,
  depth = 28,
  columns = 64,
  rows = 64,
  floorY = 0,
  parent = null,
  name = 'Mall Aquarium Floor Water',
  appearance = 'water',
} = {}) {
  const isMud = appearance === 'mud';
  const cols = Math.max(8, columns | 0);
  const rowCount = Math.max(8, rows | 0);
  const minX = centerX - width * 0.5;
  const minZ = centerZ - depth * 0.5;
  const stepX = width / (cols - 1);
  const stepZ = depth / (rowCount - 1);
  const count = cols * rowCount;

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const amount = new Float32Array(count);
  const height = new Float32Array(count);
  const velocity = new Float32Array(count);
  const nextAmount = new Float32Array(count);
  const indices = [];

  for (let zIndex = 0; zIndex < rowCount; zIndex += 1) {
    for (let xIndex = 0; xIndex < cols; xIndex += 1) {
      const index = zIndex * cols + xIndex;
      const pi = index * 3;
      positions[pi] = minX + xIndex * stepX;
      positions[pi + 1] = floorY + 0.018;
      positions[pi + 2] = minZ + zIndex * stepZ;
      uvs[index * 2] = xIndex / (cols - 1);
      uvs[index * 2 + 1] = zIndex / (rowCount - 1);
    }
  }

  for (let zIndex = 0; zIndex < rowCount - 1; zIndex += 1) {
    for (let xIndex = 0; xIndex < cols - 1; xIndex += 1) {
      const a = zIndex * cols + xIndex;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  // aAmount drives opacity in lockstep with the same array that lifts vertices —
  // avoids canvas/alphaMap UV flips putting water under the wrong tank.
  const amountAttr = new THREE.BufferAttribute(amount, 1);
  amountAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('aAmount', amountAttr);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Never clip the field when the camera is close to a tank.
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(centerX, floorY, centerZ),
    Math.hypot(width, depth) * 0.6 + 4,
  );

  // Pale translucent wet-glass: fresnel sheen + amount-driven body (not blue paint).
  const aAmount = attribute('aAmount', 'float');
  const edge = smoothstep(float(0.0015), float(0.035), aAmount);
  const fill = smoothstep(float(0.012), float(0.2), aAmount);
  // View-dependent reflection: glancing angles brighten / pick up env.
  const fresnel = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(2.4);

  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    depthWrite: isMud,
    depthTest: true,
    side: THREE.DoubleSide,
    roughness: isMud ? 0.88 : 0.08,
    metalness: isMud ? 0 : 0.02,
    ior: isMud ? 1.46 : 1.33,
    // Mild transmission so the mall floor reads through the pool.
    transmission: isMud ? 0 : 0.35,
    thickness: isMud ? 0.14 : 0.08,
    specularIntensity: isMud ? 0.32 : 1,
  });
  material.toneMapped = true;
  material.opacity = 1;
  if (isMud) {
    // Opaque, low-transmission clay. A small facing sheen keeps the springy
    // height readable without turning the deposit into brown glass.
    const mudBody = mix(color(MUD_WET_SRGB), color(MUD_DRY_SRGB), fill.mul(0.5));
    material.colorNode = mix(mudBody, color(MUD_DRY_SRGB), fresnel.mul(0.12));
    material.opacityNode = edge.mul(0.98).clamp(0, 0.98);
    material.roughnessNode = float(0.9).sub(fill.mul(0.08));
    material.userData.dogParkMudHeightfield = true;
  } else {
    // Mostly clear/grey with a whisper of teal; fresnel pulls toward white sheen.
    const body = mix(color(WATER_BODY), color(WATER_TINT), fill.mul(0.35));
    material.colorNode = mix(body, color(WATER_SHEEN), fresnel.mul(0.85));
    // Thin film: sparse water is almost invisible; deep pools still see-through;
    // rim angles pick up a stronger specular edge.
    const bodyAlpha = float(0.05).add(fill.mul(0.16));
    const rimAlpha = fresnel.mul(0.28);
    material.opacityNode = edge.mul(bodyAlpha.add(rimAlpha)).clamp(0, 0.42);
    material.roughnessNode = float(0.06).add(float(1).sub(fill).mul(0.12));
  }
  material.userData.mallWaterHeightfield = true;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.userData.noStaticMerge = true;
  mesh.userData.skipLevelRaycast = true;
  mesh.userData.mallWaterHeightfield = true;
  mesh.matrixAutoUpdate = true;
  if (parent) parent.add(mesh);

  let active = false;
  let frame = 0;
  let elapsed = 0;
  let totalAmount = 0;
  /** @type {Array<{ x:number,z:number,dirX:number,dirZ:number,age:number,life:number,radius:number,strength:number,phase:number }>} */
  const pulses = [];

  const toIndex = (x, z) => {
    const xIndex = Math.round((x - minX) / stepX);
    const zIndex = Math.round((z - minZ) / stepZ);
    if (xIndex < 1 || xIndex >= cols - 1 || zIndex < 1 || zIndex >= rowCount - 1) return -1;
    return zIndex * cols + xIndex;
  };

  /**
   * Splash / impact deposit (stream hits floor).
   * @param {number} x
   * @param {number} z
   * @param {number} [radius]
   * @param {number} [impactSpeed]
   * @param {number} [velocityX]
   * @param {number} [velocityZ]
   */
  function deposit(x, z, radius = 0.35, impactSpeed = 2, velocityX = 0, velocityZ = 0) {
    const centerIndex = toIndex(x, z);
    if (centerIndex < 0) return false;
    active = true;
    const splashRadius = THREE.MathUtils.clamp(
      radius * (isMud ? 2 : 2.4) + impactSpeed * (isMud ? 0.035 : 0.05),
      0.45,
      isMud ? 1.45 : 1.8,
    );
    const gridRadiusX = Math.ceil(splashRadius / stepX);
    const gridRadiusZ = Math.ceil(splashRadius / stepZ);
    const centerXIndex = centerIndex % cols;
    const centerZIndex = Math.floor(centerIndex / cols);
    const volume = radius * 0.28 + impactSpeed * 0.008;
    const velocityLength = Math.hypot(velocityX, velocityZ) || 1;
    const dirX = velocityX / velocityLength;
    const dirZ = velocityZ / velocityLength;

    pulses.push({
      x,
      z,
      dirX,
      dirZ,
      age: 0,
      life: isMud ? 0.95 : 0.7,
      radius: splashRadius * 1.1,
      strength: THREE.MathUtils.clamp(radius * 0.45 + impactSpeed * 0.008, 0.012, 0.08),
      phase: Math.random() * Math.PI * 2,
    });
    if (pulses.length > 24) pulses.splice(0, pulses.length - 24);

    for (let dz = -gridRadiusZ; dz <= gridRadiusZ; dz += 1) {
      for (let dx = -gridRadiusX; dx <= gridRadiusX; dx += 1) {
        const xIndex = centerXIndex + dx;
        const zIndex = centerZIndex + dz;
        if (xIndex < 1 || xIndex >= cols - 1 || zIndex < 1 || zIndex >= rowCount - 1) continue;
        const worldDx = dx * stepX;
        const worldDz = dz * stepZ;
        const distance = Math.hypot(worldDx, worldDz);
        if (distance > splashRadius) continue;

        const index = zIndex * cols + xIndex;
        const falloff = Math.cos((distance / splashRadius) * Math.PI * 0.5) ** 2;
        const directionalKick = (worldDx * velocityX + worldDz * velocityZ) * 0.012;
        amount[index] = Math.min(0.55, amount[index] + volume * falloff);
        height[index] = Math.max(
          height[index],
          amount[index] * 0.1 + falloff * radius * 0.55,
        );
        velocity[index] += (impactSpeed * 0.028 + directionalKick) * falloff;
      }
    }
    return true;
  }

  /**
   * Gentler continuous fill (tank drain / sustained jet drip).
   * Spreads as a soft blob that merges with neighbors — the meatball look.
   */
  function seep(x, z, volume, radius = 1.2) {
    const centerIndex = toIndex(x, z);
    if (centerIndex < 0 || volume <= 0) return false;
    active = true;
    const r = Math.max(0.4, radius);
    const gridRadiusX = Math.ceil(r / stepX);
    const gridRadiusZ = Math.ceil(r / stepZ);
    const centerXIndex = centerIndex % cols;
    const centerZIndex = Math.floor(centerIndex / cols);

    for (let dz = -gridRadiusZ; dz <= gridRadiusZ; dz += 1) {
      for (let dx = -gridRadiusX; dx <= gridRadiusX; dx += 1) {
        const xIndex = centerXIndex + dx;
        const zIndex = centerZIndex + dz;
        if (xIndex < 1 || xIndex >= cols - 1 || zIndex < 1 || zIndex >= rowCount - 1) continue;
        const worldDx = dx * stepX;
        const worldDz = dz * stepZ;
        const distance = Math.hypot(worldDx, worldDz);
        if (distance > r) continue;
        const falloff = Math.cos((distance / r) * Math.PI * 0.5) ** 2;
        const index = zIndex * cols + xIndex;
        amount[index] = Math.min(0.62, amount[index] + volume * falloff);
        // Nudge height toward a soft blob resting height.
        const targetH = amount[index] * 0.12;
        height[index] = Math.max(height[index], targetH * 0.85);
      }
    }
    return true;
  }

  function update(delta = 0) {
    if (!active && pulses.length === 0) return;
    const dt = Math.min(Math.max(0, delta), 0.03);
    elapsed += dt;
    let sum = 0;
    const livePulses = pulses.filter((p) => p.age < p.life);

    // Quiet mud: alternate frames when there is almost no water and no splash
    // pulses — full grid spring/diffuse was a dog-park CPU hotspot.
    frame += 1;
    if (isMud && livePulses.length === 0 && totalAmount < 0.04 && (frame & 1) === 0) {
      return;
    }

    // Diffuse amount (puddles merge / spread like viscous fluid).
    nextAmount.set(amount);
    for (let zIndex = 1; zIndex < rowCount - 1; zIndex += 1) {
      for (let xIndex = 1; xIndex < cols - 1; xIndex += 1) {
        const index = zIndex * cols + xIndex;
        const neighborAverage = (
          amount[index - 1]
          + amount[index + 1]
          + amount[index - cols]
          + amount[index + cols]
        ) * 0.25;
        if (amount[index] <= 1e-4 && neighborAverage <= 1e-4) continue;
        nextAmount[index] += (neighborAverage - amount[index]) * dt * (isMud ? 0.55 : 1.65);
        // Very slow evaporation so drained water persists in the mall.
        nextAmount[index] *= isMud ? 0.99997 : 0.99985;
      }
    }
    amount.set(nextAmount);

    // Springy heightfield (meatball jiggle) + splash rings.
    for (let zIndex = 1; zIndex < rowCount - 1; zIndex += 1) {
      for (let xIndex = 1; xIndex < cols - 1; xIndex += 1) {
        const index = zIndex * cols + xIndex;
        const laplacian = height[index - 1]
          + height[index + 1]
          + height[index - cols]
          + height[index + cols]
          - height[index] * 4;
        const target = amount[index] * (isMud ? 0.11 : 0.14);
        velocity[index] += (
          laplacian * (isMud ? 6 : 11)
          - (height[index] - target) * (isMud ? 13 : 16)
        ) * dt;
        velocity[index] *= 1 - Math.min(dt * (isMud ? 4.5 : 2.2), 0.18);
        height[index] = Math.max(0, height[index] + velocity[index] * dt);

        const ripple = Math.sin(elapsed * 6.2 + xIndex * 0.29 + zIndex * 0.21)
          * amount[index]
          * (isMud ? 0.002 : 0.005);
        let splashLift = 0;
        const worldX = minX + xIndex * stepX;
        const worldZ = minZ + zIndex * stepZ;
        for (const pulse of livePulses) {
          const dx = worldX - pulse.x;
          const dz = worldZ - pulse.z;
          const distance = Math.hypot(dx, dz);
          if (distance > pulse.radius) continue;
          const normalized = distance / pulse.radius;
          const fade = 1 - pulse.age / pulse.life;
          const direction = distance > 1e-4
            ? (dx * pulse.dirX + dz * pulse.dirZ) / distance
            : 0;
          const wakeBias = THREE.MathUtils.clamp(1 + direction * 0.4, 0.55, 1.4);
          const ring = Math.sin((1 - normalized) * Math.PI * 2.2 - pulse.age * 16 + pulse.phase);
          const envelope = Math.sin((1 - normalized) * Math.PI) ** 2;
          splashLift += ring * envelope * fade * pulse.strength * wakeBias;
        }

        // Lift above floor; scale height so meatballs read clearly.
        positions[index * 3 + 1] = floorY + 0.02
          + height[index] * (isMud ? 0.82 : 1.35)
          + ripple
          + splashLift * (isMud ? 0.72 : 1);
        sum += amount[index];
      }
    }

    for (let i = pulses.length - 1; i >= 0; i -= 1) {
      pulses[i].age += dt;
      if (pulses[i].age >= pulses[i].life) pulses.splice(i, 1);
    }

    geometry.attributes.position.needsUpdate = true;
    amountAttr.needsUpdate = true;
    if (frame % 8 === 0) geometry.computeVertexNormals();

    totalAmount = sum;
    mesh.visible = sum > 0.008;
    active = sum > 0.001 || pulses.length > 0;
  }

  function reset() {
    active = false;
    amount.fill(0);
    height.fill(0);
    velocity.fill(0);
    nextAmount.fill(0);
    pulses.length = 0;
    totalAmount = 0;
    for (let index = 0; index < count; index += 1) {
      positions[index * 3 + 1] = floorY + 0.018;
    }
    geometry.attributes.position.needsUpdate = true;
    amountAttr.needsUpdate = true;
    mesh.visible = false;
  }

  function snapshot() {
    return {
      active,
      totalAmount: Number(totalAmount.toFixed(3)),
      pulses: pulses.length,
      columns: cols,
      rows: rowCount,
      width,
      depth,
      centerX,
      centerZ,
      appearance,
    };
  }

  function dispose() {
    mesh.parent?.remove(mesh);
    geometry.dispose();
    material.dispose();
    pulses.length = 0;
  }

  // Start invisible until first deposit.
  mesh.visible = false;

  return {
    mesh,
    deposit,
    seep,
    update,
    reset,
    snapshot,
    dispose,
    get active() { return active; },
    get totalAmount() { return totalAmount; },
  };
}
