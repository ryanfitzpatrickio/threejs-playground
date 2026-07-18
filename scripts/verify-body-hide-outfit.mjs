// Regression check for installBodyHideUnderOutfit (bodyHideUnderOutfit.js).
//
// Guards the body-replacement contract used when authored outfits cover the
// UBC male/female bodies in the Sim Creator:
//
// 1. Rule ordering: the head height-band keep (cy >= headYCut, 78% of mesh
//    height) used to run BEFORE the bone-weight drop. The UBC shoulder/trap
//    line sits above that cut, so bare shoulder skin was blanket-kept and
//    poked through outfit collars on both bodies (front and back). Weight
//    drops must outrank the height band; the band only rescues head geometry
//    when bone-name matching fails. Neck bones (DEF-spine.004/.005) count as
//    "head" so open necklines show skin instead of a hole.
//
// 2. Shared-geometry mutation: cloneVibeHumanModel clones share geometry with
//    their template (SkeletonUtils.clone). The hide pass used to rewrite the
//    index in place, hiding the torso on EVERY sim using that body and
//    corrupting restore order with two same-body outfits. It must install a
//    wrapper geometry and leave the source untouched.
//
// 3. Continuous recessed skin (2026-07-16): the old neckline "windows" chose
//    whole low-poly triangles per hand-tuned band (trap/sternum/bib/fans),
//    which produced sawtooth collar edges, gaps behind straps and open backs,
//    and needed per-garment tuck sliders. Now EVERY hidden non-limb triangle
//    moves to ONE recessed companion whose per-vertex recess distance is 0 on
//    vertices shared with the kept surface (watertight join) and ramps to
//    full depth away from it — garment depth defines the visible skin
//    silhouette. Hidden limbs stay dropped (a deep recess would punch through
//    the far side of an arm/calf).
//
// 4. Sanitized bone names: three's GLTFLoader strips dots from node names
//    (PropertyBinding.sanitizeNodeName), so at runtime the Rigify bones are
//    'DEF-spine005', not 'DEF-spine.005'. Bone matchers must be dot-agnostic,
//    and the keep-side height rescue must only run when bone matching truly
//    failed.
//
// Run: node scripts/verify-body-hide-outfit.mjs   (npm run verify:body-hide-outfit)

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installBodyHideUnderOutfit } from '../src/game/characters/simhuman/bodyHideUnderOutfit.js';
import {
  installOutfitLimbCuts,
  suggestLimbRevealFromCoverage,
} from '../src/game/characters/simhuman/outfitLimbVisibility.js';
import {
  createOutfitFitUniforms,
  installOutfitInflateOnMesh,
} from '../src/game/characters/simhuman/outfitInflateMaterial.js';
import {
  compileOutfitLoopCuts,
  createOutfitLoopCut,
  installOutfitLoopCuts,
  pointIsHiddenByLoopCuts,
} from '../src/game/characters/simhuman/outfitLoopCuts.js';

assert.deepEqual(
  suggestLimbRevealFromCoverage({ arms: 0.032 }),
  { arms: 1, legs: 0, feet: 0 },
  'sleeveless imports restore body arms automatically',
);

// Sleeve/leg rings must be local to the selected limb. The old half-space
// extended infinitely along the arm axis and could erase same-side skirt and
// waist geometry far below the loop.
{
  const sleeveCut = createOutfitLoopCut({
    id: 'verify-left-sleeve',
    target: 'leftArm',
    interpolation: 'smooth',
    hideSide: 'positive',
    frame: {
      origin: [0.6, 2.8, 0],
      axis: [1, 0, 0],
      u: [0, 1, 0],
      v: [0, 0, 1],
    },
    points: [
      [0.72, 2.95, 0],
      [0.72, 2.8, 0.15],
      [0.72, 2.65, 0],
      [0.72, 2.8, -0.15],
    ],
  });
  const compiledSleeve = compileOutfitLoopCuts([sleeveCut]);
  assert.ok(
    pointIsHiddenByLoopCuts(compiledSleeve, 1.0, 2.8, 0),
    'sleeve loop cuts the distal arm inside its ring',
  );
  assert.ok(
    !pointIsHiddenByLoopCuts(compiledSleeve, 1.0, 1.4, 0),
    'sleeve loop cannot cut distant same-side waist/skirt geometry',
  );
}
assert.deepEqual(
  suggestLimbRevealFromCoverage({ arms: 0.134 }),
  { arms: 0, legs: 0, feet: 0 },
  'short/sleeved imports keep garment-owned arms',
);

