/**
 * Pure hitscan helpers for WeaponSystem (M5/M6).
 * Node-importable — no THREE / Rapier required for unit checks.
 */

/** Head region is the top fraction of collision height. */
export const HEADSHOT_HEIGHT_FRAC = 0.78;
export const HEADSHOT_MULTIPLIER = 2.35;
export const BODY_MULTIPLIER = 1;
export const LIMB_MULTIPLIER = 0.75;

/**
 * Unit direction with random cone spread around `forward`.
 * @param {{x:number,y:number,z:number}} forward unit vector
 * @param {number} spreadRad half-angle radians
 * @param {() => number} [rng] 0..1
 * @returns {{x:number,y:number,z:number}}
 */
export function applySpread(forward, spreadRad, rng = Math.random) {
  const s = Math.max(0, Number(spreadRad) || 0);
  if (s <= 1e-8) {
    return normalize(forward);
  }
  // Build orthonormal basis around forward
  const f = normalize(forward);
  const up = Math.abs(f.y) < 0.95 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const r = normalize(cross(f, up));
  const u = cross(r, f);
  const theta = rng() * Math.PI * 2;
  const phi = rng() * s;
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return normalize({
    x: f.x * cosP + (r.x * cosT + u.x * sinT) * sinP,
    y: f.y * cosP + (r.y * cosT + u.y * sinT) * sinP,
    z: f.z * cosP + (r.z * cosT + u.z * sinT) * sinP,
  });
}

/**
 * Pellet directions for one shot.
 * @param {{x:number,y:number,z:number}} forward
 * @param {number} pellets
 * @param {number} spreadRad
 * @param {() => number} [rng]
 */
export function buildPelletDirections(forward, pellets, spreadRad, rng = Math.random) {
  const n = Math.max(1, Math.floor(Number(pellets) || 1));
  const dirs = [];
  for (let i = 0; i < n; i += 1) {
    // First pellet tight; remaining use full spread (shotgun pattern).
    const s = n === 1 ? spreadRad : (i === 0 ? spreadRad * 0.15 : spreadRad);
    dirs.push(applySpread(forward, s, rng));
  }
  return dirs;
}

/**
 * Damage multiplier by hit height on a standing enemy cylinder.
 * @param {number} hitY world y of impact
 * @param {number} feetY enemy feet y
 * @param {number} height collision height
 */
export function bodyRegionMultiplier(hitY, feetY, height) {
  const h = Math.max(0.5, Number(height) || 1.8);
  const t = (Number(hitY) - Number(feetY)) / h;
  if (t >= HEADSHOT_HEIGHT_FRAC) return HEADSHOT_MULTIPLIER;
  if (t < 0.22) return LIMB_MULTIPLIER;
  return BODY_MULTIPLIER;
}

/**
 * Final damage integer for a pellet.
 */
export function computeBulletDamage(baseDamage, hitY, feetY, height) {
  const mul = bodyRegionMultiplier(hitY, feetY, height);
  return Math.max(1, Math.round((Number(baseDamage) || 0) * mul));
}

/**
 * Closest enemy hit by a ray against vertical capsules (center + radius/height).
 * @returns {null|{enemy:object, distance:number, point:{x,y,z}, region:'head'|'body'|'limb'}}
 */
export function raycastEnemies(origin, direction, range, enemies) {
  const o = origin;
  const d = normalize(direction);
  const maxR = Math.max(0.1, Number(range) || 100);
  let best = null;

  for (const enemy of enemies ?? []) {
    if (!enemy?.model || enemy.pendingCorpse || enemy.health <= 0) continue;
    const pos = enemy.model.position;
    const height = enemy.collisionHeight ?? 1.8;
    const radius = Math.max(0.2, (enemy.collisionRadius ?? 0.35) * 1.15);
    const cx = pos.x;
    const cy = pos.y + height * 0.5;
    const cz = pos.z;

    // Infinite cylinder on Y, then clamp segment to height band.
    const ox = o.x - cx;
    const oz = o.z - cz;
    const a = d.x * d.x + d.z * d.z;
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - radius * radius;
    let tEnter;
    let tExit;
    if (a < 1e-10) {
      // Ray parallel to Y: must be inside cylinder radius
      if (c > 0) continue;
      tEnter = 0;
      tExit = maxR;
    } else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      tEnter = (-b - sq) / (2 * a);
      tExit = (-b + sq) / (2 * a);
    }
    if (tExit < 0 || tEnter > maxR) continue;

    // Intersect with slab [feetY, feetY+height]
    const feetY = pos.y;
    const headY = pos.y + height;
    let t0 = Math.max(0, tEnter);
    let t1 = Math.min(maxR, tExit);
    if (Math.abs(d.y) > 1e-8) {
      const ty0 = (feetY - o.y) / d.y;
      const ty1 = (headY - o.y) / d.y;
      const yMin = Math.min(ty0, ty1);
      const yMax = Math.max(ty0, ty1);
      t0 = Math.max(t0, yMin);
      t1 = Math.min(t1, yMax);
    } else if (o.y < feetY || o.y > headY) {
      continue;
    }
    if (t1 < t0) continue;

    const tHit = t0;
    if (tHit < 0 || tHit > maxR) continue;
    if (best && tHit >= best.distance) continue;

    const point = {
      x: o.x + d.x * tHit,
      y: o.y + d.y * tHit,
      z: o.z + d.z * tHit,
    };
    const mul = bodyRegionMultiplier(point.y, feetY, height);
    const region = mul >= HEADSHOT_MULTIPLIER ? 'head' : (mul < 1 ? 'limb' : 'body');
    best = { enemy, distance: tHit, point, region };
  }

  return best;
}

