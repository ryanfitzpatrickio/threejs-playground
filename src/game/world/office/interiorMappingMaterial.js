// interiorMappingMaterial.js — P2 "fake depth" FURNISHED rooms (docs/office-interior-wfc-plan.md).
//
// Classic interior mapping, extended: an unlit quad fakes a 3D office behind the
// window by intersecting the tangent-space view ray with an analytic room box AND
// a set of analytic furniture boxes (desk + monitor + chair + a side piece), then
// shading whichever surface the ray hits FIRST. Because every piece is real 3D
// geometry in the march — not a painted decal — leaning and strafing past the
// window reveals the room around the furniture, exactly like peering through a
// real window. That parallax-correct occlusion is what makes it read as a room.
//
// Fully procedural → zero textures/samplers. Per-window variation (side-piece
// type, desk offset, monitor glow, accent tint) comes from a per-window vertex
// attribute `aRoomSeed` (set by the factory), so every fragment of one window
// shares one arrangement — no split-window artefact. The quad needs tangents
// (computeTangents).
//
// KEY (unchanged from the original): the geometry view ray is a UNIT vector in
// world-scale tangent space, so the room and furniture must ALSO be in world
// metres (window W×H × depth D). A normalised [0,1] box compresses the parallax
// and you only ever see the flat back wall ("a square hole").

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec2, vec3, float, dot, max, min, clamp, mix, normalize, sign, sin,
  step, smoothstep, fract, floor, attribute,
  tangentView, tangentGeometry, normalViewGeometry, positionViewDirection,
  uv,
} from 'three/tsl';

// hash13 → float in [0,1) for the floor-carpet tile noise (the per-window
// arrangement seed uses aRoomSeed directly, not this). dot()+scalar sin/fract
// only; salt folds in an independent sample. Layout 'float' is the default.
const hash13 = Fn(([p, salt]) => {
  const s = dot(p, vec3(12.9898, 78.233, 37.719)).add(salt.mul(97.13));
  return fract(sin(s).mul(43758.5459));
});

// Slab intersection of ray (origin p, unit dir rd) with an axis-aligned box.
// Returns vec2(tEnter, tExit); a hit satisfies tExit >= max(tEnter, 0). A tiny
// abs-guard on rd keeps invRd finite for near-axis-aligned rays (1/0 → inf would
// poison the min/max). sign/max split preserves the correct component signs.
// NOTE the 'vec2' layout arg: a Fn declared without a layout defaults its
// getNodeType to 'float', which makes the returned vec2's .x/.y swizzles resolve
// to undefined → "getNodeType of undefined" at shader-compile time (the node graph
// still constructs, so this slips past node-only verify).
const boxHit = Fn(([p, rd, bmin, bmax]) => {
  const invRd = sign(rd).div(max(rd.abs(), float(1e-6)));
  const t1 = bmin.sub(p).mul(invRd);
  const t2 = bmax.sub(p).mul(invRd);
  const tlo = vec3(min(t1.x, t2.x), min(t1.y, t2.y), min(t1.z, t2.z));
  const thi = vec3(max(t1.x, t2.x), max(t1.y, t2.y), max(t1.z, t2.z));
  return vec2(max(max(tlo.x, tlo.y), tlo.z), min(min(thi.x, thi.y), thi.z));
}, 'vec2');

/**
 * @param {object} [opts]
 * @param {number} [opts.width=1.7]  window width in metres (match the quad)
 * @param {number} [opts.height=1.5] window height in metres (match the quad)
 * @param {number} [opts.depth=3.0]  room depth in metres behind the window
 * @param {'white'|'grey'|'office'} [opts.carpet='grey'] carpet style for the procedural floor
 * @param {'interior'|'exterior'} [opts.mode='interior'] parallax content — fake room vs outdoors
 */
