import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { flattenGeometryForWebGPU } from '../geometry/prepareWebGPUGeometry.js';
import { createRallySpectatorGeometry } from './rallySpectatorGeometry.js';

/** Optimized crowd1 FBX + gesture pack, built by scripts/build-crowd-glb.py. */
export const CROWD_MODEL_URL = '/assets/models/crowd.glb';

export const STATIC_CROWD_MODELS = [
  { name: 'Jacket Man', url: '/assets/models/crowd-static/man-with-jacket.glb' },
  { name: 'Photographer', url: '/assets/models/crowd-static/photographer.glb' },
  { name: 'Winter Coat Woman', url: '/assets/models/crowd-static/woman-winter-coat.glb' },
];
export const STATIC_CROWD_AGENT_RATIO = 0.38;
export const STATIC_CROWD_TURN_SPEED = 2.4;

/** Full build-time clip contract. Runtime can bake a focused subset below. */
export const CROWD_ASSET_CLIPS = [
  'Cheering',
  'Acknowledging',
  'Angry Gesture',
  'Annoyed Head Shake',
  'Being Cocky',
  'Dismissing Gesture',
  'Happy Hand Gesture',
  'Hard Head Nod',
  'Head Nod Yes',
  'Lengthy Head Nod',
  'Look Away Gesture',
  'Looking',
  'Relieved Sigh',
  'Sarcastic Head Nod',
  'Shaking Head No',
  'Stand To Roll',
  'Thoughtful Head Shake',
  'Weight Shift',
];

/** Logical clip names baked into flipbook frames (maps to GLB clip names). */
export const CROWD_CLIP_DEFINITIONS = [
  { name: 'StandIdle', sourceClip: 'Weight Shift', samples: 10, speed: 0.22, weight: 1 },
  { name: 'Cheer', sourceClip: 'Cheering', samples: 8, speed: 0.85, weight: 1 },
  { name: 'Acknowledge', sourceClip: 'Acknowledging', samples: 6, speed: 0.85, weight: 1 },
  { name: 'Cocky', sourceClip: 'Being Cocky', samples: 6, speed: 0.75, weight: 1 },
  { name: 'Angry', sourceClip: 'Angry Gesture', samples: 6, speed: 0.8, weight: 1 },
  { name: 'HeadNod', sourceClip: 'Head Nod Yes', samples: 6, speed: 0.85, weight: 1 },
  { name: 'HeadShake', sourceClip: 'Shaking Head No', samples: 6, speed: 0.85, weight: 1 },
];

export const CROWD_REACTION_CLIPS = CROWD_CLIP_DEFINITIONS
  .filter((clip) => clip.name !== 'StandIdle')
  .map((clip) => clip.name);

export const CROWD_LOD_TIERS = [
  { maxDistanceSq: 35 * 35, updateInterval: 1 / 30, frameDivisor: 1 },
  { maxDistanceSq: 90 * 90, updateInterval: 1 / 16, frameDivisor: 2 },
  { maxDistanceSq: 240 * 240, updateInterval: 1 / 8, frameDivisor: 4 },
];

export const CROWD_HARD_CULL_DISTANCE_SQ = 240 * 240;
/** Full flipbook draws only within this range; farther agents use static box imposters. */
export const CROWD_ANIMATED_MAX_DISTANCE_SQ = 90 * 90;
/** Single-pass weld tolerance after the decimated crowd pose bake. */
export const CROWD_MERGE_TOLERANCE = 0.01;
export const CROWD_BAKE_YIELD_EVERY = 2;
export const CROWD_PIPELINE_WARMUP_FRAMES = 3;
export const CROWD_PIPELINE_WARMUP_BATCH_SIZE = 6;
/** Hard cap on detailed flipbook agents; farther spectators use box imposters. */
export const CROWD_MAX_FLIPBOOK_AGENTS = 72;
export const CROWD_SECTION_VEHICLE_RADIUS = 25;
export const CROWD_CHEER_SPEED_THRESHOLD = 15;
export const FRUSTUM_KEEP_ALIVE_DOT = -0.2;
/** Match static box crowd stature; slightly taller for trackside readability. */
export const CROWD_TARGET_HEIGHT = 2.05;
export const CROWD_DISPLAY_SCALE = 1;
export const CROWD_AMBIENT_REACTION_CHANCE = 0.35;
export const CROWD_NEAR_RANGE_SQ = 60 * 60;
export const MAX_AGENT_STEP_SECONDS = 0.1;

const DENSITY_BY_QUALITY = {
  low: 0,
  high: 0.35,
  ultra: 1.0,
};

const tempVector = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();
const tempEuler = new THREE.Euler();
const tempScale = new THREE.Vector3();
const tempMatrix = new THREE.Matrix4();
const collapsedInstanceMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

function yieldToMainThread() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function weldBakedCrowdGeometry(geometry, mergeTolerance = CROWD_MERGE_TOLERANCE) {
  const welded = mergeVertices(geometry, mergeTolerance);
  if (welded !== geometry) geometry.dispose();
  flattenGeometryForWebGPU(welded);
  return welded;
}

/**
 * Bake a posed skinned mesh while keeping its index buffer (~59k verts, not 265k
 * triangle-soup duplicates). The expanded bake path creates overlapping shards.
 */
