import {
  deleteEntry,
  readCollection,
  writeEntry,
} from '../../../store/fileStore.js';
import { createDemoGarment } from '../../../vendor/vibe-human/features/clothing/demo/createDemoGarment.ts';
import { DEMO_SIM_GARMENT_ID } from './simGarmentConstants.js';

export { DEMO_SIM_GARMENT_ID } from './simGarmentConstants.js';

export function createBuiltinDemoGarment() {
  const garment = createDemoGarment();
  garment.id = DEMO_SIM_GARMENT_ID;
  garment.name = 'Everyday T-Shirt';
  return garment;
}

export function loadSimGarments() {
  return Object.values(readCollection('garments'))
    .map(unwrapGarment)
    .filter(isGarmentDocument);
}

export function getSimGarment(id) {
  if (id === DEMO_SIM_GARMENT_ID) return createBuiltinDemoGarment();
  const entry = readCollection('garments')[id];
  const garment = unwrapGarment(entry);
  return isGarmentDocument(garment) ? garment : null;
}

export function saveSimGarment(garment) {
  if (!isGarmentDocument(garment)) throw new TypeError('Invalid garment document');
  const saved = structuredClone({ ...garment, updatedAt: Date.now() });
  writeEntry('garments', saved.id, saved, { debounce: false });
  return saved;
}

export function deleteSimGarment(id) {
  if (id === DEMO_SIM_GARMENT_ID) return false;
  deleteEntry('garments', id);
  return true;
}

function unwrapGarment(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.document && typeof entry.document === 'object' ? entry.document : entry;
}

function isGarmentDocument(value) {
  return Boolean(
    value
    && typeof value.id === 'string'
    && value.id.length > 0
    && value.patterns
    && typeof value.patterns === 'object'
    && value.seams
    && typeof value.seams === 'object',
  );
}
