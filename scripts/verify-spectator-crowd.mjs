import assert from 'node:assert/strict';
import * as THREE from 'three';

const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { normalizeRoad } = await import('../src/world/worldMap/worldMapSchema.js');
const { createTracksideLayers } = await import('../src/game/world/createTracksideLayers.js');
const { collectRallyCrowdPlacements, hash01 } = await import('../src/game/world/rallyCrowdPlacements.js');
const {
  CROWD_CLIP_DEFINITIONS,
  CROWD_LOD_TIERS,
  CROWD_ANIMATED_MAX_DISTANCE_SQ,
  CROWD_MAX_FLIPBOOK_AGENTS,
  CROWD_PIPELINE_WARMUP_FRAMES,
  CROWD_PIPELINE_WARMUP_BATCH_SIZE,
  advanceAgent,
  computeAgentFrameIndex,
  filterPlacementsByQuality,
  getLodTier,
  getQualityLodIntervalMultiplier,
  initializeCrowdInstanceStream,
  createCrowdMaterial,
  selectNearestAnimatedAgents,
  chooseStaticCrowdVariant,
  turnYawToward,
  computeCrowdNormalization,
  normalizeBakedCrowdGeometry,
  simplifyCrowdBakedGeometry,
  rebuildCrowdSections,
  simulateCrowdTick,
} = await import('../src/game/world/spectatorCrowd.js');

let passed = 0;
const ok = (message) => { passed += 1; console.log(`  ✓ ${message}`); };

const sampleHeight = () => 0;
const points = [{ x: -120, z: 0 }, { x: 0, z: 0 }, { x: 120, z: 0 }];

{
  assert.ok(CROWD_PIPELINE_WARMUP_FRAMES >= 2, 'warmup spans main and alternating prepass frames');
  assert.ok(CROWD_PIPELINE_WARMUP_BATCH_SIZE > 0 && CROWD_PIPELINE_WARMUP_BATCH_SIZE <= 8);
  assert.equal(chooseStaticCrowdVariant(0, 3, 0.3), 0);
  assert.equal(chooseStaticCrowdVariant(0.15, 3, 0.3), 1);
  assert.equal(chooseStaticCrowdVariant(0.299, 3, 0.3), 2);
  assert.equal(chooseStaticCrowdVariant(0.3, 3, 0.3), -1);
  const turned = turnYawToward(Math.PI - 0.1, -Math.PI + 0.1, 0.1, 1);
  assert.ok(turned > Math.PI - 0.1, 'turning uses the short wrapped direction');
  ok('static variants are deterministic and turn toward action without animating');
}

{
  assert.equal(Math.sqrt(CROWD_ANIMATED_MAX_DISTANCE_SQ), 90);
  assert.equal(CROWD_MAX_FLIPBOOK_AGENTS, 72);
  const agents = [12, 3, 8, 1].map((x) => ({ position: new THREE.Vector3(x, 0, 0) }));
  const selected = selectNearestAnimatedAgents(agents, new THREE.Vector3(), 10 * 10, 2);
  assert.deepEqual([...selected], [agents[3], agents[1]]);
  ok('expanded flipbook budget is assigned to the nearest eligible agents');
}

{
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
    4,
  );
  initializeCrowdInstanceStream(mesh, 4);
  assert.equal(mesh.instanceColor, null, 'flipbook does not add whole-body instance tint');
  assert.equal(mesh.instanceMatrix.usage, THREE.DynamicDrawUsage);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < 4; i += 1) {
    mesh.getMatrixAt(i, matrix);
    assert.equal(matrix.determinant(), 0, `unused instance ${i} starts collapsed`);
  }
  mesh.count = 2;
  mesh.onBeforeRender();
  assert.equal(mesh.count, 4, 'first pipeline build sees full matrix capacity');
  await Promise.resolve();
  assert.equal(mesh.count, 2, 'runtime draw count is restored after pipeline setup');
  mesh.count = 3;
  mesh.onBeforeRender();
  assert.equal(mesh.count, 3, 'later frames retain their current draw count');
  mesh.geometry.dispose();
  mesh.material.dispose();
  ok('flipbook pipelines bind full dynamic capacity without unstable color tinting');
}

