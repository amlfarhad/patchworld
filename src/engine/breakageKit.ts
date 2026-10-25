import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

export interface BreakableWallOptions {
  name?: string
  position: [number, number, number]
  size: [number, number, number]
  rows?: number
  cols?: number
  layers?: number
  color?: number
  density?: number
  friction?: number
  restitution?: number
  /** Optional contact force threshold above which fixed bricks become dynamic */
  breakForceThreshold?: number
  /** Start bricks as fixed until impacted above breakForceThreshold (default: false = stacked dynamic bricks) */
  lockUntilImpact?: boolean
}

export interface BreakableWallBrick {
  name: string
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  mesh: THREE.Mesh
  broken: boolean
}

export interface BreakableWallHandle {
  group: THREE.Group
  bricks: BreakableWallBrick[]
  step: (eventQueue?: RAPIER.EventQueue) => void
  shatterAll: () => void
  dispose: () => void
}

export function createBreakableWall(
  scene: THREE.Scene,
  world: RAPIER.World,
  namedBodies: Map<string, RAPIER.RigidBody>,
  options: BreakableWallOptions,
): BreakableWallHandle {
  const {
    name = 'wall',
    position,
    size,
    rows = 3,
    cols = 3,
    layers = 1,
    color = 0xd97757,
    density = 1.5,
    friction = 0.6,
    restitution = 0.15,
    breakForceThreshold = 15,
    lockUntilImpact = false,
  } = options

  const group = new THREE.Group()
  group.name = `${name}-group`
  scene.add(group)

  const [totalWidth, totalHeight, totalDepth] = size
  const brickWidth = totalWidth / Math.max(1, cols)
  const brickHeight = totalHeight / Math.max(1, rows)
  const brickDepth = totalDepth / Math.max(1, layers)

  const bricks: BreakableWallBrick[] = []
  const byColliderHandle = new Map<number, BreakableWallBrick>()

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let l = 0; l < layers; l++) {
        const bx = position[0] - totalWidth / 2 + (c + 0.5) * brickWidth
        const by = position[1] - totalHeight / 2 + (r + 0.5) * brickHeight
        const bz = position[2] - totalDepth / 2 + (l + 0.5) * brickDepth

        const geometry = new THREE.BoxGeometry(brickWidth * 0.98, brickHeight * 0.98, brickDepth * 0.98)
        const material = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.75,
          metalness: 0.1,
        })
        const mesh = new THREE.Mesh(geometry, material)
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.position.set(bx, by, bz)
        group.add(mesh)

        const bodyDesc = lockUntilImpact
          ? RAPIER.RigidBodyDesc.fixed().setTranslation(bx, by, bz)
          : RAPIER.RigidBodyDesc.dynamic().setTranslation(bx, by, bz)
        const body = world.createRigidBody(bodyDesc)

        const colliderDesc = RAPIER.ColliderDesc.cuboid(
          brickWidth / 2,
          brickHeight / 2,
          brickDepth / 2,
        )
          .setDensity(density)
          .setFriction(friction)
          .setRestitution(restitution)
          .setActiveEvents(
            RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | RAPIER.ActiveEvents.COLLISION_EVENTS,
          )
          .setContactForceEventThreshold(breakForceThreshold)

        const collider = world.createCollider(colliderDesc, body)
        const brickName = `${name}_${r}_${c}_${l}`
        namedBodies.set(brickName, body)

        const record: BreakableWallBrick = {
          name: brickName,
          body,
          collider,
          mesh,
          broken: !lockUntilImpact,
        }
        bricks.push(record)
        byColliderHandle.set(collider.handle, record)
      }
    }
  }

  function unlockBrick(brick: BreakableWallBrick): void {
    if (brick.broken) return
    brick.broken = true
    brick.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
  }

  return {
    group,
    bricks,
    step(eventQueue?: RAPIER.EventQueue) {
      if (lockUntilImpact && eventQueue) {
        eventQueue.drainContactForceEvents((event) => {
          if (event.totalForceMagnitude() < breakForceThreshold) return
          const brickA = byColliderHandle.get(event.collider1())
          const brickB = byColliderHandle.get(event.collider2())
          if (brickA) unlockBrick(brickA)
          if (brickB) unlockBrick(brickB)
        })
      }
      for (const brick of bricks) {
        const pos = brick.body.translation()
        const rot = brick.body.rotation()
        brick.mesh.position.set(pos.x, pos.y, pos.z)
        brick.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w)
      }
    },
    shatterAll() {
      for (const brick of bricks) {
        unlockBrick(brick)
      }
    },
    dispose() {
      scene.remove(group)
      for (const brick of bricks) {
        brick.mesh.geometry.dispose()
        const mat = brick.mesh.material
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat.dispose()
      }
    },
  }
}

export interface SnapJointOptions {
  bodyA: RAPIER.RigidBody
  bodyB: RAPIER.RigidBody
  anchorA?: [number, number, number]
  anchorB?: [number, number, number]
  breakForce: number
  type?: 'fixed' | 'spherical' | 'revolute'
  axis?: [number, number, number]
}

export interface SnapJointHandle {
  readonly isBroken: boolean
  readonly maxObservedForce: number
  joint: RAPIER.ImpulseJoint | null
  step: (contacts?: Array<{ bodyA: string; bodyB: string; totalForce: number }>) => boolean
  snap: () => void
}

