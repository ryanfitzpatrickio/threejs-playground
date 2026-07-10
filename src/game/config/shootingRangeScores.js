/**
 * Per-gun best scores for the Shooting Range breach course (localStorage).
 */

const STORAGE_KEY = 'dreamfall:shooting-range:scores';

/**
 * @returns {Record<string, { best: number, updatedAt: number }>}
 */
export function loadShootingRangeScores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * @param {string} gunId
 * @returns {number}
 */
export function getShootingRangeBest(gunId) {
  if (!gunId) return 0;
  const scores = loadShootingRangeScores();
  const entry = scores[gunId];
  return Number.isFinite(entry?.best) ? entry.best : 0;
}

/**
 * Persist a run if it beats the previous best for this gun.
 * @param {string} gunId
 * @param {number} score
 * @returns {{ best: number, isNewBest: boolean }}
 */
export function recordShootingRangeScore(gunId, score) {
  const id = gunId || 'unknown';
  const value = Math.round(Number(score) || 0);
  const scores = loadShootingRangeScores();
  const prev = Number.isFinite(scores[id]?.best) ? scores[id].best : null;
  const isNewBest = prev == null || value > prev;
  if (isNewBest) {
    scores[id] = { best: value, updatedAt: Date.now() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
    } catch {
      // quota / private mode
    }
  }
  return {
    best: isNewBest ? value : (prev ?? value),
    isNewBest,
  };
}
