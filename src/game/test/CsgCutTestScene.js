import * as THREE from 'three';
import {
  PCFShadowMap,
  SRGBColorSpace,
  WebGPURenderer,
} from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  clipGeometryByPlane,
  clipGeometryPairByPlane,
  getPlaneInObjectSpace,
  isViableCutGeometry,
  planeCutsGeometry,
} from '../geometry/clipGeometryByPlane.js';
import { bakeSkinnedModelGeometry } from '../geometry/bakeSkinnedModelGeometry.js';
import { createDynamicMeshColliderDesc } from '../physics/createDynamicMeshColliderDesc.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';

const ENEMY_URL = '/assets/models/enemy1.glb';
const ENEMY_TEST_HEIGHT = 2.7;
const ENEMY_ANIMATION_POSE_SECONDS = 0.65;
const BODY_COLOR = 0x4f786c;
const CAP_COLOR = 0xb84a3d;
const HALF_SEPARATION = 0.38;
const PHYSICS_TIMESTEP = 1 / 60;
const PROP_MIN_HALF_EXTENT = 0.035;
const AIM_RANGE_X = 1.15;
const AIM_RANGE_Y = 1.15;
const AIM_SLASH_LENGTH = 2.65;
const AIM_PLANE_SIZE = 3.35;
const RAGDOLL_SIDE_MARGIN = 0.18;
const RAGDOLL_IMPULSE = 0.55;
const RAGDOLL_UPWARD_IMPULSE = 0.22;
const RAGDOLL_MAX_BODIES_PER_HALF = 9;
const DEFAULT_COLLISION_GROUP = 0x0001;
const CUT_RAGDOLL_COLLISION_GROUP = 0x0002;
const CUT_RAGDOLL_WORLD_ONLY_GROUPS = (
  (CUT_RAGDOLL_COLLISION_GROUP << 16)
  | DEFAULT_COLLISION_GROUP
);

const PLANE_PRESETS = {
  vertical: {
    label: 'Vertical',
    x: 0,
    y: 0,
    angle: Math.PI * 0.5,
  },
  diagonal: {
    label: 'Diagonal',
    x: 0,
    y: 0.05,
    angle: Math.PI * 0.72,
  },
  shoulder: {
    label: 'Shoulder',
    x: -0.12,
    y: 0.42,
    angle: Math.PI * 0.18,
  },
};

const cameraRight = new THREE.Vector3();
const cameraUp = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
const aimCenter = new THREE.Vector3();
const aimTangent = new THREE.Vector3();
const aimNormal = new THREE.Vector3();
const aimDragStart = new THREE.Vector2();
const aimDragCurrent = new THREE.Vector2();
const guideMatrix = new THREE.Matrix4();
const tempWorldPosition = new THREE.Vector3();
const tempWorldQuaternion = new THREE.Quaternion();
const tempWorldScale = new THREE.Vector3();
const tempPhysicsPosition = new THREE.Vector3();
const tempPhysicsQuaternion = new THREE.Quaternion();
const tempFollowerPosition = new THREE.Vector3();
const tempFollowerQuaternion = new THREE.Quaternion();
const tempBoneScale = new THREE.Vector3();
const tempParentInverse = new THREE.Matrix4();
const tempWorldMatrix = new THREE.Matrix4();
const tempLocalMatrix = new THREE.Matrix4();

const RAGDOLL_BONE_PATTERN = /^(Hips|Spine_|Head$|Front_Leg_(Shoulder|Upper|Lower|Ankle|Foot)_[LR]$|Back_Leg_(Pelvis|Upper|Lower|Ankle|Foot|Foot_1)_[LR]$|Tail_(Base|Mid|Mid001|End)$)/;

