import * as THREE from 'three';
import { MARA_ANIMATION_MANIFEST } from '../characters/mara/maraAnimationManifest.js';
import { shortestAngleDelta } from '../utils/angleUtils.js';

// Combat system for the great-sword moveset. Owns `character.combat` (weapon
// state, combo progress, the active attack) and drives it in two phases from
// GameRuntime.update:
//   - processInput(): runs BEFORE movement. Reads attack/draw inputs, advances the
//     state machine, and returns a possibly-patched input (movement is locked while
//     attacking). Sets `character.combat.animationOverride` so AnimationStateSystem
//     plays the attack/draw clip this same frame.
//   - update(): runs AFTER AnimationStateSystem (mixer stepped). Detects when a
//     non-looping override clip (draw / sheathe / attack) has finished, advances
//     combo/weapon state, and (milestone 3) sweeps the blade for hit casts.
//
// AnimationStateSystem remains the sole caller of controller.play(): this system
// only decides WHICH state by setting animationOverride / the `armed` flag.

const OVERRIDE_FINISH_NORMALIZED = 0.98;

// Set false to silence sword-trace console logs and hide the 3-D visualizer.
const CUT_DEBUG = true;

// Blade visualizer colours.
const COLOR_BLADE_LIVE   = new THREE.Color(1.0, 1.0, 1.0);   // white  — current segment
const COLOR_TRAIL_WARM   = new THREE.Color(1.0, 0.45, 0.1);  // orange — before hit window
const COLOR_TRAIL_HOT    = new THREE.Color(0.0, 1.0, 0.9);   // cyan   — inside hit window, no contact
const COLOR_TRAIL_HIT    = new THREE.Color(1.0, 0.08, 0.12); // red    — blade overlapping enemy hitbox
const COLOR_TIP_SPHERE   = new THREE.Color(1.0, 0.95, 0.3);  // yellow — tip dot
// Max trail frames to keep (safety cap; a full swing is ~20-40 frames at 60 fps).
const TRAIL_MAX_FRAMES = 120;

// --- Hit casting tuning (milestone 3) ---
const HIT_REACH = 3.6; // max horizontal distance (player -> enemy) for a swing to connect
const HIT_REACH_SQ = HIT_REACH * HIT_REACH;
const BLADE_RADIUS = 0.35; // tolerance added to the enemy radius when testing the blade segment
const LIGHT_DAMAGE = 25;
const STAGGER_SECONDS = 0.4;

const UP = new THREE.Vector3(0, 1, 0);
// Scratch vectors (combat runs single-threaded once per frame; safe to reuse).
const _base = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _prevTip = new THREE.Vector3();
const _center = new THREE.Vector3();
const _swing = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _closest = new THREE.Vector3();

export class CombatSystem {
  constructor() {
    this.character = null;
    this.combat = null;

    // 3-D blade debug visuals (created by initialize(), null until then).
    this._debugScene       = null;
    this._bladeLine        = null;   // Line — live base→tip segment
    this._tipSphere        = null;   // Mesh — dot at the tip
    this._trailMesh        = null;   // Mesh — ribbon of past segments
    this._trailGeo         = null;   // BufferGeometry reused each frame
    this._trailPoints      = [];     // [{base, tip, state}] captured this swing
    // Toggled on/off with P (collisionDebugPressed). Off by default.
    this._bladeDebugEnabled = false;
  }

