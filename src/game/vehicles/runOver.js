import * as THREE from 'three';

// Vehicle "run-over" helpers: given a chassis frame (from BaseVehicle.getRunOverFrame)
// and the live enemies, decide which enemies the car is ploughing into and how hard
// to fling each one. Kept pure (no system access) so it is unit-testable and the
// GameRuntime glue stays thin. See config.runOver for the tuning fields.

const _dir = new THREE.Vector3();

// Enemies whose footprint the chassis currently overlaps, in chassis-local space,
// capped at cfg.maxPerFrame. Each entry carries `sideSign` (which side of the
// centreline the enemy sits on) for the lateral launch kick. Returns [] when the
// car is too slow or nothing is in range.
export function computeRunOverHits({ frame, enemies, cfg }) {
  const hits = [];
  if (!frame || !enemies?.length || !cfg?.enabled || frame.horizSpeed < cfg.minSpeed) {
    return hits;
  }
  const carBottom = frame.position.y - frame.halfHeight - cfg.verticalMargin;
  const carTop = frame.position.y + frame.halfHeight + cfg.verticalMargin;
  const max = cfg.maxPerFrame ?? Infinity;

  for (const enemy of enemies) {
    if (enemy.pendingCorpse) {
      continue;
    }
    const ep = enemy.model?.position;
    if (!ep) {
      continue;
    }
    const er = enemy.collisionRadius ?? 0.5;
    const eh = enemy.collisionHeight ?? 1.8;
    // Vertical AABB overlap (skip enemies on a roof/ledge above or below the car).
    if (ep.y + eh < carBottom || ep.y > carTop) {
      continue;
    }
    // Project the enemy into the chassis-local frame and test the footprint.
    const dx = ep.x - frame.position.x;
    const dz = ep.z - frame.position.z;
    const localX = dx * frame.right.x + dz * frame.right.z;
    const localZ = dx * frame.forward.x + dz * frame.forward.z;
    if (
      Math.abs(localX) > frame.halfWidth + cfg.clearance + er ||
      Math.abs(localZ) > frame.halfLength + cfg.clearance + er
    ) {
      continue;
    }
    hits.push({ enemy, sideSign: localX >= 0 ? 1 : -1 });
    if (hits.length >= max) {
      break;
    }
  }
  return hits;
}

// World-space launch velocity (m/s) for one hit: carried along the car's travel
// direction and up, both scaled by impact speed, plus a sideways kick away from the
// centreline. Writes into `out` (a THREE.Vector3) and returns it.
export function computeRunOverLaunch({ frame, sideSign, cfg }, out = new THREE.Vector3()) {
  const fwdMag = frame.horizSpeed * cfg.forwardScale + cfg.forwardBase;
  const upMag = frame.horizSpeed * cfg.upScale + cfg.upBase;
  // Horizontal travel direction (fall back to chassis forward if ~stationary).
  if (frame.horizSpeed > 1e-4) {
    _dir.set(frame.velocity.x, 0, frame.velocity.z).multiplyScalar(1 / frame.horizSpeed);
  } else {
    _dir.set(frame.forward.x, 0, frame.forward.z).normalize();
  }
  return out.set(
    _dir.x * fwdMag + frame.right.x * sideSign * cfg.sideKick,
    upMag,
    _dir.z * fwdMag + frame.right.z * sideSign * cfg.sideKick,
  );
}