export function createSnapJoint(
  world: RAPIER.World,
  options: SnapJointOptions,
): SnapJointHandle {
  const {
    bodyA,
    bodyB,
    anchorA = [0, 0, 0],
    anchorB = [0, 0, 0],
    breakForce,
    type = 'fixed',
    axis = [0, 0, 1],
  } = options

  const a1 = { x: anchorA[0], y: anchorA[1], z: anchorA[2] }
  const a2 = { x: anchorB[0], y: anchorB[1], z: anchorB[2] }
  const identRot = { x: 0, y: 0, z: 0, w: 1 }

  let jointData: RAPIER.JointData
  if (type === 'spherical') {
    jointData = RAPIER.JointData.spherical(a1, a2)
  } else if (type === 'revolute') {
    jointData = RAPIER.JointData.revolute(a1, a2, { x: axis[0], y: axis[1], z: axis[2] })
  } else {
    jointData = RAPIER.JointData.fixed(a1, identRot, a2, identRot)
  }

  let joint: RAPIER.ImpulseJoint | null = world.createImpulseJoint(jointData, bodyA, bodyB, true)
  let broken = false
  let maxObservedForce = 0

  function snap(): void {
    if (broken || !joint) return
    world.removeImpulseJoint(joint, true)
    joint = null
    broken = true
  }

  function worldPoint(body: RAPIER.RigidBody, local: [number, number, number]): THREE.Vector3 {
    const t = body.translation()
    const r = body.rotation()
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w)
    return new THREE.Vector3(local[0], local[1], local[2]).applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z))
  }

  return {
    get isBroken() {
      return broken
    },
    get maxObservedForce() {
      return maxObservedForce
    },
    get joint() {
      return joint
    },
    step(contacts) {
      if (broken) return true

      if (contacts && contacts.length > 0) {
        for (const c of contacts) {
          if (c.totalForce > maxObservedForce) maxObservedForce = c.totalForce
          if (c.totalForce >= breakForce) {
            snap()
            return true
          }
        }
      }

      const pA = worldPoint(bodyA, anchorA)
      const pB = worldPoint(bodyB, anchorB)
      const stretchForce = pA.distanceTo(pB) * 600
      const vA = bodyA.linvel()
      const vB = bodyB.linvel()
      const relSpeed = Math.hypot(vA.x - vB.x, vA.y - vB.y, vA.z - vB.z)
      const impulseEstimate = stretchForce + relSpeed * 25
      if (impulseEstimate > maxObservedForce) maxObservedForce = impulseEstimate

      if (impulseEstimate >= breakForce) {
        snap()
        return true
      }
      return false
    },
    snap,
  }
}

export interface SensorZoneOptions {
  name?: string
  position: [number, number, number]
  size: [number, number, number]
  color?: number
  opacity?: number
  kind?: 'lava' | 'goal'
}

export interface SensorZoneHandle {
  name: string
  kind: 'lava' | 'goal'
  mesh: THREE.Mesh
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  bounds: THREE.Box3
  containsBody: (body: RAPIER.RigidBody) => boolean
  containsNamedBody: (namedBodies: Map<string, RAPIER.RigidBody>, targetName: string) => boolean
  dispose: () => void
}

export function createSensorZone(
  scene: THREE.Scene,
  world: RAPIER.World,
  options: SensorZoneOptions,
): SensorZoneHandle {
  const {
    name = options.kind ?? 'sensor',
    position,
    size,
    kind = 'goal',
    color = kind === 'lava' ? 0xff4522 : 0x22c55e,
    opacity = 0.4,
  } = options

  const [sx, sy, sz] = size
  const geometry = new THREE.BoxGeometry(sx, sy, sz)
  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: kind === 'lava' ? 0.55 : 0.3,
    transparent: true,
    opacity,
    roughness: 0.3,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(position[0], position[1], position[2])
  mesh.name = name
  scene.add(mesh)

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(position[0], position[1], position[2]),
  )
  const collider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
      .setSensor(true)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    body,
  )

  const min = new THREE.Vector3(position[0] - sx / 2, position[1] - sy / 2, position[2] - sz / 2)
  const max = new THREE.Vector3(position[0] + sx / 2, position[1] + sy / 2, position[2] + sz / 2)
  const bounds = new THREE.Box3(min, max)

  function containsBody(target: RAPIER.RigidBody): boolean {
    const pos = target.translation()
    return (
      pos.x >= min.x &&
      pos.x <= max.x &&
      pos.y >= min.y &&
      pos.y <= max.y &&
      pos.z >= min.z &&
      pos.z <= max.z
    )
  }

  return {
    name,
    kind,
    mesh,
    body,
    collider,
    bounds,
    containsBody,
    containsNamedBody(namedBodies, targetName) {
      const target = namedBodies.get(targetName)
      return target ? containsBody(target) : false
    },
    dispose() {
      scene.remove(mesh)
      geometry.dispose()
      material.dispose()
    },
  }
}

export function createLavaSensor(
  scene: THREE.Scene,
  world: RAPIER.World,
  options: Omit<SensorZoneOptions, 'kind'>,
): SensorZoneHandle {
  return createSensorZone(scene, world, { ...options, kind: 'lava' })
}

export function createGoalSensor(
  scene: THREE.Scene,
  world: RAPIER.World,
  options: Omit<SensorZoneOptions, 'kind'>,
): SensorZoneHandle {
  return createSensorZone(scene, world, { ...options, kind: 'goal' })
}

export interface LaunchImpulseOptions {
  direction: [number, number, number]
  magnitude: number
  torque?: [number, number, number]
}

export function applyLaunchImpulse(
  body: RAPIER.RigidBody,
  options: LaunchImpulseOptions,
): void {
  const [dx, dy, dz] = options.direction
  const len = Math.hypot(dx, dy, dz) || 1
  const scale = options.magnitude / len
  body.wakeUp()
  body.applyImpulse({ x: dx * scale, y: dy * scale, z: dz * scale }, true)
  if (options.torque) {
    const [tx, ty, tz] = options.torque
    body.applyTorqueImpulse({ x: tx, y: ty, z: tz }, true)
  }
}