  // Call once after the scene is ready (mirrors EnemyCutSystem.initialize).
  initialize(scene) {
    if (!CUT_DEBUG || !scene) {
      return;
    }
    this._debugScene = scene;

    // --- live blade line (2-point Line) ---
    const bladeGeo = new THREE.BufferGeometry();
    bladeGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(6), 3),
    );
    this._bladeLine = new THREE.Line(
      bladeGeo,
      new THREE.LineBasicMaterial({
        color: COLOR_BLADE_LIVE,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this._bladeLine.name = 'BladeDebugLine';
    this._bladeLine.renderOrder = 50;
    this._bladeLine.visible = false;
    scene.add(this._bladeLine);

    // --- tip sphere ---
    this._tipSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 8),
      new THREE.MeshBasicMaterial({
        color: COLOR_TIP_SPHERE,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      }),
    );
    this._tipSphere.name = 'BladeDebugTip';
    this._tipSphere.renderOrder = 51;
    this._tipSphere.visible = false;
    scene.add(this._tipSphere);

    // --- ribbon trail mesh (geometry rebuilt each frame) ---
    this._trailGeo = new THREE.BufferGeometry();
    this._trailMesh = new THREE.Mesh(
      this._trailGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        depthTest: false,
        transparent: true,
        opacity: 0.18,
      }),
    );
    this._trailMesh.name = 'BladeDebugTrail';
    this._trailMesh.renderOrder = 49;
    this._trailMesh.visible = false;
    scene.add(this._trailMesh);
  }

  start({ character }) {
    this.character = character;
    this.combat = {
      // 'sheathed' | 'drawing' | 'armed' | 'sheathing'
      weapon: 'sheathed',
      armed: false,
      animationOverride: null,
      comboStep: 0,
      // active attack: { name, kind, hitEnemies:Set, prevTip:Vector3, finisher:boolean } | null
      attack: null,
      lockMovement: false,
      // buffered light-attack press queued during the active swing
      bufferedLight: false,
      sword: character?.sword ?? null,
    };

    if (character) {
      character.combat = this.combat;
    }
  }

  processInput({ input, character, enemies }) {
    const combat = character?.combat ?? this.combat;
    if (!combat) {
      return input;
    }

    if (input.drawSheathePressed && isFreeToAct(character)) {
      this.toggleWeapon({ combat });
    }

    this.processAttacks({ input, character, combat, enemies });

    return this.patchInputForCombat({ input, combat });
  }

  // Armed (sword drawn): light = left-click (combo slash1->2->3, finisher cuts),
  // heavy = right-click (finisher, cuts on hit). Mouse attacks are intentionally
  // inactive while unarmed; G/R retain the explicit grab/throw moves.
  processAttacks({ input, character, combat, enemies }) {
    if (combat.attack) {
      if (combat.weapon === 'armed' && input.lightAttackPressed) {
        combat.bufferedLight = true;
      }
      return;
    }

    if (combat.animationOverride || !isFreeToAct(character)) {
      return;
    }

    if (combat.weapon === 'armed') {
      if (input.heavyAttackPressed) {
        this.beginAttack({ combat, state: 'heavyAttack' });
      } else if (input.lightAttackPressed) {
        this.beginAttack({ combat, state: 'lightSlash1' });
      }
      return;
    }

    if (combat.weapon !== 'sheathed') {
      return;
    }

    // Unarmed (sword sheathed).
    if (input.grabSlamPressed) {
      if (this.findGrabTarget({ character, enemies })) {
        this.beginAttack({ combat, state: 'grabAndSlam' });
      }
      return;
    }
    if (input.shoulderThrowPressed) {
      if (this.findGrabTarget({ character, enemies })) {
        this.beginAttack({ combat, state: 'flyingShoulderThrow' });
      }
      return;
    }
  }

  update({ delta, character, enemies, physicsSystem, enemySystem, propSystem, enemyCutSystem, input }) {
    const combat = character?.combat ?? this.combat;
    if (!combat) {
      return;
    }

    // P toggles the blade-trace debug overlay (same key as collision debug).
    if (CUT_DEBUG && input?.collisionDebugPressed) {
      this._bladeDebugEnabled = !this._bladeDebugEnabled;
      if (!this._bladeDebugEnabled) {
        this._clearBladeDebug();
      }
    }

    // Sweep the active attack: the blade for sword swings, a forward-arc body cast
    // for unarmed moves (runs after AnimationStateSystem stepped the mixer).
    if (combat.attack) {
      const attackEntry = MARA_ANIMATION_MANIFEST[combat.attack.name];
      if (attackEntry?.combat?.attackKind === 'aimCut') {
        this.updateAimCut({
          character,
          combat,
          enemyCutSystem,
          enemySystem,
          propSystem,
          physicsSystem,
        });
      } else if (attackEntry?.combat?.hitShape === 'body') {
        this.castBody({ character, combat, enemies, enemySystem, enemyCutSystem, physicsSystem });
      } else {
        this.castBlade({ character, combat, enemies, physicsSystem, enemySystem, propSystem, enemyCutSystem });
      }
    }

    const override = combat.animationOverride;
    if (!override) {
      return;
    }

    const controller = character?.animationController;
    if (!controller) {
      return;
    }

    // Only non-looping clips (draw / sheathe / attacks) clear themselves here.
    const entry = MARA_ANIMATION_MANIFEST[override];
    if (entry?.loop) {
      return;
    }

    // Armed overrides (draw / sheathe / sword attacks) play on the UPPER-body
    // layer; sheathed (unarmed) overrides play FULL-body. Complete on whichever
    // layer the clip is actually on, else an unarmed clip never finishes.
    if (combat.armed) {
      if (controller.upperBodyState !== override) {
        return;
      }
      const t = typeof controller.getUpperBodyNormalizedTime === 'function'
        ? controller.getUpperBodyNormalizedTime()
        : 0;
      if (t < OVERRIDE_FINISH_NORMALIZED) {
        return;
      }
    } else {
      if (controller.currentState !== override) {
        return;
      }
      const t = typeof controller.getCurrentActionNormalizedTime === 'function'
        ? controller.getCurrentActionNormalizedTime()
        : normalizedTime(controller);
      if (t < OVERRIDE_FINISH_NORMALIZED) {
        return;
      }
    }

    this.completeOverride({ combat, enemyCutSystem });
  }

  beginAimCut({ combat, orientation }) {
    const state = orientation === 'horizontal' ? 'aimCutHorizontal' : 'aimCutVertical';
    this.beginAttack({ combat, state });
    combat.attack.aimCut = true;
    combat.lockMovement = true;
  }

  updateAimCut({
    character,
    combat,
    enemyCutSystem,
    enemySystem,
    propSystem,
    physicsSystem,
  }) {
    const attack = combat.attack;
    if (!attack?.aimCut || !enemyCutSystem) {
      return;
    }

    const entry = MARA_ANIMATION_MANIFEST[attack.name];
    const window = entry?.combat?.hitWindow;
    const trigger = entry?.combat?.cutTrigger
      ?? (window ? (window.start + window.end) * 0.5 : 0.35);
    const controller = character?.animationController;
    const t = typeof controller?.getUpperBodyNormalizedTime === 'function'
      ? controller.getUpperBodyNormalizedTime()
      : 0;

    if (!enemyCutSystem.cutCommitted && t >= trigger) {
      enemyCutSystem.commitPendingCuts({
        enemySystem,
        propSystem,
        physicsSystem,
      });
    }
  }

  // --- weapon draw / sheathe -------------------------------------------------

  toggleWeapon({ combat }) {
    if (combat.weapon === 'sheathed') {
      combat.weapon = 'drawing';
      combat.armed = true;
      combat.animationOverride = 'drawSword';
      if (combat.sword) {
        combat.sword.group.visible = true;
      }
    } else if (combat.weapon === 'armed') {
      combat.weapon = 'sheathing';
      combat.animationOverride = 'sheatheSword';
    }
    // Ignore the toggle while drawing / sheathing.
  }

  // Called when a non-looping override clip finishes. Advances weapon/combo state
  // and either chains into the next combo swing or releases control back to
  // AnimationStateSystem (clears the override).
  completeOverride({ combat, enemyCutSystem }) {
    const finished = combat.animationOverride;

    if (finished === 'drawSword') {
      combat.weapon = 'armed';
      combat.animationOverride = null;
      return;
    }

    if (finished === 'sheatheSword') {
      combat.weapon = 'sheathed';
      combat.armed = false;
      combat.animationOverride = null;
      if (combat.sword) {
        combat.sword.group.visible = false;
      }
      // Ensure clean exit from layered mode so next draw works and locomotion
      // state resets properly (especially right after start-of-game draw+sheathe).
      const controller = this.character?.animationController;
      if (controller) {
        controller.setUpperBodyState(null);
        controller.setAttackLegs(null, 0);
        controller.setLayered(false);
      }
      return;
    }

    if (combat.attack?.aimCut) {
      enemyCutSystem?.finishCutSwing?.();
      combat.attack = null;
      combat.comboStep = 0;
      combat.lockMovement = false;
      combat.animationOverride = null;
      return;
    }

    // Attack completion: handled fully in milestone 2 (chain or recover).
    if (isAttackState(finished)) {
      this.completeAttack({ combat });
    }
  }

  completeAttack({ combat }) {
    // Chain into the next combo swing if a light press was buffered mid-swing,
    // otherwise recover to armed locomotion.
    const buffered = combat.bufferedLight;
    const nextInChain = buffered ? nextComboState(combat) : null;

    combat.bufferedLight = false;
    combat.attack = null;
    combat.lockMovement = false;

    if (nextInChain) {
      this.beginAttack({ combat, state: nextInChain });
    } else {
      combat.comboStep = 0;
      combat.animationOverride = null;
    }
  }

  beginAttack({ combat, state }) {
    const entry = MARA_ANIMATION_MANIFEST[state];
    const kind = entry?.combat?.attackKind ?? 'light';
    const chain = entry?.combat?.comboChain;
    const finisher = Array.isArray(chain) && chain.length === 0;
    combat.comboStep = kind === 'light' ? combat.comboStep + 1 : 0;
    combat.animationOverride = state;
    // Lock movement for full-body (unarmed/sheathed) attacks so root motion from the
    // clip fully drives translation. Armed attacks are layered (upper body) and keep
    // locomotion legs, so do not lock.
    combat.lockMovement = !combat.armed;
    combat.attack = {
      name: state,
      kind,
      finisher,
      hitEnemies: new Set(),
      prevTip: new THREE.Vector3(),
      // debug: closest any enemy's body came to the blade this swing, and tip height
      nearestDist: Infinity,
      tipY: 0,
    };
    // Clear the trail so each swing starts fresh.
    if (this._bladeDebugEnabled) {
      this._clearBladeDebug();
    }
  }

  // --- input patching --------------------------------------------------------

  patchInputForCombat({ input, combat }) {
    if (!combat.lockMovement) {
      return input;
    }

    // Freeze horizontal movement while attacking; keep look / jump handling intact.
    return {
      ...input,
      moveX: 0,
      moveZ: 0,
    };
  }

  // --- hit casting (milestone 3) --------------------------------------------

  // Each frame during an attack: sample the blade base/tip in world space and
  // test the segment against nearby enemies' bounding spheres within the swing's
  // active window. First contact per enemy per swing registers a hit.
  castBlade({ character, combat, enemies, physicsSystem, enemySystem, propSystem, enemyCutSystem }) {
    const attack = combat.attack;
    const sword = combat.sword;
    const controller = character?.animationController;
    const modelRoot = controller?.modelRoot;
    if (!attack || !sword || !modelRoot) {
      return;
    }

    const entry = MARA_ANIMATION_MANIFEST[attack.name];
    const window = entry?.combat?.hitWindow;
    if (!window) {
      return;
    }

    // The mixer updated bone locals this frame but matrixWorld is only recomposed
    // on demand; force it so the blade helpers reflect the current swing pose.
    modelRoot.updateMatrixWorld(true);
    sword.bladeBase.getWorldPosition(_base);
    sword.bladeTip.getWorldPosition(_tip);

    // Attacks play on the upper-body layer, so the hit window is the upper
    // action's progress (the base is leg locomotion, which never "completes").
    const t = typeof controller.getUpperBodyNormalizedTime === 'function'
      ? controller.getUpperBodyNormalizedTime()
      : normalizedTime(controller);

    const inWindow = t >= window.start && t <= window.end;

    // Always record the blade position so the full arc is visible in the
    // visualizer (orange before window, cyan inside, red on enemy contact).
    // touchingEnemy is resolved later in the loop, so we patch the last point
    // after the loop via _patchLastTrailHit() when contact is detected.
    if (CUT_DEBUG && this._bladeDebugEnabled) {
      this._recordBladeFrame(_base, _tip, inWindow ? 'hot' : 'warm');
      this._updateBladeDebugVisuals(_base, _tip);
    }

    if (!inWindow) {
      attack.prevTip.copy(_tip); // keep the delta fresh for when we enter the window
      return;
    }

    const playerPos = character.group.position;
    const hits = [];
    // Track whether the blade overlaps ANY enemy's sphere this frame (used
    // by the debug visualizer to colour the ribbon red on contact frames).
    let touchingEnemy = false;

    for (const enemy of enemies ?? []) {
      if (!enemy?.model?.visible) {
        continue;
      }

      const ep = enemy.model.position;
      _center.set(ep.x, ep.y + (enemy.collisionHeight ?? 2) * 0.5, ep.z);
      const dist = segmentPointDistance(_base, _tip, _center);
      if (dist < attack.nearestDist) {
        attack.nearestDist = dist; // closest any enemy came to the blade this swing
      }

      const dx = ep.x - playerPos.x;
      const dz = ep.z - playerPos.z;
      if (dx * dx + dz * dz > HIT_REACH_SQ) {
        continue;
      }

      const radius = (enemy.collisionRadius ?? 0.6) + BLADE_RADIUS;
      if (dist <= radius) {
        // Blade is inside this enemy's hitbox — flag for the visualizer
        // regardless of whether we already registered a hit this swing.
        touchingEnemy = true;

        if (!attack.hitEnemies.has(enemy)) {
          attack.hitEnemies.add(enemy);
          hits.push(enemy);
        }
      }
    }

    attack.tipY = _tip.y;

    // Upgrade the just-recorded trail segment to red if blade is touching.
    if (CUT_DEBUG && this._bladeDebugEnabled && touchingEnemy) {
      this._patchLastTrailHit();
      this._updateBladeDebugVisuals(_base, _tip);
    }

    if (CUT_DEBUG) {
      // --- Console: log cut angle while inside the hit window ---
      const _swingDbg = new THREE.Vector3().subVectors(_tip, attack.prevTip);
      if (_swingDbg.lengthSq() < 1e-6) {
        _swingDbg.subVectors(_tip, _base);
      }
      if (_swingDbg.lengthSq() > 1e-6) {
        _swingDbg.normalize();
        const swingAngleDeg = THREE.MathUtils.radToDeg(Math.atan2(_swingDbg.x, _swingDbg.z)).toFixed(1);
        const elevationDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(_swingDbg.y, -1, 1))).toFixed(1);
        if (attack._lastDebugFrame !== attack._debugFrame) {
          attack._lastDebugFrame = attack._debugFrame;
          console.log(
            `[sword-trace] t=${typeof controller.getUpperBodyNormalizedTime === 'function' ? controller.getUpperBodyNormalizedTime().toFixed(3) : '?'}` +
            ` swingAzimuth=${swingAngleDeg}° elevation=${elevationDeg}°` +
            ` tipY=${_tip.y.toFixed(2)} nearestDist=${Number.isFinite(attack.nearestDist) ? attack.nearestDist.toFixed(2) : '∞'}`,
          );
        }
        attack._debugFrame = (attack._debugFrame ?? 0) + 1;
      }
    }

    // Apply after iterating so removing a cut enemy can't perturb the loop.
    for (const enemy of hits) {
      this.applyHit({ enemy, attack, physicsSystem, enemySystem, propSystem, enemyCutSystem });
    }

    attack.prevTip.copy(_tip);
  }

  // --- Blade debug visualizer helpers ----------------------------------------

  // Record one frame of the sweep trail.
  // state: 'warm' (pre-window) | 'hot' (in window) | 'hit' (touching enemy hitbox)
  _recordBladeFrame(base, tip, state) {
    if (!this._trailPoints) {
      return;
    }
    if (this._trailPoints.length >= TRAIL_MAX_FRAMES) {
      this._trailPoints.shift();
    }
    this._trailPoints.push({
      base: base.clone(),
      tip: tip.clone(),
      state,
    });
  }

  // Upgrade the most-recently recorded trail point to 'hit' state.
  // Called after the enemy loop confirms contact this frame.
  _patchLastTrailHit() {
    if (this._trailPoints?.length > 0) {
      this._trailPoints[this._trailPoints.length - 1].state = 'hit';
    }
  }

  // Rebuild the live blade line, tip sphere, and ribbon from _trailPoints.
  _updateBladeDebugVisuals(base, tip) {
    // --- live blade line ---
    if (this._bladeLine) {
      const pos = this._bladeLine.geometry.attributes.position;
      pos.setXYZ(0, base.x, base.y, base.z);
      pos.setXYZ(1, tip.x, tip.y, tip.z);
      pos.needsUpdate = true;
      this._bladeLine.geometry.computeBoundingSphere();
      this._bladeLine.visible = true;
    }

    // --- tip sphere ---
    if (this._tipSphere) {
      this._tipSphere.position.copy(tip);
      this._tipSphere.visible = true;
    }

    // --- ribbon trail ---
    const pts = this._trailPoints;
    if (!this._trailMesh || pts.length < 2) {
      return;
    }

    // Each consecutive pair of frames forms a quad (2 triangles).
    // Vertices: A=pts[i].base, B=pts[i].tip, C=pts[i+1].base, D=pts[i+1].tip
    // Tri 1: A,B,D  Tri 2: A,D,C
    const quadCount = pts.length - 1;
    const vertCount = quadCount * 6;  // 2 tris × 3 verts
    const positions = new Float32Array(vertCount * 3);
    const colors    = new Float32Array(vertCount * 3);

    let vi = 0;
    const writeVert = (p, color) => {
      positions[vi * 3]     = p.x;
      positions[vi * 3 + 1] = p.y;
      positions[vi * 3 + 2] = p.z;
      colors[vi * 3]        = color.r;
      colors[vi * 3 + 1]    = color.g;
      colors[vi * 3 + 2]    = color.b;
      vi++;
    };

    for (let i = 0; i < quadCount; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      // Colour each quad by the leading edge's state.
      const c = b.state === 'hit' ? COLOR_TRAIL_HIT
              : b.state === 'hot' ? COLOR_TRAIL_HOT
              : COLOR_TRAIL_WARM;
      // Tri 1: a.base, a.tip, b.tip
      writeVert(a.base, c);
      writeVert(a.tip,  c);
      writeVert(b.tip,  c);
      // Tri 2: a.base, b.tip, b.base
      writeVert(a.base, c);
      writeVert(b.tip,  c);
      writeVert(b.base, c);
    }

    this._trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._trailGeo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
    this._trailGeo.computeBoundingSphere();
    this._trailMesh.visible = true;
  }

  // Hide and reset all debug visuals; called at the start of each swing.
  _clearBladeDebug() {
    this._trailPoints = [];
    if (this._bladeLine)  { this._bladeLine.visible  = false; }
    if (this._tipSphere)  { this._tipSphere.visible  = false; }
    if (this._trailMesh)  {
      this._trailMesh.visible = false;
      this._trailGeo?.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      this._trailGeo?.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(0), 3));
    }
  }

  applyHit({ enemy, attack, physicsSystem, enemySystem, propSystem, enemyCutSystem }) {
    if (enemy?.isDestructibleProp) {
      _prevTip.copy(attack.prevTip);
      const plane = buildCutPlane({ base: _base, tip: _tip, prevTip: _prevTip, enemy });
      enemyCutSystem?.applyDirectCut?.({
        enemy,
        plane,
        physicsSystem,
        enemySystem,
        propSystem,
        cutSystem: enemyCutSystem,
      });
      return;
    }

    const isHeavy = attack.kind === 'heavy';
    const isFinisher = !!attack.finisher;

    if (!isHeavy) {
      enemy.health = Math.max(0, (enemy.health ?? 0) - LIGHT_DAMAGE);
    }
    if (!isHeavy && !isFinisher) {
      enemy.staggerTimer = Math.max(enemy.staggerTimer ?? 0, STAGGER_SECONDS);
      enemySystem?.playAnimation?.(enemy, 'Idle Alert');
    }

    // Heavy swings always cut. Light finisher (last strike of the 3-hit melee combo)
    // cuts on contact. Light swings also cut if health hits zero.
    if (isHeavy || isFinisher || (enemy.health ?? 0) <= 0) {
      _prevTip.copy(attack.prevTip);
      const plane = buildCutPlane({ base: _base, tip: _tip, prevTip: _prevTip, enemy });

      // --- Debug: report the cut angle at the moment of impact ---
      const _swingDbg = new THREE.Vector3().subVectors(_tip, _prevTip);
      if (_swingDbg.lengthSq() < 1e-6) _swingDbg.subVectors(_tip, _base);
      _swingDbg.normalize();
      const azimuthDeg = THREE.MathUtils.radToDeg(Math.atan2(_swingDbg.x, _swingDbg.z)).toFixed(1);
      const elevationDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(_swingDbg.y, -1, 1))).toFixed(1);
      const normalDeg = THREE.MathUtils.radToDeg(Math.atan2(plane.normal.x, plane.normal.z)).toFixed(1);
      console.log(
        `%c[sword-cut] HIT — kind=${attack.kind} enemy=${enemy.id ?? '?'}` +
        ` | swingAzimuth=${azimuthDeg}° elevation=${elevationDeg}°` +
        ` | cutNormal=(${plane.normal.x.toFixed(2)},${plane.normal.y.toFixed(2)},${plane.normal.z.toFixed(2)}) azimuth=${normalDeg}°` +
        ` | tipY=${_tip.y.toFixed(2)} nearestDist=${Number.isFinite(attack.nearestDist) ? attack.nearestDist.toFixed(2) : '∞'}`,
        'color: #00ffee; font-weight: bold;',
      );

      enemyCutSystem?.applyDirectCut?.({
        enemy,
        plane,
        physicsSystem,
        enemySystem,
        propSystem,
        cutSystem: enemyCutSystem,
      });
    }
  }

  // Forward-arc hit cast for unarmed attacks (no blade). Within the manifest
  // hitWindow, enemies inside `reach` and `arc` (around the player's facing) are
  // hit once each; applyUnarmedHit resolves stagger / knockback / throw.
  castBody({ character, combat, enemies, enemySystem, enemyCutSystem, physicsSystem }) {
    const attack = combat.attack;
    if (!attack) {
      return;
    }
    const controller = character?.animationController;
    const entry = MARA_ANIMATION_MANIFEST[attack.name];
    const window = entry?.combat?.hitWindow;
    if (!entry?.combat || !window) {
      return;
    }

    // Unarmed attacks play full-body (sheathed), so read the base action's time.
    const t = typeof controller?.getCurrentActionNormalizedTime === 'function'
      ? controller.getCurrentActionNormalizedTime()
      : normalizedTime(controller);
    if (!(t >= window.start && t <= window.end)) {
      return;
    }

    const pos = character.group.position;
    const yaw = character.group.rotation.y ?? 0;
    const reach = entry.combat.reach ?? 2.0;
    const halfArc = (entry.combat.arc ?? Math.PI * 0.5) * 0.5;
    const hits = [];

    for (const enemy of enemies ?? []) {
      if (!enemy?.model?.visible || attack.hitEnemies.has(enemy) || enemy.isDestructibleProp) {
        continue;
      }
      const dx = enemy.model.position.x - pos.x;
      const dz = enemy.model.position.z - pos.z;
      const radius = enemy.collisionRadius ?? 0.6;
      if (Math.hypot(dx, dz) > reach + radius) {
        continue;
      }
      const angleToEnemy = Math.atan2(dx, dz);
      if (Math.abs(shortestAngleDelta(angleToEnemy, yaw)) > halfArc) {
        continue;
      }
      attack.hitEnemies.add(enemy);
      hits.push(enemy);
    }

    for (const enemy of hits) {
      this.applyUnarmedHit({ enemy, attack, character, enemySystem, enemyCutSystem, physicsSystem });
    }
  }

  // Unarmed hits never cut — they stagger, knock back, or throw (ragdoll) instead.
  applyUnarmedHit({ enemy, attack, character, enemySystem, enemyCutSystem, physicsSystem }) {
    const entry = MARA_ANIMATION_MANIFEST[attack.name];
    const kb = entry?.combat?.knockback ?? { mode: 'stagger' };
    const playerPos = character.group.position;
    const enemyPos = enemy.model.position;

    // Horizontal direction from player to enemy (shove them away from the strike).
    _normal.set(enemyPos.x - playerPos.x, 0, enemyPos.z - playerPos.z);
    if (_normal.lengthSq() < 1e-6) {
      const yaw = character.group.rotation.y ?? 0;
      _normal.set(Math.sin(yaw), 0, Math.cos(yaw));
    } else {
      _normal.normalize();
    }

    if (kb.mode === 'throw') {
      // Launch the enemy as a ragdoll in the throw direction. Force 0 HP so
      // applyDirectCut's lethal-blow path guarantees a ragdoll (forced bisect).
      enemy.health = 0;
      enemyCutSystem?.applyDirectCut?.({
        enemy,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(
          new THREE.Vector3(_normal.x, 0, _normal.z),
          new THREE.Vector3(enemyPos.x, enemyPos.y + (enemy.collisionHeight ?? 2) * 0.5, enemyPos.z),
        ),
        physicsSystem,
        enemySystem,
      });
      return;
    }

    enemy.health = Math.max(0, (enemy.health ?? 0) - LIGHT_DAMAGE);

    if (kb.mode === 'knockback') {
      enemySystem?.applyKnockback?.(enemy, { direction: { x: _normal.x, z: _normal.z }, power: kb.power ?? 5 });
    } else {
      // stagger (basic jab)
      enemy.staggerTimer = Math.max(enemy.staggerTimer ?? 0, STAGGER_SECONDS);
      enemySystem?.playAnimation?.(enemy, 'Idle Alert');
    }
  }

  // Nearest visible enemy within a tight forward arc — gates grab/throw start.
  findGrabTarget({ character, enemies }) {
    const pos = character?.group?.position;
    if (!pos) {
      return null;
    }
    const yaw = character.group.rotation.y ?? 0;
    const maxReach = 2.0;
    const halfArc = Math.PI * 0.25; // ±45°
    let best = null;
    let bestDistSq = maxReach * maxReach;
    for (const enemy of enemies ?? []) {
      if (!enemy?.model?.visible) {
        continue;
      }
      const dx = enemy.model.position.x - pos.x;
      const dz = enemy.model.position.z - pos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > bestDistSq) {
        continue;
      }
      const angleToEnemy = Math.atan2(dx, dz);
      if (Math.abs(shortestAngleDelta(angleToEnemy, yaw)) > halfArc) {
        continue;
      }
      bestDistSq = distSq;
      best = enemy;
    }
    return best;
  }

  snapshot() {
    const combat = this.combat;
    if (!combat) {
      return { active: false };
    }

    return {
      active: true,
      weapon: combat.weapon,
      armed: combat.armed,
      attack: combat.attack
        ? {
            name: combat.attack.name,
            kind: combat.attack.kind,
            hits: combat.attack.hitEnemies.size,
            nearestDist: Number.isFinite(combat.attack.nearestDist)
              ? Number(combat.attack.nearestDist.toFixed(2))
              : null,
            tipY: Number(combat.attack.tipY.toFixed(2)),
          }
        : null,
      comboStep: combat.comboStep,
      animationOverride: combat.animationOverride,
      lockMovement: combat.lockMovement,
    };
  }

  dispose() {
    this._clearBladeDebug();
    this._bladeLine?.geometry?.dispose();
    this._bladeLine?.material?.dispose();
    this._bladeLine?.removeFromParent();
    this._tipSphere?.geometry?.dispose();
    this._tipSphere?.material?.dispose();
    this._tipSphere?.removeFromParent();
    this._trailGeo?.dispose();
    this._trailMesh?.material?.dispose();
    this._trailMesh?.removeFromParent();
    this._bladeLine  = null;
    this._tipSphere  = null;
    this._trailMesh  = null;
    this._trailGeo   = null;
    this._debugScene = null;
    this.character = null;
    this.combat = null;
  }
}

