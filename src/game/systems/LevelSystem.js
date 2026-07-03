import * as THREE from 'three';
import { createBaseLevel } from '../world/createBaseLevel.js';
import { createStreamingTerrainLevel } from '../world/createStreamingTerrainLevel.js';
import { createComposedWorldLevel } from '../world/createComposedWorldLevel.js';
import { createWildsLevel } from '../world/createWildsLevel.js';
import { getActiveWorldMap } from '../../world/worldMap/worldMapScenes.js';

const ledgeNormal = new THREE.Vector3();
const ledgeTangent = new THREE.Vector3();
const ledgeInput = new THREE.Vector3();
const candidatePoint = new THREE.Vector3();
const cornerPoint = new THREE.Vector3();
const cornerMoveDirection = new THREE.Vector3();
const cornerCandidatePoint = new THREE.Vector3();
const cornerCandidateNormal = new THREE.Vector3();
const climbSurfaceOrigin = new THREE.Vector3();
const climbSurfaceNormal = new THREE.Vector3();
const climbSurfaceTangent = new THREE.Vector3();
const climbSurfaceUp = new THREE.Vector3();
const climbSurfaceRelative = new THREE.Vector3();
const climbSurfacePoint = new THREE.Vector3();
const climbSurfaceLedgePoint = new THREE.Vector3();
const climbSurfaceLedgeNormal = new THREE.Vector3();
const climbSurfaceLedgeTangent = new THREE.Vector3();
const ZERO_VECTOR = new THREE.Vector3();
const wallRunOrigin = new THREE.Vector3();
const wallRunNormal = new THREE.Vector3();
const wallRunTangent = new THREE.Vector3();
const wallRunUp = new THREE.Vector3();
const wallRunRelative = new THREE.Vector3();
const wallRunVelocity = new THREE.Vector3();
const ropeAnchor = new THREE.Vector3();
const ropeBottom = new THREE.Vector3();
const ropeClosestPoint = new THREE.Vector3();
const hookRayOrigin = new THREE.Vector3();
const hookRayDirection = new THREE.Vector3();
const hookWorldNormal = new THREE.Vector3();
const hookAttachPosition = new THREE.Vector3();
const hookToPlayer = new THREE.Vector3();
const hookCameraForward = new THREE.Vector3();
const hookSearchDirection = new THREE.Vector3();
const hookColliderHitPoint = new THREE.Vector3();
const hookColliderHitNormal = new THREE.Vector3();

const HOOK_SEARCH_PITCHES = [0.62, 0.74, 0.86, 0.98, 1.1, 1.22];
const HOOK_SEARCH_YAW_OFFSETS = [-0.22, -0.11, 0, 0.11, 0.22];
// Cheap cursor-preview fan: a sparse subset of the full fan's upward cone (same
// absolute pitches, fewer samples) so it finds the same high targets firing would.
const HOOK_COARSE_PITCHES = [0.7, 0.94, 1.18];
const HOOK_COARSE_YAW_OFFSETS = [-0.18, 0, 0.18];

const avoidProbeOrigin = new THREE.Vector3();
const avoidProbeDirection = new THREE.Vector3();
const avoidLookOrigin = new THREE.Vector3();
const avoidVelocityFlat = new THREE.Vector3();
const avoidForward = new THREE.Vector3();
const avoidRight = new THREE.Vector3();
const avoidWallTangent = new THREE.Vector3();
const avoidRepulsion = new THREE.Vector3();
const avoidSampleRepulsion = new THREE.Vector3();
const avoidSampleSkim = new THREE.Vector3();
const avoidSampleNormal = new THREE.Vector3();
const avoidWorldUp = new THREE.Vector3(0, 1, 0);
const avoidStreetBoost = new THREE.Vector3();
const avoidWallNormal = new THREE.Vector3();
const avoidHitToPlayer = new THREE.Vector3();
const hookAvoidanceResult = {
  repulsion: avoidRepulsion,
  streetForward: avoidStreetBoost,
  wallNormal: avoidWallNormal,
  hasWall: false,
  penetration: 0,
  inCorridor: false,
};

const HOOK_AVOID_PROBE_RANGE = 5.2;
const HOOK_AVOID_CLEARANCE = 1.35;
const HOOK_AVOID_REPULSION = 240;
const HOOK_AVOID_SKIM = 95;
const HOOK_AVOID_LOOKAHEAD_BASE = 4.5;
const HOOK_AVOID_LOOKAHEAD_SPEED = 0.34;
const HOOK_AVOID_LOOK_YAW_OFFSETS = [-0.52, -0.26, 0, 0.26, 0.52];
const TOP_CLIMB_LEDGE_VERTICAL_TOLERANCE = 1.15;
const TOP_CLIMB_LEDGE_PLANE_TOLERANCE = 1.65;
const TOP_CLIMB_LEDGE_OUTWARD_MARGIN = 0.12;
const LEDGE_OUTER_SELECTION_MARGIN = 0.12;
const LEDGE_OUTER_SELECTION_HEIGHT_TOLERANCE = 1.15;

export class LevelSystem {
  constructor() {
    this.level = null;
    this.status = 'idle';
  }

  async loadBaseLevel(scene, qualityPreset = {}, mode = 'city') {
    this.status = 'loading';
    this.mode = ['world', 'wilds'].includes(mode) ? mode : 'city';
    if (this.mode === 'wilds') {
      this.level = createWildsLevel(qualityPreset);
    } else if (this.mode === 'world') {
      const worldMap = await getActiveWorldMap();
      const hasCity = (worldMap?.zones ?? []).some((zone) => zone.type === 'city');
      // Only spin up the city workers when the map actually has a city zone.
      this.level = hasCity
        ? createComposedWorldLevel(qualityPreset, { worldMap })
        : createStreamingTerrainLevel(qualityPreset, { worldMap });
    } else {
      this.level = createBaseLevel(qualityPreset);
    }
    scene.add(this.level.group);

    await nextFrame();
    this.status = 'loaded';
  }

  snapshot() {
    const collisionDebug = getCollisionDebugSnapshot(this.level?.group);
    const traversalDebug = getTraversalDebugSnapshot(this.level?.group);

    return {
      name: this.level?.name ?? 'Base Level',
      status: this.status,
      colliders: this.level?.colliders?.length ?? 0,
      ledges: this.level?.ledges?.length ?? 0,
      climbSurfaces: this.level?.climbSurfaces?.length ?? 0,
      wallRunSurfaces: this.level?.wallRunSurfaces?.length ?? 0,
      ropes: this.level?.ropes?.length ?? 0,
      bvhMeshes: this.level?.geometryIndex?.entries.length ?? 0,
      city: this.level?.snapshot?.() ?? null,
      collisionDebug,
      traversalDebug,
    };
  }

