/**
 * createRainEffect.js
 *
 * GPU-driven falling-rain streaks (TSL node material, WebGPU). Ported from
 * github.com/achrefelouafi/RainSystemThreeJS's src/rain.js (a classic
 * THREE.ShaderMaterial + InstancedBufferGeometry streak system) — reimplemented
 * from scratch in TSL since this project renders through THREE.WebGPURenderer,
 * not the regular GLSL pipeline that repo targets. The parameters below
 * (volume, speed, length, width, opacity, wind, color, and the fragment fade
 * shape) are matched directly to that reference's numbers/formulas, not
 * guessed — an earlier pass invented its own tuning and read nothing like the
 * reference (streaks 7.5x too fat, wrong fade shape, volume centered on the
 * camera instead of biased below eye level).
 *
 * Recycling: each drop's world position is `seed*volume + velocity*time`,
 * wrapped into a box of size `volume` whose origin follows the camera but is
 * biased mostly BELOW eye level (`origin = cameraPos - vec3(vol.x/2, vol.y*0.85,
 * vol.z/2)`), same as the reference — this puts most of the fall distance
 * below the player (where it needs room to fall before recycling) while only
 * a little of the box pokes up above eye level (where new drops need to be
 * visible entering view). The double mod (`mod(mod(u, volume) + volume,
 * volume)`) guards against `mod()` ever seeing a negative dividend, which
 * differs between GLSL (always positive) and WGSL/HLSL (sign follows the
 * dividend) — the reference only needs a single mod() since it's pure GLSL;
 * wrapping this way gives the same result under either convention.
 *
 * Billboarding: the quad's width axis is `cross(velocity, towardCamera)` and
 * its length axis is the velocity itself, so every streak always points the
 * way it's falling and reads edge-on from any angle — same as the reference.
 *
 * WebGPU/TSL-specific fixes not present in the (WebGL/GLSL) reference:
 * - Per-instance seed/rand data use StorageInstancedBufferAttribute + storage()
 *   instead of a plain InstancedBufferAttribute + attribute() node, because
 *   attribute() reads route through a WebGPU UNIFORM buffer (64KB hard limit,
 *   instantly exceeded at a few thousand drops).
 * - instanceIndex is only valid in the vertex stage, so per-instance values
 *   needed in the fragment stage (rand, and the raw local UV) are carried
 *   across via NAMED varyings (varyingProperty), not plain varying() — a
 *   plain varying() closure-captured across the separately-built
 *   positionNode/opacityNode trees throws "Cannot read properties of null
 *   (reading 'build')"; varyingProperty is keyed by name so each build
 *   resolves it independently (mirrors CurveModifierGPU.js's curveNormal
 *   pattern).
 * - The raw local UV specifically MUST be captured into its own varying
 *   before use, not read via `positionLocal` after `material.positionNode` is
 *   set — NodeMaterial reassigns the shared `positionLocal` property node to
 *   positionNode's result, so a later read of `positionLocal` (e.g. in the
 *   fade calc) sees the absolute world-space override, not the quad's
 *   original -0.5..0.5 UV (this silently zeroed opacity everywhere).
 * - mesh.count is fixed at maxDrops from the very first frame, never ramped.
 *   THREE's automatic per-instance matrix node (nodes/accessors/Instance.js)
 *   picks uniform-buffer vs. unbounded-interleaved-attribute storage for the
 *   instance matrix based on `count * 16 * 4` bytes AT SHADER-COMPILE TIME,
 *   which happens on the first frame `mesh.count > 0` — ramping count up
 *   gradually made that first compile choose the small-count uniform-buffer
 *   path, which then broke once the real count grew past the 64KB limit.
 * - Every instance matrix is explicitly set to identity. InstancedMesh's
 *   instanceMatrix starts as a zeroed Float32Array, not identity — left
 *   alone, THREE's automatic `instanceMatrix * positionNode` transform
 *   collapsed every vertex to the origin regardless of what positionNode
 *   computed.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial, StorageInstancedBufferAttribute } from 'three/webgpu';
import {
  Fn,
  storage,
  instanceIndex,
  varyingProperty,
  uniform,
  cameraPosition,
  time,
  mod,
  cross,
  normalize,
  mix,
  smoothstep,
  positionLocal,
  vec3,
  float,
} from 'three/tsl';
import { lightningFlash } from '../systems/weatherUniforms.js';

const DEFAULT_MAX_DROPS = 12000;
// Matches the reference's uVolume (50, 40, 50).
const DEFAULT_VOLUME = new THREE.Vector3(50, 40, 50);
const DEFAULT_FALL_SPEED = 22; // uSpeed
const DEFAULT_LENGTH = 1.4; // uLength
// The reference's exact 0.012 is a true hairline that only reads against
// its dark rainy-night scene; in this game's bright desert test scene it was
// confirmed invisible even at max opacity (placement was still correct —
// verified with a full-opacity/oversized diagnostic pass). Widened enough to
// actually read as a streak against a bright backdrop while keeping the same
// hairline character.
const DEFAULT_STREAK_WIDTH = 0.03;
const DEFAULT_WIND = { x: 3, z: 1 }; // uWind default from the reference's main.js

export function createRainEffect({ maxDrops = DEFAULT_MAX_DROPS, wind = DEFAULT_WIND } = {}) {
  const geometry = new THREE.PlaneGeometry(1, 1);

  // Per-instance random seed/variation (aSeed/aRand in the reference), read
  // via instanceIndex. See file header for why this is a storage buffer
  // instead of a plain instanced attribute.
  const seedAttr = new StorageInstancedBufferAttribute(maxDrops, 3);
  const randAttr = new StorageInstancedBufferAttribute(maxDrops, 1);
  for (let i = 0; i < maxDrops; i += 1) {
    seedAttr.setXYZ(i, Math.random(), Math.random(), Math.random());
    randAttr.setX(i, Math.random());
  }
  const seedBuffer = storage(seedAttr, 'vec3', maxDrops);
  const randBuffer = storage(randAttr, 'float', maxDrops);

  const volume = uniform(DEFAULT_VOLUME.clone());
  const fallSpeed = uniform(DEFAULT_FALL_SPEED);
  const lengthBase = uniform(DEFAULT_LENGTH);
  const windVec = uniform(new THREE.Vector3(wind.x ?? 0, 0, wind.z ?? 0));
  const streakWidth = uniform(DEFAULT_STREAK_WIDTH);
  // Ramped in update() so toggling weather fades in/out instead of popping.
  const intensity = uniform(0);

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.toneMapped = false;

  // Named varyings carrying per-instance data from the vertex stage (where
  // instanceIndex/positionLocal are valid) to the fragment stage. See file
  // header for why these can't be plain varying()/positionLocal reads.
  const randVaryingProp = varyingProperty('float', 'vRainRand');
  const localUVVaryingProp = varyingProperty('vec2', 'vRainLocalUV');

  material.positionNode = Fn(() => {
    const seed = seedBuffer.element(instanceIndex);
    const rand = randBuffer.element(instanceIndex);
    randVaryingProp.assign(rand);
    localUVVaryingProp.assign(positionLocal.xy);

    // origin = cameraPos - vec3(vol.x*0.5, vol.y*0.85, vol.z*0.5) — biases the
    // box mostly below eye level (see file header), same as the reference.
    const origin = cameraPosition.sub(vec3(volume.x.mul(0.5), volume.y.mul(0.85), volume.z.mul(0.5)));

    const speed = fallSpeed.mul(mix(float(0.75), float(1.25), rand));
    const base = seed.mul(volume);
    const velocity = vec3(windVec.x, speed.negate(), windVec.z);
    const disp = velocity.mul(time);

    // Double-mod wrap (see file header) so drops recycle inside the box
    // regardless of the backend's mod() sign convention.
    const shifted = base.add(disp).sub(origin);
    const wrapped = mod(mod(shifted, volume).add(volume), volume);
    const worldPos = wrapped.add(origin);

    const toCamera = normalize(cameraPosition.sub(worldPos));
    const fallDir = normalize(velocity);
    const widthAxis = normalize(cross(fallDir, toCamera));

    const len = lengthBase.mul(mix(float(0.7), float(1.3), rand));
    const localOffset = widthAxis.mul(positionLocal.x.mul(streakWidth))
      .add(fallDir.mul(positionLocal.y.mul(len)));

    return worldPos.add(localOffset);
  })();

  // Soft taper matching the reference's fragment shader exactly: UV remapped
  // from the quad's -0.5..0.5 local space to 0..1, then a two-sided smoothstep
  // "lens" shape across the width and an asymmetric one along the length
  // (fades in fast from the tail, out slowly toward the head) — this is what
  // makes it read as a soft streak/comet rather than a blocky bar.
  const u = localUVVaryingProp.x.add(0.5);
  const v = localUVVaryingProp.y.add(0.5);
  const across = smoothstep(0.0, 0.5, u).mul(smoothstep(1.0, 0.5, u));
  const along = smoothstep(0.0, 0.3, v).mul(smoothstep(1.0, 0.55, v));
  // Brightened during a lightning flash — matches the reference's rain.js
  // exactly: `vec3 col = uColor * (1.0 + uLightning * 2.5);`.
  material.colorNode = vec3(0.706, 0.722, 0.749).mul(float(1).add(lightningFlash.mul(2.5))); // 0xb4b8bf, the reference's uColor
  material.opacityNode = across.mul(along).mul(mix(float(0.3), float(0.5), randVaryingProp)).mul(intensity);

  const mesh = new THREE.InstancedMesh(geometry, material, maxDrops);
  mesh.name = 'Rain';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // The instanced geometry's own bounding volume doesn't reflect where drops
  // actually render (they're relocated entirely in the shader, camera-relative,
  // effectively "everywhere the camera goes") — never cull the whole mesh.
  mesh.frustumCulled = false;
  // Always the full instance count from the very first frame — see file
  // header for why ramping this up over time broke the instance-matrix
  // buffer selection.
  mesh.count = maxDrops;

  // Every instance set to identity — see file header for why THREE's default
  // zeroed instanceMatrix would otherwise collapse all drops to the origin.
  const identity = new THREE.Matrix4();
  for (let i = 0; i < maxDrops; i += 1) mesh.setMatrixAt(i, identity);
  mesh.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'RainEffect';
  group.userData.noCollision = true;
  group.add(mesh);

  let targetFraction = 0;
  let currentFraction = 0;

  const setIntensity = (fraction) => {
    targetFraction = THREE.MathUtils.clamp(fraction, 0, 1);
  };

  const update = (delta) => {
    // Ease current toward target over ~0.6s so weather changes fade rather
    // than pop (matches TireScreechAudio's setTargetAtTime-style ramping).
    const rate = Math.min(1, Math.max(0, delta) / 0.6);
    currentFraction += (targetFraction - currentFraction) * rate;
    if (Math.abs(currentFraction - targetFraction) < 0.002) currentFraction = targetFraction;
    // mesh.count stays fixed at maxDrops (see above); the fade is entirely
    // this uniform driving opacityNode's `.mul(intensity)`.
    intensity.value = currentFraction;
    mesh.visible = currentFraction > 0;
  };

  const dispose = () => {
    geometry.dispose();
    material.dispose();
    group.remove(mesh);
  };

  return { group, setIntensity, update, dispose };
}
