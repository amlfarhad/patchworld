import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import RAPIER from '@dimforge/rapier3d-compat'
import { AutonomousLoop } from './AutonomousLoop'
import type { ContactSnapshot, GeneratedLevelModule, MountedLevel, StepResult } from './types'

const rapierReady = RAPIER.init()

export class EngineHost {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500)
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  readonly namedBodies = new Map<string, RAPIER.RigidBody>()
  readonly autonomousLoop: AutonomousLoop

  private readonly canvas: HTMLCanvasElement
  private currentModule: GeneratedLevelModule | null = null
  private eventQueue: RAPIER.EventQueue | null = null
  private world: RAPIER.World | null = null
  private levelHandle: MountedLevel | null = null
  private levelRoot: THREE.Group | null = null
  private unsubscribeLoopState: (() => void) | null = null
  private animationFrame = 0
  private frameIndex = 0
  private accumulator = 0
  private lastFrameTime = 0
  private disposed = false
  private viewportWidth = 0
  private viewportHeight = 0
  private viewportPixelRatio = 0
  private readonly fixedStep = 1 / 60

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.autonomousLoop = new AutonomousLoop(canvas)
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0xeaf3e9)
    this.camera.position.set(0, 3, 8)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.target.set(0, 0, 0)
    this.controls.enabled = this.autonomousLoop.isHumanControlled
    this.controls.update()
    this.unsubscribeLoopState = this.autonomousLoop.onStateChange(() => {
      this.controls.enabled = this.autonomousLoop.isHumanControlled
    })
    this.scene.add(new THREE.HemisphereLight(0xdceeff, 0x27313a, 2))
    this.resize()
    window.addEventListener('resize', this.resize)
  }

  async initialize(levelModule: GeneratedLevelModule): Promise<void> {
    await rapierReady
    if (this.disposed) return
    this.eventQueue = new RAPIER.EventQueue(true)
    await this.mountLevel(levelModule)
    this.autonomousLoop.connect()
    this.lastFrameTime = performance.now()
    this.animationFrame = window.requestAnimationFrame(this.tick)
  }

  async mountLevel(levelModule: GeneratedLevelModule): Promise<void> {
    await rapierReady
    if (this.disposed) return

    const nextWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    nextWorld.timestep = this.fixedStep
    const nextBodies = new Map<string, RAPIER.RigidBody>()
    const nextRoot = new THREE.Group()
    nextRoot.name = 'generated-level'
    const existingChildren = new Set(this.scene.children)

    let nextHandle: MountedLevel
    try {
      if (!this.eventQueue) throw new Error('Rapier event queue is not initialized')
      nextHandle = levelModule.buildWorld(this.scene, nextWorld, nextBodies, this.eventQueue)
      if (!nextHandle || typeof nextHandle.dispose !== 'function') {
        throw new TypeError('Generated level must return a dispose function')
      }
      if (typeof nextHandle.stepBotAndRules !== 'function') {
        throw new TypeError('Generated level must return a stepBotAndRules function')
      }
      if (typeof nextHandle.stepHumanAndRules !== 'function') {
        throw new TypeError('Generated level must return a stepHumanAndRules function')
      }
      if (!Array.isArray(nextHandle.controls)) {
        throw new TypeError('Generated level must return a controls list')
      }
      if (!nextHandle.goal || typeof nextHandle.goal.type !== 'string' || typeof nextHandle.goal.body !== 'string') {
        throw new TypeError('Generated level must return a valid goal object')
      }
      const newObjects = this.scene.children.filter((child) => !existingChildren.has(child))
      if (newObjects.length > 0) nextRoot.add(...newObjects)
      this.scene.add(nextRoot)
    } catch (error) {
      const additions = this.scene.children.filter((child) => !existingChildren.has(child))
      additions.forEach((child) => {
        this.scene.remove(child)
        this.disposeObjectTree(child)
      })
      this.disposeObjectTree(nextRoot)
      nextWorld.free()
      throw error
    }

    this.clearCurrentLevel()
    this.levelHandle = nextHandle
    this.levelRoot = nextRoot
    this.world = nextWorld
    this.namedBodies.clear()
    nextBodies.forEach((body, name) => this.namedBodies.set(name, body))
    this.frameIndex = 0
    this.accumulator = 0
    this.currentModule = levelModule
    this.frameLevelBounds()
    window.dispatchEvent(
      new CustomEvent('argon:level-mounted', {
        detail: {
          hasLevel: nextBodies.size > 0 || nextRoot.children.length > 0,
          bodyCount: nextBodies.size,
          controls: nextHandle.controls,
          goal: nextHandle.goal,
        },
      }),
    )
    this.autonomousLoop.onLevelMounted()
  }

  dispatchPointerOrKey(event: { type: string; key?: string; ndc?: [number, number] }): void {
    if (this.autonomousLoop.isHumanControlled) this.levelHandle?.onPointerOrKey?.(event)
  }

  resizeViewport(): void {
    if (!this.disposed) this.resize()
  }

  async resetLevel(): Promise<void> {
    if (!this.currentModule) return
    this.autonomousLoop.takeOver()
    await this.mountLevel(this.currentModule)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.cancelAnimationFrame(this.animationFrame)
    window.removeEventListener('resize', this.resize)
    this.unsubscribeLoopState?.()
    this.unsubscribeLoopState = null
    this.controls.dispose()
    this.clearCurrentLevel()
    this.autonomousLoop.dispose()
    this.eventQueue?.free()
    this.renderer.dispose()
  }

  private frameLevelBounds(): void {
    const box = new THREE.Box3()
    if (this.levelRoot && this.levelRoot.children.length > 0) {
      this.levelRoot.updateMatrixWorld(true)
      box.expandByObject(this.levelRoot)
    }

    this.namedBodies.forEach((body) => {
      const pos = body.translation()
      const point = new THREE.Vector3(pos.x, pos.y, pos.z)
      box.expandByPoint(point.clone().addScalar(0.5))
      box.expandByPoint(point.clone().subScalar(0.5))
    })

    if (box.isEmpty()) {
      this.camera.position.set(0, 3, 8)
      this.controls.target.set(0, 0, 0)
      this.camera.lookAt(0, 0, 0)
      this.controls.update()
      return
    }

    const sphere = new THREE.Sphere()
    box.getBoundingSphere(sphere)
    const center = sphere.center
    const radius = Math.max(sphere.radius, 2.5)
    const vFov = THREE.MathUtils.degToRad(this.camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(this.camera.aspect, 0.5))
    const halfFov = Math.min(vFov, hFov) / 2
    const distance = Math.min(Math.max((radius / Math.sin(halfFov)) * 1.15, 6), 180)
    const viewDirection = new THREE.Vector3(0.35, 0.55, 1).normalize()

    this.camera.position.copy(center).addScaledVector(viewDirection, distance)
    this.controls.target.copy(center)
    this.camera.lookAt(center)
    this.controls.update()
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    const pixelRatio = Math.min(window.devicePixelRatio, 2)
    if (width === this.viewportWidth && height === this.viewportHeight && pixelRatio === this.viewportPixelRatio) return
    this.viewportWidth = width
    this.viewportHeight = height
    this.viewportPixelRatio = pixelRatio
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private readonly tick = (now: number): void => {
    if (this.disposed) return
    const delta = Math.min((now - this.lastFrameTime) / 1000, 0.1)
    this.lastFrameTime = now
    this.accumulator += delta

    while (this.accumulator >= this.fixedStep) {
      const nextFrame = this.frameIndex + 1
      let stepResult: StepResult | null = null
      try {
        stepResult = this.autonomousLoop.stepBotAndRules(this.levelHandle)
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        stepResult = { botState: 'exception', goalReached: false, failedEarly: failure }
      }
      this.world?.step(this.eventQueue ?? undefined)
      this.frameIndex = nextFrame
      this.accumulator -= this.fixedStep
      const contacts = this.drainContactEvents()
      this.autonomousLoop.afterPhysicsFrame(
        stepResult,
        this.namedBodies,
        contacts,
      )
    }

    if (this.controls.enabled) {
      this.controls.update()
    }
    this.renderer.render(this.scene, this.camera)
    this.animationFrame = window.requestAnimationFrame(this.tick)
  }

  private disposeObjectTree(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
      else material?.dispose()
    })
  }

  private clearCurrentLevel(): void {
    try {
      this.levelHandle?.dispose()
    } catch (error) {
      console.error('[Argon Engine] Generated level cleanup failed', error)
    }
    if (this.levelRoot) {
      this.scene.remove(this.levelRoot)
      this.disposeObjectTree(this.levelRoot)
    }
    this.world?.free()
    this.levelHandle = null
    this.levelRoot = null
    this.world = null
    this.namedBodies.clear()
  }

  private drainContactEvents(): ContactSnapshot[] {
    const world = this.world
    if (!world) return []

    const namesByBodyHandle = new Map<number, string>()
    this.namedBodies.forEach((body, name) => namesByBodyHandle.set(body.handle, name))
    const contacts: ContactSnapshot[] = []
    this.eventQueue?.drainContactForceEvents((event) => {
      const colliderA = world.getCollider(event.collider1())
      const colliderB = world.getCollider(event.collider2())
      const bodyA = colliderA.parent()
      const bodyB = colliderB.parent()
      contacts.push({
        bodyA: bodyA ? namesByBodyHandle.get(bodyA.handle) ?? `body:${bodyA.handle}` : `collider:${colliderA.handle}`,
        bodyB: bodyB ? namesByBodyHandle.get(bodyB.handle) ?? `body:${bodyB.handle}` : `collider:${colliderB.handle}`,
        totalForce: Number(event.totalForceMagnitude().toFixed(3)),
      })
    })
    return contacts
  }
}
