import { useEffect, useState } from 'react'
import type { ControlBinding, LevelGoal } from '../engine/types'

export interface AgentLog { id: number; timestamp: string; message: string; kind: 'activity' | 'terminal' | 'error' }
/** The agent's critique of the latest failed attempt. `streaming` text grows as `critique-text` updates arrive. */
export interface Critique { iteration: number; text: string; status: 'idle' | 'watching' | 'streaming' | 'done'; updatedAt: string }
/** A file a patch wrote, with its previous text (`null` when the file is new). Matches Tanmay's `FileChange`. */
export interface FileChange { path: string; before: string | null; after: string }
/** The files one patch wrote, for the Workshop's Code tab. */
export interface CodeIteration { iteration: number; timestamp: string; changes: FileChange[] }
export interface HumanResult { outcome: 'won' | 'lost'; reason?: string; seconds?: number }
export interface Replay { runId: string; videoUrl: string; failed: boolean; failureReason?: string; iteration: number; frameCount: number }
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
}
type ProgressDetail = { phase: string; message: string; timestamp: string; iteration?: number; maxIterations?: number; diagnosis?: string; terminal?: string; skillContent?: string }
const idleCritique: Critique = { iteration: 0, text: '', status: 'idle', updatedAt: '' }
const initial: SandboxState = {
  connected: false, ready: false, hasLevel: false, phase: 'idle', message: 'Ready for your first world',
  frame: 0, frameLimit: 240, bodyCount: 0, iteration: 0, diagnosis: '', diagnosisTime: '',
  critique: idleCritique, code: [], replay: null, replays: [], critiques: {}, controls: [], levelGoal: null, levelMounts: 0, humanResult: null, logs: [], skillContent: '', skillUpdated: '', goal: '', error: '', human: false, mock: false,
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
    let sequence = 0
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
    // A person playing the level reached its goal, or the level reported that their attempt failed.
    listen<{ seconds?: number } | boolean | undefined>('argon:human-won', (d) => setState((s) => (s.human && !s.humanResult ? { ...s, humanResult: { outcome: 'won', seconds: typeof d === 'object' ? d.seconds : undefined } } : s)))
    listen<{ reason?: string } | undefined>('argon:human-lost', (d) => setState((s) => (s.human && !s.humanResult ? { ...s, humanResult: { outcome: 'lost', reason: d?.reason } } : s)))
    listen<{ frame: number; total: number; bodyCount: number }>('argon:frame', (d) => setState((s) => ({ ...s, phase: 'running', frame: d.frame, frameLimit: d.total, bodyCount: d.bodyCount })))
    listen<ProgressDetail>('argon:progress', (d) => {
      setState((s) => { const critique = critiqueFromProgress(s.critique, d, s.iteration); return {
        ...s, phase: d.terminal ? s.phase : d.skillContent ? (s.phase === 'idle' ? 'idle' : 'skill-evolving') : d.phase === 'hmr-swapped' && !s.hasLevel ? 'idle' : d.phase === 'thinking' && s.phase === 'critiquing' ? s.phase : d.phase,
        message: d.message, iteration: d.iteration ?? s.iteration, maxIterations: d.maxIterations ?? s.maxIterations,
        diagnosis: d.diagnosis ?? s.diagnosis, diagnosisTime: d.diagnosis ? d.timestamp : s.diagnosisTime, critique, critiques: remember(s.critiques, critique),
        skillContent: d.skillContent ?? s.skillContent, skillUpdated: d.skillContent ? d.timestamp : s.skillUpdated,
        error: d.phase === 'error' ? d.message : s.error,
        logs: log(s, d.terminal ?? d.message, d.terminal ? 'terminal' : d.phase === 'error' ? 'error' : 'activity', d.timestamp),
      } })
    })
    // `text` is the whole critique so far, so each update replaces the last; updates for older runs are dropped.
    listen<{ iteration: number; text: string; final: boolean; timestamp: string }>('argon:critique-text', (d) => setState((s) => {
      const c = s.critique
      if (d.iteration < c.iteration || (d.iteration === c.iteration && c.status === 'done' && !d.final)) return s
      const critique: Critique = { iteration: d.iteration, text: d.text, status: d.final ? 'done' : 'streaming', updatedAt: d.timestamp }
      return { ...s, critique, critiques: remember(s.critiques, critique) }
    }))
    // Browsers get each patch's full before/after text on `patch-applied`; keep the last dozen for the Code tab.
    listen<{ iteration?: number; changes?: FileChange[] }>('argon:patch-applied', ({ iteration, changes }) => {
      if (changes?.length) setState((s) => ({ ...s, code: [...s.code.slice(-11), { iteration: iteration ?? s.iteration, timestamp: new Date().toISOString(), changes }] }))
    })
    listen<string>('argon:playtest-state', (phase) => setState((s) => ({ ...s, phase, human: phase === 'human' || phase === 'complete', frame: phase === 'running' ? 0 : s.frame, iteration: phase === 'running' ? Math.max(1, s.iteration) : s.iteration })))
    listen<Omit<Replay, 'iteration'>>('argon:video-preview', (incoming) => {
      videoUrls.push(incoming.videoUrl)
      if (videoUrls.length > MAX_REPLAYS) URL.revokeObjectURL(videoUrls.shift() ?? '')
      setState((s) => {
        const replay = { ...incoming, iteration: Math.max(1, s.iteration) }
        return { ...s, replay, replays: [...s.replays, replay].slice(-MAX_REPLAYS), critique: { ...idleCritique, iteration: s.critique.iteration } }
      })
    })
    listen<string>('argon:goal-submitted', (goal) => {
      videoUrls.splice(0).forEach((url) => URL.revokeObjectURL(url))
      setState((s) => ({ ...s, goal, error: '', phase: 'synthesizing', human: false, diagnosis: '', diagnosisTime: '', critique: idleCritique, code: [], replay: null, replays: [], critiques: {}, iteration: 0, frame: 0 }))
    })
    listen<string>('argon:goal-error', (error) => setState((s) => ({ ...s, error, phase: 'error', logs: log(s, error, 'error') })))
    listen<{ diagnostics: string }>('argon:patch-rejected', (d) => setState((s) => ({ ...s, error: d.diagnostics, phase: 'error', logs: log(s, d.diagnostics, 'error') })))
    return () => { bindings.forEach(([name, handler]) => window.removeEventListener(name, handler)); videoUrls.forEach((url) => URL.revokeObjectURL(url)) }
  }, [])
  return state
}