{
  // Weather/env changes invalidate the render pipeline (RendererSystem
  // .invalidatePipeline), rebuilding each crowd InstancedMesh's WebGPU binding
  // at whatever per-frame count it has — so a later frame needing more
  // instances flickers out. markCrowdMeshPipelineDirty must re-collapse every
  // slot and clear the prime flag so onBeforeRender re-primes at full capacity.
  const { markCrowdMeshPipelineDirty } = await import('../src/game/world/spectatorCrowd.js');
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
    4,
  );
  initializeCrowdInstanceStream(mesh, 4);
  mesh.count = 2;
  mesh.onBeforeRender();
  await Promise.resolve();
  assert.equal(mesh.userData.crowdPipelinePrimed, true, 'pipeline primed on first render');

  // Simulate a frame where more agents than the rebuilt binding would allow land
  // on this mesh, then a pipeline-rebuild event firing mid-run.
  const live = new THREE.Matrix4().makeTranslation(5, 0, 0);
  mesh.setMatrixAt(3, live);
  mesh.count = 4;
  markCrowdMeshPipelineDirty(mesh);
  assert.equal(mesh.userData.crowdPipelinePrimed, false, 'dirty flag clears the prime');
  const probe = new THREE.Matrix4();
  mesh.getMatrixAt(3, probe);
  assert.equal(probe.determinant(), 0, 'stale live matrices are re-collapsed (no prime ghosts)');

  mesh.onBeforeRender();
  assert.equal(mesh.count, 4, 're-prime renders full capacity after a pipeline rebuild');
  await Promise.resolve();
  assert.equal(mesh.userData.crowdPipelinePrimed, true, 're-prime marks the stream primed again');
  mesh.geometry.dispose();
  mesh.material.dispose();
  ok('markCrowdMeshPipelineDirty re-primes instanced pipelines after weather/env changes');
}

{
  const texture = new THREE.Texture();
  const source = new THREE.MeshStandardMaterial({ map: texture, color: 0xc8d4e0 });
  const crowdMaterial = createCrowdMaterial(source);
  assert.ok(crowdMaterial.isMeshBasicMaterial);
  assert.equal(crowdMaterial.map, texture);
  assert.equal(crowdMaterial.color.getHex(), source.color.getHex());
  assert.equal(crowdMaterial.vertexColors, false);
  crowdMaterial.dispose();
  source.dispose();
  texture.dispose();
  ok('baked poses use stable unlit source texture and color');
}

{
  const road = normalizeRoad({ points, width: 6, trackStyle: 'rallySpectator' });
  const profile = buildRoadProfile({ roads: [road], sampleHeight, smoothRadius: 0, maxGrade: Infinity });
  const a = createTracksideLayers({ profile, sampleHeight, crowdQuality: 'low' });
  const b = createTracksideLayers({ profile, sampleHeight, crowdQuality: 'low' });
  assert.equal(a.crowdPlacements.length, b.crowdPlacements.length);
  assert.equal(a.crowdPlacements[0]?.x, b.crowdPlacements[0]?.x);
  assert.equal(a.crowdPlacements[0]?.sectionId, b.crowdPlacements[0]?.sectionId);
  a.dispose();
  b.dispose();
  ok('placement list is deterministic across rebuilds');
}

{
  const placements = Array.from({ length: 40 }, (_, i) => ({
    x: i * 2,
    z: 5,
    y: 0,
    occupancySeed: hash01(i * 3.1),
    sectionId: `0_left_${Math.floor(i / 10)}`,
  }));
  const ultra = filterPlacementsByQuality(placements, 'ultra', 260);
  const medium = filterPlacementsByQuality(placements, 'high', 260);
  assert.ok(ultra.length >= medium.length);
  assert.ok(medium.length > 0);
  ok('quality density thins without reshuffling order');
}

{
  const agent = {
    clipName: 'StandIdle',
    phase: 0.2,
    speed: 0.25,
    stateTime: 0,
    stateDuration: 5,
    queuedReaction: null,
    lodTimeAccumulator: 0,
    playbackSpeeds: { StandIdle: 0.25, Cheer: 1 },
  };
  const changed = advanceAgent(agent, 1 / 30, 1 / 30);
  assert.equal(changed, true);
  assert.equal(agent.clipName, 'StandIdle');
  assert.ok(Number.isFinite(agent.phase));
  ok('advanceAgent advances idle phase without NaN');
}

{
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 2.5, 0,
    -1, 2.5, 0,
  ], 3));
  const bounds = normalizeBakedCrowdGeometry(geometry, 1.85);
  assert.ok(Math.abs(bounds.height - 1.85) < 0.01);
  assert.ok(Math.abs(geometry.boundingBox.min.y) < 0.01);
  ok('normalizeBakedCrowdGeometry grounds feet and scales to target height');
}

{
  // Guard: flipbook frames must share ONE normalization transform. Normalizing
  // each frame against its own bounds shrank the body whenever a pose raised
  // the arms (taller bounding box) — spectators pulsed small mid-reaction.
  const makeFrame = (topY) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0,
      0.4, 1.7, 0, // shoulder stays at the same body height in both poses
      -0.4, topY, 0, // hand: at side (1.7) vs raised overhead (2.4)
    ], 3));
    return geometry;
  };
  const restFrame = makeFrame(1.7);
  const normalization = computeCrowdNormalization(restFrame, 1.85);
  const armsUpFrame = makeFrame(2.4);
  normalizeBakedCrowdGeometry(restFrame, 1.85, normalization);
  normalizeBakedCrowdGeometry(armsUpFrame, 1.85, normalization);
  const shoulderYRest = restFrame.getAttribute('position').getY(1);
  const shoulderYArmsUp = armsUpFrame.getAttribute('position').getY(1);
  assert.ok(Math.abs(shoulderYRest - shoulderYArmsUp) < 1e-6);
  assert.ok(armsUpFrame.boundingBox.max.y > 1.85 + 0.01);
  ok('shared normalization keeps body scale constant across raised-arm frames');
}

