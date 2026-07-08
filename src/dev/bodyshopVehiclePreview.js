import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BaseVehicle } from '../game/vehicles/BaseVehicle.js';
import { GARAGE_DEFAULT_CHASSIS_TRANSFORM, GARAGE_FRAME_PRESETS } from '../game/vehicles/garageBuilds.js';
import {
  configureBodyshopRenderer,
  installBodyshopEnvironment,
  liftObjectToFloor,
} from './bodyshopViewport.js';

export async function createBodyshopVehiclePreview({
  container,
  glbUrl,
  chassisId = 'bodyshop-preview',
}) {
  if (!container) throw new Error('Preview container is required.');

  const preset = GARAGE_FRAME_PRESETS.find((entry) => entry.id === 'street') ?? GARAGE_FRAME_PRESETS[0];
  const frame = preset.frame;

  const transform = GARAGE_DEFAULT_CHASSIS_TRANSFORM;
  const vehicle = new BaseVehicle({
    name: 'Bodyshop Preview',
    hideEngine: true,
    chassisOverlay: {
      url: glbUrl,
      profileId: chassisId,
      chassisSurfaceMode: 'metallic',
      position: [...transform.position],
      rotationDegrees: [...transform.rotationDegrees],
      scale: [...transform.scale],
    },
    frameParameters: frame,
    config: {
      body: {
        size: [frame.frameWidth, frame.frameHeight, frame.frameLength],
      },
      ground: {
        enginePower: 8,
        traction: 0.55,
        wheelRadius: 0.38,
        wheelWidth: 0.3,
        wheelInset: 0.12,
        rayCast: {
          wheelRadius: 0.38,
          suspensionStiffness: 24,
          suspensionCompression: 12,
          suspensionRelaxation: 12,
          maxSteerYawRate: 0.75,
          highSpeedSteerYawRate: 0.42,
        },
      },
    },
  });

  const model = vehicle.buildMesh();
  vehicle.group = model;
  await vehicle.assembleGroundVehicleVisuals({ syncParkedWheels: true });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#c9cec9');

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(5.2, 2.1, 5.4);

  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
  configureBodyshopRenderer(renderer);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.className = 'builder-canvas bodyshop-preview-canvas';
  container.replaceChildren(renderer.domElement);
  await renderer.init();
  await installBodyshopEnvironment(renderer, scene);

  const ambient = new THREE.AmbientLight(0xffffff, 0.32);
  const hemi = new THREE.HemisphereLight('#fff7d8', '#73806e', 1.5);
  const sun = new THREE.DirectionalLight('#fff4db', 2.0);
  sun.position.set(4, 7, 5);
  sun.castShadow = true;
  scene.add(ambient, hemi, sun);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new THREE.MeshStandardMaterial({ color: '#b8c0bb', roughness: 0.92, metalness: 0.04 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.16;
  floor.receiveShadow = true;
  scene.add(floor);
  scene.add(model);
  liftObjectToFloor(model, 0.16, 0.02);

  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 1) * 0.5;

  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.target.copy(center);
  camera.position.copy(center.clone().add(new THREE.Vector3(radius * 1.8, radius * 0.85, radius * 1.8)));
  orbitControls.update();

  const resize = () => {
    const width = Math.max(container.clientWidth, 320);
    const height = Math.max(container.clientHeight, 240);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  };
  resize();

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  let animationFrame = 0;
  const tick = () => {
    animationFrame = requestAnimationFrame(tick);
    orbitControls.update();
    renderer.render(scene, camera);
  };
  tick();

  return {
    vehicle,
    setSteer(amount = 0) {
      vehicle._articulate(THREE.MathUtils.clamp(amount, -1, 1));
    },
    setDoorOpen(amount = 0) {
      vehicle.doorOpenTarget = THREE.MathUtils.clamp(amount, 0, 1);
      vehicle.setDoorOpenAmount(vehicle.doorOpenTarget);
    },
    dispose() {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      orbitControls.dispose();
      renderer.dispose();
      container.replaceChildren();
      vehicle.dispose?.({ scene: null, physics: null });
    },
  };
}
