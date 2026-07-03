/**
 * createWaterMaterial.js
 *
 * Animated translucent water surface (TSL node material, WebGPU) for rivers.
 * `time` is TSL's built-in clock node — the WebGPU renderer advances it
 * automatically every frame (already used by RendererSystem's fog node), so the
 * ripples animate with zero per-frame wiring.
 *
 * First transparent animated material in the project: transparent + depthWrite =
 * false so the carved channel bed stays visible through the surface (and the water
 * never occludes itself), DoubleSide so it reads from any bank angle.
 *
 * A fresh material is built per river level (not module-cached) so level disposal
 * frees it cleanly — matching the terrain material pattern.
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  time,
  positionWorld,
  normalize,
  sin,
  mix,
  clamp,
  float,
  vec3,
} from 'three/tsl';

export function createWaterMaterial() {
  const x = positionWorld.x;
  const z = positionWorld.z;
  const t = time;

  // Two layered directional ripple terms for gentle, non-uniform surface motion.
  const rippleX = sin(x.mul(1.6).add(t.mul(1.2)))
    .add(sin(z.mul(1.1).sub(t.mul(0.9)).add(x.mul(0.3))));
  const rippleZ = sin(z.mul(1.4).add(t.mul(1.0)))
    .add(sin(x.mul(1.0).sub(z.mul(0.5)).add(t.mul(0.7))));

  // Perturb the (mostly +Y) geometry normal so specular glints shift with the swell.
  const amp = float(0.07);
  const perturbed = normalize(vec3(
    rippleX.mul(amp),
    float(1),
    rippleZ.mul(amp),
  ));

  // Subtle teal↔deep-blue shimmer driven by the ripple peaks.
  const shallow = vec3(0.18, 0.42, 0.50);
  const deep = vec3(0.03, 0.10, 0.20);
  const shimmer = clamp(rippleX.add(rippleZ).mul(0.25).add(0.5), float(0.15), float(0.85));
  const color = mix(deep, shallow, shimmer);

  const material = new MeshStandardNodeMaterial();
  material.colorNode = color;
  material.normalNode = perturbed;
  material.roughnessNode = float(0.08); // glossy → sharp sun specular
  material.metalnessNode = float(0.0);
  material.transparent = true;
  material.opacity = 0.82;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.DoubleSide;
  material.name = 'River Water';
  return material;
}
