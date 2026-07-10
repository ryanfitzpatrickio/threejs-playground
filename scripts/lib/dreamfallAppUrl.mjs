/**
 * Build the app URL for Playwright/node harnesses.
 * DREAMFALL_URL is the URL of record (host, port, AND existing query are kept).
 * Do NOT use `new URL(path, base)` — that strips base search params.
 *
 * @param {Record<string, string|null|undefined>} [extraParams]
 *   Set a key to null/undefined to delete it (e.g. { autostart: null } for menu-path verify).
 * @param {{ skipAutostart?: boolean }} [opts]
 */
export function dreamfallAppUrl(extraParams = {}, opts = {}) {
  const u = new URL(process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173/');
  // Only default autostart when the env URL did not already specify it.
  // Preserves intentional ?autostart=0 or truthy overrides from operators.
  if (!opts.skipAutostart && !u.searchParams.has('autostart')) {
    u.searchParams.set('autostart', '1');
  }
  for (const [k, v] of Object.entries(extraParams)) {
    if (v == null) u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Absolute URL for a non-root path on the same app host (keeps search from dreamfallAppUrl).
 */
export function dreamfallAbsoluteUrl(pathname, extraParams = {}, opts = {}) {
  const u = new URL(dreamfallAppUrl(extraParams, opts));
  u.pathname = pathname;
  return u.toString();
}

/** Self-check when run directly: `node scripts/lib/dreamfallAppUrl.mjs` */
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('dreamfallAppUrl.mjs')) {
  const prev = process.env.DREAMFALL_URL;
  process.env.DREAMFALL_URL = 'http://127.0.0.1:5175/?level=city&autostart=0';
  const a = dreamfallAppUrl();
  if (!a.includes('5175') || !a.includes('autostart=0') || !a.includes('level=city')) {
    console.error('FAIL preserve query', a);
    process.exit(1);
  }
  process.env.DREAMFALL_URL = 'http://127.0.0.1:5173';
  const b = dreamfallAppUrl();
  if (!b.includes('autostart=1')) {
    console.error('FAIL default autostart', b);
    process.exit(1);
  }
  const c = dreamfallAppUrl({ autostart: null });
  if (c.includes('autostart=')) {
    console.error('FAIL delete autostart', c);
    process.exit(1);
  }
  const d = dreamfallAppUrl({}, { skipAutostart: true });
  if (d.includes('autostart=')) {
    console.error('FAIL skipAutostart', d);
    process.exit(1);
  }
  if (prev == null) delete process.env.DREAMFALL_URL;
  else process.env.DREAMFALL_URL = prev;
  console.log('ok: dreamfallAppUrl self-check');
}
