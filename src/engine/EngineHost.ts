import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import RAPIER from '@dimforge/rapier3d-compat'
import { AutonomousLoop } from './AutonomousLoop'
import { evaluateLevelGoal } from './goalEvaluator'
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
  private stageRoot: THREE.Group | null = null
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
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
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
    this.setupDefaultStage()
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
      this.enableLevelShadows(nextRoot)
      this.createDefaultGroundCollider(nextWorld)
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
    if (this.stageRoot) {
      this.scene.remove(this.stageRoot)
      this.disposeObjectTree(this.stageRoot)
      this.stageRoot = null
    }
    this.autonomousLoop.dispose()
    this.eventQueue?.free()
    this.renderer.dispose()
  }

  private setupDefaultStage(): void {
    const stage = new THREE.Group()
    stage.name = 'default-stage'

    // Sky dome with smooth gradient
    const skyGeo = new THREE.SphereGeometry(240, 32, 16)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x9bd3f8) },
        horizonColor: { value: new THREE.Color(0xeaf3e9) },
        bottomColor: { value: new THREE.Color(0xd2e4d0) },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPos = worldPosition.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPos;
        void main() {
          float h = normalize(vWorldPos).y;
          vec3 col = h >= 0.0
            ? mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.65))
            : mix(horizonColor, bottomColor, pow(clamp(-h, 0.0, 1.0), 0.65));
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    const skyDome = new THREE.Mesh(skyGeo, skyMat)
    skyDome.name = 'default-sky'
    stage.add(skyDome)

    // Hemisphere + Directional light with shadows
    const hemiLight = new THREE.HemisphereLight(0xdceeff, 0x3b4d3f, 1.4)
    stage.add(hemiLight)

    const sunLight = new THREE.DirectionalLight(0xfff7e8, 2.2)
    sunLight.position.set(18, 32, 20)
    sunLight.castShadow = true
    sunLight.shadow.mapSize.set(2048, 2048)
    sunLight.shadow.camera.near = 1
    sunLight.shadow.camera.far = 120
    const shadowExtent = 35
    sunLight.shadow.camera.left = -shadowExtent
    sunLight.shadow.camera.right = shadowExtent
    sunLight.shadow.camera.top = shadowExtent
    sunLight.shadow.camera.bottom = -shadowExtent
    sunLight.shadow.bias = -0.0005
    stage.add(sunLight)

    // Visual ground slab at y = -0.25 (top surface at y = 0)
    const groundGeo = new THREE.BoxGeometry(120, 0.5, 120)
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xdbe7d8,
      roughness: 0.9,
      metalness: 0.04,
    })
    const groundMesh = new THREE.Mesh(groundGeo, groundMat)
    groundMesh.position.set(0, -0.25, 0)
    groundMesh.receiveShadow = true
    groundMesh.name = 'default-ground'
    stage.add(groundMesh)

    const grid = new THREE.GridHelper(120, 60, 0x99b399, 0xc3d6c2)
    grid.position.set(0, 0.004, 0)
    stage.add(grid)

    this.stageRoot = stage
    this.scene.add(stage)
  }

  private createDefaultGroundCollider(world: RAPIER.World): void {
    const groundBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.25, 0),
    )
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(60, 0.25, 60).setFriction(0.8).setRestitution(0.2),
      groundBody,
    )
  }

  private enableLevelShadows(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = true
        mesh.receiveShadow = true
      }
    })
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
      if (stepResult) {
        const engineGoalReached =
          !stepResult.failedEarly &&
          evaluateLevelGoal(this.levelHandle?.goal, this.namedBodies)
        stepResult = {
          ...stepResult,
          goalReached: engineGoalReached,
        }
      }
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
