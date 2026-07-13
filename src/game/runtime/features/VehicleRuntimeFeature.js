import { computeRunOverHits, computeRunOverLaunch } from '../../vehicles/runOver.js';
import { bindRuntimeHost } from '../bindRuntimeHost.js';

/** Vehicle runtime glue: run-over and related fixed-step integration helpers. */
export class VehicleRuntimeFeature {
  constructor(host) {
    this._host = host;

    return bindRuntimeHost(this, host);
  }


  _applyVehicleRunOver() {
    const vehicle = this.vehicleSystem?.activeVehicle;
    const cfg = vehicle?.config?.runOver;
    if (!vehicle || vehicle.domain !== 'ground' || !cfg?.enabled) {
      return;
    }
    const frame = vehicle.getRunOverFrame();
    const enemies = this.enemySystem?.enemies;
    // computeRunOverHits collects into a fresh array, so it is safe that the loop
    // below removes enemies (which splices enemySystem.enemies) as it ragdolls them.
    const hits = computeRunOverHits({ frame, enemies, cfg });
    for (const { enemy, sideSign } of hits) {
      const launch = computeRunOverLaunch({ frame, sideSign, cfg });
      this.enemyCutSystem.smashEnemyToRagdoll({
        enemy,
        launchVelocity: launch,
        physicsSystem: this.physicsSystem,
        enemySystem: this.enemySystem,
        propSystem: this.propSystem,
      });
    }
  }

}
