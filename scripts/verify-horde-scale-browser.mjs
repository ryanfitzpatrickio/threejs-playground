// Browser contract for the frame-budgeted Horde spawn queue.
// Requires a running dev server (`npm run dev`).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const targetCount = Math.max(
  25,
  Math.min(250, Math.floor(Number(process.argv[2] ?? process.env.HORDE_SCALE_COUNT) || 32)),
);
const launchOptions = {
  headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
};
let browser;
try {
  browser = await chromium.launch({
    ...launchOptions,
    executablePath: existsSync(chromePath) ? chromePath : undefined,
  });
} catch (chromeError) {
  console.warn(`Chrome launch failed; retrying bundled Chromium: ${chromeError.message.split('\n')[0]}`);
  browser = await chromium.launch(launchOptions);
}
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.addInitScript(() => {
  localStorage.setItem('dreamfall:controls-dismissed', 'true');
  localStorage.setItem('dreamfall:level', 'horde');
});
await page.goto(dreamfallAppUrl({ level: 'horde', hordeCount: 0 }), {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForFunction(
  () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
  { timeout: 120_000 },
);

const request = await page.evaluate((target) => {
  const debug = globalThis.__DREAMFALL_DEBUG__;
  debug.clearHordeEnemies();
  return debug.spawnHordeEnemies({ count: target, archetype: 'mixed' });
}, targetCount);
assert.equal(request.requested, targetCount);
assert.equal(request.accepted, targetCount);
assert.equal(request.spawned, 12, 'large request must use the bounded initial burst');
assert.equal(request.queued, targetCount - 12);

await page.waitForFunction((target) => {
  const scale = globalThis.__DREAMFALL_DEBUG__?.getHordeDebug?.();
  return scale?.enemyCount === target && scale?.queued === 0;
}, targetCount, { timeout: 120_000 });
await page.waitForFunction((target) => {
  const scale = globalThis.__DREAMFALL_DEBUG__?.getHordeDebug?.();
  return scale?.fullActors === scale?.fullActorLimit
    && scale?.proxies === target - scale.fullActorLimit;
}, targetCount, { timeout: 120_000 });
await page.waitForFunction((target) => {
  const snapshot = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
  const rendered = Object.values(snapshot?.hordeProxies?.meshes ?? {})
    .reduce((sum, count) => sum + count, 0);
  return rendered === target - snapshot?.hordeScale?.fullActorLimit;
}, targetCount, { timeout: 120_000 });

const result = await page.evaluate(() => {
  const snapshot = globalThis.__DREAMFALL_DEBUG__.snapshot();
  const proxyRenderers = [];
  const shadowCasters = [];
  const largestMeshes = [];
  const THREE = globalThis.__DREAMFALL_DEBUG__.getThree();
  const camera = globalThis.__DREAMFALL_DEBUG__.getCamera();
  globalThis.__DREAMFALL_DEBUG__.getScene?.()?.traverse?.((object) => {
    if ((object?.isMesh || object?.isInstancedMesh) && object.castShadow === true) {
      shadowCasters.push({
        name: object.name,
        vertices: object.geometry?.attributes?.position?.count ?? 0,
        instances: object.isInstancedMesh ? object.count : 1,
      });
    }
    if (object?.isMesh || object?.isInstancedMesh) {
      const geometry = object.geometry;
      const vertices = geometry?.index?.count ?? geometry?.attributes?.position?.count ?? 0;
      largestMeshes.push({
        name: object.name,
        vertices,
        instances: object.isInstancedMesh ? object.count : 1,
        visible: object.visible,
        castShadow: object.castShadow === true,
      });
    }
    if (!object?.isInstancedMesh || !String(object.name).startsWith('Horde ')) return;
    const box = object.geometry?.boundingBox;
    const sphere = object.boundingSphere;
    const first = new THREE.Matrix4();
    if (object.count > 0) object.getMatrixAt(0, first);
    const elements = first.elements;
    let projectedOnScreen = 0;
    const projectedSamples = [];
    const instanceMatrix = new THREE.Matrix4();
    const projected = new THREE.Vector3();
    for (let index = 0; index < object.count; index += 1) {
      object.getMatrixAt(index, instanceMatrix);
      projected.setFromMatrixPosition(instanceMatrix).applyMatrix4(object.matrixWorld).project(camera);
      if (
        Math.abs(projected.x) <= 1
        && Math.abs(projected.y) <= 1
        && projected.z >= -1
        && projected.z <= 1
      ) {
        projectedOnScreen += 1;
        if (projectedSamples.length < 3) {
          projectedSamples.push([projected.x, projected.y, projected.z]);
        }
      }
    }
    proxyRenderers.push({
      name: object.name,
      count: object.count,
      visible: object.visible,
      frustumCulled: object.frustumCulled,
      geometryVertices: object.geometry?.attributes?.position?.count ?? 0,
      geometryMin: box ? [box.min.x, box.min.y, box.min.z] : null,
      geometryMax: box ? [box.max.x, box.max.y, box.max.z] : null,
      instanceSphereRadius: sphere?.radius ?? null,
      firstPosition: [elements[12], elements[13], elements[14]],
      projectedOnScreen,
      projectedSamples,
    });
  });
  return {
    scale: snapshot.hordeScale,
    totalCount: snapshot.hordeScale.alive,
    fullCount: snapshot.enemies.count,
    proxyCount: snapshot.hordeProxies.count,
    promoted: snapshot.hordeProxies.promoted,
    proxyMeshes: snapshot.hordeProxies.meshes,
    enemyIds: snapshot.enemies.enemies.map((enemy) => enemy.id),
    spatial: snapshot.enemies.spatial,
    enemyBodies: snapshot.physics.enemyBodies,
    proxyRenderers,
    shadowCasters,
    drawStats: snapshot.renderer?.drawStats,
    largestMeshes: largestMeshes
      .sort((a, b) => b.vertices * b.instances - a.vertices * a.instances)
      .slice(0, 12),
  };
});

assert.equal(result.totalCount, targetCount);
assert.equal(result.scale.queued, 0);
assert.equal(result.scale.peakAlive, targetCount);
assert.ok(result.fullCount <= result.scale.fullActorLimit, result);
assert.ok(result.proxyCount > 0, 'overflow should use instanced proxies');
if (targetCount <= 32) {
  assert.ok(result.promoted > 0, 'near proxies should promote as full slots fill');
}
assert.equal(result.fullCount + result.proxyCount, targetCount);
assert.equal(result.enemyBodies, result.fullCount);
assert.equal(new Set(result.enemyIds).size, result.fullCount, 'full Horde actor ids must be unique');
assert.ok(
  Number.isFinite(result.scale.demotionRadius)
    && result.scale.demotionRadius > result.scale.promotionRadius,
  'demotion radius must hysteresis past promotion',
);
assert.ok(Number.isFinite(result.scale.promoted), 'scale snapshot exposes promoted count');
assert.ok(Number.isFinite(result.scale.demoted), 'scale snapshot exposes demoted count');
assert.ok(
  (result.scale.poseCatalogSize ?? 0) >= 1,
  'display pose must be loaded',
);
assert.ok(
  result.scale.geometrySource === 'lowpoly'
    || result.scale.geometrySource === 'baked'
    || result.scale.geometrySource === 'vat'
    || result.scale.geometrySource === 'mixed',
  result.scale,
);
// Horde proxies must use baked/VAT robot meshes (not lowpoly block men).
assert.ok(
  result.scale.geometrySource === 'baked' || result.scale.geometrySource === 'vat',
  `Horde proxy slots should use baked/VAT robot meshes, got ${result.scale.geometrySource}`,
);
assert.equal(
  Object.values(result.proxyMeshes).reduce((sum, count) => sum + count, 0),
  result.proxyCount,
);
for (const renderer of result.proxyRenderers) {
  assert.ok(renderer.geometryVertices <= 18_000, renderer);
  // M5: sector meshes use per-sector capacity (not the global agent cap).
  assert.ok(
    renderer.count > 0 && renderer.count <= (result.scale.cap ?? 2000),
    `sector instance capacity out of range: ${renderer.count}`,
  );
}
assert.ok(result.spatial.bruteForcePairsAvoided > 0, result.spatial);

if (targetCount >= 250) {
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/dreamfall-horde-proxies.png' });
}

const cleared = await page.evaluate(() => {
  globalThis.__DREAMFALL_DEBUG__.clearHordeEnemies();
  const snapshot = globalThis.__DREAMFALL_DEBUG__.snapshot();
  return {
    enemies: snapshot.enemies.count,
    proxies: snapshot.hordeProxies.count,
    enemyBodies: snapshot.physics.enemyBodies,
    queued: snapshot.hordeScale.queued,
  };
});
assert.deepEqual(cleared, { enemies: 0, proxies: 0, enemyBodies: 0, queued: 0 });

console.log('PASS: Horde browser scale queue');
console.log({ request, result });
console.log('proxyRenderers', JSON.stringify(result.proxyRenderers, null, 2));
console.log('shadowCasters', JSON.stringify(result.shadowCasters, null, 2));
console.log('drawStats', JSON.stringify(result.drawStats, null, 2));
console.log('largestMeshes', JSON.stringify(result.largestMeshes, null, 2));
if (targetCount >= 250) {
  console.log('screenshot: /tmp/dreamfall-horde-proxies.png');
}
await browser.close();