{
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, -0.4, 0,
    0, 1.6, 0,
    0.2, 0.4, 0,
  ], 3));
  const bounds = normalizeBakedCrowdGeometry(geometry, 2, {
    scale: 1,
    minY: 0,
    groundEachFrame: true,
  });
  assert.ok(Math.abs(bounds.minY) < 1e-6);
  assert.ok(Math.abs(bounds.height - 2) < 1e-6);
  ok('per-pose grounding removes FBX root drift without changing shared scale');
}

{
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  for (let triangleIndex = 0; triangleIndex < 400; triangleIndex += 1) {
    const x = triangleIndex * 0.01;
    positions.push(x, 0, 0, x + 0.01, 1, 0, x + 0.02, 0.5, 0);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const before = geometry.getAttribute('position').count;
  const simplified = simplifyCrowdBakedGeometry(geometry, 0, 0.05);
  assert.ok(simplified.getAttribute('position').count < before);
  assert.ok(simplified.getAttribute('position').count > 0);
  ok('simplifyCrowdBakedGeometry welds vertices without dropping random triangles');
}

{
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 0, 1, 0, 1, 0, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  const simplified = simplifyCrowdBakedGeometry(geometry, 0, 0.05);
  assert.ok(simplified.getAttribute('position').count <= 4);
  assert.ok(simplified.boundingBox.max.y > simplified.boundingBox.min.y);
  ok('simplifyCrowdBakedGeometry preserves mesh bounds while welding indexed geometry');
}

{
  const clip = new THREE.AnimationClip('test', 1, [
    new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 0, 0, 1, 0, 0]),
    new THREE.QuaternionKeyframeTrack('mixamorigHips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  const { lockRootTranslation } = await import('../src/game/world/spectatorCrowd.js');
  const locked = lockRootTranslation(clip);
  assert.equal(locked.tracks.length, 1);
  ok('lockRootTranslation strips hips translation before bake');
}

{
  const frameCounts = new Map(CROWD_CLIP_DEFINITIONS.map((c) => [c.name, c.samples]));
  const agents = Array.from({ length: 48 }, (_, i) => ({
    clipName: 'StandIdle',
    phase: hash01(i),
    speed: 0.25,
    stateTime: 0,
    stateDuration: 4,
    queuedReaction: null,
    lodTimeAccumulator: 0,
    currentFrameIndex: -1,
    position: new THREE.Vector3(i * 3, 0, 8),
    sectionId: `0_left_${Math.floor(i / 12)}`,
  }));
  const { totalInstances, counts } = simulateCrowdTick({
    agents,
    frameCounts,
    deltaSeconds: 1 / 30,
    cameraPosition: { x: 60, y: 2, z: -12 },
    quality: 'high',
  });
  assert.ok(totalInstances > 0);
  assert.ok(totalInstances <= agents.length);
  for (const [, count] of counts) assert.ok(count > 0);
  ok('simulated tick keeps instance counts within agent budget');
}

{
  assert.equal(getLodTier(20 * 20).frameDivisor, 1);
  assert.equal(getLodTier(50 * 50).frameDivisor, 2);
  assert.equal(getLodTier(200 * 200).frameDivisor, 4);
  assert.ok(getQualityLodIntervalMultiplier('high') > getQualityLodIntervalMultiplier('ultra'));
  const tier = getLodTier(30 * 30);
  const frameIndex = computeAgentFrameIndex({
    clipName: 'StandIdle',
    phase: 0.5,
  }, 8, tier);
  assert.ok(frameIndex >= 0 && frameIndex < 8);
  ok('LOD tier selection and frame indices stay in baked range');
}

{
  const placements = [
    { x: 0, z: 0, y: 0, sectionId: '0_left_0' },
    { x: 4, z: 0, y: 0, sectionId: '0_left_0' },
    { x: 50, z: 0, y: 0, sectionId: '0_left_1' },
  ];
  const sections = rebuildCrowdSections(placements);
  assert.equal(sections.size, 2);
  assert.ok(sections.get('0_left_0')?.sphere.radius > 0);
  ok('section culling spheres bucket placements');
}

{
  const road = normalizeRoad({ points, width: 6, trackStyle: 'rallySpectator' });
  const profile = buildRoadProfile({ roads: [road], sampleHeight, smoothRadius: 0, maxGrade: Infinity });
  const animated = createTracksideLayers({ profile, sampleHeight, crowdQuality: 'ultra' });
  const staticCrowds = animated.group.children.filter((c) => c.name === 'Rally Spectator Crowd');
  assert.equal(staticCrowds.length, 0);
  assert.ok(animated.crowdPlacements.length > 0);
  animated.dispose();
  ok('animated quality skips static box meshes');
}

console.log(`\nverify:spectator-crowd — ${passed} checks passed`);
