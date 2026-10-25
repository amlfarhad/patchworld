import type RAPIER from '@dimforge/rapier3d-compat'
import { encodePlaytestPacket, type BrowserMessage, type DaemonMessage, type PlaytestFailedMetadata } from '../shared/protocol'
import { SynchronizedRecorder } from './TelemetryRecorder'
import { InPageSocket } from '../hosted/inPageDaemon'
import { isHosted } from '../hosted/mode'
import type { ContactSnapshot, MountedLevel, StepResult } from './types'

type LoopState = 'idle' | 'running' | 'uploading' | 'awaiting-patch' | 'complete' | 'error' | 'human'

export class AutonomousLoop {
  private socket: WebSocket | null = null
  private recorder: SynchronizedRecorder | null = null
  private state: LoopState = 'idle'
  private runGeneration = 0
  private humanTicks = 0
  /** Reported once per mounted level, so the win banner does not flicker. */
  private humanWon = false
  private runId = ''
  private frameLimit = 240
  private runTicks = 0
  private telemetryFrames = 0
  private enabled = false
  private mountedWhileUploading = false
  /** A level mounted before the socket opened (e.g. after Vite reloaded the page); tell the daemon once registered. */
  private unreportedMount = false
  private reconnectTimer: number | null = null
  private disposed = false
  private readonly listeners = new Set<(state: LoopState) => void>()
  private readonly canvas: HTMLCanvasElement
  private readonly socketUrl: string

  constructor(canvas: HTMLCanvasElement, socketUrl: string = import.meta.env.VITE_ARGON_SYNC_URL ?? 'ws://127.0.0.1:4174') {
    this.canvas = canvas
    this.socketUrl = socketUrl
  }

