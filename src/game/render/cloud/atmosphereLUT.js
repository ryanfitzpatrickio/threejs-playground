// AtmosphereLUTNode — precomputes the atmospheric scattering tables the sky
// shader (and, later, the cloud ambient/aerial terms) sample per pixel.
//
// Bakes the transmittance LUT (256×64, Bruneton-style: for each
// (view-zenith cosine, altitude) march 40 samples through the atmosphere and
// accumulate Rayleigh + Mie optical depth, zeroing directions that intersect the
// planet), followed by a compact 32×32 hemisphere-integrated multiple-scatter
// approximation used by both the visible sky and the PMREM environment source.
//
// Follows the vendored SSAONode pattern: a TempNode that owns its RenderTarget +
// NodeMaterial, renders in `updateBefore` through a shared QuadMesh with
// `RendererUtils.resetRendererState`/`restoreRendererState`, and exposes its
// result via `passTexture`. The bake is dirty-gated (once on init, re-baked only
// when `markDirty()` is called — e.g. on atmosphere-param change in M6).

import {
  RenderTarget,
  QuadMesh,
  NodeMaterial,
  RendererUtils,
  HalfFloatType,
  RGBAFormat,
  TempNode,
} from 'three/webgpu';
import {
  NodeUpdateType,
  Fn,
  uv,
  float,
  vec2,
  vec3,
  vec4,
  Loop,
  exp,
  sqrt,
  max,
  select,
  passTexture,
  texture,
} from 'three/tsl';
import { ATMOSPHERE, LUT_SIZES } from './cloudConfig.js';
import { uAtmosphereRayleigh, uAtmosphereTurbidity, uAtmosphereMultiScatter } from './cloudUniforms.js';

const _quadMesh = /*@__PURE__*/ new QuadMesh();
let _rendererState;

class AtmosphereLUTNode extends TempNode {
  constructor() {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this._dirty = true;

    const [tw, th] = LUT_SIZES.transmittance;
    this._transmittanceRT = new RenderTarget(tw, th, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat,
    });
    this._transmittanceRT.texture.name = 'cloud.transmittanceLUT';
    const [mw, mh] = LUT_SIZES.multiscatter;
    this._multiScatterRT = new RenderTarget(mw, mh, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat,
    });
    this._multiScatterRT.texture.name = 'cloud.multiScatterLUT';

    this._material = new NodeMaterial();
    this._material.name = 'cloud.atmosphereLUT';
    this._material.fragmentNode = buildTransmittanceFn()();
    this._textureNode = passTexture(this, this._transmittanceRT.texture);
    this._multiScatterMaterial = new NodeMaterial();
    this._multiScatterMaterial.name = 'cloud.multiScatterLUT';
    this._multiScatterMaterial.fragmentNode = buildMultiScatterFn(texture(this._transmittanceRT.texture))();
    this._multiScatterNode = passTexture(this, this._multiScatterRT.texture);
  }

  get transmittanceTexture() {
    return this._transmittanceRT.texture;
  }

  getTextureNode() {
    return this._textureNode;
  }

  get multiScatterTexture() {
    return this._multiScatterRT.texture;
  }

  getMultiScatterNode() {
    return this._multiScatterNode;
  }

  markDirty() {
    this._dirty = true;
  }

  updateBefore(frame) {
    if (!this._dirty) return;
    this.bake(frame.renderer);
  }

  // Eagerly bake the LUT(s) outside the per-frame node loop — used by the
  // provider before PMREM captures the environment, so the env sky samples a
  // populated table instead of a cleared target on first load. Idempotent.
  bake(renderer) {
    if (!this._dirty || !renderer) return;
    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState);
    _quadMesh.material = this._material;
    _quadMesh.name = 'cloud.atmosphereLUT';
    renderer.setRenderTarget(this._transmittanceRT);
    _quadMesh.render(renderer);
    _quadMesh.material = this._multiScatterMaterial;
    _quadMesh.name = 'cloud.multiScatterLUT';
    renderer.setRenderTarget(this._multiScatterRT);
    _quadMesh.render(renderer);
    RendererUtils.restoreRendererState(renderer, _rendererState);
    this._dirty = false;
  }

  dispose() {
    this._transmittanceRT.dispose();
    this._multiScatterRT.dispose();
    this._material.dispose();
    this._multiScatterMaterial.dispose();
  }
}

