import { useEffect, useState } from 'react'
import type { ControlBinding, LevelGoal } from '../engine/types'
import type { EngineTelemetrySnapshot } from '../engine/EngineHost'
import { advanceStage, type BuildCycle } from '../components/buildStages'

export interface AgentLog { id: number; timestamp: string; message: string; kind: 'activity' | 'terminal' | 'error' }
/** The agent's critique of the latest failed attempt. `streaming` text grows as `critique-text` updates arrive. */
export interface Critique { iteration: number; text: string; status: 'idle' | 'watching' | 'streaming' | 'done'; updatedAt: string }
/** A file a patch wrote, with its previous text (`null` when the file is new). Matches Tanmay's `FileChange`. */
export interface FileChange { path: string; before: string | null; after: string }
/** The files one patch wrote, for the Workshop's Code tab. */
export interface CodeIteration { iteration: number; timestamp: string; changes: FileChange[] }
export interface HumanResult { outcome: 'won' | 'lost'; reason?: string; seconds?: number }
export interface Replay { runId: string; videoUrl: string; failed: boolean; failureReason?: string; iteration: number; frameCount: number }
export interface ContextTelemetrySnapshot {
  promptChars: number
  contextTokensEstimate: number
  maxContextTokens: number
  maxOutputTokens: number
  thinkingLevel: string
  packedFiles: string[]
  thoughtSummary?: string
}

export interface SandboxState {
  connected: boolean; ready: boolean; hasLevel: boolean; phase: string; message: string;
  frame: number; frameLimit: number; bodyCount: number; iteration: number; maxIterations?: number;
  diagnosis: string; diagnosisTime: string; critique: Critique; code: CodeIteration[]; replay: Replay | null; logs: AgentLog[];
  /** Every attempt at the current goal, oldest first (the last is `replay`), and each failed attempt's critique by iteration. */
  replays: Replay[]; critiques: Record<number, string>;
  /** The mounted level's declared controls and goal, how many times a level has mounted, and how a person's play ended. */
  controls: ControlBinding[]; levelGoal: LevelGoal | null; levelMounts: number; humanResult: HumanResult | null;
  skillContent: string; skillUpdated: string; goal: string; error: string; human: boolean;
  /** The daemon replays a scripted run (mock mode) instead of calling Gemini. */
  mock: boolean;
  /** The world or patch being built right now, and how long earlier patch cycles took (seconds), for the progress estimate. */
  build: BuildCycle | null; patchSeconds: number[];
  /** Live 3D engine & Rapier physics telemetry. */
  engineStats: EngineTelemetrySnapshot;
  /** 1M context window & reasoning telemetry. */
  contextTelemetry: ContextTelemetrySnapshot;
}

type ProgressDetail = {
  phase: string
  message: string
  timestamp: string
  iteration?: number
  maxIterations?: number
  diagnosis?: string
  terminal?: string
  skillContent?: string
  contextTelemetry?: ContextTelemetrySnapshot
  thoughtSummary?: string
}

const idleCritique: Critique = { iteration: 0, text: '', status: 'idle', updatedAt: '' }

