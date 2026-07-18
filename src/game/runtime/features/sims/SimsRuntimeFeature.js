import * as THREE from 'three';

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const groundHit = new THREE.Vector3();

export class SimsRuntimeFeature {
  constructor(host) {
    this.host = host;
    this.active = host.levelMode === 'sims';
    this.frameInput = null;
    this.marker = null;
    this.selectionRing = null;
  }

  async initializeAfterLevel() {
    if (!this.active) return;
    this.host.inputSystem.setPointerLockEnabled(false);
    // Shared runtime still boots Mara for the frame pipeline; park + hide her so
    // she never reads as a distant household NPC (and stay hidden if FP systems
    // later force character.group.visible = true).
    this.parkMainPlayer();
    await this.host.simSystem.initialize({
      scene: this.host.sceneSystem.scene,
      levelSystem: this.host.levelSystem,
    });
    this.host.simCameraSystem.initialize(this.host.cameraSystem.camera);
    this.host.levelSystem.warmupGeometryRaycasts({ maxMs: 100, maxCount: 64 });
    this.createIndicators();
    this.syncIndicators();
  }

  /**
   * Keep the open-world player body off the lot and non-rendered.
   * Safe to call every frame — accessories (wingsuit / jacket) live outside
   * character.group and would otherwise stay visible on their own.
   */
  parkMainPlayer() {
    if (!this.active) return;
    const character = this.host.characterSystem?.character;
    if (!character) return;

    character.hiddenForSims = true;

    const park = this.host.levelSystem?.level?.spawnPoint;
    if (park && character.group) {
      character.group.position.copy(park);
      if (character.velocity?.set) character.velocity.set(0, 0, 0);
      if (typeof character.verticalVelocity === 'number') character.verticalVelocity = 0;
    }

    if (character.group) character.group.visible = false;
    if (character.wingsuitRig?.group) character.wingsuitRig.group.visible = false;
    if (character.proceduralJacket?.group) character.proceduralJacket.group.visible = false;
    // Cloth jacket mesh may be parented under the character or scene root.
    const clothMesh = character.jacketCloth?.mesh ?? character.jacketCloth?.object ?? null;
    if (clothMesh) clothMesh.visible = false;
  }

  prepareInput(input) {
    if (!this.active) return input;
    this.frameInput = input;
    if (input.mousePrimaryPressed) this.handleClick(input.pointerClickNdc);
    return {
      ...input,
      moveX: 0,
      moveZ: 0,
      lookX: 0,
      lookY: 0,
      zoomDelta: 0,
      lightAttackPressed: false,
      heavyAttackPressed: false,
      mousePrimaryHeld: false,
      mouseSecondaryHeld: false,
      mouseMiddleHeld: false,
      jump: false,
      jumpPressed: false,
      brace: false,
      bracePressed: false,
      slide: false,
      slidePressed: false,
      drawSheathePressed: false,
      shoulderThrowPressed: false,
      cutModePressed: false,
      telekinesisPressed: false,
      hookFirePressed: false,
      hookAimHeld: false,
      abilityPressed: false,
      abilityDoubleTapped: false,
      wingsuitTogglePressed: false,
      dodgeDirection: null,
      mountPressed: false,
      gunSlotPressed: null,
    };
  }

  updateActors(delta) {
    if (!this.active) return;
    this.parkMainPlayer();
    this.host.simSystem.update(delta);
    this.syncIndicators();
  }

  updateCamera(delta) {
    if (!this.active) return;
    // Late in the frame (after FP weapon / jacket systems that may re-show Mara).
    this.parkMainPlayer();
    this.host.simCameraSystem.update(delta, this.frameInput ?? {});
  }

  updateGarments(delta) {
    if (!this.active) return;
    this.host.simSystem.updateGarments(delta);
  }

  handleClick(ndc) {
    if (!ndc || !this.host.simSystem.ready) return;
    raycaster.setFromCamera(ndc, this.host.cameraSystem.camera);
    const actor = this.host.simSystem.pick(raycaster.ray);
    if (actor) {
      this.host.simSystem.select(actor.id);
      this.syncIndicators();
      return;
    }

    const hits = this.host.levelSystem.raycastGeometry({
      origin: raycaster.ray.origin,
      direction: raycaster.ray.direction,
      near: 0,
      far: 100,
    });
    const lotHit = hits.find((hit) => /Lot Lawn|Front Walk|Patio/.test(hit.object?.name ?? ''));
    const point = lotHit?.point
      ?? (raycaster.ray.intersectPlane(groundPlane, groundHit) ? groundHit : null);
    if (!point || Math.abs(point.x) > 19 || Math.abs(point.z) > 14) return;
    const goal = point.clone();
    goal.y = this.host.levelSystem.getGroundHeightAt(goal, 0.34, {
      maxStepUp: 0.35,
      maxSnapDown: 1,
    });
    if (this.host.simSystem.setGoal(goal)) {
      this.marker.position.set(goal.x, goal.y + 0.025, goal.z);
      this.marker.visible = true;
    }
  }

  createIndicators() {
    const markerMaterial = new THREE.MeshBasicMaterial({
      color: 0x4dd6ff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.31, 32), markerMaterial);
    this.marker.name = 'Sim Goal Marker';
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    this.host.sceneSystem.scene.add(this.marker);

    this.selectionRing = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.5, 32),
      markerMaterial.clone(),
    );
    this.selectionRing.name = 'Selected Sim Ring';
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.host.sceneSystem.scene.add(this.selectionRing);
  }

  syncIndicators() {
    const selected = this.host.simSystem.selectedActor;
    this.selectionRing?.position.set(
      selected?.group.position.x ?? 0,
      (selected?.group.position.y ?? 0) + 0.02,
      selected?.group.position.z ?? 0,
    );
    if (this.selectionRing) this.selectionRing.visible = Boolean(selected);
    if (this.marker && selected && !selected.goal) this.marker.visible = false;
  }

  snapshot() {
    const actors = this.host.simSystem.snapshot();
    return {
      sims: actors.sims,
      selectedSimId: actors.selectedSimId,
      camera: this.host.simCameraSystem.snapshot(),
    };
  }

  dispose() {
    this.marker?.geometry.dispose();
    this.marker?.material.dispose();
    this.marker?.removeFromParent();
    this.selectionRing?.geometry.dispose();
    this.selectionRing?.material.dispose();
    this.selectionRing?.removeFromParent();
    this.marker = null;
    this.selectionRing = null;
    this.host.simSystem.dispose();
    this.host.simCameraSystem.dispose();
  }
}