export function bakeCrowdSkinnedGeometry(root) {
  root.updateMatrixWorld(true);

  let geometry = null;
  let material = null;

  root.traverse((child) => {
    if (!child.isSkinnedMesh || !child.geometry || geometry) return;

    const source = child.geometry;
    const positionAttr = source.getAttribute('position');
    if (!positionAttr) return;

    child.skeleton?.update?.();
    material = getPrimaryMaterial(child.material);

    const vertexCount = positionAttr.count;
    const positions = new Float32Array(vertexCount * 3);
    const uvAttr = source.getAttribute('uv');
    const uvs = uvAttr ? new Float32Array(vertexCount * 2) : null;

    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      tempVector.fromBufferAttribute(positionAttr, vertexIndex);
      if (typeof child.applyBoneTransform === 'function') {
        child.applyBoneTransform(vertexIndex, tempVector);
      }
      tempVector.applyMatrix4(child.matrixWorld);
      positions[vertexIndex * 3] = tempVector.x;
      positions[vertexIndex * 3 + 1] = tempVector.y;
      positions[vertexIndex * 3 + 2] = tempVector.z;
      if (uvs && uvAttr) {
        uvs[vertexIndex * 2] = uvAttr.getX(vertexIndex);
        uvs[vertexIndex * 2 + 1] = uvAttr.getY(vertexIndex);
      }
    }

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (source.index) {
      geometry.setIndex(source.index.clone());
    }
  });

  if (!geometry) return null;

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, material, vertexCount: geometry.getAttribute('position').count };
}

/**
 * @param {import('./rallyCrowdPlacements.js').collectRallyCrowdPlacements extends Function ? ReturnType<import('./rallyCrowdPlacements.js').collectRallyCrowdPlacements> : never} placements
 */
export function filterPlacementsByQuality(placements, quality, maxAgents = Infinity) {
  const density = DENSITY_BY_QUALITY[quality] ?? DENSITY_BY_QUALITY.high;
  const filtered = placements.filter((p) => p.occupancySeed <= density);
  const chosen = filtered.length > 0 ? filtered : placements.slice(0, Math.min(12, placements.length));
  return chosen.slice(0, maxAgents);
}

export function getLodTier(distanceSq, tiers = CROWD_LOD_TIERS) {
  for (const tier of tiers) {
    if (distanceSq <= tier.maxDistanceSq) return tier;
  }
  return tiers[tiers.length - 1];
}

export function getQualityLodIntervalMultiplier(quality) {
  return quality === 'high' ? 1.5 : 1.0;
}

export function nextIdleDuration() {
  return 3.5 + Math.random() * 6;
}

export function chooseAmbientReaction() {
  return CROWD_REACTION_CLIPS[Math.floor(Math.random() * CROWD_REACTION_CLIPS.length)] ?? 'Cheer';
}

function isRootTranslationTrack(trackName) {
  const name = trackName.toLowerCase();
  return (
    name === 'root.position' ||
    name === 'hips.position' ||
    name === 'mixamorig:hips.position' ||
    name === 'mixamorighips.position' ||
    name.endsWith('/root.position') ||
    name.endsWith('/hips.position')
  );
}

export function lockRootTranslation(clip) {
  const filteredTracks = clip.tracks.filter((track) => !isRootTranslationTrack(track.name));
  if (filteredTracks.length === clip.tracks.length) {
    return clip;
  }
  const lockedClip = new THREE.AnimationClip(clip.name, clip.duration, filteredTracks);
  lockedClip.blendMode = clip.blendMode;
  lockedClip.userData = { ...(clip.userData ?? {}), rootTranslationLocked: true };
  return lockedClip;
}

/**
 * Advance one agent's state machine. Returns true when the baked frame index
 * should be recomputed.
 */
export function advanceAgent(agent, deltaSeconds, updateInterval, clipDefs = CROWD_CLIP_DEFINITIONS) {
  agent.lodTimeAccumulator += deltaSeconds;
  if (agent.lodTimeAccumulator < updateInterval) {
    return false;
  }

  const steppedDelta = Math.min(agent.lodTimeAccumulator, MAX_AGENT_STEP_SECONDS);
  agent.lodTimeAccumulator = 0;
  agent.stateTime += steppedDelta;
  agent.phase += steppedDelta * agent.speed;

  if (agent.clipName === 'StandIdle') {
    agent.phase %= 1;
    if (agent.queuedReaction) {
      const reaction = clipDefs.find((c) => c.name === agent.queuedReaction) ?? clipDefs[0];
      agent.clipName = reaction.name;
      agent.speed = (agent.playbackSpeeds?.[reaction.name] ?? reaction.speed) * (0.95 + Math.random() * 0.1);
      agent.phase = 0;
      agent.stateTime = 0;
      agent.stateDuration = 1;
      agent.queuedReaction = null;
    } else if (agent.stateTime >= agent.stateDuration) {
      agent.stateTime = 0;
      agent.stateDuration = nextIdleDuration();
      if (Math.random() < CROWD_AMBIENT_REACTION_CHANCE) {
        const reactionName = chooseAmbientReaction();
        const reaction = clipDefs.find((c) => c.name === reactionName) ?? clipDefs[0];
        agent.clipName = reaction.name;
        agent.speed = (agent.playbackSpeeds?.[reaction.name] ?? reaction.speed) * (0.95 + Math.random() * 0.1);
        agent.phase = 0;
      }
    }
    return true;
  }

  if (agent.phase >= 1) {
    const idle = clipDefs.find((c) => c.name === 'StandIdle') ?? clipDefs[0];
    agent.clipName = idle.name;
    agent.speed = (agent.playbackSpeeds?.[idle.name] ?? idle.speed) * (0.9 + Math.random() * 0.2);
    agent.phase = Math.random();
    agent.stateTime = 0;
    agent.stateDuration = nextIdleDuration();
  }

  return true;
}

export function computeAgentFrameIndex(agent, frameCount, lodTier) {
  const normalizedPhase = agent.clipName === 'StandIdle'
    ? agent.phase % 1
    : Math.min(agent.phase, 0.999);
  const effectiveFrameCount = Math.max(1, Math.ceil(frameCount / lodTier.frameDivisor));
  const lodFrameIndex = Math.min(
    Math.floor(normalizedPhase * effectiveFrameCount),
    effectiveFrameCount - 1,
  );
  return Math.min(lodFrameIndex * lodTier.frameDivisor, frameCount - 1);
}