function buildMultiScatterFn(transmittanceNode) {
  const DIRECTIONS = 8;
  return Fn(() => {
    const p = uv();
    const sunMu = p.x.mul(2).sub(1);
    const altitude = p.y;
    const lostLight = vec3(0).toVar();
    Loop(DIRECTIONS, ({ i }) => {
      const mu = float(i).add(0.5).div(DIRECTIONS).mul(2).sub(1);
      const transmittance = transmittanceNode.sample(vec2(mu.mul(0.5).add(0.5), altitude)).rgb;
      const angularWeight = max(float(0.15), float(1).add(mu.mul(sunMu)).mul(0.5));
      lostLight.addAssign(vec3(1).sub(transmittance).mul(angularWeight));
    });
    const average = lostLight.div(DIRECTIONS);
    const groundBounce = vec3(0.18, 0.17, 0.15).mul(float(1).sub(altitude)).mul(max(sunMu, 0));
    const psi = average.add(groundBounce);
    return vec4(psi.div(vec3(1).sub(psi.mul(uAtmosphereMultiScatter)).add(0.001)), 1);
  });
}

// Transmittance baker. UV mapping: x → view-zenith cosine in [-1,1], y →
// observer altitude in [0, atmosphere thickness] km. Returns the RGB
// transmittance to the atmosphere boundary along that direction, or black if
// the ray intersects the planet (ground shadow).
function buildTransmittanceFn() {
  const A = ATMOSPHERE;
  const SAMPLES = A.TRANSMITTANCE_SAMPLES;
  return Fn(() => {
    const EARTH_R = float(A.EARTH_R_KM);
    const ATMO_R = float(A.ATMO_R_KM);
    const Hr = float(A.RAYLEIGH_SCALE_HEIGHT_KM);
    const Hm = float(A.MIE_SCALE_HEIGHT_KM);
    const THICK = float(A.THICKNESS_KM);
    const MIE_EXT = float(A.MIE_EXTINCTION_FACTOR);

    const betaR = vec3(
      A.RAYLEIGH_BETA_RGB_KM[0],
      A.RAYLEIGH_BETA_RGB_KM[1],
      A.RAYLEIGH_BETA_RGB_KM[2],
    ).mul(uAtmosphereRayleigh);
    const mieBase = float(A.MIE_BETA_BASE_KM).mul(uAtmosphereTurbidity);
    const betaM = vec3(mieBase, mieBase, mieBase);

    const p = uv();
    const cosV = p.x.mul(2).sub(1);
    const alt0 = p.y.mul(THICK);
    const radius = EARTH_R.add(alt0);
    const horiz = sqrt(max(float(1).sub(cosV.mul(cosV)), 0));

    // Ray/ground-sphere intersection (origin above the surface):
    const bg = float(2).mul(radius).mul(cosV);
    const cg = radius.mul(radius).sub(EARTH_R.mul(EARTH_R));
    const discg = bg.mul(bg).sub(float(4).mul(cg));
    const tg = bg.negate().sub(sqrt(max(discg, 0))).div(2);
    const hitGround = discg.greaterThan(0).and(tg.greaterThan(0));

    // Ray/atmosphere-sphere intersection → march length:
    const b = bg; // same form: 2·radius·cosV
    const c = radius.mul(radius).sub(ATMO_R.mul(ATMO_R));
    const disc = max(b.mul(b).sub(float(4).mul(c)), 0);
    const tFar = max(b.negate().add(sqrt(disc)).div(2), 0);
    const step = tFar.div(SAMPLES);

    const tauR = float(0).toVar();
    const tauM = float(0).toVar();
    Loop(SAMPLES, ({ i }) => {
      const d = float(i).add(0.5).mul(step);
      // origin is (0, radius, 0); dir is (horiz, cosV, 0) — a unit vector.
      const sx = horiz.mul(d);
      const sy = radius.add(cosV.mul(d));
      const altitude = max(sqrt(sx.mul(sx).add(sy.mul(sy))).sub(EARTH_R), 0);
      tauR.addAssign(exp(altitude.negate().div(Hr)).mul(step));
      tauM.addAssign(exp(altitude.negate().div(Hm)).mul(step));
    });

    const tau = betaR.mul(tauR).add(betaM.mul(MIE_EXT).mul(tauM));
    const T = exp(tau.negate());
    return vec4(select(hitGround, vec3(0, 0, 0), T), 1);
  });
}

export { AtmosphereLUTNode };
export default AtmosphereLUTNode;