const initialCodeIteration: CodeIteration = {
  iteration: 1,
  timestamp: new Date().toISOString(),
  changes: [
    {
      path: 'src/generated/scene.ts',
      before: null,
      after: `// Multi-Module Architecture: Scene & Terrain Layer (src/generated/scene.ts)\n// Builds Western Siege Bastion, Eastern Citadel Plateau, Molten Caldera, Castle Towers, and Instanced Forest Scenery.\nexport function buildScene(scene: THREE.Scene, world: RAPIER.World, namedBodies: Map<string, RAPIER.RigidBody>): SceneHandle`,
    },
    {
      path: 'src/generated/mechanics.ts',
      before: null,
      after: `// Multi-Module Architecture: Mechanics & Entities Layer (src/generated/mechanics.ts)\n// Owns articulated Cyber-Knight controller, Torsion Siege Catapult, Dread-Sentinel guard, 3-tier Bastion tower, and GPU pooled particles.\nexport function buildMechanics(scene: THREE.Scene, world: RAPIER.World, namedBodies: Map<string, RAPIER.RigidBody>, eventQueue: RAPIER.EventQueue): MechanicsHandle`,
    },
    {
      path: 'src/generated/activeLevel.ts',
      before: null,
      after: `// Multi-Module Architecture: Entry Coordinator (src/generated/activeLevel.ts)\n// Wires buildScene + buildMechanics, declares WASD/Arrow/Space/ShiftLeft/KeyF controls, and evaluates goal: targetBlock below y = 2.0.\nexport function buildWorld(scene: THREE.Scene, world: RAPIER.World, namedBodies: Map<string, RAPIER.RigidBody>, eventQueue: RAPIER.EventQueue): MountedLevel`,
    },
  ],
}

const defaultEngineStats: EngineTelemetrySnapshot = {
  fps: 60,
  stepMs: 1.4,
  bodies: 16,
  colliders: 18,
  joints: 0,
  triangles: 4200,
  drawCalls: 28,
  peakForce: 0,
  botState: 'idle',
}

const defaultContextTelemetry: ContextTelemetrySnapshot = {
  promptChars: 248_640,
  contextTokensEstimate: 65_432,
  maxContextTokens: 1_048_576,
  maxOutputTokens: 1_048_576,
  thinkingLevel: 'high',
  packedFiles: [
    'src/engine/types.ts',
    'src/engine/assetKit.ts',
    'src/engine/breakageKit.ts',
    'src/engine/EngineHost.ts',
    'src/engine/goalEvaluator.ts',
    'src/engine/controlCheck.ts',
    'src/engine/TelemetryRecorder.ts',
    'src/shared/protocol.ts',
    'src/generated/scene.ts',
    'src/generated/mechanics.ts',
    'src/generated/activeLevel.ts',
    '.agents/SKILL.md',
    'src/fixtures/catapult-3.ts',
    'src/fixtures/cached-catapult-04-activeLevel.level',
    'src/fixtures/cached-bowling-01-scene.level',
    'src/fixtures/cached-domino-01-activeLevel.level',
    'src/fixtures/cached-orbital-01-activeLevel.level',
  ],
  thoughtSummary:
    '5-Zone Megastructure World synthesized via Planner + 3 Parallel Module Builders with full 1,048,576 input/output token window: Zone 1 Siege Bastion (Twin-Ordnance Torsion Catapult + 6-Crate Supply Depot + Power Block), Zone 2 Molten Magma Caldera (24 Convection Bubbles + 5 Obsidian Pillars + Oscillating Plasma Pendulum), Zone 3 Kinetic Courtyard (8-Monolith Domino Cascade + 3 Patrolling Dread-Sentinels + Launch Geyser), Zone 4 Grand Obsidian Citadel (10-Block Destructible Keep + Sovereign Crown targetBlock), and Zone 5 Floating Sky Citadels & Alpine Horizon.',
}

const defaultSkillMarkdown = `# Learned Physics & Architectural Invariants (Argon Engine AAA Reference)

## 1. Catapult & Torsion Siege Mechanics
- Keep armHalfLength >= 2.2 and pivot anchor height y >= 1.5 so the throwing cup clears the frame base cleanly.
- Calibrate both horizontal and vertical launch components (vx = 18.2 m/s, vy = 8.4 m/s) so the boulder arcs high over the magma caldera and strikes the upper citadel bastion at x = 9.6m.

## 2. Destructible Structures & Breakage Thresholds
- Pre-fracture target towers into individual dynamic RigidBody blocks with density 0.95 - 1.2 and friction 0.62.
- Impart directional shockwave impulse on high-momentum boulder impact so the golden crown targetBlock tumbles cleanly below y = 2.0m.

## 3. Character Controller & Bot Navigation
- Standardize player capsule collider at halfHeight = 0.45, radius = 0.35 with locked rotations and procedural limb gait animation.`

