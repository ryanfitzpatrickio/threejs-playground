/**
 * Face features matched to golden-retriever head-close stills:
 * - Dark eyes with almost no white sclera
 * - Soft golden lids (not cartoon outlines)
 * - Wet leather nose with blend into cream muzzle
 * - Subtle mouth crease
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color as tslColor, float } from 'three/tsl';

const IRIS = 0x2c1810;
const PUPIL = 0x050403;
const LID = 0xb08a52;
const LID_DARK = 0x8a6830;
const NOSE = 0x241a14;
const NOSE_BLEND = 0xc09a68;
const MOUTH = 0x5a3a28;
const WHISKER = 0xe8dcc8;
const TOOTH = 0xf4ecd8;
const GUM = 0x7a3d3a;
const MOUTH_INTERIOR = 0x5c2220;
const TONGUE = 0xd8687a;
const TONGUE_DARK = 0xb84f60;

/**
 * Tapered lathe profile for one tongue segment — revolved around the
 * segment's local +Y, which callers then rotate 90° onto +Z (mouth-forward)
 * and squash on local Z so the tongue reads as a flat blade, not a sausage.
 * `taperEnd` false keeps the far end near full width (for the base segment,
 * which the tip segment continues from); true rounds it to a point (the tip).
 */
function buildTongueSegmentGeometry(radiusBase, length, { taperEnd = true, radialSegments = 12, heightSegments = 8 } = {}) {
  const points = [];
  for (let i = 0; i <= heightSegments; i += 1) {
    const t = i / heightSegments;
    // Mild width ease — avoid a round balloon mid-tongue.
    const bulge = 1 + 0.04 * Math.sin(Math.min(t, 0.55) / 0.55 * Math.PI);
    const taper = taperEnd
      ? 1 - THREE.MathUtils.smoothstep(t, 0.45, 1) * 0.94
      : 1 - THREE.MathUtils.smoothstep(t, 0.85, 1) * 0.1;
    const r = Math.max(0.0004, radiusBase * bulge * taper);
    points.push(new THREE.Vector2(r, t * length));
  }
  return new THREE.LatheGeometry(points, radialSegments);
}

/** Local scale after rot.x=90°: X = width, Y = length axis, Z = thickness (flatten). */
const TONGUE_FLAT_SCALE = new THREE.Vector3(1.2, 1, 0.28);

/**
 * @param {Map<string, THREE.Bone>} bonesByName
 */