// --- Synthetic body: vertices shaped like the UBC layout --------------------
// Height span 0..3.5 → headYCut = 2.73, footYCut = 0.42.
// Shoulder verts sit ABOVE headYCut (the regression trigger), neck verts are
// neck-bone weighted, chest verts sit mid-band, hand verts are extremities.
// Upper-arm/forearm/thigh bones carry bind translations so the limb spatial
// classifier sees real ranges (shoulder shelf inside torso, hand on the arm).

// Runtime (sanitized, dotless) names — what GLTFLoader actually produces.
const BONE_DEFS = [
  ['DEF-spine003', null],
  ['DEF-shoulderL', null],
  ['DEF-spine005', null],
  ['DEF-spine006', null],
  ['DEF-handL', null],
  ['DEF-breastL', null],
  ['DEF-footL', null],
  ['DEF-thighL', [0.15, 2.0]],
  ['DEF-upper_armL', [0.6, 2.8]],
  ['DEF-forearmL', [0.8, 2.8]],
];
const [CHEST, SHOULDER, NECK, HEAD, HAND, BREAST, FOOT, THIGH] = [0, 1, 2, 3, 4, 5, 6, 7];

function makeTri(regionVerts, boneIndex, positions, skinIndices, skinWeights) {
  for (const [x, y, z] of regionVerts) {
    positions.push(x, y, z);
    skinIndices.push(boneIndex, 0, 0, 0);
    skinWeights.push(1, 0, 0, 0);
  }
}