export function queueReactionBurst(agents, clipName, probability) {
  for (const agent of agents) {
    if (agent.clipName !== 'StandIdle') continue;
    if (Math.random() < probability) {
      agent.queuedReaction = clipName;
      agent.stateDuration = Math.min(agent.stateDuration, 0.15 + Math.random() * 0.4);
    }
  }
}

/** Reserve the expensive baked-GLB slots for the closest eligible agents. */
export function selectNearestAnimatedAgents(
  agents,
  cameraPosition,
  maxDistanceSq = CROWD_ANIMATED_MAX_DISTANCE_SQ,
  maxAgents = CROWD_MAX_FLIPBOOK_AGENTS,
) {
  return new Set(agents
    .map((agent) => ({
      agent,
      distanceSq: agent.position.distanceToSquared(cameraPosition),
    }))
    .filter((entry) => entry.distanceSq <= maxDistanceSq)
    .sort((a, b) => a.distanceSq - b.distanceSq)
    .slice(0, maxAgents)
    .map((entry) => entry.agent));
}

export function chooseStaticCrowdVariant(
  variantSeed,
  modelCount = STATIC_CROWD_MODELS.length,
  ratio = STATIC_CROWD_AGENT_RATIO,
) {
  if (modelCount <= 0 || variantSeed >= ratio) return -1;
  return Math.min(modelCount - 1, Math.floor((variantSeed / ratio) * modelCount));
}

export function turnYawToward(currentYaw, targetYaw, deltaSeconds, turnSpeed = STATIC_CROWD_TURN_SPEED) {
  const difference = Math.atan2(
    Math.sin(targetYaw - currentYaw),
    Math.cos(targetYaw - currentYaw),
  );
  return currentYaw + difference * Math.min(1, Math.max(0, deltaSeconds) * turnSpeed);
}

export function rebuildCrowdSections(placements) {
  const sections = new Map();
  const grouped = new Map();
  for (const placement of placements) {
    const bucket = grouped.get(placement.sectionId) ?? [];
    bucket.push(placement);
    grouped.set(placement.sectionId, bucket);
  }
  for (const [sectionId, positions] of grouped) {
    const box = new THREE.Box3();
    for (const placement of positions) {
      box.expandByPoint(tempVector.set(placement.x, placement.y, placement.z));
    }
    box.min.addScalar(-1.2);
    box.max.addScalar(1.2);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sections.set(sectionId, { id: sectionId, sphere, center: sphere.center.clone() });
  }
  return sections;
}

function getPrimaryMaterial(material) {
  if (Array.isArray(material)) {
    return material.find(Boolean) ?? material[0] ?? null;
  }
  return material ?? null;
}

/**
 * Three r185's WebGPU Instance node captures mesh.count while building each
 * render pipeline and uses that value as the matrix binding length. A frame
 * mesh may first contain only one agent and later contain many, which makes
 * the extra instance indices read out of bounds and disappear.
 *
 * Prime the first render with the full capacity (unused entries are collapsed),
 * then restore the actual draw count after all synchronous render passes have
 * built their pipelines. Subsequent draws can safely vary from 0..capacity.
 */
export function initializeCrowdInstanceStream(mesh, capacity = mesh.instanceMatrix.count) {
  for (let instanceIndex = 0; instanceIndex < capacity; instanceIndex += 1) {
    mesh.setMatrixAt(instanceIndex, collapsedInstanceMatrix);
  }
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.crowdInstanceCapacity = capacity;
  mesh.userData.crowdPipelinePrimed = false;
  mesh.onBeforeRender = function primeCrowdInstancePipeline() {
    if (this.userData.crowdPipelinePrimed) return;
    const drawCount = this.count;
    this.count = capacity;
    this.userData.crowdPipelinePrimed = true;
    queueMicrotask(() => {
      this.count = drawCount;
    });
  };
  return mesh;
}

/**
 * Reset one primed instance stream so the next render rebuilds its pipeline
 * binding at full capacity. WebGPU captures mesh.count into the instance
 * binding when a render pipeline is built, so any later rebuild (weather/env
 * change → RendererSystem.invalidatePipeline, scene-fog toggle, resize)
 * re-captures whatever small per-frame count the mesh happens to have and the
 * extra instances flicker out. Re-collapsing every slot first keeps the one
 * prime render ghost-free (stale matrices from earlier frames would otherwise
 * paint at the bumped capacity).
 */
export function markCrowdMeshPipelineDirty(mesh) {
  if (!mesh?.userData) return;
  const capacity = mesh.userData.crowdInstanceCapacity ?? mesh.instanceMatrix?.count ?? 0;
  for (let instanceIndex = 0; instanceIndex < capacity; instanceIndex += 1) {
    mesh.setMatrixAt(instanceIndex, collapsedInstanceMatrix);
  }
  if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.crowdPipelinePrimed = false;
}

/**
 * Baked flipbook poses have sparse temporal normal samples. PBR lighting makes
 * those changing normals flash between dark/grey and textured frames, so use
 * the same stable unlit texture path as the 3js-rocks crowd implementation.
 */
export function createCrowdMaterial(material) {
  const source = getPrimaryMaterial(material);
  const crowdMaterial = new THREE.MeshBasicMaterial({
    name: `${source?.name || 'Crowd'}_flat`,
    map: source?.map ?? null,
    color: source?.color?.clone?.() ?? new THREE.Color(0xd8d2c3),
    transparent: false,
    opacity: 1,
    alphaMap: null,
    alphaTest: 0,
    depthWrite: true,
    side: THREE.FrontSide,
    toneMapped: true,
  });
  if (crowdMaterial.map) crowdMaterial.map.colorSpace = THREE.SRGBColorSpace;
  return crowdMaterial;
}

