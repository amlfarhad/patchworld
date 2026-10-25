import type { GeneratedLevelModule } from '../engine/types'
import { decodePlaytestPacket, type DaemonMessage, type FileChange, type GeneratedFilePayload, type IterationEntry } from '../shared/protocol'
import { loadGeneratedLevel } from './moduleLoader'
import { DemoOrchestrator, LiveOrchestrator, type HostedEvent, type HostedOrchestrator, type HostedPatch } from './orchestratorClients'

/**
 * The hosted build's stand-in for server/syncDaemon.ts. It runs the same goal → playtest →
 * critique → patch loop inside the page and talks to AutonomousLoop through a socket-shaped
 * object, so the engine and UI code are shared with the local build. Generated levels are
 * compiled and mounted directly instead of being written to disk for Vite to hot-reload.
 */

/** Attempts per goal. Each critique continues the same Gemini conversation, so later attempts see every earlier one. */
const maxIterations = 8
const mountTimeoutMs = 15_000
const passcodeKey = 'patchworld.livePasscode'
const modeKey = 'patchworld.mode'

export type HostedMode = 'live' | 'demo'
let memoryMode: HostedMode | null = null

/** Live is the default; Demo is an explicit choice that replays the recorded catapult run. */
export function getHostedMode(): HostedMode {
  try {
    return localStorage.getItem(modeKey) === 'demo' ? 'demo' : 'live'
  } catch {
    return memoryMode ?? 'live'
  }
}

export function setHostedMode(mode: HostedMode): void {
  memoryMode = mode
  try { localStorage.setItem(modeKey, mode) } catch { /* storage unavailable; the choice lasts for this page only */ }
  window.dispatchEvent(new CustomEvent('patchworld:mode-changed'))
}

type Mounter = (module: GeneratedLevelModule) => Promise<void>
let mounter: Mounter | null = null

/** The viewport registers how to mount a module into the persistent engine. */
export function setHostedMounter(mount: Mounter | null): void {
  mounter = mount
}

export function getLivePasscode(): string {
  try { return localStorage.getItem(passcodeKey) ?? '' } catch { return '' }
}

export function setLivePasscode(passcode: string): void {
  try {
    if (passcode) localStorage.setItem(passcodeKey, passcode)
    else localStorage.removeItem(passcodeKey)
  } catch { /* storage unavailable; the passcode lasts for this page only */ }
  window.dispatchEvent(new CustomEvent('patchworld:mode-changed'))
}

class InPageDaemon {
  private goalEpoch = 0
  private activeGoal = ''
  private worldGoal = ''
  private iteration = 0
  private previousInteractionId: string | undefined
  private awaitingLevelMount = false
  private mountWatchdog: ReturnType<typeof setTimeout> | undefined
  private history: IterationEntry[] = []
  private currentFiles: GeneratedFilePayload[] = []
  private skillContent = ''
  private controller = new AbortController()

  private readonly deliver: (message: DaemonMessage) => void

  constructor(deliver: (message: DaemonMessage) => void) {
    this.deliver = deliver
  }

  get mock(): boolean {
    return getHostedMode() === 'demo'
  }

  private orchestrator(): HostedOrchestrator {
    return this.mock ? this.demo : new LiveOrchestrator(getLivePasscode())
  }

  /** The Gemini conversation to continue. Demo patches never set one (see applyPatch), so a demo-N id never reaches Gemini. */
  private chainId(): string | undefined {
    return this.mock ? undefined : this.previousInteractionId
  }

  private readonly demo = new DemoOrchestrator()

  private progress(event: HostedEvent): void {
    const timestamp = new Date().toISOString()
    if (event.critiqueText !== undefined) {
      this.deliver({ type: 'critique-text', iteration: event.iteration ?? this.iteration, text: event.critiqueText, final: event.critiqueFinal ?? false, timestamp })
      return
    }
    this.deliver({ type: 'progress', iteration: this.iteration, maxIterations, ...event, timestamp })
  }

  private publishHistory(): void {
    this.deliver({ type: 'iteration-history', goal: this.worldGoal, entries: this.history })
  }

  private settleLatest(outcome: IterationEntry['outcome'], details: Pick<IterationEntry, 'runId' | 'failureReason'> = {}): void {
    const latest = this.history.at(-1)
    if (!latest || latest.outcome !== 'pending') return
    this.history = [...this.history.slice(0, -1), { ...latest, outcome, ...details }]
    this.publishHistory()
  }

  private newEpoch(): number {
    this.controller.abort()
    this.controller = new AbortController()
    this.clearWatchdog()
    this.awaitingLevelMount = false
    return ++this.goalEpoch
  }

  private clearWatchdog(): void {
    if (this.mountWatchdog) clearTimeout(this.mountWatchdog)
    this.mountWatchdog = undefined
  }