const positions = [];
const skinIndices = [];
const skinWeights = [];
// Anchor verts so the mesh spans the full 0..3.5 body height (feet + crown).
// Foot verts lean toward -z: the facing detector reads the toe direction.
makeTri([[0, 0.05, -0.06], [0.1, 0.05, -0.06], [0, 0.1, -0.06]], FOOT, positions, skinIndices, skinWeights);
makeTri([[0, 3.5, 0], [0.1, 3.5, 0], [0, 3.45, 0]], HEAD, positions, skinIndices, skinWeights);
// Shoulder tri ABOVE headYCut (y≈2.9) — must leave the body surface. Its
// shoulder-bone weights classify as "arms", but it sits inside the torso
// spatial range, so it belongs to the recessed companion (collar skin), not
// to the dropped limb set.
makeTri([[0.4, 2.9, 0], [0.5, 2.9, 0], [0.45, 2.85, 0]], SHOULDER, positions, skinIndices, skinWeights);
// Neck tri above headYCut — must be kept (open necklines show skin).
makeTri([[0, 2.95, 0], [0.05, 2.95, 0], [0, 2.9, 0]], NECK, positions, skinIndices, skinWeights);
// Chest tri mid-band (y≈2.4) — off the surface, recessed.
makeTri([[0, 2.4, 0], [0.1, 2.4, 0], [0, 2.35, 0]], CHEST, positions, skinIndices, skinWeights);
// Hand tri mid-height (arms hang) — garment owns arms at reveal 0: dropped.
makeTri([[0.6, 1.3, 0], [0.7, 1.3, 0], [0.65, 1.25, 0]], HAND, positions, skinIndices, skinWeights);
// Unclassified-bone tri above headYCut (y≈2.85) — the old blanket height
// rescue kept these; with matched bone tables they must leave the surface.
makeTri([[0.2, 2.85, 0], [0.3, 2.85, 0], [0.25, 2.8, 0]], BREAST, positions, skinIndices, skinWeights);
// Sternum tri: front-center (-z), just below the neck. The continuous
// companion must fill it (deep necklines) without any tuck configuration.
makeTri([[0, 2.78, -0.2], [0.08, 2.78, -0.2], [0, 2.74, -0.2]], CHEST, positions, skinIndices, skinWeights);
// Neck-EDGE tri: two neck-dominant verts and one chest vert. Min-based keep
// drops it from the surface; its first vertex coincides with a kept neck
// vertex, so the recess field must be EXACTLY 0 there (watertight join).
{
  const verts = [[0, 2.9, 0], [0.1, 2.6, 0], [-0.1, 2.6, 0]];
  for (let v = 0; v < 3; v += 1) {
    positions.push(...verts[v]);
    skinIndices.push(v < 2 ? NECK : CHEST, 0, 0, 0);
    skinWeights.push(1, 0, 0, 0);
  }
}
// Thigh tri used by the complementary limb reveal checks.
makeTri([[0.2, 1.8, 0], [0.35, 1.8, 0], [0.25, 1.65, 0]], THIGH, positions, skinIndices, skinWeights);
// Broad trap fan on the BACK (+z): only one neck vertex. The old system left
// this as a HOLE (excluded from surface and windows) — open-back garments
// showed gaps. The continuous companion must fill it recessed.
{
  const verts = [[0, 2.9, 0.04], [0.3, 2.65, 0.08], [-0.3, 2.65, 0.08]];
  for (let v = 0; v < 3; v += 1) {
    positions.push(...verts[v]);
    skinIndices.push(v === 0 ? NECK : CHEST, 0, 0, 0);
    skinWeights.push(1, 0, 0, 0);
  }
}
// Matching one-neck fan on the FRONT — fills the collar sawtooth recessed.
{
  const verts = [[0, 2.9, -0.04], [0.3, 2.65, -0.08], [-0.3, 2.65, -0.08]];
  for (let v = 0; v < 3; v += 1) {
    positions.push(...verts[v]);
    skinIndices.push(v === 0 ? NECK : CHEST, 0, 0, 0);
    skinWeights.push(1, 0, 0, 0);
  }
}
// Coarse all-neck-weighted fan: without an authored loop this belongs to the
// true neck surface. With a neckline loop, only its top corner is inside the
// opening; the loop transition must outrank the automatic neck keep or this
// entire long triangle appears as a jagged body/mannequin shard.
makeTri(
  [[0, 2.9, -0.04], [0.3, 2.65, -0.08], [-0.3, 2.65, -0.08]],
  NECK,
  positions,
  skinIndices,
  skinWeights,
);
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
const vertCount = positions.length / 3;
const sourceIndex = [...Array(vertCount).keys()];
geometry.setIndex(sourceIndex);
geometry.addGroup(0, 9, 0);
geometry.addGroup(9, vertCount - 9, 1);

// shouldProcessMesh skips meshes under 200 verts — pad the count without
// adding triangles (extra verts are unreferenced by the index).
{
  const padded = new Float32Array(200 * 3);
  padded.set(positions);
  geometry.setAttribute('position', new THREE.BufferAttribute(padded, 3));
  const padIdx = new Uint16Array(200 * 4);
  padIdx.set(skinIndices);
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(padIdx, 4));
  const padW = new Float32Array(200 * 4);
  padW.set(skinWeights);
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(padW, 4));
}

const bones = BONE_DEFS.map(([name]) => {
  const bone = new THREE.Bone();
  bone.name = name;
  return bone;
});
const boneInverses = BONE_DEFS.map(([, translation]) => (translation
  ? new THREE.Matrix4().makeTranslation(-translation[0], -translation[1], 0)
  : new THREE.Matrix4()));
const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
mesh.name = 'SyntheticBody';
// Explicit bind matrix: bind() without one RECALCULATES boneInverses from the
// (identity) bone world transforms, silently discarding the bind translations
// the limb spatial classifier needs.
mesh.bind(new THREE.Skeleton(bones, boneInverses), new THREE.Matrix4());
const parent = new THREE.Group();
parent.add(mesh);

