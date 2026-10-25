import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import type { GeneratedLevelModule, StepResult } from '../engine/types'

// Mock fixture, draft 2 of the "catapult" script (see catapult.script.json).
// The catapult throws a boulder over the lava pit and knocks the red boss off the castle bridge.
const LAUNCH_FRAME = 30
const LAUNCH_VELOCITY = { x: 7, y: 4.5, z: 0 }
const BOULDER_START = { x: -3.6, y: 3.05, z: 0 }

type Vec3 = [number, number, number]

export const buildWorld: GeneratedLevelModule['buildWorld'] = (scene, world, namedBodies) => {
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4)
  sun.position.set(-4, 9, 7)
  scene.add(sun)

  const block = (size: Vec3, color: number, emissive = 0x000000) => new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color, emissive, roughness: 0.85 }),
  )
  const fixedBlock = (center: Vec3, size: Vec3, color: number, emissive?: number) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...center))
    world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2), body)
    const mesh = block(size, color, emissive)
    mesh.position.set(...center)
    scene.add(mesh)
  }

  fixedBlock([-3.5, 1.2, 0], [5, 2.4, 2], 0x7fbf68) // launch hill
  fixedBlock([2.25, 0.85, 0], [6.5, 1.7, 2.4], 0xff6a1f, 0xff3b00) // lava pit
  fixedBlock([-0.5, 2.45, 0], [0.2, 1.5, 0.8], 0xb8c0ca) // bridge pillars
  fixedBlock([1.5, 2.45, 0], [0.2, 1.5, 0.8], 0xb8c0ca)
  fixedBlock([0.5, 3.3, 0], [2.2, 0.2, 1.2], 0x8d6748) // castle bridge
  fixedBlock([5.85, 3.5, 0], [0.7, 3.6, 2], 0xb8c0ca) // castle wall

  // Catapult frame and throwing arm are visual only; the boulder waits in the bucket as a kinematic body.
  const frame = block([1.2, 0.24, 0.9], 0x6b4528)
  frame.position.set(-3.3, 2.52, 0)
  scene.add(frame)
  const pivot = new THREE.Group()
  pivot.position.set(-3, 2.75, 0)
  pivot.rotation.z = 2.68
  const arm = block([0.7, 0.1, 0.18], 0x9a6a3f)
  arm.position.x = 0.35
  pivot.add(arm)
  scene.add(pivot)

  const boulder = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(BOULDER_START.x, BOULDER_START.y, BOULDER_START.z)
      .setCcdEnabled(true),
  )
  world.createCollider(
    RAPIER.ColliderDesc.ball(0.35)
      .setDensity(5)
      .setSensor(true)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
    boulder,
  )
  const boulderMesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.35, 1),
    new THREE.MeshStandardMaterial({ color: 0x8b9097, flatShading: true }),
  )
  scene.add(boulderMesh)
  namedBodies.set('boulder', boulder)

  const boss = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(1.2, 3.76, 0))
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.35, 0.35, 0.35)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(5),
    boss,
  )
  const bossMesh = block([0.7, 0.7, 0.7], 0xe2463b)
  for (const x of [-0.15, 0.15]) {
    const eye = block([0.16, 0.16, 0.02], 0xffffff)
    eye.position.set(x, 0.08, 0.36)
    const pupil = block([0.07, 0.07, 0.02], 0x1d2329)
    pupil.position.set(x + 0.03, 0.06, 0.375)
    bossMesh.add(eye, pupil)
  }
  scene.add(bossMesh)
  namedBodies.set('boss', boss)

  const synced: Array<[THREE.Object3D, RAPIER.RigidBody]> = [[boulderMesh, boulder], [bossMesh, boss]]
  const sync = () => {
    for (const [mesh, body] of synced) {
      const p = body.translation()
      const q = body.rotation()
      mesh.position.set(p.x, p.y, p.z)
      mesh.quaternion.set(q.x, q.y, q.z, q.w)
    }
  }
  sync()

  let launched = false
  const launch = () => {
    if (launched) return
    launched = true
    boulder.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
    boulder.setLinvel(LAUNCH_VELOCITY, true)
  }

  const rules = (botState: string): StepResult => {
    if (launched && pivot.rotation.z > 1.35) pivot.rotation.z = Math.max(1.35, pivot.rotation.z - 0.22)
    sync()
    if (boss.translation().y < 2.4) return { botState: 'boss in the lava', goalReached: true }
    if (launched && boulder.translation().y < -0.6) {
      return { botState, goalReached: false, failedEarly: 'The boulder left the arena without knocking the boss off the bridge.' }
    }
    return { botState, goalReached: false }
  }

  return {
    stepBotAndRules: (frameIndex) => {
      if (frameIndex >= LAUNCH_FRAME) launch()
      return rules(launched ? 'boulder in flight' : 'aiming')
    },
    stepHumanAndRules: () => rules(launched ? 'boulder in flight' : 'press Space to fire'),
    onPointerOrKey: (event) => {
      if ((event.type === 'keydown' && event.key === ' ') || event.type === 'pointerdown') launch()
    },
    dispose: () => {},
  }
}