  private emitter(epoch: number) {
    return (event: HostedEvent) => { if (epoch === this.goalEpoch) this.progress(event) }
  }

  private fail(error: unknown, epoch: number): void {
    if (epoch !== this.goalEpoch) return
    if (error instanceof DOMException && error.name === 'AbortError') return
    this.awaitingLevelMount = false
    this.clearWatchdog()
    this.activeGoal = ''
    const message = error instanceof Error ? error.message : String(error)
    this.deliver({ type: 'goal-error', message })
    this.progress({ phase: 'error', message, iteration: this.iteration })
  }

  /** Compiles a patch, records it, and mounts it; the engine reports the mount back as level-mounted. */
  private async applyPatch(patch: HostedPatch, epoch: number): Promise<void> {
    if (epoch !== this.goalEpoch) return
    const module = await loadGeneratedLevel(patch.files)
    if (epoch !== this.goalEpoch) return
    const before = new Map(this.currentFiles.map((file) => [file.path, file.content]))
    const changes: FileChange[] = patch.files.map((file) => ({ path: file.path, before: before.get(file.path) ?? null, after: file.content }))
    const merged = new Map(this.currentFiles.map((file) => [file.path, file.content]))
    patch.files.forEach((file) => merged.set(file.path, file.content))
    this.currentFiles = [...merged].map(([path, content]) => ({ path, content }))
    this.iteration += 1
    // A demo patch replaces the level Gemini last saw, so the next live call starts a fresh conversation.
    this.previousInteractionId = patch.interactionId.startsWith('demo-') ? undefined : patch.interactionId
    this.history = [...this.history, { iteration: this.iteration, outcome: 'pending', files: patch.files.map((file) => file.path), diagnosis: patch.diagnosis, timestamp: new Date().toISOString() }]
    this.publishHistory()
    this.deliver({ type: 'patch-applied', files: patch.files.map((file) => file.path), iteration: this.iteration, changes })
    if (patch.skillContent?.trim()) {
      this.skillContent = patch.skillContent
      this.progress({ phase: 'skill-evolving', message: 'Learned physics invariants updated.', skillContent: this.skillContent } as HostedEvent & { skillContent: string })
    }
    this.awaitingLevelMount = true
    this.mountWatchdog = setTimeout(() => {
      if (epoch === this.goalEpoch && this.awaitingLevelMount) void this.handleMountFailure('The updated level did not finish loading within 15 s.')
    }, mountTimeoutMs)
    this.progress({ phase: 'hmr-pending', message: 'Patch compiled; mounting the updated level.', iteration: this.iteration })
    if (!mounter) throw new Error('The engine is not ready to mount levels yet.')
    try {
      await mounter(module)
    } catch (error) {
      if (epoch !== this.goalEpoch) return
      await this.handleMountFailure(error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined)
    }
  }

  private async startGoal(goal: string): Promise<void> {
    const text = goal.trim()
    if (!text || text.length > 2_000) {
      this.deliver({ type: 'goal-error', message: 'Enter a level goal between 1 and 2,000 characters.' })
      return
    }
    const epoch = this.newEpoch()
    this.activeGoal = text
    this.worldGoal = text
    this.iteration = 0
    this.previousInteractionId = undefined
    this.history = []
    this.publishHistory()
    this.deliver({ type: 'start-goal-accepted', goal: text })
    try {
      const patch = await this.orchestrator().generate(text, this.emitter(epoch), this.controller.signal)
      await this.applyPatch(patch, epoch)
    } catch (error) {
      this.fail(error, epoch)
    }
  }

  private async startTwist(twist: string): Promise<void> {
    const text = twist.trim()
    if (!text || text.length > 800) {
      this.deliver({ type: 'goal-error', message: 'Enter a twist between 1 and 800 characters.' })
      return
    }
    if (!this.worldGoal || this.currentFiles.length === 0) return this.startGoal(text)
    const baseGoal = this.worldGoal
    const epoch = this.newEpoch()
    this.settleLatest('abandoned')
    this.activeGoal = `${baseGoal} Twist: ${text}`
    this.worldGoal = this.activeGoal
    this.deliver({ type: 'start-goal-accepted', goal: this.activeGoal })
    try {
      const patch = await this.orchestrator().revise({ goal: baseGoal, twist: text, currentFiles: this.currentFiles, previousInteractionId: this.chainId() }, this.emitter(epoch), this.controller.signal)
      await this.applyPatch(patch, epoch)
    } catch (error) {
      this.fail(error, epoch)
    }
  }

