import * as THREE from 'three';

// Wingsuit driver — Part A, M0 (pinned membrane) + M2 (interior cloth billow).
//
// Boundary verts (the leading edge along the arm, the lower edge along the leg, and
// the inner body seam) stay HARD-pinned to bones via bilinear interpolation, exactly
// as in M0. The interior + the free trailing edge get a verlet cloth sim so the sheet
// sags, billows, and ripples like fabric.
//
// Stability trick: the sim integrates each free vertex's DISPLACEMENT from its pinned
// rest position (offset space), not its world position. That way the character
// running/jumping/animating (which yanks the rest targets around) never injects huge
// velocities into the cloth — the offsets just spring back to zero while gravity +
// airflow push them around. Runs AFTER AnimationStateSystem so the pose is final.

const GRAVITY = 3.2; // gentle sag (not full 9.8, or the sheet collapses flat)
const DAMPING = 0.9; // velocity retention between frames
const STIFFNESS = 0.16; // per-frame pull of each offset back toward its pinned rest
const MAX_OFFSET = 0.34; // clamp (m) so cloth can't balloon absurdly far
const WIND_BASE = 0.45; // steady billow push along the wing normal
const WIND_SPEED_K = 0.14; // extra billow per m/s of character speed
const FLUTTER_AMP = 0.9; // amplitude of the travelling ripple
const FLUTTER_FREQ = 8.5; // ripple temporal frequency
const SPATIAL_U = 0.7; // ripple phase step across the sheet (u)
const SPATIAL_V = 1.1; // ripple phase step across the sheet (v)
const MAX_DT = 1 / 30; // verlet stability clamp
const COLLISION_RADIUS = 0.2; // torso sphere the cloth can't sink inside

const _c00 = new THREE.Vector3();
const _c10 = new THREE.Vector3();
const _c01 = new THREE.Vector3();
const _c11 = new THREE.Vector3();
const _top = new THREE.Vector3();
const _bottom = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _edgeU = new THREE.Vector3();
const _edgeV = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _torso = new THREE.Vector3();
const _world = new THREE.Vector3();

export class WingsuitSystem {
  constructor() {
    this.time = 0;
  }

  update({ delta, character }) {
    const rig = character?.wingsuitRig;
    if (!rig || !rig.deployed) {
      return;
    }

    const modelRoot = character.animationController?.modelRoot;
    if (!modelRoot) {
      return;
    }

    if (!rig.bonesResolved) {
      resolveBones(rig, modelRoot);
      rig.bonesResolved = true;
    }

    const dt = Math.min(Math.max(delta ?? 0, 0), MAX_DT);
    this.time += dt;

    // Character airspeed feeds the billow strength.
    const vx = character.velocity?.x ?? 0;
    const vz = character.velocity?.z ?? 0;
    const speed = Math.hypot(vx, vz) + Math.abs(character.verticalVelocity ?? 0);

    // Torso centre for the (cheap) body-collision clamp.
    let hasTorso = false;
    if (rig.torsoBone) {
      rig.torsoBone.updateWorldMatrix(true, false);
      _torso.setFromMatrixPosition(rig.torsoBone.matrixWorld);
      hasTorso = true;
    }

    for (const panel of rig.panels) {
      ensureBuffers(panel);
      updatePanel(panel, { dt, time: this.time, speed, torso: hasTorso ? _torso : null });
    }
  }
}

function resolveBones(rig, modelRoot) {
  for (const panel of rig.panels) {
    for (const corner of panel.corners) {
      corner.boneRef = modelRoot.getObjectByName(corner.bone) ?? null;
    }
  }
  rig.torsoBone =
    modelRoot.getObjectByName('mixamorigSpine1') ??
    modelRoot.getObjectByName('mixamorigSpine') ??
    modelRoot.getObjectByName('mixamorigHips') ??
    null;
}

function ensureBuffers(panel) {
  if (panel.offset) {
    return;
  }
  const n = panel.cols * panel.rows * 3;
  panel.offset = new Float32Array(n);
  panel.offsetPrev = new Float32Array(n);
}

function cornerWorld(corner, target) {
  const bone = corner.boneRef;
  if (!bone) {
    return target.set(0, 0, 0);
  }
  // updateWorldMatrix(true,false) refreshes the ancestor chain so the bone's
  // matrixWorld is correct even though we run before the renderer's scene update.
  bone.updateWorldMatrix(true, false);
  return target.setFromMatrixPosition(bone.matrixWorld);
}

