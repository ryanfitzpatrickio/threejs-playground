/**
 * Animal / dog generator catalog.
 *
 * Hierarchy (UI + data):
 *   Order → Species (taxonomic family) → Family (silhouette bucket) → Breed → Variant → Seed
 *
 * `ANIMAL_SPECIES` is the master list of taxonomic families we intend to
 * support (terrestrial quadrupeds + Aves MVP + Insecta catalog). Many entries
 * stay visible so authoring can fill the catalog over time.
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

// ---------------------------------------------------------------------------
// Super-category: taxonomic orders + species (biological families)
// ---------------------------------------------------------------------------

/** Orders that host classic dog-like / horse-like terrestrial quadrupeds + Aves + Insecta. */
export const ANIMAL_ORDERS = deepFreeze([
  {
    id: 'carnivora',
    label: 'Carnivora',
    description: 'Terrestrial carnivorans only — dog-like, cat-like, weasel-like forms. Excludes pinnipeds.',
  },
  {
    id: 'rodentia',
    label: 'Rodentia',
    description: 'Rodents — squirrel, mouse/rat, and specialized forms. Largest mammal order.',
  },
  {
    id: 'perissodactyla',
    label: 'Perissodactyla',
    description: 'Odd-toed ungulates — horse-like group (horses, rhinos, tapirs).',
  },
  {
    id: 'artiodactyla',
    label: 'Artiodactyla',
    description: 'Terrestrial even-toed ungulates — antelope-like, pig-like, camel-like forms.',
  },
  {
    id: 'aves',
    label: 'Aves',
    description: 'Birds — shared bird-rigged.glb mesh + embedded Flap/Glide/Idle/Walk clips (MVP).',
  },
  {
    id: 'insecta',
    label: 'Insecta',
    description: 'Insects — catalog by body plan (beetle, hymenopteran, fly, orthopteran, …). Mesh/rig TBD; breeds are authored catalog entries only.',
  },
]);

/**
 * Master species list (taxonomic families). Every entry is listed even when
 * no silhouette family or authored breed exists yet (`populated` is derived).
 *
 * Ids are lowercase biological family names. Labels keep Latin family spelling.
 */
export const ANIMAL_SPECIES = deepFreeze([
  // Order Carnivora — terrestrial families (13)
  {
    id: 'canidae',
    label: 'Canidae',
    orderId: 'carnivora',
    description: 'Dogs, wolves, foxes, jackals, and related canids.',
    examples: 'dogs, wolves, foxes, jackals',
  },
  {
    id: 'felidae',
    label: 'Felidae',
    orderId: 'carnivora',
    description: 'Cats — domestic and wild felids.',
    examples: 'domestic cats, lions, tigers, leopards',
  },
  {
    id: 'ursidae',
    label: 'Ursidae',
    orderId: 'carnivora',
    description: 'Bears — plantigrade carnivorans with massive bodies and short tails.',
    examples: 'brown bear, polar bear, giant panda, black bear, sun bear',
  },
  {
    id: 'mustelidae',
    label: 'Mustelidae',
    orderId: 'carnivora',
    description: 'Weasels, otters, badgers, martens, wolverines.',
    examples: 'weasels, otters, badgers, martens, wolverines',
  },
  {
    id: 'procyonidae',
    label: 'Procyonidae',
    orderId: 'carnivora',
    description: 'Raccoons and relatives — plantigrade / semi-plantigrade New World carnivorans.',
    examples: 'raccoons, coatis, kinkajous, olingos, ringtails',
  },
  {
    id: 'mephitidae',
    label: 'Mephitidae',
    orderId: 'carnivora',
    description: 'Skunks and stink badgers.',
    examples: 'skunks, stink badgers',
  },
  {
    id: 'ailuridae',
    label: 'Ailuridae',
    orderId: 'carnivora',
    description: 'Red panda.',
    examples: 'red panda',
  },
  {
    id: 'viverridae',
    label: 'Viverridae',
    orderId: 'carnivora',
    description: 'Civets, genets, oyans.',
    examples: 'civets, genets, oyans',
  },
  {
    id: 'herpestidae',
    label: 'Herpestidae',
    orderId: 'carnivora',
    description: 'Mongooses.',
    examples: 'mongooses',
  },
  {
    id: 'hyaenidae',
    label: 'Hyaenidae',
    orderId: 'carnivora',
    description: 'Hyenas and aardwolf.',
    examples: 'hyenas, aardwolf',
  },
  {
    id: 'eupleridae',
    label: 'Eupleridae',
    orderId: 'carnivora',
    description: 'Malagasy carnivores.',
    examples: 'fossa, falanouc',
  },
  {
    id: 'nandiniidae',
    label: 'Nandiniidae',
    orderId: 'carnivora',
    description: 'African palm civet.',
    examples: 'African palm civet',
  },
  {
    id: 'prionodontidae',
    label: 'Prionodontidae',
    orderId: 'carnivora',
    description: 'Asiatic linsangs.',
    examples: 'Asiatic linsangs',
  },

  // Order Rodentia — classic terrestrial / arboreal body plans first, then specialized
  {
    id: 'sciuridae',
    label: 'Sciuridae',
    orderId: 'rodentia',
    description: 'Squirrels — tree squirrels, ground squirrels, chipmunks, marmots, prairie dogs, flying squirrels.',
    examples: 'grey squirrel, chipmunk, marmot, prairie dog',
    bodyPlan: 'squirrel',
  },
  {
    id: 'muridae',
    label: 'Muridae',
    orderId: 'rodentia',
    description: 'True mice and rats — largest rodent family (Old World mice, rats, gerbils).',
    examples: 'house mouse, Norway rat, gerbil',
    bodyPlan: 'mouse-rat',
  },
  {
    id: 'cricetidae',
    label: 'Cricetidae',
    orderId: 'rodentia',
    description: 'New World mice, voles, hamsters, lemmings, cotton rats.',
    examples: 'deer mouse, vole, hamster, lemming',
    bodyPlan: 'mouse-rat',
  },
  {
    id: 'heteromyidae',
    label: 'Heteromyidae',
    orderId: 'rodentia',
    description: 'Kangaroo rats and pocket mice.',
    examples: 'kangaroo rat, pocket mouse',
    bodyPlan: 'jumping',
  },
  {
    id: 'dipodidae',
    label: 'Dipodidae',
    orderId: 'rodentia',
    description: 'Jerboas, birch mice, jumping mice.',
    examples: 'jerboa, jumping mouse',
    bodyPlan: 'jumping',
  },
  {
    id: 'gliridae',
    label: 'Gliridae',
    orderId: 'rodentia',
    description: 'Dormice.',
    examples: 'dormouse',
    bodyPlan: 'mouse-rat',
  },
  {
    id: 'spalacidae',
    label: 'Spalacidae',
    orderId: 'rodentia',
    description: 'Blind mole-rats, bamboo rats, zokors.',
    examples: 'mole-rat, bamboo rat',
    bodyPlan: 'fossorial',
  },
  {
    id: 'nesomyidae',
    label: 'Nesomyidae',
    orderId: 'rodentia',
    description: 'African and Malagasy rodents — climbing mice, giant pouched rats.',
    examples: 'giant pouched rat, climbing mouse',
    bodyPlan: 'mouse-rat',
  },
  {
    id: 'geomyidae',
    label: 'Geomyidae',
    orderId: 'rodentia',
    description: 'Pocket gophers.',
    examples: 'pocket gopher',
    bodyPlan: 'fossorial',
  },
  {
    id: 'castoridae',
    label: 'Castoridae',
    orderId: 'rodentia',
    description: 'Beavers.',
    examples: 'beaver',
    bodyPlan: 'semiaquatic',
  },
  {
    id: 'caviidae',
    label: 'Caviidae',
    orderId: 'rodentia',
    description: 'Guinea pigs, cavies, capybaras, maras.',
    examples: 'guinea pig, capybara, mara',
    bodyPlan: 'cavy',
  },
  {
    id: 'chinchillidae',
    label: 'Chinchillidae',
    orderId: 'rodentia',
    description: 'Chinchillas and viscachas.',
    examples: 'chinchilla, viscacha',
    bodyPlan: 'cavy',
  },
  {
    id: 'erethizontidae',
    label: 'Erethizontidae',
    orderId: 'rodentia',
    description: 'New World porcupines.',
    examples: 'North American porcupine',
    bodyPlan: 'porcupine',
  },
  {
    id: 'hystricidae',
    label: 'Hystricidae',
    orderId: 'rodentia',
    description: 'Old World porcupines.',
    examples: 'crested porcupine',
    bodyPlan: 'porcupine',
  },
  {
    id: 'bathyergidae',
    label: 'Bathyergidae',
    orderId: 'rodentia',
    description: 'African mole-rats (naked mole-rat and relatives).',
    examples: 'naked mole-rat',
    bodyPlan: 'fossorial',
  },

  // Order Perissodactyla — odd-toed ungulates (3)
  {
    id: 'equidae',
    label: 'Equidae',
    orderId: 'perissodactyla',
    description: 'Horses, zebras, asses/donkeys. Shared dog skeleton + horse-sourced clip pack (equid library).',
    examples: 'horses, zebras, donkeys',
  },
  {
    id: 'rhinocerotidae',
    label: 'Rhinocerotidae',
    orderId: 'perissodactyla',
    description: 'Rhinoceroses. Shared dog skeleton + horse-sourced equid clips; solid-hoof + horn proxy.',
    examples: 'rhinoceroses',
  },
  {
    id: 'tapiridae',
    label: 'Tapiridae',
    orderId: 'perissodactyla',
    description: 'Tapirs. Shared dog skeleton + horse-sourced equid clips; solid-hoof body plan.',
    examples: 'tapirs',
  },

  // Order Artiodactyla — terrestrial even-toed ungulates (10)
  {
    id: 'bovidae',
    label: 'Bovidae',
    orderId: 'artiodactyla',
    description: 'Cattle, bison, antelopes, goats, sheep, gazelles — largest ungulate family.',
    examples: 'cattle, bison, antelopes, goats, sheep, gazelles',
  },
  {
    id: 'cervidae',
    label: 'Cervidae',
    orderId: 'artiodactyla',
    description: 'Deer, moose, elk, reindeer, muntjacs.',
    examples: 'deer, moose, elk, reindeer, muntjacs',
  },
  {
    id: 'camelidae',
    label: 'Camelidae',
    orderId: 'artiodactyla',
    description: 'Camels, llamas, alpacas, guanacos, vicuñas.',
    examples: 'camels, llamas, alpacas',
  },
  {
    id: 'suidae',
    label: 'Suidae',
    orderId: 'artiodactyla',
    description: 'Pigs and warthogs.',
    examples: 'pigs, warthogs',
  },
  {
    id: 'tayassuidae',
    label: 'Tayassuidae',
    orderId: 'artiodactyla',
    description: 'Peccaries.',
    examples: 'peccaries',
  },
  {
    id: 'hippopotamidae',
    label: 'Hippopotamidae',
    orderId: 'artiodactyla',
    description: 'Hippopotamuses. Shared dog skeleton + horse-sourced equid clips; massive barrel silhouette.',
    examples: 'hippopotamuses',
  },
  {
    id: 'giraffidae',
    label: 'Giraffidae',
    orderId: 'artiodactyla',
    description: 'Giraffes and okapi. Shared dog skeleton + horse-sourced equid clips; extreme neck scale.',
    examples: 'giraffes, okapi',
  },
  {
    id: 'moschidae',
    label: 'Moschidae',
    orderId: 'artiodactyla',
    description: 'Musk deer.',
    examples: 'musk deer',
  },
  {
    id: 'tragulidae',
    label: 'Tragulidae',
    orderId: 'artiodactyla',
    description: 'Chevrotains / mouse-deer.',
    examples: 'chevrotains, mouse-deer',
  },
  {
    id: 'antilocapridae',
    label: 'Antilocapridae',
    orderId: 'artiodactyla',
    description: 'Pronghorn.',
    examples: 'pronghorn',
  },

  // Order Aves — top bird families by species richness (AviList / IOC-aligned, ~2025–2026)
  {
    id: 'tyrannidae',
    label: 'Tyrannidae',
    orderId: 'aves',
    description: 'Tyrant flycatchers — largest bird family (~400–450 spp.).',
    examples: 'eastern phoebe, great kiskadee, scissor-tailed flycatcher',
    bodyPlan: 'passerine',
  },
  {
    id: 'thraupidae',
    label: 'Thraupidae',
    orderId: 'aves',
    description: 'Tanagers — colorful Neotropical songbirds (~370–385 spp.).',
    examples: 'blue-gray tanager, paradise tanager, bananaquit',
    bodyPlan: 'passerine',
  },
  {
    id: 'trochilidae',
    label: 'Trochilidae',
    orderId: 'aves',
    description: 'Hummingbirds — hovering nectarivores (~360 spp.).',
    examples: 'ruby-throated hummingbird, anna\'s hummingbird, sword-billed hummingbird',
    bodyPlan: 'hummingbird',
  },
  {
    id: 'columbidae',
    label: 'Columbidae',
    orderId: 'aves',
    description: 'Pigeons and doves (~350 spp.).',
    examples: 'rock pigeon, mourning dove, Victoria crowned pigeon',
    bodyPlan: 'pigeon',
  },
  {
    id: 'muscicapidae',
    label: 'Muscicapidae',
    orderId: 'aves',
    description: 'Old World flycatchers and chats (~340 spp.).',
    examples: 'European robin, nightingale, pied flycatcher',
    bodyPlan: 'passerine',
  },
  {
    id: 'furnariidae',
    label: 'Furnariidae',
    orderId: 'aves',
    description: 'Ovenbirds and woodcreepers (~300+ spp.).',
    examples: 'rufous hornero, plain-brown woodcreeper',
    bodyPlan: 'passerine',
  },
  {
    id: 'accipitridae',
    label: 'Accipitridae',
    orderId: 'aves',
    description: 'Hawks, eagles, and kites (~250 spp.).',
    examples: 'red-tailed hawk, bald eagle, red kite',
    bodyPlan: 'raptor',
  },
  {
    id: 'fringillidae',
    label: 'Fringillidae',
    orderId: 'aves',
    description: 'Finches and euphonias (~230 spp.).',
    examples: 'house finch, American goldfinch, Eurasian bullfinch',
    bodyPlan: 'passerine',
  },
  {
    id: 'anatidae',
    label: 'Anatidae',
    orderId: 'aves',
    description: 'Ducks, geese, and swans (~170 spp.).',
    examples: 'mallard, Canada goose, mute swan',
    bodyPlan: 'waterfowl',
  },
  {
    id: 'psittacidae',
    label: 'Psittacidae',
    orderId: 'aves',
    description: 'New World and African parrots (~170 spp.).',
    examples: 'scarlet macaw, African grey, budgerigar',
    bodyPlan: 'parrot',
  },

  // Order Insecta — iconic families by body-plan group (catalog MVP; no insect mesh yet)
  // 1–4 Oval / armored / dome-shaped (beetles)
  {
    id: 'coccinellidae',
    label: 'Coccinellidae',
    orderId: 'insecta',
    description: 'Lady beetles — domed oval elytra, often spotted.',
    examples: 'seven-spotted ladybug, Asian lady beetle',
    bodyPlan: 'beetle',
  },
  {
    id: 'scarabaeidae',
    label: 'Scarabaeidae',
    orderId: 'insecta',
    description: 'Scarabs and June beetles — stout oval bodies, clubbed antennae.',
    examples: 'Japanese beetle, June beetle, dung beetle',
    bodyPlan: 'beetle',
  },
  {
    id: 'curculionidae',
    label: 'Curculionidae',
    orderId: 'insecta',
    description: 'Weevils — elongated snout (rostrum), hard elytra.',
    examples: 'acorn weevil, boll weevil',
    bodyPlan: 'beetle',
  },
  {
    id: 'carabidae',
    label: 'Carabidae',
    orderId: 'insecta',
    description: 'Ground beetles — flattened cursorial predators with long legs.',
    examples: 'ground beetle, bombardier beetle',
    bodyPlan: 'beetle',
  },
  // 5–8 Narrow-waisted / segmented (bees, wasps, ants)
  {
    id: 'apidae',
    label: 'Apidae',
    orderId: 'insecta',
    description: 'Bees — hairy pollen-carrying hymenopterans with a petiole waist.',
    examples: 'honey bee, bumblebee, carpenter bee',
    bodyPlan: 'hymenopteran',
  },
  {
    id: 'vespidae',
    label: 'Vespidae',
    orderId: 'insecta',
    description: 'Social and solitary wasps — yellowjackets, hornets, paper wasps.',
    examples: 'yellowjacket, European hornet, paper wasp',
    bodyPlan: 'hymenopteran',
  },
  {
    id: 'formicidae',
    label: 'Formicidae',
    orderId: 'insecta',
    description: 'Ants — eusocial hymenopterans with elbowed antennae and a petiole.',
    examples: 'pavement ant, carpenter ant, fire ant',
    bodyPlan: 'hymenopteran',
  },
  {
    id: 'ichneumonidae',
    label: 'Ichneumonidae',
    orderId: 'insecta',
    description: 'Ichneumon wasps — slender parasitoids, often with a long ovipositor.',
    examples: 'ichneumon wasp, giant ichneumon',
    bodyPlan: 'hymenopteran',
  },
  // 9–11 Streamlined / two-winged (flies & mosquitoes)
  {
    id: 'muscidae',
    label: 'Muscidae',
    orderId: 'insecta',
    description: 'House flies and allies — compact two-winged scavengers.',
    examples: 'house fly, stable fly',
    bodyPlan: 'fly',
  },
  {
    id: 'culicidae',
    label: 'Culicidae',
    orderId: 'insecta',
    description: 'Mosquitoes — slender piercing-sucking dipterans with long legs.',
    examples: 'Anopheles, Aedes, Culex',
    bodyPlan: 'fly',
  },
  {
    id: 'syrphidae',
    label: 'Syrphidae',
    orderId: 'insecta',
    description: 'Hoverflies — bee/wasp mimics that hover and feed on nectar.',
    examples: 'drone fly, marmalade hoverfly',
    bodyPlan: 'fly',
  },
  // 12–14 Jumping / elongated hind legs (grasshoppers & crickets)
  {
    id: 'acrididae',
    label: 'Acrididae',
    orderId: 'insecta',
    description: 'Short-horned grasshoppers and locusts — powerful saltatory hind legs.',
    examples: 'differential grasshopper, migratory locust',
    bodyPlan: 'orthopteran',
  },
  {
    id: 'gryllidae',
    label: 'Gryllidae',
    orderId: 'insecta',
    description: 'True crickets — long antennae, chirping stridulation.',
    examples: 'field cricket, house cricket',
    bodyPlan: 'orthopteran',
  },
  {
    id: 'tettigoniidae',
    label: 'Tettigoniidae',
    orderId: 'insecta',
    description: 'Katydids / bush crickets — leaf-like wings, very long antennae.',
    examples: 'common true katydid, fork-tailed bush katydid',
    bodyPlan: 'orthopteran',
  },
  // 15–16 Flat / scuttling
  {
    id: 'blattidae',
    label: 'Blattidae',
    orderId: 'insecta',
    description: 'Large cockroaches — flattened oval runners.',
    examples: 'American cockroach, Oriental cockroach',
    bodyPlan: 'roach',
  },
  {
    id: 'rhinotermitidae',
    label: 'Rhinotermitidae',
    orderId: 'insecta',
    description: 'Subterranean termites — soft-bodied eusocial wood feeders.',
    examples: 'eastern subterranean termite',
    bodyPlan: 'termite',
  },
  // 17–19 Large-winged / delicate (butterflies & moths)
  {
    id: 'nymphalidae',
    label: 'Nymphalidae',
    orderId: 'insecta',
    description: 'Brush-footed butterflies — large colorful wings, reduced forelegs.',
    examples: 'monarch, painted lady, fritillary',
    bodyPlan: 'lepidopteran',
  },
  {
    id: 'saturniidae',
    label: 'Saturniidae',
    orderId: 'insecta',
    description: 'Giant silk moths — broad delicate wings, often tailed hindwings.',
    examples: 'luna moth, polyphemus moth, atlas moth',
    bodyPlan: 'lepidopteran',
  },
  {
    id: 'sphingidae',
    label: 'Sphingidae',
    orderId: 'insecta',
    description: 'Sphinx / hawk moths — heavy-bodied, powerful rapid fliers.',
    examples: 'tobacco hornworm moth, white-lined sphinx',
    bodyPlan: 'lepidopteran',
  },
  // 20–21 Long-bodied aerial (dragonflies)
  {
    id: 'libellulidae',
    label: 'Libellulidae',
    orderId: 'insecta',
    description: 'Skimmer dragonflies — long abdomen, two pairs of outstretched wings.',
    examples: 'common whitetail, twelve-spotted skimmer',
    bodyPlan: 'odonate',
  },
  {
    id: 'coenagrionidae',
    label: 'Coenagrionidae',
    orderId: 'insecta',
    description: 'Narrow-winged damselflies — slender body, wings folded at rest.',
    examples: 'familiar bluet, eastern forktail',
    bodyPlan: 'odonate',
  },
  // 22–23 Raptorial / ambush
  {
    id: 'mantidae',
    label: 'Mantidae',
    orderId: 'insecta',
    description: 'Praying mantises — raptorial forelegs, elongated prothorax.',
    examples: 'Chinese mantis, Carolina mantis',
    bodyPlan: 'mantis',
  },
  // 24–25 Specialized camouflage & others
  {
    id: 'phasmatidae',
    label: 'Phasmatidae',
    orderId: 'insecta',
    description: 'Stick insects — elongated twig-mimic body.',
    examples: 'northern walkingstick, Indian stick insect',
    bodyPlan: 'phasmid',
  },
  {
    id: 'cicadidae',
    label: 'Cicadidae',
    orderId: 'insecta',
    description: 'Cicadas — stout-bodied hemipterans with clear wings and loud song.',
    examples: 'periodical cicada, dog-day cicada',
    bodyPlan: 'cicada',
  },
]);

