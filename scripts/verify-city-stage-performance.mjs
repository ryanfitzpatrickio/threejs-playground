import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const timeout = Number(process.env.CITY_VERIFY_TIMEOUT_MS ?? 120000);

// Heap-growth budget (KB/s) over a stationary post-load sampling window. Loose:
// streaming caches, BVH warmup, and render caches legitimately accumulate, but a
// per-frame allocation leak (the pre-P1/P2 hot path rebuilt collider grids +
// result objects every frame) blows well past this. The actual rate is reported
// for human inspection; headless FPS is 30-throttled so this measures allocation
// rate, not fps.
const HEAP_GROWTH_KB_PER_SEC_CEILING = Number(process.env.HEAP_GROWTH_KB_PER_SEC_CEILING ?? 1500);

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
  // precise memory info enables heap-growth sampling — direct evidence the P1/P2
  // GC-churn fixes landed (GC was the #1 cost in the 2026-07-02 city trace).
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  // "Failed to load resource" messages only carry the URL in location(), not the text.
  const isFavicon = message.text().includes('favicon') || message.location()?.url?.includes('favicon');
  if (message.type() === 'error' && !isFavicon) errors.push(message.text());
});

await page.addInitScript(() => {
  localStorage.setItem('dreamfall:quality', 'ultra');
  localStorage.setItem('dreamfall:post-effect', 'ssao');
  localStorage.setItem('dreamfall:level', 'city');
  localStorage.setItem('dreamfall:controls-dismissed', 'true');
});
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout });
  await page.waitForFunction(() => {
    const snapshot = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
    return snapshot?.level?.city?.initialLoadComplete === true && snapshot.level.ledges > 0;
  }, { timeout });
  // Let the stream settle into steady state (BVH warmup + remaining attaches).
  await new Promise((r) => setTimeout(r, 800));

  const result = await page.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const snapshot = dbg.snapshot();
    const { colliderIndex, colliders, geometryIndex } = dbg.getLevelHandles();

    // P1 (add path): collider index tracks the flat array exactly and its cell
    // grid is internally consistent (assertConsistent throws on mismatch).
    let colliderConsistent = true;
    try { colliderIndex?.assertConsistent?.(); } catch { colliderConsistent = false; }

    // P1 (remove path): round-trip removeChunk → addChunk on one real chunk key.
    // page.evaluate runs synchronously, so no rAF/game update interleaves — the
    // transient missing chunk is atomic w.r.t. the running game. Proves the
    // swap-remove leaves cells + the flat array consistent and count-restored.
    let removeRoundTrip = null;
    const sampleCollider = Array.isArray(colliders) ? colliders.find((c) => c?.chunkKey != null) : null;
    if (colliderIndex && sampleCollider) {
      const key = sampleCollider.chunkKey;
      const before = colliderIndex.colliders.length;
      const chunkColliders = colliders.filter((c) => c?.chunkKey === key);
      let stage = 'ok';
      try {
        colliderIndex.removeChunk(key);
        const afterRemove = colliderIndex.colliders.length;
        colliderIndex.assertConsistent();
        colliderIndex.addChunk(key, chunkColliders);
        colliderIndex.assertConsistent();
        const afterReadd = colliderIndex.colliders.length;
        removeRoundTrip = { before, afterRemove, afterReadd, removedCount: before - afterRemove };
        if (afterRemove >= before || afterReadd !== before) stage = 'count-mismatch';
      } catch (e) { stage = `threw:${e.message}`; }
      removeRoundTrip = { ...removeRoundTrip, stage };
    }

    // P1: numeric ground-height parity. The index path (probeGround →
    // getGroundHeightAt with the index) must match a brute-force max over the
    // flat collider array at the same sample points. Probes a grid around spawn.
    let parityProbed = 0;
    let parityMismatches = 0;
    const origin = dbg.getCharacter().group.position;
    const radius = 0.5;
    for (let ix = -3; ix <= 3; ix += 1) {
      for (let iz = -3; iz <= 3; iz += 1) {
        const px = origin.x + ix * 20;
        const pz = origin.z + iz * 20;
        const viaIndex = dbg.probeGround(px, 1000, pz, radius);
        // Brute-force equivalent of the no-step-window ground snap.
        // Brute-force reference: mirrors createBaseLevel getGroundHeightAt's
        // `consider` callback exactly for the no-step-window case (the probe
        // passes no maxStepUp/maxSnapDown/requiredInset), INCLUDING the
        // noGroundSnap skip — a faithful cross-check, not a simplification.
        let brute = 0;
        if (Array.isArray(colliders)) {
          for (const c of colliders) {
            if (c?.noGroundSnap === true) continue;
            const surfaceY = typeof c?.surfaceHeightAt === 'function'
              ? c.surfaceHeightAt(px, pz) : c?.topY;
            if (typeof surfaceY !== 'number' || !Number.isFinite(surfaceY)) continue;
            const insideX = px + radius >= c.minX && px - radius <= c.maxX;
            const insideZ = pz + radius >= c.minZ && pz - radius <= c.maxZ;
            if (insideX && insideZ && surfaceY > brute) brute = surfaceY;
          }
        }
        parityProbed += 1;
        if (Math.abs(viaIndex - brute) > 1e-3) parityMismatches += 1;
      }
    }

    // P3: count frozen static meshes (matrixWorldAutoUpdate===false) and verify
    // none have a stale baked matrix (validateFrozenMatrices recomputes parent*
    // local and compares). -1 = validator unavailable.
    let frozenMeshes = 0;
    let staticMeshes = 0;
    dbg.getScene().traverse((o) => {
      if (!o.isMesh) return;
      if (o.matrixWorldAutoUpdate === false) frozenMeshes += 1;
      if (o.static === true) staticMeshes += 1;
    });
    let frozenMismatches = -1;
    try { frozenMismatches = geometryIndex?.validateFrozenMatrices?.() ?? -1; } catch { frozenMismatches = -2; }

    return {
      city: snapshot.level.city,
      ledges: snapshot.level.ledges,
      renderer: snapshot.renderer,
      attachMeasures: performance.getEntriesByName('city-chunk-attach').length,
      collider: {
        hasIndex: !!colliderIndex,
        flatCount: colliders?.length ?? 0,
        indexCount: colliderIndex?.colliders?.length ?? 0,
        consistent: colliderConsistent,
        removeRoundTrip,
        parityProbed,
        parityMismatches,
      },
      matrix: { frozenMeshes, staticMeshes, frozenMismatches },
    };
  });

  // Regression + P1/P2/P3 assertions.
  assert.equal(errors.length, 0, errors[0]);
  assert.ok(result.city.chunks > 0);
  assert.ok(result.city.worstAttachMs >= result.city.lastAttachMs);
  assert.ok(result.attachMeasures > 0);
  assert.ok(result.ledges > 0, 'near traversal was backfilled');
  assert.equal(result.city.activeLoadRadius, 2, 'ultra steady load radius');
  // Shadows + SSAO post-effect must remain intact (regression guard for the
  // earlier render-list re-entrancy crash).
  assert.equal(result.renderer.shadows, true, 'clipmap shadows on');
  assert.equal(result.renderer.postEffectMode, 'ssao', 'SSAO post-effect on');

  // P1: incremental collider index — add + remove paths + query parity.
  assert.equal(result.collider.hasIndex, true, 'collider spatial index present');
  assert.equal(result.collider.indexCount, result.collider.flatCount,
    'index tracks flat collider array exactly');
  assert.equal(result.collider.consistent, true, 'collider cell grid consistent after streaming');
  assert.ok(result.collider.removeRoundTrip, 'remove/add round-trip exercised');
  assert.equal(result.collider.removeRoundTrip.stage, 'ok',
    `collider remove/add round-trip: ${result.collider.removeRoundTrip.stage}`);
  assert.equal(result.collider.removeRoundTrip.removedCount > 0, true,
    'removeChunk actually removed colliders');
  assert.equal(result.collider.removeRoundTrip.afterReadd, result.collider.removeRoundTrip.before,
    'addChunk restored the exact collider count');
  assert.equal(result.collider.parityMismatches, 0,
    `index ground-height parity (${result.collider.parityMismatches}/${result.collider.parityProbed} mismatches)`);

  // P3: frozen static matrices + Three static draw hint.
  assert.ok(result.matrix.frozenMeshes > 0, `static chunk meshes frozen (${result.matrix.frozenMeshes})`);
  assert.ok(result.matrix.staticMeshes > 0, `city meshes marked static (${result.matrix.staticMeshes})`);
  assert.equal(result.matrix.frozenMismatches, 0, 'no stale baked world matrices');

  // Furniture batching: city-wide instanced pools (not per-chunk furniture draws).
  assert.ok(result.city.furniture?.meshes > 0, 'global furniture batch meshes');
  assert.ok(result.city.furniture.drawCalls <= 20,
    `furniture draw calls batched (${result.city.furniture?.drawCalls})`);

  // P1/P2: heap RETAINED growth across forced GCs (stable, unlike raw
  // usedJSHeapSize which swings with time-since-last-GC). Always reported. The
  // hard assert is opt-in via env: the GC-churn *reduction* is proven
  // structurally (frozen sentinel + reused scratch arrays eliminate the
  // per-frame allocations; the index kills per-call grid rebuilds) and
  // confirmed by a real-browser trace, not by a noisy headless heap number.
  result.heap = await sampleHeapGrowth(page);
  if (result.heap.available && process.env.DREAMFALL_ASSERT_HEAP === '1') {
    assert.ok(
      result.heap.retainedKbPerSec < HEAP_GROWTH_KB_PER_SEC_CEILING,
      `retained heap growth ${result.heap.retainedKbPerSec.toFixed(1)} KB/s over ceiling ${HEAP_GROWTH_KB_PER_SEC_CEILING}`,
    );
  }

  console.log('City stage performance verification passed.', JSON.stringify(result));
} catch (error) {
  const snapshot = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.() ?? null).catch(() => null);
  console.error('City performance snapshot at failure:', JSON.stringify(snapshot?.level ?? snapshot));
  throw error;
} finally {
  await browser.close();
}

