import { Group, Mesh } from 'three';
import { Rng } from './seedthree/rng.js';
import { generateSkeleton } from './seedthree/weber-penn.js';
import { buildBranchGeometry } from './seedthree/branch-mesh.js';
import { buildFoliage } from './seedthree/leaf-cards.js';

const LOD1_PCT = 0.5;
const LOD2_PCT = 0.15;

function pruneStems(stems, terminalStems, prune) {
  let meshStems = stems;
  let levelTerminals = terminalStems;
  if (prune <= 0) return { meshStems, levelTerminals };
  const deepest = Math.max(...meshStems.map((s) => s.level));
  if (deepest <= 0) return { meshStems, levelTerminals };
  const candidates = meshStems
    .filter((s) => s.level === deepest)
    .sort((a, b) => a.radii[0] - b.radii[0]);
  const drop = new Set(candidates.slice(0, Math.floor(candidates.length * prune)));
  return {
    meshStems: meshStems.filter((s) => !drop.has(s)),
    levelTerminals: levelTerminals.filter((s) => !drop.has(s)),
  };
}

function buildLodLevel(speciesPreset, seed, assets, {
  name,
  radialScale,
  ringStride,
  prune,
  foliageCfg,
  foliageSeedSuffix,
  castShadow = false,
}) {
  const rng = new Rng(`${speciesPreset.name}:${seed}`);
  const { stems } = generateSkeleton(speciesPreset.params, rng);
  const terminalStems = stems.filter((s) => s.level === s.maxLevel);
  const { meshStems, levelTerminals } = pruneStems(stems, terminalStems, prune);

  const level = new Group();
  level.name = `${speciesPreset.name.replace(/\s+/g, '_')}_${name}`;

  const frng = new Rng(`${speciesPreset.name}:${seed}:${foliageSeedSuffix}`);
  const foliage = buildFoliage(
    levelTerminals,
    foliageCfg,
    frng,
    foliageCfg.mode === 'clusters' ? assets.clusterMat : assets.leafMat,
    foliageCfg.mode === 'clusters' ? assets.clusterCenter : assets.leafCenter,
  );
  if (foliage) {
    foliage.castShadow = castShadow;
    foliage.receiveShadow = castShadow;
    level.add(foliage);
  }

  const geo = buildBranchGeometry(meshStems, {
    tileWorldSize: speciesPreset.tileWorldSize ?? 1.5,
    radialScale,
    ringStride,
  });
  geo.computeBoundingSphere();
  const branches = new Mesh(geo, assets.barkMat);
  branches.castShadow = castShadow;
  branches.receiveShadow = castShadow;
  level.add(branches);

  level.position.y = -(speciesPreset.plantSink ?? 0.2);
  return { lodGroup: level, branches, foliage };
}

export function buildLod1Tree(speciesPreset, seed, assets, { castShadow = false } = {}) {
  const meshQuality = 1;
  return buildLodLevel(speciesPreset, seed, assets, {
    name: 'LOD1',
    radialScale: meshQuality * LOD1_PCT,
    ringStride: 1,
    prune: 0,
    foliageCfg: { ...speciesPreset.foliage, mode: 'leaves' },
    foliageSeedSuffix: 'foliage1',
    castShadow,
  });
}

export function buildLod2Tree(speciesPreset, seed, assets, { castShadow = false } = {}) {
  const meshQuality = 1;
  return buildLodLevel(speciesPreset, seed, assets, {
    name: 'LOD2',
    radialScale: Math.min(1, meshQuality * LOD2_PCT * 2.4),
    ringStride: 2,
    prune: 0.35,
    foliageCfg: {
      ...speciesPreset.foliage,
      mode: 'clusters',
      clustersPerBranch: speciesPreset.foliage?.clustersPerBranch ?? 3,
    },
    foliageSeedSuffix: 'foliage2',
    castShadow,
  });
}