export function createDogHeadFeatures(bonesByName, phenotype = null) {
  const head = bonesByName.get('Head');
  const muzzle = bonesByName.get('Muzzle');
  const noseTip = bonesByName.get('NoseTip');
  if (!head) throw new Error('Head bone required for face features');
  const headScale = phenotype?.skeleton?.headSize ?? 1;
  const faceShape = phenotype?.face ?? {};

  const group = new THREE.Group();
  group.name = 'DogHeadFeatures';
  const disposables = [];

  const mat = (hex, { opacity = 1, depthTest = true, depthWrite } = {}) => {
    const opaque = opacity >= 0.999;
    const m = new MeshBasicNodeMaterial({
      transparent: !opaque,
      depthTest,
      depthWrite: depthWrite ?? opaque,
      side: THREE.FrontSide,
    });
    m.colorNode = tslColor(new THREE.Color(hex));
    m.opacityNode = float(opacity);
    disposables.push(m);
    return m;
  };

  // Ref: mid-head, modest size, dark iris filling the opening.
  const geometryShape = phenotype?.geometry ?? {};
  const irisColor = faceShape.irisColor ?? IRIS;
  const lidColor = faceShape.lidColor ?? LID;
  const lidDarkColor = faceShape.lidDarkColor ?? LID_DARK;
  const eyeY = 0.016 * headScale * (faceShape.eyeHeight ?? 1);
  const eyeX = 0.032 * headScale * (faceShape.eyeSpacing ?? 1);
  const eyeR = 0.0135 * headScale * (faceShape.eyeScale ?? 1);
  const skullRx = 0.07 * headScale * 1.18 * (geometryShape.skullWidth ?? 1);
  const skullRy = 0.07 * headScale * 0.97 * (geometryShape.skullHeight ?? 1);
  const skullRz = 0.07 * headScale * 1.1 * (geometryShape.skullLength ?? 1);
  const eyeSurface = Math.sqrt(Math.max(
    0.08,
    1 - (eyeX / skullRx) ** 2 - ((eyeY - 0.008) / skullRy) ** 2,
  ));
  const eyeZ = 0.005 + skullRz * eyeSurface
    + 0.004 * headScale
    + ((faceShape.eyeForward ?? 1) - 1) * 0.008 * headScale;

  /** @type {{ root: THREE.Group, iris: THREE.Mesh, lids: THREE.Mesh[] }[]} */
  const eyes = [];

  for (const side of [1, -1]) {
    const eyeRoot = new THREE.Group();
    eyeRoot.name = side > 0 ? 'EyeL' : 'EyeR';
    eyeRoot.position.set(side * eyeX, eyeY, eyeZ);
    eyeRoot.rotation.y = side * 0.2;
    eyeRoot.rotation.x = -0.06;
    // Slight slant — inner corner dips toward the nose (golden "kind" eye).
    eyeRoot.rotation.z = side * 0.05;
    eyeRoot.renderOrder = 500;

    // Dark iris fills the opening (dogs show almost no white).
    const irisGeo = new THREE.CircleGeometry(eyeR, 22);
    disposables.push(irisGeo);
    const iris = new THREE.Mesh(irisGeo, mat(irisColor));
    iris.scale.set(1.05, 0.96, 1);
    iris.position.z = 0.001;
    iris.renderOrder = 500;
    eyeRoot.add(iris);

    // Very soft warm edge (not a yellow ring sticker).
    const rimGeo = new THREE.RingGeometry(eyeR * 0.92, eyeR * 1.08, 22);
    disposables.push(rimGeo);
    const rim = new THREE.Mesh(rimGeo, mat(lidDarkColor, { opacity: 0.35 }));
    rim.position.z = 0.0005;
    rim.scale.set(1.05, 0.96, 1);
    rim.renderOrder = 499;
    eyeRoot.add(rim);

    // Pupil
    const pupilGeo = new THREE.CircleGeometry(eyeR * 0.4, 14);
    disposables.push(pupilGeo);
    const pupil = new THREE.Mesh(pupilGeo, mat(PUPIL));
    pupil.position.z = 0.002;
    pupil.renderOrder = 501;
    eyeRoot.add(pupil);

    // Catch light
    const catchGeo = new THREE.CircleGeometry(eyeR * 0.1, 8);
    disposables.push(catchGeo);
    const catchLight = new THREE.Mesh(catchGeo, mat(0xffffff, { opacity: 0.8 }));
    catchLight.position.set(side * -0.002, 0.0028, 0.003);
    catchLight.renderOrder = 502;
    eyeRoot.add(catchLight);

    // Soft lids only (no full socket disc — that read as yellow rings).
    // Upper lid hugs the top of the iris so the eye reads open, not sleepy.
    const lids = [];
    {
      const lidGeo = new THREE.CircleGeometry(eyeR * 1.2, 16, 0, Math.PI);
      disposables.push(lidGeo);
      const lid = new THREE.Mesh(lidGeo, mat(lidColor, { opacity: 0.8 }));
      lid.position.set(0, eyeR * 0.68, 0.0015);
      lid.scale.set(1.1, 0.3, 1);
      lid.renderOrder = 503;
      eyeRoot.add(lid);
      lids.push(lid);
    }
    {
      const lidGeo = new THREE.CircleGeometry(eyeR * 1.1, 14, 0, Math.PI);
      disposables.push(lidGeo);
      const lid = new THREE.Mesh(lidGeo, mat(lidColor, { opacity: 0.5 }));
      lid.rotation.z = Math.PI;
      lid.position.set(0, -eyeR * 0.58, 0.0015);
      lid.scale.set(1.06, 0.2, 1);
      lid.renderOrder = 503;
      eyeRoot.add(lid);
      lids.push(lid);
    }

    head.add(eyeRoot);
    eyes.push({ root: eyeRoot, iris, lids });
  }

  // Inner-corner creases — the soft dark lines goldens get from eye to muzzle.
  for (const side of [1, -1]) {
    const creaseGeo = new THREE.CircleGeometry(0.5, 12);
    disposables.push(creaseGeo);
    const crease = new THREE.Mesh(creaseGeo, mat(0x6b4426, { opacity: 0.26 }));
    crease.scale.set(0.0042 * headScale, 0.024 * headScale, 1);
    crease.position.set(side * 0.0195 * headScale, -0.009 * headScale, 0.058 * headScale);
    crease.rotation.z = side * -0.18;
    crease.renderOrder = 498;
    head.add(crease);
  }

  // ---- Nose: compact wet pad meeting cream muzzle ----
  const noseRoot = new THREE.Group();
  noseRoot.name = 'Nose';
  if (noseTip) noseRoot.position.copy(noseTip.position);
  else noseRoot.position.set(0, 0.004, 0.05);
  noseRoot.renderOrder = 510;
  (muzzle ?? head).add(noseRoot);

  // Cream-to-leather blend (matches ref soft transition)
  const noseScale = headScale * (faceShape.noseScale ?? 1);
  const blendGeo = new THREE.SphereGeometry(0.011 * noseScale, 14, 12);
  disposables.push(blendGeo);
  const blend = new THREE.Mesh(blendGeo, mat(NOSE_BLEND, { opacity: 0.42 }));
  blend.position.set(0, -0.002, -0.006);
  blend.scale.set(1.35, 0.8, 0.95);
  blend.renderOrder = 508;
  noseRoot.add(blend);

  const noseGeo = new THREE.SphereGeometry(0.0105 * noseScale, 16, 14);
  disposables.push(noseGeo);
  const noseMesh = new THREE.Mesh(noseGeo, mat(NOSE));
  noseMesh.scale.set(1.35, 0.9, 1.05);
  noseMesh.renderOrder = 510;
  noseRoot.add(noseMesh);

  for (const side of [1, -1]) {
    const pitGeo = new THREE.SphereGeometry(0.0036 * noseScale, 10, 8);
    disposables.push(pitGeo);
    const pit = new THREE.Mesh(pitGeo, mat(0x050403));
    pit.position.set(side * 0.0046 * noseScale, -0.001 * noseScale, 0.008 * noseScale);
    pit.scale.set(1.2, 0.75, 0.6);
    pit.renderOrder = 511;
    noseRoot.add(pit);
  }

  // Soft philtrum
  const philGeo = new THREE.BoxGeometry(0.002 * noseScale, 0.007 * noseScale, 0.005 * noseScale);
  disposables.push(philGeo);
  const phil = new THREE.Mesh(philGeo, mat(0x0a0806, { opacity: 0.5 }));
  phil.position.set(0, -0.008, 0.001);
  phil.renderOrder = 511;
  noseRoot.add(phil);

  // Mouth-depth layout tracks the real nose pad for every muzzle length.
  // Capping at golden-only Z buried teeth mid-snout on retrievers / GSDs
  // (long muzzles extend far past 0.082*headScale). Always sit just behind
  // the nose leather so crowns live in the open lip gap, not inside the loft.
  const jaw = bonesByName.get('Jaw');
  const muzzleLocalZ = muzzle?.position.z ?? 0.07 * headScale;
  const noseLocalZ = noseTip?.position.z ?? 0.058 * headScale;
  const jawLocalZ = jaw?.position.z ?? 0.028 * headScale;
  // NoseTip is parented under Muzzle; both Muzzle and Jaw are Head children.
  const noseHeadZ = muzzleLocalZ + noseLocalZ;
  const lipInset = 0.012 * headScale;
  const toothLocalZ = Math.max(0.03 * headScale, noseHeadZ - jawLocalZ - lipInset);
  const toothHeadZ = jawLocalZ + toothLocalZ;
  const gumLocalZ = Math.max(0.02 * headScale, toothLocalZ - 0.004 * headScale);
  const mouthFrontHeadZ = THREE.MathUtils.clamp(
    toothHeadZ - 0.006 * headScale,
    0.035 * headScale,
    noseHeadZ - 0.004 * headScale,
  );
  // Relative to a mid-size golden row (~0.082*hs) — scales tongue pant extend.
  const mouthDepthScale = THREE.MathUtils.clamp(toothLocalZ / (0.082 * headScale), 0.45, 1.6);

  // ---- Lip crease: tiny flattened disc under the muzzle base ----
  // Parent to Muzzle so long-snout breeds (poodle, doberman) and brachy faces
  // keep the mark on the lip line instead of a free head-local sphere poking
  // out past the underside of the snout.
  const muzzleWidth = geometryShape.muzzleWidth ?? 1;
  const mouthGeo = new THREE.SphereGeometry(0.011 * headScale, 12, 8);
  disposables.push(mouthGeo);
  const mouth = new THREE.Mesh(mouthGeo, mat(0x332014, { opacity: 0.32 }));
  // Muzzle-local: slightly below and behind the muzzle origin (toward the throat).
  mouth.position.set(0, -0.014 * headScale, -0.012 * headScale);
  mouth.scale.set(0.72 * muzzleWidth, 0.04, 0.22);
  mouth.renderOrder = 505;
  (muzzle ?? head).add(mouth);

  // Roof of the mouth: fixed to Head (upper jaw doesn't move). Only shown while
  // the mouth is open — when closed this sphere used to poke through thin
  // muzzle lofts (poodle profile especially).
  const palateGeo = new THREE.SphereGeometry(0.028 * headScale, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55);
  disposables.push(palateGeo);
  const palate = new THREE.Mesh(palateGeo, mat(MOUTH_INTERIOR));
  palate.name = 'DogPalate';
  palate.rotation.x = Math.PI;
  // Sit mid oral cavity, above the lip line, short of the nose pad.
  palate.position.set(
    0,
    -0.01 * headScale,
    THREE.MathUtils.clamp((jawLocalZ + muzzleLocalZ) * 0.55, jawLocalZ + 0.01 * headScale, noseHeadZ - 0.02 * headScale),
  );
  palate.scale.set(0.85 * muzzleWidth, 0.5, 0.4 + 0.35 * mouthDepthScale);
  palate.renderOrder = 494;
  palate.visible = false;
  head.add(palate);

  // Upper teeth: parented to Muzzle so long snouts carry them forward under
  // the loft (head-local Z stayed mid-snout on retrievers). Tips hang into
  // the oral cavity; only visible when the mouth is open.
  const upperTeethGroup = new THREE.Group();
  upperTeethGroup.name = 'DogUpperTeeth';
  upperTeethGroup.visible = false;
  {
    const upperMat = mat(TOOTH);
    upperMat.polygonOffset = true;
    upperMat.polygonOffsetFactor = -2;
    upperMat.polygonOffsetUnits = -2;
    const upperCount = 6;
    const upperSpan = 0.02 * headScale * muzzleWidth;
    const upperH = 0.0055 * headScale;
    // Muzzle-local: underside of the snout, just behind the nose pad.
    const upperY = -0.02 * headScale;
    const upperZ = Math.max(0.012 * headScale, noseLocalZ - lipInset);
    for (let i = 0; i < upperCount; i += 1) {
      const t = (i / (upperCount - 1)) - 0.5;
      const geo = new THREE.ConeGeometry(0.002 * headScale, upperH, 6);
      disposables.push(geo);
      const tooth = new THREE.Mesh(geo, upperMat);
      // Apex points down into the open mouth.
      tooth.rotation.x = Math.PI;
      tooth.position.set(
        t * upperSpan,
        upperY,
        upperZ - Math.abs(t) * 0.0025 * headScale,
      );
      tooth.renderOrder = 497;
      upperTeethGroup.add(tooth);
    }
    // Thin upper gum strip just above the crowns.
    const upperGumGeo = new THREE.CapsuleGeometry(0.0024 * headScale, 0.02 * headScale * muzzleWidth, 4, 8);
    disposables.push(upperGumGeo);
    const upperGum = new THREE.Mesh(upperGumGeo, mat(GUM));
    upperGum.rotation.z = Math.PI * 0.5;
    upperGum.position.set(0, upperY + 0.0035 * headScale, upperZ - 0.002 * headScale);
    upperGum.renderOrder = 496;
    upperTeethGroup.add(upperGum);
  }
  (muzzle ?? head).add(upperTeethGroup);

  // ---- Articulated lower jaw interior: inner mouth, bottom teeth, tongue ----
  // All parented to the Jaw bone so they open/close and pant with it — the
  // same trick used for eyes/nose riding the Head/Muzzle bones above. The
  // jaw's own fur geometry (dogBodyGeometry.js) now forms a real lower-jaw
  // floor, so these only need to dress that floor (gum/teeth/tongue) and hide
  // the small back-of-throat gap — not mask a whole hollow void.
  const jawGroup = new THREE.Group();
  jawGroup.name = 'DogJawInterior';
  const mouthInteriorParts = [];

  // Seeded per-dog "personality" for panting: which side the tongue tends to
  // loll toward, and how much it curls — deterministic per dog, not per frame.
  const seed = phenotype?.seed ?? 1;
  const hash01 = (n) => {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const pantSideBias = (hash01(seed * 1.7 + 3) - 0.5) * 2;
  const pantCurlBias = 0.35 + hash01(seed * 2.3 + 11) * 0.5;

  let tongueRoot = null;
  let tipPivot = null;
  // Rest / pant offsets for tongue root in jaw-local space (scaled for brachy).
  const tongueRestZ = 0.01 * headScale * mouthDepthScale;
  const tonguePantExtraZ = 0.004 * headScale * mouthDepthScale;
  // Y is finalized after tooth crown height is known (below); defaults keep
  // the tongue above a typical golden tooth row until then.
  let tongueRestY = 0.016 * headScale;
  const tonguePantExtraY = 0.004 * headScale;
  if (jaw) {
    jaw.add(jawGroup);

    // Back of mouth: the jaw's own fur geometry now forms the visible floor,
    // but there's still a gap above/behind it (between the jaw hinge and the
    // fixed muzzle underside) that looks straight through to the hollow
    // inside of the skull's double-sided fur shell. This dark mass sits in
    // that gap — sized to the opening, not to the whole cavity — so the
    // jaw floor stays the star of the shot instead of being masked by it.
    const interiorGeo = new THREE.SphereGeometry(0.036 * headScale, 16, 12);
    disposables.push(interiorGeo);
    const interior = new THREE.Mesh(interiorGeo, mat(MOUTH_INTERIOR));
    interior.position.set(0, 0.017 * headScale, 0.006 * headScale * mouthDepthScale);
    interior.scale.set(1.05, 0.85, 0.55 + 0.3 * mouthDepthScale);
    interior.renderOrder = 493;
    jawGroup.add(interior);
    mouthInteriorParts.push(interior);

    // Gum line along the jaw floor, just behind the teeth (not past the nose).
    const gumGeo = new THREE.CapsuleGeometry(0.0032 * headScale, 0.026 * headScale * Math.min(1, 0.7 + mouthDepthScale * 0.3), 4, 8);
    disposables.push(gumGeo);
    const gum = new THREE.Mesh(gumGeo, mat(GUM));
    gum.rotation.z = Math.PI * 0.5;
    gum.position.set(0, 0.005 * headScale, gumLocalZ);
    gum.renderOrder = 497;
    jawGroup.add(gum);
    mouthInteriorParts.push(gum);

    // Bottom teeth: a small row along the front of the lower jaw.
    // Opaque + real depth test (no depthTest:false stacking — that caused
    // the tongue/teeth to weird-blend). Polygon offset pulls crowns just
    // clear of the jaw fur loft's depth write.
    const toothMat = mat(TOOTH);
    toothMat.polygonOffset = true;
    toothMat.polygonOffsetFactor = -2;
    toothMat.polygonOffsetUnits = -2;
    const toothCount = 6;
    const toothSpanX = 0.022 * headScale;
    const brachyTeeth = mouthDepthScale < 0.9;
    // Compact lower-row fangs — big cones read cartoonish in the open mouth.
    const toothH = 0.0065 * headScale * (brachyTeeth ? 1.08 : 1);
    // Sit on the jaw floor; crowns peak around toothY + toothH/2.
    const toothY = 0.0065 * headScale * (brachyTeeth ? 1.12 : 1);
    const toothCrownY = toothY + toothH * 0.45;
    for (let i = 0; i < toothCount; i += 1) {
      const t = (i / (toothCount - 1)) - 0.5;
      const toothGeo = new THREE.ConeGeometry(0.0024 * headScale, toothH, 6);
      disposables.push(toothGeo);
      const tooth = new THREE.Mesh(toothGeo, toothMat);
      tooth.rotation.x = Math.PI;
      tooth.position.set(
        t * toothSpanX,
        toothY,
        toothLocalZ - Math.abs(t) * 0.003 * headScale,
      );
      tooth.renderOrder = 498;
      jawGroup.add(tooth);
      mouthInteriorParts.push(tooth);
    }

    // ---- Procedural tongue: two hinged lathe-built segments ----
    // Layered *above* the tooth crowns in jaw-local Y so normal depth sorting
    // puts tongue over teeth without disabling depth test.
    tongueRoot = new THREE.Group();
    tongueRoot.name = 'TongueRoot';
    tongueRestY = toothCrownY + 0.005 * headScale;
    tongueRoot.position.set(0, tongueRestY, tongueRestZ);
    jawGroup.add(tongueRoot);

    const tongueMat = mat(TONGUE);
    // Shorter tongue segments on brachy so pant loll doesn't spear past the face.
    const baseLen = 0.02 * headScale * (0.7 + 0.3 * mouthDepthScale);
    const tipLen = 0.024 * headScale * (0.65 + 0.35 * mouthDepthScale);
    // Wider, thinner blade — lathe is circular; flat scale makes the dog tongue.
    const baseGeo = buildTongueSegmentGeometry(0.011 * headScale, baseLen, { taperEnd: false });
    disposables.push(baseGeo);
    const baseMesh = new THREE.Mesh(baseGeo, tongueMat);
    baseMesh.rotation.x = Math.PI * 0.5;
    baseMesh.scale.copy(TONGUE_FLAT_SCALE);
    baseMesh.renderOrder = 499;
    tongueRoot.add(baseMesh);

    tipPivot = new THREE.Group();
    tipPivot.name = 'TongueTipPivot';
    tipPivot.position.set(0, 0, baseLen);
    tongueRoot.add(tipPivot);

    const tipGeo = buildTongueSegmentGeometry(0.0095 * headScale, tipLen, { taperEnd: true });
    disposables.push(tipGeo);
    const tipMesh = new THREE.Mesh(tipGeo, tongueMat);
    tipMesh.rotation.x = Math.PI * 0.5;
    tipMesh.scale.copy(TONGUE_FLAT_SCALE);
    tipMesh.renderOrder = 499;
    tipPivot.add(tipMesh);

    // Thin center groove on the flat top face (not a fat capsule tube).
    const creaseGeo = new THREE.BoxGeometry(
      0.0032 * headScale,
      0.0011 * headScale,
      baseLen * 0.72,
    );
    disposables.push(creaseGeo);
    const crease = new THREE.Mesh(creaseGeo, mat(TONGUE_DARK));
    crease.position.set(0, 0.0022 * headScale, baseLen * 0.42);
    crease.renderOrder = 500;
    tongueRoot.add(crease);

    jawGroup.visible = false;
  }

  // Sparse thin whiskers — front Z tracks the mouth, not a fixed golden snout.
  const whiskerMat = mat(WHISKER, { opacity: 0.18 });
  for (const side of [1, -1]) {
    for (let k = 0; k < 3; k += 1) {
      const wGeo = new THREE.CylinderGeometry(0.0003 * headScale, 0.00018 * headScale, 0.024 * headScale, 4);
      disposables.push(wGeo);
      const w = new THREE.Mesh(wGeo, whiskerMat);
      w.rotation.z = side * (Math.PI * 0.5 + (k - 1) * 0.08);
      w.rotation.x = 0.04 + k * 0.03;
      w.position.set(side * 0.016 * headScale, (-0.014 - k * 0.003) * headScale, mouthFrontHeadZ + 0.006 * headScale);
      w.renderOrder = 507;
      head.add(w);
    }
  }

  let blinkAmount = 0;

  return {
    group,
    eyes,
    setBlink(amount) {
      blinkAmount = THREE.MathUtils.clamp(amount, 0, 1);
      for (const eye of eyes) {
        const upper = eye.lids[0];
        if (!upper) continue;
        upper.scale.y = THREE.MathUtils.lerp(0.3, 1.6, blinkAmount);
        upper.position.y = THREE.MathUtils.lerp(eyeR * 0.68, -eyeR * 0.1, blinkAmount);
      }
    },
    setGaze(yaw, pitch) {
      const y = THREE.MathUtils.clamp(yaw, -0.3, 0.3);
      const p = THREE.MathUtils.clamp(pitch, -0.2, 0.2);
      for (const eye of eyes) {
        eye.iris.position.x = y * 0.0025;
        eye.iris.position.y = -p * 0.002;
      }
    },
    /**
     * @param {number} openAmount 0 (closed) .. 1 (full pant)
     * @param {number} [pantWobble] 0..1 fast oscillation while panting — lolls
     *   the tongue a little further with each "pant" beat.
     * @param {number} [driftYaw] -1..1 slow wander driving which side the
     *   tongue currently leans toward (combined with this dog's own bias).
     * @param {number} [driftCurl] 0..1 slow wander driving how tightly the
     *   tip currently curls (combined with this dog's own bias).
     * @param {boolean} [showTongue] false for alert half-open (teeth only).
     */
    setMouthOpen(openAmount, pantWobble = 0, driftYaw = 0, driftCurl = 0, showTongue = true) {
      const t = THREE.MathUtils.clamp(openAmount, 0, 1);
      if (!jaw) return;
      const open = t > 0.02;
      jawGroup.visible = open;
      palate.visible = open;
      upperTeethGroup.visible = open;
      // Soften the closed-mouth lip mark when the jaws open (interior takes over).
      mouth.visible = t < 0.55;
      mouth.scale.set(
        0.72 * muzzleWidth * (1 - t * 0.35),
        0.04 * (1 - t * 0.5),
        0.22 * (1 - t * 0.35),
      );
      const loll = showTongue ? t * (0.55 + pantWobble * 0.45) : 0;
      if (tongueRoot && tipPivot) {
        tongueRoot.visible = Boolean(showTongue) && open;
        // Ride above the tooth crowns (Y), out through the lip gap (Z). Real
        // depth sorting handles tongue-over-teeth — no depthTest:false tricks.
        tongueRoot.rotation.x = loll * -0.17;
        tongueRoot.position.y = tongueRestY + loll * tonguePantExtraY;
        tongueRoot.position.z = tongueRestZ + loll * tonguePantExtraZ;
        tongueRoot.scale.z = 1 + loll * (0.55 + 0.35 * mouthDepthScale);
        // Side lean: this dog's own signature bias plus a slow shared drift,
        // scaled by openAmount so it's neutral while the mouth is closed.
        // Strong enough to carry the tip over the lower lip line so the
        // lolling tongue hangs out and off to one side of the mouth.
        const yaw = (pantSideBias * 0.7 + driftYaw * 0.3) * (showTongue ? t : 0);
        tongueRoot.rotation.y = yaw;
        // Tip droop: per-dog bias plus slow drift plus the fast pant flutter —
        // flops the tip down over the lip, bobbing with each pant beat.
        const curl = pantCurlBias * 0.6 + driftCurl * 0.4;
        tipPivot.rotation.x = showTongue ? curl * 0.5 + pantWobble * 0.3 : 0;
        tipPivot.rotation.z = showTongue ? yaw * 0.4 : 0;
      }
      for (const part of mouthInteriorParts) {
        part.scale.setScalar(THREE.MathUtils.lerp(0.85, 1, t));
      }
    },
    getBlink() {
      return blinkAmount;
    },
    dispose() {
      for (const d of disposables) d.dispose?.();
    },
  };
}