export function createInteriorMappingMaterial({
  width = 1.7, height = 1.5, depth = 3.0, carpet = 'grey', mode = 'interior',
} = {}) {
  const material = new MeshBasicNodeMaterial();
  material.side = THREE.FrontSide;
  material.userData.interiorMappingMode = mode;

  if (mode === 'exterior') {
    material.colorNode = Fn(() => {
      const u = uv();
      const W = float(width);
      const H = float(height);
      const roomSeed = attribute('aRoomSeed');

      const bitangent = normalViewGeometry.cross(tangentView).mul(tangentGeometry.w);
      const vDir = normalize(vec3(
        dot(positionViewDirection, tangentView),
        dot(positionViewDirection, bitangent),
        dot(positionViewDirection, normalViewGeometry),
      ));

      const skyLow = vec3(0.72, 0.82, 0.96);
      const skyHigh = vec3(0.38, 0.58, 0.92);
      const sky = mix(skyLow, skyHigh, smoothstep(float(0.15), float(0.95), u.y));

      const sunX = mix(float(0.25), float(0.75), fract(roomSeed.mul(3.17)));
      const sunY = mix(float(0.55), float(0.82), fract(roomSeed.mul(11.3)));
      const sunDist = u.x.sub(sunX).abs().add(u.y.sub(sunY).abs().mul(0.6));
      const sun = smoothstep(float(0.22), float(0.0), sunDist).mul(vec3(1.4, 1.25, 0.95));

      const parX = vDir.x.mul(0.35);
      const parY = vDir.y.mul(0.12);

      const bx = u.x.add(parX);
      const by = u.y.add(parY);
      const cellA = floor(bx.mul(12).add(roomSeed.mul(17)));
      const hA = hash13(vec3(cellA, float(0), roomSeed), float(1));
      const bwA = mix(float(0.04), float(0.14), hA);
      const bhA = mix(float(0.08), float(0.38), fract(hA.mul(7.1)));
      const cxA = fract(bx.mul(12).add(hA.mul(0.3)));
      const botA = mix(float(0.02), float(0.35), fract(hA.mul(13.7)));
      const bldA = step(cxA, bwA).mul(step(botA, u.y)).mul(step(u.y, botA.add(bhA)));
      const colA = mix(vec3(0.14, 0.16, 0.22), vec3(0.28, 0.31, 0.38), hA);

      const cellB = floor(bx.mul(7).add(roomSeed.mul(5.3)));
      const hB = hash13(vec3(cellB, float(1), roomSeed), float(2));
      const bwB = mix(float(0.06), float(0.2), hB);
      const bhB = mix(float(0.12), float(0.55), fract(hB.mul(5.9)));
      const cxB = fract(bx.mul(7).add(hB.mul(0.5)));
      const botB = mix(float(0.0), float(0.25), fract(hB.mul(9.3)));
      const bldB = step(cxB, bwB).mul(step(botB, u.y)).mul(step(u.y, botB.add(bhB)));
      const colB = mix(vec3(0.10, 0.12, 0.18), vec3(0.22, 0.25, 0.32), hB);

      const horizon = smoothstep(float(0.18), float(0.42), u.y);
      let col = mix(colB.mul(0.85), colA, float(0.55));
      col = mix(col, sky, horizon);
      col = col.add(sun.mul(horizon));

      const slat = sin(u.y.mul(95).add(roomSeed.mul(40))).mul(0.5).add(0.5);
      const slatMask = smoothstep(float(0.42), float(0.55), slat).mul(float(0.06));
      col = col.mul(float(1).sub(slatMask));

      const eu = smoothstep(float(0.0), float(0.035), u.x).mul(smoothstep(float(1.0), float(0.965), u.x));
      const ev = smoothstep(float(0.0), float(0.05), u.y).mul(smoothstep(float(1.0), float(0.95), u.y));
      col = col.mul(mix(float(0.18), float(1.0), eu.mul(ev)));

      return col;
    })();
    material.toneMapped = true;
    return material;
  }

  material.colorNode = Fn(() => {
    // --- tangent-space view ray into the room (unchanged: surface → camera, then negate) ---
    const bitangent = normalViewGeometry.cross(tangentView).mul(tangentGeometry.w);
    const vDir = normalize(vec3(
      dot(positionViewDirection, tangentView),
      dot(positionViewDirection, bitangent),
      dot(positionViewDirection, normalViewGeometry),
    )).toVar();

    const W = float(width);
    const H = float(height);
    const D = float(depth);
    const roomMin = vec3(0, 0, D.negate());
    const roomMax = vec3(W, H, 0);
    const p = vec3(uv().x.mul(W), uv().y.mul(H), float(0)).toVar(); // fragment, on the window (z=0) face
    const rd = vDir.negate().toVar();                                // into the room (−z)

    // Carpet base colour for the procedural floor (matches PBR carpet options).
    const floorBaseCol = (carpet === 'white')
      ? vec3(0.52, 0.52, 0.56)
      : (carpet === 'office')
        ? vec3(0.16, 0.16, 0.22)
        : vec3(0.22, 0.23, 0.27);

    // --- per-window arrangement seed ---
    // aRoomSeed is a per-window vertex attribute (one float, same on all 4 verts)
    // set by the factory, so every fragment of a window shares one arrangement
    // (no split-window artefact). objectPosition can't be used here: in this three
    // build it neither swizzles nor chains, so it can't seed a hash. Four samples
    // are decorrelated from the one seed by multiplying through primes.
    const roomSeed = attribute('aRoomSeed');
    const rArr = roomSeed;
    const rJit = fract(roomSeed.mul(7.13));
    const rMon = fract(roomSeed.mul(13.7).add(0.31));
    const rTnt = fract(roomSeed.mul(23.1).add(0.7));

    // --- furniture boxes, room metres; x∈[0,W], y∈[0,H], z∈[-D,0] (window at z=0) ---
    const deskHalfW = float(0.46);
    const deskTopY = float(0.44);
    const deskFrontZ = D.negate().add(0.62);        // -D + 0.62 (against the back wall)
    const deskCX = mix(float(0.34), float(0.66), rJit).mul(W);
    const deskMin = vec3(deskCX.sub(deskHalfW), float(0), D.negate());
    const deskMax = vec3(deskCX.add(deskHalfW), deskTopY, deskFrontZ);

    // Monitor stands on the desk, against the back wall, thin in z so the ray
    // almost always enters its front (screen) face.
    const monHalfW = float(0.27);
    const monMin = vec3(deskCX.sub(monHalfW), deskTopY, D.negate());
    const monMax = vec3(deskCX.add(monHalfW), float(0.82), D.negate().add(0.09));

    // Chair between window (z = 0) and desk; faces toward the desk (−z). Back toward +z.
    const chairZ = float(-1.35);
    const seatMin = vec3(deskCX.sub(0.22), float(0.18), chairZ.sub(0.18));
    const seatMax = vec3(deskCX.add(0.22), float(0.36), chairZ.add(0.18));
    const backMin = vec3(deskCX.sub(0.22), float(0.36), chairZ.add(0.10));
    const backMax = vec3(deskCX.add(0.22), float(0.74), chairZ.add(0.24));

    // One side piece against the LEFT wall, chosen by rArr. Three candidate boxes
    // are intersected but only the active variant's hits count (gated by v*).
    const bookMin = vec3(float(0.02), float(0), D.negate().add(0.10));
    const bookMax = vec3(float(0.40), float(0.95), D.negate().add(0.95));
    const cabMin = vec3(float(0.02), float(0), float(0.60).negate());
    const cabMax = vec3(float(0.40), float(0.56), float(0.05).negate());
    const plantMin = vec3(float(0.06), float(0), D.negate().add(0.25));
    const plantMax = vec3(float(0.42), float(0.62), D.negate().add(0.65));
    const vBook = step(rArr, float(0.34));
    const vCab = step(float(0.34), rArr).mul(step(rArr, float(0.67)));
    const vPlant = step(float(0.67), rArr);

    // --- nearest-surface compositing: shell first, then each piece overrides if closer ---
    // Float-gated mix (no bool ops): ok=1 only when the box is hit (tExit>=enter) AND
    // the entry is closer than the running best. Sequential, so layering is correct
    // (chair in front of desk in front of the back wall, floor visible around them).
    const SHELL = float(0); const DESK = float(1); const MON = float(2);
    const SEAT = float(3); const BACK = float(4); const SIDE = float(5);

    const bestT = boxHit(p, rd, roomMin, roomMax).y.toVar(); // shell = room-box EXIT dist
    const bestId = SHELL.toVar();

    const consider = (bmin, bmax, id, mask = null) => {
      const b = boxHit(p, rd, bmin, bmax);
      const enter = max(b.x, float(0));
      let ok = step(enter, b.y).mul(step(enter, bestT));
      if (mask !== null) ok = ok.mul(mask);
      bestT.assign(mix(bestT, enter, ok));
      bestId.assign(mix(bestId, id, ok));
    };
    consider(deskMin, deskMax, DESK);
    consider(monMin, monMax, MON);
    consider(seatMin, seatMax, SEAT);
    consider(backMin, backMax, BACK);
    consider(bookMin, bookMax, SIDE, vBook);
    consider(cabMin, cabMax, SIDE, vCab);
    consider(plantMin, plantMax, SIDE, vPlant);

    // Hit point + room-relative coords (0..1 across / up / depth). Valid on every
    // surface; the shell masks below only matter when bestId==SHELL.
    const hit = p.add(rd.mul(bestT));
    const hx = clamp(hit.x.div(W), float(0), float(1));
    const hy = clamp(hit.y.div(H), float(0), float(1));
    const hd = clamp(hit.z.negate().div(D), float(0), float(1)); // 0 front → 1 back

    // ============ SHELL colour (floor / ceiling / three walls) ============
    const floorMask = step(hy, float(0.06));
    const ceilMask = step(float(0.94), hy);
    const backMask = step(float(0.90), hd);
    const sideMask = max(step(hx, float(0.06)), step(float(0.94), hx));

    // Floor: carpet (style chosen by `carpet` param) with low tile noise + contact shadow.
    const tileN = hash13(vec3(floor(hx.mul(5)), floor(hy.mul(5)), float(0)), float(9)).sub(0.5);
    const tn = tileN.mul(0.05);
    const floorBase = floorBaseCol.add(vec3(tn, tn, tn));
    const underDesk = step(deskMin.x.div(W), hx).mul(step(hx, deskMax.x.div(W)))
      .mul(step(deskMax.z.negate().div(D), hd));
    const floorCol = mix(floorBase, floorBase.mul(0.5), underDesk.mul(0.75));

    // Ceiling: off-white tile with a 2×2 grid of cool-white emissive troffers
    // (values >1 so they bloom on ultra, like the real lit panels overhead).
    const pxg = fract(hx.mul(2).add(0.5));
    const pzg = fract(hd.mul(2).add(0.5));
    const panel = step(float(0.18), pxg).mul(step(pxg, float(0.82)))
      .mul(step(float(0.22), pzg)).mul(step(pzg, float(0.78)));
    const ceilCol = mix(vec3(0.22, 0.22, 0.25), vec3(1.2, 1.35, 1.7), panel);

    // Back wall: warm paint, a centred outside window (sky + distant buildings),
    // a soft cool halo where the monitor light washes the wall, and a fake office door.
    const wallPaint = mix(vec3(0.30, 0.29, 0.32), vec3(0.40, 0.37, 0.39), rTnt.mul(0.4));
    const doorCX = mix(float(0.72), float(0.88), rJit);
    const doorW = float(0.14);
    const doorBot = float(0.02);
    const doorTop = float(0.72);
    const fakeDoor = step(doorCX.sub(doorW), hx).mul(step(hx, doorCX.add(doorW)))
      .mul(step(doorBot, hy)).mul(step(hy, doorTop)).mul(backMask);
    const doorPanel = vec3(0.34, 0.30, 0.26);
    const doorFrame = vec3(0.12, 0.12, 0.14);
    const doorEdge = max(step(hx, doorCX.sub(doorW.sub(0.012))), step(doorCX.add(doorW.sub(0.012)), hx))
      .add(max(step(hy, doorBot), step(doorTop, hy)));
    const doorCol = mix(doorPanel, doorFrame, clamp(doorEdge, float(0), float(1)));
    const ow = step(float(0.16), hx).mul(step(hx, float(0.84)))
      .mul(step(float(0.30), hy)).mul(step(hy, float(0.88)));
    const sky = mix(vec3(0.45, 0.55, 0.78), vec3(0.86, 0.91, 1.0), smoothstep(float(0.3), float(0.95), hy));
    const buildings = mix(vec3(0.16, 0.18, 0.24), vec3(0.30, 0.33, 0.42), step(float(0.5), hy));
    const outside = mix(buildings, sky, smoothstep(float(0.5), float(0.62), hy));
    const monHX = deskCX.div(W);
    const halo = smoothstep(float(0.20), float(0.0), hx.sub(monHX).abs())
      .mul(smoothstep(float(0.0), float(0.25), hy)).mul(smoothstep(float(1.0), float(0.55), hy));
    const backCol = mix(wallPaint, outside, ow)
      .add(vec3(0.08, 0.14, 0.26).mul(halo));
    const backWithDoor = mix(backCol, doorCol, fakeDoor);

    // Side walls: same paint, slightly graded toward the floor (reads as a recess).
    const sideWall = mix(wallPaint.mul(0.9), wallPaint, smoothstep(float(0.0), float(0.5), hy));

    let shellCol = wallPaint;
    shellCol = mix(shellCol, sideWall, sideMask);
    shellCol = mix(shellCol, floorCol, floorMask);
    shellCol = mix(shellCol, ceilCol, ceilMask);
    shellCol = mix(shellCol, backWithDoor, backMask);

    // ============ FURNITURE colour ============
    // Desk: warm wood; the lit top face reads lighter than the front apron.
    const deskTopF = step(deskTopY.sub(0.03), hit.y);
    const deskCol = mix(vec3(0.17, 0.12, 0.08), vec3(0.37, 0.27, 0.17), deskTopF);

    // Monitor: dark body; the front face is an emissive cool screen (>1 → bloom).
    const screenF = step(monMax.z.sub(0.02), hit.z);
    const screen = vec3(0.55, 0.85, 1.5).mul(mix(float(0.7), float(1.5), rMon));
    const monCol = mix(vec3(0.03, 0.03, 0.05), screen, screenF);

    // Chair: dark fabric; a faint highlight on the seat crown.
    const seatTopF = step(seatMax.y.sub(0.03), hit.y);
    const seatCol = mix(vec3(0.09, 0.10, 0.13), vec3(0.14, 0.15, 0.19), seatTopF);
    const backrestCol = vec3(0.07, 0.08, 0.11);

    // Side piece: bookshelf (wood + shelf lines) / metal cabinet / potted plant.
    const bookCol = vec3(0.20, 0.15, 0.10)
      .mul(mix(float(0.6), float(1.0), step(float(0.08), fract(hit.y.mul(2.2).add(0.5)))));
    const cabCol = vec3(0.13, 0.13, 0.16);
    const plantCol = mix(vec3(0.22, 0.15, 0.10), vec3(0.16, 0.33, 0.17), step(float(0.18), hit.y));
    const sideCol = mix(mix(bookCol, cabCol, vCab), plantCol, vPlant);

    // ============ pick the winner (one-hot weights on the integer id) ============
    const wShell = step(bestId.sub(0).abs(), float(0.499));
    const wDesk = step(bestId.sub(1).abs(), float(0.499));
    const wMon = step(bestId.sub(2).abs(), float(0.499));
    const wSeat = step(bestId.sub(3).abs(), float(0.499));
    const wBack = step(bestId.sub(4).abs(), float(0.499));
    const wSide = step(bestId.sub(5).abs(), float(0.499));
    const col = shellCol.mul(wShell)
      .add(deskCol.mul(wDesk))
      .add(monCol.mul(wMon))
      .add(seatCol.mul(wSeat))
      .add(backrestCol.mul(wBack))
      .add(sideCol.mul(wSide)).toVar();

    // ============ atmosphere + window read ============
    // Mild depth fade so the back of the room settles behind the furniture.
    col.assign(col.mul(mix(float(1.0), float(0.74), hd)));
    // Subtle mullion frame at the quad edges so it reads as a window, not a hole.
    const eu = smoothstep(float(0.0), float(0.035), uv().x).mul(smoothstep(float(1.0), float(0.965), uv().x));
    const ev = smoothstep(float(0.0), float(0.05), uv().y).mul(smoothstep(float(1.0), float(0.95), uv().y));
    col.assign(col.mul(mix(float(0.18), float(1.0), eu.mul(ev))));

    return col;
  })();

  material.toneMapped = true;
  return material;
}
