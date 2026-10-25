/** Window event that opens the control bar's twist box (sent by the win and lose screens). */
export const OPEN_TWIST_EVENT = 'patchworld:open-twist'

export type StageId = 'generate' | 'check' | 'load' | 'playtest' | 'critique' | 'patch'
export type BuildKind = 'world' | 'patch' | 'twist'

/** One pass of the loop that ends with a bot playtest: the first world, a fix after a failed attempt, or a twist. */
export interface BuildCycle { kind: BuildKind; startedAt: number; attempt: number; stage: StageId }

export const STAGE_LABELS: Record<StageId, string> = {
  generate: 'Generating world', check: 'Checking code', load: 'Loading level', playtest: 'Bot playtest', critique: 'Critique', patch: 'Patch',
}

/** The stages each kind of cycle goes through, in order. */
export const STAGE_ORDER: Record<BuildKind, StageId[]> = {
  world: ['generate', 'check', 'load', 'playtest'],
  patch: ['critique', 'patch', 'check', 'load', 'playtest'],
  twist: ['patch', 'check', 'load', 'playtest'],
}

/**
 * Which stage a progress phase means. Phases that say nothing about the build (skill updates, tool output)
 * return null and leave the stage alone. `critiqueDone` turns the patch call's "thinking" into the Patch stage.
 */
function stageFor(phase: string, kind: BuildKind, critiqueDone: boolean): StageId | null {
  switch (phase) {
    case 'accepted': case 'synthesizing': return 'generate'
    case 'thinking': return kind === 'world' ? 'generate' : kind === 'twist' || critiqueDone ? 'patch' : 'critique'
    case 'critiquing': case 'awaiting-patch': return critiqueDone ? 'patch' : 'critique'
    case 'patching': case 'diagnosis': return 'patch'
    case 'typecheck-retry': case 'synthesized': case 'patched': return 'check'
    case 'hmr-pending': case 'hmr-swapped': return 'load'
    case 'recording': case 'running': case 'uploading': return 'playtest'
    default: return null
  }
}

/** Moves the cycle forward to the stage `phase` means; never backwards, so stray or late phases cannot make it flicker. */
export function advanceStage(build: BuildCycle | null, phase: string, critiqueDone: boolean): BuildCycle | null {
  if (!build) return build
  const next = stageFor(phase, build.kind, critiqueDone)
  const order = STAGE_ORDER[build.kind]
  if (!next || !order.includes(next) || order.indexOf(next) <= order.indexOf(build.stage)) return build
  return { ...build, stage: next }
}

/**
 * How long this cycle usually takes, in seconds, and how to say it. Live: about 3 minutes for the first world and
 * 1–2 minutes per patch; mock replays are much faster. Once a patch cycle has finished, its real duration is used.
 */
export function estimate(kind: BuildKind, mock: boolean, patchSeconds: number[]): { seconds: number; label: string } {
  if (kind === 'world') return mock ? { seconds: 20, label: '~20 s (mock replay)' } : { seconds: 180, label: '~3 min' }
  if (patchSeconds.length) {
    const seconds = patchSeconds.reduce((sum, value) => sum + value, 0) / patchSeconds.length
    return { seconds, label: `~${formatDuration(seconds)}, like earlier fixes` }
  }
  return mock ? { seconds: 10, label: '~10 s (mock replay)' } : { seconds: 120, label: '1–2 min' }
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
