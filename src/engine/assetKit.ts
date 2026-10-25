import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

export type Vec3 = [number, number, number]

export interface AssetOptions {
  position?: Vec3
  scale?: number | Vec3
  color?: number
}

export interface PlatformTileOptions extends AssetOptions {
  size?: Vec3
  topColor?: number
}

const materialCache = new Map<string, THREE.MeshStandardMaterial>()

function getMaterial(
  color: number,
  roughness = 0.65,
  metalness = 0.08,
  emissive = 0x000000,
  emissiveIntensity = 0,
): THREE.MeshStandardMaterial {
  const key = `${color}_${roughness}_${metalness}_${emissive}_${emissiveIntensity}`
  const existing = materialCache.get(key)
  if (existing) return existing
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    emissive,
    emissiveIntensity,
  })
  materialCache.set(key, mat)
  return mat
}

function applyTransform(group: THREE.Group, options?: AssetOptions): THREE.Group {
  if (options?.position) {
    group.position.set(options.position[0], options.position[1], options.position[2])
  }
  if (options?.scale !== undefined) {
    if (typeof options.scale === 'number') {
      group.scale.setScalar(options.scale)
    } else {
      group.scale.set(options.scale[0], options.scale[1], options.scale[2])
    }
  }
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })
  return group
}

function addPart(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  pos: Vec3,
  rot?: Vec3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(pos[0], pos[1], pos[2])
  if (rot) mesh.rotation.set(rot[0], rot[1], rot[2])
  parent.add(mesh)
  return mesh
}

/**
 * Humanoid character (~10 parts): head, cap/visor, eyes, torso, backpack, arms, legs.
 * Origin is centered at the character's vertical midpoint (height ~1.2m, radius ~0.35m).
 */
export function createCharacter(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-character'

  const tunicMat = getMaterial(options.color ?? 0x3b82f6, 0.55, 0.1)
  const skinMat = getMaterial(0xffd2a6, 0.7, 0.05)
  const darkMat = getMaterial(0x1e293b, 0.4, 0.2)
  const bootMat = getMaterial(0x451a03, 0.8, 0.1)
  const packMat = getMaterial(0xf59e0b, 0.5, 0.25)

  // Torso & backpack
  addPart(group, new THREE.BoxGeometry(0.46, 0.48, 0.28), tunicMat, [0, -0.02, 0])
  addPart(group, new THREE.BoxGeometry(0.34, 0.36, 0.16), packMat, [0, 0.02, -0.2])

  // Head & cap
  addPart(group, new THREE.BoxGeometry(0.42, 0.38, 0.38), skinMat, [0, 0.42, 0])
  addPart(group, new THREE.BoxGeometry(0.45, 0.12, 0.44), tunicMat, [0, 0.6, 0.03])

  // Eyes
  addPart(group, new THREE.BoxGeometry(0.07, 0.09, 0.04), darkMat, [-0.1, 0.43, 0.2])
  addPart(group, new THREE.BoxGeometry(0.07, 0.09, 0.04), darkMat, [0.1, 0.43, 0.2])

  // Arms
  addPart(group, new THREE.BoxGeometry(0.14, 0.4, 0.14), tunicMat, [-0.32, -0.02, 0])
  addPart(group, new THREE.BoxGeometry(0.14, 0.4, 0.14), tunicMat, [0.32, -0.02, 0])

  // Legs / boots
  addPart(group, new THREE.BoxGeometry(0.17, 0.34, 0.2), bootMat, [-0.12, -0.42, 0.02])
  addPart(group, new THREE.BoxGeometry(0.17, 0.34, 0.2), bootMat, [0.12, -0.42, 0.02])

  return applyTransform(group, options)
}

/**
 * Arcade enemy (~8 parts): spiky body, brow, angry eyes, horns, feet.
 */