  setCollisionDebugVisible(visible) {
    const overlays = findDebugOverlays(this.level?.group);

    if (overlays.length === 0) {
      return false;
    }

    for (const overlay of overlays) {
      overlay.visible = visible === true;
    }

    return visible === true;
  }

  toggleCollisionDebug() {
    const overlays = findDebugOverlays(this.level?.group);

    if (overlays.length === 0) {
      return false;
    }

    const visible = !overlays.some((overlay) => overlay.visible === true);
    for (const overlay of overlays) {
      overlay.visible = visible;
    }

    return visible;
  }

  updateStreaming(position) {
    const debugVisible = findDebugOverlays(this.level?.group).some((overlay) => overlay.visible === true);
    return this.level?.updateStreaming?.(position, { debugVisible }) ?? null;
  }

  getGroundHeightAt(position, radius, options) {
    return this.level?.getGroundHeightAt?.(position, radius, options) ?? 0;
  }

  // Forwarded so callers holding the LevelSystem (e.g. VehicleSystem) can guarantee
  // a physics heightfield exists under a point before placing a rigid body there —
  // streaming-built terrain can be visually live without a heightfield. No-op on
  // levels that don't stream terrain (city/wilds), which is why those modes worked.
  ensureGroundCollider(position, physics, options) {
    return this.level?.ensureGroundCollider?.(position, physics, options) ?? false;
  }

  getBlockingColliderAt({ position, radius, feetY, height, stepHeight }) {
    return this.level?.getBlockingColliderAt?.({
      position,
      radius,
      feetY,
      height,
      stepHeight,
    }) ?? null;
  }

  raycastGeometry(query) {
    return this.level?.geometryIndex?.raycast(query) ?? [];
  }

  warmupGeometryRaycasts(options) {
    return this.level?.geometryIndex?.warmupBoundsTrees?.(options) ?? 0;
  }

  findRopeCandidate({
    position,
    maxDistance = 0.86,
    verticalPadding = 0.28,
  }) {
    let bestCandidate = null;
    let bestScore = Infinity;

    for (const rope of this.level?.ropes ?? []) {
      setVectorFromObject(ropeAnchor, rope.anchor);
      ropeBottom.copy(ropeAnchor);
      ropeBottom.y -= rope.length;
      const minY = ropeBottom.y - verticalPadding;
      const maxY = ropeAnchor.y + verticalPadding;

      if (position.y < minY || position.y > maxY) {
        continue;
      }

      const grabDistance = THREE.MathUtils.clamp(
        ropeAnchor.y - position.y,
        rope.minGrabDistance ?? 0.85,
        rope.maxGrabDistance ?? rope.length,
      );
      ropeClosestPoint.copy(ropeAnchor);
      ropeClosestPoint.y -= grabDistance;

      const horizontalDistance = Math.hypot(
        position.x - ropeClosestPoint.x,
        position.z - ropeClosestPoint.z,
      );

      if (horizontalDistance > maxDistance) {
        continue;
      }

      const verticalDistance = Math.abs(position.y - ropeClosestPoint.y);
      const score = horizontalDistance + verticalDistance * 0.22;

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = {
          ...rope,
          anchor: ropeAnchor.clone(),
          bottom: ropeBottom.clone(),
          point: ropeClosestPoint.clone(),
          grabDistance,
          distance: horizontalDistance,
          swingTangent: new THREE.Vector3(rope.swingTangent.x, rope.swingTangent.y, rope.swingTangent.z),
        };
      }
    }