const speciesIds = new Set(ANIMAL_SPECIES.map((species) => species.id));
const orderIds = new Set(ANIMAL_ORDERS.map((order) => order.id));

// Sanity: every species orderId must exist.
for (const entry of ANIMAL_SPECIES) {
  if (!orderIds.has(entry.orderId)) throw new Error(`Unknown order ${entry.orderId} on species ${entry.id}`);
}

/**
 * Silhouette / gameplay families nested under a taxonomic species.
 * Existing dog groups live under Canidae; feline under Felidae; raccoon under Procyonidae.
 */
export const DOG_FAMILIES = deepFreeze([
  // Canidae — domestic / working dog silhouette buckets
  { id: 'retriever-sporting', speciesId: 'canidae', label: 'Retriever / Sporting', description: 'Balanced field and retrieving silhouettes.' },
  { id: 'herding', speciesId: 'canidae', label: 'Herding', description: 'Athletic, alert working silhouettes.' },
  { id: 'hound', speciesId: 'canidae', label: 'Hound', description: 'Scent and pursuit silhouettes.' },
  { id: 'guardian-working', speciesId: 'canidae', label: 'Guardian / Working', description: 'Substantial guardian and utility silhouettes.' },
  { id: 'brachy-bully', speciesId: 'canidae', label: 'Brachy / Bully', description: 'Compact, broad-headed silhouettes.' },
  { id: 'terrier', speciesId: 'canidae', label: 'Terrier', description: 'Compact, square terrier silhouettes and furnishings.' },
  { id: 'spitz', speciesId: 'canidae', label: 'Spitz', description: 'Plush double coats, erect ears, and curled tails.' },
  { id: 'toy-companion', speciesId: 'canidae', label: 'Toy / Companion', description: 'Small companion silhouettes.' },
  // Canidae — wild / AI-authored canids (no breeds yet; recipe familyId target)
  { id: 'wild-canid', speciesId: 'canidae', label: 'Wild canid', description: 'Fox, wolf, coyote, and other wild canid silhouettes (recipes / future breeds).' },
  // Felidae
  { id: 'feline', speciesId: 'felidae', label: 'Domestic feline', description: 'Domestic cats — short muzzle, erect ears, compact body.' },
  // Procyonidae — silhouette buckets (shared dog rig)
  { id: 'raccoon', speciesId: 'procyonidae', label: 'Raccoon', description: 'Compact procyonid silhouette — bandit mask, ringed tail, dexterous paws.' },
  { id: 'coati', speciesId: 'procyonidae', label: 'Coati', description: 'Long-snouted terrestrial procyonid — elongated muzzle, long ringed tail, plantigrade walk.' },
  { id: 'kinkajou', speciesId: 'procyonidae', label: 'Kinkajou', description: 'Arboreal honey-bear silhouette — short muzzle, rounded head, thick prehensile-style tail.' },
  { id: 'ringtail', speciesId: 'procyonidae', label: 'Ringtail', description: 'Cat-like procyonid — slender body, fox face, very long black-and-white ringed tail.' },
  // Ursidae — plantigrade bear silhouette buckets (shared dog rig for now)
  { id: 'ursine', speciesId: 'ursidae', label: 'Ursine', description: 'Classic true-bear silhouette — massive body, short tail, thick limbs, plantigrade read (brown / black / grizzly).' },
  { id: 'polar', speciesId: 'ursidae', label: 'Polar', description: 'Arctic long-limbed bear — elongated neck/legs, white coat, swimming/ambush build.' },
  { id: 'panda', speciesId: 'ursidae', label: 'Panda', description: 'Giant-panda silhouette — cobby body, short muzzle, high-contrast black-and-white markings.' },
  // Bovidae — caprine (goat) silhouette; uses hoof / horn / caprine-eye kits
  { id: 'caprine', speciesId: 'bovidae', label: 'Caprine', description: 'Goats and goat-like bovids — cloven hooves, horns, horizontal pupils, coarse coat.' },
  // Rodentia — silhouette buckets under taxonomic species (clips: Rat.fbx library)
  { id: 'squirrel', speciesId: 'sciuridae', label: 'Squirrel', description: 'Tree/ground squirrel silhouette — bushy tail, alert ears, compact arboreal build.' },
  { id: 'mouse-rat', speciesId: 'muridae', label: 'Mouse / rat', description: 'Classic muridae body plan — pointed muzzle, long tail, scurrying gait.' },
  { id: 'hamster-vole', speciesId: 'cricetidae', label: 'Hamster / vole', description: 'Cricetid silhouette — short muzzle, stockier body, shorter tail than murids.' },
  { id: 'beaver', speciesId: 'castoridae', label: 'Beaver', description: 'Semi-aquatic castorid — heavy body, broad flat tail (future kit).' },
  // Mustelidae — long low tube-body carnivorans (shared dog rig)
  { id: 'mustelid-otter', speciesId: 'mustelidae', label: 'Otter', description: 'Semi-aquatic mustelid — long tube body, webbed paws, thick tail.' },
  { id: 'mustelid-badger', speciesId: 'mustelidae', label: 'Badger', description: 'Stocky fossorial mustelid — flattened body, black-and-white face, dorsal crest.' },
  { id: 'mustelid-weasel', speciesId: 'mustelidae', label: 'Weasel', description: 'Elongated slender mustelid — very long tube body, short tail, tiny ears.' },
  // Mephitidae — skunks
  { id: 'mephitid', speciesId: 'mephitidae', label: 'Skunk', description: 'Black body with twin white dorsal stripes and a big bushy tail.' },
  // Ailuridae — red panda
  { id: 'ailurid', speciesId: 'ailuridae', label: 'Red panda', description: 'Auburn-red arboreal — black underparts, bushy ringed tail, white face mask.' },
  // Viverridae — genets
  { id: 'viverrid', speciesId: 'viverridae', label: 'Genet', description: 'Slender viverrid — spotted grey coat, dark face mask, very long ringed tail.' },
  // Herpestidae — meerkat / mongoose
  { id: 'herpestid', speciesId: 'herpestidae', label: 'Meerkat', description: 'Slender social herpestid — tan coat, long body, tall sentinel posture.' },
  // Hyaenidae — hyenas
  { id: 'hyaenid', speciesId: 'hyaenidae', label: 'Hyena', description: 'Heavy-built carnivoran — sloped back, spotted coat, bristly dorsal crest.' },
  // Caviidae — three silhouette buckets (guinea pig / capybara / mara)
  { id: 'cavid', speciesId: 'caviidae', label: 'Cavy', description: 'Stocky cobby domestic cavy — short legs, no tail, compact head (guinea pig).' },
  { id: 'hydrochoerine', speciesId: 'caviidae', label: 'Capybara', description: 'Largest living rodent — barrel body, short legs, semi-aquatic, stub tail.' },
  { id: 'mara', speciesId: 'caviidae', label: 'Mara', description: 'Long-legged Patagonian cavy — hare-like cursorial build, short tail, upright ears.' },
  // Chinchillidae — chinchilla
  { id: 'chinchillid', speciesId: 'chinchillidae', label: 'Chinchilla', description: 'Ultra-dense silky silver-grey coat, big rounded ears, long bushy tail.' },
  // Erethizontidae — New-World porcupine
  { id: 'erethizontid', speciesId: 'erethizontidae', label: 'Porcupine', description: 'Slow arboreal rodent — dorsal field of banded quills over the back.' },
  // Hystricidae — Old-World crested porcupine (quill kit, longer quills + crest)
  { id: 'hystricid', speciesId: 'hystricidae', label: 'Crested porcupine', description: 'Terrestrial rodent — long quills and a crest over the head/neck.' },
  // Cervidae — deer
  { id: 'cervid', speciesId: 'cervidae', label: 'Deer', description: 'Slender ungulate — long legs, cloven hooves, branched antler rack.' },
  // Camelidae — camel / llama
  { id: 'camelid', speciesId: 'camelidae', label: 'Camelid', description: 'Long-necked ungulate — cloven-hoof (padded), dorsal hump, long legs.' },
  // Suidae — pigs
  { id: 'suid', speciesId: 'suidae', label: 'Pig', description: 'Stocky omnivore — snout disk, cloven hooves, bristly coat; boars carry tusks.' },
  // ── Remaining empty-species fill (1 silhouette family each) ──────────────
  // Carnivora niche
  { id: 'euplerid', speciesId: 'eupleridae', label: 'Fossa', description: 'Malagasy carnivoran — long low cat-like body, short coat, long tapering tail.' },
  { id: 'nandinia', speciesId: 'nandiniidae', label: 'Palm civet', description: 'African palm civet — stocky arboreal frugivore, short muzzle, ringed tail.' },
  { id: 'prionodontid', speciesId: 'prionodontidae', label: 'Linsang', description: 'Asiatic linsang — slender spotted viverrid-like form, very long ringed tail.' },
  // Rodentia niche
  { id: 'heteromyid', speciesId: 'heteromyidae', label: 'Kangaroo rat', description: 'Bipedal desert jumper — huge hind legs, tiny forelimbs, long tufted tail.' },
  { id: 'dipodid', speciesId: 'dipodidae', label: 'Jerboa', description: 'Desert jumping mouse — elongated hind legs, long balancing tail, large ears.' },
  { id: 'glirid', speciesId: 'gliridae', label: 'Dormouse', description: 'Compact arboreal dormouse — soft dense coat, bushy tail, large dark eyes.' },
  { id: 'spalacid', speciesId: 'spalacidae', label: 'Mole-rat', description: 'Fossorial mole-rat — cylindrical body, tiny eyes/ears, short limbs, reduced tail.' },
  { id: 'nesomyid', speciesId: 'nesomyidae', label: 'Pouched rat', description: 'Giant pouched rat — large muriform rodent, long snout, strong scavenger build.' },
  { id: 'geomyid', speciesId: 'geomyidae', label: 'Pocket gopher', description: 'Fossorial gopher — stocky body, short legs, reduced pinnae, short tail.' },
  { id: 'bathyergid', speciesId: 'bathyergidae', label: 'Naked mole-rat', description: 'Eusocial fossorial rodent — nearly hairless wrinkled skin, cylindrical tube body.' },
  // Perissodactyla
  { id: 'equid', speciesId: 'equidae', label: 'Equid', description: 'Horse / zebra / ass — solid hooves, long limbs, upright mane, long tail.' },
  { id: 'rhinocerotid', speciesId: 'rhinocerotidae', label: 'Rhinoceros', description: 'Massive odd-toed ungulate — barrel body, solid hooves, horned poll, short tail.' },
  { id: 'tapirid', speciesId: 'tapiridae', label: 'Tapir', description: 'Stocky forest ungulate — solid hooves, short trunk-like muzzle, rounded body.' },
  // Artiodactyla remaining
  { id: 'tayassuid', speciesId: 'tayassuidae', label: 'Peccary', description: 'New-World pig relative — compact, bristly, cloven hooves, short snout.' },
  { id: 'hippopotamid', speciesId: 'hippopotamidae', label: 'Hippopotamus', description: 'Semi-aquatic giant — barrel body, huge head, short legs, cloven-style feet.' },
  { id: 'giraffid', speciesId: 'giraffidae', label: 'Giraffe', description: 'Extreme long-neck ungulate — cloven hooves, ossicone headgear, tall legs.' },
  { id: 'moschid', speciesId: 'moschidae', label: 'Musk deer', description: 'Small hornless deer — cloven hooves, elongated canines, compact alpine build.' },
  { id: 'tragulid', speciesId: 'tragulidae', label: 'Mouse-deer', description: 'Tiny chevrotain — delicate legs, cloven hooves, arched back, short tail.' },
  { id: 'antilocaprid', speciesId: 'antilocapridae', label: 'Pronghorn', description: 'Cursorial plains ungulate — cloven hooves, pronged horns, long legs.' },
  // Aves — one silhouette family per taxonomic bird family (shared bird-rigged.glb)
  { id: 'tyrant-flycatcher', speciesId: 'tyrannidae', label: 'Tyrant flycatcher', description: 'Upright passerine perch-and-sally silhouette — short bill, long tail.' },
  { id: 'tanager', speciesId: 'thraupidae', label: 'Tanager', description: 'Stocky colorful songbird — short conical bill, medium tail.' },
  { id: 'hummingbird', speciesId: 'trochilidae', label: 'Hummingbird', description: 'Tiny hovering nectarivore — needle bill, blurred wing beat scale.' },
  { id: 'pigeon-dove', speciesId: 'columbidae', label: 'Pigeon / dove', description: 'Compact plump body, small head, short bill, strong wing.' },
  { id: 'old-world-flycatcher', speciesId: 'muscicapidae', label: 'Old World flycatcher', description: 'Small chat/flycatcher — upright perch, fine bill, expressive tail.' },
  { id: 'ovenbird-woodcreeper', speciesId: 'furnariidae', label: 'Ovenbird / woodcreeper', description: 'Neotropical furnariid — strong bill, often longer tail for trunk climbing.' },
  { id: 'hawk-eagle', speciesId: 'accipitridae', label: 'Hawk / eagle', description: 'Raptor silhouette — hooked bill, broad wings, powerful talons.' },
  { id: 'finch', speciesId: 'fringillidae', label: 'Finch', description: 'Seed-eating passerine — stout conical bill, compact body.' },
  { id: 'duck-goose-swan', speciesId: 'anatidae', label: 'Duck / goose / swan', description: 'Waterfowl — flattened bill, webbed feet read, buoyant body.' },
  { id: 'parrot', speciesId: 'psittacidae', label: 'Parrot', description: 'Hooked bill, zygodactyl feet, often vivid plumage and long tail.' },
  // Insecta — one silhouette family per taxonomic family (body-plan groups in species.bodyPlan)
  // Oval / armored / dome (beetles)
  { id: 'ladybug', speciesId: 'coccinellidae', label: 'Ladybug', description: 'Domed oval elytra — spotted lady beetle silhouette.' },
  { id: 'scarab-beetle', speciesId: 'scarabaeidae', label: 'Scarab beetle', description: 'Stout oval scarab — metallic or patterned elytra, clubbed antennae.' },
  { id: 'weevil', speciesId: 'curculionidae', label: 'Weevil', description: 'Hard-bodied beetle with an elongated snout (rostrum).' },
  { id: 'ground-beetle', speciesId: 'carabidae', label: 'Ground beetle', description: 'Flattened cursorial predator — long legs, dark armored body.' },
  // Narrow-waisted (bees, wasps, ants)
  { id: 'honey-bee', speciesId: 'apidae', label: 'Honey bee', description: 'Hairy pollen-carrying bee — striped abdomen, petiole waist.' },
  { id: 'yellowjacket', speciesId: 'vespidae', label: 'Yellowjacket', description: 'Compact social wasp — bold yellow/black bands, short legs.' },
  { id: 'pavement-ant', speciesId: 'formicidae', label: 'Pavement ant', description: 'Small eusocial ant — elbowed antennae, petiole, caste morphs.' },
  { id: 'ichneumon', speciesId: 'ichneumonidae', label: 'Ichneumon', description: 'Slender parasitoid wasp — long body, threadlike antennae, long ovipositor.' },
  // Two-winged (flies)
  { id: 'house-fly', speciesId: 'muscidae', label: 'House fly', description: 'Compact two-winged scavenger — large compound eyes, short antennae.' },
  { id: 'mosquito', speciesId: 'culicidae', label: 'Mosquito', description: 'Slender piercing dipteran — long legs, needle proboscis, scaled wings.' },
  { id: 'hoverfly', speciesId: 'syrphidae', label: 'Hoverfly', description: 'Bee-mimic hoverer — large eyes, hovering wing beat, short antennae.' },
  // Jumping orthopterans
  { id: 'grasshopper', speciesId: 'acrididae', label: 'Grasshopper', description: 'Saltatory hind legs, short antennae, often camouflaged tegmina.' },
  { id: 'field-cricket', speciesId: 'gryllidae', label: 'Field cricket', description: 'Robust cricket — long antennae, chirping wings, jumping hind legs.' },
  { id: 'katydid', speciesId: 'tettigoniidae', label: 'Katydid', description: 'Leaf-winged bush cricket — very long antennae, green camouflage.' },
  // Flat / scuttling
  { id: 'cockroach', speciesId: 'blattidae', label: 'Cockroach', description: 'Flattened oval runner — long antennae, spiny legs, leathery tegmina.' },
  { id: 'termite', speciesId: 'rhinotermitidae', label: 'Termite', description: 'Soft pale eusocial wood-feeder — caste morphs (worker / soldier / alate).' },
  // Butterflies & moths
  { id: 'brushfoot-butterfly', speciesId: 'nymphalidae', label: 'Brush-footed butterfly', description: 'Large colorful wings, slender body, reduced forelegs.' },
  { id: 'silk-moth', speciesId: 'saturniidae', label: 'Giant silk moth', description: 'Broad delicate wings — often pale green with tails (luna).' },
  { id: 'sphinx-moth', speciesId: 'sphingidae', label: 'Sphinx moth', description: 'Heavy-bodied hawk moth — swept-back wings, rapid flight.' },
  // Odonates
  { id: 'dragonfly', speciesId: 'libellulidae', label: 'Dragonfly', description: 'Long abdomen, two pairs of wings held open at rest, large eyes.' },
  { id: 'damselfly', speciesId: 'coenagrionidae', label: 'Damselfly', description: 'Slender odonate — wings usually folded along the body at rest.' },
  // Raptorial
  { id: 'praying-mantis', speciesId: 'mantidae', label: 'Praying mantis', description: 'Elongated prothorax and raptorial forelegs held in a prayer pose.' },
  // Camouflage & others
  { id: 'stick-insect', speciesId: 'phasmatidae', label: 'Stick insect', description: 'Twig-mimic — extremely elongated body and legs.' },
  { id: 'cicada', speciesId: 'cicadidae', label: 'Cicada', description: 'Stout clear-winged hemipteran — broad head, loud tymbals.' },
]);

