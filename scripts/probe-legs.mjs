import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });
const page = await browser.newPage({});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');
await page.waitForTimeout(500);
const legQuats = async () => page.evaluate(() => {
  const dump = globalThis.__DREAMFALL_DEBUG__.dumpRiderBones();
  const legs = {};
  for (const b of dump.bones) {
    if (/^(mixamorigHips|mixamorigLeftUpLeg|mixamorigLeftLeg|mixamorigLeftFoot|mixamorigRightUpLeg|mixamorigRightLeg|mixamorigRightFoot)/.test(b.name)) {
      legs[b.name] = b.q;
    }
  }
  return { state: dump.animState, legs };
});
const snap = () => page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
await page.keyboard.press('KeyQ');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'armed', { timeout: 4000 });
await page.waitForTimeout(400);
// ensure idle
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.character?.animation?.currentState === 'idle', { timeout: 3000 }).catch(()=>{});
await page.waitForTimeout(200);
const idle = await legQuats();
let s1 = await snap();
console.log('IDLE: animState=', idle.state, 'speed=', s1.character.speed, 'currentState(base)=', s1.character.animation.currentState, 'upper=', s1.character.animation.upperBodyState);
// attack standing
const box = await page.locator('canvas.game-canvas').boundingBox();
await page.mouse.click(box.x+box.width/2, box.y+box.height/2, { button: 'left' });
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.state === 'lightSlash1', { timeout: 2000 }).catch(()=>{});
await page.waitForTimeout(400); // mid-swing
const atk = await legQuats();
let s2 = await snap();
console.log('ATTACK: animState=', atk.state, 'speed=', s2.character.speed, 'currentState(base)=', s2.character.animation.currentState, 'upper=', s2.character.animation.upperBodyState);
// diff
let maxDiff = 0, sumDiff = 0, n = 0;
for (const name of Object.keys(idle.legs)) {
  const a = idle.legs[name], b = atk.legs[name];
  if (!b) continue;
  for (let i=0;i<4;i++){ const d=Math.abs(a[i]-b[i]); if (d>maxDiff)maxDiff=d; sumDiff+=d; }
  n++;
}
console.log(`LEG DIFF idle vs mid-attack: maxQuatComponentDiff=${maxDiff.toFixed(4)} (0=identical, >0.1=clearly different)`);
await browser.close();