    return bestCandidate;
  }

  findHookAttachCandidate({
    origin,
    direction,
    camera,
    playerPosition,
    maxDistance = 68,
    minDistance = 3,
    minHeightAbovePlayer = 4,
    minGroundHeight = 1.2,
    coarse = false,
  }) {
    if (!playerPosition) {
      return null;
    }

    const playerFeetY = playerPosition.y;
    let bestCandidate = null;
    let bestScore = -Infinity;

    const searchRays = buildHookSearchRays({ camera, origin, direction, playerPosition, coarse });
    let hitCount = 0;
    let colliderHitCount = 0;
    let scoredCount = 0;

    for (const ray of searchRays) {
      hookRayOrigin.copy(ray.origin);
      hookRayDirection.copy(ray.direction).normalize();

      const geometryHits = this.raycastGeometry({
        origin: hookRayOrigin,
        direction: hookRayDirection,
        near: minDistance,
        far: maxDistance,
        firstHitOnly: false,
      });
      hitCount += geometryHits.length;
      let rayScoredCount = 0;

      for (const hit of geometryHits) {
        const candidate = scoreHookHit({
          hit,
          rayDirection: hookRayDirection,
          rayWeight: ray.weight,
          playerPosition,
          playerFeetY,
          minHeightAbovePlayer,
          minGroundHeight,
          getGroundHeightAt: (point, radius) => this.getGroundHeightAt(point, radius),
        });

        if (candidate) {
          scoredCount += 1;
          rayScoredCount += 1;
        }

        if (candidate && candidate.score > bestScore) {
          bestScore = candidate.score;
          bestCandidate = candidate;
        }
      }

      if (rayScoredCount === 0) {
        const colliderHits = raycastHookColliders({
          origin: hookRayOrigin,
          direction: hookRayDirection,
          near: minDistance,
          far: maxDistance,
          colliderIndex: this.level?.colliderIndex ?? null,
        });
        hitCount += colliderHits.length;
        colliderHitCount += colliderHits.length;

        for (const hit of colliderHits) {
          const candidate = scoreHookHit({
            hit,
            rayDirection: hookRayDirection,
            rayWeight: ray.weight,
            playerPosition,
            playerFeetY,
            minHeightAbovePlayer,
            minGroundHeight,
            getGroundHeightAt: (point, radius) => this.getGroundHeightAt(point, radius),
          });

          if (candidate) {
            scoredCount += 1;
          }

          if (candidate && candidate.score > bestScore) {
            bestScore = candidate.score;
            bestCandidate = candidate;
          }
        }
      }
    }

    if (!bestCandidate) {
      this.lastHookSearch = {
        coarse,
        rays: searchRays.length,
        hits: hitCount,
        colliderHits: colliderHitCount,
        scored: scoredCount,
        found: false,
      };
      return null;
    }

    this.lastHookSearch = {
      coarse,
      rays: searchRays.length,
      hits: hitCount,
      colliderHits: colliderHitCount,
      scored: scoredCount,
      found: true,
      meshName: bestCandidate.meshName ?? null,
      distance: Number(bestCandidate.distance.toFixed(3)),
      heightAbovePlayer: Number(bestCandidate.heightAbovePlayer.toFixed(3)),
    };

    return {
      position: bestCandidate.position,
      normal: bestCandidate.normal,
      distance: bestCandidate.distance,
      meshName: bestCandidate.meshName,
      point: bestCandidate.point,
      heightAbovePlayer: bestCandidate.heightAbovePlayer,
    };
  }

  computeHookSwingAvoidance({
    position,
    velocity,
    bodyRadius = 0.48,
  }) {
    avoidRepulsion.set(0, 0, 0);
    avoidStreetBoost.set(0, 0, 0);
    avoidWallNormal.set(0, 0, 0);

    let penetration = 0;
    let inCorridor = false;
    let hasWall = false;
    let leftGap = Infinity;
    let rightGap = Infinity;

    avoidVelocityFlat.set(velocity.x, 0, velocity.z);
    const speed = avoidVelocityFlat.length();
    if (speed > 1.2) {
      avoidVelocityFlat.multiplyScalar(1 / speed);
    } else {
      avoidVelocityFlat.set(0, 0, -1);
    }

    const probeY = position.y + 1.05;
    avoidProbeOrigin.set(position.x, probeY, position.z);

    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      avoidProbeDirection.set(Math.sin(angle), 0, Math.cos(angle));
      accumulateHookAvoidanceHit({
        origin: avoidProbeOrigin,
        direction: avoidProbeDirection,
        maxDistance: HOOK_AVOID_PROBE_RANGE,
        bodyRadius,
        raycast: (query) => this.raycastGeometry(query),
        onWall: (sample) => {
          hasWall = true;
          if (sample.penetration >= penetration) {
            penetration = sample.penetration;
            avoidWallNormal.copy(sample.normal);
          }
        },
      });
    }

    if (speed > 1.2) {
      const lookDistance = Math.min(
        14,
        HOOK_AVOID_LOOKAHEAD_BASE + speed * HOOK_AVOID_LOOKAHEAD_SPEED,
      );
      avoidLookOrigin.copy(avoidProbeOrigin).addScaledVector(velocity, Math.min(0.22, speed * 0.04));

      for (const yawOffset of HOOK_AVOID_LOOK_YAW_OFFSETS) {
        const yaw = Math.atan2(avoidVelocityFlat.x, avoidVelocityFlat.z) + yawOffset;
        avoidProbeDirection.set(
          Math.sin(yaw),
          -0.08,
          Math.cos(yaw),
        ).normalize();

        accumulateHookAvoidanceHit({
          origin: avoidLookOrigin,
          direction: avoidProbeDirection,
          maxDistance: lookDistance,
          bodyRadius,
          lookaheadWeight: 1.35,
          raycast: (query) => this.raycastGeometry(query),
          onWall: (sample) => {
            hasWall = true;
            if (sample.penetration >= penetration) {
              penetration = sample.penetration;
              avoidWallNormal.copy(sample.normal);
            }
          },
        });
      }

      avoidForward.copy(avoidVelocityFlat);
      avoidRight.set(avoidForward.z, 0, -avoidForward.x).normalize();

      avoidProbeDirection.copy(avoidRight).multiplyScalar(-1);
      leftGap = measureHookSideGap({
        origin: avoidProbeOrigin,
        direction: avoidProbeDirection,
        bodyRadius,
        raycast: (query) => this.raycastGeometry(query),
      });
      rightGap = measureHookSideGap({
        origin: avoidProbeOrigin,
        direction: avoidRight,
        bodyRadius,
        raycast: (query) => this.raycastGeometry(query),
      });

      inCorridor = leftGap < HOOK_AVOID_PROBE_RANGE && rightGap < HOOK_AVOID_PROBE_RANGE;
      if (inCorridor) {
        avoidStreetBoost.copy(avoidForward);
      }
    }

    hookAvoidanceResult.hasWall = hasWall;
    hookAvoidanceResult.penetration = penetration;
    hookAvoidanceResult.inCorridor = inCorridor;
    return hookAvoidanceResult;
  }

  findClimbSurfaceCandidate({
    position,
    maxFaceDistance = 0.62,
    minFaceDistance = -0.1,
    edgePadding = 0.16,
    verticalPadding = 0.16,
    blockName = null,
    face = null,
    normalHint = null,
    minNormalDot = -1,
    minOriginY = -Infinity,
    minTopY = -Infinity,
    maxEdgeDistance = 0.45,
    maxVerticalDistance = 1.15,
    trace = null,
  }) {
    let bestCandidate = null;
    let bestScore = Infinity;

    for (const surface of this.level?.climbSurfaces ?? []) {
      // blockName/face filters define the candidate *pool*; surfaces dropped here
      // are intentionally not traced (the caller reports poolSize separately).
      if (blockName && surface.blockName !== blockName) {
        continue;
      }

      if (face && surface.face !== face) {
        continue;
      }

      setVectorFromObject(climbSurfaceOrigin, surface.origin);
      setVectorFromObject(climbSurfaceNormal, surface.normal);
      const originY = climbSurfaceOrigin.y;
      const topY = originY + surface.maxV;

      if (originY < minOriginY) {
        pushClimbTrace(trace, surface, { reject: 'minOriginY', originY, topY });
        continue;
      }

      if (normalHint && climbSurfaceNormal.dot(normalHint) < minNormalDot) {
        pushClimbTrace(trace, surface, { reject: 'normalDot', originY, topY });
        continue;
      }

      if (topY < minTopY) {
        pushClimbTrace(trace, surface, { reject: 'minTopY', originY, topY });
        continue;
      }

      setVectorFromObject(climbSurfaceTangent, surface.tangent);
      setVectorFromObject(climbSurfaceUp, surface.up);

      climbSurfaceRelative.subVectors(position, climbSurfaceOrigin);
      const u = climbSurfaceRelative.dot(climbSurfaceTangent);
      const v = climbSurfaceRelative.dot(climbSurfaceUp);
      const clampedU = THREE.MathUtils.clamp(u, surface.minU + edgePadding, surface.maxU - edgePadding);
      const clampedV = THREE.MathUtils.clamp(v, surface.minV + verticalPadding, surface.maxV - verticalPadding);
      const edgeDistance = Math.abs(u - clampedU);
      const verticalDistance = Math.abs(v - clampedV);

      if (edgeDistance > maxEdgeDistance || verticalDistance > maxVerticalDistance) {
        pushClimbTrace(trace, surface, {
          reject: edgeDistance > maxEdgeDistance ? 'edgeDistance' : 'verticalDistance',
          originY,
          topY,
          edgeDist: edgeDistance,
          vertDist: verticalDistance,
        });
        continue;
      }

      climbSurfacePoint
        .copy(climbSurfaceOrigin)
        .addScaledVector(climbSurfaceTangent, clampedU)
        .addScaledVector(climbSurfaceUp, clampedV);

      const faceDistance = position.clone().sub(climbSurfacePoint).dot(climbSurfaceNormal);

      if (faceDistance < minFaceDistance || faceDistance > maxFaceDistance) {
        pushClimbTrace(trace, surface, {
          reject: faceDistance < minFaceDistance ? 'minFaceDistance' : 'maxFaceDistance',
          originY,
          topY,
          edgeDist: edgeDistance,
          vertDist: verticalDistance,
          faceDist: faceDistance,
        });
        continue;
      }

      const score = Math.abs(faceDistance - (surface.rootOffset ?? 0.38)) + edgeDistance + verticalDistance * 0.5;

      // A surface that clears every filter is a viable attach target; record it
      // (reject: null) even if it doesn't beat the current best, so the trace
      // shows all surfaces that passed, not just the winner.
      pushClimbTrace(trace, surface, {
        reject: null,
        originY,
        topY,
        edgeDist: edgeDistance,
        vertDist: verticalDistance,
        faceDist: faceDistance,
        score,
      });

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = {
          ...surface,
          origin: climbSurfaceOrigin.clone(),
          normal: climbSurfaceNormal.clone(),
          tangent: climbSurfaceTangent.clone(),
          up: climbSurfaceUp.clone(),
          point: climbSurfacePoint.clone(),
          u: clampedU,
          v: clampedV,
          faceDistance,
        };
      }
    }

    return bestCandidate;
  }

  findWallRunCandidate({
    position,
    velocity,
    maxFaceDistance = 0.82,
    minFaceDistance = -0.18,
    edgePadding = 0.22,
    verticalPadding = 0.34,
  }) {
    let bestCandidate = null;
    let bestScore = Infinity;

    for (const surface of this.level?.wallRunSurfaces ?? []) {
      setVectorFromObject(wallRunOrigin, surface.origin);
      setVectorFromObject(wallRunNormal, surface.normal);
      setVectorFromObject(wallRunTangent, surface.tangent);
      setVectorFromObject(wallRunUp, surface.up);

      wallRunRelative.copy(position).sub(wallRunOrigin);
      const faceDistance = wallRunRelative.dot(wallRunNormal);
      const u = wallRunRelative.dot(wallRunTangent);
      const v = wallRunRelative.dot(wallRunUp);

      if (
        faceDistance < minFaceDistance ||
        faceDistance > maxFaceDistance ||
        u < surface.minU - edgePadding ||
        u > surface.maxU + edgePadding ||
        v < surface.minV - verticalPadding ||
        v > surface.maxV + verticalPadding
      ) {
        continue;
      }

      wallRunVelocity.copy(velocity ?? ZERO_VECTOR).setY(0);
      const velocityLengthSq = wallRunVelocity.lengthSq();
      const normalizedVelocity = velocityLengthSq > 0.0001
        ? wallRunVelocity.normalize()
        : null;
      const intoWall = normalizedVelocity
        ? normalizedVelocity.dot(wallRunNormal) < -0.08
        : true;
      const alongWall = normalizedVelocity
        ? Math.abs(normalizedVelocity.dot(wallRunTangent)) > 0.16
        : true;

      if (!intoWall && !alongWall) {
        continue;
      }

      const edgeDistance = Math.min(Math.abs(u - surface.minU), Math.abs(surface.maxU - u));
      const score = Math.abs(faceDistance - (surface.rootOffset ?? 0.42)) + Math.abs(v - 1.35) * 0.15 - edgeDistance * 0.012;

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = {
          ...surface,
          origin: wallRunOrigin.clone(),
          normal: wallRunNormal.clone(),
          tangent: wallRunTangent.clone(),
          up: wallRunUp.clone(),
          u: THREE.MathUtils.clamp(u, surface.minU, surface.maxU),
          v: THREE.MathUtils.clamp(v, surface.minV, surface.maxV),
          faceDistance,
          alongWall,
          intoWall,
        };
      }
    }

    return bestCandidate;
  }

  findTopLedgeForClimbSurface({ surface, u, edgePadding = 0.28 } = {}) {
    if (!surface) {
      return null;
    }

    const surfaceTopPoint = climbSurfaceLedgePoint
      .copy(surface.origin)
      .addScaledVector(surface.tangent, u)
      .addScaledVector(surface.up, surface.maxV);
    let bestCandidate = null;
    let bestScore = Infinity;
    let bestOutwardPlane = -Infinity;
    const requireTargetLedge = Boolean(surface.targetLedgeName);
    const targetLedge = requireTargetLedge
      ? this.level?.ledges?.find((ledge) => ledge.name === surface.targetLedgeName)
      : null;

    for (const ledge of this.level?.ledges ?? []) {
      if (ledge.blockName !== surface.blockName || ledge.face !== surface.face) {
        continue;
      }

      if (
        requireTargetLedge &&
        ledge.name !== surface.targetLedgeName &&
        (
          !targetLedge ||
          !isSameLedgePlaneFamily(ledge, targetLedge) ||
          ledgeSpanOverlap(ledge, targetLedge) < 0.45
        )
      ) {
        continue;
      }

      climbSurfaceLedgeNormal.set(ledge.normal.x, ledge.normal.y, ledge.normal.z);
      climbSurfaceLedgeTangent.set(ledge.tangent.x, ledge.tangent.y, ledge.tangent.z);

      if (climbSurfaceLedgeNormal.dot(surface.normal) < 0.92) {
        continue;
      }

      const along = ledge.axis === 'x' ? surfaceTopPoint.x : surfaceTopPoint.z;
      const clampedAlong = THREE.MathUtils.clamp(along, ledge.min + edgePadding, ledge.max - edgePadding);
      const alongDistance = Math.abs(along - clampedAlong);

      if (alongDistance > 0.4) {
        continue;
      }

      const verticalDistance = Math.abs(surfaceTopPoint.y - ledge.y);

      if (verticalDistance > TOP_CLIMB_LEDGE_VERTICAL_TOLERANCE) {
        continue;
      }

      candidatePoint.set(
        ledge.axis === 'x' ? clampedAlong : ledge.x,
        ledge.y,
        ledge.axis === 'z' ? clampedAlong : ledge.z,
      );

      const faceDistance = surfaceTopPoint.clone().sub(candidatePoint).dot(climbSurfaceLedgeNormal);
      const planeDistance = Math.abs(faceDistance);

      if (planeDistance > TOP_CLIMB_LEDGE_PLANE_TOLERANCE) {
        continue;
      }

      const outwardPlane = ledgeOutwardPlaneValue(ledge);
      const score = alongDistance + verticalDistance * 0.55 + planeDistance * 0.12;

      if (outwardPlane > bestOutwardPlane + TOP_CLIMB_LEDGE_OUTWARD_MARGIN || (Math.abs(outwardPlane - bestOutwardPlane) <= TOP_CLIMB_LEDGE_OUTWARD_MARGIN && score < bestScore)) {
        bestOutwardPlane = outwardPlane;
        bestScore = score;
        bestCandidate = {
          ...ledge,
          point: candidatePoint.clone(),
          normal: climbSurfaceLedgeNormal.clone(),
          tangent: climbSurfaceLedgeTangent.clone(),
          along: clampedAlong,
          faceDistance,
        };
      }
    }

    return bestCandidate;
  }

  findLedgeCandidate({
    position,
    maxHorizontalDistance = 0.55,
    minFaceDistance = 0.02,
    minVerticalOffset = -1.45,
    maxVerticalOffset = 0.28,
    minTopHeight = 1.7,
  }) {
    let bestCandidate = null;
    let bestScore = Infinity;
    let bestOutwardPlane = -Infinity;

    for (const ledge of this.level?.ledges ?? []) {
      if (ledge.y < minTopHeight) {
        continue;
      }

      ledgeNormal.set(ledge.normal.x, ledge.normal.y, ledge.normal.z);
      ledgeTangent.set(ledge.tangent.x, ledge.tangent.y, ledge.tangent.z);

      const along = ledge.axis === 'x' ? position.x : position.z;
      const clampedAlong = THREE.MathUtils.clamp(along, ledge.min + 0.24, ledge.max - 0.24);
      const verticalOffset = position.y - ledge.y;

      if (verticalOffset < minVerticalOffset || verticalOffset > maxVerticalOffset) {
        continue;
      }

      candidatePoint.set(
        ledge.axis === 'x' ? clampedAlong : ledge.x,
        ledge.y,
        ledge.axis === 'z' ? clampedAlong : ledge.z,
      );

      const faceDistance = position.clone().sub(candidatePoint).dot(ledgeNormal);
      const alongDistance = Math.abs(along - clampedAlong);
      const reachableFace = faceDistance >= minFaceDistance && faceDistance <= maxHorizontalDistance;

      if (!reachableFace || alongDistance > 0.35) {
        continue;
      }

      const score = Math.abs(faceDistance - 0.2) + alongDistance + Math.abs(verticalOffset + 0.9) * 0.2;
      const outwardPlane = ledgeOutwardPlaneValue(ledge);

      if (shouldPreferLedgeCandidate({
        candidate: ledge,
        bestCandidate,
        outwardPlane,
        bestOutwardPlane,
        score,
        bestScore,
      })) {
        bestOutwardPlane = outwardPlane;
        bestScore = score;
        bestCandidate = {
          ...ledge,
          point: candidatePoint.clone(),
          normal: ledgeNormal.clone(),
          tangent: ledgeTangent.clone(),
          along: clampedAlong,
          faceDistance,
          verticalOffset,
        };
      }
    }

    return bestCandidate;
  }

  findTopLedgeCandidate({
    position,
    input,
    maxInsideDistance = 0.58,
    minInsideDistance = 0.04,
    maxVerticalDistance = 0.16,
    minInputApproach = 0.55,
    minTopHeight = 1.7,
  }) {
    let bestCandidate = null;
    let bestScore = Infinity;
    let bestOutwardPlane = -Infinity;

    ledgeInput.set(input.moveX, 0, input.moveZ);

    if (ledgeInput.lengthSq() <= 0.0001) {
      return null;
    }

    ledgeInput.normalize();

    for (const ledge of this.level?.ledges ?? []) {
      if (ledge.y < minTopHeight) {
        continue;
      }

      const verticalDistance = Math.abs(position.y - ledge.y);

      if (verticalDistance > maxVerticalDistance) {
        continue;
      }

      ledgeNormal.set(ledge.normal.x, ledge.normal.y, ledge.normal.z);
      ledgeTangent.set(ledge.tangent.x, ledge.tangent.y, ledge.tangent.z);

      const inputApproach = ledgeInput.dot(ledgeNormal);

      if (inputApproach < minInputApproach) {
        continue;
      }

      const along = ledge.axis === 'x' ? position.x : position.z;
      const clampedAlong = THREE.MathUtils.clamp(along, ledge.min + 0.35, ledge.max - 0.35);
      const alongDistance = Math.abs(along - clampedAlong);

      if (alongDistance > 0.25) {
        continue;
      }

      candidatePoint.set(
        ledge.axis === 'x' ? clampedAlong : ledge.x,
        ledge.y,
        ledge.axis === 'z' ? clampedAlong : ledge.z,
      );

      const faceDistance = position.clone().sub(candidatePoint).dot(ledgeNormal);
      const insideDistance = -faceDistance;

      if (insideDistance < minInsideDistance || insideDistance > maxInsideDistance) {
        continue;
      }

      const score = Math.abs(insideDistance - 0.24) + alongDistance + (1 - inputApproach) * 0.25;
      const outwardPlane = ledgeOutwardPlaneValue(ledge);

      if (shouldPreferLedgeCandidate({
        candidate: ledge,
        bestCandidate,
        outwardPlane,
        bestOutwardPlane,
        score,
        bestScore,
      })) {
        bestOutwardPlane = outwardPlane;
        bestScore = score;
        bestCandidate = {
          ...ledge,
          point: candidatePoint.clone(),
          normal: ledgeNormal.clone(),
          tangent: ledgeTangent.clone(),
          along: clampedAlong,
          faceDistance,
          insideDistance,
          inputApproach,
        };
      }
    }

    return bestCandidate;
  }

  findConnectedLedgeAtCorner({ ledge, direction, minTopHeight = 1.7 }) {
    if (!ledge || !Number.isFinite(direction) || direction === 0) {
      return null;
    }

    const cornerAlong = direction > 0 ? ledge.max : ledge.min;
    const sourcePoint = pointOnLedge({ ledge, along: cornerAlong, target: cornerPoint });

    cornerMoveDirection.set(
      ledge.axis === 'x' ? Math.sign(direction) : 0,
      0,
      ledge.axis === 'z' ? Math.sign(direction) : 0,
    );

    let bestCandidate = null;
    let bestScore = Infinity;

    for (const candidate of this.level?.ledges ?? []) {
      if (
        candidate === ledge ||
        candidate.name === ledge.name ||
        candidate.blockName !== ledge.blockName ||
        Math.abs(candidate.y - ledge.y) > 0.001 ||
        candidate.y < minTopHeight
      ) {
        continue;
      }

      const candidateAlong = candidate.axis === 'x' ? sourcePoint.x : sourcePoint.z;

      if (candidateAlong < candidate.min - 0.01 || candidateAlong > candidate.max + 0.01) {
        continue;
      }

      pointOnLedge({
        ledge: candidate,
        along: THREE.MathUtils.clamp(candidateAlong, candidate.min, candidate.max),
        target: cornerCandidatePoint,
      });

      if (cornerCandidatePoint.distanceToSquared(sourcePoint) > 0.0025) {
        continue;
      }

      cornerCandidateNormal.set(candidate.normal.x, candidate.normal.y, candidate.normal.z);
      const outwardAlignment = cornerMoveDirection.dot(cornerCandidateNormal);

      if (outwardAlignment < 0.55) {
        continue;
      }

      const score = 1 - outwardAlignment;

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = {
          ...candidate,
          point: cornerCandidatePoint.clone(),
          normal: cornerCandidateNormal.clone(),
          tangent: new THREE.Vector3(candidate.tangent.x, candidate.tangent.y, candidate.tangent.z),
          along: THREE.MathUtils.clamp(candidateAlong, candidate.min, candidate.max),
          cornerFrom: ledge.name,
        };
      }
    }

    return bestCandidate;
  }

  // Finds a higher ledge on the same wall (block + face + axis) within a vertical
  // reach window, used for the wall-ledge "hop up" when topping out is not
  // possible. Requires the higher ledge to share the wall plane and overlap the
  // current along position.
  findHopUpLedgeCandidate({
    position,
    fromLedge,
    minRise = 1.1,
    maxRise = 2.9,
    maxAlongDistance = 0.7,
    maxPlaneDistance = 1.25,
  }) {
    if (!fromLedge) {
      return null;
    }

    const fromFixed = fromLedge.axis === 'x' ? fromLedge.z : fromLedge.x;
    let bestCandidate = null;
    let bestScore = Infinity;

    for (const ledge of this.level?.ledges ?? []) {
      if (
        ledge === fromLedge ||
        ledge.name === fromLedge.name ||
        ledge.blockName !== fromLedge.blockName ||
        ledge.face !== fromLedge.face ||
        ledge.axis !== fromLedge.axis
      ) {
        continue;
      }

      const rise = ledge.y - fromLedge.y;

      if (rise < minRise || rise > maxRise) {
        continue;
      }

      const fixed = ledge.axis === 'x' ? ledge.z : ledge.x;

      if (Math.abs(fixed - fromFixed) > maxPlaneDistance) {
        continue;
      }

      const along = ledge.axis === 'x' ? position.x : position.z;
      const clampedAlong = THREE.MathUtils.clamp(along, ledge.min + 0.32, ledge.max - 0.32);
      const alongDistance = Math.abs(along - clampedAlong);

      if (alongDistance > maxAlongDistance) {
        continue;
      }

      const score = rise + alongDistance + Math.abs(fixed - fromFixed) * 0.5;

      if (score < bestScore) {
        bestScore = score;
        candidatePoint.set(
          ledge.axis === 'x' ? clampedAlong : ledge.x,
          ledge.y,
          ledge.axis === 'z' ? clampedAlong : ledge.z,
        );
        bestCandidate = {
          ...ledge,
          point: candidatePoint.clone(),
          normal: new THREE.Vector3(ledge.normal.x, ledge.normal.y, ledge.normal.z),
          tangent: new THREE.Vector3(ledge.tangent.x, ledge.tangent.y, ledge.tangent.z),
          along: clampedAlong,
        };
      }
    }

    return bestCandidate;
  }

  dispose() {
    if (!this.level) {
      return;
    }

    this.level.dispose();
    this.level.group.removeFromParent();
    this.level = null;
  }
}