/**
 * Scale + foot offset that maps a standing-pose bake to targetHeight with feet at y=0.
 * Must be computed ONCE (from the standing pose) and shared across all flipbook
 * frames: raised-arm poses have taller bounds, so per-frame normalization
 * shrinks the body whenever arms go up.
 */
export function computeCrowdNormalization(geometry, targetHeight = CROWD_TARGET_HEIGHT) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const sizeY = box.max.y - box.min.y;
  if (!Number.isFinite(sizeY) || sizeY <= 1e-5) return null;
  return { scale: targetHeight / sizeY, minY: box.min.y };
}

/** Feet at y=0, height = targetHeight — same contract as static box spectators. */
export function normalizeBakedCrowdGeometry(geometry, targetHeight = CROWD_TARGET_HEIGHT, normalization = null) {
  const transform = normalization ?? computeCrowdNormalization(geometry, targetHeight);
  if (!transform) {
    return { height: 0, minY: 0, maxY: 0 };
  }

  const { scale } = transform;
  if (transform.groundEachFrame) geometry.computeBoundingBox();
  const minY = transform.groundEachFrame ? geometry.boundingBox.min.y : transform.minY;
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i += 1) {
    position.setXYZ(
      i,
      position.getX(i) * scale,
      (position.getY(i) - minY) * scale,
      position.getZ(i) * scale,
    );
  }
  position.needsUpdate = true;
  if (geometry.hasAttribute('skinIndex')) geometry.deleteAttribute('skinIndex');
  if (geometry.hasAttribute('skinWeight')) geometry.deleteAttribute('skinWeight');
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return {
    height: geometry.boundingBox.max.y - geometry.boundingBox.min.y,
    minY: geometry.boundingBox.min.y,
    maxY: geometry.boundingBox.max.y,
  };
}

/**
 * Weld the expanded bake once. Never loop mergeVertices — each pass on ~265k
 * verts costs ~200ms and was freezing the tab during flipbook load.
 */
export function simplifyCrowdBakedGeometry(
  geometry,
  _targetVertices,
  mergeTolerance = CROWD_MERGE_TOLERANCE,
) {
  const simplified = weldBakedCrowdGeometry(geometry, mergeTolerance);
  simplified.computeVertexNormals();
  simplified.computeBoundingBox();
  simplified.computeBoundingSphere();
  return simplified;
}

function bakePosedCrowdGeometry(crowdRoot, normalization) {
  const baked = bakeCrowdSkinnedGeometry(crowdRoot);
  if (!baked?.geometry) {
    throw new Error('Failed to bake crowd pose');
  }
  const welded = weldBakedCrowdGeometry(baked.geometry);
  normalizeBakedCrowdGeometry(welded, CROWD_TARGET_HEIGHT, normalization);
  welded.computeVertexNormals();
  welded.computeBoundingSphere();
  return {
    geometry: welded,
    bounds: {
      height: welded.boundingBox.max.y - welded.boundingBox.min.y,
      minY: welded.boundingBox.min.y,
      maxY: welded.boundingBox.max.y,
    },
  };
}

function bakeStaticCrowdGeometry(root) {
  root.updateMatrixWorld(true);
  let sourceMesh = null;
  root.traverse((child) => {
    if (!sourceMesh && child.isMesh && child.geometry) sourceMesh = child;
  });
  if (!sourceMesh) throw new Error('Static crowd model has no Mesh');

  const geometry = sourceMesh.geometry.clone();
  geometry.applyMatrix4(sourceMesh.matrixWorld);
  normalizeBakedCrowdGeometry(geometry, CROWD_TARGET_HEIGHT);
  flattenGeometryForWebGPU(geometry);
  return {
    geometry,
    material: createCrowdMaterial(sourceMesh.material),
  };
}

function populateAgents(placements, quality, maxAgents, playbackSpeeds) {
  const filtered = filterPlacementsByQuality(placements, quality, maxAgents);
  const idle = CROWD_CLIP_DEFINITIONS.find((c) => c.name === 'StandIdle') ?? CROWD_CLIP_DEFINITIONS[0];
  const agents = [];
  const idleSpeed = playbackSpeeds?.StandIdle ?? idle.speed;

  for (const placement of filtered) {
    const rotationJitter = (Math.random() - 0.5) * 0.35;
    const scale = CROWD_DISPLAY_SCALE * placement.scale * (0.94 + Math.random() * 0.12);
    const yaw = placement.yaw + rotationJitter;
    const staticVariantIndex = chooseStaticCrowdVariant(placement.variantSeed ?? 1);
    tempEuler.set(0, yaw, 0);
    tempQuaternion.setFromEuler(tempEuler);
    tempScale.setScalar(scale);
    tempMatrix.compose(
      tempVector.set(placement.x, placement.y, placement.z),
      tempQuaternion,
      tempScale,
    );

    agents.push({
      clipName: idle.name,
      phase: Math.random(),
      speed: idleSpeed * (0.9 + Math.random() * 0.15),
      playbackSpeeds,
      matrix: tempMatrix.clone(),
      position: tempVector.clone(),
      scale,
      baseYaw: yaw,
      yaw,
      staticVariantIndex,
      stateTime: 0,
      stateDuration: nextIdleDuration(),
      queuedReaction: null,
      lodTimeAccumulator: Math.random() * 0.05,
      sectionId: placement.sectionId,
      currentFrameIndex: -1,
    });
  }

  return { agents, filteredPlacements: filtered };
}

/**
 * Mixed rally sideline crowd — frame-baked animation plus static GLB variants.
 *
 * @param {{ placements: object[], quality?: string, modelUrl?: string, maxAgents?: number }} options
 */
