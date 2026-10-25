import { ArgonOrchestrator, type FailedRunInput, type GeneratedPatch, type OrchestratorEvent } from './argonOrchestrator.ts'
import type { GeneratedFile } from './generatedFiles.ts'

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

export function createWorldOrchestrator(emit: (event: WorldEvent) => void): WorldOrchestrator {
  return new ArgonOrchestrator(emit)
}