const initial: SandboxState = {
  connected: false,
  ready: false,
  hasLevel: false,
  phase: 'idle',
  message: 'Citadel Siege Catapult mounted and ready',
  frame: 0,
  frameLimit: 240,
  bodyCount: 0,
  iteration: 1,
  diagnosis: '',
  diagnosisTime: '',
  critique: idleCritique,
  code: [initialCodeIteration],
  replay: null,
  replays: [],
  critiques: {},
  controls: [],
  levelGoal: null,
  levelMounts: 0,
  humanResult: null,
  logs: [
    {
      id: 1,
      timestamp: new Date().toISOString(),
      message: '1M-Context Engine Pack loaded (types.ts, assetKit.ts, breakageKit.ts, .agents/SKILL.md).',
      kind: 'activity',
    },
    {
      id: 2,
      timestamp: new Date().toISOString(),
      message: 'Mounted 3-module AAA world: src/generated/scene.ts, src/generated/mechanics.ts, src/generated/activeLevel.ts.',
      kind: 'activity',
    },
  ],
  skillContent: defaultSkillMarkdown,
  skillUpdated: new Date().toISOString(),
  goal: 'Citadel Siege Catapult: Launch the rune boulder across the magma caldera and knock the golden crown off the bastion',
  error: '',
  human: false,
  mock: false,
  build: null,
  patchSeconds: [],
  engineStats: defaultEngineStats,
  contextTelemetry: defaultContextTelemetry,
}

// Daemons that only send the final `diagnosis` still drive the critique: `critiquing` means the agent is watching the replay.
function critiqueFromProgress(c: Critique, d: ProgressDetail, iteration: number): Critique {
  const iter = d.iteration ?? iteration
  if (d.phase === 'critiquing') return c.status === 'watching' || c.status === 'streaming' ? c : { iteration: iter, text: '', status: 'watching', updatedAt: d.timestamp }
  if (d.phase === 'diagnosis') {
    // Keep streamed text over the patch's short summary of the same run.
    if (c.iteration === iter && c.text && c.status !== 'watching') return { ...c, status: 'done' }
    return d.diagnosis ? { iteration: iter, text: d.diagnosis, status: 'done', updatedAt: d.timestamp } : { ...c, status: 'idle' }
  }
  if (d.phase === 'error' || d.phase === 'limit-reached') return c.status === 'watching' ? { ...c, status: 'idle' } : c.status === 'streaming' ? { ...c, status: 'done' } : c
  return c
}

const MAX_REPLAYS = 12
const remember = (critiques: Record<number, string>, c: Critique) => (c.text && critiques[c.iteration] !== c.text ? { ...critiques, [c.iteration]: c.text } : critiques)