export function createEnemy(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-enemy'

  const bodyMat = getMaterial(options.color ?? 0xe11d48, 0.5, 0.15)
  const hornMat = getMaterial(0xfef08a, 0.35, 0.3)
  const eyeWhite = getMaterial(0xffffff, 0.2, 0.05)
  const pupilMat = getMaterial(0x111827, 0.2, 0.1)
  const footMat = getMaterial(0x31102f, 0.85, 0.05)

  addPart(group, new THREE.BoxGeometry(0.68, 0.58, 0.62), bodyMat, [0, 0.02, 0])
  // Horns
  addPart(group, new THREE.ConeGeometry(0.1, 0.26, 6), hornMat, [-0.22, 0.42, 0], [0, 0, 0.25])
  addPart(group, new THREE.ConeGeometry(0.1, 0.26, 6), hornMat, [0.22, 0.42, 0], [0, 0, -0.25])
  // Eyes & brow
  addPart(group, new THREE.BoxGeometry(0.16, 0.16, 0.04), eyeWhite, [-0.15, 0.08, 0.32])
  addPart(group, new THREE.BoxGeometry(0.16, 0.16, 0.04), eyeWhite, [0.15, 0.08, 0.32])
  addPart(group, new THREE.BoxGeometry(0.08, 0.08, 0.05), pupilMat, [-0.13, 0.06, 0.34])
  addPart(group, new THREE.BoxGeometry(0.08, 0.08, 0.05), pupilMat, [0.13, 0.06, 0.34])
  addPart(group, new THREE.BoxGeometry(0.5, 0.07, 0.06), footMat, [0, 0.19, 0.33])
  // Feet
  addPart(group, new THREE.BoxGeometry(0.24, 0.16, 0.32), footMat, [-0.18, -0.34, 0.05])
  addPart(group, new THREE.BoxGeometry(0.24, 0.16, 0.32), footMat, [0.18, -0.34, 0.05])

  return applyTransform(group, options)
}

/**
 * Stylized layered pine/foliage tree.
 */
export function createTree(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-tree'

  const trunkMat = getMaterial(0x78350f, 0.9, 0.02)
  const leafMat = getMaterial(options.color ?? 0x22c55e, 0.75, 0.05)

  addPart(group, new THREE.CylinderGeometry(0.16, 0.22, 0.9, 8), trunkMat, [0, 0.45, 0])
  addPart(group, new THREE.ConeGeometry(0.85, 1.1, 7), leafMat, [0, 1.25, 0])
  addPart(group, new THREE.ConeGeometry(0.68, 0.95, 7), leafMat, [0, 1.85, 0])
  addPart(group, new THREE.ConeGeometry(0.46, 0.75, 7), leafMat, [0, 2.35, 0])

  return applyTransform(group, options)
}

/**
 * Multi-faceted low-poly boulder cluster.
 */
export function createRock(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-rock'

  const rockMat = getMaterial(options.color ?? 0x94a3b8, 0.88, 0.08)
  const accentMat = getMaterial(0x64748b, 0.92, 0.05)

  addPart(group, new THREE.DodecahedronGeometry(0.5, 0), rockMat, [0, 0, 0], [0.2, 0.4, 0.1])
  addPart(group, new THREE.DodecahedronGeometry(0.32, 0), accentMat, [0.3, -0.12, 0.18], [0.5, 0.1, 0.3])
  addPart(group, new THREE.DodecahedronGeometry(0.26, 0), rockMat, [-0.28, -0.15, -0.14], [0.1, 0.7, 0.2])

  return applyTransform(group, options)
}

/**
 * Wooden crate with recessed inner faces and corner frame bars.
 */
export function createCrate(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-crate'

  const woodMat = getMaterial(options.color ?? 0xd97706, 0.8, 0.08)
  const trimMat = getMaterial(0x92400e, 0.85, 0.12)

  addPart(group, new THREE.BoxGeometry(0.88, 0.88, 0.88), woodMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.96, 0.14, 0.96), trimMat, [0, 0.38, 0])
  addPart(group, new THREE.BoxGeometry(0.96, 0.14, 0.96), trimMat, [0, -0.38, 0])
  addPart(group, new THREE.BoxGeometry(0.14, 0.96, 0.96), trimMat, [-0.38, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.14, 0.96, 0.96), trimMat, [0.38, 0, 0])

  return applyTransform(group, options)
}

/**
 * Metallic spinning coin pickup with raised rim and center emblem.
 */
