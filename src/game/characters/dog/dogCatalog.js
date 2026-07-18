/**
 * Dog generator catalog.
 *
 * `generatorLineage` values are normalized gameplay-generation weights. They
 * select useful procedural shape priors; they are not genetic ancestry, DNA,
 * breed purity, or medical data.
 *
 * Popularity metadata is intentionally nested so stable breed identity does
 * not depend on an annual ranking. Source: AKC 2025 registration statistics.
 */

export const DOG_LINEAGE_KEYS = Object.freeze([
  'retriever',
  'shepherd',
  'scentHound',
  'mastiff',
  'bulldog',
  'terrier',
  'spitz',
  'toySpaniel',
  'pointer',
  'poodle',
]);

const AKC_2025_SOURCE = 'https://www.akc.org/expert-advice/dog-breeds/most-popular-dog-breeds-2025/';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function lineage(partial) {
  const raw = DOG_LINEAGE_KEYS.map((key) => Math.max(0, Number(partial[key] ?? 0)));
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new Error('Dog generator lineage must contain a positive weight.');
  const out = {};
  let assigned = 0;
  DOG_LINEAGE_KEYS.forEach((key, index) => {
    const value = index === DOG_LINEAGE_KEYS.length - 1
      ? 1 - assigned
      : raw[index] / total;
    out[key] = value;
    assigned += value;
  });
  return Object.freeze(out);
}

export const DOG_FAMILIES = deepFreeze([
  { id: 'retriever-sporting', label: 'Retriever / Sporting', description: 'Balanced field and retrieving silhouettes.' },
  { id: 'herding', label: 'Herding', description: 'Athletic, alert working silhouettes.' },
  { id: 'hound', label: 'Hound', description: 'Scent and pursuit silhouettes.' },
  { id: 'guardian-working', label: 'Guardian / Working', description: 'Substantial guardian and utility silhouettes.' },
  { id: 'brachy-bully', label: 'Brachy / Bully', description: 'Compact, broad-headed silhouettes.' },
  { id: 'terrier', label: 'Terrier', description: 'Compact, square terrier silhouettes and furnishings.' },
  { id: 'spitz', label: 'Spitz', description: 'Plush double coats, erect ears, and curled tails.' },
  { id: 'toy-companion', label: 'Toy / Companion', description: 'Small companion silhouettes.' },
]);

const familyIds = new Set(DOG_FAMILIES.map((family) => family.id));

function breed({
  id,
  label,
  rank,
  familyId,
  akcGroup,
  authored = false,
  size,
  build,
  coat,
  energy,
  trainability,
  weights,
  flags = [],
}) {
  if (!familyIds.has(familyId)) throw new Error(`Unknown dog family ${familyId}`);
  return {
    id,
    label,
    familyId,
    akc: { group: akcGroup },
    popularity: { year: 2025, rank, source: AKC_2025_SOURCE },
    authored,
    summary: { size, build, coat, energy, trainability },
    behavior: { energy, trainability, sociability: 3, vigilance: 3 },
    generatorLineage: lineage(weights),
    conformationFlags: [...flags],
  };
}