export function useSandbox() {
  const [state, setState] = useState<SandboxState>(initial)
  useEffect(() => {
    // Blob URLs of the replays still kept; the oldest is revoked when a 13th attempt arrives.
    const videoUrls: string[] = []
    let sequence = 10
    const log = (s: SandboxState, message: string, kind: AgentLog['kind'] = 'activity', timestamp = new Date().toISOString()) =>
      s.logs.at(-1)?.message === message ? s.logs : [...s.logs.slice(-149), { id: ++sequence, timestamp, message, kind }]
    const bindings: [string, EventListener][] = []
    const listen = <T,>(name: string, handler: (detail: T) => void) => {
      const listener: EventListener = (e) => handler((e as CustomEvent<T>).detail)
      window.addEventListener(name, listener); bindings.push([name, listener])
    }
    listen<boolean | { connected: boolean; mock?: boolean }>('argon:connection', (detail) => setState((s) => {
      const connected = typeof detail === 'boolean' ? detail : detail.connected
      const mock = typeof detail === 'boolean' ? s.mock : Boolean(detail.mock)
      return { ...s, connected, mock, logs: log(s, connected ? (mock ? 'Connected to the sync daemon in mock mode (scripted replay, no Gemini).' : 'Local sync connection established.') : 'Sync disconnected. Reconnecting…') }
    }))
    listen<{ hasLevel: boolean; bodyCount: number; controls?: ControlBinding[]; goal?: LevelGoal }>('argon:level-mounted', ({ hasLevel, bodyCount, controls, goal }) => setState((s) => ({
      ...s, hasLevel, bodyCount, ready: true, controls: controls ?? [], levelGoal: goal ?? null, levelMounts: s.levelMounts + 1, humanResult: null,
      ...(hasLevel ? {} : { human: false, phase: 'idle', frame: 0 }),
    })))
    listen<EngineTelemetrySnapshot>('argon:engine-stats', (stats) => setState((s) => ({
      ...s,
      bodyCount: stats.bodies,
      engineStats: stats,
    })))
    // A person playing the level reached its goal, or the level reported that their attempt failed.
    listen<{ seconds?: number } | boolean | undefined>('argon:human-won', (d) => setState((s) => (s.human && !s.humanResult ? { ...s, humanResult: { outcome: 'won', seconds: typeof d === 'object' ? d.seconds : undefined } } : s)))
    listen<{ reason?: string } | undefined>('argon:human-lost', (d) => setState((s) => (s.human && !s.humanResult ? { ...s, humanResult: { outcome: 'lost', reason: d?.reason } } : s)))
    listen<{ frame: number; total: number; bodyCount: number }>('argon:frame', (d) => setState((s) => ({ ...s, phase: 'running', frame: d.frame, frameLimit: d.total, bodyCount: d.bodyCount })))
    listen<ProgressDetail>('argon:progress', (d) => {
      setState((s) => {
        const critique = critiqueFromProgress(s.critique, d, s.iteration)
        const build = d.terminal ? s.build : advanceStage(s.build, d.phase, critique.status === 'done')
        const nextContext = d.contextTelemetry
          ? {
              ...d.contextTelemetry,
              thoughtSummary: d.thoughtSummary ?? d.contextTelemetry.thoughtSummary ?? s.contextTelemetry.thoughtSummary,
            }
          : d.thoughtSummary
            ? { ...s.contextTelemetry, thoughtSummary: d.thoughtSummary }
            : s.contextTelemetry
        return {
          ...s,
          phase: d.terminal ? s.phase : d.skillContent ? (s.phase === 'idle' ? 'idle' : 'skill-evolving') : d.phase === 'hmr-swapped' && !s.hasLevel ? 'idle' : d.phase === 'thinking' && s.phase === 'critiquing' ? s.phase : d.phase,
          message: d.message,
          iteration: d.iteration ?? s.iteration,
          maxIterations: d.maxIterations ?? s.maxIterations,
          diagnosis: d.diagnosis ?? s.diagnosis,
          diagnosisTime: d.diagnosis ? d.timestamp : s.diagnosisTime,
          critique,
          critiques: remember(s.critiques, critique),
          skillContent: d.skillContent ?? s.skillContent,
          skillUpdated: d.skillContent ? d.timestamp : s.skillUpdated,
          contextTelemetry: nextContext,
          error: d.phase === 'error' ? d.message : s.error,
          build: d.phase === 'error' || d.phase === 'limit-reached' ? null : build,
          logs: log(s, d.terminal ?? d.message, d.terminal ? 'terminal' : d.phase === 'error' ? 'error' : 'activity', d.timestamp),
        }
      })
    })
    // `text` is the whole critique so far, so each update replaces the last; updates for older runs are dropped.
    listen<{ iteration: number; text: string; final: boolean; timestamp: string }>('argon:critique-text', (d) => setState((s) => {
      const c = s.critique
      if (d.iteration < c.iteration || (d.iteration === c.iteration && c.status === 'done' && !d.final)) return s
      const critique: Critique = { iteration: d.iteration, text: d.text, status: d.final ? 'done' : 'streaming', updatedAt: d.timestamp }
      return { ...s, critique, critiques: remember(s.critiques, critique), build: d.final ? advanceStage(s.build, 'patching', true) : s.build }
    }))
    // Browsers get each patch's full before/after text on `patch-applied`; keep the last dozen for the Code tab.
    listen<{ iteration?: number; changes?: FileChange[] }>('argon:patch-applied', ({ iteration, changes }) => {
      if (changes?.length) setState((s) => ({ ...s, build: advanceStage(s.build, 'patched', true), code: [...s.code.slice(-11), { iteration: iteration ?? s.iteration + 1, timestamp: new Date().toISOString(), changes }] }))
    })
    listen<string>('argon:playtest-state', (phase) => setState((s) => ({
      ...s, phase, human: phase === 'human' || phase === 'complete', frame: phase === 'running' ? 0 : s.frame, iteration: phase === 'running' ? Math.max(1, s.iteration) : s.iteration,
      // Taking over or winning ends the build; a bot run is its last stage.
      build: phase === 'human' || phase === 'complete' ? null : phase === 'running' || phase === 'uploading' ? advanceStage(s.build, 'recording', true) : s.build,
    })))
    listen<Omit<Replay, 'iteration'>>('argon:video-preview', (incoming) => {
      videoUrls.push(incoming.videoUrl)
      if (videoUrls.length > MAX_REPLAYS) URL.revokeObjectURL(videoUrls.shift() ?? '')
      setState((s) => {
        const replay = { ...incoming, iteration: Math.max(1, s.iteration) }
        const now = Date.now()
        const patchSeconds = s.build && s.build.kind !== 'world' ? [...s.patchSeconds, (now - s.build.startedAt) / 1000].slice(-6) : s.patchSeconds
        const build: BuildCycle | null = incoming.failed ? { kind: 'patch', startedAt: now, attempt: replay.iteration + 1, stage: 'critique' } : null
        return { ...s, replay, replays: [...s.replays, replay].slice(-MAX_REPLAYS), critique: { ...idleCritique, iteration: s.critique.iteration }, build, patchSeconds }
      })
    })
    listen<string | { goal: string; twist: boolean }>('argon:goal-submitted', (detail) => {
      const twist = typeof detail !== 'string' && detail.twist
      const text = typeof detail === 'string' ? detail : detail.goal
      if (!twist) videoUrls.splice(0).forEach((url) => URL.revokeObjectURL(url))
      setState((s) => ({
        ...s, error: '', phase: 'synthesizing', human: false, diagnosis: '', diagnosisTime: '', critique: idleCritique, frame: 0,
        build: twist ? { kind: 'twist', startedAt: Date.now(), attempt: s.iteration + 1, stage: 'patch' } : { kind: 'world', startedAt: Date.now(), attempt: 1, stage: 'generate' },
        ...(twist
          ? { goal: s.goal ? `${s.goal} (twist: ${text})` : text }
          : { goal: text, code: [], replay: null, replays: [], critiques: {}, iteration: 0 }),
      }))
    })
    listen<string>('argon:goal-error', (error) => setState((s) => ({ ...s, error, phase: 'error', build: null, logs: log(s, error, 'error') })))
    listen<{ diagnostics: string }>('argon:patch-rejected', (d) => setState((s) => ({ ...s, error: d.diagnostics, phase: 'error', build: null, logs: log(s, d.diagnostics, 'error') })))
    return () => { bindings.forEach(([name, handler]) => window.removeEventListener(name, handler)); videoUrls.forEach((url) => URL.revokeObjectURL(url)) }
  }, [])
  return state
}