const familyIds = new Set(DOG_FAMILIES.map((family) => family.id));

for (const family of DOG_FAMILIES) {
  if (!speciesIds.has(family.speciesId)) {
    throw new Error(`Unknown species ${family.speciesId} for family ${family.id}`);
  }
}

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
  // Discrete named subtypes (coat/size), NOT continuous seed noise and NOT
  // separate breed IDs. Omitted → synthetic single 'default' variant so every
  // breed has a uniform Family → Breed → Variant → Seed resolution path.
  variants = null,
  defaultVariantId = 'default',
}) {
  if (!familyIds.has(familyId)) throw new Error(`Unknown dog family ${familyId}`);
  const familyInfo = DOG_FAMILIES.find((family) => family.id === familyId);
  if (!familyInfo) throw new Error(`Unknown dog family ${familyId}`);
  const resolvedVariants = variants && variants.length
    ? variants.map((variant) => ({ kind: 'coat', ...variant }))
    : [{ id: 'default', label: 'Standard', kind: 'type' }];
  const resolvedDefaultVariantId = resolvedVariants.some((variant) => variant.id === defaultVariantId)
    ? defaultVariantId
    : resolvedVariants[0].id;
  return {
    id,
    label,
    familyId,
    speciesId: familyInfo.speciesId,
    akc: { group: akcGroup },
    popularity: { year: 2025, rank, source: AKC_2025_SOURCE },
    authored,
    summary: { size, build, coat, energy, trainability },
    behavior: { energy, trainability, sociability: 3, vigilance: 3 },
    generatorLineage: lineage(weights),
    conformationFlags: [...flags],
    variants: resolvedVariants,
    defaultVariantId: resolvedDefaultVariantId,
  };
}