  private async critique(packetBytes: Uint8Array): Promise<void> {
    const packet = decodePlaytestPacket(packetBytes)
    if (this.history.at(-1)?.outcome !== 'pending') return
    this.settleLatest('failed', { runId: packet.metadata.runId, failureReason: packet.metadata.failureReason })
    if (!this.activeGoal) return
    const epoch = this.goalEpoch
    if (this.iteration >= maxIterations) {
      this.activeGoal = ''
      this.progress({ phase: 'limit-reached', message: 'Iteration limit reached. Review the replay, take over, or start a new goal.' })
      return
    }
    try {
      this.progress({ phase: 'critiquing', message: this.mock ? 'Demo critic is replaying a recorded review.' : 'The critic is reviewing the video and frame telemetry.', iteration: this.iteration })
      const patch = await this.orchestrator().critique({
        videoBytes: packet.videoBytes,
        metadata: packet.metadata,
        currentFiles: this.currentFiles,
        previousInteractionId: this.chainId(),
        iteration: this.iteration,
      }, this.emitter(epoch), this.controller.signal)
      if (epoch !== this.goalEpoch) return
      this.progress({ phase: 'diagnosis', message: patch.diagnosis ?? 'Patch is ready for the next playtest.', diagnosis: patch.diagnosis, iteration: this.iteration })
      await this.applyPatch(patch, epoch)
    } catch (error) {
      this.fail(error, epoch)
    }
  }

  private async handleMountFailure(error: string, stack?: string): Promise<void> {
    this.clearWatchdog()
    const wasAwaiting = this.awaitingLevelMount
    this.awaitingLevelMount = false
    if (!wasAwaiting) {
      this.progress({ phase: 'error', message: `The level threw while loading: ${error}`, iteration: this.iteration })
      return
    }
    this.settleLatest('mount-failed', { failureReason: error })
    const epoch = this.goalEpoch
    if (!this.activeGoal || this.iteration >= maxIterations) {
      this.fail(new Error(`Generated level failed to load: ${error}`), epoch)
      return
    }
    try {
      this.progress({ phase: 'critiquing', message: 'The level crashed while loading; asking for a repair.', iteration: this.iteration })
      const patch = await this.orchestrator().repair({ error, stack, currentFiles: this.currentFiles, previousInteractionId: this.chainId(), iteration: this.iteration }, this.emitter(epoch), this.controller.signal)
      await this.applyPatch(patch, epoch)
    } catch (repairError) {
      this.fail(repairError, epoch)
    }
  }

  receive(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      void this.critique(bytes).catch((error) => this.fail(error, this.goalEpoch))
      return
    }
    const message = JSON.parse(data) as { type: string; goal?: string; twist?: string; runId?: string; error?: string; stack?: string }
    switch (message.type) {
      case 'register':
        this.deliver({ type: 'registered', role: 'browser', mock: this.mock })
        if (this.history.length > 0) this.publishHistory()
        if (this.skillContent) this.progress({ phase: 'skill-evolving', message: 'Learned physics invariants.', skillContent: this.skillContent } as HostedEvent & { skillContent: string })
        break
      case 'start-goal':
        if (typeof message.goal === 'string') void this.startGoal(message.goal)
        break
      case 'twist':
        if (typeof message.twist === 'string') void this.startTwist(message.twist)
        break
      case 'pause-goal':
        this.newEpoch()
        this.activeGoal = ''
        this.settleLatest('abandoned')
        this.progress({ phase: 'human', message: 'Autonomous loop paused. Human control enabled.' })
        break
      case 'level-mounted':
        this.clearWatchdog()
        this.deliver({ type: 'progress', phase: 'hmr-swapped', message: 'Updated physics module mounted live.', timestamp: new Date().toISOString(), iteration: this.iteration })
        if (this.awaitingLevelMount) {
          this.awaitingLevelMount = false
          this.deliver({ type: 'start-playtest', maxFrames: 240 })
          this.progress({ phase: 'recording', message: 'Recording the 8-second autonomous bot playtest.', iteration: this.iteration })
        }
        break
      case 'level-mount-failed':
        void this.handleMountFailure(message.error ?? 'Unknown error', message.stack)
        break
      case 'playtest-passed':
        if (this.history.at(-1)?.outcome !== 'pending') break
        this.settleLatest('passed', { runId: message.runId })
        this.activeGoal = ''
        this.progress({ phase: 'complete', message: 'Goal reached. Human controls are available.' })
        break
      default:
        this.deliver({ type: 'daemon-error', message: `Unknown message type ${message.type}` })
    }
  }
}

/** A WebSocket-shaped connection to the in-page daemon, used by AutonomousLoop in hosted builds. */
export class InPageSocket extends EventTarget {
  static readonly OPEN = 1
  readonly OPEN = 1
  readyState = 0
  binaryType: BinaryType = 'arraybuffer'
  private readonly daemon = new InPageDaemon((message) => {
    if (this.readyState !== 1) return
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })))
  })

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) return
    this.daemon.receive(data)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close'))
  }
}