  connect(): void {
    if (this.disposed || this.socket || typeof WebSocket === 'undefined') return
    // Hosted builds have no local sync daemon; the loop runs in the page instead.
    const socket = isHosted ? new InPageSocket() as unknown as WebSocket : new WebSocket(this.socketUrl)
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'register', role: 'browser' })))
    socket.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => this.handleMessage(event.data))
    socket.addEventListener('error', () => this.setState('error'))
    socket.addEventListener('close', () => {
      if (this.disposed) return
      window.dispatchEvent(new CustomEvent('argon:connection', { detail: false }))
      if (this.state === 'running' || this.state === 'uploading') this.setState('error')
      this.socket = null
      this.reconnectTimer = window.setTimeout(() => this.connect(), 1_000)
    })
    this.socket = socket
  }

  dispose(): void {
    this.disposed = true
    this.runGeneration += 1
    if (this.recorder?.isRecording) void this.recorder.stop().catch(() => {})
    this.recorder = null
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
    this.listeners.clear()
  }

  onStateChange(listener: (state: LoopState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onLevelMounted(): void {
    this.humanWon = false
    this.humanTicks = 0
    this.unreportedMount = !this.send({ type: 'level-mounted' })
    if (this.enabled && this.state === 'awaiting-patch') this.beginRun()
    else if (this.enabled && this.state === 'uploading') this.mountedWhileUploading = true
  }

  get isHumanControlled(): boolean { return this.state === 'human' || this.state === 'complete' }

  takeOver(): void {
    this.enabled = false
    this.runGeneration += 1
    this.mountedWhileUploading = false
    if (this.recorder?.isRecording) void this.recorder.stop().catch(() => {})
    this.recorder = null
    this.send({ type: 'pause-goal' })
    this.setState('human')
  }

  /** Tells the daemon the generated level threw while mounting, so it can repair it or stop the loop. */
  reportMountFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.send({ type: 'level-mount-failed', error: failure.message || String(error), stack: failure.stack })
  }

  startGoal(goal: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      window.dispatchEvent(new CustomEvent('argon:goal-error', { detail: 'Sync daemon is not connected.' }))
      return
    }
    this.takeOver()
    this.enabled = true
    this.setState('awaiting-patch')
    window.dispatchEvent(new CustomEvent('argon:goal-submitted', { detail: goal }))
    this.send({ type: 'start-goal', goal })
  }

  /** Asks the daemon to change the current world rather than build a new one. */
  applyTwist(twist: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      window.dispatchEvent(new CustomEvent('argon:goal-error', { detail: 'Sync daemon is not connected.' }))
      return
    }
    this.takeOver()
    this.enabled = true
    this.setState('awaiting-patch')
    window.dispatchEvent(new CustomEvent('argon:goal-submitted', { detail: { goal: twist, twist: true } }))
    this.send({ type: 'twist', twist })
  }

  stepBotAndRules(level: MountedLevel | null): StepResult | null {
    if (!level) return null
    if (this.isHumanControlled) return level.stepHumanAndRules?.(++this.humanTicks, this.humanTicks / 60) ?? null
    if (this.state !== 'running') return null
    return level.stepBotAndRules(this.runTicks + 1, this.runTicks / 60)
  }

  afterPhysicsFrame(
    result: StepResult | null,
    namedBodies: Map<string, RAPIER.RigidBody>,
    contacts: ContactSnapshot[],
  ): void {
    if (this.state === 'human' && result?.goalReached && !this.humanWon) {
      this.humanWon = true
      window.dispatchEvent(new CustomEvent('argon:human-won', { detail: true }))
    }
    if (this.state !== 'running' || !result) return
    this.runTicks += 1
    const shouldCapture = this.runTicks % 2 === 0 || result.goalReached || Boolean(result.failedEarly)
    if (shouldCapture) {
      this.telemetryFrames += 1
      window.dispatchEvent(new CustomEvent('argon:frame', { detail: { frame: this.telemetryFrames, total: this.frameLimit, bodyCount: namedBodies.size } }))
      this.recorder?.capturePhysicsFrame(this.telemetryFrames, namedBodies, contacts, result.botState)
    }
    if (result.goalReached) {
      void this.finishRun(true)
    } else if (result.failedEarly || this.runTicks >= this.frameLimit * 2) {
      void this.finishRun(false, result.failedEarly ?? `Timed out after ${this.frameLimit} recorded frames`)
    }
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return

    let message: DaemonMessage
    try {
      message = JSON.parse(data) as DaemonMessage
    } catch {
      console.error('[Argon Loop] Invalid message from sync daemon')
      return
    }
    if (message.type === 'start-playtest') {
      this.enabled = true
      this.frameLimit = Math.max(1, Math.min(message.maxFrames ?? 240, 240))
      this.beginRun()
    } else if (message.type === 'patch-rejected') {
      this.setState('awaiting-patch')
      window.dispatchEvent(new CustomEvent('argon:patch-rejected', { detail: message }))
    } else if (message.type === 'daemon-error') {
      console.error('[Argon Loop] Sync daemon error:', message.message)
      this.setState('error')
      window.dispatchEvent(new CustomEvent('argon:goal-error', { detail: message.message }))
    } else if (message.type === 'registered') {
      window.dispatchEvent(new CustomEvent('argon:connection', { detail: { connected: true, mock: message.mock === true } }))
      if (this.unreportedMount) {
        this.unreportedMount = false
        this.send({ type: 'level-mounted' })
      }
    } else if (message.type === 'progress') {
      window.dispatchEvent(new CustomEvent('argon:progress', { detail: message }))
    } else if (message.type === 'goal-error') {
      window.dispatchEvent(new CustomEvent('argon:goal-error', { detail: message.message }))
    } else if (message.type === 'start-goal-accepted') {
      window.dispatchEvent(new CustomEvent('argon:progress', { detail: { phase: 'accepted', message: 'Goal accepted. Starting world synthesis.', timestamp: new Date().toISOString() } }))
    } else if (message.type === 'critique-text') {
      window.dispatchEvent(new CustomEvent('argon:critique-text', { detail: message }))
    } else if (message.type === 'iteration-history') {
      window.dispatchEvent(new CustomEvent('argon:iteration-history', { detail: message }))
    } else if (message.type === 'patch-applied') {
      window.dispatchEvent(new CustomEvent('argon:patch-applied', { detail: message }))
    }
  }

  private send(message: BrowserMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private beginRun(): void {
    if (this.socket?.readyState !== WebSocket.OPEN || this.state === 'running' || this.state === 'uploading') return
    this.runGeneration += 1
    this.runId = crypto.randomUUID()
    this.runTicks = 0
    this.telemetryFrames = 0
    this.recorder = new SynchronizedRecorder(this.canvas)
    try {
      this.recorder.start(30)
      this.setState('running')
    } catch (error) {
      console.error('[Argon Loop] Unable to start synchronized recording', error)
      this.setState('error')
    }
  }

  private async finishRun(goalReached: boolean, failureReason?: string): Promise<void> {
    if (this.state !== 'running' || !this.recorder) return
    this.setState(goalReached ? 'complete' : 'uploading')
    const recorder = this.recorder
    const generation = this.runGeneration
    this.recorder = null

    try {
      const { videoBlob, telemetry } = await recorder.stop()
      if (this.disposed || generation !== this.runGeneration) return
      const videoUrl = URL.createObjectURL(videoBlob)
      window.dispatchEvent(new CustomEvent('argon:video-preview', { detail: { runId: this.runId, videoUrl, failed: !goalReached, failureReason, frameCount: telemetry.length } }))
      if (goalReached) {
        this.send({
          type: 'playtest-passed',
          runId: this.runId,
          frameCount: telemetry.length,
        })
        this.setState('complete')
        return
      }

      const metadata: PlaytestFailedMetadata = {
        type: 'PLAYTEST_FAILED_PAYLOAD',
        runId: this.runId,
        frameCount: telemetry.length,
        failureReason,
        telemetry,
      }
      const videoBytes = new Uint8Array(await videoBlob.arrayBuffer())
      const packet = encodePlaytestPacket(metadata, videoBytes)
      this.socket?.send(packet.buffer as ArrayBuffer)
      this.setState('awaiting-patch')
      if (this.mountedWhileUploading) {
        this.mountedWhileUploading = false
        this.beginRun()
      }
    } catch (error) {
      console.error('[Argon Loop] Unable to finish playtest recording', error)
      this.setState('error')
    }
  }

  private setState(state: LoopState): void {
    this.state = state
    this.listeners.forEach((listener) => listener(state))
    window.dispatchEvent(new CustomEvent('argon:playtest-state', { detail: state }))
  }
}