const TRI = {
  foot: 0,
  crown: 1,
  shoulder: 2,
  neck: 3,
  chest: 4,
  hand: 5,
  breast: 6,
  sternum: 7,
  neckEdge: 8,
  leg: 9,
  broadNeckFan: 10,
  frontNeckFan: 11,
  coarseNeckFan: 12,
};

function triangleSet(indexAttr) {
  const set = new Set();
  for (let i = 0; i < (indexAttr?.count ?? 0); i += 3) {
    set.add(Math.floor(indexAttr.getX(i) / 3));
  }
  return set;
}

const handle = installBodyHideUnderOutfit({ skinnedMeshes: [mesh] });
assert.ok(handle, 'hide should install on the synthetic body mesh');
assert.equal(handle.meshCount, 1);
assert.equal(handle.recessedMeshCount, 1, 'one continuous recessed companion, no band windows');

// Source geometry untouched (shared across model clones).
assert.notEqual(mesh.geometry, geometry, 'mesh should get a wrapper geometry');
assert.equal(geometry.getIndex().count, vertCount, 'source index must not be rewritten');
assert.equal(geometry.groups.length, 2, 'source groups must not be cleared');
assert.ok(
  !geometry.getAttribute('bodyHideRecess'),
  'recess attribute must live on the wrapper only, never the shared source',
);
assert.ok(
  !geometry.getAttribute('bodyHideSeamRecess'),
  'seam recess attribute must live on the wrapper only, never the shared source',
);

const keptTris = triangleSet(mesh.geometry.getIndex());
assert.ok(keptTris.has(TRI.crown), 'crown tri kept');
assert.ok(keptTris.has(TRI.neck), 'neck tri kept (open necklines show skin)');
assert.ok(keptTris.has(TRI.coarseNeckFan), 'coarse neck fan stays on the true surface without a loop');
assert.ok(!keptTris.has(TRI.foot), 'foot body hidden when garment owns the feet');
assert.ok(!keptTris.has(TRI.hand), 'arm body hidden when garment owns the arms');
assert.ok(!keptTris.has(TRI.leg), 'leg body hidden when garment owns the legs');
assert.ok(!keptTris.has(TRI.chest), 'chest tri off the body surface');
assert.ok(
  !keptTris.has(TRI.shoulder),
  'shoulder tri above headYCut must leave the surface — weights outrank the head height band',
);
assert.ok(
  !keptTris.has(TRI.breast),
  'unclassified-bone tri above headYCut must leave the surface when bone tables matched',
);
assert.ok(
  !keptTris.has(TRI.neckEdge),
  'tri with a single neck-dominant vert must leave the surface (min-based keep, not max)',
);
assert.equal(mesh.geometry.groups.length, 1, 'wrapper draws one group over the filtered index');
assert.equal(mesh.geometry.groups[0].count, mesh.geometry.getIndex().count);

// --- Continuous recessed companion ------------------------------------------
const companion = parent.getObjectByName('SyntheticBody:recessedSkin');
assert.ok(companion?.isSkinnedMesh, 'recessed skin is a companion skinned mesh');
const companionTris = triangleSet(companion.geometry.getIndex());
for (const name of ['shoulder', 'chest', 'breast', 'sternum', 'neckEdge', 'broadNeckFan', 'frontNeckFan']) {
  assert.ok(
    companionTris.has(TRI[name]),
    `companion covers ${name} — continuous fill, no per-garment band selection`,
  );
}
assert.ok(!companionTris.has(TRI.neck), 'companion excludes kept head/neck triangles');
assert.ok(!companionTris.has(TRI.crown), 'companion excludes the face/crown');
assert.ok(!companionTris.has(TRI.hand), 'hidden limbs are dropped, not recessed (thin limbs invert)');
assert.ok(!companionTris.has(TRI.leg), 'hidden legs are dropped, not recessed');
assert.ok(!companionTris.has(TRI.foot), 'hidden feet are dropped, not recessed');