export function createSpectatorCrowd({
  placements = [],
  quality = 'ultra',
  modelUrl = CROWD_MODEL_URL,
  maxAgents = 520,
} = {}) {
  const group = new THREE.Group();
  group.name = 'SpectatorCrowd';
  group.userData.noCollision = true;

  let status = 'idle';
  let error = null;
  let loaded = false;
  let agents = [];
  let sections = new Map();
  let sourceMeshes = [];
  let staticSourceMeshes = [];
  const frameCounts = new Map();
  const playbackSpeeds = {};
  let activeVehicleSectionId = null;
  let previousVehicleSectionId = null;
  const lodIntervalMultiplier = getQualityLodIntervalMultiplier(quality);

  let bakedSampleHeight = 0;
  let bakedVertexCount = 0;
  let bakedFrameProgress = 0;
  let bakedFrameTotal = CROWD_CLIP_DEFINITIONS.reduce((sum, clip) => sum + clip.samples, 0);
  let imposterMesh = null;
  let pipelineWarmupFramesRemaining = 0;
  let pipelineWarmupMeshes = [];
  let pipelineWarmupBatchStart = 0;
  const activeFlipbookMeshes = new Set();
  let lastDrawStats = {
    drawnAgents: 0,
    culledAgents: 0,
    imposterAgents: 0,
    flipbookAgents: 0,
    staticAgents: 0,
    flipbookCap: CROWD_MAX_FLIPBOOK_AGENTS,
    nearAgents: 0,
    reactingAgents: 0,
    nearestAgentM: null,
  };

  const snapshotBase = () => ({
    status,
    quality,
    loaded,
    agentCount: agents.length,
    placementCount: placements.length,
    bakedSampleHeight,
    bakedVertexCount,
    bakedFrameProgress,
    bakedFrameTotal,
    pipelineWarmupFramesRemaining,
    pipelineWarmupMeshesRemaining: Math.max(0, pipelineWarmupMeshes.length - pipelineWarmupBatchStart),
    animatedMaxDistanceM: Math.sqrt(CROWD_ANIMATED_MAX_DISTANCE_SQ),
    ...lastDrawStats,
    activeMeshes: sourceMeshes.reduce((sum, sm) => sum + sm.instancedFrames.filter((f) => f.mesh.visible).length, 0)
      + staticSourceMeshes.filter((source) => source.mesh?.visible).length,
    frameDraws: sourceMeshes.reduce((sum, sm) => sum + sm.instancedFrames.filter((f) => f.mesh.count > 0).length, 0)
      + staticSourceMeshes.filter((source) => (source.mesh?.count ?? 0) > 0).length,
    instanceTotal: lastDrawStats.drawnAgents,
    error: error ? String(error.message || error) : null,
  });

  function createInstancedFrames() {
    const frameCapacity = Math.min(maxAgents, CROWD_MAX_FLIPBOOK_AGENTS);
    for (const sourceMesh of sourceMeshes) {
      for (const clipDefinition of CROWD_CLIP_DEFINITIONS) {
        const frames = sourceMesh.frames.get(clipDefinition.name);
        if (!frames) continue;

        const lookup = [];
        frames.forEach((geometry, frameIndex) => {
          const mesh = new THREE.InstancedMesh(geometry, sourceMesh.material, frameCapacity);
          initializeCrowdInstanceStream(mesh, frameCapacity);
          mesh.name = `SpectatorCrowd ${clipDefinition.name} f${frameIndex}`;
          mesh.userData.skipLevelRaycast = true;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.frustumCulled = false;
          mesh.count = 0;
          mesh.visible = false;
          group.add(mesh);
          const entry = { clipName: clipDefinition.name, frameIndex, mesh };
          sourceMesh.instancedFrames.push(entry);
          lookup[frameIndex] = mesh;
        });
        sourceMesh.frameLookup.set(clipDefinition.name, lookup);
      }
    }
  }

  async function loadStaticSourceModels() {
    staticSourceMeshes = await Promise.all(STATIC_CROWD_MODELS.map(async (definition) => {
      const gltf = await createGltfLoader().loadAsync(encodeURI(definition.url));
      const baked = bakeStaticCrowdGeometry(gltf.scene);
      return {
        ...definition,
        ...baked,
        mesh: null,
      };
    }));
  }

  function createStaticInstances() {
    staticSourceMeshes.forEach((source, variantIndex) => {
      const capacity = agents.filter((agent) => agent.staticVariantIndex === variantIndex).length;
      if (capacity === 0) return;
      const mesh = new THREE.InstancedMesh(source.geometry, source.material, capacity);
      initializeCrowdInstanceStream(mesh, capacity);
      mesh.name = `SpectatorCrowd Static ${source.name}`;
      mesh.userData.skipLevelRaycast = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      source.mesh = mesh;
      group.add(mesh);
    });
  }

  function beginPipelineWarmup() {
    pipelineWarmupMeshes = [
      ...sourceMeshes.flatMap((sourceMesh) => sourceMesh.instancedFrames.map((entry) => entry.mesh)),
      ...staticSourceMeshes.map((source) => source.mesh).filter(Boolean),
    ];
    pipelineWarmupBatchStart = 0;
    pipelineWarmupFramesRemaining = CROWD_PIPELINE_WARMUP_FRAMES;
    setPipelineWarmupBatchVisible(true);
    status = 'warming-pipelines';
  }

  function setPipelineWarmupBatchVisible(visible) {
    const end = Math.min(
      pipelineWarmupMeshes.length,
      pipelineWarmupBatchStart + CROWD_PIPELINE_WARMUP_BATCH_SIZE,
    );
    for (let index = pipelineWarmupBatchStart; index < end; index += 1) {
      pipelineWarmupMeshes[index].count = visible ? 1 : 0;
      pipelineWarmupMeshes[index].visible = visible;
    }
  }

  function onAfterRender() {
    if (status !== 'warming-pipelines') return;
    pipelineWarmupFramesRemaining -= 1;
    if (pipelineWarmupFramesRemaining > 0) return;

    setPipelineWarmupBatchVisible(false);
    pipelineWarmupBatchStart += CROWD_PIPELINE_WARMUP_BATCH_SIZE;
    if (pipelineWarmupBatchStart < pipelineWarmupMeshes.length) {
      pipelineWarmupFramesRemaining = CROWD_PIPELINE_WARMUP_FRAMES;
      setPipelineWarmupBatchVisible(true);
      return;
    }

    pipelineWarmupFramesRemaining = 0;
    pipelineWarmupMeshes = [];
    pipelineWarmupBatchStart = 0;
    status = 'ready';
  }

  async function load() {
    if (status === 'loading' || loaded) return;
    status = 'loading';
    try {
      const gltf = await createGltfLoader().loadAsync(encodeURI(modelUrl));
      const crowdRoot = cloneSkeleton(gltf.scene);
      crowdRoot.updateMatrixWorld(true);
      crowdRoot.traverse((child) => {
        if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
      });

      const clips = new Map((gltf.animations ?? []).map((clip) => [clip.name, clip]));
      const mixer = new THREE.AnimationMixer(crowdRoot);
      const skinnedMesh = crowdRoot.getObjectByProperty?.('type', 'SkinnedMesh')
        ?? (() => {
          let found = null;
          crowdRoot.traverse((child) => { if (!found && child.isSkinnedMesh) found = child; });
          return found;
        })();
      if (!skinnedMesh) {
        throw new Error('Crowd model has no SkinnedMesh');
      }

      const normalizationDefinition = CROWD_CLIP_DEFINITIONS.find((clip) => clip.name === 'StandIdle')
        ?? CROWD_CLIP_DEFINITIONS[0];
      const normalizationSourceClip = clips.get(normalizationDefinition.sourceClip);
      if (!normalizationSourceClip) {
        throw new Error(`Missing crowd normalization clip "${normalizationDefinition.sourceClip}"`);
      }
      const normalizationAction = mixer.clipAction(lockRootTranslation(normalizationSourceClip));
      normalizationAction.reset();
      normalizationAction.play();
      normalizationAction.paused = true;
      normalizationAction.time = 0;
      mixer.update(0);
      crowdRoot.updateMatrixWorld(true);
      crowdRoot.traverse((child) => {
        if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
      });
      const normalizationBake = bakeCrowdSkinnedGeometry(crowdRoot);
      if (!normalizationBake?.geometry) {
        throw new Error('Failed to bake crowd normalization pose');
      }
      const normalizationWelded = weldBakedCrowdGeometry(normalizationBake.geometry);
      const normalization = computeCrowdNormalization(normalizationWelded);
      normalizationWelded.dispose();
      normalizationAction.stop();
      if (!normalization) {
        throw new Error('Crowd normalization pose has degenerate bounds');
      }
      normalization.groundEachFrame = true;
      bakedSampleHeight = CROWD_TARGET_HEIGHT;

      const sourceMaterial = getPrimaryMaterial(skinnedMesh.material)?.clone?.()
        ?? skinnedMesh.material?.clone?.();
      if (!sourceMaterial) {
        throw new Error('Crowd model has no usable material');
      }
      const bakedSourceMesh = {
        sourceMaterial,
        material: createCrowdMaterial(sourceMaterial),
        frames: new Map(),
        instancedFrames: [],
        frameLookup: new Map(),
      };

      for (const clipDefinition of CROWD_CLIP_DEFINITIONS) {
        const sourceClip = clips.get(clipDefinition.sourceClip);
        if (!sourceClip) {
          throw new Error(`Missing crowd clip "${clipDefinition.sourceClip}" in ${modelUrl}`);
        }
        const clip = lockRootTranslation(sourceClip);

        playbackSpeeds[clipDefinition.name] = clipDefinition.name === 'StandIdle'
          ? clipDefinition.speed
          : 1 / Math.max(clip.duration, 0.05);

        const action = mixer.clipAction(clip);
        action.reset();
        action.play();
        action.paused = true;

        const bakedFrames = [];
        for (let frameIndex = 0; frameIndex < clipDefinition.samples; frameIndex += 1) {
          const sampleTime = clip.duration * (frameIndex / clipDefinition.samples);
          action.time = sampleTime;
          mixer.update(0);
          crowdRoot.updateMatrixWorld(true);
          crowdRoot.traverse((child) => {
            if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
          });
          const { geometry } = bakePosedCrowdGeometry(crowdRoot, normalization);
          bakedFrames.push(geometry);
          bakedFrameProgress += 1;
          if (bakedFrameProgress % CROWD_BAKE_YIELD_EVERY === 0) {
            await yieldToMainThread();
          }
        }
        action.stop();
        bakedSourceMesh.frames.set(clipDefinition.name, bakedFrames);
        frameCounts.set(clipDefinition.name, clipDefinition.samples);
      }

      sourceMeshes.push(bakedSourceMesh);

      createInstancedFrames();
      await loadStaticSourceModels();
      imposterMesh = new THREE.InstancedMesh(
        createRallySpectatorGeometry(),
        new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true }),
        maxAgents,
      );
      imposterMesh.name = 'SpectatorCrowd Imposters';
      imposterMesh.userData.skipLevelRaycast = true;
      imposterMesh.castShadow = false;
      imposterMesh.receiveShadow = false;
      imposterMesh.frustumCulled = false;
      imposterMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      imposterMesh.count = 0;
      // Prime the imposter's instance binding too — its count varies per frame
      // (0..maxAgents) just like the flipbook frames, so a pipeline rebuild
      // would otherwise capture a small count and drop far-agent boxes.
      initializeCrowdInstanceStream(imposterMesh, maxAgents);
      group.add(imposterMesh);

      const firstFrame = sourceMeshes[0]?.frames?.get('StandIdle')?.[0];
      bakedVertexCount = firstFrame?.getAttribute('position')?.count ?? 0;
      const populated = populateAgents(placements, quality, maxAgents, playbackSpeeds);
      agents = populated.agents;
      sections = rebuildCrowdSections(populated.filteredPlacements);
      createStaticInstances();
      loaded = true;
      beginPipelineWarmup();
    } catch (err) {
      status = 'error';
      error = err;
      console.error('[SpectatorCrowd] load failed:', err?.message || err, err);
    }
  }

  function resolveFocus(focus) {
    if (!focus) return null;
    if (focus.isVector3) return { position: focus, speed: 0 };
    const position = focus.position?.isVector3
      ? focus.position
      : tempVector.set(focus.x ?? 0, focus.y ?? 0, focus.z ?? 0);
    return { position, speed: focus.speed ?? 0 };
  }

  function updateVehicleReactions(focus) {
    const resolved = resolveFocus(focus);
    if (!resolved || !loaded) return;
    const { position, speed } = resolved;

    let currentSectionId = null;
    let minDistSq = Infinity;
    const radiusSq = CROWD_SECTION_VEHICLE_RADIUS * CROWD_SECTION_VEHICLE_RADIUS;

    for (const [sectionId, section] of sections) {
      const distSq = section.center.distanceToSquared(position);
      if (distSq <= radiusSq && distSq < minDistSq) {
        minDistSq = distSq;
        currentSectionId = sectionId;
      }
    }

    if (currentSectionId && currentSectionId !== activeVehicleSectionId) {
      const fastReactions = ['Cheer', 'Cocky', 'Acknowledge'];
      const slowReactions = ['Acknowledge', 'HeadNod', 'HeadShake'];
      const reactions = speed >= CROWD_CHEER_SPEED_THRESHOLD ? fastReactions : slowReactions;
      const clip = reactions[Math.floor(Math.random() * reactions.length)];
      const probability = speed >= CROWD_CHEER_SPEED_THRESHOLD ? 0.34 : 0.22;
      const sectionAgents = agents.filter((a) => a.sectionId === currentSectionId);
      queueReactionBurst(sectionAgents, clip, probability);
    }

    if (previousVehicleSectionId && previousVehicleSectionId !== currentSectionId) {
      const trailingAgents = agents.filter((a) => a.sectionId === previousVehicleSectionId);
      queueReactionBurst(trailingAgents, 'Cheer', 0.12);
    }

    previousVehicleSectionId = activeVehicleSectionId;
    activeVehicleSectionId = currentSectionId;
  }

  function update(deltaSeconds, camera, focusPosition) {
    if (!loaded || !camera || status !== 'ready') return;

    updateVehicleReactions(focusPosition);
    const actionFocus = resolveFocus(focusPosition);
    const focusX = actionFocus?.position?.x;
    const focusZ = actionFocus?.position?.z;
    const animatedAgents = selectNearestAnimatedAgents(
      agents.filter((agent) => agent.staticVariantIndex < 0),
      camera.position,
    );

    let drawnAgents = 0;
    let culledAgents = 0;
    let imposterAgents = 0;
    let flipbookAgents = 0;
    let staticAgents = 0;
    let nearAgents = 0;
    let reactingAgents = 0;
    let nearestAgentDistSq = Infinity;

    for (const mesh of activeFlipbookMeshes) {
      mesh.count = 0;
    }
    activeFlipbookMeshes.clear();
    if (imposterMesh) imposterMesh.count = 0;
    for (const source of staticSourceMeshes) {
      if (source.mesh) source.mesh.count = 0;
    }

    for (const agent of agents) {
      const distSq = agent.position.distanceToSquared(camera.position);
      if (distSq < nearestAgentDistSq) nearestAgentDistSq = distSq;

      if (distSq > CROWD_HARD_CULL_DISTANCE_SQ) {
        culledAgents += 1;
        continue;
      }

      if (distSq <= CROWD_NEAR_RANGE_SQ) nearAgents += 1;
      if (agent.clipName !== 'StandIdle') reactingAgents += 1;

      if (agent.staticVariantIndex >= 0) {
        if (Number.isFinite(focusX) && Number.isFinite(focusZ)) {
          const targetYaw = Math.atan2(focusX - agent.position.x, focusZ - agent.position.z);
          agent.yaw = turnYawToward(agent.yaw, targetYaw, deltaSeconds);
        } else {
          agent.yaw = turnYawToward(agent.yaw, agent.baseYaw, deltaSeconds);
        }
        tempEuler.set(0, agent.yaw, 0);
        tempQuaternion.setFromEuler(tempEuler);
        tempScale.setScalar(agent.scale);
        agent.matrix.compose(agent.position, tempQuaternion, tempScale);

        const staticMesh = staticSourceMeshes[agent.staticVariantIndex]?.mesh;
        if (staticMesh) {
          const instanceIndex = staticMesh.count;
          staticMesh.setMatrixAt(instanceIndex, agent.matrix);
          staticMesh.count = instanceIndex + 1;
          staticAgents += 1;
          drawnAgents += 1;
        }
        continue;
      }

      if (!animatedAgents.has(agent)) {
        if (imposterMesh) {
          const instanceIndex = imposterMesh.count;
          imposterMesh.setMatrixAt(instanceIndex, agent.matrix);
          imposterMesh.count = instanceIndex + 1;
        }
        imposterAgents += 1;
        continue;
      }

      const frameCount = frameCounts.get(agent.clipName) ?? 1;
      const lodTier = getLodTier(distSq);
      const updateInterval = lodTier.updateInterval * lodIntervalMultiplier;
      advanceAgent(agent, deltaSeconds, updateInterval);
      agent.currentFrameIndex = computeAgentFrameIndex(agent, frameCount, lodTier);

      for (const sourceMesh of sourceMeshes) {
        const bakedFrame = sourceMesh.frameLookup.get(agent.clipName)?.[agent.currentFrameIndex];
        if (!bakedFrame) continue;
        const instanceIndex = bakedFrame.count;
        bakedFrame.setMatrixAt(instanceIndex, agent.matrix);
        bakedFrame.count = instanceIndex + 1;
        activeFlipbookMeshes.add(bakedFrame);
        drawnAgents += 1;
        flipbookAgents += 1;
        break;
      }
    }

    lastDrawStats = {
      drawnAgents,
      culledAgents,
      imposterAgents,
      flipbookAgents,
      staticAgents,
      flipbookCap: CROWD_MAX_FLIPBOOK_AGENTS,
      nearAgents,
      reactingAgents,
      nearestAgentM: Number.isFinite(nearestAgentDistSq) && nearestAgentDistSq < Infinity
        ? +Math.sqrt(nearestAgentDistSq).toFixed(1)
        : null,
    };

    for (const bakedFrame of activeFlipbookMeshes) {
      bakedFrame.instanceMatrix.needsUpdate = true;
      bakedFrame.visible = true;
    }

    for (const sourceMesh of sourceMeshes) {
      for (const entry of sourceMesh.instancedFrames) {
        const mesh = entry.mesh;
        if (activeFlipbookMeshes.has(mesh)) continue;
        mesh.count = 0;
        mesh.visible = false;
      }
    }

    for (const source of staticSourceMeshes) {
      if (!source.mesh) continue;
      source.mesh.instanceMatrix.needsUpdate = source.mesh.count > 0;
      source.mesh.visible = source.mesh.count > 0;
    }

    if (imposterMesh) {
      imposterMesh.instanceMatrix.needsUpdate = imposterMesh.count > 0;
      imposterMesh.visible = imposterMesh.count > 0;
    }
  }

  /**
   * Reset every instanced stream so the next render re-primes its pipeline
   * binding at full capacity. Call after any event that rebuilds WebGPU render
   * pipelines (weather/env change, scene-fog toggle, resize) — without this the
   * animated frames re-capture a small per-frame count and spectators flicker.
   * Safe before load (no-op) and after dispose.
   */
  function markPipelinesDirty() {
    for (const sourceMesh of sourceMeshes) {
      for (const entry of sourceMesh.instancedFrames) markCrowdMeshPipelineDirty(entry.mesh);
    }
    for (const source of staticSourceMeshes) {
      if (source.mesh) markCrowdMeshPipelineDirty(source.mesh);
    }
    if (imposterMesh) markCrowdMeshPipelineDirty(imposterMesh);
  }

  function dispose() {
    imposterMesh?.geometry?.dispose?.();
    const imposterMaterial = imposterMesh?.material;
    if (Array.isArray(imposterMaterial)) imposterMaterial.forEach((m) => m?.dispose?.());
    else imposterMaterial?.dispose?.();
    imposterMesh = null;
    activeFlipbookMeshes.clear();

    for (const source of staticSourceMeshes) {
      source.geometry?.dispose?.();
      source.material?.dispose?.();
    }
    staticSourceMeshes = [];
    pipelineWarmupMeshes = [];

    for (const sourceMesh of sourceMeshes) {
      for (const bakedFrame of sourceMesh.instancedFrames) {
        bakedFrame.mesh.geometry?.dispose?.();
        const mat = bakedFrame.mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
        else mat?.dispose?.();
      }
      for (const frames of sourceMesh.frames.values()) {
        for (const geometry of frames) geometry.dispose?.();
      }
    }
    sourceMeshes = [];
    agents = [];
    sections.clear();
    disposeObject3D(group);
    group.removeFromParent();
    loaded = false;
    status = 'disposed';
  }

  return {
    group,
    load,
    update,
    onAfterRender,
    dispose,
    markPipelinesDirty,
    snapshot: snapshotBase,
    get agents() { return agents; },
    get sections() { return sections; },
    get loaded() { return loaded; },
    get status() { return status; },
  };
}