export function createCoin(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-coin'

  const goldMat = getMaterial(options.color ?? 0xfacc15, 0.25, 0.8, 0xca8a04, 0.2)
  const coreMat = getMaterial(0xfef08a, 0.2, 0.9)

  addPart(group, new THREE.CylinderGeometry(0.32, 0.32, 0.1, 16), goldMat, [0, 0, 0], [Math.PI / 2, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.12, 0.28, 0.14), coreMat, [0, 0, 0])

  return applyTransform(group, options)
}

/**
 * Arcade item block with rivets and bright emblem on sides.
 */
export function createItemBlock(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-item-block'

  const blockMat = getMaterial(options.color ?? 0xf59e0b, 0.35, 0.45, 0xb45309, 0.15)
  const emblemMat = getMaterial(0xfef9c3, 0.25, 0.2)

  addPart(group, new THREE.BoxGeometry(0.92, 0.92, 0.92), blockMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.98, 0.4, 0.4), emblemMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.4, 0.4, 0.98), emblemMat, [0, 0, 0])

  return applyTransform(group, options)
}

/**
 * Goal post / flag with base pedestal, metallic pole, finial orb, and pennant banner.
 */
export function createGoalFlag(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-goal-flag'

  const poleMat = getMaterial(0xe2e8f0, 0.3, 0.75)
  const baseMat = getMaterial(0x475569, 0.7, 0.3)
  const flagMat = getMaterial(options.color ?? 0x22c55e, 0.45, 0.1, options.color ?? 0x22c55e, 0.25)
  const orbMat = getMaterial(0xfacc15, 0.2, 0.85)

  addPart(group, new THREE.CylinderGeometry(0.35, 0.42, 0.2, 12), baseMat, [0, 0.1, 0])
  addPart(group, new THREE.CylinderGeometry(0.06, 0.06, 2.4, 10), poleMat, [0, 1.3, 0])
  addPart(group, new THREE.SphereGeometry(0.14, 12, 12), orbMat, [0, 2.55, 0])
  addPart(group, new THREE.BoxGeometry(0.85, 0.48, 0.06), flagMat, [0.44, 2.15, 0])

  return applyTransform(group, options)
}

/**
 * Layered platform tile with grassy/colored cap and earthen underside.
 */
export function createPlatformTile(options: PlatformTileOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-platform-tile'

  const [w, h, d] = options.size ?? [2, 0.5, 2]
  const capHeight = Math.min(0.16, h * 0.35)
  const baseHeight = Math.max(0.05, h - capHeight)

  const baseMat = getMaterial(options.color ?? 0x854d0e, 0.88, 0.05)
  const topMat = getMaterial(options.topColor ?? 0x4ade80, 0.7, 0.05)

  addPart(group, new THREE.BoxGeometry(w, baseHeight, d), baseMat, [0, -capHeight / 2, 0])
  addPart(group, new THREE.BoxGeometry(w * 1.02, capHeight, d * 1.02), topMat, [0, baseHeight / 2, 0])

  return applyTransform(group, options)
}

/**
 * Small collider helper so generated levels can pair an asset group with a matching box or capsule body in one call.
 */
export interface ColliderBodyOptions {
  type?: 'dynamic' | 'fixed' | 'kinematicPosition'
  shape?: 'box' | 'capsule' | 'ball'
  position?: Vec3
  size?: Vec3
  halfHeight?: number
  radius?: number
  density?: number
  friction?: number
  restitution?: number
  lockRotations?: boolean
}

export function createBodyWithCollider(
  world: RAPIER.World,
  options: ColliderBodyOptions = {},
): RAPIER.RigidBody {
  const [x, y, z] = options.position ?? [0, 0, 0]
  const bodyDesc =
    options.type === 'fixed'
      ? RAPIER.RigidBodyDesc.fixed()
      : options.type === 'kinematicPosition'
        ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.dynamic()
  bodyDesc.setTranslation(x, y, z)
  if (options.lockRotations) bodyDesc.lockRotations()

  const body = world.createRigidBody(bodyDesc)
  const shape = options.shape ?? 'box'
  let colliderDesc: RAPIER.ColliderDesc
  if (shape === 'capsule') {
    colliderDesc = RAPIER.ColliderDesc.capsule(options.halfHeight ?? 0.3, options.radius ?? 0.3)
  } else if (shape === 'ball') {
    colliderDesc = RAPIER.ColliderDesc.ball(options.radius ?? 0.4)
  } else {
    const [sx, sy, sz] = options.size ?? [1, 1, 1]
    colliderDesc = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
  }

  colliderDesc
    .setDensity(options.density ?? 1)
    .setFriction(options.friction ?? 0.6)
    .setRestitution(options.restitution ?? 0.15)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | RAPIER.ActiveEvents.COLLISION_EVENTS)
  world.createCollider(colliderDesc, body)
  return body
}

