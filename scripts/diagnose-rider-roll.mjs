// Regression test for the rider-roll bug.
//
// Boots the app, force-mounts the horse, freezes the riding clip, then sweeps
// the horse through a range of yaws (including the backward hemisphere) and
// checks two invariants that must hold while mounted:
//
//   1. The rider's character.group orientation is a CLEAN YAW — its rotation
//      axis stays on world up, so the quaternion's x/z (tilt) components are
//      ~0 for every horse yaw. The bug: WallRunSystem ran an unconditional
//      lean-reset that wrote character.group.rotation.z every frame, which
//      resynced the quaternion from the full Euler and baked in roll whenever
//      the clean yaw's XYZ-Euler form carried non-zero pitch/roll — i.e. for
//      backward-hemisphere yaws. (Fixed by skipping the lean reset while any
//      other orientation-owning state is active.)
//   2. No rider bone's LOCAL quaternion depends on yaw (clip frozen + torso
//      stabilized), so the roll is never skeletal.
//
// Exits non-zero if either invariant is violated. Run against a dev server:
//   DREAMFALL_URL=http://127.0.0.1:5175 node scripts/diagnose-rider-roll.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const appUrl = dreamfallAppUrl();
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const YAWS = [0, 45, 90, 135, 180, 225, 270, -45, -90, -135];
const ROLL_FLAG_DEG = 0.3; // per-bone local-quaternion drift threshold
const MAX_TILT_DEG = 1.0; // rider group rotation axis must stay within this of world up

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
});

let tiltFailure = false;
let boneFailure = false;

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [browser error]', msg.text());
  });

  console.log(`Loading ${appUrl} ...`);
  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.character?.source === 'fbx',
  );
  console.log('Runtime ready. Forcing mount...');

  await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.forceMount());
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.mount?.state === 'mounted',
    { timeout: 8000 },
  );
  console.log('Mounted. Settling + freezing riding clip...');
  await page.waitForTimeout(700);
  await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.setRiderTimeScale(0));
  await page.waitForTimeout(300);

  const samples = [];
  for (const yaw of YAWS) {
    await page.evaluate((y) => globalThis.__DREAMFALL_DEBUG__.setHorseYaw(y), yaw);
    await page.waitForTimeout(260);
    const dump = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.dumpRiderBones());
    samples.push({ yaw, dump });
  }

  tiltFailure = reportGroupTilt(samples);
  boneFailure = reportBones(samples);
} finally {
  await browser.close();
}

if (tiltFailure || boneFailure) {
  console.log(`\nRESULT: FAIL (group tilt=${tiltFailure ? 'BAD' : 'ok'}, bones=${boneFailure ? 'BAD' : 'ok'})`);
  process.exitCode = 1;
} else {
  console.log('\nRESULT: PASS — rider orientation is a clean yaw for every horse heading; no bone drift.');
}

// Rider group must be a clean yaw: how far its rotation axis tilts off world up.
function reportGroupTilt(samples) {
  console.log('\n== rider group rotation-axis tilt off world up (must be ~0 for every yaw) ==');
  console.log('  yaw(set) | group.quat (xyzw)         | tilt   | group(yaw pitch roll)');
  let worst = 0;
  let worstYaw = 0;
  for (const { yaw, dump } of samples) {
    const [x, y, z] = dump.group.quat;
    // axis tilt from Y: the x/z magnitude of the (normalized) vector part
    const lateral = Math.sqrt(x * x + z * z);
    const vertical = Math.abs(y);
    const tiltDeg = (Math.atan2(lateral, vertical) * 180) / Math.PI;
    if (tiltDeg > worst) {
      worst = tiltDeg;
      worstYaw = yaw;
    }
    const q = dump.group.quat.map((v) => v.toFixed(2)).join(',');
    const g = dump.group;
    console.log(
      `  ${String(yaw).padStart(5)} | [${q.padEnd(23)}] | ${tiltDeg.toFixed(2).padStart(5)}deg | ` +
      `(${fmt(g.yawDeg)} ${fmt(g.pitchDeg)} ${fmt(g.rollDeg)})`,
    );
  }
  const ok = worst <= MAX_TILT_DEG;
  console.log(`  worst tilt: ${worst.toFixed(2)}deg at yaw=${worstYaw}deg — ${ok ? 'OK' : 'FAIL (threshold ' + MAX_TILT_DEG + 'deg)'}`);
  return !ok;
}

function reportBones(samples) {
  const reference = samples[0].dump.bones;
  const byName = new Map(reference.map((b) => [b.name, { name: b.name, deltas: [] }]));

  for (const { dump } of samples) {
    const map = new Map(dump.bones.map((b) => [b.name, b.q]));
    for (const entry of byName.values()) {
      const q = map.get(entry.name);
      entry.deltas.push(q ? quatAngleDeg(reference.find((b) => b.name === entry.name).q, q) : null);
    }
  }

  const rows = [...byName.values()]
    .map((e) => ({ name: e.name, maxDelta: Math.max(...e.deltas) }))
    .sort((a, b) => b.maxDelta - a.maxDelta);

  const flagged = rows.filter((r) => r.maxDelta > ROLL_FLAG_DEG);
  console.log(`\n== bones whose LOCAL quaternion changes with yaw (clip is FROZEN) ==`);
  if (!flagged.length) {
    console.log('  (none) — no bone is yaw-driven; roll is not a per-bone local-quaternion effect.');
  } else {
    for (const r of flagged) {
      console.log(`  ${r.name.padEnd(24)} maxDelta=${r.maxDelta.toFixed(2)}deg`);
    }
  }

  const torsos = ['mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead'];
  console.log(`\n== torso chain max delta (should be ~0 if stabilizer holds) ==`);
  for (const name of torsos) {
    const r = rows.find((x) => x.name === name);
    if (r) console.log(`  ${name.padEnd(24)} maxDelta=${r.maxDelta.toFixed(2)}deg`);
  }
  return flagged.length > 0;
}

function quatAngleDeg(a, b) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  dot = Math.min(1, Math.max(-1, Math.abs(dot)));
  return (2 * Math.acos(dot) * 180) / Math.PI;
}

function fmt(v) {
  return String(v).padStart(7);
}
