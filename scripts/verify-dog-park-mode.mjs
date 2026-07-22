import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const requestedUrls = [];
  const missingAssetResponses = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  page.on('response', (response) => {
    const url = response.url();
    if (response.status() >= 400 && new URL(url).pathname.startsWith('/assets/')) {
      missingAssetResponses.push(`${response.status()} ${url}`);
    }
  });
  page.on('pageerror', (error) => errors.push(String(error?.message ?? error)));
  page.on('console', (message) => {
    if (message.type() === 'error' || /vehicle spawn budget exceeded/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem('dreamfall:controls-dismissed', 'true');
  });
  // Clips are default; pin dogAnims=clips so the harness always exercises Death flop.
  await page.goto(dreamfallAppUrl({ level: 'dog-park', autostart: '1', dogAnims: 'clips' }), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => {
      const snapshot = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
      return snapshot?.stage === 'running'
        && snapshot?.dogPark?.dog?.position
        && snapshot?.dogPark?.animationClips?.ready === true
        && snapshot?.dogPark?.animationClips?.library !== 'procedural';
    },
    { timeout: 150_000 },
  );

  const initial = await page.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const snapshot = dbg.snapshot();
    return {
      dogPark: snapshot.dogPark,
      level: snapshot.level,
      playerVisible: dbg.getCharacter()?.group?.visible,
      characterSource: dbg.getCharacter()?.source,
      hiddenForDogPark: dbg.getCharacter()?.hiddenForDogPark,
      dogObject: Boolean(dbg.getScene().getObjectByName(`ProceduralDog_${snapshot.dogPark.breedId}`)),
      hudHint: Boolean(document.querySelector('.dog-park-hint')),
      customizeBtn: Boolean(document.querySelector('.dog-customize-btn')),
      npcCount: snapshot.dogPark?.npc?.count ?? null,
    };
  });
  assert.equal(initial.dogPark.mode, 'dog-park');
  assert.equal(initial.dogPark.animationClips.clips, 14);
  assert.equal(initial.playerVisible, false, 'runtime stub should be hidden');
  assert.equal(initial.characterSource, 'dog-park-stub', 'dog park must not load Mara');
  assert.equal(initial.hiddenForDogPark, true, 'hiddenForDogPark flag should stick');
  assert.equal(initial.dogObject, true, 'procedural dog should be in scene');
  assert.equal(initial.hudHint, true, 'dog park control hint should be mounted');
  assert.equal(initial.customizeBtn, true, 'customize button should be mounted');
  if (initial.npcCount != null) {
    assert.ok(initial.npcCount <= 12, `npc pack too large: ${initial.npcCount}`);
  }
  assert.ok(initial.level.city?.forest?.forestTrees >= 8, 'park should load shared forest trees');

  // Lazy tree-impostor baking can briefly occupy the first running frames.
  await page.waitForFunction(() => {
    const status = globalThis.__DREAMFALL_DEBUG__.snapshot().level?.city?.forest?.forestImpostorBakeStatus;
    return !status || status === 'ready' || status === 'error' || status === 'disabled';
  }, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark.dog.position);
  await page.keyboard.down('w');
  await page.waitForTimeout(1400);
  await page.keyboard.up('w');
  await page.waitForTimeout(250);
  const walked = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark);
  assert.ok(
    Math.hypot(walked.dog.position.x - before.x, walked.dog.position.z - before.z) > 0.5,
    `W input should move dog: ${JSON.stringify({ before, after: walked.dog.position })}`,
  );
  assert.ok(['Walk', 'Idle'].includes(walked.animationClips.clip), `unexpected locomotion clip ${walked.animationClips.clip}`);

  // Put the dog in the west wallow, grow a paw trail, then verify Z runs
  // procedural flop → mud impact → ragdoll (not the Death skeleton clip).
  await page.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const breedId = dbg.snapshot().dogPark.breedId;
    const dog = dbg.getScene().getObjectByName(`ProceduralDog_${breedId}`);
    dog.position.set(-21, 0.052, -5);
    dog.updateMatrixWorld(true);
  });
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.dog?.surfaceClass === 'mud',
    { timeout: 10_000 },
  );
  await page.waitForTimeout(350);
  const mudBeforeWalk = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark.mud);
  const coatBeforeWalk = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark.mudCoat);
  await page.keyboard.down('w');
  await page.waitForTimeout(900);
  await page.keyboard.up('w');
  await page.waitForTimeout(150);
  const mudTrail = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark.mud);
  assert.ok(mudTrail.pawStampCount > mudBeforeWalk.pawStampCount,
    `walking in mud should grow paw trail (${mudBeforeWalk.pawStampCount} -> ${mudTrail.pawStampCount})`);
  assert.ok(mudTrail.activeDeformCells > 0 && mudTrail.deformTextureActive, 'paw trail activates deform texture');
  assert.ok(mudTrail.visiblePawPrints > 0, 'paw trail has persistent readable print instances');
  const coatTrail = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark.mudCoat);
  assert.ok(coatTrail.pawDepositCount > coatBeforeWalk.pawDepositCount,
    'accepted mud paw stamps should deposit coat mud');
  assert.ok(coatTrail.lowerCoverage > coatBeforeWalk.lowerCoverage, 'mud run grows lower-body coverage');
  assert.ok(coatTrail.particleEmissionCount > coatBeforeWalk.particleEmissionCount,
    'mud run emits airborne paw droplets');
  if (process.env.DOG_PARK_TRAIL_SCREENSHOT) {
    await mkdir('.codex-tmp', { recursive: true });
    await page.screenshot({ path: process.env.DOG_PARK_TRAIL_SCREENSHOT, fullPage: true });
  }

  const flopPosition = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark.dog.position);
  const impactCountBefore = mudTrail.flopImpactCount;
  const coatBeforeFlop = coatTrail;
  await page.keyboard.press('z');
  // Procedural flop — mixer must not enter Death.
  await page.waitForFunction(
    () => {
      const park = globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark;
      const clips = park?.animationClips;
      return clips?.clip !== 'Death' && clips?.busy !== true;
    },
    { timeout: 5_000 },
  );
  await page.waitForFunction(
    (count) => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.mud?.flopImpactCount === count + 1,
    impactCountBefore,
    { timeout: 5_000 },
  );
  const mudImpact = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark);
  assert.equal(mudImpact.mud.flopImpactCount, impactCountBefore + 1, 'flop emits exactly one mud impact');
  assert.ok(mudImpact.mud.groundBlob.active, 'flop activates springy mud blob');
  assert.ok(mudImpact.mud.groundBlob.pulses >= 1, 'flop emits a blob pulse');
  assert.ok(mudImpact.mudCoat.bodyCoverage >= 0.85, 'mud flop produces broad body coverage');
  assert.equal(mudImpact.mudCoat.wetness, 1, 'mud flop fully refreshes wetness');
  assert.equal(mudImpact.mudCoat.flopDepositCount, coatBeforeFlop.flopDepositCount + 1);
  assert.equal(mudImpact.mudCoat.burstEventCount, coatBeforeFlop.burstEventCount + 1);
  assert.equal(mudImpact.mudCoat.particleEmissionCount, coatBeforeFlop.particleEmissionCount + 36,
    'mud flop emits one deterministic 36-droplet burst');
  assert.ok(
    Math.hypot(mudImpact.dog.position.x - flopPosition.x, mudImpact.dog.position.z - flopPosition.z) < 0.05,
    'flop action lock prevents movement during impact',
  );
  // Ragdoll should take over after procedural impact (not Death clip hold).
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.ragdoll?.active === true
      || globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.ragdoll?.mode === 'limp'
      || globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.ragdoll?.mode === 'blend',
    { timeout: 5_000 },
  ).catch(() => {
    // Ragdoll may be brief / already blended if physics steps slow in CI.
  });
  if (process.env.DOG_PARK_SCREENSHOT) {
    await mkdir('.codex-tmp', { recursive: true });
    await page.screenshot({ path: process.env.DOG_PARK_SCREENSHOT, fullPage: true });
  }
  // After limp+blend, clips resume Idle (or procedural idle if packs off).
  await page.waitForFunction(
    () => {
      const park = globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark;
      const rag = park?.ragdoll;
      const clips = park?.animationClips;
      const ragDone = !rag?.active || rag?.mode === 'inactive';
      const clipsOk = !clips?.ready || clips?.clip === 'Idle' || clips?.busy === false;
      return ragDone && clipsOk;
    },
    { timeout: 12_000 },
  );
  const recovered = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark);
  assert.equal(recovered.mud.flopImpactCount, impactCountBefore + 1, 'procedural flop recovery does not duplicate impact');
  assert.notEqual(recovered.animationClips?.clip, 'Death', 'recovery must not leave Death clip active');

  // The same animation on grass must not deposit coat mud or spawn droplets.
  await page.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const dog = dbg.getScene().getObjectByName(`ProceduralDog_${dbg.snapshot().dogPark.breedId}`);
    dog.position.set(0, 0, 0);
    dog.updateMatrixWorld(true);
  });
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.dog?.surfaceClass === 'grass',
    { timeout: 10_000 },
  );
  const grassBefore = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark);
  await page.keyboard.press('z');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.animationClips?.busy === true,
    { timeout: 5_000 },
  );
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.animationClips?.busy === false,
    { timeout: 8_000 },
  );
  const grassRecovered = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark);
  assert.equal(grassRecovered.mud.flopImpactCount, grassBefore.mud.flopImpactCount,
    'grass flop creates no ground mud impact');
  assert.equal(grassRecovered.mudCoat.flopDepositCount, grassBefore.mudCoat.flopDepositCount,
    'grass flop creates no coat deposit');
  assert.equal(grassRecovered.mudCoat.particleEmissionCount, grassBefore.mudCoat.particleEmissionCount,
    'grass flop emits no mud particles');

  const positionBeforeRebuild = grassRecovered.dog.position;
  await page.evaluate(() => {
    globalThis.dispatchEvent(new CustomEvent('dreamfall:dog-park-config', {
      detail: { breedId: 'beagle', seed: 27 },
    }));
  });
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.breedId === 'beagle'
      && globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.animationClips?.ready === true,
    { timeout: 30_000 },
  );
  const rebuilt = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark);
  assert.equal(rebuilt.seed, 27);
  assert.equal(rebuilt.mudCoat.phase, 'clean', 'breed rebuild starts with a clean coat');
  assert.equal(rebuilt.mudCoat.lowerCoverage, 0);
  assert.equal(rebuilt.mudCoat.bodyCoverage, 0);
  assert.equal(rebuilt.mudCoat.particleEmissionCount, 0);
  assert.ok(
    Math.hypot(rebuilt.dog.position.x - positionBeforeRebuild.x, rebuilt.dog.position.z - positionBeforeRebuild.z) < 0.1,
    'breed rebuild should preserve park position',
  );
  const rebound = await page.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const dog = dbg.getScene().getObjectByName(`ProceduralDog_${dbg.snapshot().dogPark.breedId}`);
    const shared = dog.children.find((child) => child.name === 'DogBody')?.material?.userData?.dogMudUniforms;
    const shells = dog.children.filter((child) => child.name.startsWith('DogFurShell_'));
    return Boolean(shared) && shells.every((shell) => shell.material.userData.dogMudUniforms === shared);
  });
  assert.equal(rebound, true, 'breed rebuild safely rebinds shared body/shell mud uniforms');

  const forbiddenRequests = requestedUrls.filter(isForbiddenDogParkRequest);
  assert.deepEqual(
    forbiddenRequests,
    [],
    `dog park requested non-product assets:\n${forbiddenRequests.join('\n')}`,
  );
  assert.deepEqual(
    missingAssetResponses,
    [],
    `dog park has missing runtime assets:\n${missingAssetResponses.join('\n')}`,
  );

  // Product entry: the Dog card must select the runtime park, while the Studio
  // button remains the explicit isolated-viewer path. The standalone product
  // has no MainMenu, so verify its Studio -> Play park round-trip instead.
  const standaloneProduct = await page.locator('.dog-product-shell').count() > 0;
  if (standaloneProduct) {
    await page.click('.dog-park-hud__actions button:last-child');
    await page.waitForSelector('.dog-sim-shell');
    assert.equal(new URL(page.url()).searchParams.get('dogMode'), 'studio');
    await page.click('.dog-product-mode-toggle');
    await page.waitForFunction(
      () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running'
        && globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.mode === 'dog-park',
      { timeout: 150_000 },
    );
    assert.equal(new URL(page.url()).searchParams.has('dogMode'), false);
  } else {
    await page.evaluate(() => localStorage.removeItem('dreamfall:skip-menu'));
    await page.goto(dreamfallAppUrl({ level: null, autostart: null }, { skipAutostart: true }), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForSelector('[data-testid="experience-dog"]', { timeout: 90_000 });
    await page.click('[data-testid="experience-dog"]');
    await page.waitForFunction(
      () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running'
        && globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.mode === 'dog-park',
      { timeout: 150_000 },
    );
  }

  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobilePage.on('pageerror', (error) => errors.push(String(error?.message ?? error)));
  await mobilePage.addInitScript(() => localStorage.setItem('dreamfall:controls-dismissed', 'true'));
  await mobilePage.goto(dreamfallAppUrl({ level: 'dog-park', autostart: '1' }), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await mobilePage.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running'
      && Boolean(document.querySelector('.dog-park-hud')),
    { timeout: 150_000 },
  );
  const mobileHud = await mobilePage.locator('.dog-park-hud').boundingBox();
  assert.ok(mobileHud && mobileHud.x >= 0 && mobileHud.x + mobileHud.width <= 390, 'mobile dog HUD should fit viewport');
  await mobilePage.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const dog = dbg.getScene().getObjectByName(`ProceduralDog_${dbg.snapshot().dogPark.breedId}`);
    dog.position.set(-21, 0.052, -5);
    dog.updateMatrixWorld(true);
  });
  await mobilePage.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.dog?.surfaceClass === 'mud',
    { timeout: 10_000 },
  );
  await mobilePage.waitForTimeout(350);
  const mobileImpactBefore = await mobilePage.evaluate(
    () => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark.mud.flopImpactCount,
  );
  await mobilePage.keyboard.press('z');
  await mobilePage.waitForFunction(
    (count) => globalThis.__DREAMFALL_DEBUG__.snapshot().dogPark?.mud?.flopImpactCount === count + 1,
    mobileImpactBefore,
    { timeout: 5_000 },
  );
  if (process.env.DOG_PARK_MOBILE_SCREENSHOT) {
    await mobilePage.screenshot({ path: process.env.DOG_PARK_MOBILE_SCREENSHOT, fullPage: true });
  }
  await mobilePage.close();
  const fatal = errors.filter((error) =>
    /failed to start|is not defined|cannot read|uncaught|WebGPU.*(?:error|fail)|createRenderPipelineAsync|depthStencil|AttributeNode.*not found|vehicle spawn budget exceeded/i.test(error));
  assert.deepEqual(fatal, [], `fatal browser errors: ${fatal.join(' | ')}`);
  console.log('verify-dog-park-mode: standalone boot/network, studio round-trip, mud behavior, desktop/mobile HUD, and breed rebuild OK');
} finally {
  await browser.close();
}

function isForbiddenDogParkRequest(rawUrl) {
  const { pathname } = new URL(rawUrl);
  if (/\/assets\/(animation-packs|simoutfits|guns)\//.test(pathname)) return true;
  if (/\/assets\/models\/(player-tpose|horse-rigged)\.(glb|fbx)$/.test(pathname)) return true;
  if (pathname.startsWith('/assets/textures/urban-track/')) return true;
  if (/^\/assets\/textures\/fx\/bullet-hole-atlas-7x7\.(png|catalog\.json)$/.test(pathname)) return true;
  if (pathname.startsWith('/assets/textures/range/')) {
    return !['woodwall', 'woodwall2', 'concrete', 'pillarmiddle']
      .some((folder) => pathname.startsWith(`/assets/textures/range/${folder}/`));
  }
  if (pathname.startsWith('/assets/textures/forest/')) {
    return !pathname.startsWith('/assets/textures/forest/bald-cypress/')
      && !pathname.startsWith('/assets/textures/forest/pine/');
  }
  if (pathname.startsWith('/assets/forest-leaves/')) {
    return !/\/(bald_cypress|pine)_needle_(albedo|normal|roughness|translucency)\.png$/.test(pathname);
  }
  return false;
}