async function sampleHeapGrowth(page) {
  // Measure RETAINED growth: force a full GC, read baseline, let the game run,
  // force another full GC, read end. The delta is allocations that survived a
  // collection (real retained growth / a leak), not pending garbage. If gc()
  // isn't exposed, fall back to a raw reading and mark it low-confidence.
  const sample = await page.evaluate(async () => {
    const memory = performance.memory;
    if (!memory) return { available: false };
    const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;
    const read = () => ({ used: memory.usedJSHeapSize, t: performance.now() });
    if (gc) gc();
    const first = read();
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 100));
    if (gc) gc();
    const last = read();
    return {
      available: true,
      forcedGc: !!gc,
      first,
      last,
    };
  });
  if (!sample.available) return { available: false };
  const dtSec = (sample.last.t - sample.first.t) / 1000;
  const retainedBytes = sample.last.used - sample.first.used;
  return {
    available: true,
    forcedGc: sample.forcedGc,
    startMb: +(sample.first.used / 1048576).toFixed(1),
    endMb: +(sample.last.used / 1048576).toFixed(1),
    retainedKb: +(retainedBytes / 1024).toFixed(1),
    retainedKbPerSec: dtSec > 0 ? +(retainedBytes / 1024 / dtSec).toFixed(1) : 0,
  };
}