assert.ok(
  companion.material.depthWrite,
  'companion writes depth — recessed skin must occlude the interior lining',
);
assert.equal(companion.material.side, THREE.FrontSide, 'only outward skin fills openings');
assert.ok(companion.material.positionNode, 'companion material has a TSL inward position node');
assert.ok(companion.material.userData.bodyRecessedSkin, 'companion material is tagged');
assert.equal(companion.skeleton, mesh.skeleton, 'companion shares the live body skeleton');
assert.equal(
  companion.morphTargetInfluences,
  mesh.morphTargetInfluences,
  'companion shares live body morph influences',
);

// Watertight join: the neckEdge vertex that coincides with a kept neck vertex
// must have recess distance EXACTLY 0; the rest of the companion ramps to
// full depth (≈0.085 raw units scaled to the 3.5 span) with distance from the
// kept boundary. Islands with no kept neighbour (chest, back fan) sit at full
// depth — they are only visible where the garment leaves them open.
const recessAttr = companion.geometry.getAttribute('bodyHideRecess');
assert.ok(recessAttr, 'companion bakes a per-vertex recess distance attribute');
assert.ok(
  companion.geometry.getAttribute('bodyHideSeamRecess'),
  'companion separates limb-seam recess so both depths can update independently',
);
const companionGeometry = companion.geometry;
handle.setSkinTuck({ torso: 0.42, seams: 0.73 });
assert.deepEqual(handle.skinTuck, { torso: 0.42, seams: 0.73 });
assert.equal(
  companion.geometry,
  companionGeometry,
  'live tuck controls update shader uniforms without rebuilding companion geometry',
);
assert.equal(companion.material.userData.bodyRecess.skinTuckUniforms.torso.value, 0.42);
assert.equal(companion.material.userData.bodyRecess.skinTuckUniforms.seams.value, 0.73);
const NECK_EDGE_V0 = TRI.neckEdge * 3; // coincides with kept neck vert [0, 2.9, 0]
assert.equal(recessAttr.getX(NECK_EDGE_V0), 0, 'kept-boundary vertex must not recess');
const fullDepth = (0.085 / 3.49) * 3.45; // TORSO_SKIN_RECESS scaled by ySpan
for (const vertex of [NECK_EDGE_V0 + 1, NECK_EDGE_V0 + 2]) {
  const amount = recessAttr.getX(vertex);
  assert.ok(
    Math.abs(amount - fullDepth) < fullDepth * 0.15,
    `neckEdge far vertex ${vertex} reaches full depth (got ${amount})`,
  );
}
for (const name of ['chest', 'sternum', 'broadNeckFan']) {
  for (let corner = 0; corner < 3; corner += 1) {
    const amount = recessAttr.getX(TRI[name] * 3 + corner);
    assert.ok(
      amount > fullDepth * 0.5,
      `${name} vertex ${corner} recesses deep (got ${amount})`,
    );
  }
}
const shoulderRecess = recessAttr.getX(TRI.shoulder * 3);
assert.ok(shoulderRecess > 0, 'trap/shoulder shelf recesses behind collars and straps');

// Dispose restores the original geometry reference, no index surgery.
handle.dispose();
assert.equal(mesh.geometry, geometry, 'dispose should restore the source geometry');
assert.equal(geometry.getIndex().count, vertCount);
assert.equal(companion.parent, null, 'dispose removes the recessed companion');

// Full reveal restores the real body on all three limb regions. The outfit
// applies the inverse of this selection in outfitLimbVisibility.js.
const revealed = installBodyHideUnderOutfit(
  { skinnedMeshes: [mesh] },
  { limbReveal: { arms: 1, legs: 1, feet: 1 } },
);
const revealTris = triangleSet(mesh.geometry.getIndex());
assert.ok(revealTris.has(TRI.hand), 'full arm reveal restores body hands/arms');
assert.ok(revealTris.has(TRI.leg), 'full leg reveal restores body legs');
assert.ok(revealTris.has(TRI.foot), 'full foot reveal restores body feet');
const revealedCompanion = parent.getObjectByName('SyntheticBody:recessedSkin');
const revealedCompanionTris = triangleSet(revealedCompanion.geometry.getIndex());
assert.ok(
  revealedCompanionTris.has(TRI.shoulder),
  'trap shelf stays recessed even at full arm reveal (it is torso, not arm)',
);
revealed.dispose();