export class CsgCutTestScene {
  constructor({ canvas, onSnapshot } = {}) {
    this.canvas = canvas;
    this.onSnapshot = onSnapshot;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.clock = new THREE.Clock();
    this.RAPIER = null;
    this.physicsWorld = null;
    this.floorBody = null;
    this.physicsSnapshotElapsed = 0;
    this.animationFrame = 0;
    this.resizeObserver = null;
    this.enemyGltf = null;
    this.enemyRoot = null;
    this.enemyMixer = null;
    this.enemyAction = null;
    this.enemyAnimationName = null;
    this.targetMode = 'enemy';
    this.cutProps = [];
    this.rigProps = [];
    this.cutPlane = new THREE.Plane();
    this.cutPlaneHelper = null;
    this.cutSlashGuide = null;
    this.planePreset = 'vertical';
    this.aimPresetLabel = PLANE_PRESETS.vertical.label;
    this.aim = {
      x: 0,
      y: 0,
      angle: Math.PI * 0.5,
      dragging: false,
    };
    this.cutTimePaused = false;
    this.lastSnapshot = null;
    this.pointerHandlers = null;
    this.lastColliderType = null;
    this.lastRenderMode = 'static';
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: BODY_COLOR,
      roughness: 0.68,
      metalness: 0.08,
      envMapIntensity: 0.24,
    });
    this.capMaterial = new THREE.MeshStandardMaterial({
      color: CAP_COLOR,
      roughness: 0.74,
      metalness: 0.02,
      envMapIntensity: 0.18,
    });
  }

  async start() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xd7e2dc);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(3.6, 2.2, 4.6);

    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.localClippingEnabled = true;
    await this.renderer.init();
    await RAPIER.init();
    this.RAPIER = RAPIER;
    this.physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.8, 0);
    this.controls.minDistance = 2.4;
    this.controls.maxDistance = 8;

    this.setupScene();
    await this.loadEnemyTarget();
    this.reset();
    this.installAimHandlers();
    this.installResizeObserver();
    this.resize();
    this.renderFrame();
  }

  dispose() {
    cancelAnimationFrame(this.animationFrame);
    this.removeAimHandlers();
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    this.clearCutProps();
    this.clearRigProps();
    if (this.enemyRoot) {
      this.scene?.remove(this.enemyRoot);
      disposeObject3D(this.enemyRoot);
    }
    this.enemyRoot = null;
    this.enemyMixer = null;
    this.enemyAction = null;
    this.cutPlaneHelper?.geometry?.dispose();
    this.cutSlashGuide?.geometry?.dispose();
    this.bodyMaterial.dispose();
    this.capMaterial.dispose();
    this.physicsWorld?.free?.();
    this.physicsWorld = null;
    this.renderer?.dispose();
  }

  reset() {
    this.clearCutProps();
    this.clearRigProps();
    this.physicsSnapshotElapsed = 0;

    if (!this.enemyRoot) {
      this.createProxyTarget();
    }

    this.enemyRoot.visible = true;
    this.cutTimePaused = false;
    this.enemyMixer?.stopAllAction();
    this.enemyAction?.reset().play();
    this.enemyMixer?.setTime(ENEMY_ANIMATION_POSE_SECONDS);
    this.enemyRoot.updateMatrixWorld(true);
    this.applyAimPreset(this.planePreset);
    this.updateCutPlane();

    const baked = this.bakeCurrentTarget();
    const sourceVertices = baked?.geometry.getAttribute('position').count ?? 0;
    const planeCutsSource = baked ? planeCutsGeometry(baked.geometry, this.cutPlane) : false;

    this.updateSnapshot({
      phase: 5,
      status: 'ready',
      mode: 'live',
      target: this.targetMode,
      animation: this.enemyAnimationName,
      bakedMeshes: baked?.meshCount ?? 0,
      skinnedMeshes: baked?.skinnedMeshCount ?? 0,
      texture: baked?.hasTexture ? 'yes' : 'no',
      preset: this.aimPresetLabel,
      aimAngle: Number(THREE.MathUtils.radToDeg(this.aim.angle).toFixed(1)),
      sourceVertices,
      planeCutsSource,
      physics: 'ready',
      propCount: 0,
      rigMeshes: 0,
      ragdollBodies: 0,
      ragdollJoints: 0,
      ragdollMotion: 0,
      lowestPropY: null,
      collider: this.lastColliderType,
      renderMode: this.lastRenderMode,
      positiveVertices: 0,
      negativeVertices: 0,
      positiveGroups: 0,
      negativeGroups: 0,
      viable: false,
    });

    baked?.geometry.dispose();
  }

  setPlanePreset(name) {
    if (!PLANE_PRESETS[name]) {
      return;
    }

    this.planePreset = name;
    this.applyAimPreset(name);
    this.updateCutPlane();

    if (!this.cutProps.length && !this.rigProps.length) {
      const baked = this.bakeCurrentTarget();

      this.updateSnapshot({
        ...this.lastSnapshot,
        preset: this.aimPresetLabel,
        aimAngle: Number(THREE.MathUtils.radToDeg(this.aim.angle).toFixed(1)),
        sourceVertices: baked?.geometry.getAttribute('position').count ?? this.lastSnapshot?.sourceVertices ?? 0,
        bakedMeshes: baked?.meshCount ?? this.lastSnapshot?.bakedMeshes ?? 0,
        skinnedMeshes: baked?.skinnedMeshCount ?? this.lastSnapshot?.skinnedMeshes ?? 0,
        texture: baked?.hasTexture ? 'yes' : this.lastSnapshot?.texture ?? 'no',
        planeCutsSource: baked ? planeCutsGeometry(baked.geometry, this.cutPlane) : false,
      });

      baked?.geometry.dispose();
    }
  }

  cut() {
    if (!this.enemyRoot || this.cutProps.length || this.rigProps.length) {
      return;
    }

    const baked = this.bakeCurrentTarget();
    const sourceGeometry = baked?.geometry;

    if (!sourceGeometry) {
      this.updateSnapshot({
        ...this.lastSnapshot,
        status: 'failed',
        viable: false,
      });
      return;
    }

    const planeCutsSource = planeCutsGeometry(sourceGeometry, this.cutPlane);
    const halves = planeCutsSource
      ? clipGeometryPairByPlane(sourceGeometry, this.cutPlane)
      : null;

    sourceGeometry.dispose();

    if (!halves) {
      this.updateSnapshot({
        ...this.lastSnapshot,
        status: 'failed',
        planeCutsSource,
        viable: false,
      });
      return;
    }

    const positiveViable = isViableCutGeometry(halves.positive);
    const negativeViable = isViableCutGeometry(halves.negative);
    const positiveVertices = halves.positive.getAttribute('position').count;
    const negativeVertices = halves.negative.getAttribute('position').count;
    const positiveGroups = halves.positive.groups.length;
    const negativeGroups = halves.negative.groups.length;
    const positiveBodyMaterial = cloneCutBodyMaterial(baked.material);
    const negativeBodyMaterial = cloneCutBodyMaterial(baked.material);
    this.physicsSnapshotElapsed = 0;
    const rigProps = this.createClippedRigProps({
      plane: this.cutPlane,
      halves,
      positiveBodyMaterial,
      negativeBodyMaterial,
    });
    this.enemyRoot.visible = false;

    if (rigProps) {
      positiveBodyMaterial?.dispose();
      negativeBodyMaterial?.dispose();
      this.rigProps.push(...rigProps);
      this.scene.add(...rigProps.map((prop) => prop.root));
      this.lastRenderMode = 'skinnedRagdoll';
    } else {
      const positiveProp = this.createDynamicHalfProp(halves.positive, 1, {
        bodyMaterial: positiveBodyMaterial ?? this.bodyMaterial,
        ownsBodyMaterial: Boolean(positiveBodyMaterial),
      });
      const negativeProp = this.createDynamicHalfProp(halves.negative, -1, {
        bodyMaterial: negativeBodyMaterial ?? this.bodyMaterial,
        ownsBodyMaterial: Boolean(negativeBodyMaterial),
      });

      this.cutProps.push(positiveProp, negativeProp);
      this.scene.add(positiveProp.mesh, negativeProp.mesh);
      this.lastRenderMode = 'staticChunks';
    }

    this.updateSnapshot({
      phase: 5,
      status: positiveViable && negativeViable ? 'passed' : 'nonviable',
      mode: 'released',
      target: this.targetMode,
      animation: this.enemyAnimationName,
      bakedMeshes: baked.meshCount,
      skinnedMeshes: baked.skinnedMeshCount,
      texture: baked.hasTexture ? 'yes' : 'no',
      preset: this.aimPresetLabel,
      aimAngle: Number(THREE.MathUtils.radToDeg(this.aim.angle).toFixed(1)),
      sourceVertices: baked.vertexCount,
      planeCutsSource,
      physics: 'dynamic',
      propCount: this.cutProps.length + this.rigProps.length,
      rigMeshes: this.countVisibleRigMeshes(),
      ragdollBodies: this.countRagdollBodies(),
      ragdollJoints: this.countRagdollJoints(),
      ragdollMotion: this.getRagdollMotion(),
      lowestPropY: this.getLowestPropY(),
      collider: this.lastColliderType,
      renderMode: this.lastRenderMode,
      positiveVertices,
      negativeVertices,
      positiveGroups,
      negativeGroups,
      viable: positiveViable && negativeViable,
    });
  }

  setupScene() {
    const hemi = new THREE.HemisphereLight(0xf5f0df, 0x5d6c68, 2.1);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.8);
    key.position.set(4, 7, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 5;
    key.shadow.camera.bottom = -5;
    this.scene.add(key);

    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x7f918a,
      roughness: 0.82,
      metalness: 0,
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(7, 0.05, 7), floorMaterial);
    floor.position.y = -0.035;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.createPhysicsFloor();

    const grid = new THREE.GridHelper(7, 14, 0x46635c, 0x9aaca5);
    grid.position.y = 0.002;
    grid.material.transparent = true;
    grid.material.opacity = 0.38;
    this.scene.add(grid);

    this.cutPlaneHelper = new THREE.Mesh(
      new THREE.PlaneGeometry(AIM_PLANE_SIZE, AIM_PLANE_SIZE),
      new THREE.MeshBasicMaterial({
        color: 0xf0c463,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.cutPlaneHelper.renderOrder = 4;
    this.scene.add(this.cutPlaneHelper);

    this.cutSlashGuide = new THREE.Mesh(
      new THREE.BoxGeometry(AIM_SLASH_LENGTH, 0.035, 0.045),
      new THREE.MeshBasicMaterial({
        color: 0xfff0a6,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      }),
    );
    this.cutSlashGuide.renderOrder = 5;
    this.scene.add(this.cutSlashGuide);
  }

  async loadEnemyTarget() {
    try {
      const loader = new GLTFLoader();
      this.enemyGltf = await loader.loadAsync(ENEMY_URL);
      this.enemyRoot = cloneSkeleton(this.enemyGltf.scene);
      this.enemyRoot.name = 'cut-test-enemy';
      prepareTargetAsset(this.enemyRoot);
      normalizeToHeight(this.enemyRoot, ENEMY_TEST_HEIGHT);
      this.enemyRoot.rotation.y = Math.PI * 0.08;
      this.scene.add(this.enemyRoot);

      this.enemyMixer = new THREE.AnimationMixer(this.enemyRoot);
      const clip = findPreferredClip(this.enemyGltf.animations);

      if (clip) {
        this.enemyAnimationName = clip.name;
        this.enemyAction = this.enemyMixer.clipAction(clip);
        this.enemyAction.enabled = true;
        this.enemyAction.setEffectiveWeight(1);
        this.enemyAction.play();
        this.enemyMixer.update(ENEMY_ANIMATION_POSE_SECONDS);
      } else {
        this.enemyAnimationName = 'none';
      }

      this.targetMode = 'enemy';
    } catch (error) {
      console.warn('Cut Lab enemy target failed to load; falling back to proxy.', error);
      this.createProxyTarget();
    }
  }

  createProxyTarget() {
    if (this.enemyRoot) {
      this.scene.remove(this.enemyRoot);

      if (this.targetMode === 'proxy') {
        this.enemyRoot.geometry?.dispose();
      } else {
        disposeObject3D(this.enemyRoot);
      }
    }

    const geometry = new THREE.CapsuleGeometry(0.58, 1.45, 18, 32);
    geometry.rotateX(Math.PI * 0.5);
    geometry.rotateZ(Math.PI * 0.5);
    geometry.translate(0, 0.98, 0);
    geometry.computeVertexNormals();

    this.enemyRoot = new THREE.Mesh(geometry, this.bodyMaterial);
    this.enemyRoot.name = 'cut-test-proxy';
    this.enemyRoot.castShadow = true;
    this.enemyRoot.receiveShadow = true;
    this.scene.add(this.enemyRoot);
    this.enemyMixer = null;
    this.enemyAction = null;
    this.enemyAnimationName = 'none';
    this.targetMode = 'proxy';
  }

  bakeCurrentTarget() {
    if (!this.enemyRoot) {
      return null;
    }

    this.enemyRoot.updateMatrixWorld(true);
    return bakeSkinnedModelGeometry(this.enemyRoot);
  }

  applyAimPreset(name) {
    const preset = PLANE_PRESETS[name] ?? PLANE_PRESETS.vertical;

    this.aim.x = preset.x;
    this.aim.y = preset.y;
    this.aim.angle = preset.angle;
    this.aimPresetLabel = preset.label;
  }

  updateCutPlane() {
    this.resolveAimBasis();
    aimCenter.copy(this.controls?.target ?? new THREE.Vector3(0, 0.8, 0))
      .addScaledVector(cameraRight, this.aim.x)
      .addScaledVector(cameraUp, this.aim.y);
    aimTangent.copy(cameraRight)
      .multiplyScalar(Math.cos(this.aim.angle))
      .addScaledVector(cameraUp, Math.sin(this.aim.angle))
      .normalize();
    aimNormal.crossVectors(aimTangent, cameraForward).normalize();

    if (aimNormal.lengthSq() < 0.0001) {
      aimNormal.copy(cameraRight);
    }

    this.cutPlane.setFromNormalAndCoplanarPoint(aimNormal, aimCenter);
    this.positionCutGuide({ center: aimCenter, tangent: aimTangent, normal: aimNormal });
  }

  resolveAimBasis() {
    this.camera.updateMatrixWorld(true);
    cameraRight.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    cameraUp.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    this.camera.getWorldDirection(cameraForward).normalize();
  }

  createDynamicHalfProp(geometry, sideSign, { bodyMaterial = this.bodyMaterial, ownsBodyMaterial = false } = {}) {
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const position = center.clone().add(
      this.cutPlane.normal.clone().multiplyScalar(HALF_SEPARATION * sideSign),
    );

    geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, [bodyMaterial, this.capMaterial]);

    mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const body = this.physicsWorld.createRigidBody(
      this.RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setLinvel(
          this.cutPlane.normal.x * sideSign * 1.55,
          1.15,
          this.cutPlane.normal.z * sideSign * 1.55,
        )
        .setAngvel({
          x: 1.4 + Math.abs(this.cutPlane.normal.z) * 1.2,
          y: sideSign * 2.2,
          z: -1.1 - Math.abs(this.cutPlane.normal.x) * 1.2,
        })
        .setLinearDamping(0.08)
        .setAngularDamping(0.16),
    );
    const colliderResult = createDynamicMeshColliderDesc({
      RAPIER: this.RAPIER,
      geometry,
      fallbackSize: size,
      minHalfExtent: PROP_MIN_HALF_EXTENT,
      mode: 'compound',
    });

    for (const desc of colliderResult.descs) {
      this.physicsWorld.createCollider(
        desc.setDensity(1.35).setFriction(0.82).setRestitution(0.08),
        body,
      );
    }
    this.lastColliderType = colliderResult.type;
    return { mesh, body, ownedMaterials: ownsBodyMaterial ? [bodyMaterial] : [] };
  }

  createClippedRigProps({
    plane,
    halves,
    positiveBodyMaterial,
    negativeBodyMaterial,
  }) {
    if (this.targetMode !== 'enemy' || !this.enemyRoot?.isObject3D) {
      return null;
    }

    const positive = this.createClippedRigProp({
      sourceGeometry: halves.positive,
      sideSign: 1,
      plane,
      bodyMaterial: positiveBodyMaterial,
    });
    const negative = this.createClippedRigProp({
      sourceGeometry: halves.negative,
      sideSign: -1,
      plane,
      bodyMaterial: negativeBodyMaterial,
    });

    halves.positive.dispose();
    halves.negative.dispose();

    if (!positive || !negative) {
      positive && this.disposeRigProp(positive);
      negative && this.disposeRigProp(negative);
      return null;
    }

    return [positive, negative];
  }

  createClippedRigProp({
    sourceGeometry,
    sideSign,
    plane,
    bodyMaterial,
  }) {
    const rigRoot = cloneSkeleton(this.enemyRoot);
    const root = new THREE.Group();
    const ownedMaterials = [];
    const ownedGeometries = [];
    const clippedSkinnedMeshes = [];

    root.name = sideSign > 0 ? 'cut-test-positive-rig-half' : 'cut-test-negative-rig-half';
    root.visible = true;
    rigRoot.visible = true;
    rigRoot.updateMatrixWorld(true);
    rigRoot.traverse((child) => {
      if (!child.isMesh && !child.isSkinnedMesh) {
        return;
      }

      const localPlane = getPlaneInObjectSpace(plane, child);
      const clippedGeometry = clipGeometryByPlane(child.geometry, localPlane, sideSign, {
        includeCap: true,
      });

      if (!clippedGeometry) {
        child.visible = false;
        return;
      }

      child.geometry = clippedGeometry;
      child.visible = true;
      child.castShadow = true;
      child.receiveShadow = true;
      child.frustumCulled = false;
      child.material = cloneRigMaterials(child.material, ownedMaterials, {
        includeCap: clippedGeometry.groups.some((group) => group.materialIndex === 1),
      });
      ownedGeometries.push(clippedGeometry);

      if (child.isSkinnedMesh) {
        clippedSkinnedMeshes.push(child);
      }
    });

    const bodyOffset = plane.normal.clone().multiplyScalar(HALF_SEPARATION * sideSign);
    rigRoot.position.add(bodyOffset);
    root.add(rigRoot);

    const ragdoll = this.createRigHalfRagdoll({
      rigRoot,
      plane,
      sideSign,
      bodyOffset,
    });

    if (!ragdoll.bodies.length) {
      return null;
    }

    const ragdollFollowers = createSkinnedBoneFollowers({
      meshes: clippedSkinnedMeshes,
      records: ragdoll.bodies,
    });

    this.lastColliderType = 'skinnedRagdoll';
    return {
      root,
      rigRoot,
      ragdollBodies: ragdoll.bodies,
      ragdollJoints: ragdoll.joints,
      ragdollFollowers,
      ownedMaterials,
      ownedGeometries,
    };
  }

  createRigHalfRagdoll({ rigRoot, plane, sideSign, bodyOffset }) {
    const bones = collectRagdollBones({
      rigRoot,
      plane,
      sideSign,
      bodyOffset,
    });
    const records = [];
    const recordByBone = new Map();
    const joints = [];

    for (const bone of bones) {
      bone.getWorldPosition(tempWorldPosition);
      bone.getWorldQuaternion(tempWorldQuaternion);

      const radius = getRagdollBoneRadius(bone.name);
      const body = this.physicsWorld.createRigidBody(
        this.RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(tempWorldPosition.x, tempWorldPosition.y, tempWorldPosition.z)
          .setRotation({
            x: tempWorldQuaternion.x,
            y: tempWorldQuaternion.y,
            z: tempWorldQuaternion.z,
            w: tempWorldQuaternion.w,
          })
          .setLinvel(
            plane.normal.x * sideSign * RAGDOLL_IMPULSE,
            RAGDOLL_UPWARD_IMPULSE,
            plane.normal.z * sideSign * RAGDOLL_IMPULSE,
          )
          .setAngvel({
            x: 0.12 + Math.abs(plane.normal.z) * 0.35,
            y: sideSign * 0.35,
            z: -0.12 - Math.abs(plane.normal.x) * 0.35,
          })
          .setLinearDamping(0.7)
          .setAngularDamping(0.88),
      );

      this.physicsWorld.createCollider(
        this.RAPIER.ColliderDesc.ball(radius)
          .setDensity(getRagdollBoneDensity(bone.name))
          .setFriction(0.94)
          .setRestitution(0)
          .setCollisionGroups(CUT_RAGDOLL_WORLD_ONLY_GROUPS),
        body,
      );

      const record = {
        bone,
        body,
        radius,
        initialPosition: tempWorldPosition.clone(),
        initialQuaternion: tempWorldQuaternion.clone(),
      };

      records.push(record);
      recordByBone.set(bone, record);
    }

    for (const record of records) {
      const parentRecord = findNearestRagdollParent(record.bone, recordByBone);

      if (!parentRecord) {
        continue;
      }

      const anchorWorld = record.initialPosition;
      const parentAnchor = worldPointToBodyLocal({
        point: anchorWorld,
        bodyPosition: parentRecord.initialPosition,
        bodyQuaternion: parentRecord.initialQuaternion,
      });
      const childAnchor = worldPointToBodyLocal({
        point: anchorWorld,
        bodyPosition: record.initialPosition,
        bodyQuaternion: record.initialQuaternion,
      });

      joints.push(
        this.physicsWorld.createImpulseJoint(
          this.RAPIER.JointData.spherical(parentAnchor, childAnchor),
          parentRecord.body,
          record.body,
          true,
        ),
      );
    }

    return { bodies: records, joints };
  }

  clearCutProps() {
    for (const prop of this.cutProps) {
      this.scene?.remove(prop.mesh);
      prop.mesh.geometry.dispose();
      prop.ownedMaterials?.forEach((material) => material.dispose());

      if (this.physicsWorld && prop.body) {
        this.physicsWorld.removeRigidBody(prop.body);
      }
    }

    this.cutProps = [];

    if (this.enemyRoot) {
      this.enemyRoot.visible = true;
    }
  }

  clearRigProps() {
    for (const prop of this.rigProps) {
      this.scene?.remove(prop.root);
      this.disposeRigProp(prop);
    }

    this.rigProps = [];
  }

  disposeRigProp(prop) {
    prop.ownedMaterials?.forEach((material) => material.dispose());
    prop.ownedGeometries?.forEach((geometry) => geometry.dispose());

    if (!this.physicsWorld) {
      return;
    }

    for (const joint of prop.ragdollJoints ?? []) {
      this.physicsWorld.removeImpulseJoint(joint, true);
    }

    for (const record of prop.ragdollBodies ?? []) {
      this.physicsWorld.removeRigidBody(record.body);
    }
  }

  installAimHandlers() {
    const onPointerDown = (event) => {
      if (this.cutProps.length || this.rigProps.length || !this.enemyRoot) {
        return;
      }

      this.aim.dragging = true;
      this.cutTimePaused = true;
      this.controls.enabled = false;
      this.canvas.setPointerCapture?.(event.pointerId);
      aimDragStart.set(event.clientX, event.clientY);
      aimDragCurrent.copy(aimDragStart);
      this.updateAimFromPointer(event, { useDragAngle: false });
    };
    const onPointerMove = (event) => {
      if (!this.aim.dragging) {
        return;
      }

      this.updateAimFromPointer(event, { useDragAngle: true });
    };
    const onPointerUp = (event) => {
      if (!this.aim.dragging) {
        return;
      }

      this.aim.dragging = false;
      this.controls.enabled = true;
      this.canvas.releasePointerCapture?.(event.pointerId);
      this.refreshAimSnapshot();
    };

    this.canvas.addEventListener('pointerdown', onPointerDown);
    this.canvas.addEventListener('pointermove', onPointerMove);
    this.canvas.addEventListener('pointerup', onPointerUp);
    this.canvas.addEventListener('pointercancel', onPointerUp);
    this.pointerHandlers = {
      onPointerDown,
      onPointerMove,
      onPointerUp,
    };
  }

  removeAimHandlers() {
    if (!this.pointerHandlers) {
      return;
    }

    this.canvas.removeEventListener('pointerdown', this.pointerHandlers.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.pointerHandlers.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.pointerHandlers.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.pointerHandlers.onPointerUp);
    this.pointerHandlers = null;
  }

  updateAimFromPointer(event, { useDragAngle }) {
    const rect = this.canvas.getBoundingClientRect();
    const normalizedX = ((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2;
    const normalizedY = (0.5 - (event.clientY - rect.top) / Math.max(1, rect.height)) * 2;

    this.aim.x = THREE.MathUtils.clamp(normalizedX * AIM_RANGE_X, -AIM_RANGE_X, AIM_RANGE_X);
    this.aim.y = THREE.MathUtils.clamp(normalizedY * AIM_RANGE_Y, -AIM_RANGE_Y, AIM_RANGE_Y);
    aimDragCurrent.set(event.clientX, event.clientY);

    if (useDragAngle) {
      const dx = aimDragCurrent.x - aimDragStart.x;
      const dy = aimDragStart.y - aimDragCurrent.y;

      if (Math.hypot(dx, dy) > 8) {
        this.aim.angle = Math.atan2(dy, dx);
      }
    }

    this.aimPresetLabel = 'Custom';
    this.updateCutPlane();
    this.refreshAimSnapshot();
  }

  refreshAimSnapshot() {
    if (this.cutProps.length || this.rigProps.length || !this.lastSnapshot) {
      return;
    }

    const baked = this.bakeCurrentTarget();

    this.updateSnapshot({
      ...this.lastSnapshot,
      mode: this.aim.dragging ? 'aiming' : 'paused',
      preset: this.aimPresetLabel,
      aimAngle: Number(THREE.MathUtils.radToDeg(this.aim.angle).toFixed(1)),
      sourceVertices: baked?.geometry.getAttribute('position').count ?? this.lastSnapshot.sourceVertices,
      bakedMeshes: baked?.meshCount ?? this.lastSnapshot.bakedMeshes,
      skinnedMeshes: baked?.skinnedMeshCount ?? this.lastSnapshot.skinnedMeshes,
      texture: baked?.hasTexture ? 'yes' : this.lastSnapshot.texture,
      planeCutsSource: baked ? planeCutsGeometry(baked.geometry, this.cutPlane) : false,
    });

    baked?.geometry.dispose();
  }

  createPhysicsFloor() {
    if (!this.physicsWorld) {
      return;
    }

    this.floorBody = this.physicsWorld.createRigidBody(
      this.RAPIER.RigidBodyDesc.fixed(),
    );
    this.physicsWorld.createCollider(
      this.RAPIER.ColliderDesc.cuboid(3.5, 0.025, 3.5)
        .setTranslation(0, -0.035, 0)
        .setFriction(0.92)
        .setRestitution(0),
      this.floorBody,
    );
  }

  stepPhysics(delta) {
    if (!this.physicsWorld || (!this.cutProps.length && !this.rigProps.length)) {
      return;
    }

    this.physicsWorld.timestep = Math.min(PHYSICS_TIMESTEP, delta);
    this.physicsWorld.step();

    for (const prop of this.cutProps) {
      const translation = prop.body.translation();
      const rotation = prop.body.rotation();

      prop.mesh.position.set(translation.x, translation.y, translation.z);
      prop.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }

    for (const prop of this.rigProps) {
      this.syncRagdollProp(prop);
    }

    this.physicsSnapshotElapsed += delta;

    if (this.physicsSnapshotElapsed >= 0.25) {
      this.physicsSnapshotElapsed = 0;
      this.updateSnapshot({
        ...this.lastSnapshot,
        propCount: this.cutProps.length + this.rigProps.length,
        rigMeshes: this.countVisibleRigMeshes(),
        ragdollBodies: this.countRagdollBodies(),
        ragdollJoints: this.countRagdollJoints(),
        ragdollMotion: this.getRagdollMotion(),
        lowestPropY: this.getLowestPropY(),
      });
    }
  }

  syncRagdollProp(prop) {
    const drivenTargets = [];

    for (const record of prop.ragdollBodies ?? []) {
      const translation = record.body.translation();
      const rotation = record.body.rotation();

      drivenTargets.push({
        bone: record.bone,
        position: new THREE.Vector3(translation.x, translation.y, translation.z),
        quaternion: new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
      });
    }

    for (const follower of prop.ragdollFollowers ?? []) {
      const translation = follower.record.body.translation();
      const rotation = follower.record.body.rotation();

      tempPhysicsPosition.set(translation.x, translation.y, translation.z);
      tempPhysicsQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      tempFollowerPosition.copy(follower.localPosition)
        .applyQuaternion(tempPhysicsQuaternion)
        .add(tempPhysicsPosition);
      tempFollowerQuaternion.copy(tempPhysicsQuaternion).multiply(follower.localQuaternion);

      drivenTargets.push({
        bone: follower.bone,
        position: tempFollowerPosition.clone(),
        quaternion: tempFollowerQuaternion.clone(),
      });
    }

    drivenTargets
      .sort((a, b) => getBoneDepth(a.bone) - getBoneDepth(b.bone))
      .forEach((target) => setBoneWorldTransform(target));

    prop.rigRoot?.updateMatrixWorld(true);
  }

  getLowestPropY() {
    if (!this.cutProps.length && !this.rigProps.length) {
      return null;
    }

    let lowest = Infinity;

    for (const prop of this.cutProps) {
      const translation = prop.body.translation();
      lowest = Math.min(lowest, translation.y);
    }

    for (const prop of this.rigProps) {
      for (const record of prop.ragdollBodies ?? []) {
        const translation = record.body.translation();
        lowest = Math.min(lowest, translation.y - record.radius);
      }
    }

    return Number(lowest.toFixed(3));
  }

  countVisibleRigMeshes() {
    let count = 0;

    for (const prop of this.rigProps) {
      if (!prop.root.visible) {
        continue;
      }

      prop.root.traverse((child) => {
        if ((child.isMesh || child.isSkinnedMesh) && child.visible) {
          count += 1;
        }
      });
    }

    return count;
  }

  countRagdollBodies() {
    return this.rigProps.reduce((count, prop) => count + (prop.ragdollBodies?.length ?? 0), 0);
  }

  countRagdollJoints() {
    return this.rigProps.reduce((count, prop) => count + (prop.ragdollJoints?.length ?? 0), 0);
  }

  getRagdollMotion() {
    let maxDistance = 0;

    for (const prop of this.rigProps) {
      for (const record of prop.ragdollBodies ?? []) {
        const translation = record.body.translation();
        maxDistance = Math.max(
          maxDistance,
          record.initialPosition.distanceTo(tempWorldPosition.set(
            translation.x,
            translation.y,
            translation.z,
          )),
        );
      }
    }

    return Number(maxDistance.toFixed(3));
  }

  positionCutGuide({ center, tangent, normal }) {
    const guideUp = normal.clone().cross(tangent).normalize();

    guideMatrix.makeBasis(tangent, guideUp, normal);

    if (this.cutPlaneHelper) {
      this.cutPlaneHelper.position.copy(center);
      this.cutPlaneHelper.quaternion.setFromRotationMatrix(guideMatrix);
    }

    if (this.cutSlashGuide) {
      this.cutSlashGuide.position.copy(center);
      this.cutSlashGuide.quaternion.setFromRotationMatrix(guideMatrix);
    }
  }

  installResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  resize() {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  renderFrame = () => {
    const delta = this.clock.getDelta();

    if (this.enemyMixer && this.enemyRoot?.visible && !this.cutProps.length && !this.rigProps.length && !this.cutTimePaused) {
      this.enemyMixer.update(delta);
    }

    if (!this.cutProps.length && !this.rigProps.length) {
      this.updateCutPlane();
    }

    this.stepPhysics(delta);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  };

  updateSnapshot(snapshot) {
    this.lastSnapshot = snapshot;
    this.onSnapshot?.(snapshot);
  }
}

function findPreferredClip(clips = []) {
  const preferredNames = ['Run', 'Idle Alert', 'Bite', 'Walk', 'Idle'];

  for (const name of preferredNames) {
    const clip = clips.find((candidate) => candidate.name === name);

    if (clip) {
      return clip;
    }
  }

  return clips[0] ?? null;
}

function cloneCutBodyMaterial(material) {
  if (!material || typeof material.clone !== 'function') {
    return null;
  }

  const clone = material.clone();

  if ('skinning' in clone) {
    clone.skinning = false;
  }

  clone.needsUpdate = true;
  return clone;
}

function cloneRigMaterials(material, ownedMaterials, { includeCap = false } = {}) {
  const primary = Array.isArray(material)
    ? material[0]
    : material;

  if (includeCap) {
    return [
      cloneRigMaterial(primary, ownedMaterials),
      cloneCutSocketMaterial(primary, ownedMaterials),
    ];
  }

  if (Array.isArray(material)) {
    return material.map((entry) => cloneRigMaterial(entry, ownedMaterials));
  }

  return cloneRigMaterial(material, ownedMaterials);
}

function cloneRigMaterial(material, ownedMaterials) {
  const clone = material?.clone?.() ?? new THREE.MeshStandardMaterial({ color: BODY_COLOR });

  if ('skinning' in clone) {
    clone.skinning = true;
  }

  clone.needsUpdate = true;
  ownedMaterials.push(clone);
  return clone;
}

function cloneCutSocketMaterial(material, ownedMaterials) {
  const clone = material?.clone?.() ?? new THREE.MeshStandardMaterial({ color: 0x353b38 });

  if ('skinning' in clone) {
    clone.skinning = true;
  }

  if (clone.map) {
    clone.map = clone.map.clone();
    clone.map.wrapS = THREE.RepeatWrapping;
    clone.map.wrapT = THREE.RepeatWrapping;
    clone.map.repeat.set(3.3, 2.1);
    clone.map.offset.set(0.37, 0.19);
    clone.map.rotation = Math.PI * 0.31;
    clone.map.center.set(0.5, 0.5);
    clone.map.needsUpdate = true;
  }

  if ('color' in clone) {
    clone.color.multiplyScalar(0.72);
    clone.color.offsetHSL(0.03, -0.12, -0.06);
  }

  if ('metalness' in clone) {
    clone.metalness = Math.max(clone.metalness ?? 0, 0.38);
  }

  if ('roughness' in clone) {
    clone.roughness = Math.min(Math.max(clone.roughness ?? 0.5, 0.42), 0.68);
  }

  clone.name = `${material?.name ?? 'cut'} socket`;
  clone.needsUpdate = true;
  ownedMaterials.push(clone);
  return clone;
}

function createSkinnedBoneFollowers({ meshes, records }) {
  if (!meshes?.length || !records?.length) {
    return [];
  }

  const simulatedBones = new Set(records.map((record) => record.bone));
  const recordByBone = new Map(records.map((record) => [record.bone, record]));
  const usedBones = new Set();

  for (const mesh of meshes) {
    const skinIndex = mesh.geometry?.getAttribute('skinIndex');
    const skinWeight = mesh.geometry?.getAttribute('skinWeight');
    const bones = mesh.skeleton?.bones ?? [];

    if (!skinIndex || !skinWeight || !bones.length) {
      continue;
    }

    const vertexCount = Math.min(skinIndex.count, skinWeight.count);

    for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
      for (let slot = 0; slot < 4; slot += 1) {
        const weight = skinWeight.getComponent(vertexIndex, slot);

        if (!Number.isFinite(weight) || weight <= 0.00001) {
          continue;
        }

        const bone = bones[Math.round(skinIndex.getComponent(vertexIndex, slot))];

        if (bone && !simulatedBones.has(bone)) {
          usedBones.add(bone);
        }
      }
    }
  }

  const followers = [];

  for (const bone of usedBones) {
    const record = findNearestRagdollParent(bone, recordByBone)
      ?? findNearestRagdollRecord(bone, records);

    if (!record) {
      continue;
    }

    bone.getWorldPosition(tempWorldPosition);
    bone.getWorldQuaternion(tempWorldQuaternion);
    followers.push({
      bone,
      record,
      localPosition: worldPointToBodyLocal({
        point: tempWorldPosition,
        bodyPosition: record.initialPosition,
        bodyQuaternion: record.initialQuaternion,
      }),
      localQuaternion: record.initialQuaternion.clone().invert().multiply(tempWorldQuaternion),
    });
  }

  return followers;
}

function collectRagdollBones({
  rigRoot,
  plane,
  sideSign,
  bodyOffset,
}) {
  const candidates = [];

  rigRoot.updateMatrixWorld(true);
  rigRoot.traverse((object) => {
    if (!object.isBone || !RAGDOLL_BONE_PATTERN.test(object.name)) {
      return;
    }

    object.getWorldPosition(tempWorldPosition);
    const unoffsetPosition = tempWorldPosition.clone().sub(bodyOffset);
    const signedDistance = plane.distanceToPoint(unoffsetPosition) * sideSign;

    candidates.push({
      bone: object,
      signedDistance,
      priority: getRagdollBonePriority(object.name),
    });
  });

  const selected = candidates
    .filter((entry) => entry.signedDistance >= -RAGDOLL_SIDE_MARGIN)
    .sort((a, b) => b.priority - a.priority || b.signedDistance - a.signedDistance)
    .slice(0, RAGDOLL_MAX_BODIES_PER_HALF)
    .map((entry) => entry.bone);

  if (selected.length >= 3) {
    return selected;
  }

  return candidates
    .sort((a, b) => b.signedDistance - a.signedDistance)
    .slice(0, Math.min(6, RAGDOLL_MAX_BODIES_PER_HALF))
    .map((entry) => entry.bone);
}

function getRagdollBonePriority(name) {
  if (name === 'Hips') return 10;
  if (/^Spine_/.test(name)) return 9;
  if (name === 'Head') return 8;
  if (/(Shoulder|Pelvis|Upper)/.test(name)) return 7;
  if (/(Lower|Ankle)/.test(name)) return 6;
  if (/Foot/.test(name)) return 5;
  if (/Tail/.test(name)) return 4;
  return 1;
}

function getRagdollBoneRadius(name) {
  if (name === 'Hips') return 0.2;
  if (/^Spine_/.test(name)) return 0.18;
  if (name === 'Head') return 0.16;
  if (/(Shoulder|Pelvis|Upper)/.test(name)) return 0.135;
  if (/(Lower|Ankle)/.test(name)) return 0.105;
  if (/Foot/.test(name)) return 0.12;
  if (/Tail/.test(name)) return 0.075;
  return 0.1;
}

function getRagdollBoneDensity(name) {
  if (name === 'Hips' || /^Spine_/.test(name)) return 1.35;
  if (/(Shoulder|Pelvis|Upper)/.test(name)) return 1.05;
  return 0.85;
}

function findNearestRagdollParent(bone, recordByBone) {
  let current = bone.parent;

  while (current) {
    const record = recordByBone.get(current);

    if (record) {
      return record;
    }

    current = current.parent;
  }

  return null;
}

function findNearestRagdollRecord(bone, records) {
  bone.getWorldPosition(tempWorldPosition);
  let nearest = null;
  let nearestDistance = Infinity;

  for (const record of records) {
    const distance = tempWorldPosition.distanceToSquared(record.initialPosition);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = record;
    }
  }

  return nearest;
}

function getBoneDepth(bone) {
  let depth = 0;
  let current = bone?.parent;

  while (current) {
    depth += 1;
    current = current.parent;
  }

  return depth;
}

function worldPointToBodyLocal({
  point,
  bodyPosition,
  bodyQuaternion,
}) {
  return point.clone()
    .sub(bodyPosition)
    .applyQuaternion(bodyQuaternion.clone().invert());
}

function setBoneWorldTransform({ bone, position, quaternion }) {
  const parent = bone.parent;

  parent?.updateMatrixWorld(true);
  bone.updateMatrixWorld(true);
  tempBoneScale.copy(bone.scale);
  bone.matrixWorld.decompose(tempWorldPosition, tempWorldQuaternion, tempWorldScale);
  tempWorldMatrix.compose(position, quaternion, tempWorldScale);

  if (parent) {
    tempParentInverse.copy(parent.matrixWorld).invert();
    tempLocalMatrix.multiplyMatrices(tempParentInverse, tempWorldMatrix);
  } else {
    tempLocalMatrix.copy(tempWorldMatrix);
  }

  tempLocalMatrix.decompose(bone.position, bone.quaternion, tempWorldScale);
  bone.scale.copy(tempBoneScale);
  bone.updateMatrixWorld(true);
}

function prepareTargetAsset(root) {
  root.traverse((child) => {
    if (child.isMesh || child.isSkinnedMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      child.frustumCulled = false;
    }
  });
}

function normalizeToHeight(root, targetHeight) {
  // Use geometry bind-pose bounds for skinned models to avoid applyBoneTransform / matrixWorld issues.
  const box = new THREE.Box3();
  let usedGeo = false;

  root.updateMatrixWorld(true);

  root.traverse((child) => {
    if (child.isSkinnedMesh && child.geometry) {
      const geo = child.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (geo.boundingBox) {
        const b = geo.boundingBox.clone();
        b.applyMatrix4(child.matrixWorld);
        box.union(b);
        usedGeo = true;
      }
    }
  });

  if (!usedGeo) {
    box.setFromObject(root);
  }

  const size = box.getSize(new THREE.Vector3());

  if (!Number.isFinite(size.y) || size.y <= 0) {
    return;
  }

  root.scale.multiplyScalar(targetHeight / size.y);
  root.updateMatrixWorld(true);

  // Recompute after scale
  const normBox = new THREE.Box3();
  root.traverse((child) => {
    if (child.isSkinnedMesh && child.geometry && child.geometry.boundingBox) {
      const b = child.geometry.boundingBox.clone();
      b.applyMatrix4(child.matrixWorld);
      normBox.union(b);
    }
  });

  root.position.y -= (normBox.min ? normBox.min.y : 0);
  root.updateMatrixWorld(true);
}