export interface ScatterArea {
  min: [number, number]
  max: [number, number]
  y?: number
  minRadius?: number
}

/**
 * Scatters background scenery deterministically using THREE.InstancedMesh (one InstancedMesh per child mesh in `template`).
 */
export function scatter(
  scene: THREE.Scene,
  template: THREE.Object3D,
  count: number,
  area: ScatterArea,
  seed = 1337,
): THREE.Group {
  const container = new THREE.Group()
  container.name = 'asset-scatter'
  scene.add(container)
  if (count <= 0) return container

  let state = (seed >>> 0) || 1
  const nextRand = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }

  template.updateMatrixWorld(true)
  const meshParts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; localMatrix: THREE.Matrix4 }> = []
  template.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh) {
      meshParts.push({
        geometry: mesh.geometry,
        material: mesh.material,
        localMatrix: mesh.matrix.clone(),
      })
    }
  })

  const instancedMeshes = meshParts.map((part) => {
    const inst = new THREE.InstancedMesh(part.geometry, part.material, count)
    inst.castShadow = true
    inst.receiveShadow = true
    container.add(inst)
    return { inst, localMatrix: part.localMatrix }
  })

  const [minX, minZ] = area.min
  const [maxX, maxZ] = area.max
  const baseY = area.y ?? 0
  const minRadius = area.minRadius ?? 0
  const instanceTransform = new THREE.Matrix4()
  const finalMatrix = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const euler = new THREE.Euler()

  for (let i = 0; i < count; i++) {
    let x = 0
    let z = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      x = minX + nextRand() * (maxX - minX)
      z = minZ + nextRand() * (maxZ - minZ)
      if (Math.hypot(x, z) >= minRadius) break
    }
    const s = 0.75 + nextRand() * 0.55
    pos.set(x, baseY, z)
    euler.set(0, nextRand() * Math.PI * 2, 0)
    quat.setFromEuler(euler)
    scale.set(s, s, s)
    instanceTransform.compose(pos, quat, scale)

    for (const { inst, localMatrix } of instancedMeshes) {
      finalMatrix.multiplyMatrices(instanceTransform, localMatrix)
      inst.setMatrixAt(i, finalMatrix)
    }
  }

  for (const { inst } of instancedMeshes) {
    inst.instanceMatrix.needsUpdate = true
  }

  return container
}

/**
 * Gameplay helper 1: Basic player controller (run left/right, jump with ground check, driven by a held-keys set).
 */
export interface PlayerControllerOptions {
  moveSpeed?: number
  jumpSpeed?: number
  groundYThreshold?: number
  leftKeys?: string[]
  rightKeys?: string[]
  jumpKeys?: string[]
}

export interface PlayerControllerHandle {
  heldKeys: Set<string>
  onPointerOrKey: (event: { type: string; key?: string; code?: string }) => void
  step: () => { grounded: boolean; moving: number }
  syncMesh: (mesh: THREE.Object3D) => void
}

