import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  cameraPosition,
  color,
  float,
  Fn,
  If,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalView,
  positionView,
  positionWorld,
  smoothstep,
  vec4,
} from 'three/tsl';

function bumpNormal(height) {
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
}

/**
 * Torn sheet-metal cap for vehicle destructible cuts: dark steel with sharp
 * fractured ridges, gouges, and scratch grain that reads at close range.
 */
export function createJaggedMetalCapMaterial() {
  const p = positionWorld;
  const detail = smoothstep(42, 5, p.distance(cameraPosition));

  const near = Fn(() => {
    const plates = float(0).toVar();
    const ridges = float(0).toVar();
    const gouge = float(0).toVar();
    const scratch = float(0).toVar();

    If(detail.greaterThan(0), () => {
      plates.assign(mx_fractal_noise_float(p.mul(4.5), 3).mul(0.5).add(0.5));
      ridges.assign(
        mx_noise_float(p.mul(19))
          .mul(mx_noise_float(p.mul(41).add(13.7)))
          .abs(),
      );
      gouge.assign(smoothstep(0.48, 0.94, mx_fractal_noise_float(p.mul(11), 2).abs()));
      scratch.assign(mx_noise_float(p.mul(76)).mul(0.5).add(0.5));
    });

    return vec4(plates, ridges, gouge, scratch);
  })();

  const plates = near.x;
  const ridges = near.y;
  const gouge = near.z;
  const scratch = near.w;

  const jag = smoothstep(0.32, 0.88, ridges);
  const baseColor = mix(color(0x171b21), color(0x3f4854), plates);
  const tearColor = mix(color(0x5f6d7c), color(0x8f9cab), jag);
  const colorNode = mix(baseColor, tearColor, jag.mul(0.62).mul(detail));

  const metalnessNode = mix(float(0.86), float(0.38), gouge.mul(0.75).mul(detail));
  const roughnessNode = mix(
    float(0.24),
    float(0.78),
    scratch.mul(detail).add(gouge.mul(0.42).mul(detail)),
  );

  const height = ridges
    .mul(0.014)
    .add(gouge.mul(0.009))
    .add(plates.sub(0.5).abs().mul(0.007))
    .mul(detail);
  const normalNode = bumpNormal(height);

  const material = new MeshStandardNodeMaterial();
  material.colorNode = colorNode;
  material.metalnessNode = metalnessNode;
  material.roughnessNode = roughnessNode;
  material.normalNode = normalNode;
  return material;
}
