import { useEffect, useState } from 'react'
import type { FileChange, IterationEntry } from '../shared/protocol'

export interface AgentLog { id: number; timestamp: string; message: string; kind: 'activity' | 'terminal' | 'error' }
export interface Replay { runId: string; videoUrl: string; failed: boolean; failureReason?: string; iteration: number; frameCount: number }
export interface PatchRecord { iteration: number; changes: FileChange[]; timestamp: string }
export interface SandboxState {
  connected: boolean; ready: boolean; hasLevel: boolean; phase: string; message: string;
  frame: number; frameLimit: number; bodyCount: number; iteration: number; maxIterations?: number;
  diagnosis: string; diagnosisTime: string; logs: AgentLog[];
  /** Every recorded attempt for the current goal, oldest first. */
  replays: Replay[];
  /** The replay shown in the corner card; the newest unless the viewer picked one. */
  replay: Replay | null;
  /** Live critique of the latest failed run, as it streams in. */
  critique: string; critiqueFinal: boolean;
  history: IterationEntry[]; patches: PatchRecord[];
  skillContent: string; skillUpdated: string; goal: string; error: string; human: boolean;
  /** The daemon is replaying a scripted run instead of calling Gemini. */
  mock: boolean;
  /** Set when a person playing the level reaches its goal. */
  humanWon: boolean;
}
const initial: SandboxState = {
  connected: false, ready: false, hasLevel: false, phase: 'idle', message: 'Ready for your first world',
  frame: 0, frameLimit: 240, bodyCount: 0, iteration: 0, diagnosis: '', diagnosisTime: '', logs: [],
  replays: [], replay: null, critique: '', critiqueFinal: false, history: [], patches: [],
  skillContent: '', skillUpdated: '', goal: '', error: '', human: false, mock: false, humanWon: false,
}
const maxReplays = 12

/** Show an earlier attempt in the replay card. */
export function selectReplay(runId: string): void {
  window.dispatchEvent(new CustomEvent('argon:select-replay', { detail: runId }))
}

