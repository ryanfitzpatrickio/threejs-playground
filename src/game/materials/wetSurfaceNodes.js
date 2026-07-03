/**
 * wetSurfaceNodes.js
 *
 * Direct TSL port of the wet-surface shader techniques from
 * github.com/achrefelouafi/RainSystemThreeJS — specifically the GLSL in that
 * repo's `src/main.js` (PUDDLE_HEADER, applied to the ground plane) and
 * `src/model.js` (WET_HEADER, applied to the dropped car model). Every
 * function here is a line-for-line translation of that repo's GLSL, not a
 * reinvention — reused by createTerrainBiomeMaterial.js, CityGenerator.js's
 * road material, and createVehicleOverlayMaterials.js so all three surfaces
 * share exactly the one wet-surface technique the reference uses.
 *
 * Ported pieces:
 * - `hash21`, `snoise` (Ashima 2D simplex), `fbm` — noise primitives.
 * - `puddleMaskAt` — fbm-thresholded puddle coverage mask.
 * - `rippleField`, `puddleRippleNormal` — hash-seeded per-cell rings that
 *   spawn/expand/fade on a loop, giving the animated "rain hitting standing
 *   water" ripple normal perturbation (used identically for ground puddles
 *   AND flat-top puddles on the car in the reference).
 * - `dropField`, `dropletMask` — Voronoi-style rounded water beads, triplanar
 *   blended by world-normal so droplets sit correctly on any surface
 *   orientation (the reference's car-paint beading).
 *
 * Not ported: the reference's GPU "deflection droplet" particle system
 * (droplets bouncing off a model's flat top, found via a CPU raycast scan of
 * the mesh) — that's a distinct, separate particle subsystem on top of the
 * wet-surface shader, not part of the shader technique itself.
 */

import {
  Fn,
  Loop,
  int,
  float,
  vec2,
  vec3,
  mod,
  floor,
  fract,
  abs,
  dot,
  max,
  sin,
  exp,
  length,
  normalize,
  select,
  smoothstep,
  time,
} from 'three/tsl';

// --- hash / hashing helpers -------------------------------------------------

// float hash21(vec2 p) { p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
export const hash21 = Fn(([p]) => {
  const pp = fract(p.mul(vec2(123.34, 345.45))).toVar();
  pp.assign(pp.add(dot(pp, pp.add(34.345))));
  return fract(pp.x.mul(pp.y));
});

// --- Ashima 2D simplex noise -------------------------------------------------

const permute3 = Fn(([x]) => mod(x.mul(34.0).add(1.0).mul(x), 289.0));

// float snoise(vec2 v) — verbatim port of the reference's Ashima simplex noise.
export const snoise = Fn(([v]) => {
  const C = vec2(0.211324865405187, 0.366025403784439); // C.xy used directly; C.zw below
  const Cz = float(-0.577350269189626);
  const Cw = float(0.024390243902439);

  const i = floor(v.add(dot(v, vec2(C.y, C.y)))).toVar();
  const x0 = v.sub(i).add(dot(i, vec2(C.x, C.x))).toVar();

  const i1 = select(x0.x.greaterThan(x0.y), vec2(1.0, 0.0), vec2(0.0, 1.0));

  // x12 = x0.xyxy + C.xxzz; then x12.xy -= i1 — built directly as two vec2 halves.
  const x12xy = vec2(x0.x.add(C.x), x0.y.add(C.x)).sub(i1).toVar();
  const x12zw = vec2(x0.x.add(Cz), x0.y.add(Cz)).toVar();

  i.assign(mod(i, 289.0));

  const p = permute3(
    permute3(vec3(i.y.add(0.0), i.y.add(i1.y), i.y.add(1.0)))
      .add(vec3(i.x.add(0.0), i.x.add(i1.x), i.x.add(1.0))),
  ).toVar();

  const m = max(
    float(0.5).sub(vec3(
      dot(x0, x0),
      dot(x12xy, x12xy),
      dot(x12zw, x12zw),
    )),
    0.0,
  ).toVar();
  m.assign(m.mul(m));
  m.assign(m.mul(m));

  const x = fract(p.mul(Cw)).mul(2.0).sub(1.0).toVar();
  const h = abs(x).sub(0.5).toVar();
  const ox = floor(x.add(0.5)).toVar();
  const a0 = x.sub(ox).toVar();
  m.assign(m.mul(float(1.79284291400159).sub(float(0.85373472095314).mul(a0.mul(a0).add(h.mul(h))))));

  const gx = a0.x.mul(x0.x).add(h.x.mul(x0.y));
  const gy = a0.y.mul(x12xy.x).add(h.y.mul(x12xy.y));
  const gz = a0.z.mul(x12zw.x).add(h.z.mul(x12zw.y));
  const g = vec3(gx, gy, gz);

  return dot(m, g).mul(130.0);
});