/** Reused Rapier ray to avoid per-shot WASM allocations. */
let _rapierRay = null;
let _rapierRayOwner = null;

/**
 * Prefer physics ray for world geometry; still test enemies separately.
 * Expensive against dense city colliders — callers should pass physics=null
 * unless wall occlusion is required.
 * @returns {{toi:number, point:{x,y,z}, collider:any}|null}
 */
export function castPhysicsRay(physics, origin, direction, range) {
  if (!physics?.world || !physics?.RAPIER) return null;
  const d = normalize(direction);
  const maxR = Math.max(0.1, Math.min(Number(range) || 100, 80));
  if (!_rapierRay || _rapierRayOwner !== physics.RAPIER) {
    _rapierRay = new physics.RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: d.x, y: d.y, z: d.z },
    );
    _rapierRayOwner = physics.RAPIER;
  } else {
    _rapierRay.origin.x = origin.x;
    _rapierRay.origin.y = origin.y;
    _rapierRay.origin.z = origin.z;
    _rapierRay.dir.x = d.x;
    _rapierRay.dir.y = d.y;
    _rapierRay.dir.z = d.z;
  }
  // solid=true: stop at first hit
  const hit = physics.world.castRay(_rapierRay, maxR, true);
  if (!hit) return null;
  const toi = hit.timeOfImpact;
  return {
    toi,
    point: {
      x: origin.x + d.x * toi,
      y: origin.y + d.y * toi,
      z: origin.z + d.z * toi,
    },
    collider: hit.collider ?? null,
  };
}

/**
 * Resolve one pellet: enemy first (cheap), optional world ray only if needed.
 */
export function resolvePelletHit({
  origin,
  direction,
  range,
  enemies,
  physics = null,
  baseDamage = 20,
}) {
  const enemyHit = raycastEnemies(origin, direction, range, enemies);

  // Skip world ray when we already have a solid enemy hit — big win in cities.
  if (enemyHit && enemyHit.distance < (Number(range) || 100)) {
    if (!physics) {
      return makeEnemyResult(enemyHit, baseDamage, origin, direction);
    }
    // Only cast world if we need occlusion (enemy behind walls).
    const worldHit = castPhysicsRay(physics, origin, direction, enemyHit.distance + 0.05);
    if (worldHit && worldHit.toi + 0.05 < enemyHit.distance) {
      return makeWorldResult(worldHit, origin, direction);
    }
    return makeEnemyResult(enemyHit, baseDamage, origin, direction);
  }

  if (physics) {
    const worldHit = castPhysicsRay(physics, origin, direction, range);
    if (worldHit) return makeWorldResult(worldHit, origin, direction);
  }

  const d = normalize(direction);
  const r = Math.max(0.1, Number(range) || 100);
  return {
    kind: 'miss',
    distance: r,
    point: { x: origin.x + d.x * r, y: origin.y + d.y * r, z: origin.z + d.z * r },
    direction: d,
    damage: 0,
    enemy: null,
    region: null,
  };
}

function makeEnemyResult(enemyHit, baseDamage, origin, direction) {
  const feetY = enemyHit.enemy.model.position.y;
  const height = enemyHit.enemy.collisionHeight ?? 1.8;
  const damage = computeBulletDamage(baseDamage, enemyHit.point.y, feetY, height);
  return {
    kind: 'enemy',
    distance: enemyHit.distance,
    point: enemyHit.point,
    direction: normalize(direction),
    damage,
    enemy: enemyHit.enemy,
    region: enemyHit.region,
  };
}

function makeWorldResult(worldHit, origin, direction) {
  return {
    kind: 'world',
    distance: worldHit.toi,
    point: worldHit.point,
    direction: normalize(direction),
    damage: 0,
    enemy: null,
    region: null,
    collider: worldHit.collider,
  };
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
