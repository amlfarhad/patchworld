import { ArgonOrchestrator, type FailedRunInput, type GeneratedPatch, type OrchestratorEvent } from './argonOrchestrator.ts'
import type { GeneratedFile } from './generatedFiles.ts'
import { MockOrchestrator } from './mockOrchestrator.ts'

export type ValidateFiles = (files: GeneratedFile[]) => Promise<string[]>

/** Orchestrator progress, plus optional streamed critique text (the whole critique so far). */
export interface WorldEvent extends OrchestratorEvent {
  critiqueText?: string
  critiqueFinal?: boolean
}

export interface MountFailureInput {
  error: string
  stack?: string
  currentFiles: GeneratedFile[]
  previousInteractionId?: string
  iteration: number
}

export interface TwistInput {
  /** The goal the current world was built for. */
  goal: string
  twist: string
  currentFiles: GeneratedFile[]
  previousInteractionId?: string
}

/**
 * What the sync daemon needs from a world generator. `ArgonOrchestrator` (live Gemini) and
 * `MockOrchestrator` (scripted replay) both implement it. The optional methods let the daemon
 * repair a level that crashed while mounting and apply twists to the current world; without
 * them the daemon stops on a crash and regenerates the world for a twist.
 */
export interface WorldOrchestrator {
  generateInitialWorld(goal: string, validate: ValidateFiles): Promise<GeneratedPatch>
  critiqueAndPatchWorld(input: FailedRunInput, validate: ValidateFiles): Promise<GeneratedPatch>
  repairMountFailure?(input: MountFailureInput, validate: ValidateFiles): Promise<GeneratedPatch>
  reviseWorld?(input: TwistInput, validate: ValidateFiles): Promise<GeneratedPatch>
}

/**
 * Reads the mock script from `--mock` / `--mock=<name or path>` or `ARGON_MOCK`.
 * Returns null for live mode.
 */
export function mockScriptFromArgs(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string | null {
  const flag = argv.find((arg) => arg === '--mock' || arg.startsWith('--mock='))
  const value = flag ? flag.slice('--mock='.length) : (env.ARGON_MOCK ?? '').trim()
  if (flag && !value) return 'catapult'
  if (!value || value === '0' || value.toLowerCase() === 'false') return null
  if (value === '1' || value.toLowerCase() === 'true') return 'catapult'
  return value
}

export function createWorldOrchestrator(
  emit: (event: WorldEvent) => void,
  options: { mockScript: string | null; projectRoot: string },
): WorldOrchestrator {
  if (options.mockScript) return new MockOrchestrator(emit, options.mockScript, options.projectRoot)
  return new ArgonOrchestrator(emit)
}