/**
 * Test harness: simulate one update tick without a renderer/GLB.
 */
export function simulateCrowdTick({
  agents,
  frameCounts = new Map(CROWD_CLIP_DEFINITIONS.map((c) => [c.name, c.samples])),
  deltaSeconds = 1 / 60,
  cameraPosition = { x: 0, y: 2, z: -10 },
  quality = 'ultra',
}) {
  const counts = new Map();
  let totalInstances = 0;

  for (const agent of agents) {
    const distSq = agent.position.distanceToSquared(
      tempVector.set(cameraPosition.x, cameraPosition.y, cameraPosition.z),
    );
    if (distSq > CROWD_HARD_CULL_DISTANCE_SQ) continue;

    const frameCount = frameCounts.get(agent.clipName) ?? 1;
    const lodTier = getLodTier(distSq);
    const interval = lodTier.updateInterval * getQualityLodIntervalMultiplier(quality);
    advanceAgent(agent, deltaSeconds, interval);
    const frameIndex = computeAgentFrameIndex(agent, frameCount, lodTier);
    if (!Number.isFinite(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) {
      throw new Error(`Invalid frame index ${frameIndex} for ${agent.clipName}`);
    }
    agent.currentFrameIndex = frameIndex;
    const key = `${agent.clipName}:${frameIndex}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    totalInstances += 1;
  }

  return { totalInstances, counts };
}