export const DOG_BREEDS = deepFreeze([
  breed({ id: 'french-bulldog', label: 'French Bulldog', rank: 1, familyId: 'brachy-bully', akcGroup: 'Non-Sporting', authored: true, size: 'Small', build: 'Compact', coat: 'Short', energy: 3, trainability: 3, weights: { bulldog: 0.72, mastiff: 0.12, toySpaniel: 0.1, terrier: 0.06 }, flags: ['brachycephalic', 'compact-spine', 'heat-sensitive-conformation'] }),
  breed({ id: 'labrador-retriever', label: 'Labrador Retriever', rank: 2, familyId: 'retriever-sporting', akcGroup: 'Sporting', authored: true, size: 'Large', build: 'Athletic', coat: 'Short double', energy: 4, trainability: 5, weights: { retriever: 0.76, pointer: 0.14, shepherd: 0.04, poodle: 0.03, mastiff: 0.03 } }),
  breed({ id: 'golden-retriever', label: 'Golden Retriever', rank: 3, familyId: 'retriever-sporting', akcGroup: 'Sporting', authored: true, size: 'Large', build: 'Balanced', coat: 'Long double', energy: 4, trainability: 5, weights: { retriever: 0.78, pointer: 0.08, shepherd: 0.04, toySpaniel: 0.03, poodle: 0.04, spitz: 0.03 } }),
  breed({ id: 'german-shepherd-dog', label: 'German Shepherd Dog', rank: 4, familyId: 'herding', akcGroup: 'Herding', authored: true, size: 'Large', build: 'Athletic', coat: 'Medium double', energy: 5, trainability: 5, weights: { shepherd: 0.82, spitz: 0.08, mastiff: 0.04, pointer: 0.04, retriever: 0.02 }, flags: ['sloped-topline-variation'] }),
  breed({
    id: 'dachshund', label: 'Dachshund', rank: 5, familyId: 'hound', akcGroup: 'Hound', authored: true, size: 'Small', build: 'Long and low', coat: 'Smooth', energy: 3, trainability: 3, weights: { scentHound: 0.76, terrier: 0.12, toySpaniel: 0.05, bulldog: 0.03, retriever: 0.04 }, flags: ['long-spine', 'short-limbs'],
    defaultVariantId: 'smooth',
    variants: [
      { id: 'smooth', label: 'Smooth' },
      { id: 'longhaired', label: 'Longhaired' },
      { id: 'wirehaired', label: 'Wirehaired' },
    ],
  }),
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
  // First non-canine breed: no AKC group/rank (not a dog), reuses the shared
  // quadruped generator via `generatorLineage` as a stylized shape prior only
  // (compact-round + dense-coat silhouette), same as every other entry here.
  breed({ id: 'raccoon', label: 'Raccoon', rank: null, familyId: 'raccoon', akcGroup: null, authored: true, size: 'Small', build: 'Compact rounded', coat: 'Dense grizzled', energy: 3, trainability: 2, weights: { spitz: 0.48, terrier: 0.28, mastiff: 0.14, retriever: 0.1 }, flags: ['non-canine-extension', 'procyonid', 'bandit-mask', 'ringed-tail', 'dexterous-paws'] }),
  breed({
    id: 'white-nosed-coati',
    label: 'White-nosed Coati',
    rank: null,
    familyId: 'coati',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Long-snouted terrestrial',
    coat: 'Brown grizzled',
    energy: 4,
    trainability: 2,
    weights: { scentHound: 0.36, terrier: 0.28, spitz: 0.22, pointer: 0.14 },
    flags: ['non-canine-extension', 'procyonid', 'long-snout', 'ringed-tail', 'dexterous-paws'],
  }),
  breed({
    id: 'kinkajou',
    label: 'Kinkajou',
    rank: null,
    familyId: 'kinkajou',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Arboreal rounded',
    coat: 'Short golden',
    energy: 3,
    trainability: 2,
    weights: { toySpaniel: 0.36, spitz: 0.28, terrier: 0.22, bulldog: 0.14 },
    flags: ['non-canine-extension', 'procyonid', 'prehensile-tail', 'arboreal'],
  }),
  breed({
    id: 'ringtail',
    label: 'Ringtail',
    rank: null,
    familyId: 'ringtail',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Slender cat-like',
    coat: 'Soft grey-brown',
    energy: 4,
    trainability: 2,
    weights: { terrier: 0.34, scentHound: 0.28, spitz: 0.22, pointer: 0.16 },
    flags: ['non-canine-extension', 'procyonid', 'ringed-tail', 'long-tail'],
  }),
  // Feline family (P0): tortoiseshell + Khao Manee. Lineage weights are
  // shape priors only (compact + fine-boned), not genetics.
  breed({
    id: 'tortoiseshell',
    label: 'Tortoiseshell',
    rank: null,
    familyId: 'feline',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Compact',
    coat: 'Short mottled',
    energy: 3,
    trainability: 3,
    weights: { terrier: 0.42, toySpaniel: 0.28, spitz: 0.18, bulldog: 0.12 },
    flags: ['non-canine-extension', 'feline', 'tortie-pattern'],
  }),
  breed({
    id: 'khao-manee',
    label: 'Khao Manee',
    rank: null,
    familyId: 'feline',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Fine-boned',
    coat: 'Short white',
    energy: 3,
    trainability: 3,
    weights: { toySpaniel: 0.4, terrier: 0.32, spitz: 0.18, pointer: 0.1 },
    flags: ['non-canine-extension', 'feline', 'odd-eye-possible'],
    defaultVariantId: 'odd-eye',
    variants: [
      { id: 'odd-eye', label: 'Odd-eye (blue + green)', kind: 'eyes' },
      { id: 'blue', label: 'Blue eyes', kind: 'eyes' },
      { id: 'regular', label: 'Regular (gold)', kind: 'eyes' },
    ],
  }),
  // 3rd feline option: the bespoke fully-procedural cat — own ~50-bone rig,
  // ring-loft body, and shell tortie coat via createProceduralCat, NOT the
  // shared dog rig. The `cat-rig` flag routes builds (mirrors the birds'
  // `bird-rig`). Catalog-only (authored: false): it carries no dog-skeleton
  // phenotype profile; reference stills are borrowed from the tortoiseshell
  // board (see CAT_REF_BREED_ALIASES in DogSimScene).
  breed({
    id: 'tortoiseshell-procedural',
    label: 'Tortoiseshell (Procedural)',
    rank: null,
    familyId: 'feline',
    akcGroup: null,
    authored: false,
    size: 'Small',
    build: 'Compact',
    coat: 'Short mottled',
    energy: 3,
    trainability: 3,
    weights: { terrier: 0.42, toySpaniel: 0.28, spitz: 0.18, bulldog: 0.12 },
    flags: ['non-canine-extension', 'feline', 'tortie-pattern', 'cat-rig'],
  }),
  // Felidae breed column (P1): every cat-ref board has a first-pass authored
  // profile (dogPhenotypes.js felineProfile). Shape priors only — not
  // genetics. CFA/TICA-ish popularity order.
  breed({ id: 'domestic-shorthair', label: 'Domestic Shorthair', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Compact', coat: 'Short', energy: 3, trainability: 3, weights: { terrier: 0.4, toySpaniel: 0.3, spitz: 0.18, bulldog: 0.12 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'domestic-longhair', label: 'Domestic Longhair', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Compact', coat: 'Long', energy: 3, trainability: 3, weights: { toySpaniel: 0.38, terrier: 0.28, spitz: 0.22, poodle: 0.12 }, flags: ['non-canine-extension', 'feline', 'high-grooming'] }),
  breed({ id: 'siamese', label: 'Siamese', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Svelte', coat: 'Short pointed', energy: 4, trainability: 4, weights: { pointer: 0.36, terrier: 0.34, toySpaniel: 0.2, scentHound: 0.1 }, flags: ['non-canine-extension', 'feline', 'colorpoint'] }),
  breed({ id: 'persian', label: 'Persian', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Cobby', coat: 'Long dense', energy: 2, trainability: 3, weights: { bulldog: 0.36, toySpaniel: 0.32, mastiff: 0.18, poodle: 0.14 }, flags: ['non-canine-extension', 'feline', 'brachycephalic', 'high-grooming'] }),
  breed({ id: 'maine-coon', label: 'Maine Coon', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Large', build: 'Substantial', coat: 'Long shaggy', energy: 3, trainability: 4, weights: { mastiff: 0.34, retriever: 0.28, spitz: 0.22, terrier: 0.16 }, flags: ['non-canine-extension', 'feline', 'giant-scale', 'high-grooming'] }),
  breed({ id: 'ragdoll', label: 'Ragdoll', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Large', build: 'Substantial soft', coat: 'Semi-long pointed', energy: 2, trainability: 4, weights: { retriever: 0.34, toySpaniel: 0.3, mastiff: 0.2, poodle: 0.16 }, flags: ['non-canine-extension', 'feline', 'colorpoint', 'high-grooming'] }),
  breed({ id: 'bengal', label: 'Bengal', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Athletic', coat: 'Short spotted', energy: 5, trainability: 4, weights: { pointer: 0.4, terrier: 0.28, scentHound: 0.18, shepherd: 0.14 }, flags: ['non-canine-extension', 'feline', 'wild-look'] }),
  breed({ id: 'british-shorthair', label: 'British Shorthair', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Cobby', coat: 'Short dense', energy: 2, trainability: 3, weights: { bulldog: 0.34, mastiff: 0.28, terrier: 0.22, toySpaniel: 0.16 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'american-shorthair', label: 'American Shorthair', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Balanced', coat: 'Short', energy: 3, trainability: 3, weights: { terrier: 0.36, retriever: 0.28, bulldog: 0.2, pointer: 0.16 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'scottish-fold', label: 'Scottish Fold', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Rounded', coat: 'Short/medium', energy: 3, trainability: 3, weights: { bulldog: 0.32, toySpaniel: 0.3, terrier: 0.22, spitz: 0.16 }, flags: ['non-canine-extension', 'feline', 'folded-ears'] }),
  breed({ id: 'abyssinian', label: 'Abyssinian', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Lithe', coat: 'Short ticked', energy: 5, trainability: 4, weights: { pointer: 0.38, terrier: 0.32, scentHound: 0.18, shepherd: 0.12 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'russian-blue', label: 'Russian Blue', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Fine-boned', coat: 'Short blue-gray', energy: 3, trainability: 4, weights: { toySpaniel: 0.36, terrier: 0.32, pointer: 0.18, spitz: 0.14 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'sphynx', label: 'Sphynx', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Wedge', coat: 'Hairless', energy: 4, trainability: 4, weights: { terrier: 0.4, pointer: 0.28, toySpaniel: 0.2, bulldog: 0.12 }, flags: ['non-canine-extension', 'feline', 'hairless'] }),
  breed({ id: 'norwegian-forest', label: 'Norwegian Forest Cat', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Large', build: 'Substantial', coat: 'Long double', energy: 3, trainability: 3, weights: { spitz: 0.4, retriever: 0.28, mastiff: 0.18, shepherd: 0.14 }, flags: ['non-canine-extension', 'feline', 'high-grooming', 'cold-climate-double-coat'] }),
  breed({ id: 'siberian', label: 'Siberian', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Large', build: 'Powerful', coat: 'Long triple', energy: 3, trainability: 4, weights: { spitz: 0.38, retriever: 0.28, mastiff: 0.2, shepherd: 0.14 }, flags: ['non-canine-extension', 'feline', 'high-grooming', 'cold-climate-double-coat'] }),
  breed({ id: 'birman', label: 'Birman', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Stocky', coat: 'Semi-long pointed', energy: 2, trainability: 4, weights: { toySpaniel: 0.36, retriever: 0.28, poodle: 0.2, terrier: 0.16 }, flags: ['non-canine-extension', 'feline', 'colorpoint', 'high-grooming'] }),
  breed({ id: 'exotic-shorthair', label: 'Exotic Shorthair', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Cobby', coat: 'Short plush', energy: 2, trainability: 3, weights: { bulldog: 0.4, toySpaniel: 0.28, mastiff: 0.18, terrier: 0.14 }, flags: ['non-canine-extension', 'feline', 'brachycephalic'] }),
  breed({ id: 'devon-rex', label: 'Devon Rex', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Fine-boned', coat: 'Short wavy', energy: 4, trainability: 4, weights: { terrier: 0.38, toySpaniel: 0.3, pointer: 0.2, poodle: 0.12 }, flags: ['non-canine-extension', 'feline', 'rex-coat'] }),
  breed({ id: 'cornish-rex', label: 'Cornish Rex', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Svelte', coat: 'Short wavy', energy: 5, trainability: 4, weights: { pointer: 0.36, terrier: 0.32, toySpaniel: 0.2, scentHound: 0.12 }, flags: ['non-canine-extension', 'feline', 'rex-coat'] }),
  breed({ id: 'savannah', label: 'Savannah', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Large', build: 'Tall lean', coat: 'Short spotted', energy: 5, trainability: 3, weights: { pointer: 0.42, shepherd: 0.24, scentHound: 0.2, terrier: 0.14 }, flags: ['non-canine-extension', 'feline', 'wild-look', 'giant-scale'] }),
  breed({ id: 'manx', label: 'Manx', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Round compact', coat: 'Short/long', energy: 3, trainability: 3, weights: { bulldog: 0.34, terrier: 0.3, toySpaniel: 0.22, spitz: 0.14 }, flags: ['non-canine-extension', 'feline', 'tailless'] }),
  breed({ id: 'bombay', label: 'Bombay', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Muscular', coat: 'Short black', energy: 3, trainability: 4, weights: { terrier: 0.36, bulldog: 0.28, mastiff: 0.2, toySpaniel: 0.16 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'chartreux', label: 'Chartreux', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Muscular', coat: 'Short blue-gray', energy: 3, trainability: 3, weights: { mastiff: 0.32, terrier: 0.28, bulldog: 0.22, retriever: 0.18 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'turkish-angora', label: 'Turkish Angora', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Fine-boned', coat: 'Semi-long silky', energy: 4, trainability: 3, weights: { toySpaniel: 0.36, pointer: 0.28, terrier: 0.22, poodle: 0.14 }, flags: ['non-canine-extension', 'feline', 'high-grooming'] }),
  breed({ id: 'turkish-van', label: 'Turkish Van', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Athletic', coat: 'Semi-long', energy: 4, trainability: 3, weights: { pointer: 0.34, retriever: 0.28, terrier: 0.22, toySpaniel: 0.16 }, flags: ['non-canine-extension', 'feline', 'high-grooming'] }),
  breed({ id: 'burmese', label: 'Burmese', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Compact muscular', coat: 'Short satin', energy: 4, trainability: 4, weights: { terrier: 0.38, bulldog: 0.26, toySpaniel: 0.22, pointer: 0.14 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'tonkinese', label: 'Tonkinese', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Medium foreign', coat: 'Short mink', energy: 4, trainability: 4, weights: { terrier: 0.36, pointer: 0.28, toySpaniel: 0.22, scentHound: 0.14 }, flags: ['non-canine-extension', 'feline', 'colorpoint'] }),
  breed({ id: 'oriental-shorthair', label: 'Oriental Shorthair', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Extreme foreign', coat: 'Short', energy: 5, trainability: 4, weights: { pointer: 0.42, terrier: 0.3, scentHound: 0.16, toySpaniel: 0.12 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'himalayan', label: 'Himalayan', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Cobby', coat: 'Long pointed', energy: 2, trainability: 3, weights: { bulldog: 0.34, toySpaniel: 0.3, poodle: 0.2, mastiff: 0.16 }, flags: ['non-canine-extension', 'feline', 'brachycephalic', 'colorpoint', 'high-grooming'] }),
  breed({ id: 'ragamuffin', label: 'Ragamuffin', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Large', build: 'Substantial soft', coat: 'Long plush', energy: 2, trainability: 4, weights: { retriever: 0.34, toySpaniel: 0.3, mastiff: 0.2, poodle: 0.16 }, flags: ['non-canine-extension', 'feline', 'high-grooming'] }),
  breed({ id: 'nebelung', label: 'Nebelung', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Fine-boned', coat: 'Semi-long blue-gray', energy: 3, trainability: 3, weights: { toySpaniel: 0.36, spitz: 0.28, terrier: 0.2, pointer: 0.16 }, flags: ['non-canine-extension', 'feline', 'high-grooming'] }),
  breed({ id: 'munchkin', label: 'Munchkin', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Short-legged', coat: 'Short/long', energy: 3, trainability: 3, weights: { terrier: 0.36, toySpaniel: 0.28, bulldog: 0.2, scentHound: 0.16 }, flags: ['non-canine-extension', 'feline', 'short-limbs'] }),
  breed({ id: 'egyptian-mau', label: 'Egyptian Mau', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Athletic', coat: 'Short spotted', energy: 4, trainability: 3, weights: { pointer: 0.4, terrier: 0.28, scentHound: 0.18, shepherd: 0.14 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'somali', label: 'Somali', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Lithe', coat: 'Semi-long ticked', energy: 4, trainability: 4, weights: { pointer: 0.34, toySpaniel: 0.28, terrier: 0.22, spitz: 0.16 }, flags: ['non-canine-extension', 'feline', 'high-grooming'] }),
  breed({ id: 'balinese', label: 'Balinese', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Svelte', coat: 'Semi-long pointed', energy: 4, trainability: 4, weights: { pointer: 0.34, toySpaniel: 0.3, terrier: 0.22, poodle: 0.14 }, flags: ['non-canine-extension', 'feline', 'colorpoint', 'high-grooming'] }),
  breed({ id: 'japanese-bobtail', label: 'Japanese Bobtail', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Lean', coat: 'Short/long', energy: 4, trainability: 3, weights: { terrier: 0.36, pointer: 0.28, toySpaniel: 0.22, spitz: 0.14 }, flags: ['non-canine-extension', 'feline', 'bobtail'] }),
  breed({ id: 'singapura', label: 'Singapura', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Toy', build: 'Fine-boned', coat: 'Short ticked', energy: 4, trainability: 3, weights: { toySpaniel: 0.4, terrier: 0.32, pointer: 0.16, spitz: 0.12 }, flags: ['non-canine-extension', 'feline', 'toy-scale'] }),
  breed({ id: 'ocicat', label: 'Ocicat', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Athletic', coat: 'Short spotted', energy: 4, trainability: 4, weights: { pointer: 0.38, terrier: 0.28, scentHound: 0.18, retriever: 0.16 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'havana-brown', label: 'Havana Brown', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Firm', coat: 'Short mahogany', energy: 3, trainability: 4, weights: { terrier: 0.36, toySpaniel: 0.28, pointer: 0.2, bulldog: 0.16 }, flags: ['non-canine-extension', 'feline'] }),
  breed({ id: 'american-curl', label: 'American Curl', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Small', build: 'Balanced', coat: 'Short/long', energy: 3, trainability: 3, weights: { toySpaniel: 0.34, terrier: 0.3, spitz: 0.2, pointer: 0.16 }, flags: ['non-canine-extension', 'feline', 'curled-ears'] }),
  breed({ id: 'selkirk-rex', label: 'Selkirk Rex', rank: null, familyId: 'feline', akcGroup: null, authored: true, size: 'Medium', build: 'Stocky', coat: 'Curly plush', energy: 3, trainability: 3, weights: { bulldog: 0.32, poodle: 0.28, toySpaniel: 0.22, terrier: 0.18 }, flags: ['non-canine-extension', 'feline', 'rex-coat', 'high-grooming'] }),
  // Bovidae / Caprine — domestic goat (shared rig + ungulate appendage kits).
  breed({
    id: 'domestic-goat',
    label: 'Domestic Goat',
    rank: null,
    familyId: 'caprine',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Compact ungulate',
    coat: 'Coarse pied',
    energy: 3,
    trainability: 3,
    weights: { scentHound: 0.34, terrier: 0.28, spitz: 0.22, shepherd: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'cloven-hoof', 'horned'],
  }),
  // Rodentia P0 — classic squirrel / mouse / rat body plans (shared dog rig + rat clips).
  breed({
    id: 'norway-rat',
    label: 'Norway Rat',
    rank: null,
    familyId: 'mouse-rat',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Compact scurrying',
    coat: 'Short coarse',
    energy: 4,
    trainability: 2,
    weights: { terrier: 0.42, scentHound: 0.28, toySpaniel: 0.18, spitz: 0.12 },
    flags: ['non-canine-extension', 'rodent', 'muridae', 'rat-clips'],
  }),
  breed({
    id: 'house-mouse',
    label: 'House Mouse',
    rank: null,
    familyId: 'mouse-rat',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Fine scurrying',
    coat: 'Short',
    energy: 5,
    trainability: 2,
    weights: { toySpaniel: 0.4, terrier: 0.34, pointer: 0.16, spitz: 0.1 },
    flags: ['non-canine-extension', 'rodent', 'muridae', 'toy-scale', 'rat-clips'],
  }),
  breed({
    id: 'grey-squirrel',
    label: 'Grey Squirrel',
    rank: null,
    familyId: 'squirrel',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Arboreal compact',
    coat: 'Medium double',
    energy: 5,
    trainability: 2,
    weights: { spitz: 0.4, terrier: 0.28, toySpaniel: 0.18, pointer: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'sciuridae', 'bushy-tail', 'rat-clips'],
  }),
  breed({
    id: 'eastern-chipmunk',
    label: 'Eastern Chipmunk',
    rank: null,
    familyId: 'squirrel',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Compact striped',
    coat: 'Short striped',
    energy: 5,
    trainability: 2,
    weights: { terrier: 0.38, toySpaniel: 0.28, spitz: 0.2, pointer: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'sciuridae', 'striped', 'rat-clips'],
  }),
  breed({
    id: 'syrian-hamster',
    label: 'Syrian Hamster',
    rank: null,
    familyId: 'hamster-vole',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Stocky short-tailed',
    coat: 'Short dense',
    energy: 3,
    trainability: 2,
    weights: { bulldog: 0.34, toySpaniel: 0.3, terrier: 0.22, spitz: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'cricetidae', 'short-tail', 'rat-clips'],
  }),
  // Ursidae P0 — one authored breed per silhouette family (shared dog rig).
  breed({
    id: 'brown-bear',
    label: 'Brown Bear',
    rank: null,
    familyId: 'ursine',
    akcGroup: null,
    authored: true,
    size: 'Giant',
    build: 'Massive plantigrade',
    coat: 'Dense brown',
    energy: 3,
    trainability: 2,
    weights: { mastiff: 0.42, spitz: 0.28, retriever: 0.18, bulldog: 0.12 },
    flags: ['non-canine-extension', 'ursid', 'plantigrade', 'short-tail', 'giant-scale'],
  }),
  breed({
    id: 'polar-bear',
    label: 'Polar Bear',
    rank: null,
    familyId: 'polar',
    akcGroup: null,
    authored: true,
    size: 'Giant',
    build: 'Long-limbed arctic',
    coat: 'Dense white',
    energy: 3,
    trainability: 2,
    weights: { mastiff: 0.36, retriever: 0.28, spitz: 0.22, shepherd: 0.14 },
    flags: ['non-canine-extension', 'ursid', 'plantigrade', 'short-tail', 'giant-scale', 'arctic'],
  }),
  breed({
    id: 'giant-panda',
    label: 'Giant Panda',
    rank: null,
    familyId: 'panda',
    akcGroup: null,
    authored: true,
    size: 'Large',
    build: 'Cobby plantigrade',
    coat: 'Black-and-white',
    energy: 2,
    trainability: 2,
    weights: { bulldog: 0.36, mastiff: 0.3, toySpaniel: 0.2, spitz: 0.14 },
    flags: ['non-canine-extension', 'ursid', 'plantigrade', 'short-tail', 'panda-markings'],
  }),
  // Mustelidae — long low tube-body carnivorans (shared dog rig + mustelidBase).
  breed({
    id: 'river-otter',
    label: 'River Otter',
    rank: null,
    familyId: 'mustelid-otter',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Long low semi-aquatic',
    coat: 'Short dense brown',
    energy: 4,
    trainability: 3,
    weights: { scentHound: 0.32, terrier: 0.3, spitz: 0.22, pointer: 0.16 },
    flags: ['non-canine-extension', 'mustelid', 'webbed-paw', 'long-body', 'dense-coat'],
  }),
  breed({
    id: 'european-badger',
    label: 'European Badger',
    rank: null,
    familyId: 'mustelid-badger',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Stocky flattened',
    coat: 'Short grizzled',
    energy: 3,
    trainability: 2,
    weights: { bulldog: 0.34, terrier: 0.3, mastiff: 0.2, spitz: 0.16 },
    flags: ['non-canine-extension', 'mustelid', 'dorsal-crest', 'badger-face'],
  }),
  breed({
    id: 'least-weasel',
    label: 'Least Weasel',
    rank: null,
    familyId: 'mustelid-weasel',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Elongated slender tube',
    coat: 'Short brown',
    energy: 5,
    trainability: 2,
    weights: { terrier: 0.4, toySpaniel: 0.3, scentHound: 0.18, pointer: 0.12 },
    flags: ['non-canine-extension', 'mustelid', 'long-body', 'toy-scale'],
  }),
  // Mephitidae — skunk (skunk-striped pattern, bushy tail).
  breed({
    id: 'striped-skunk',
    label: 'Striped Skunk',
    rank: null,
    familyId: 'mephitid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Stocky low',
    coat: 'Short black/white',
    energy: 3,
    trainability: 2,
    weights: { terrier: 0.34, bulldog: 0.3, spitz: 0.2, scentHound: 0.16 },
    flags: ['non-canine-extension', 'mephitid', 'bushy-tail', 'striped'],
    defaultVariantId: 'striped',
    variants: [
      { id: 'striped', label: 'Striped' },
      { id: 'hooded', label: 'Hooded' },
    ],
  }),
  // Ailuridae — red panda.
  breed({
    id: 'red-panda',
    label: 'Red Panda',
    rank: null,
    familyId: 'ailurid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Stocky arboreal',
    coat: 'Long auburn',
    energy: 3,
    trainability: 2,
    weights: { spitz: 0.34, terrier: 0.28, toySpaniel: 0.22, bulldog: 0.16 },
    flags: ['non-canine-extension', 'ailurid', 'bushy-tail', 'ringed-tail', 'arboreal'],
  }),
  // Viverridae — genet (spotted, very long ringed tail).
  breed({
    id: 'common-genet',
    label: 'Common Genet',
    rank: null,
    familyId: 'viverrid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Slender long-tailed',
    coat: 'Short spotted grey',
    energy: 4,
    trainability: 2,
    weights: { terrier: 0.36, scentHound: 0.28, pointer: 0.2, spitz: 0.16 },
    flags: ['non-canine-extension', 'viverrid', 'long-tail', 'ringed-tail', 'arboreal'],
  }),
  // Herpestidae — meerkat.
  breed({
    id: 'meerkat',
    label: 'Meerkat',
    rank: null,
    familyId: 'herpestid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Slender sentinel',
    coat: 'Short tan',
    energy: 4,
    trainability: 3,
    weights: { terrier: 0.4, scentHound: 0.26, pointer: 0.2, toySpaniel: 0.14 },
    flags: ['non-canine-extension', 'herpestid', 'long-body'],
  }),
  // Hyaenidae — spotted hyena (sloped back, dorsal crest, spotted).
  breed({
    id: 'spotted-hyena',
    label: 'Spotted Hyena',
    rank: null,
    familyId: 'hyaenid',
    akcGroup: null,
    authored: true,
    size: 'Large',
    build: 'Heavy sloped-back',
    coat: 'Short spotted',
    energy: 4,
    trainability: 2,
    weights: { mastiff: 0.4, shepherd: 0.24, terrier: 0.2, scentHound: 0.16 },
    flags: ['non-canine-extension', 'hyaenid', 'dorsal-crest', 'heavy-build', 'spotted'],
  }),
  // Caviidae — one authored breed per silhouette family.
  breed({
    id: 'capybara',
    label: 'Capybara',
    rank: null,
    familyId: 'hydrochoerine',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Barrel stocky',
    coat: 'Short coarse',
    energy: 2,
    trainability: 2,
    weights: { bulldog: 0.36, mastiff: 0.28, terrier: 0.2, spitz: 0.16 },
    flags: ['non-canine-extension', 'rodent', 'caviidae', 'short-tail', 'rat-clips'],
  }),
  breed({
    id: 'guinea-pig',
    label: 'Guinea Pig',
    rank: null,
    familyId: 'cavid',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Cobby short-legged',
    coat: 'Short dense',
    energy: 3,
    trainability: 2,
    weights: { bulldog: 0.38, toySpaniel: 0.28, terrier: 0.2, spitz: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'caviidae', 'short-tail', 'toy-scale', 'rat-clips'],
  }),
  breed({
    id: 'patagonian-mara',
    label: 'Patagonian Mara',
    rank: null,
    familyId: 'mara',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Long-legged cursorial',
    coat: 'Short agouti',
    energy: 4,
    trainability: 2,
    weights: { scentHound: 0.34, pointer: 0.28, terrier: 0.22, spitz: 0.16 },
    flags: ['non-canine-extension', 'rodent', 'caviidae', 'short-tail', 'long-legs', 'rat-clips'],
  }),
  // Chinchillidae — chinchilla (ultra-dense silver coat, big ears, bushy tail).
  breed({
    id: 'chinchilla',
    label: 'Chinchilla',
    rank: null,
    familyId: 'chinchillid',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Compact big-eared',
    coat: 'Ultra-dense silver',
    energy: 4,
    trainability: 2,
    weights: { toySpaniel: 0.36, spitz: 0.3, terrier: 0.2, pointer: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'chinchillidae', 'bushy-tail', 'rat-clips'],
  }),
  // Erethizontidae + Hystricidae — porcupines (dorsal quill field).
  breed({
    id: 'north-american-porcupine',
    label: 'North American Porcupine',
    rank: null,
    familyId: 'erethizontid',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Stocky arboreal',
    coat: 'Quilled brown',
    energy: 2,
    trainability: 1,
    weights: { bulldog: 0.34, mastiff: 0.26, terrier: 0.22, spitz: 0.18 },
    flags: ['non-canine-extension', 'rodent', 'erethizontidae', 'quills', 'rat-clips'],
  }),
  breed({
    id: 'crested-porcupine',
    label: 'Crested Porcupine',
    rank: null,
    familyId: 'hystricid',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Stocky terrestrial',
    coat: 'Long-quilled',
    energy: 2,
    trainability: 1,
    weights: { bulldog: 0.36, terrier: 0.28, mastiff: 0.22, spitz: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'hystricidae', 'quills', 'rat-clips'],
  }),
  // Cervidae — red deer (branched antler rack, fawn spots, cloven hooves).
  breed({
    id: 'red-deer',
    label: 'Red Deer',
    rank: null,
    familyId: 'cervid',
    akcGroup: null,
    authored: true,
    size: 'Large',
    build: 'Long-legged slender',
    coat: 'Short tawny spotted',
    energy: 4,
    trainability: 1,
    weights: { pointer: 0.36, shepherd: 0.26, scentHound: 0.22, retriever: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'cervidae', 'cloven-hoof', 'antlered'],
  }),
  // Camelidae — dromedary (single hump) + llama (woolly, long neck).
  breed({
    id: 'dromedary',
    label: 'Dromedary',
    rank: null,
    familyId: 'camelid',
    akcGroup: null,
    authored: true,
    size: 'Giant',
    build: 'Long-legged humped',
    coat: 'Short tan',
    energy: 3,
    trainability: 3,
    weights: { mastiff: 0.34, shepherd: 0.26, pointer: 0.22, retriever: 0.18 },
    flags: ['non-canine-extension', 'ungulate', 'camelidae', 'cloven-hoof', 'humped', 'giant-scale'],
  }),
  breed({
    id: 'llama',
    label: 'Llama',
    rank: null,
    familyId: 'camelid',
    akcGroup: null,
    authored: true,
    size: 'Giant',
    build: 'Long-necked woolly',
    coat: 'Woolly',
    energy: 3,
    trainability: 3,
    weights: { shepherd: 0.32, mastiff: 0.28, pointer: 0.22, spitz: 0.18 },
    flags: ['non-canine-extension', 'ungulate', 'camelidae', 'cloven-hoof', 'high-grooming', 'giant-scale'],
  }),
  // Suidae — domestic pig + warthog (snout disk, cloven hooves; warthog has tusks + crest).
  breed({
    id: 'domestic-pig',
    label: 'Domestic Pig',
    rank: null,
    familyId: 'suid',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Compact barrel',
    coat: 'Short bristly',
    energy: 3,
    trainability: 3,
    weights: { bulldog: 0.38, mastiff: 0.28, terrier: 0.2, retriever: 0.14 },
    flags: ['non-canine-extension', 'ungulate', 'suidae', 'cloven-hoof'],
  }),
  breed({
    id: 'warthog',
    label: 'Warthog',
    rank: null,
    familyId: 'suid',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Stocky sloped-back',
    coat: 'Sparse bristly',
    energy: 4,
    trainability: 1,
    weights: { bulldog: 0.4, terrier: 0.26, mastiff: 0.2, shepherd: 0.14 },
    flags: ['non-canine-extension', 'ungulate', 'suidae', 'cloven-hoof', 'tusked', 'dorsal-crest'],
  }),
  // Castoridae — North American beaver (paddle tail + webbed paws; reuses 'beaver' family).
  breed({
    id: 'north-american-beaver',
    label: 'North American Beaver',
    rank: null,
    familyId: 'beaver',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Heavy semi-aquatic',
    coat: 'Dense brown',
    energy: 3,
    trainability: 2,
    weights: { bulldog: 0.34, mastiff: 0.28, spitz: 0.22, terrier: 0.16 },
    flags: ['non-canine-extension', 'rodent', 'castoridae', 'paddle-tail', 'webbed-paw', 'rat-clips'],
  }),
  // ── Remaining empty-species fill (1 authored breed each) ─────────────────
  // Carnivora niche — dog clip pack (shared carnivoran gait).
  breed({
    id: 'fossa',
    label: 'Fossa',
    rank: null,
    familyId: 'euplerid',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Long low cat-like',
    coat: 'Short reddish-brown',
    energy: 4,
    trainability: 2,
    weights: { terrier: 0.34, scentHound: 0.28, pointer: 0.22, spitz: 0.16 },
    flags: ['non-canine-extension', 'euplerid', 'long-body', 'long-tail'],
  }),
  breed({
    id: 'african-palm-civet',
    label: 'African Palm Civet',
    rank: null,
    familyId: 'nandinia',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Stocky arboreal',
    coat: 'Short spotted brown',
    energy: 3,
    trainability: 2,
    weights: { terrier: 0.32, bulldog: 0.28, spitz: 0.22, scentHound: 0.18 },
    flags: ['non-canine-extension', 'nandinia', 'ringed-tail', 'arboreal'],
  }),
  breed({
    id: 'banded-linsang',
    label: 'Banded Linsang',
    rank: null,
    familyId: 'prionodontid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Slender elongated',
    coat: 'Short banded',
    energy: 4,
    trainability: 2,
    weights: { terrier: 0.38, scentHound: 0.28, pointer: 0.2, spitz: 0.14 },
    flags: ['non-canine-extension', 'prionodontid', 'long-tail', 'long-body'],
  }),
  // Rodentia niche — rat clip pack (order rodentia + rat-clips flag).
  breed({
    id: 'kangaroo-rat',
    label: 'Kangaroo Rat',
    rank: null,
    familyId: 'heteromyid',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Bipedal jumper',
    coat: 'Short sandy',
    energy: 5,
    trainability: 1,
    weights: { toySpaniel: 0.34, pointer: 0.28, terrier: 0.22, spitz: 0.16 },
    flags: ['non-canine-extension', 'rodent', 'heteromyidae', 'long-legs', 'toy-scale', 'rat-clips'],
  }),
  breed({
    id: 'jerboa',
    label: 'Jerboa',
    rank: null,
    familyId: 'dipodid',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Long-legged jumper',
    coat: 'Short sandy',
    energy: 5,
    trainability: 1,
    weights: { toySpaniel: 0.36, pointer: 0.3, terrier: 0.2, spitz: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'dipodidae', 'long-legs', 'long-tail', 'toy-scale', 'rat-clips'],
  }),
  breed({
    id: 'edible-dormouse',
    label: 'Edible Dormouse',
    rank: null,
    familyId: 'glirid',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Compact arboreal',
    coat: 'Soft grey-brown',
    energy: 3,
    trainability: 2,
    weights: { toySpaniel: 0.36, spitz: 0.3, terrier: 0.2, bulldog: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'gliridae', 'bushy-tail', 'toy-scale', 'rat-clips'],
  }),
  breed({
    id: 'blind-mole-rat',
    label: 'Blind Mole-Rat',
    rank: null,
    familyId: 'spalacid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Cylindrical fossorial',
    coat: 'Short dense',
    energy: 2,
    trainability: 1,
    weights: { bulldog: 0.36, terrier: 0.3, toySpaniel: 0.2, mastiff: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'spalacidae', 'fossorial', 'short-tail', 'rat-clips'],
  }),
  breed({
    id: 'giant-pouched-rat',
    label: 'Giant Pouched Rat',
    rank: null,
    familyId: 'nesomyid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Large muriform',
    coat: 'Short coarse',
    energy: 4,
    trainability: 3,
    weights: { terrier: 0.4, scentHound: 0.28, toySpaniel: 0.18, spitz: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'nesomyidae', 'rat-clips'],
  }),
  breed({
    id: 'pocket-gopher',
    label: 'Pocket Gopher',
    rank: null,
    familyId: 'geomyid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Stocky fossorial',
    coat: 'Short dense',
    energy: 3,
    trainability: 1,
    weights: { bulldog: 0.34, terrier: 0.32, toySpaniel: 0.2, spitz: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'geomyidae', 'fossorial', 'short-tail', 'rat-clips'],
  }),
  breed({
    id: 'naked-mole-rat',
    label: 'Naked Mole-Rat',
    rank: null,
    familyId: 'bathyergid',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Hairless fossorial tube',
    coat: 'Nearly hairless',
    energy: 2,
    trainability: 1,
    weights: { bulldog: 0.36, toySpaniel: 0.28, terrier: 0.22, mastiff: 0.14 },
    flags: ['non-canine-extension', 'rodent', 'bathyergidae', 'fossorial', 'hairless', 'short-tail', 'toy-scale', 'rat-clips'],
  }),
  // Perissodactyla — horse-sourced clip pack (`equid` library → dog-anims).
  breed({
    id: 'domestic-horse',
    label: 'Domestic Horse',
    rank: null,
    familyId: 'equid',
    akcGroup: null,
    authored: true,
    size: 'Giant',
    build: 'Long-legged ungulate',
    coat: 'Short sleek',
    energy: 4,
    trainability: 4,
    weights: { pointer: 0.34, shepherd: 0.28, retriever: 0.22, mastiff: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'equidae', 'solid-hoof', 'giant-scale', 'horse-clips'],
  }),
  // Horse v2: the bespoke fully-procedural horse — own ~120-bone rig,
  // ring-loft body, bay shell coat, and procedural gait/IK animation via
  // createProceduralHorse, NOT the shared dog rig. The `horse-rig` flag
  // routes builds (mirrors the cat's `cat-rig`). Catalog-only
  // (authored: false): it carries no dog-skeleton phenotype profile;
  // reference stills are borrowed from the domestic-horse equid-ref board
  // (see EQUID_REF_BREED_ALIASES in DogSimScene). v1 `domestic-horse`
  // (dog skeleton + equid clip pack) stays untouched.
  breed({
    id: 'domestic-horse-procedural',
    label: 'Domestic Horse v2 (Procedural)',
    rank: null,
    familyId: 'equid',
    akcGroup: null,
    authored: false,
    size: 'Giant',
    build: 'Long-legged ungulate',
    coat: 'Short sleek bay',
    energy: 4,
    trainability: 4,
    weights: { pointer: 0.34, shepherd: 0.28, retriever: 0.22, mastiff: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'equidae', 'solid-hoof', 'giant-scale', 'horse-rig'],
  }),
  breed({
    id: 'white-rhinoceros',
    label: 'White Rhinoceros',
    rank: null,
    familyId: 'rhinocerotid',
    akcGroup: null,
    authored: true,
    size: 'Giant',
    build: 'Massive barrel',
    coat: 'Sparse grey',
    energy: 2,
    trainability: 1,
    weights: { mastiff: 0.42, bulldog: 0.28, shepherd: 0.18, retriever: 0.12 },
    flags: ['non-canine-extension', 'ungulate', 'rhinocerotidae', 'solid-hoof', 'horned', 'giant-scale', 'horse-clips'],
  }),
  breed({
    id: 'brazilian-tapir',
    label: 'Brazilian Tapir',
    rank: null,
    familyId: 'tapirid',
    akcGroup: null,
    authored: true,
    size: 'Large',
    build: 'Stocky rounded',
    coat: 'Short dark',
    energy: 3,
    trainability: 2,
    weights: { bulldog: 0.34, mastiff: 0.3, scentHound: 0.2, retriever: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'tapiridae', 'solid-hoof', 'horse-clips'],
  }),
  // Artiodactyla remaining — dog pack for pig/deer-like; equid pack for hippo/giraffe.
  breed({
    id: 'collared-peccary',
    label: 'Collared Peccary',
    rank: null,
    familyId: 'tayassuid',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Compact pig-like',
    coat: 'Bristly grizzled',
    energy: 4,
    trainability: 2,
    weights: { bulldog: 0.36, terrier: 0.28, mastiff: 0.2, scentHound: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'tayassuidae', 'cloven-hoof'],
  }),
  breed({
    id: 'common-hippopotamus',
    label: 'Common Hippopotamus',
    rank: null,
    familyId: 'hippopotamid',
    akcGroup: null,
    authored: true,
    size: 'Giant',
    build: 'Massive barrel',
    coat: 'Sparse pink-grey',
    energy: 2,
    trainability: 1,
    weights: { mastiff: 0.4, bulldog: 0.32, retriever: 0.16, shepherd: 0.12 },
    flags: ['non-canine-extension', 'ungulate', 'hippopotamidae', 'cloven-hoof', 'giant-scale', 'horse-clips'],
  }),
  breed({
    id: 'reticulated-giraffe',
    label: 'Reticulated Giraffe',
    rank: null,
    familyId: 'giraffid',
    akcGroup: null,
    authored: true,
    size: 'Giant',
    build: 'Extreme long-neck',
    coat: 'Short reticulated',
    energy: 3,
    trainability: 2,
    weights: { pointer: 0.34, shepherd: 0.28, mastiff: 0.22, retriever: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'giraffidae', 'cloven-hoof', 'giant-scale', 'horse-clips'],
  }),
  breed({
    id: 'siberian-musk-deer',
    label: 'Siberian Musk Deer',
    rank: null,
    familyId: 'moschid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Compact alpine deer',
    coat: 'Dense brown',
    energy: 4,
    trainability: 1,
    weights: { scentHound: 0.34, terrier: 0.28, pointer: 0.22, spitz: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'moschidae', 'cloven-hoof'],
  }),
  breed({
    id: 'lesser-mouse-deer',
    label: 'Lesser Mouse-Deer',
    rank: null,
    familyId: 'tragulid',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Tiny delicate ungulate',
    coat: 'Short reddish',
    energy: 4,
    trainability: 1,
    weights: { toySpaniel: 0.36, terrier: 0.28, pointer: 0.2, scentHound: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'tragulidae', 'cloven-hoof', 'toy-scale'],
  }),
  breed({
    id: 'pronghorn',
    label: 'Pronghorn',
    rank: null,
    familyId: 'antilocaprid',
    akcGroup: null,
    authored: true,
    size: 'Large',
    build: 'Cursorial plains',
    coat: 'Short tan/white',
    energy: 5,
    trainability: 1,
    weights: { pointer: 0.38, shepherd: 0.26, scentHound: 0.2, retriever: 0.16 },
    flags: ['non-canine-extension', 'ungulate', 'antilocapridae', 'cloven-hoof', 'horned'],
  }),
  // Aves MVP — top-10 families by species count; one iconic species each.
  // Shared bird-rigged.glb (not the procedural quadruped mesh). Flags: bird-rig.
  breed({
    id: 'eastern-phoebe',
    label: 'Eastern Phoebe',
    rank: null,
    familyId: 'tyrant-flycatcher',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Upright passerine',
    coat: 'Gray-brown',
    energy: 4,
    trainability: 1,
    weights: { pointer: 0.4, terrier: 0.3, toySpaniel: 0.18, spitz: 0.12 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'passerine'],
  }),
  breed({
    id: 'blue-gray-tanager',
    label: 'Blue-gray Tanager',
    rank: null,
    familyId: 'tanager',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Stocky songbird',
    coat: 'Blue-gray',
    energy: 3,
    trainability: 1,
    weights: { toySpaniel: 0.36, terrier: 0.28, spitz: 0.2, pointer: 0.16 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'passerine'],
  }),
  breed({
    id: 'ruby-throated-hummingbird',
    label: 'Ruby-throated Hummingbird',
    rank: null,
    familyId: 'hummingbird',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Tiny hoverer',
    coat: 'Iridescent green',
    energy: 5,
    trainability: 1,
    weights: { toySpaniel: 0.44, pointer: 0.28, terrier: 0.18, spitz: 0.1 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'hummingbird', 'toy-scale'],
  }),
  breed({
    id: 'rock-pigeon',
    label: 'Rock Pigeon',
    rank: null,
    familyId: 'pigeon-dove',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Plump strong-winged',
    coat: 'Blue-bar / iridescent',
    energy: 3,
    trainability: 2,
    weights: { bulldog: 0.32, retriever: 0.28, terrier: 0.22, spitz: 0.18 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'pigeon'],
  }),
  breed({
    id: 'european-robin',
    label: 'European Robin',
    rank: null,
    familyId: 'old-world-flycatcher',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Round chat',
    coat: 'Orange-breasted',
    energy: 4,
    trainability: 1,
    weights: { toySpaniel: 0.38, terrier: 0.3, spitz: 0.18, pointer: 0.14 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'passerine'],
  }),
  breed({
    id: 'rufous-hornero',
    label: 'Rufous Hornero',
    rank: null,
    familyId: 'ovenbird-woodcreeper',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Stocky furnariid',
    coat: 'Rufous brown',
    energy: 3,
    trainability: 1,
    weights: { terrier: 0.36, scentHound: 0.28, spitz: 0.2, pointer: 0.16 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'passerine'],
  }),
  breed({
    id: 'red-tailed-hawk',
    label: 'Red-tailed Hawk',
    rank: null,
    familyId: 'hawk-eagle',
    akcGroup: null,
    authored: true,
    size: 'Large',
    build: 'Broad-winged raptor',
    coat: 'Brown / red tail',
    energy: 3,
    trainability: 2,
    weights: { pointer: 0.4, shepherd: 0.28, mastiff: 0.18, retriever: 0.14 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'raptor'],
  }),
  breed({
    id: 'house-finch',
    label: 'House Finch',
    rank: null,
    familyId: 'finch',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Conical-billed seed eater',
    coat: 'Streaked / red-headed ♂',
    energy: 4,
    trainability: 1,
    weights: { terrier: 0.36, toySpaniel: 0.3, spitz: 0.2, pointer: 0.14 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'passerine'],
  }),
  breed({
    id: 'mallard',
    label: 'Mallard',
    rank: null,
    familyId: 'duck-goose-swan',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Classic dabbling duck',
    coat: 'Green head ♂ / mottled ♀',
    energy: 3,
    trainability: 1,
    weights: { retriever: 0.36, bulldog: 0.28, scentHound: 0.2, spitz: 0.16 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'waterfowl'],
  }),
  breed({
    id: 'scarlet-macaw',
    label: 'Scarlet Macaw',
    rank: null,
    familyId: 'parrot',
    akcGroup: null,
    authored: true,
    size: 'Large',
    build: 'Long-tailed macaw',
    coat: 'Scarlet / blue / yellow',
    energy: 4,
    trainability: 4,
    weights: { pointer: 0.34, toySpaniel: 0.28, shepherd: 0.22, spitz: 0.16 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'parrot'],
  }),
  breed({
    id: 'canada-goose',
    label: 'Canada Goose',
    rank: null,
    familyId: 'duck-goose-swan',
    akcGroup: null,
    authored: true,
    size: 'Large',
    build: 'Large long-necked waterfowl',
    coat: 'Black head/neck, brown body, white chin strap',
    energy: 3,
    trainability: 1,
    weights: { retriever: 0.34, bulldog: 0.26, scentHound: 0.24, spitz: 0.16 },
    flags: ['non-canine-extension', 'avian', 'bird-rig', 'waterfowl'],
  }),
  // ---------------------------------------------------------------------------
  // Insecta catalog MVP — body-plan groups 1–25. Authored for UI/population;
  // no insect mesh yet (flag: insect). Excluded from AUTHORED_DOG_BREED_IDS.
  // Lineage weights are unused shape priors only (required by breed()).
  // ---------------------------------------------------------------------------
  // 1–4 Oval / armored / dome-shaped (beetles)
  breed({
    id: 'seven-spotted-ladybug',
    label: 'Seven-spotted Ladybug',
    rank: null,
    familyId: 'ladybug',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Domed oval',
    coat: 'Red elytra, seven black spots',
    energy: 2,
    trainability: 1,
    weights: { bulldog: 0.4, toySpaniel: 0.3, terrier: 0.2, spitz: 0.1 },
    flags: ['non-canine-extension', 'insect', 'beetle', 'toy-scale', 'ladybug-rig'],
    defaultVariantId: 'seven-spot',
    variants: [
      { id: 'seven-spot', label: 'Seven-spot (classic)', kind: 'pattern' },
      { id: 'two-spot', label: 'Two-spot', kind: 'pattern' },
      { id: 'immaculate', label: 'Spotless', kind: 'pattern' },
    ],
  }),
  breed({
    id: 'japanese-beetle',
    label: 'Japanese Beetle',
    rank: null,
    familyId: 'scarab-beetle',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Stout oval scarab',
    coat: 'Metallic green thorax, copper elytra',
    energy: 3,
    trainability: 1,
    weights: { bulldog: 0.36, terrier: 0.28, mastiff: 0.2, spitz: 0.16 },
    flags: ['non-canine-extension', 'insect', 'beetle', 'toy-scale'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'grub', label: 'Grub (larva)', kind: 'stage' },
    ],
  }),
  breed({
    id: 'acorn-weevil',
    label: 'Acorn Weevil',
    rank: null,
    familyId: 'weevil',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Snouted hard-bodied',
    coat: 'Brown mottled',
    energy: 2,
    trainability: 1,
    weights: { scentHound: 0.4, terrier: 0.3, pointer: 0.18, toySpaniel: 0.12 },
    flags: ['non-canine-extension', 'insect', 'beetle', 'toy-scale', 'rostrum'],
  }),
  breed({
    id: 'ground-beetle',
    label: 'Ground Beetle',
    rank: null,
    familyId: 'ground-beetle',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Flattened cursorial',
    coat: 'Dark iridescent',
    energy: 4,
    trainability: 1,
    weights: { pointer: 0.4, terrier: 0.3, scentHound: 0.18, shepherd: 0.12 },
    flags: ['non-canine-extension', 'insect', 'beetle', 'toy-scale'],
  }),
  // 5–8 Narrow-waisted / segmented (bees, wasps, ants)
  breed({
    id: 'honey-bee',
    label: 'Honey Bee',
    rank: null,
    familyId: 'honey-bee',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Hairy petiolate',
    coat: 'Amber / black bands',
    energy: 5,
    trainability: 2,
    weights: { terrier: 0.34, spitz: 0.28, pointer: 0.22, toySpaniel: 0.16 },
    flags: ['non-canine-extension', 'insect', 'hymenopteran', 'toy-scale', 'eusocial'],
    defaultVariantId: 'worker',
    variants: [
      { id: 'worker', label: 'Worker', kind: 'caste' },
      { id: 'drone', label: 'Drone', kind: 'caste' },
      { id: 'queen', label: 'Queen', kind: 'caste' },
    ],
  }),
  breed({
    id: 'yellowjacket',
    label: 'Yellowjacket Wasp',
    rank: null,
    familyId: 'yellowjacket',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Compact social wasp',
    coat: 'Yellow / black bands',
    energy: 5,
    trainability: 1,
    weights: { terrier: 0.36, pointer: 0.3, shepherd: 0.2, spitz: 0.14 },
    flags: ['non-canine-extension', 'insect', 'hymenopteran', 'toy-scale', 'eusocial'],
    defaultVariantId: 'worker',
    variants: [
      { id: 'worker', label: 'Worker', kind: 'caste' },
      { id: 'queen', label: 'Queen', kind: 'caste' },
    ],
  }),
  breed({
    id: 'pavement-ant',
    label: 'Common Pavement Ant',
    rank: null,
    familyId: 'pavement-ant',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Small eusocial ant',
    coat: 'Dark brown / black',
    energy: 4,
    trainability: 2,
    weights: { terrier: 0.4, toySpaniel: 0.28, pointer: 0.2, spitz: 0.12 },
    flags: ['non-canine-extension', 'insect', 'hymenopteran', 'toy-scale', 'eusocial'],
    defaultVariantId: 'worker',
    variants: [
      { id: 'worker', label: 'Worker', kind: 'caste' },
      { id: 'queen', label: 'Queen', kind: 'caste' },
      { id: 'male', label: 'Male (alate)', kind: 'caste' },
    ],
  }),
  breed({
    id: 'ichneumon-wasp',
    label: 'Ichneumon Wasp',
    rank: null,
    familyId: 'ichneumon',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Slender parasitoid',
    coat: 'Orange / black / yellow',
    energy: 3,
    trainability: 1,
    weights: { pointer: 0.4, scentHound: 0.28, terrier: 0.2, toySpaniel: 0.12 },
    flags: ['non-canine-extension', 'insect', 'hymenopteran', 'toy-scale', 'parasitoid'],
    defaultVariantId: 'female',
    variants: [
      { id: 'female', label: 'Female (ovipositor)', kind: 'sex' },
      { id: 'male', label: 'Male', kind: 'sex' },
    ],
  }),
  // 9–11 Streamlined / two-winged (flies & mosquitoes)
  breed({
    id: 'house-fly',
    label: 'House Fly',
    rank: null,
    familyId: 'house-fly',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Compact dipteran',
    coat: 'Gray thorax, dark abdomen',
    energy: 4,
    trainability: 1,
    weights: { terrier: 0.36, toySpaniel: 0.3, pointer: 0.2, spitz: 0.14 },
    flags: ['non-canine-extension', 'insect', 'fly', 'toy-scale'],
  }),
  breed({
    id: 'anopheles-mosquito',
    label: 'Anopheles Mosquito',
    rank: null,
    familyId: 'mosquito',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Slender piercing',
    coat: 'Brown scaled',
    energy: 3,
    trainability: 1,
    weights: { pointer: 0.38, toySpaniel: 0.3, scentHound: 0.2, terrier: 0.12 },
    flags: ['non-canine-extension', 'insect', 'fly', 'toy-scale'],
    defaultVariantId: 'female',
    variants: [
      { id: 'female', label: 'Female (blood-feeder)', kind: 'sex' },
      { id: 'male', label: 'Male', kind: 'sex' },
    ],
  }),
  breed({
    id: 'hoverfly',
    label: 'Hoverfly',
    rank: null,
    familyId: 'hoverfly',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Bee-mimic hoverer',
    coat: 'Yellow / black bands',
    energy: 4,
    trainability: 1,
    weights: { terrier: 0.34, pointer: 0.28, spitz: 0.22, toySpaniel: 0.16 },
    flags: ['non-canine-extension', 'insect', 'fly', 'toy-scale', 'mimic'],
  }),
  // 12–14 Jumping / elongated hind legs
  breed({
    id: 'grasshopper',
    label: 'Grasshopper',
    rank: null,
    familyId: 'grasshopper',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Saltatory orthopteran',
    coat: 'Green / brown camouflage',
    energy: 4,
    trainability: 1,
    weights: { pointer: 0.4, shepherd: 0.26, terrier: 0.2, scentHound: 0.14 },
    flags: ['non-canine-extension', 'insect', 'orthopteran'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'nymph', label: 'Nymph', kind: 'stage' },
    ],
  }),
  breed({
    id: 'field-cricket',
    label: 'Field Cricket',
    rank: null,
    familyId: 'field-cricket',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Robust cricket',
    coat: 'Black / dark brown',
    energy: 3,
    trainability: 1,
    weights: { terrier: 0.36, bulldog: 0.28, scentHound: 0.2, spitz: 0.16 },
    flags: ['non-canine-extension', 'insect', 'orthopteran'],
    defaultVariantId: 'male',
    variants: [
      { id: 'male', label: 'Male (chirper)', kind: 'sex' },
      { id: 'female', label: 'Female', kind: 'sex' },
    ],
  }),
  breed({
    id: 'katydid',
    label: 'Katydid',
    rank: null,
    familyId: 'katydid',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Leaf-winged',
    coat: 'Leaf green',
    energy: 2,
    trainability: 1,
    weights: { toySpaniel: 0.34, pointer: 0.3, terrier: 0.22, spitz: 0.14 },
    flags: ['non-canine-extension', 'insect', 'orthopteran', 'camouflage'],
  }),
  // 15–16 Flat / scuttling
  breed({
    id: 'american-cockroach',
    label: 'American Cockroach',
    rank: null,
    familyId: 'cockroach',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Flattened runner',
    coat: 'Reddish brown',
    energy: 4,
    trainability: 1,
    weights: { terrier: 0.36, scentHound: 0.28, bulldog: 0.2, pointer: 0.16 },
    flags: ['non-canine-extension', 'insect', 'roach'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'nymph', label: 'Nymph', kind: 'stage' },
    ],
  }),
  breed({
    id: 'subterranean-termite',
    label: 'Subterranean Termite',
    rank: null,
    familyId: 'termite',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Soft eusocial',
    coat: 'Cream / pale',
    energy: 3,
    trainability: 2,
    weights: { toySpaniel: 0.4, bulldog: 0.28, terrier: 0.2, spitz: 0.12 },
    flags: ['non-canine-extension', 'insect', 'termite', 'toy-scale', 'eusocial'],
    defaultVariantId: 'worker',
    variants: [
      { id: 'worker', label: 'Worker', kind: 'caste' },
      { id: 'soldier', label: 'Soldier', kind: 'caste' },
      { id: 'alate', label: 'Alate (swarmer)', kind: 'caste' },
    ],
  }),
  // 17–19 Large-winged / delicate (butterflies & moths)
  breed({
    id: 'monarch-butterfly',
    label: 'Monarch Butterfly',
    rank: null,
    familyId: 'brushfoot-butterfly',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Large-winged brushfoot',
    coat: 'Orange / black / white',
    energy: 3,
    trainability: 1,
    weights: { toySpaniel: 0.34, pointer: 0.3, spitz: 0.2, retriever: 0.16 },
    flags: ['non-canine-extension', 'insect', 'lepidopteran'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'male', label: 'Male adult', kind: 'sex' },
      { id: 'female', label: 'Female adult', kind: 'sex' },
      { id: 'chrysalis', label: 'Chrysalis', kind: 'stage' },
      { id: 'caterpillar', label: 'Caterpillar', kind: 'stage' },
    ],
  }),
  breed({
    id: 'luna-moth',
    label: 'Luna Moth',
    rank: null,
    familyId: 'silk-moth',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Broad-winged silk moth',
    coat: 'Pale green, long tails',
    energy: 2,
    trainability: 1,
    weights: { toySpaniel: 0.36, poodle: 0.28, spitz: 0.2, pointer: 0.16 },
    flags: ['non-canine-extension', 'insect', 'lepidopteran'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'caterpillar', label: 'Caterpillar', kind: 'stage' },
    ],
  }),
  breed({
    id: 'sphinx-moth',
    label: 'Sphinx Moth',
    rank: null,
    familyId: 'sphinx-moth',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Heavy-bodied hawk moth',
    coat: 'Brown / gray streaked',
    energy: 4,
    trainability: 1,
    weights: { pointer: 0.4, mastiff: 0.24, shepherd: 0.2, retriever: 0.16 },
    flags: ['non-canine-extension', 'insect', 'lepidopteran'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'hornworm', label: 'Hornworm (larva)', kind: 'stage' },
    ],
  }),
  // 20–21 Long-bodied aerial (dragonflies)
  breed({
    id: 'dragonfly',
    label: 'Dragonfly',
    rank: null,
    familyId: 'dragonfly',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Long-bodied aerial predator',
    coat: 'Iridescent / patterned',
    energy: 5,
    trainability: 1,
    weights: { pointer: 0.42, shepherd: 0.26, terrier: 0.18, scentHound: 0.14 },
    flags: ['non-canine-extension', 'insect', 'odonate'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'nymph', label: 'Aquatic nymph', kind: 'stage' },
    ],
  }),
  breed({
    id: 'damselfly',
    label: 'Damselfly',
    rank: null,
    familyId: 'damselfly',
    akcGroup: null,
    authored: true,
    size: 'Toy',
    build: 'Slender odonate',
    coat: 'Blue / green metallic',
    energy: 4,
    trainability: 1,
    weights: { toySpaniel: 0.36, pointer: 0.3, terrier: 0.2, spitz: 0.14 },
    flags: ['non-canine-extension', 'insect', 'odonate', 'toy-scale'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'nymph', label: 'Aquatic nymph', kind: 'stage' },
    ],
  }),
  // 22–23 Raptorial / ambush
  breed({
    id: 'praying-mantis',
    label: 'Praying Mantis',
    rank: null,
    familyId: 'praying-mantis',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Raptorial ambush',
    coat: 'Green / brown',
    energy: 3,
    trainability: 2,
    weights: { pointer: 0.38, shepherd: 0.28, scentHound: 0.2, terrier: 0.14 },
    flags: ['non-canine-extension', 'insect', 'mantis', 'raptorial'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'nymph', label: 'Nymph', kind: 'stage' },
      { id: 'green', label: 'Green morph', kind: 'color' },
      { id: 'brown', label: 'Brown morph', kind: 'color' },
    ],
  }),
  // 24–25 Specialized camouflage & others
  breed({
    id: 'stick-insect',
    label: 'Stick Insect',
    rank: null,
    familyId: 'stick-insect',
    akcGroup: null,
    authored: true,
    size: 'Medium',
    build: 'Twig-mimic elongate',
    coat: 'Bark brown / green',
    energy: 1,
    trainability: 1,
    weights: { scentHound: 0.4, pointer: 0.28, toySpaniel: 0.18, terrier: 0.14 },
    flags: ['non-canine-extension', 'insect', 'phasmid', 'camouflage'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'nymph', label: 'Nymph', kind: 'stage' },
    ],
  }),
  breed({
    id: 'periodical-cicada',
    label: 'Periodical Cicada',
    rank: null,
    familyId: 'cicada',
    akcGroup: null,
    authored: true,
    size: 'Small',
    build: 'Stout clear-winged',
    coat: 'Black body, red eyes, clear wings',
    energy: 3,
    trainability: 1,
    weights: { bulldog: 0.34, terrier: 0.28, mastiff: 0.22, spitz: 0.16 },
    flags: ['non-canine-extension', 'insect', 'cicada'],
    defaultVariantId: 'adult',
    variants: [
      { id: 'adult', label: 'Adult', kind: 'stage' },
      { id: 'nymph', label: 'Underground nymph', kind: 'stage' },
      { id: 'brood-x', label: 'Brood X (17-year)', kind: 'type' },
      { id: 'brood-xix', label: 'Brood XIX (13-year)', kind: 'type' },
    ],
  }),
]);

/**
 * Authored quadruped breeds with procedural dog-skeleton phenotypes.
 * Excludes bird-rig entries and insect catalog entries (no dog mesh).
 */
export const AUTHORED_DOG_BREED_IDS = Object.freeze(
  DOG_BREEDS
    .filter((breedInfo) => (
      breedInfo.authored
      && !breedInfo.conformationFlags?.includes('bird-rig')
      && !breedInfo.conformationFlags?.includes('insect')
    ))
    .map((breedInfo) => breedInfo.id),
);

/** Authored bird breeds that use the shared bird GLB rig. */
export const AUTHORED_BIRD_BREED_IDS = Object.freeze(
  DOG_BREEDS
    .filter((breedInfo) => breedInfo.authored && breedInfo.conformationFlags?.includes('bird-rig'))
    .map((breedInfo) => breedInfo.id),
);

/**
 * Authored insect catalog breeds (body-plan MVP). No insect mesh/rig yet —
 * studio selection updates catalog identity only until a procedural path ships.
 */
export const AUTHORED_INSECT_BREED_IDS = Object.freeze(
  DOG_BREEDS
    .filter((breedInfo) => breedInfo.authored && breedInfo.conformationFlags?.includes('insect'))
    .map((breedInfo) => breedInfo.id),
);

const breedById = new Map(DOG_BREEDS.map((breedInfo) => [breedInfo.id, breedInfo]));
const familyById = new Map(DOG_FAMILIES.map((family) => [family.id, family]));
const speciesById = new Map(ANIMAL_SPECIES.map((species) => [species.id, species]));
const orderById = new Map(ANIMAL_ORDERS.map((order) => [order.id, order]));

export function getDogBreed(id) {
  return breedById.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

export function getDogFamily(id) {
  return familyById.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

export function getAnimalSpecies(id) {
  return speciesById.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

export function getAnimalOrder(id) {
  return orderById.get(String(id ?? '').trim().toLowerCase()) ?? null;
}

/** Taxonomic species id for a silhouette family, or null. */
export function getSpeciesIdForFamily(familyId) {
  return getDogFamily(familyId)?.speciesId ?? null;
}

/** Taxonomic species id for a breed, via its family. */
export function getSpeciesIdForBreed(breedId) {
  const breedInfo = getDogBreed(breedId);
  if (!breedInfo) return null;
  return getSpeciesIdForFamily(breedInfo.familyId);
}

/** All silhouette families under a taxonomic species (may be empty). */
export function getFamiliesForSpecies(speciesId = null) {
  if (!speciesId) return [...DOG_FAMILIES];
  const key = String(speciesId).trim().toLowerCase();
  return DOG_FAMILIES.filter((family) => family.speciesId === key);
}

/**
 * Families under a species that currently have at least one authored breed.
 * Empty species (no families or no breeds) return [].
 */
export function getPopulatedFamiliesForSpecies(speciesId) {
  return getFamiliesForSpecies(speciesId).filter((family) => (
    getAuthoredDogBreeds(family.id).length > 0
  ));
}

/** True when the species has ≥1 authored breed (via any nested family). */
export function isSpeciesPopulated(speciesId) {
  return getPopulatedFamiliesForSpecies(speciesId).length > 0;
}

/** True when the breed uses the authored bird GLB rig (not procedural quadruped). */
export function isBirdBreed(breedId) {
  return Boolean(getDogBreed(breedId)?.conformationFlags?.includes('bird-rig'));
}

/** True when the breed is an Insecta catalog entry. */
export function isInsectBreed(breedId) {
  return Boolean(getDogBreed(breedId)?.conformationFlags?.includes('insect'));
}

/** True when the breed uses the procedural ladybug mesh (createProceduralLadybug). */
export function isLadybugBreed(breedId) {
  return Boolean(getDogBreed(breedId)?.conformationFlags?.includes('ladybug-rig'));
}

/** True when the breed uses the bespoke procedural cat rig (createProceduralCat). */
export function isCatRigBreed(breedId) {
  return Boolean(getDogBreed(breedId)?.conformationFlags?.includes('cat-rig'));
}

/** True when the breed uses the bespoke procedural horse rig (createProceduralHorse). */
export function isHorseRigBreed(breedId) {
  return Boolean(getDogBreed(breedId)?.conformationFlags?.includes('horse-rig'));
}

/** True when the taxonomic species is under order Aves. */
export function isAvianSpecies(speciesId) {
  return getAnimalSpecies(speciesId)?.orderId === 'aves';
}

/** True when the taxonomic species is under order Insecta. */
export function isInsectSpecies(speciesId) {
  return getAnimalSpecies(speciesId)?.orderId === 'insecta';
}

export function normalizeDogBreedId(id, fallback = 'golden-retriever') {
  return getDogBreed(id)?.id ?? getDogBreed(fallback)?.id ?? 'golden-retriever';
}

/**
 * Rendering boundary: authored quadruped/bird breeds keep their id. Insect
 * catalog entries have no mesh yet and fall back to Golden. Catalog-only stubs
 * fall back to the first authored breed in the same silhouette family (e.g.
 * feline stubs → tortoiseshell). Unknown ids fall back to Golden.
 */
export function normalizeRenderableDogBreedId(id) {
  const candidate = getDogBreed(id);
  if (!candidate) return 'golden-retriever';
  // Insects are catalog identity only — never resolve a dog phenotype for them.
  if (candidate.conformationFlags?.includes('insect')) return 'golden-retriever';
  if (candidate.authored) return candidate.id;
  const familyAuthored = getAuthoredDogBreeds(candidate.familyId)
    .filter((breedInfo) => !breedInfo.conformationFlags?.includes('insect'));
  if (familyAuthored.length) return familyAuthored[0].id;
  return 'golden-retriever';
}

const DEFAULT_VARIANT_LIST = Object.freeze([{ id: 'default', label: 'Standard', kind: 'type' }]);

/** Discrete named subtypes for a breed (coat/size). Always non-empty. */
export function getDogVariants(breedId) {
  return getDogBreed(breedId)?.variants ?? DEFAULT_VARIANT_LIST;
}

/** Unknown/missing variant → the breed's authored default, never throws. */
export function normalizeDogVariantId(breedId, variantId) {
  const breedInfo = getDogBreed(breedId);
  if (!breedInfo) return 'default';
  return breedInfo.variants.some((variant) => variant.id === variantId)
    ? variantId
    : breedInfo.defaultVariantId;
}

/** All catalog breeds for a family (authored + stubs). Omitting familyId → all. */
export function getDogBreeds(familyId = null) {
  if (!familyId) return [...DOG_BREEDS];
  return DOG_BREEDS.filter((breedInfo) => breedInfo.familyId === familyId);
}

export function getAuthoredDogBreeds(familyId = null) {
  return DOG_BREEDS.filter((breedInfo) => (
    breedInfo.authored && (!familyId || breedInfo.familyId === familyId)
  ));
}

/** Authored breeds under any family of the given taxonomic species. */
export function getAuthoredBreedsForSpecies(speciesId) {
  const familySet = new Set(getFamiliesForSpecies(speciesId).map((family) => family.id));
  return DOG_BREEDS.filter((breedInfo) => breedInfo.authored && familySet.has(breedInfo.familyId));
}

/** All catalog breeds under any family of the given taxonomic species. */
export function getBreedsForSpecies(speciesId) {
  const familySet = new Set(getFamiliesForSpecies(speciesId).map((family) => family.id));
  return DOG_BREEDS.filter((breedInfo) => familySet.has(breedInfo.familyId));
}