export function createPlayerController(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  options: PlayerControllerOptions = {},
): PlayerControllerHandle {
  const moveSpeed = options.moveSpeed ?? 6.5
  const jumpSpeed = options.jumpSpeed ?? 8.2
  const leftKeys = new Set(
    (options.leftKeys ?? ['ArrowLeft', 'KeyA', 'a', 'A']).map((k) => k.toLowerCase()),
  )
  const rightKeys = new Set(
    (options.rightKeys ?? ['ArrowRight', 'KeyD', 'd', 'D']).map((k) => k.toLowerCase()),
  )
  const jumpKeys = new Set(
    (options.jumpKeys ?? ['Space', ' ', 'ArrowUp', 'KeyW', 'w', 'W']).map((k) => k.toLowerCase()),
  )
  const heldKeys = new Set<string>()

  function isPressed(set: Set<string>): boolean {
    for (const k of heldKeys) {
      if (set.has(k)) return true
    }
    return false
  }

  function checkGrounded(): boolean {
    const pos = body.translation()
    const vel = body.linvel()
    if (options.groundYThreshold !== undefined && pos.y <= options.groundYThreshold && Math.abs(vel.y) < 0.6) {
      return true
    }
    const ray = new RAPIER.Ray({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: -1, z: 0 })
    const hit = world.castRay(ray, 0.85, true, undefined, undefined, undefined, body)
    return hit !== null || (pos.y <= 0.75 && Math.abs(vel.y) < 0.25)
  }

  return {
    heldKeys,
    onPointerOrKey(event) {
      const tokens = [event.key, event.code].filter((t): t is string => Boolean(t)).map((t) => t.toLowerCase())
      if (event.type === 'keydown') {
        tokens.forEach((t) => heldKeys.add(t))
      } else if (event.type === 'keyup') {
        tokens.forEach((t) => heldKeys.delete(t))
      }
    },
    step() {
      const left = isPressed(leftKeys)
      const right = isPressed(rightKeys)
      const jump = isPressed(jumpKeys)
      const moving = (right ? 1 : 0) - (left ? 1 : 0)
      const grounded = checkGrounded()
      const currentVel = body.linvel()
      const nextVx = moving !== 0 ? moving * moveSpeed : currentVel.x * 0.8
      const nextVy = jump && grounded && currentVel.y <= 0.5 ? jumpSpeed : currentVel.y
      body.wakeUp()
      body.setLinvel({ x: nextVx, y: nextVy, z: currentVel.z }, true)
      return { grounded, moving }
    },
    syncMesh(mesh) {
      const p = body.translation()
      const q = body.rotation()
      mesh.position.set(p.x, p.y, p.z)
      mesh.quaternion.set(q.x, q.y, q.z, q.w)
    },
  }
}

/**
 * Gameplay helper 2: Finite pickup (`collectOnce`) and directional block trigger (`hitFromBelow`).
 */
export interface TriggerItemHandle {
  readonly triggered: boolean
  check: (actor: RAPIER.RigidBody) => boolean
  reset: () => void
}

export function collectOnce(
  targetMesh: THREE.Object3D,
  options: { radius?: number; onCollect?: () => void } = {},
): TriggerItemHandle {
  const radius = options.radius ?? 0.85
  let collected = false

  return {
    get triggered() {
      return collected
    },
    check(actor: RAPIER.RigidBody): boolean {
      if (collected) return false
      const p = actor.translation()
      const dist = Math.hypot(
        p.x - targetMesh.position.x,
        p.y - targetMesh.position.y,
        p.z - targetMesh.position.z,
      )
      if (dist <= radius) {
        collected = true
        targetMesh.visible = false
        options.onCollect?.()
        return true
      }
      return false
    },
    reset() {
      collected = false
      targetMesh.visible = true
    },
  }
}

export function hitFromBelow(
  blockMesh: THREE.Object3D,
  options: { width?: number; reachY?: number; once?: boolean; onHit?: () => void } = {},
): TriggerItemHandle {
  const halfWidth = (options.width ?? 1.1) / 2
  const reachY = options.reachY ?? 1.05
  const once = options.once ?? true
  let fired = false

  return {
    get triggered() {
      return fired
    },
    check(actor: RAPIER.RigidBody): boolean {
      if (once && fired) return false
      const p = actor.translation()
      const v = actor.linvel()
      const dy = blockMesh.position.y - p.y
      const dx = Math.abs(p.x - blockMesh.position.x)
      const dz = Math.abs(p.z - blockMesh.position.z)
      if (dy > 0.15 && dy <= reachY && dx <= halfWidth && dz <= halfWidth && v.y > 0.2) {
        fired = true
        options.onHit?.()
        return true
      }
      return false
    },
    reset() {
      fired = false
    },
  }
}