function updatePanel(panel, { dt, time, speed, torso }) {
  const [h00, h10, h01, h11] = panel.corners;
  cornerWorld(h00, _c00); // hand
  cornerWorld(h10, _c10); // foot
  cornerWorld(h01, _c01); // shoulder / hips
  cornerWorld(h11, _c11); // hip / hips

  // Approximate wing-plane normal from the corner quad — the airflow billows the
  // cloth along this axis.
  _edgeU.subVectors(_c10, _c00);
  _edgeV.subVectors(_c01, _c00);
  _normal.crossVectors(_edgeU, _edgeV);
  if (_normal.lengthSq() > 1e-8) {
    _normal.normalize();
  } else {
    _normal.set(0, 0, 1);
  }

  const positions = panel.geometry.attributes.position.array;
  const offset = panel.offset;
  const offsetPrev = panel.offsetPrev;
  const { gridU, gridV, cols, rows } = panel;
  const dt2 = dt * dt;
  const windMag = WIND_BASE + WIND_SPEED_K * speed;

  for (let iv = 0; iv < rows; iv++) {
    const v = iv / gridV;
    for (let iu = 0; iu < cols; iu++) {
      const u = iu / gridU;
      const vert = iv * cols + iu;
      const oi = vert * 3;
      const pi = vert * 3;

      // Pinned rest position (bilinear blend of the four corner bones).
      _top.lerpVectors(_c00, _c10, u);
      _bottom.lerpVectors(_c01, _c11, u);
      _rest.lerpVectors(_top, _bottom, v);

      // Boundary: leading edge (u=0), leg edge (u=1), body seam (v=1). Hard-pinned.
      const pinned = iu === 0 || iu === gridU || iv === gridV;

      if (pinned) {
        offset[oi] = offset[oi + 1] = offset[oi + 2] = 0;
        offsetPrev[oi] = offsetPrev[oi + 1] = offsetPrev[oi + 2] = 0;
        positions[pi] = _rest.x;
        positions[pi + 1] = _rest.y;
        positions[pi + 2] = _rest.z;
        continue;
      }

      // Travelling ripple + steady billow along the wing normal, plus gravity sag.
      const flutter = 0.4 + FLUTTER_AMP * Math.sin(time * FLUTTER_FREQ + u * (cols * SPATIAL_U) + v * (rows * SPATIAL_V));
      const push = windMag * flutter;
      const ax = _normal.x * push;
      const ay = _normal.y * push - GRAVITY;
      const az = _normal.z * push;

      // Verlet in offset space, with a spring back toward the pinned rest (0 offset).
      let ox = offset[oi];
      let oy = offset[oi + 1];
      let oz = offset[oi + 2];

      let nx = ox + (ox - offsetPrev[oi]) * DAMPING + ax * dt2;
      let ny = oy + (oy - offsetPrev[oi + 1]) * DAMPING + ay * dt2;
      let nz = oz + (oz - offsetPrev[oi + 2]) * DAMPING + az * dt2;

      nx *= 1 - STIFFNESS;
      ny *= 1 - STIFFNESS;
      nz *= 1 - STIFFNESS;

      // Clamp the displacement magnitude.
      const lenSq = nx * nx + ny * ny + nz * nz;
      if (lenSq > MAX_OFFSET * MAX_OFFSET) {
        const scale = MAX_OFFSET / Math.sqrt(lenSq);
        nx *= scale;
        ny *= scale;
        nz *= scale;
      }

      offsetPrev[oi] = ox;
      offsetPrev[oi + 1] = oy;
      offsetPrev[oi + 2] = oz;

      // World position = pinned rest + displacement.
      _world.set(_rest.x + nx, _rest.y + ny, _rest.z + nz);

      // Body-collision clamp: shove the vertex out of the torso sphere.
      if (torso) {
        const dx = _world.x - torso.x;
        const dy = _world.y - torso.y;
        const dz = _world.z - torso.z;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < COLLISION_RADIUS * COLLISION_RADIUS && dSq > 1e-6) {
          const d = Math.sqrt(dSq);
          const k = COLLISION_RADIUS / d;
          _world.set(torso.x + dx * k, torso.y + dy * k, torso.z + dz * k);
          // Re-derive the offset so prev/current stay consistent (less buzzing).
          nx = _world.x - _rest.x;
          ny = _world.y - _rest.y;
          nz = _world.z - _rest.z;
        }
      }

      offset[oi] = nx;
      offset[oi + 1] = ny;
      offset[oi + 2] = nz;

      positions[pi] = _world.x;
      positions[pi + 1] = _world.y;
      positions[pi + 2] = _world.z;
    }
  }

  panel.geometry.attributes.position.needsUpdate = true;
  panel.geometry.computeVertexNormals();
  panel.geometry.computeBoundingSphere();
}