// float fbm(vec2 p) { ... 5 octaves ... }
export const fbm = Fn(([pIn]) => {
  const p = vec2(pIn).toVar();
  const value = float(0.0).toVar();
  const amp = float(0.5).toVar();
  Loop({ start: int(0), end: int(5), type: 'int', condition: '<' }, () => {
    value.addAssign(amp.mul(snoise(p)));
    p.assign(p.mul(2.0));
    amp.assign(amp.mul(0.5));
  });
  return value;
});

// float puddleMaskAt(vec2 worldXZ) — fbm-thresholded coverage mask.
export const puddleMaskAt = Fn(([worldXZ, scale, seed, coverage, edge]) => {
  const p = worldXZ.mul(scale).add(seed);
  const n = fbm(p).mul(0.5).add(0.5);
  const threshold = float(1.0).sub(coverage);
  return smoothstep(threshold.sub(edge), threshold.add(edge), n);
});

// --- rain-ripple rings (ground puddles AND flat-top puddles on the car) ----

// float rippleField(vec2 uv) — hash-seeded per-cell rings, spawn/expand/fade on a loop.
export const rippleField = Fn(([uv, rippleSpeed, rippleDensity]) => {
  const g = floor(uv).toVar();
  const f = fract(uv).toVar();
  const h = float(0.0).toVar();

  Loop({ start: int(-1), end: int(1), type: 'int', condition: '<=' }, ({ i: yi }) => {
    Loop({ start: int(-1), end: int(1), type: 'int', condition: '<=' }, ({ i: xi }) => {
      const o = vec2(float(xi), float(yi));
      const id = g.add(o);
      const r = hash21(id);
      const life = time.mul(rippleSpeed).add(r);
      const cycle = floor(life);
      const t = fract(life);
      const roll = hash21(id.add(cycle.mul(1.7)).add(0.31));
      const spawn = roll.greaterThanEqual(float(1.0).sub(rippleDensity));
      const c = o.add(vec2(
        hash21(id.add(cycle.mul(2.3)).add(0.11)),
        hash21(id.add(cycle.mul(3.7)).add(0.83)),
      ));
      const d = length(f.sub(c));
      const radius = t.mul(0.7);
      const band = exp(d.sub(radius).mul(10.0).pow(2).negate());
      const env = sin(t.mul(3.14159));
      h.addAssign(
        sin(d.sub(radius).mul(50.0)).mul(band).mul(env).mul(select(spawn, float(1.0), float(0.0))),
      );
    });
  });

  return h;
});

// vec3 puddleRippleNormal(vec2 worldXZ) — gradient of rippleField, as a perturbed normal.
export const puddleRippleNormal = Fn(([worldXZ, wind, rippleScale, rainRipple, rippleSpeed, rippleDensity]) => {
  const drift = wind.xz.mul(time).mul(0.05);
  const uv = worldXZ.mul(rippleScale).add(drift);
  const e = float(0.05);
  const h0 = rippleField(uv, rippleSpeed, rippleDensity);
  const hx = rippleField(uv.add(vec2(e, 0.0)), rippleSpeed, rippleDensity);
  const hz = rippleField(uv.add(vec2(0.0, e)), rippleSpeed, rippleDensity);
  const grad = vec2(hx.sub(h0), hz.sub(h0)).div(e);
  return normalize(vec3(grad.x.negate().mul(rainRipple), 1.0, grad.y.negate().mul(rainRipple)));
});

// --- triplanar droplet beading (car paint) ---------------------------------

// float dropField(vec2 uv) — Voronoi-style rounded water beads.
export const dropField = Fn(([uvIn, dropletScale]) => {
  const uv = uvIn.mul(dropletScale).toVar();
  const g = floor(uv).toVar();
  const f = fract(uv).toVar();
  const v = float(0.0).toVar();

  Loop({ start: int(-1), end: int(1), type: 'int', condition: '<=' }, ({ i: yi }) => {
    Loop({ start: int(-1), end: int(1), type: 'int', condition: '<=' }, ({ i: xi }) => {
      const o = vec2(float(xi), float(yi));
      const id = g.add(o);
      const c = o.add(vec2(hash21(id.add(0.1)), hash21(id.add(0.2))));
      const rad = float(0.16).add(float(0.22).mul(hash21(id.add(0.3))));
      const d = length(f.sub(c));
      v.assign(max(v, smoothstep(rad, rad.mul(0.4), d)));
    });
  });

  return v;
});

// float dropletMask(vec3 p, vec3 worldNormal) — triplanar blend of dropField.
export const dropletMask = Fn(([p, worldNormal, dropletScale]) => {
  const n = abs(worldNormal).toVar();
  n.assign(n.div(max(n.x.add(n.y).add(n.z), 1e-4)));
  const dx = dropField(p.zy, dropletScale);
  const dy = dropField(p.xz, dropletScale);
  const dz = dropField(p.xy, dropletScale);
  return dx.mul(n.x).add(dy.mul(n.y)).add(dz.mul(n.z));
});