export const DOG_BREEDS = deepFreeze([
  breed({ id: 'french-bulldog', label: 'French Bulldog', rank: 1, familyId: 'brachy-bully', akcGroup: 'Non-Sporting', authored: true, size: 'Small', build: 'Compact', coat: 'Short', energy: 3, trainability: 3, weights: { bulldog: 0.72, mastiff: 0.12, toySpaniel: 0.1, terrier: 0.06 }, flags: ['brachycephalic', 'compact-spine', 'heat-sensitive-conformation'] }),
  breed({ id: 'labrador-retriever', label: 'Labrador Retriever', rank: 2, familyId: 'retriever-sporting', akcGroup: 'Sporting', authored: true, size: 'Large', build: 'Athletic', coat: 'Short double', energy: 4, trainability: 5, weights: { retriever: 0.76, pointer: 0.14, shepherd: 0.04, poodle: 0.03, mastiff: 0.03 } }),
  breed({ id: 'golden-retriever', label: 'Golden Retriever', rank: 3, familyId: 'retriever-sporting', akcGroup: 'Sporting', authored: true, size: 'Large', build: 'Balanced', coat: 'Long double', energy: 4, trainability: 5, weights: { retriever: 0.78, pointer: 0.08, shepherd: 0.04, toySpaniel: 0.03, poodle: 0.04, spitz: 0.03 } }),
  breed({ id: 'german-shepherd-dog', label: 'German Shepherd Dog', rank: 4, familyId: 'herding', akcGroup: 'Herding', authored: true, size: 'Large', build: 'Athletic', coat: 'Medium double', energy: 5, trainability: 5, weights: { shepherd: 0.82, spitz: 0.08, mastiff: 0.04, pointer: 0.04, retriever: 0.02 }, flags: ['sloped-topline-variation'] }),
  breed({ id: 'dachshund', label: 'Dachshund', rank: 5, familyId: 'hound', akcGroup: 'Hound', authored: true, size: 'Small', build: 'Long and low', coat: 'Smooth', energy: 3, trainability: 3, weights: { scentHound: 0.76, terrier: 0.12, toySpaniel: 0.05, bulldog: 0.03, retriever: 0.04 }, flags: ['long-spine', 'short-limbs'] }),
  breed({ id: 'poodle', label: 'Poodle', rank: 6, familyId: 'retriever-sporting', akcGroup: 'Non-Sporting', authored: true, size: 'Variable', build: 'Square', coat: 'Curly', energy: 4, trainability: 5, weights: { poodle: 0.76, retriever: 0.14, toySpaniel: 0.04, pointer: 0.03, shepherd: 0.03 }, flags: ['high-grooming'] }),
  breed({ id: 'beagle', label: 'Beagle', rank: 7, familyId: 'hound', akcGroup: 'Hound', authored: true, size: 'Medium', build: 'Compact', coat: 'Short', energy: 4, trainability: 3, weights: { scentHound: 0.82, retriever: 0.05, terrier: 0.04, pointer: 0.05, toySpaniel: 0.04 } }),
  breed({ id: 'rottweiler', label: 'Rottweiler', rank: 8, familyId: 'guardian-working', akcGroup: 'Working', authored: true, size: 'Large', build: 'Powerful', coat: 'Short double', energy: 4, trainability: 4, weights: { mastiff: 0.62, shepherd: 0.18, bulldog: 0.08, retriever: 0.04, terrier: 0.03, pointer: 0.05 }, flags: ['heavy-build'] }),
  breed({ id: 'german-shorthaired-pointer', label: 'German Shorthaired Pointer', rank: 9, familyId: 'retriever-sporting', akcGroup: 'Sporting', authored: true, size: 'Large', build: 'Lean athletic', coat: 'Short', energy: 5, trainability: 4, weights: { pointer: 0.78, retriever: 0.1, scentHound: 0.05, shepherd: 0.03, poodle: 0.04 } }),
  breed({ id: 'bulldog', label: 'Bulldog', rank: 10, familyId: 'brachy-bully', akcGroup: 'Non-Sporting', authored: true, size: 'Medium', build: 'Heavy compact', coat: 'Short', energy: 2, trainability: 3, weights: { bulldog: 0.78, mastiff: 0.15, terrier: 0.03, toySpaniel: 0.04 }, flags: ['brachycephalic', 'heavy-front', 'heat-sensitive-conformation'] }),
  breed({ id: 'cane-corso', label: 'Cane Corso', rank: 11, familyId: 'guardian-working', akcGroup: 'Working', authored: true, size: 'Giant', build: 'Muscular', coat: 'Short', energy: 4, trainability: 4, weights: { mastiff: 0.8, shepherd: 0.08, bulldog: 0.07, pointer: 0.03, retriever: 0.02 }, flags: ['heavy-build'] }),
  breed({ id: 'cavalier-king-charles-spaniel', label: 'Cavalier King Charles Spaniel', rank: 12, familyId: 'toy-companion', akcGroup: 'Toy', authored: true, size: 'Small', build: 'Graceful', coat: 'Silky', energy: 3, trainability: 4, weights: { toySpaniel: 0.76, retriever: 0.08, scentHound: 0.04, poodle: 0.06, spitz: 0.03, terrier: 0.03 }, flags: ['high-grooming'] }),
  breed({ id: 'yorkshire-terrier', label: 'Yorkshire Terrier', rank: 13, familyId: 'terrier', akcGroup: 'Toy', authored: true, size: 'Toy', build: 'Compact', coat: 'Long silky', energy: 4, trainability: 3, weights: { terrier: 0.7, toySpaniel: 0.18, poodle: 0.05, spitz: 0.04, scentHound: 0.03 }, flags: ['high-grooming'] }),
  breed({ id: 'australian-shepherd', label: 'Australian Shepherd', rank: 14, familyId: 'herding', akcGroup: 'Herding', authored: true, size: 'Medium', build: 'Agile', coat: 'Medium double', energy: 5, trainability: 5, weights: { shepherd: 0.76, retriever: 0.08, spitz: 0.08, pointer: 0.04, poodle: 0.04 } }),
  breed({ id: 'doberman-pinscher', label: 'Doberman Pinscher', rank: 15, familyId: 'guardian-working', akcGroup: 'Working', authored: true, size: 'Large', build: 'Lean powerful', coat: 'Short', energy: 5, trainability: 5, weights: { shepherd: 0.38, mastiff: 0.3, terrier: 0.12, pointer: 0.12, scentHound: 0.04, retriever: 0.04 } }),
  breed({ id: 'pembroke-welsh-corgi', label: 'Pembroke Welsh Corgi', rank: 16, familyId: 'herding', akcGroup: 'Herding', authored: true, size: 'Small', build: 'Long and low', coat: 'Medium double', energy: 4, trainability: 4, weights: { shepherd: 0.64, spitz: 0.18, scentHound: 0.06, terrier: 0.06, toySpaniel: 0.06 }, flags: ['short-limbs'] }),
  breed({ id: 'miniature-schnauzer', label: 'Miniature Schnauzer', rank: 17, familyId: 'terrier', akcGroup: 'Terrier', authored: true, size: 'Small', build: 'Square', coat: 'Wiry double', energy: 4, trainability: 4, weights: { terrier: 0.68, poodle: 0.1, shepherd: 0.08, toySpaniel: 0.05, spitz: 0.04, scentHound: 0.05 }, flags: ['high-grooming', 'furnishings'] }),
  breed({ id: 'boxer', label: 'Boxer', rank: 18, familyId: 'brachy-bully', akcGroup: 'Working', authored: true, size: 'Large', build: 'Muscular athletic', coat: 'Short', energy: 5, trainability: 4, weights: { bulldog: 0.38, mastiff: 0.32, shepherd: 0.12, pointer: 0.1, terrier: 0.04, retriever: 0.04 }, flags: ['brachycephalic'] }),
  breed({ id: 'pomeranian', label: 'Pomeranian', rank: 19, familyId: 'spitz', akcGroup: 'Toy', authored: true, size: 'Toy', build: 'Compact', coat: 'Long double', energy: 4, trainability: 4, weights: { spitz: 0.78, toySpaniel: 0.12, terrier: 0.04, poodle: 0.03, shepherd: 0.03 }, flags: ['high-grooming', 'plume-tail'] }),
  breed({ id: 'bernese-mountain-dog', label: 'Bernese Mountain Dog', rank: 20, familyId: 'guardian-working', akcGroup: 'Working', authored: true, size: 'Giant', build: 'Substantial', coat: 'Long double', energy: 3, trainability: 4, weights: { mastiff: 0.48, shepherd: 0.2, retriever: 0.14, spitz: 0.08, pointer: 0.05, scentHound: 0.05 }, flags: ['heavy-build', 'high-grooming'] }),
  breed({ id: 'shih-tzu', label: 'Shih Tzu', rank: 21, familyId: 'toy-companion', akcGroup: 'Toy', authored: true, size: 'Toy', build: 'Compact', coat: 'Long', energy: 2, trainability: 3, weights: { toySpaniel: 0.62, poodle: 0.12, spitz: 0.1, bulldog: 0.08, terrier: 0.04, scentHound: 0.04 }, flags: ['brachycephalic', 'high-grooming'] }),
  breed({ id: 'great-dane', label: 'Great Dane', rank: 22, familyId: 'guardian-working', akcGroup: 'Working', authored: true, size: 'Giant', build: 'Tall athletic', coat: 'Short', energy: 3, trainability: 4, weights: { mastiff: 0.58, pointer: 0.17, shepherd: 0.1, scentHound: 0.06, retriever: 0.05, bulldog: 0.04 }, flags: ['giant-scale'] }),
  breed({ id: 'boston-terrier', label: 'Boston Terrier', rank: 23, familyId: 'brachy-bully', akcGroup: 'Non-Sporting', authored: true, size: 'Small', build: 'Compact', coat: 'Short', energy: 4, trainability: 4, weights: { bulldog: 0.48, terrier: 0.32, toySpaniel: 0.1, mastiff: 0.06, shepherd: 0.04 }, flags: ['brachycephalic'] }),
  breed({ id: 'chihuahua', label: 'Chihuahua', rank: 24, familyId: 'toy-companion', akcGroup: 'Toy', authored: true, size: 'Toy', build: 'Fine-boned', coat: 'Smooth', energy: 4, trainability: 3, weights: { toySpaniel: 0.62, terrier: 0.12, spitz: 0.1, scentHound: 0.05, bulldog: 0.04, shepherd: 0.04, poodle: 0.03 }, flags: ['toy-scale', 'open-fontanel-conformation'] }),
  breed({ id: 'havanese', label: 'Havanese', rank: 25, familyId: 'toy-companion', akcGroup: 'Toy', size: 'Small', build: 'Sturdy', coat: 'Long silky', energy: 3, trainability: 4, weights: { toySpaniel: 0.5, poodle: 0.22, terrier: 0.08, spitz: 0.08, retriever: 0.05, scentHound: 0.04, shepherd: 0.03 }, flags: ['high-grooming'] }),
  // Authored catalog extension outside the source article's ranked top 25.
  breed({ id: 'siberian-husky', label: 'Siberian Husky', rank: null, familyId: 'spitz', akcGroup: 'Working', authored: true, size: 'Medium', build: 'Endurance athletic', coat: 'Medium double', energy: 5, trainability: 3, weights: { spitz: 0.82, shepherd: 0.08, pointer: 0.04, retriever: 0.03, scentHound: 0.03 }, flags: ['cold-climate-double-coat'] }),
]);

export const AUTHORED_DOG_BREED_IDS = Object.freeze(
  DOG_BREEDS.filter((breedInfo) => breedInfo.authored).map((breedInfo) => breedInfo.id),
);

const breedById = new Map(DOG_BREEDS.map((breedInfo) => [breedInfo.id, breedInfo]));
const familyById = new Map(DOG_FAMILIES.map((family) => [family.id, family]));

export function getDogBreed(id) {
  return breedById.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

export function getDogFamily(id) {
  return familyById.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

export function normalizeDogBreedId(id, fallback = 'golden-retriever') {
  return getDogBreed(id)?.id ?? getDogBreed(fallback)?.id ?? 'golden-retriever';
}

/** Rendering boundary: catalog-only breeds deliberately fall back to Golden. */
export function normalizeRenderableDogBreedId(id) {
  const candidate = getDogBreed(id);
  return candidate?.authored ? candidate.id : 'golden-retriever';
}

export function getAuthoredDogBreeds(familyId = null) {
  return DOG_BREEDS.filter((breedInfo) => (
    breedInfo.authored && (!familyId || breedInfo.familyId === familyId)
  ));
}