function getCollisionDebugSnapshot(root) {
  return getDebugOverlaySnapshot(root, 'collision');
}

function getTraversalDebugSnapshot(root) {
  return getDebugOverlaySnapshot(root, 'traversal');
}

function getDebugOverlaySnapshot(root, type) {
  const snapshot = {
    overlays: 0,
    visible: false,
    lineSegments: 0,
    lineVertices: 0,
  };

  root?.traverse?.((object) => {
    if (object.userData?.debugOverlay === type && !object.isLineSegments) {
      snapshot.overlays += 1;
      snapshot.visible = object.visible === true;
    }

    if (object.isLineSegments && object.userData?.debugOverlay === type) {
      snapshot.lineSegments += 1;
      snapshot.lineVertices += object.geometry?.attributes?.position?.count ?? 0;
    }
  });

  return snapshot;
}

function findDebugOverlays(root) {
  const overlays = [];

  root?.traverse?.((object) => {
    if (!object.isLineSegments && object.userData?.debugOverlay === 'traversal') {
      overlays.push(object);
    }
  });

  return overlays;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function pointOnLedge({ ledge, along, target }) {
  return target.set(
    ledge.axis === 'x' ? along : ledge.x,
    ledge.y,
    ledge.axis === 'z' ? along : ledge.z,
  );
}

function ledgeOutwardPlaneValue(ledge) {
  const normalSign = ledge.axis === 'x'
    ? Math.sign(ledge.normal?.z ?? 0)
    : Math.sign(ledge.normal?.x ?? 0);
  const fixed = ledge.axis === 'x' ? ledge.z : ledge.x;
  return fixed * (normalSign || 1);
}

function shouldPreferLedgeCandidate({
  candidate,
  bestCandidate,
  outwardPlane,
  bestOutwardPlane,
  score,
  bestScore,
}) {
  if (!bestCandidate) {
    return true;
  }

  if (isSameLedgePlaneFamily(candidate, bestCandidate)) {
    if (outwardPlane > bestOutwardPlane + LEDGE_OUTER_SELECTION_MARGIN) {
      return true;
    }

    if (Math.abs(outwardPlane - bestOutwardPlane) <= LEDGE_OUTER_SELECTION_MARGIN) {
      return score < bestScore;
    }

    return false;
  }

  return score < bestScore;
}

function isSameLedgePlaneFamily(a, b) {
  return a.face === b.face &&
    a.axis === b.axis &&
    Math.abs((a.y ?? 0) - (b.y ?? 0)) <= LEDGE_OUTER_SELECTION_HEIGHT_TOLERANCE;
}

function ledgeSpanOverlap(a, b) {
  return Math.min(a.max ?? -Infinity, b.max ?? -Infinity) - Math.max(a.min ?? Infinity, b.min ?? Infinity);
}

function setVectorFromObject(target, source) {
  target.set(source.x, source.y, source.z);
  return target;
}

const CLIMB_TRACE_DEFAULTS = {
  reject: null,
  originY: null,
  topY: null,
  edgeDist: null,
  vertDist: null,
  faceDist: null,
  score: null,
};

// Records why a climb-surface candidate was accepted or rejected, for the
// traversal-router snapshot. No-ops unless the caller passes a trace array.
function pushClimbTrace(trace, surface, fields) {
  if (!trace) {
    return;
  }

  trace.push({
    name: surface.name ?? null,
    blockName: surface.blockName ?? null,
    face: surface.face ?? null,
    ...CLIMB_TRACE_DEFAULTS,
    ...fields,
  });
}

function accumulateHookAvoidanceHit({
  origin,
  direction,
  maxDistance,
  bodyRadius,
  lookaheadWeight = 1,
  raycast,
  onWall,
}) {
  const hits = raycast({
    origin,
    direction,
    near: 0.05,
    far: maxDistance,
    firstHitOnly: true,
  });

  if (!hits.length) {
    return;
  }

  const sample = buildHookAvoidanceSample({
    hit: hits[0],
    origin,
    bodyRadius,
    lookaheadWeight,
  });

  if (!sample) {
    return;
  }

  avoidRepulsion.add(avoidSampleRepulsion);
  avoidRepulsion.add(avoidSampleSkim);
  onWall?.(sample);
}

function measureHookSideGap({
  origin,
  direction,
  bodyRadius,
  raycast,
}) {
  const hits = raycast({
    origin,
    direction,
    near: 0.05,
    far: HOOK_AVOID_PROBE_RANGE,
    firstHitOnly: true,
  });

  if (!hits.length) {
    return Infinity;
  }

  const sample = buildHookAvoidanceSample({
    hit: hits[0],
    origin,
    bodyRadius,
    lookaheadWeight: 1,
  });

  if (!sample) {
    return Infinity;
  }

  return hits[0].distance - bodyRadius;
}

function buildHookAvoidanceSample({
  hit,
  origin,
  bodyRadius,
  lookaheadWeight,
}) {
  const mesh = hit.object;
  avoidSampleNormal.copy(hit.face?.normal ?? ZERO_VECTOR);

  if (mesh?.matrixWorld) {
    avoidSampleNormal.transformDirection(mesh.matrixWorld).normalize();
  }

  if (Math.abs(avoidSampleNormal.y) > 0.78) {
    return null;
  }

  avoidHitToPlayer.subVectors(origin, hit.point);
  if (avoidHitToPlayer.lengthSq() > 0.0001) {
    avoidHitToPlayer.normalize();
  } else {
    avoidHitToPlayer.copy(avoidSampleNormal);
  }

  if (avoidSampleNormal.dot(avoidHitToPlayer) < 0) {
    avoidSampleNormal.negate();
  }

  const gap = hit.distance - bodyRadius;
  const penetration = HOOK_AVOID_CLEARANCE - gap;

  let falloff = 0;
  if (penetration > 0) {
    falloff = THREE.MathUtils.clamp(penetration / HOOK_AVOID_CLEARANCE, 0, 1);
  } else {
    const proximity = HOOK_AVOID_PROBE_RANGE - gap;
    if (proximity <= 0.2) {
      return null;
    }
    falloff = THREE.MathUtils.clamp(proximity / HOOK_AVOID_PROBE_RANGE, 0, 1) * 0.42;
  }

  const strength = (falloff * falloff) * HOOK_AVOID_REPULSION * lookaheadWeight;

  avoidSampleRepulsion.copy(avoidSampleNormal).multiplyScalar(strength);

  avoidWallTangent.crossVectors(avoidSampleNormal, avoidWorldUp);
  if (avoidWallTangent.lengthSq() <= 1e-6) {
    avoidSampleSkim.set(0, 0, 0);
  } else {
    avoidWallTangent.normalize();
    if (avoidVelocityFlat.lengthSq() > 1 && avoidWallTangent.dot(avoidVelocityFlat) < 0) {
      avoidWallTangent.negate();
    }
    avoidSampleSkim.copy(avoidWallTangent).multiplyScalar(strength * HOOK_AVOID_SKIM * 0.012);
  }

  return {
    normal: avoidSampleNormal,
    penetration: Math.max(0, penetration),
  };
}

function buildHookSearchRays({ camera, origin, direction, playerPosition, coarse = false }) {
  const rays = [];
  let baseYaw = 0;

  if (camera) {
    camera.getWorldPosition(hookRayOrigin);
    camera.getWorldDirection(hookCameraForward);
    baseYaw = Math.atan2(hookCameraForward.x, hookCameraForward.z);

    rays.push({
      origin: hookRayOrigin.clone(),
      direction: hookCameraForward.clone().normalize(),
      weight: 1.5,
    });

    // Cursor preview: a sparse version of the full upward cone so it finds the
    // same high targets a real fire would, at a fraction of the ray count.
    if (coarse) {
      for (const pitch of HOOK_COARSE_PITCHES) {
        for (const dYaw of HOOK_COARSE_YAW_OFFSETS) {
          const yaw = baseYaw + dYaw;
          hookSearchDirection.set(
            Math.sin(yaw) * Math.cos(pitch),
            Math.sin(pitch),
            Math.cos(yaw) * Math.cos(pitch),
          );
          rays.push({
            origin: hookRayOrigin.clone(),
            direction: hookSearchDirection.clone().normalize(),
            weight: 1,
          });
        }
      }
      return rays;
    }
  } else if (origin && direction) {
    hookRayOrigin.copy(origin);
    baseYaw = Math.atan2(direction.x, direction.z);
  } else {
    hookRayOrigin.copy(playerPosition).add({ x: 0, y: 1.8, z: 0 });
  }

  for (let pitchIndex = 0; pitchIndex < HOOK_SEARCH_PITCHES.length; pitchIndex += 1) {
    const pitch = HOOK_SEARCH_PITCHES[pitchIndex];
    const pitchWeight = 1 + pitchIndex * 0.08;

    for (let yawIndex = 0; yawIndex < HOOK_SEARCH_YAW_OFFSETS.length; yawIndex += 1) {
      const yaw = baseYaw + HOOK_SEARCH_YAW_OFFSETS[yawIndex];
      hookSearchDirection.set(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      );

      rays.push({
        origin: hookRayOrigin.clone(),
        direction: hookSearchDirection.clone(),
        weight: pitchWeight,
      });
    }
  }

  return rays;
}

function raycastHookColliders({ origin, direction, near, far, colliderIndex, colliders }) {
  const hits = [];

  const test = (collider) => {
    const height = (collider?.topY ?? 0) - (collider?.bottomY ?? 0);
    if (
      !Number.isFinite(collider?.minX) ||
      !Number.isFinite(collider?.maxX) ||
      !Number.isFinite(collider?.minZ) ||
      !Number.isFinite(collider?.maxZ) ||
      !Number.isFinite(collider?.topY) ||
      !Number.isFinite(collider?.bottomY) ||
      height < 2
    ) {
      return;
    }

    const hit = intersectRayAabbCollider({ origin, direction, near, far, collider });
    if (hit) {
      hits.push(hit);
    }
  };

  // Prefer the spatial index (city): visit only cells overlapping the ray's XZ
  // footprint instead of every collider. Fall back to the flat array for levels
  // without an index (wilds/world).
  if (colliderIndex) {
    colliderIndex.forEachInRaySegmentXZ(origin.x, origin.z, direction.x, direction.z, far, test);
  } else {
    for (const collider of colliders ?? []) {
      test(collider);
    }
  }

  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

function intersectRayAabbCollider({ origin, direction, near, far, collider }) {
  let tMin = -Infinity;
  let tMax = Infinity;
  let entryAxis = null;
  let entrySign = 0;
  let exitAxis = null;
  let exitSign = 0;

  const x = intersectRayAabbAxis(origin.x, direction.x, collider.minX, collider.maxX);
  if (!x) return null;
  if (x.tNear > tMin) {
    tMin = x.tNear;
    entryAxis = 'x';
    entrySign = x.nearSign;
  }
  if (x.tFar < tMax) {
    tMax = x.tFar;
    exitAxis = 'x';
    exitSign = x.farSign;
  }

  const y = intersectRayAabbAxis(origin.y, direction.y, collider.bottomY, collider.topY);
  if (!y) return null;
  if (y.tNear > tMin) {
    tMin = y.tNear;
    entryAxis = 'y';
    entrySign = y.nearSign;
  }
  if (y.tFar < tMax) {
    tMax = y.tFar;
    exitAxis = 'y';
    exitSign = y.farSign;
  }

  const z = intersectRayAabbAxis(origin.z, direction.z, collider.minZ, collider.maxZ);
  if (!z) return null;
  if (z.tNear > tMin) {
    tMin = z.tNear;
    entryAxis = 'z';
    entrySign = z.nearSign;
  }
  if (z.tFar < tMax) {
    tMax = z.tFar;
    exitAxis = 'z';
    exitSign = z.farSign;
  }

  if (tMax < tMin) {
    return null;
  }

  const distance = tMin >= near ? tMin : tMax;
  if (distance < near || distance > far) {
    return null;
  }

  const axis = tMin >= near ? entryAxis : exitAxis;
  const sign = tMin >= near ? entrySign : exitSign;
  setAxisNormal(hookColliderHitNormal, axis, sign);

  hookColliderHitPoint.copy(origin).addScaledVector(direction, distance);

  return {
    distance,
    point: hookColliderHitPoint.clone(),
    face: { normal: hookColliderHitNormal.clone() },
    object: { name: collider.name ?? null },
  };
}

function intersectRayAabbAxis(originValue, directionValue, minValue, maxValue) {
  const epsilon = 1e-8;
  if (Math.abs(directionValue) < epsilon) {
    return originValue >= minValue && originValue <= maxValue
      ? { tNear: -Infinity, tFar: Infinity, nearSign: 0, farSign: 0 }
      : null;
  }

  const inv = 1 / directionValue;
  let tNear = (minValue - originValue) * inv;
  let tFar = (maxValue - originValue) * inv;
  let nearSign = -1;
  let farSign = 1;

  if (tNear > tFar) {
    const tmpT = tNear;
    tNear = tFar;
    tFar = tmpT;
    nearSign = 1;
    farSign = -1;
  }

  return { tNear, tFar, nearSign, farSign };
}

function setAxisNormal(target, axis, sign) {
  target.set(0, 0, 0);
  if (axis === 'x') {
    target.x = sign;
  } else if (axis === 'y') {
    target.y = sign;
  } else if (axis === 'z') {
    target.z = sign;
  }
  return target;
}

function scoreHookHit({
  hit,
  rayDirection,
  rayWeight,
  playerPosition,
  playerFeetY,
  minHeightAbovePlayer,
  minGroundHeight,
  getGroundHeightAt,
}) {
  const mesh = hit.object;
  hookWorldNormal.copy(hit.face?.normal ?? ZERO_VECTOR);

  if (mesh?.matrixWorld) {
    hookWorldNormal.transformDirection(mesh.matrixWorld).normalize();
  }

  hookToPlayer.subVectors(playerPosition, hit.point);
  if (hookToPlayer.lengthSq() > 0.0001) {
    hookToPlayer.normalize();
  } else {
    hookToPlayer.copy(rayDirection).negate();
  }

  let facesPlayer = hookWorldNormal.dot(hookToPlayer);
  if (facesPlayer < 0) {
    hookWorldNormal.negate();
    facesPlayer = -facesPlayer;
  }

  if (facesPlayer < 0.08) {
    return null;
  }

  const verticalness = Math.abs(hookWorldNormal.y);
  if (verticalness > 0.88) {
    return null;
  }

  const groundY = getGroundHeightAt(hit.point, 0.6);
  if (hit.point.y - groundY < minGroundHeight) {
    return null;
  }

  const heightAbovePlayer = hit.point.y - playerFeetY;
  if (heightAbovePlayer < minHeightAbovePlayer) {
    return null;
  }

  const horizontalDist = Math.hypot(
    hit.point.x - playerPosition.x,
    hit.point.z - playerPosition.z,
  );
  const steepness = heightAbovePlayer / Math.max(horizontalDist, 1.5);

  hookAttachPosition.copy(hit.point).addScaledVector(hookWorldNormal, 0.14);

  const score =
    heightAbovePlayer * 4.2 +
    steepness * 14 +
    facesPlayer * 2.5 +
    rayWeight * 1.5 -
    hit.distance * 0.025;

  return {
    score,
    position: hookAttachPosition.clone(),
    normal: hookWorldNormal.clone(),
    distance: hit.distance,
    meshName: mesh?.name ?? null,
    point: hit.point.clone(),
    heightAbovePlayer,
  };
}
