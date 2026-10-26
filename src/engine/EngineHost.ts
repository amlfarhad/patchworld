import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import RAPIER from '@dimforge/rapier3d-compat'
import { AutonomousLoop } from './AutonomousLoop'
import { getProceduralNoiseTexture } from './assetKit'
import { checkDeclaredControls } from './controlCheck'
import { evaluateLevelGoal } from './goalEvaluator'
import type { ContactSnapshot, ControlBinding, GeneratedLevelModule, MountedLevel, StepResult } from './types'

const rapierReady = RAPIER.init()

export type CameraDirectorMode = 'overview' | 'follow' | 'cinematic' | 'citadel'

export interface EngineTelemetrySnapshot {
  fps: number
  stepMs: number
  bodies: number
  colliders: number
  joints: number
  triangles: number
  drawCalls: number
  peakForce: number
  botState: string
  cameraMode?: CameraDirectorMode
}

export class EngineHost {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500)
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls
  readonly namedBodies = new Map<string, RAPIER.RigidBody>()
  readonly autonomousLoop: AutonomousLoop
  readonly isSoftwareGl: boolean

  private readonly canvas: HTMLCanvasElement
  private currentModule: GeneratedLevelModule | null = null
  private eventQueue: RAPIER.EventQueue | null = null
  private world: RAPIER.World | null = null
  private levelHandle: MountedLevel | null = null
  private levelRoot: THREE.Group | null = null
  private stageRoot: THREE.Group | null = null
  private envRenderTarget: THREE.WebGLRenderTarget | null = null
  private unsubscribeLoopState: (() => void) | null = null
  private animationFrame = 0
  private paceTimer = 0
  private frameIndex = 0
  private accumulator = 0
  private lastFrameTime = 0
  private lastStatsEmitTime = 0
  private smoothedFps = 60
  private lastStepMs = 0.4
  private peakForce = 0
  private latestBotState = 'ready'
  private cameraTrauma = 0
  private cameraMode: CameraDirectorMode = 'overview'
  private disposed = false
  private viewportWidth = 0
  private viewportHeight = 0
  private viewportPixelRatio = 0
  private readonly fixedStep = 1 / 60

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.autonomousLoop = new AutonomousLoop(canvas, undefined, () => this.checkControls())
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })

    const gl = this.renderer.getContext()
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const rendererInfo = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
    this.isSoftwareGl = /SwiftShader|llvmpipe|Software/i.test(rendererInfo)

    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0xeaf3e9)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.08
    this.renderer.shadowMap.enabled = !this.isSoftwareGl
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer)
    const roomEnvironment = new RoomEnvironment()
    this.envRenderTarget = pmremGenerator.fromScene(roomEnvironment, 0.04)
    this.scene.environment = this.envRenderTarget.texture
    roomEnvironment.dispose()
    pmremGenerator.dispose()

    this.scene.fog = new THREE.FogExp2(0xe4efe3, 0.0038)

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
    window.addEventListener('argon:camera-mode', this.handleCameraModeEvent as EventListener)
  }

  private readonly handleCameraModeEvent = (event: CustomEvent<CameraDirectorMode>): void => {
    const mode = event.detail
    if (mode === 'overview' || mode === 'follow' || mode === 'cinematic' || mode === 'citadel') {
      this.setCameraMode(mode)
    }
  }

  public setCameraMode(mode: CameraDirectorMode): void {
    this.cameraMode = mode
    if (mode === 'overview') {
      this.frameLevelBounds()
    } else if (mode === 'citadel') {
      const targetBody = this.namedBodies.get('targetBlock') ?? this.namedBodies.get('tower-b5')
      const focus = targetBody
        ? new THREE.Vector3(targetBody.translation().x, 4.2, targetBody.translation().z)
        : new THREE.Vector3(18, 4.2, 0)
      this.controls.target.copy(focus)
      this.camera.position.set(focus.x - 11, focus.y + 7.5, focus.z + 16)
      this.camera.lookAt(focus)
      this.controls.update()
    }
    this.emitEngineTelemetry(performance.now(), true)
  }

  async initialize(levelModule: GeneratedLevelModule): Promise<void> {
    await rapierReady
    if (this.disposed) return
    this.eventQueue = new RAPIER.EventQueue(true)
    // Connect and start rendering before mounting, so a broken generated level left on disk
    // cannot keep the page offline after a reload.
    this.autonomousLoop.connect()
    this.lastFrameTime = performance.now()
    this.scheduleNextFrame()
    await this.mountLevel(levelModule)
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
    this.peakForce = 0
    this.cameraTrauma = 0
    this.latestBotState = 'mounted'
    this.currentModule = levelModule
    this.frameLevelBounds()
    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera)
    }
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
    this.emitEngineTelemetry(performance.now(), true)
    this.autonomousLoop.onLevelMounted()
  }

  dispatchPointerOrKey(event: { type: string; key?: string; code?: string; ndc?: [number, number] }): void {
    if (this.autonomousLoop.isHumanControlled) this.levelHandle?.onPointerOrKey?.(event)
  }

  checkControls(levelModule: GeneratedLevelModule | null = this.currentModule): ControlBinding[] {
    if (!levelModule) return []
    return checkDeclaredControls(levelModule)
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
    window.clearTimeout(this.paceTimer)
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('argon:camera-mode', this.handleCameraModeEvent as EventListener)
    this.unsubscribeLoopState?.()
    this.unsubscribeLoopState = null
    this.controls.dispose()
    this.clearCurrentLevel()
    if (this.stageRoot) {
      this.scene.remove(this.stageRoot)
      this.disposeObjectTree(this.stageRoot)
      this.stageRoot = null
    }
    this.scene.environment = null
    this.envRenderTarget?.dispose()
    this.envRenderTarget = null
    this.autonomousLoop.dispose()
    this.eventQueue?.free()
    this.renderer.dispose()
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return
    if (this.isSoftwareGl) {
      this.paceTimer = window.setTimeout(() => {
        if (!this.disposed) {
          this.animationFrame = window.requestAnimationFrame(this.tick)
        }
      }, 16)
    } else {
      this.animationFrame = window.requestAnimationFrame(this.tick)
    }
  }

  private setupDefaultStage(): void {
    const stage = new THREE.Group()
    stage.name = 'default-stage'

    // Sky dome with smooth gradient and atmospheric scattering halo
    const skyGeo = new THREE.SphereGeometry(240, 32, 16)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x88c9f9) },
        horizonColor: { value: new THREE.Color(0xeaf3e9) },
        bottomColor: { value: new THREE.Color(0xcde2cb) },
        sunDir: { value: new THREE.Vector3(18, 32, 20).normalize() },
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
        uniform vec3 sunDir;
        varying vec3 vWorldPos;
        void main() {
          vec3 dir = normalize(vWorldPos);
          float h = dir.y;
          vec3 col = h >= 0.0
            ? mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.62))
            : mix(horizonColor, bottomColor, pow(clamp(-h, 0.0, 1.0), 0.65));
          float sunGlow = pow(max(dot(dir, sunDir), 0.0), 24.0);
          col += vec3(1.0, 0.94, 0.78) * sunGlow * 0.28;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    const skyDome = new THREE.Mesh(skyGeo, skyMat)
    skyDome.name = 'default-sky'
    stage.add(skyDome)

    // 3-Point Studio Lighting: Hemisphere Fill + Warm Key Light + Cool Rim Backlight
    const hemiLight = new THREE.HemisphereLight(0xdceeff, 0x3b4d3f, 1.42)
    stage.add(hemiLight)

    const sunLight = new THREE.DirectionalLight(0xfff6e5, 2.35)
    sunLight.position.set(18, 32, 20)
    sunLight.castShadow = !this.isSoftwareGl
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

    const rimLight = new THREE.DirectionalLight(0x7dd3fc, 0.85)
    rimLight.position.set(-22, 18, -24)
    stage.add(rimLight)

    // Visual ground slab at y = -0.25 (top surface at y = 0) with procedural micro-relief
    const stoneBump = getProceduralNoiseTexture('stone', 128)
    stoneBump.repeat.set(18, 18)
    const groundGeo = new THREE.BoxGeometry(120, 0.5, 120)
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xdbe7d8,
      roughness: 0.86,
      metalness: 0.05,
      bumpMap: stoneBump,
      bumpScale: 0.012,
    })
    const groundMesh = new THREE.Mesh(groundGeo, groundMat)
    groundMesh.position.set(0, -0.25, 0)
    groundMesh.receiveShadow = true
    groundMesh.name = 'default-ground'
    stage.add(groundMesh)

    const grid = new THREE.GridHelper(120, 60, 0x99b399, 0xc3d6c2)
    grid.position.set(0, 0.004, 0)
    stage.add(grid)

    // Distant procedural mountain range & snow-capped peaks around the horizon
    const mountainMat = new THREE.MeshStandardMaterial({
      color: 0x94a89b,
      roughness: 0.92,
      metalness: 0.04,
    })
    const snowMat = new THREE.MeshStandardMaterial({
      color: 0xf1f7f0,
      roughness: 0.65,
      metalness: 0.05,
    })
    const peakCount = 28
    for (let i = 0; i < peakCount; i++) {
      const angle = (i / peakCount) * Math.PI * 2
      const dist = 76 + ((i * 17) % 19)
      const h = 16 + ((i * 23) % 18)
      const r = 10 + ((i * 11) % 9)
      const mx = Math.cos(angle) * dist
      const mz = Math.sin(angle) * dist
      const peak = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mountainMat)
      peak.position.set(mx, h * 0.42, mz)
      peak.rotation.y = i * 0.7
      stage.add(peak)

      const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.44, h * 0.36, 7), snowMat)
      cap.position.set(mx, h * 0.73, mz)
      cap.rotation.y = i * 0.7
      stage.add(cap)
    }

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
        mesh.castShadow = !this.isSoftwareGl
        mesh.receiveShadow = !this.isSoftwareGl
      }
    })
  }

  public frameLevelBounds(): void {
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

    // Clamp extreme scatter bounds so camera focuses tightly on the playable arena
    box.min.max(new THREE.Vector3(-28, -4, -18))
    box.max.min(new THREE.Vector3(28, 16, 18))

    const sphere = new THREE.Sphere()
    box.getBoundingSphere(sphere)
    const center = sphere.center
    const radius = Math.max(sphere.radius, 2.5)
    const vFov = THREE.MathUtils.degToRad(this.camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(this.camera.aspect, 0.5))
    const halfFov = Math.min(vFov, hFov) / 2
    const distance = Math.min(Math.max((radius / Math.sin(halfFov)) * 0.88, 6), 56)
    const viewDirection = new THREE.Vector3(0.24, 0.50, 1).normalize()

    this.camera.position.copy(center).addScaledVector(viewDirection, distance)
    this.controls.target.copy(center)
    this.camera.lookAt(center)
    this.controls.update()
  }

  private readonly resize = (): void => {
    const width = Math.max(1, this.canvas.clientWidth)
    const height = Math.max(1, this.canvas.clientHeight)
    const pixelRatio = this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2)
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
    const rawDelta = (now - this.lastFrameTime) / 1000
    const delta = Math.min(Math.max(rawDelta, 0.001), 0.05)
    this.lastFrameTime = now
    this.smoothedFps = this.smoothedFps * 0.9 + (1 / Math.max(rawDelta, 0.004)) * 0.1
    this.accumulator += delta

    while (this.accumulator >= this.fixedStep) {
      const stepStart = performance.now()
      const nextFrame = this.frameIndex + 1
      let stepResult: StepResult | null = null
      try {
        stepResult = this.autonomousLoop.stepBotAndRules(this.levelHandle)
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error)
        stepResult = { botState: 'exception', goalReached: false, failedEarly: failure }
      }
      this.world?.step(this.eventQueue ?? undefined)
      this.lastStepMs = performance.now() - stepStart
      this.frameIndex = nextFrame
      this.accumulator -= this.fixedStep
      const contacts = this.drainContactEvents()
      for (const c of contacts) {
        if (c.totalForce > this.peakForce) this.peakForce = c.totalForce
        if (c.totalForce > 35) {
          this.cameraTrauma = Math.min(1, this.cameraTrauma + Math.min(0.45, c.totalForce / 220))
        }
      }
      if (stepResult) {
        this.latestBotState = stepResult.botState
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

    if (this.cameraMode === 'follow') {
      const tracked = this.namedBodies.get('player') ?? this.namedBodies.get('boulder')
      if (tracked) {
        const tp = tracked.translation()
        const desiredTarget = new THREE.Vector3(tp.x + 2.5, Math.max(1.8, tp.y + 1.2), tp.z)
        const desiredCam = new THREE.Vector3(tp.x - 6.5, Math.max(5.5, tp.y + 5.2), tp.z + 13.5)
        this.controls.target.lerp(desiredTarget, 0.08)
        this.camera.position.lerp(desiredCam, 0.08)
        this.camera.lookAt(this.controls.target)
      }
    } else if (this.cameraMode === 'cinematic') {
      const angle = now * 0.00028
      const radius = 34
      this.controls.target.lerp(new THREE.Vector3(2, 3.2, 0), 0.05)
      this.camera.position.set(
        Math.sin(angle) * radius + 2,
        14.5 + Math.sin(angle * 2) * 2.5,
        Math.cos(angle) * radius,
      )
      this.camera.lookAt(this.controls.target)
    } else if (this.controls.enabled) {
      this.controls.update()
    }

    // Apply decaying trauma^2 rotational shake on heavy physics impacts
    if (this.cameraTrauma > 0.001) {
      const shake = this.cameraTrauma * this.cameraTrauma * 0.014
      this.camera.rotation.z += Math.sin(now * 0.045) * shake
      this.cameraTrauma = Math.max(0, this.cameraTrauma - delta * 2.4)
    }

    this.renderer.render(this.scene, this.camera)
    this.emitEngineTelemetry(now, false)
    this.scheduleNextFrame()
  }

  private emitEngineTelemetry(now: number, force: boolean): void {
    if (!force && now - this.lastStatsEmitTime < 250) return
    this.lastStatsEmitTime = now
    const detail: EngineTelemetrySnapshot = {
      fps: Math.min(60, Math.max(1, Math.round(this.smoothedFps))),
      stepMs: Number(this.lastStepMs.toFixed(2)),
      bodies: this.namedBodies.size,
      colliders: this.world?.colliders.len() ?? 0,
      joints: this.world?.impulseJoints.len() ?? 0,
      triangles: this.renderer.info.render.triangles,
      drawCalls: this.renderer.info.render.calls,
      peakForce: Math.round(this.peakForce),
      botState: this.latestBotState,
      cameraMode: this.cameraMode,
    }
    window.dispatchEvent(new CustomEvent('argon:engine-stats', { detail }))
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
