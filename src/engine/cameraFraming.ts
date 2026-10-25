import * as THREE from 'three'

/** Objects larger than this (ground planes, sky domes) are left out when measuring a level. */
const maxFramedRadius = 25
/** Share of the viewport height kept clear at the bottom for the HUD. */
const hudReserve = 0.3
/** Share of the viewport width on the right kept clear for the replay card. */
const sideReserve = 0.26
const padding = 1.6
/** Camera looks at the level from the front and a little above. */
const viewDirection = new THREE.Vector3(0, 0.32, 1).normalize()

/** Measures the parts of a level worth framing: meshes of reasonable size plus any named body positions. */
export function measureLevel(root: THREE.Object3D, bodyPositions: Iterable<THREE.Vector3>): THREE.Box3 | null {
  const box = new THREE.Box3()
  const sphere = new THREE.Sphere()
  const part = new THREE.Box3()
  root.updateMatrixWorld(true)
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry || !mesh.visible) return
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
    if (!mesh.geometry.boundingSphere) return
    sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld)
    if (!Number.isFinite(sphere.radius) || sphere.radius > maxFramedRadius) return
    part.setFromObject(mesh)
    box.union(part)
  })
  for (const position of bodyPositions) {
    if (Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z) && position.y > -5) box.expandByPoint(position)
  }
  return box.isEmpty() ? null : box
}

/** Places the camera so the whole box is visible above the HUD band at the bottom of the viewport. */
export function frameBox(camera: THREE.PerspectiveCamera, box: THREE.Box3): THREE.Vector3 {
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const verticalFov = THREE.MathUtils.degToRad(camera.fov)
  const usableHeight = 1 - hudReserve
  const halfHeight = Math.max(size.y, size.z * 0.35, 1) / 2
  const halfWidth = Math.max(size.x, 1) / 2
  const distanceForHeight = halfHeight / (Math.tan(verticalFov / 2) * usableHeight)
  const distanceForWidth = halfWidth / (Math.tan(verticalFov / 2) * camera.aspect * (1 - sideReserve))
  const distance = Math.max(distanceForHeight, distanceForWidth) * padding + size.z / 2
  // Aim below the centre so the level sits in the upper part of the frame, clear of the HUD.
  const target = center.clone()
  target.y -= Math.tan(verticalFov / 2) * distance * hudReserve
  // Aim right of the centre so the level sits left of the replay card.
  target.x += Math.tan(verticalFov / 2) * camera.aspect * distance * sideReserve
  camera.position.copy(target).addScaledVector(viewDirection, distance)
  camera.near = Math.max(0.05, distance / 200)
  camera.far = Math.max(500, distance * 20)
  camera.lookAt(target)
  camera.updateProjectionMatrix()
  return target
}
