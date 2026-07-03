// Final A/B: Rapier raycast vehicle controller (new default) vs the legacy custom
// suspension + rigid wheel balls. Drives full throttle over real procedural terrain
// and reports top speed, grounded fraction, and peak vertical jerk (the "pop").
//
// Run: node scripts/probe-controller-vs-legacy.mjs

function ctx(){const g={addColorStop(){}};return new Proxy({},{get:(_t,p)=>p==='createLinearGradient'||p==='createRadialGradient'?(()=>g):p==='getImageData'?(()=>({data:new Uint8ClampedArray(4)})):(()=>{}),set:()=>true});}
const cv=()=>({width:64,height:64,getContext:ctx,style:{},addEventListener(){},removeEventListener(){},setAttribute(){}});
globalThis.document={createElement:(t)=>t==='canvas'?cv():{style:{},appendChild(){},addEventListener(){},removeEventListener(){},setAttribute(){}},createElementNS:()=>cv()};

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';

await RAPIER.init();
const dt = 1 / 120;

async function run(useRayCastController) {
  const level = createStreamingTerrainLevel({}, { worldMap: null });
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -15.5, z: 0 });
  physics.world.numSolverIterations = 8;
  for (const tc of level.terrainChunks) physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
  for (let cz = 2; cz >= -200; cz -= 1) for (let cx = -2; cx <= 2; cx += 1)
    level.ensureGroundCollider(new THREE.Vector3(cx * 32, 0, cz * 32), physics, { radiusChunks: 0 });
  physics.world.step();

  const vs = new VehicleSystem();
  vs.initialize({ physics, scene: new THREE.Scene(), level });
  const veh = new BaseVehicle({ position: level.spawnPoint.clone(), rotationY: 0, config: { ground: { useRayCastController } } });
  await vs.spawnVehicle({ vehicle: veh });
  vs.activeVehicle = veh;
  const bodyOf = () => physics.world.bodies.get(veh.bodyHandle);

  physics.world.timestep = dt;
  for (let i = 0; i < 120; i += 1) { veh.update({ dt, controls: { throttle: 0, steer: 0, brake: 0, handbrake: false, boost: false }, physics }); physics.world.step(); physics.steppedThisFrame = false; }

  const drive = { moveX: 0, moveZ: -1, jump: false, slide: false, brace: false, mountPressed: false };
  let prevVy = bodyOf().linvel().y, maxJerk = 0, sumGF = 0, n = 0, topSpeed = 0, sumJerk = 0;
  for (let f = 0; f < 5200; f += 1) {
    physics.steppedThisFrame = false;
    vs.update({ delta: dt, input: drive, character: stub(veh), level });
    physics.world.step();
    const v = bodyOf().linvel();
    const spd = Math.hypot(v.x, v.y, v.z);
    topSpeed = Math.max(topSpeed, spd);
    if (spd > 12) { // measure the at-speed regime
      const dVy = v.y - prevVy; sumJerk += Math.abs(dVy); maxJerk = Math.max(maxJerk, Math.abs(dVy)); sumGF += veh.groundedFraction; n += 1;
    }
    prevVy = v.y;
  }
  return { model: useRayCastController ? 'CONTROLLER' : 'LEGACY', topSpeed: +topSpeed.toFixed(0), grounded: n ? +(sumGF / n).toFixed(2) : 0, maxJerk: +maxJerk.toFixed(1), sumJerk: +sumJerk.toFixed(0), fastFrames: n };
}

const legacy = await run(false);
const ctrl = await run(true);
const f = (r) => `top=${r.topSpeed}m/s  grounded@speed=${r.grounded}  maxJerk=${r.maxJerk}  Σjerk=${r.sumJerk}  (fastFrames=${r.fastFrames})`;
console.log('LEGACY (balls):', f(legacy));
console.log('CONTROLLER    :', f(ctrl));

function stub(v) { return { group: v.group, velocity: new THREE.Vector3(), verticalVelocity: 0, grounded: true, vehicle: { active: true, vehicle: v, seatIndex: v.driverSeatIndex, handTargets: null, anchorOffset: null }, animationController: { play() {} } }; }
