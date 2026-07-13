/**
 * verify-deathmatch-browser — M2 live two-context integration (needs servers).
 *
 * Unlike the pure node checks, this one requires BOTH live servers:
 *   Terminal 1:  npm run party:dev      # PartyKit on 127.0.0.1:1999
 *   Terminal 2:  npm run dev            # Vite on 127.0.0.1:5173
 *   Terminal 3:  npm run verify:deathmatch-browser
 *
 * It launches two INDEPENDENT Chromium contexts (not two pages sharing storage),
 * has A create a room and B join by code, and asserts both browsers converge on
 * the same room over one socket each. WebGPU render correctness is out of scope
 * here (headless Chromium can't be trusted for pixels — see CLAUDE.md); this
 * proves the network/lobby handshake end to end.
 *
 * Env overrides: DM_APP_URL (default http://127.0.0.1:5173),
 *                VITE_PARTYKIT_HOST (default 127.0.0.1:1999).
 */

import { chromium } from 'playwright';

const APP_URL = process.env.DM_APP_URL ?? 'http://127.0.0.1:5173';
const PARTY_HOST = process.env.VITE_PARTYKIT_HOST ?? '127.0.0.1:1999';

async function reachable(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function preflight() {
  const appUp = await reachable(APP_URL);
  const partyUp = await reachable(`http://${PARTY_HOST}/`);
  if (!appUp || !partyUp) {
    console.log('verify-deathmatch-browser: SKIPPED (live servers not detected)');
    if (!appUp) console.log(`  · Vite not reachable at ${APP_URL} — run: npm run dev`);
    if (!partyUp) console.log(`  · PartyKit not reachable at ${PARTY_HOST} — run: npm run party:dev`);
    console.log('  Start both servers, then re-run this check.');
    process.exit(0); // Not a failure: this test is opt-in and infra-gated.
  }
}

/** Open a fresh isolated context and drive the lobby to the room overlay. */
async function openClient(browser, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${APP_URL}?level=deathmatch&autostart=1`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('deathmatch-lobby').waitFor({ timeout: 20_000 });
  await page.getByTestId('dm-name').fill(name);
  return { context, page };
}

async function main() {
  await preflight();

  const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
  const failures = [];
  try {
    const a = await openClient(browser, 'Ann');
    const b = await openClient(browser, 'Bob');

    // A creates a room, then reads the room code from its overlay.
    await a.page.getByTestId('dm-create').click();
    await a.page.getByTestId('deathmatch-room-overlay').waitFor({ timeout: 30_000 });
    const codeText = await a.page.getByTestId('dm-room-code').innerText();
    const code = (codeText.match(/[A-Z0-9]{4,12}/) ?? [])[0];
    if (!code) failures.push('could not read room code from A overlay');

    // B joins by code.
    await b.page.getByTestId('dm-code').fill(code ?? '');
    await b.page.getByTestId('dm-join').click();
    await b.page.getByTestId('deathmatch-room-overlay').waitFor({ timeout: 30_000 });

    // Both should show two players.
    const countPlayers = async (page) =>
      page.locator('[data-testid="deathmatch-room-overlay"] .dm-room__player').count();

    await a.page.waitForFunction(
      () => document.querySelectorAll('[data-testid="deathmatch-room-overlay"] .dm-room__player').length >= 2,
      { timeout: 15_000 },
    ).catch(() => failures.push('A never saw 2 players'));
    await b.page.waitForFunction(
      () => document.querySelectorAll('[data-testid="deathmatch-room-overlay"] .dm-room__player').length >= 2,
      { timeout: 15_000 },
    ).catch(() => failures.push('B never saw 2 players'));

    const [na, nb] = [await countPlayers(a.page), await countPlayers(b.page)];
    if (na !== 2) failures.push(`A shows ${na} players (expected 2)`);
    if (nb !== 2) failures.push(`B shows ${nb} players (expected 2)`);

    await a.context.close();
    await b.context.close();
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error('verify-deathmatch-browser FAILED');
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('verify-deathmatch-browser: two contexts joined one room and converged');
}

main().catch((err) => {
  console.error('verify-deathmatch-browser errored');
  console.error(err);
  process.exit(1);
});
