/**
 * Narrow shared boot warmup (PR4). Completes under a wall-clock budget, then
 * yields to the main menu. Does not attach a GameRuntime or WebGPU scene.
 */

import { ensureRapier } from '../physics/rapierInit.js';
import { GAME_CONFIG } from '../config/gameConfig.js';

const DEFAULT_BUDGET_MS = 2000;

/**
 * Optional known asset URLs to HTTP-prefetch (browser cache only — no parse).
 * Keep small; over-budget work is soft-skipped.
 */
const PREFETCH_URLS = [
  // Lightweight static that always exists; real Mara packs are large and
  // profile-dependent — avoid claiming hitch reduction without a parse cache.
];

/**
 * @param {{
 *   onProgress?: (p: { phase: string, label: string, fraction: number, completed: number, total: number }) => void,
 *   budgetMs?: number,
 * }} [options]
 */
export async function runSharedWarmup(options = {}) {
  const budgetMs = options.budgetMs
    ?? GAME_CONFIG.boot?.sharedWarmupBudgetMs
    ?? DEFAULT_BUDGET_MS;
  const onProgress = options.onProgress ?? (() => {});
  const t0 = performance.now();
  const mark = (label, fraction, completed, total) => {
    onProgress({
      phase: 'shared',
      label,
      fraction: Math.min(1, Math.max(0, fraction)),
      completed,
      total,
    });
  };

  const total = 3;
  mark('Initializing physics…', 0.05, 0, total);

  try {
    await ensureRapier();
  } catch (err) {
    console.warn('[sharedWarmup] Rapier init failed (soft-fail to menu)', err);
  }
  mark('Physics ready', 0.55, 1, total);

  if (performance.now() - t0 < budgetMs && PREFETCH_URLS.length > 0) {
    mark('Prefetching assets…', 0.65, 1, total);
    await Promise.allSettled(
      PREFETCH_URLS.map((url) => fetch(url, { cache: 'force-cache', mode: 'no-cors' }).catch(() => null)),
    );
  }
  mark('Prefetch done', 0.85, 2, total);

  // Soft idle frames so the loading UI can paint.
  for (let i = 0; i < 2; i += 1) {
    if (performance.now() - t0 >= budgetMs) break;
    await new Promise((r) => requestAnimationFrame(r));
  }

  mark('Ready', 1, total, total);
  try {
    performance.measure?.('dreamfall-shared-warmup', {
      start: t0,
      end: performance.now(),
    });
  } catch {
    // measure may fail if marks missing; ignore
  }
  return { durationMs: performance.now() - t0 };
}
