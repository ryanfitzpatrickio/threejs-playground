import { broadleafControls } from './broadleaf-controls.js';
import { speciesTextureFiles } from '../../forestSpeciesTextures.js';

const DEFAULT_FOLIAGE = {
  mode: 'leaves',
  clustersPerBranch: 3,
  clusterSize: 1.1,
  clusterSizeVar: 0.3,
  clusterQuads: 2,
  tint: 0xffffff,
  leavesPerBranch: 9,
  size: 0.7,
  downAngle: 62,
  bend: 0,
  startFrac: 0.15,
};

const DEFAULT_PARAMS = {
  scale: 30,
  scaleV: 3,
  levels: 3,
  ratio: 0.02,
  ratioPower: 1.4,
  baseSize: 0.12,
  shape: 0,
  flare: 0.5,
  attractionUp: 0.0,
  baseSplits: 0,
  baseSplitAngle: 0,
  length: [1.0, 0.34, 0.34, 0.28],
  lengthV: [0.0, 0.08, 0.1, 0.1],
  taper: [1.0, 1.0, 1.0, 1.0],
  curveRes: [14, 6, 4, 3],
  curve: [2, 12, 16, 0],
  curveBack: [0, 0, 0, 0],
  curveV: [4, 18, 24, 24],
  downAngle: [0, 82, 80, 74],
  downAngleV: [0, 10, 12, 12],
  rotate: [0, 137, 137, 137],
  rotateV: [0, 22, 22, 22],
  branches: [0, 46, 16, 0],
  radialSegments: [12, 6, 4, 3],
};

function mergeParams(overrides = {}) {
  const out = { ...DEFAULT_PARAMS, ...overrides };
  for (const key of [
    'length', 'lengthV', 'taper', 'curveRes', 'curve', 'curveBack', 'curveV',
    'downAngle', 'downAngleV', 'rotate', 'rotateV', 'branches', 'radialSegments',
  ]) {
    if (overrides[key]) out[key] = [...overrides[key]];
  }
  return out;
}

export function makeConiferPreset({
  id,
  name,
  latin,
  tileWorldSize = 1.2,
  foliage = {},
  params = {},
}) {
  const { bark, leaf } = speciesTextureFiles(id);
  return {
    name,
    latin,
    bark,
    leaf,
    biome: 'temperate',
    tileWorldSize,
    controls: broadleafControls,
    foliage: { ...DEFAULT_FOLIAGE, ...foliage },
    params: mergeParams(params),
  };
}

export const redSpruce = makeConiferPreset({
  id: 'red-spruce',
  name: 'Red Spruce',
  latin: 'Picea rubens',
  tileWorldSize: 1.3,
  foliage: { leavesPerBranch: 10, size: 0.65 },
  params: { scale: 24, scaleV: 2.5, baseSize: 0.1, branches: [0, 50, 18, 0], downAngle: [0, 84, 82, 78] },
});

export const sitkaSpruce = makeConiferPreset({
  id: 'sitka-spruce',
  name: 'Sitka Spruce',
  latin: 'Picea sitchensis',
  tileWorldSize: 1.3,
  foliage: { leavesPerBranch: 10, size: 0.68 },
  params: { scale: 38, scaleV: 4, flare: 0.55, branches: [0, 48, 17, 0], downAngle: [0, 80, 78, 72] },
});

export const westernHemlock = makeConiferPreset({
  id: 'western-hemlock',
  name: 'Western Hemlock',
  latin: 'Tsuga heterophylla',
  tileWorldSize: 1.3,
  foliage: { leavesPerBranch: 11, size: 0.62, downAngle: 68 },
  params: { scale: 32, scaleV: 3, baseSize: 0.1, branches: [0, 54, 20, 0], curve: [2, 18, 24, 0], downAngle: [0, 86, 84, 80] },
});

export const easternHemlock = makeConiferPreset({
  id: 'eastern-hemlock',
  name: 'Eastern Hemlock',
  latin: 'Tsuga canadensis',
  tileWorldSize: 1.3,
  foliage: { leavesPerBranch: 8, size: 0.6, startFrac: 0.25 },
  params: { scale: 28, scaleV: 3, baseSize: 0.32, branches: [0, 36, 12, 0], curve: [2, 14, 20, 0], downAngle: [0, 78, 74, 68], rotateV: [0, 28, 28, 28] },
});

export const deodarCedar = makeConiferPreset({
  id: 'deodar-cedar',
  name: 'Deodar Cedar',
  latin: 'Cedrus deodara',
  tileWorldSize: 1.3,
  foliage: { leavesPerBranch: 9, size: 0.72, downAngle: 58 },
  params: { scale: 34, scaleV: 3, ratio: 0.022, baseSize: 0.14, branches: [0, 42, 14, 0], downAngle: [0, 70, 66, 60], attractionUp: 0.05 },
});

export const atlasCedar = makeConiferPreset({
  id: 'atlas-cedar',
  name: 'Atlas Cedar',
  latin: 'Cedrus atlantica',
  foliage: { leavesPerBranch: 8, size: 0.75, downAngle: 55 },
  params: { scale: 28, scaleV: 3, baseSize: 0.18, shape: 2, flare: 0.6, branches: [0, 38, 14, 0], downAngle: [0, 62, 58, 52], attractionUp: -0.1, length: [1.0, 0.42, 0.38, 0.3] },
});

