import { normalizeWorldMap } from './worldMapSchema.js';

const RALLY_MAP_SOURCE = Object.freeze({
  version: 1,
  name: 'Pine Ridge Rally',
  chunkSize: 32,
  bounds: { minX: -384, minZ: -384, maxX: 384, maxZ: 384 },
  spawn: { x: -132, z: 136, yaw: 138 },
  zones: [
    {
      id: 'rally_hills',
      type: 'terrain',
      shape: 'rect',
      rect: { minX: -384, minZ: -384, maxX: 384, maxZ: 384 },
      props: { biome: 'hills', relief: 0.78 },
    },
    {
      id: 'rally_wilds_west',
      type: 'wilds',
      shape: 'rect',
      rect: { minX: -384, minZ: -384, maxX: -190, maxZ: 384 },
      props: { biome: 'alpine' },
    },
    {
      id: 'rally_wilds_north',
      type: 'wilds',
      shape: 'rect',
      rect: { minX: -190, minZ: -384, maxX: 384, maxZ: -280 },
      props: { biome: 'alpine' },
    },
    {
      id: 'rally_wilds_east',
      type: 'wilds',
      shape: 'rect',
      rect: { minX: 275, minZ: -280, maxX: 384, maxZ: 384 },
      props: { biome: 'alpine' },
    },
  ],
  roads: [
    {
      id: 'pine_ridge_stage',
      type: 'road',
      width: 6.4,
      trackStyle: 'rallySpectator',
      surface: 'mud',
      points: [
        { x: -140, z: 150 }, { x: -95, z: 105 }, { x: -112, z: 48 },
        { x: -54, z: 9 }, { x: 12, z: 34 }, { x: 76, z: 5 },
        { x: 106, z: -54 }, { x: 58, z: -106 }, { x: -9, z: -92 },
        { x: -57, z: -137 }, { x: -22, z: -202 }, { x: 62, z: -225 },
        { x: 132, z: -190 }, { x: 168, z: -122 },
      ],
    },
    {
      id: 'pine_ridge_service',
      type: 'road',
      width: 5.5,
      trackStyle: 'rallyStage',
      surface: 'mud',
      points: [
        { x: 76, z: 5 }, { x: 140, z: 42 }, { x: 202, z: 28 }, { x: 238, z: -22 },
      ],
    },
  ],
  rivers: [],
  pois: [
    { id: 'rally_start', name: 'Stage Start', kind: 'landmark', x: -140, z: 150 },
    { id: 'rally_finish', name: 'Stage Finish', kind: 'landmark', x: 168, z: -122 },
  ],
  entities: [],
  createdAt: 0,
});

export function getDefaultRallyWorldMap() {
  return normalizeWorldMap(RALLY_MAP_SOURCE);
}
