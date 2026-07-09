import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BaseVehicle } from '../game/vehicles/BaseVehicle.js';
import { GARAGE_DEFAULT_CHASSIS_TRANSFORM } from '../game/vehicles/garageBuilds.js';
import {
  BODYSHOP_FLOOR_CLEARANCE,
  BODYSHOP_FLOOR_Y,
  createBodyshopVehicleOptions,
} from './bodyshopVehicleConfig.js';
import {
  configureBodyshopRenderer,
  installBodyshopEnvironment,
  liftObjectToFloor,
} from './bodyshopViewport.js';

export async function createBodyshopVehiclePreview({
  container,
  glbUrl,
  chassisId = 'bodyshop-preview',
  framePresetId = 'street',
  chassisTransform = GARAGE_DEFAULT_CHASSIS_TRANSFORM,
} = {}) {
  if (!container) throw new Error('Preview container is required.');

  const vehicle = new BaseVehicle({
    name: 'Bodyshop Preview',
    ...createBodyshopVehicleOptions({
      framePresetId,
      chassisTransform,
      chassisOverlay: {
        url: glbUrl,
        profileId: chassisId,
      },
    }),
  });

  const model = vehicle.buildMesh();
  vehicle.group = model;
  await vehicle.assembleGroundVehicleVisuals({ syncParkedWheels: true });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#d6dbde');

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(4.5, 2.2, 4.6);

  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
  configureBodyshopRenderer(renderer);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.className = 'builder-canvas bodyshop-preview-canvas';
  container.replaceChildren(renderer.domElement);
  await renderer.init();
  await installBodyshopEnvironment(renderer, scene);

  const ambient = new THREE.AmbientLight(0xffffff, 0.34);
  const hemi = new THREE.HemisphereLight('#fff7d8', '#73806e', 1.7);
  const sun = new THREE.DirectionalLight('#fff4db', 2.1);
  sun.position.set(4, 7, 5);
  scene.add(ambient, hemi, sun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(18, 18),
    new THREE.MeshStandardMaterial({ color: '#c7cfca', roughness: 0.95, metalness: 0.02 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = BODYSHOP_FLOOR_Y;
  floor.userData._builderHelper = true;
  scene.add(floor);
  scene.add(model);
  liftObjectToFloor(model, BODYSHOP_FLOOR_Y, BODYSHOP_FLOOR_CLEARANCE);

  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 1) * 0.5;

  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.target.copy(center);
  camera.position.copy(center.clone().add(new THREE.Vector3(radius * 1.9, radius * 0.95, radius * 1.9)));
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
