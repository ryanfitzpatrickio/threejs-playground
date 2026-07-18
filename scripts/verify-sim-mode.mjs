import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const testPresets = [
  {
    id: `verify-sim-male-${suffix}`,
    name: 'Verify Male Sim',
    body: 'male',
    outfitId: 'fantasy-ranger',
    garmentIds: [],
  },
  {
    id: `verify-sim-female-${suffix}`,
    name: 'Verify Female Sim',
    body: 'female',
    outfitId: null,
    garmentIds: ['demo-tshirt'],
  },
];
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

try {
  await Promise.all(testPresets.map(async (preset, index) => {
    const response = await fetch(new URL(`/api/store/sims/${preset.id}`, dreamfallAppUrl()), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 4,
        ...preset,
        morphs: {},
        facs: {},
        skin: {},
        updatedAt: Date.now() + index,
      }),
    });
    assert.ok(response.ok, `failed to seed ${preset.body} Sim preset: ${response.status}`);
  }));

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error?.message ?? error)));
  await page.addInitScript(() => {
    localStorage.setItem('dreamfall:controls-dismissed', 'true');
  });
  await page.goto(dreamfallAppUrl({ level: 'sims', autostart: '1' }), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running'
      && globalThis.__DREAMFALL_DEBUG__.snapshot().sims?.sims?.length === 2,
    { timeout: 150_000 },
  );

  const initial = await page.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const snapshot = dbg.snapshot();
    return {
      sims: snapshot.sims.sims,
      selectedSimId: snapshot.sims.selectedSimId,
      camera: snapshot.sims.camera,
      playerVisible: dbg.getCharacter()?.group?.visible,
      pointerLocked: Boolean(document.pointerLockElement),
    };
  });
  assert.equal(initial.sims.length, 2);
  assert.deepEqual(
    new Set(initial.sims.map((sim) => sim.body)),
    new Set(['male', 'female']),
    `mixed household bodies: ${JSON.stringify(initial.sims)}`,
  );
  const male = initial.sims.find((sim) => sim.body === 'male');
  const female = initial.sims.find((sim) => sim.body === 'female');
  assert.equal(male?.outfit?.id, 'fantasy-ranger', 'male preset should spawn its authored outfit');
  assert.ok(male?.outfit?.meshes > 0, 'authored outfit should contain skinned meshes');
  assert.equal(male?.garments?.length, 0, 'authored outfit should replace Dynamic Cloth wardrobe');
  assert.equal(female?.outfit, null);
  assert.equal(female?.garments?.length, 1, 'female preset should retain Dynamic Cloth coverage');
  assert.ok(female?.garments?.[0]?.particles > 0, 'garment should compile cloth particles');
  assert.equal(initial.playerVisible, false, 'parked Mara should be hidden');
  assert.equal(initial.pointerLocked, false, 'Sims mode must not lock the pointer');
  // FP / camera systems used to force character.group.visible = true after load.
  await page.waitForTimeout(800);
  const stillHidden = await page.evaluate(() => {
    const character = globalThis.__DREAMFALL_DEBUG__?.getCharacter?.();
    const wingsuit = character?.wingsuitRig?.group;
    const jacket = character?.proceduralJacket?.group;
    return {
      playerVisible: Boolean(character?.group?.visible),
      wingsuitVisible: Boolean(wingsuit?.visible),
      jacketVisible: Boolean(jacket?.visible),
      hiddenForSims: Boolean(character?.hiddenForSims),
    };
  });
  assert.equal(stillHidden.playerVisible, false, 'Mara must stay hidden after sim systems tick');
  assert.equal(stillHidden.hiddenForSims, true, 'hiddenForSims flag should stick');
  assert.equal(stillHidden.wingsuitVisible, false, 'wingsuit must not render on the lot');
  assert.equal(stillHidden.jacketVisible, false, 'procedural jacket must not render on the lot');

  const secondId = female.id;
  const secondScreen = await projectActor(page, secondId);
  await page.mouse.click(secondScreen.x, secondScreen.y);
  await page.waitForFunction(
    (id) => globalThis.__DREAMFALL_DEBUG__.snapshot().sims?.selectedSimId === id,
    secondId,
    { timeout: 10_000 },
  );

  const goalWorld = { x: -1.5, y: 0, z: -2.5 };
  const goalScreen = await projectWorld(page, goalWorld);
  await page.mouse.click(goalScreen.x, goalScreen.y);
  await page.waitForFunction(
    (id) => globalThis.__DREAMFALL_DEBUG__.snapshot().sims?.sims
      ?.find((sim) => sim.id === id)?.goal != null,
    secondId,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    ({ id, goal }) => {
      const sim = globalThis.__DREAMFALL_DEBUG__.snapshot().sims?.sims?.find((entry) => entry.id === id);
      return sim && Math.hypot(sim.x - goal.x, sim.z - goal.z) < 0.35;
    },
    { id: secondId, goal: goalWorld },
    { timeout: 15_000 },
  );

  const cameraBefore = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().sims.camera.position);
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(740, 400, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(500);
  const final = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().sims);
  const cameraDelta = Math.hypot(
    final.camera.position.x - cameraBefore.x,
    final.camera.position.y - cameraBefore.y,
    final.camera.position.z - cameraBefore.z,
  );
  assert.ok(cameraDelta > 0.25, `camera should orbit, delta=${cameraDelta}`);
  assert.equal(final.selectedSimId, secondId);
  const finalGarment = final.sims.find((sim) => sim.id === secondId)?.garments?.[0];
  assert.ok(finalGarment?.steps > 0, 'garment fixed-step solver should advance');
  assert.ok(finalGarment?.movedVertices > 0, 'garment vertices should move while the sim walks');
  assert.equal(finalGarment?.hasBvh, true, 'garment collision should use the posed-avatar triangle BVH');
  assert.equal(Boolean(await page.evaluate(() => document.pointerLockElement)), false);

  const fatal = errors.filter((error) => /failed to start|is not defined|Cannot read/i.test(error));
  assert.deepEqual(fatal, [], `fatal page errors: ${fatal.join(' | ')}`);
  console.log('verify-sim-mode: two Sims, authored outfit, Dynamic Cloth, movement, and RTS camera OK');
} finally {
  await Promise.allSettled(testPresets.map((preset) => (
    fetch(new URL(`/api/store/sims/${preset.id}`, dreamfallAppUrl()), { method: 'DELETE' })
  )));
  await browser.close();
}

async function projectActor(page, id) {
  return page.evaluate((actorId) => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const actor = dbg.getScene().getObjectByName(`Sim Actor:${actorId}`);
    const point = actor.position.clone().add({ x: 0, y: 0.9, z: 0 }).project(dbg.getCamera());
    const rect = document.querySelector('canvas').getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }, id);
}

async function projectWorld(page, world) {
  return page.evaluate((value) => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const THREE = dbg.getThree();
    const point = new THREE.Vector3(value.x, value.y, value.z).project(dbg.getCamera());
    const rect = document.querySelector('canvas').getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }, world);
}