export const hicksYew = makeConiferPreset({
  id: 'hicks-yew',
  name: "Hick's Yew",
  latin: "Taxus × media 'Hicksii'",
  tileWorldSize: 1.2,
  foliage: { leavesPerBranch: 12, size: 0.55, downAngle: 50, startFrac: 0.05 },
  params: { scale: 8, scaleV: 1.2, ratio: 0.028, baseSize: 0.04, shape: 5, flare: 0.35, branches: [0, 58, 22, 0], downAngle: [0, 72, 68, 62], length: [1.0, 0.28, 0.26, 0.22] },
});

export const japaneseYew = makeConiferPreset({
  id: 'japanese-yew',
  name: 'Japanese Yew',
  latin: 'Taxus cuspidata',
  tileWorldSize: 1.2,
  foliage: { leavesPerBranch: 13, size: 0.52, downAngle: 48, startFrac: 0.06 },
  params: { scale: 10, scaleV: 1.5, ratio: 0.026, baseSize: 0.06, branches: [0, 62, 24, 0], downAngle: [0, 68, 64, 58], length: [1.0, 0.3, 0.28, 0.24] },
});

export const giantSequoia = makeConiferPreset({
  id: 'giant-sequoia',
  name: 'Giant Sequoia',
  latin: 'Sequoiadendron giganteum',
  foliage: { leavesPerBranch: 7, size: 0.8, startFrac: 0.35 },
  params: { scale: 48, scaleV: 5, ratio: 0.038, baseSize: 0.62, shape: 1, flare: 0.7, branches: [0, 32, 10, 0], downAngle: [0, 68, 64, 58], curve: [3, 8, 10, 0], curveV: [3, 10, 12, 12] },
});

export const californiaRedwood = makeConiferPreset({
  id: 'california-redwood',
  name: 'California Redwood',
  latin: 'Sequoia sempervirens',
  foliage: { leavesPerBranch: 8, size: 0.72, startFrac: 0.4 },
  params: { scale: 52, scaleV: 5, ratio: 0.014, baseSize: 0.58, branches: [0, 28, 8, 0], downAngle: [0, 74, 70, 64], curve: [2, 6, 8, 0], length: [1.0, 0.38, 0.34, 0.28] },
});

export const baldCypress = makeConiferPreset({
  id: 'bald-cypress',
  name: 'Bald Cypress',
  latin: 'Taxodium distichum',
  tileWorldSize: 1.3,
  foliage: { leavesPerBranch: 10, size: 0.58, downAngle: 72, bend: 0.15 },
  params: { scale: 26, scaleV: 3, baseSize: 0.22, branches: [0, 44, 18, 0], curve: [2, 22, 28, 0], downAngle: [0, 88, 86, 82], curveV: [4, 24, 30, 30] },
});

export const spartanJuniper = makeConiferPreset({
  id: 'spartan-juniper',
  name: 'Spartan Juniper',
  latin: "Juniperus chinensis 'Spartan'",
  tileWorldSize: 1.2,
  foliage: { leavesPerBranch: 11, size: 0.5, downAngle: 45, startFrac: 0.08 },
  params: { scale: 12, scaleV: 1.5, ratio: 0.024, baseSize: 0.03, shape: 5, flare: 0.3, branches: [0, 52, 20, 0], downAngle: [0, 58, 54, 48], length: [1.0, 0.26, 0.24, 0.2], attractionUp: 0.2 },
});

export const sugarPine = makeConiferPreset({
  id: 'sugar-pine',
  name: 'Sugar Pine',
  latin: 'Pinus lambertiana',
  foliage: { leavesPerBranch: 8, size: 0.82, downAngle: 58 },
  params: { scale: 36, scaleV: 3.5, baseSize: 0.28, branches: [0, 42, 15, 0], downAngle: [0, 74, 70, 64], length: [1.0, 0.38, 0.36, 0.3] },
});

export const redPine = makeConiferPreset({
  id: 'red-pine',
  name: 'Red Pine',
  latin: 'Pinus resinosa',
  foliage: { leavesPerBranch: 7, size: 0.78, downAngle: 52, startFrac: 0.22 },
  params: { scale: 28, scaleV: 3, baseSize: 0.26, shape: 1, branches: [0, 34, 12, 0], downAngle: [0, 66, 62, 56], rotateV: [0, 30, 30, 30] },
});

export const nobleFir = makeConiferPreset({
  id: 'noble-fir',
  name: 'Noble Fir',
  latin: 'Abies procera',
  tileWorldSize: 1.3,
  foliage: { leavesPerBranch: 11, size: 0.64, downAngle: 64 },
  params: { scale: 32, scaleV: 3, baseSize: 0.1, branches: [0, 56, 20, 0], downAngle: [0, 86, 84, 80], curve: [2, 10, 12, 0] },
});

export const westernLarch = makeConiferPreset({
  id: 'western-larch',
  name: 'Western Larch',
  latin: 'Larix occidentalis',
  foliage: { leavesPerBranch: 5, size: 0.65, downAngle: 60, startFrac: 0.3 },
  params: { scale: 30, scaleV: 3, baseSize: 0.38, ratio: 0.016, branches: [0, 26, 8, 0], downAngle: [0, 70, 66, 60], curve: [2, 8, 10, 0], length: [1.0, 0.36, 0.32, 0.26] },
});