// The character must be grounded and clear of traversal states to draw the sword
// or swing — otherwise the attack clip would fight hang / wall-run / vault anims.
function isFreeToAct(character) {
  if (!character) {
    return false;
  }

  if (character.hang || character.wallRun || character.wallClimb || character.vault || character.slide || character.rope || character.mount) {
    return false;
  }

  return character.grounded !== false;
}

function normalizedTime(controller) {
  if (typeof controller.getCurrentActionNormalizedTime === 'function') {
    return controller.getCurrentActionNormalizedTime();
  }
  const action = controller.currentAction;
  if (!action) {
    return 0;
  }
  const duration = action.getClip()?.duration ?? 0;
  return duration > 0 ? action.time / duration : 0;
}

function isAttackState(state) {
  const entry = MARA_ANIMATION_MANIFEST[state];
  return Boolean(entry?.combat?.attackKind);
}

function nextComboState(combat) {
  const entry = MARA_ANIMATION_MANIFEST[combat.attack?.name];
  const chain = entry?.combat?.comboChain;
  return Array.isArray(chain) && chain.length > 0 ? chain[0] : null;
}

// Build the bisection plane from the blade's motion at the moment of contact.
// Normal = swingDir × up (a vertical plane across the swing path), with fallbacks
// for near-vertical swings. The plane passes through the enemy's mid-body.
function buildCutPlane({ base, tip, prevTip, enemy }) {
  _swing.subVectors(tip, prevTip);
  if (_swing.lengthSq() < 1e-6) {
    _swing.subVectors(tip, base); // fall back to blade axis if the tip barely moved
  }
  if (_swing.lengthSq() < 1e-6) {
    _swing.set(1, 0, 0);
  }
  _swing.normalize();

  _axis.subVectors(tip, base);
  if (_axis.lengthSq() > 1e-6) {
    _axis.normalize();
  }

  _normal.crossVectors(_swing, UP);
  if (_normal.lengthSq() < 0.01) {
    _normal.crossVectors(_axis, UP);
  }
  if (_normal.lengthSq() < 0.01) {
    _normal.set(1, 0, 0);
  }
  _normal.normalize();

  const ep = enemy.model.position;
  _contact.set(ep.x, ep.y + (enemy.collisionHeight ?? 2) * 0.5, ep.z);

  return new THREE.Plane().setFromNormalAndCoplanarPoint(_normal, _contact);
}

// Closest distance from point p to segment a-b.
function segmentPointDistance(a, b, p) {
  _ab.subVectors(b, a);
  const lenSq = _ab.lengthSq();
  if (lenSq < 1e-9) {
    return p.distanceTo(a);
  }
  const tt = THREE.MathUtils.clamp(_ap.subVectors(p, a).dot(_ab) / lenSq, 0, 1);
  _closest.copy(a).addScaledVector(_ab, tt);
  return p.distanceTo(_closest);
}