// Arm reveal 1..2 deliberately continues beyond the base limb: shoulder and
// collarbone first, then the medial sternum at 2. Lower chest stays recessed.
const extendedReveal = installBodyHideUnderOutfit(
  { skinnedMeshes: [mesh] },
  { limbReveal: { arms: 2, legs: 0, feet: 0 } },
);
const extendedRevealTris = triangleSet(mesh.geometry.getIndex());
assert.ok(extendedRevealTris.has(TRI.shoulder), 'arm reveal 2 restores the shoulder/collar shelf');
assert.ok(extendedRevealTris.has(TRI.sternum), 'arm reveal 2 reaches the center sternum');
assert.ok(!extendedRevealTris.has(TRI.chest), 'arm extension stays inside its upper-chest band');
extendedReveal.dispose();

// A sharp torso loop can dip to a front-center V while staying high around
// the shoulder/back. The garment loses the selected side and the body keeps
// that identical side at the true surface.
const vNeckCut = createOutfitLoopCut({
  id: 'verify-v-neck',
  target: 'torso',
  interpolation: 'sharp',
  hideSide: 'positive',
  points: [
    [0.45, 2.82, 0],
    [0, 2.5, -0.3],
    [-0.45, 2.82, 0],
    [0, 2.82, 0.3],
  ],
});
assert.ok(vNeckCut, 'sharp V-neck loop sanitizes');
const loopBody = installBodyHideUnderOutfit(
  { skinnedMeshes: [mesh] },
  { loopCuts: [vNeckCut] },
);
const loopBodyTris = triangleSet(mesh.geometry.getIndex());
assert.ok(loopBodyTris.has(TRI.sternum), 'loop restores body inside the front V');
assert.ok(!loopBodyTris.has(TRI.chest), 'loop leaves lower covered chest recessed');
assert.ok(
  !loopBodyTris.has(TRI.frontNeckFan),
  'torso loop does not restore a coarse triangle with only one corner inside the opening',
);
assert.ok(
  !loopBodyTris.has(TRI.coarseNeckFan),
  'torso transition outranks automatic neck keep for a straddling neck-weighted triangle',
);
assert.ok(
  triangleSet(parent.getObjectByName('SyntheticBody:recessedSkin').geometry.getIndex())
    .has(TRI.frontNeckFan),
  'torso loop leaves its straddling body transition on the recessed companion',
);
assert.ok(
  triangleSet(parent.getObjectByName('SyntheticBody:recessedSkin').geometry.getIndex())
    .has(TRI.coarseNeckFan),
  'straddling neck-weighted transition moves to the recessed companion',
);
loopBody.dispose();

const loopGarment = installOutfitLoopCuts([mesh], [vNeckCut]);
const loopGarmentTris = triangleSet(mesh.geometry.getIndex());
assert.ok(!loopGarmentTris.has(TRI.sternum), 'loop removes garment inside the front V');
assert.ok(
  !loopGarmentTris.has(TRI.frontNeckFan),
  'torso loop removes a coarse donor-neck triangle as soon as one corner enters the cut side',
);
assert.ok(loopGarmentTris.has(TRI.chest), 'loop keeps garment below the neckline');
assert.ok(loopGarment.visibleTriangles < loopGarment.sourceTriangles, 'closed loop removes one side');
const loopVisibleAtZero = loopGarment.visibleTriangles;
loopGarment.setCuts([{ ...vNeckCut, edgeInset: 0.3 }]);
assert.ok(
  loopGarment.visibleTriangles > loopVisibleAtZero,
  'positive edge adjustment keeps more garment without redrawing the loop',
);
loopGarment.dispose();

const insetLoopBody = installBodyHideUnderOutfit(
  { skinnedMeshes: [mesh] },
  { loopCuts: [{ ...vNeckCut, edgeInset: 0.3 }] },
);
assert.ok(
  !triangleSet(mesh.geometry.getIndex()).has(TRI.sternum),
  'body handoff retreats with the same keep-more edge adjustment',
);
insetLoopBody.dispose();

