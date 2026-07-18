import assert from 'node:assert/strict';
import {
  __seedFileStoreForTests,
  readCollection,
} from '../src/store/fileStore.js';
import {
  createSimPreset,
  getSimPreset,
  getSimSpawnPresets,
  loadSimPresets,
  saveSimPreset,
} from '../src/game/characters/simhuman/simPresetStore.js';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const simId = `verify-sim-${suffix}`;
const garmentId = `verify-garment-${suffix}`;
const base = new URL(dreamfallAppUrl());

async function api(collection, id, init) {
  const response = await fetch(new URL(`/api/store/${collection}/${id}`, base), init);
  assert.ok(response.ok, `${init?.method ?? 'GET'} ${collection}/${id}: ${response.status}`);
  return response.json();
}

try {
  const preset = createSimPreset({
    id: simId,
    name: 'Store Verify Sim',
    body: 'female',
    morphs: {
      'id.head.width': 0.42,
      'not-a-real-morph': 1,
    },
    garmentIds: [garmentId],
  });
  assert.equal(preset.morphs['id.head.width'], 0.42);
  assert.equal(preset.morphs['not-a-real-morph'], undefined);
  assert.equal(preset.body, 'female');
  const outfitPreset = createSimPreset({
    id: `verify-outfit-${suffix}`,
    body: 'male',
    outfitId: 'fantasy-peasant',
    garmentIds: [garmentId],
  });
  assert.equal(outfitPreset.outfitId, 'fantasy-peasant');
  assert.deepEqual(outfitPreset.garmentIds, [], 'authored outfit should replace simulated garments');

  const garment = { id: garmentId, name: 'Store Verify Garment', panels: [] };
  await api('sims', simId, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(preset),
  });
  await api('garments', garmentId, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(garment),
  });

  const loadedSim = await api('sims', simId);
  const loadedGarment = await api('garments', garmentId);
  assert.equal(loadedSim.name, preset.name);
  assert.equal(loadedSim.body, 'female');
  assert.deepEqual(loadedSim.garmentIds, [garmentId]);
  assert.equal(loadedGarment.name, garment.name);

  __seedFileStoreForTests({ sims: { [simId]: loadedSim }, garments: { [garmentId]: loadedGarment } });
  assert.equal(getSimPreset(simId).morphs['id.head.width'], 0.42);
  assert.equal(getSimPreset(simId).body, 'female');
  assert.equal(loadSimPresets().some((entry) => entry.id === simId), true);
  assert.equal(readCollection('garments')[garmentId].name, garment.name);
  const resaved = saveSimPreset({ ...loadedSim, name: 'Store Verify Sim Updated' });
  assert.equal(resaved.name, 'Store Verify Sim Updated');
  assert.equal(getSimSpawnPresets(2).length, 2);

  console.log('verify-sims-store: sims + garments REST and synchronous cache round-trip OK');
} finally {
  await Promise.allSettled([
    fetch(new URL(`/api/store/sims/${simId}`, base), { method: 'DELETE' }),
    fetch(new URL(`/api/store/garments/${garmentId}`, base), { method: 'DELETE' }),
  ]);
}
