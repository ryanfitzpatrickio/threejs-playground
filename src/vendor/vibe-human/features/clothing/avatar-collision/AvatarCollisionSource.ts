import * as THREE from 'three/webgpu'

export type AvatarCollisionSource = {
  getSkinnedMeshes(): THREE.SkinnedMesh[]
  getBodyMeshes(): THREE.SkinnedMesh[]
  getHeadMeshes(): THREE.SkinnedMesh[]
  getSkeletons(): THREE.Skeleton[]
  getBones(): Record<string, THREE.Bone>
  getRootObject(): THREE.Object3D | null
}

const emptySource: AvatarCollisionSource = {
  getSkinnedMeshes: () => [],
  getBodyMeshes: () => [],
  getHeadMeshes: () => [],
  getSkeletons: () => [],
  getBones: () => ({}),
  getRootObject: () => null,
}

let currentSource: AvatarCollisionSource = emptySource

export function registerAvatarCollisionSource(source: AvatarCollisionSource) {
  currentSource = source
  return () => {
    if (currentSource === source) currentSource = emptySource
  }
}

export function getAvatarCollisionSource() {
  return currentSource
}