export function useSandbox() {
  const [state, setState] = useState<SandboxState>(initial)
  useEffect(() => {
    let sequence = 0
    const videoUrls = new Set<string>()
    const log = (s: SandboxState, message: string, kind: AgentLog['kind'] = 'activity', timestamp = new Date().toISOString()) =>
      s.logs.at(-1)?.message === message ? s.logs : [...s.logs.slice(-149), { id: ++sequence, timestamp, message, kind }]
    const bindings: [string, EventListener][] = []
    const listen = <T,>(name: string, handler: (detail: T) => void) => {
      const listener: EventListener = (e) => handler((e as CustomEvent<T>).detail)
      window.addEventListener(name, listener); bindings.push([name, listener])
    }
    listen<{ connected: boolean; mock?: boolean } | boolean>('argon:connection', (detail) => {
      const connected = typeof detail === 'boolean' ? detail : detail.connected
      const mock = typeof detail === 'boolean' ? undefined : detail.mock
      setState((s) => ({ ...s, connected, mock: mock ?? s.mock, logs: log(s, connected ? 'Local sync connection established.' : 'Sync disconnected. Reconnecting…') }))
    })
    listen<{ hasLevel: boolean; bodyCount: number }>('argon:level-mounted', (detail) => setState((s) => ({ ...s, ...detail, ready: true, humanWon: false, ...(detail.hasLevel ? {} : { human: false, phase: 'idle', frame: 0 }) })))
    listen<{ frame: number; total: number; bodyCount: number }>('argon:frame', (d) => setState((s) => ({ ...s, phase: 'running', frame: d.frame, frameLimit: d.total, bodyCount: d.bodyCount })))
    listen<{ phase: string; message: string; timestamp: string; iteration?: number; maxIterations?: number; diagnosis?: string; terminal?: string; skillContent?: string }>('argon:progress', (d) => {
      setState((s) => ({
        ...s, phase: d.terminal ? s.phase : d.skillContent ? (s.phase === 'idle' ? 'idle' : 'skill-evolving') : d.phase === 'hmr-swapped' && !s.hasLevel ? 'idle' : d.phase === 'thinking' && s.phase === 'critiquing' ? s.phase : d.phase,
        message: d.message, iteration: d.iteration ?? s.iteration, maxIterations: d.maxIterations ?? s.maxIterations,
        diagnosis: d.diagnosis ?? s.diagnosis, diagnosisTime: d.diagnosis ? d.timestamp : s.diagnosisTime,
        skillContent: d.skillContent ?? s.skillContent, skillUpdated: d.skillContent ? d.timestamp : s.skillUpdated,
        error: d.phase === 'error' ? d.message : s.error,
        logs: log(s, d.terminal ?? d.message, d.terminal ? 'terminal' : d.phase === 'error' ? 'error' : 'activity', d.timestamp),
      }))
    })
    listen<{ iteration: number; text: string; final: boolean; timestamp: string }>('argon:critique-text', (d) => setState((s) => ({
      ...s, critique: d.text, critiqueFinal: d.final,
      ...(d.final ? { diagnosis: d.text, diagnosisTime: d.timestamp, logs: log(s, `Critique: ${d.text}`, 'activity', d.timestamp) } : {}),
    })))
    listen<{ goal: string; entries: IterationEntry[] }>('argon:iteration-history', (d) => setState((s) => ({ ...s, history: d.entries })))
    listen<{ iteration?: number; changes?: FileChange[] }>('argon:patch-applied', (d) => {
      if (!d.changes?.length) return
      setState((s) => ({ ...s, critique: '', critiqueFinal: false, patches: [...s.patches.slice(-19), { iteration: d.iteration ?? s.iteration, changes: d.changes!, timestamp: new Date().toISOString() }] }))
    })
    listen<string>('argon:playtest-state', (phase) => setState((s) => ({ ...s, phase, human: phase === 'human' || phase === 'complete', frame: phase === 'running' ? 0 : s.frame, iteration: phase === 'running' ? Math.max(1, s.iteration) : s.iteration })))
    listen<Omit<Replay, 'iteration'>>('argon:video-preview', (incoming) => {
      videoUrls.add(incoming.videoUrl)
      setState((s) => {
        const replay = { ...incoming, iteration: Math.max(1, s.iteration) }
        const replays = [...s.replays, replay]
        while (replays.length > maxReplays) {
          const dropped = replays.shift()!
          URL.revokeObjectURL(dropped.videoUrl)
          videoUrls.delete(dropped.videoUrl)
        }
        return { ...s, replays, replay }
      })
    })
    listen<string>('argon:select-replay', (runId) => setState((s) => ({ ...s, replay: s.replays.find((r) => r.runId === runId) ?? s.replay })))
    listen<boolean>('argon:human-won', () => setState((s) => ({ ...s, humanWon: true })))
    listen<string | { goal: string; twist: boolean }>('argon:goal-submitted', (detail) => setState((s) => {
      // A twist keeps the earlier attempts; a brand-new goal starts a fresh history.
      const keep = typeof detail !== 'string' && detail.twist
      const goal = typeof detail === 'string' ? detail : detail.goal
      if (!keep) s.replays.forEach((r) => { URL.revokeObjectURL(r.videoUrl); videoUrls.delete(r.videoUrl) })
      return {
        ...s, goal: keep ? s.goal : goal, error: '', phase: 'synthesizing', human: false, humanWon: false,
        diagnosis: '', diagnosisTime: '', critique: '', critiqueFinal: false, iteration: 0, frame: 0,
        ...(keep ? {} : { replays: [], replay: null, patches: [], history: [] }),
      }
    }))
    listen<string>('argon:goal-error', (error) => setState((s) => ({ ...s, error, phase: 'error', logs: log(s, error, 'error') })))
    listen<{ diagnostics: string }>('argon:patch-rejected', (d) => setState((s) => ({ ...s, error: d.diagnostics, phase: 'error', logs: log(s, d.diagnostics, 'error') })))
    return () => { bindings.forEach(([name, handler]) => window.removeEventListener(name, handler)); videoUrls.forEach((url) => URL.revokeObjectURL(url)) }
  }, [])
  return state
}