// Torso ring limit ("tube" cuts). The neck's side angles put shoulder tops at
// the same height as donor-shell cruft inside the neck hole, so a radius-blind
// axial cut cannot remove one without eating the other. A finite radialReach
// bounds the cut to a tube around the drawn dots; missing/null reach keeps
// legacy radius-blind behavior.
const neckRing = {
  target: 'torso',
  interpolation: 'sharp',
  hideSide: 'positive',
  frame: { origin: [0, 0, 0], axis: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  points: [
    [0.2, 2.6, 0],
    [0, 2.6, 0.2],
    [-0.2, 2.6, 0],
    [0, 2.6, -0.2],
  ],
};
const tubeCut = compileOutfitLoopCuts([{ ...neckRing, radialReach: 0.05 }]);
assert.ok(
  pointIsHiddenByLoopCuts(tubeCut, 0.1, 2.8, 0.1),
  'ring-limited cut hides cruft inside the drawn tube',
);
assert.ok(
  !pointIsHiddenByLoopCuts(tubeCut, 0.45, 2.8, 0),
  'ring-limited cut spares the shoulder top at the same height',
);
assert.ok(
  !pointIsHiddenByLoopCuts(tubeCut, 0.1, 2.5, 0.1),
  'ring-limited cut keeps garment below the loop inside the tube',
);
const legacyCut = compileOutfitLoopCuts([neckRing]);
assert.ok(
  pointIsHiddenByLoopCuts(legacyCut, 0.45, 2.8, 0),
  'cuts without a ring limit stay radius-blind (legacy behavior)',
);
// UI opt-out stores null; JSON also cannot represent Infinity. Both must
// sanitize back to the unlimited legacy cut.
for (const raw of [{ ...neckRing, radialReach: null }, JSON.parse(JSON.stringify({ ...neckRing, radialReach: Infinity }))]) {
  assert.ok(
    pointIsHiddenByLoopCuts(compileOutfitLoopCuts([raw]), 0.45, 2.8, 0),
    'null/JSON-round-tripped ring limit restores the radius-blind cut',
  );
}

const garmentCut = installOutfitLimbCuts(
  [mesh],
  { arms: 1, legs: 1, feet: 1 },
);
const garmentIdx = mesh.geometry.getIndex();
assert.equal(garmentIdx.count, geometry.getIndex().count, 'fragment cut keeps complete source topology');
assert.ok(
  garmentCut.visibleTriangles < garmentCut.sourceTriangles,
  'full reveal mask identifies garment limb triangles',
);
const visibleAtArmOne = garmentCut.visibleTriangles;
garmentCut.setReveal({ arms: 2, legs: 1, feet: 1 });
assert.ok(
  garmentCut.visibleTriangles < visibleAtArmOne,
  'arm reveal 2 cuts garment shoulder/collar/sternum beyond the base limb',
);
const garmentCutAttribute = mesh.geometry.getAttribute('outfitLimbCut');
assert.ok(
  garmentCutAttribute.getX(TRI.shoulder * 3) > 1
    && garmentCutAttribute.getX(TRI.shoulder * 3) <= 2,
  'garment shoulder receives an extended arm coordinate',
);
assert.equal(
  garmentCutAttribute.getX(TRI.sternum * 3),
  2,
  'garment center sternum is the end of the arm extension',
);
assert.equal(
  garmentCutAttribute?.itemSize,
  3,
  'garment wrapper packs interpolated arm/leg/foot coordinates into one buffer',
);
assert.equal(mesh.geometry.getAttribute('position'), geometry.getAttribute('position'), 'cut shares source vertex/UV buffers');
assert.ok(mesh.geometry.groups.length > 1, 'cut preserves source material groups');
garmentCut.dispose();
assert.equal(mesh.geometry, geometry, 'garment cut dispose restores source geometry');

// WebGPU builds a separate shadow override material. opacityNode drives the
// visible alpha cut but is not copied into that pass; maskShadowNode must carry
// the same limb selection or invisible sleeves/bodices still cast shadows on
// the body that reveal restored underneath.
{
  const shadowMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  const fitUniforms = createOutfitFitUniforms();
  fitUniforms.setFitPosition({ x: 0.12, y: -0.08, z: 0.04 });
  const shadowMaterials = installOutfitInflateOnMesh(shadowMesh, fitUniforms);
  assert.equal(shadowMaterials.length, 1, 'outfit material installs for shadow regression');
  assert.deepEqual(
    fitUniforms.fitPositionUniform.value.toArray(),
    [0.12, -0.08, 0.04],
    'baked outfit XYZ offset updates through shared shader uniforms',
  );
  assert.equal(
    shadowMesh.material.userData.outfitFitPositionUniform,
    fitUniforms.fitPositionUniform,
    'all outfit pieces share the same bind-pose position uniform',
  );
  assert.ok(shadowMesh.material.opacityNode, 'visible pass keeps soft limb coverage');
  assert.ok(shadowMesh.material.maskShadowNode, 'shadow pass receives the hard limb cut mask');
  assert.equal(shadowMesh.material.maskNode, null, 'visible pass is not replaced by a hard mask');
  for (const material of shadowMaterials) material.dispose();
}

// UV seams duplicate positions and therefore split one visible shell into
// separate index islands. The limb classifier must reconnect those coincident
// corners without welding the real buffers, or a torso bridge between two
// shoulder panels is ignored and full Arm reveal shreds the garment.
{
  const seamGeometry = new THREE.BufferGeometry();
  const seamPositions = [
    // Left arm-weighted panel.
    -0.8, 0.3, 0, -0.7, 0.4, 0, -0.7, 1.2, 0,
    // Torso bridge. Its end corners duplicate the panels but use private
    // indices, exactly like a glTF UV seam.
    -0.7, 0.4, 0, 0, 0.7, 0, 0.7, 0.4, 0,
    // Right arm-weighted panel.
    0.7, 0.4, 0, 0.8, 0.3, 0, 0.7, 1.2, 0,
  ];
  seamGeometry.setAttribute('position', new THREE.Float32BufferAttribute(seamPositions, 3));
  seamGeometry.setIndex([...Array(9).keys()]);
  const seamSkinIndices = [];
  const seamSkinWeights = [];
  for (let vertex = 0; vertex < 9; vertex += 1) {
    const bone = vertex < 3 ? 1 : vertex < 6 ? 0 : 2;
    seamSkinIndices.push(bone, 0, 0, 0);
    seamSkinWeights.push(1, 0, 0, 0);
  }
  seamGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(seamSkinIndices, 4));
  seamGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(seamSkinWeights, 4));
  const seamBones = ['DEF-spine003', 'DEF-upper_armL', 'DEF-upper_armR', 'DEF-forearmL', 'DEF-forearmR']
    .map((name) => Object.assign(new THREE.Bone(), { name }));
  const inverseAt = (x, y) => new THREE.Matrix4().makeTranslation(-x, -y, 0);
  const seamSkeleton = new THREE.Skeleton(seamBones, [
    new THREE.Matrix4(),
    inverseAt(-0.4, 2.5),
    inverseAt(0.4, 2.5),
    inverseAt(-0.8, 2.5),
    inverseAt(0.8, 2.5),
  ]);
  const seamMesh = new THREE.SkinnedMesh(seamGeometry, new THREE.MeshBasicMaterial());
  seamMesh.bind(seamSkeleton, new THREE.Matrix4());
  const seamCut = installOutfitLimbCuts([seamMesh], { arms: 1, legs: 0, feet: 0 });
  const seamAttribute = seamMesh.geometry.getAttribute('outfitLimbCut');
  assert.equal(seamAttribute.getX(0), 3, 'left panel is protected through its coincident UV seam');
  assert.equal(seamAttribute.getX(6), 3, 'right panel is protected through its coincident UV seam');
  assert.equal(
    seamMesh.geometry.getAttribute('position'),
    seamGeometry.getAttribute('position'),
    'classification-only seam clumping leaves rendered positions untouched',
  );
  seamCut.dispose();
}

console.log('verify-body-hide-outfit: continuous recessed skin + complementary limb masks OK');
