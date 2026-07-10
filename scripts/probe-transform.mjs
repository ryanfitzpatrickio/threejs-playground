#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import { chromium } from 'playwright';
const appUrl = dreamfallAppUrl() /* was 5174 default */;
const browser = await chromium.launch({ headless:true, executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined, args:['--enable-unsafe-webgpu','--enable-features=Vulkan'] });
const page = await browser.newPage({ viewport:{width:1440,height:900} });
await page.goto(appUrl,{waitUntil:'domcontentloaded'});
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(()=>globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage==='running',{timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,7000));

const data = await page.evaluate(()=>{
  const scene = globalThis.__DREAMFALL_DEBUG__?.getScene?.();
  if(!scene) return {error:'no scene'};
  scene.updateMatrixWorld(true);
  const out = {};
  function report(label, nameRe){
    let node=null; scene.traverse(o=>{ if(!node && o.name && nameRe.test(o.name)) node=o; });
    if(!node){ out[label]='not found'; return; }
    // find first skinned descendant
    let sk=null; node.traverse(o=>{ if(!sk && o.isSkinnedMesh) sk=o; });
    let boneExtent=null;
    if(sk && sk.skeleton){
      let mn=1/0,mx=-1/0; const v={x:0,y:0,z:0};
      for(const b of sk.skeleton.bones){
        const e=b.matrixWorld.elements;
        // world position = (e12,e13,e14) / w
        v.x=e[12]; v.y=e[13]; v.z=e[14];
        if(v.y<mn)mn=v.y; if(v.y>mx)mx=v.y;
      }
      boneExtent={minY:mn.toFixed(3), maxY:mx.toFixed(3), height:(mx-mn).toFixed(3)};
    }
    out[label]={ name:node.name, scale:[node.scale.x.toFixed(3),node.scale.y.toFixed(3),node.scale.z.toFixed(3)], eulerDeg:[(node.rotation.x*180/Math.PI).toFixed(0),(node.rotation.y*180/Math.PI).toFixed(0),(node.rotation.z*180/Math.PI).toFixed(0)], boneExtent };
  }
  report('mara_object', /Mara Climber/);
  report('enemy0', /^Enemy 1$/);
  report('horse', /Horse Rigged/);
  return out;
});

console.log(JSON.stringify(data, null, 2));
await page.screenshot({ path: '.codex-tmp/probe-browser/mara-fixed.png' });
await browser.close();
