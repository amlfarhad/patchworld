import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PlaytestFailedMetadata } from '../src/shared/protocol.ts'
import type { GeneratedFile } from './generatedFiles.ts'

const model = process.env.ARGON_MODEL ?? 'gemini-4-argon'
const managedAgent = process.env.ARGON_AGENT ?? 'antigravity-preview-09-2026'
const pollIntervalMs = 2_000

export interface OrchestratorEvent {
  phase: string
  message: string
  iteration?: number
  diagnosis?: string
  skillContent?: string
  terminal?: string
}

export interface GeneratedPatch {
  files: GeneratedFile[]
  interactionId: string
  skillContent?: string
  diagnosis?: string
}

export interface FailedRunInput {
  videoBytes: Uint8Array
  metadata: PlaytestFailedMetadata
  currentFiles: GeneratedFile[]
  previousInteractionId?: string
  iteration: number
}

const levelContract = `
Generated TypeScript must export buildWorld(scene, world, namedBodies, eventQueue) and return MountedLevel.
The exact host contract is:
interface StepResult { botState: string; goalReached: boolean; failedEarly?: string }
interface MountedLevel {
  stepBotAndRules(frameIndex: number, elapsedSeconds: number): StepResult;
  onPointerOrKey?: (event: { type: string; key?: string; ndc?: [number, number] }) => void;
  stepHumanAndRules?: (frameIndex: number, elapsedSeconds: number) => StepResult;
  dispose(): void;
}
interface GeneratedLevelModule {
  buildWorld(scene: THREE.Scene, world: RAPIER.World,
    namedBodies: Map<string, RAPIER.RigidBody>, eventQueue: RAPIER.EventQueue): MountedLevel;
}
Implement onPointerOrKey and stepHumanAndRules for interactive play after autonomous success. Human updates must not apply bot actions. Keep visuals in sync with bodies in both modes.
Import THREE from 'three' and RAPIER from '@dimforge/rapier3d-compat'. Keep all generated files as direct children of src/generated/.
Return one JSON object only: {"files":[{"path":"src/generated/activeLevel.ts","content":"..."}],"diagnosis":"short summary with video timestamps when available","skillContent":"Markdown physical invariants learned from evidence, or empty when none"}.
Include activeLevel.ts in every patch. Never use eval, Function, remote script loading, or write outside src/generated/.
`

const interactionKinds = new Map<string, 'model' | 'agent'>()

export function extractInteractionText(interaction: {
  output_text?: string | null
  steps?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
  }>
}): string {
  const stepTexts: string[] = []
  for (const step of interaction.steps ?? []) {
    if (step.type !== 'model_output') continue
    for (const part of step.content ?? []) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        stepTexts.push(part.text)
      }
    }
  }
  if (stepTexts.length > 0) return stepTexts.join('\n')
  return interaction.output_text ?? ''
}

export function resolveChainedInteractionId(
  previousInteractionId: string | undefined,
  targetKind: 'model' | 'agent',
): string | undefined {
  if (!previousInteractionId) return undefined
  const recordedKind = interactionKinds.get(previousInteractionId)
  if (recordedKind && recordedKind !== targetKind) return undefined
  return previousInteractionId
}

export class ArgonOrchestrator {
  private readonly ai: GoogleGenAI

  constructor(private readonly emit: (event: OrchestratorEvent) => void) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing; add it to physics-sandbox/.env')
    this.ai = new GoogleGenAI({ apiKey })
  }

  async generateInitialWorld(goal: string, validate: (files: GeneratedFile[]) => Promise<string[]>): Promise<GeneratedPatch> {
    const prompt = `Create a complete physics sandbox level for this goal: ${goal}\n\n${levelContract}`
    this.emit({ phase: 'synthesizing', message: 'Synthesizing the first physics world…' })
    const interaction = await this.ai.interactions.create({
      model,
      background: true,
      input: prompt,
      generation_config: {
        max_output_tokens: 131_072,
        thinking_level: 'high',
      },
      system_instruction: 'You generate safe, typed Three.js and Rapier level modules for the Argon engine. Follow the output contract exactly.',
    })
    interactionKinds.set(interaction.id, 'model')
    const completed = await this.waitForInteraction(interaction.id, 'Long-decode world generation')
    return this.parseAndRepair(extractInteractionText(completed), interaction.id, validate, prompt)
  }

  async critiqueAndPatchWorld(
    input: FailedRunInput,
    validate: (files: GeneratedFile[]) => Promise<string[]>,
  ): Promise<GeneratedPatch> {
    const videoPath = join(tmpdir(), `argon-${randomUUID()}.webm`)
    await writeFile(videoPath, input.videoBytes)
    try {
      this.emit({ phase: 'critiquing', message: 'Uploading the failed run for managed-agent critique…', iteration: input.iteration })
      const uploadedVideo = await this.ai.files.upload({
        file: videoPath,
        config: { mimeType: 'video/webm' },
      })
      const prompt = `Inspect the attached browser playtest video and the frame telemetry. Diagnose the physics failure using video timestamps. Use sandbox code execution for numerical checks where useful; report actual tool results, never invented proofs. Return a complete patched file set and a skillContent Markdown document containing physical invariants learned from this run for .agents/SKILL.md.\nIteration: ${input.iteration}\nFailure: ${input.metadata.failureReason ?? 'Goal not reached'}\nTelemetry (${input.metadata.frameCount} frames):\n${JSON.stringify(input.metadata.telemetry)}\nCurrent generated files:\n${JSON.stringify(input.currentFiles)}\n\n${levelContract}`
      const chainedAgentId = resolveChainedInteractionId(input.previousInteractionId, 'agent')
      const interaction = await this.ai.interactions.create({
        agent: managedAgent,
        environment: 'remote',
        ...(chainedAgentId ? { previous_interaction_id: chainedAgentId } : {}),
        input: [
          { type: 'video', uri: uploadedVideo.uri, mime_type: uploadedVideo.mimeType ?? 'video/webm' },
          { type: 'text', text: prompt },
        ],
        background: true,
      })
      interactionKinds.set(interaction.id, 'agent')
      const completed = await this.waitForInteraction(interaction.id, 'Managed Agent critique')
      return this.parseAndRepair(extractInteractionText(completed), interaction.id, validate, prompt)
    } finally {
      await rm(videoPath, { force: true })
    }
  }

  private async parseAndRepair(
    output: string,
    interactionId: string,
    validate: (files: GeneratedFile[]) => Promise<string[]>,
    originalPrompt: string,
  ): Promise<GeneratedPatch> {
    let candidate = parsePatch(output)
    let diagnostics = await validate(candidate.files)
    if (diagnostics.length > 0) {
      this.emit({ phase: 'typecheck-retry', message: 'TypeScript rejected the draft; sending diagnostics for one repair pass.' })
      const chainedModelId = resolveChainedInteractionId(interactionId, 'model')
      const repair = await this.ai.interactions.create({
        model,
        background: true,
        ...(chainedModelId ? { previous_interaction_id: chainedModelId } : {}),
        input: `${originalPrompt}\n\nCompiler diagnostics from the proposed files (repair once):\n${diagnostics.join('\n')}\nReturn the full corrected file set as the required JSON object.`,
        generation_config: { max_output_tokens: 65_536, thinking_level: 'high' },
      })
      interactionKinds.set(repair.id, 'model')
      const completed = await this.waitForInteraction(repair.id, 'TypeScript repair pass')
      candidate = parsePatch(extractInteractionText(completed))
      diagnostics = await validate(candidate.files)
      if (diagnostics.length > 0) throw new Error(`Generated TypeScript still fails after one repair pass:\n${diagnostics.join('\n')}`)
      interactionId = repair.id
    }
    return { files: candidate.files, diagnosis: candidate.diagnosis, skillContent: candidate.skillContent, interactionId }
  }

  private async waitForInteraction(id: string, label: string) {
    const seenSteps = new Set<string>()
    const deadline = Date.now() + 20 * 60_000
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${label} exceeded the 20-minute polling limit`)
      const interaction = await this.ai.interactions.get(id)
      for (const step of interaction.steps ?? []) {
        if (!['code_execution_call', 'code_execution_result', 'function_call', 'function_result', 'mcp_server_tool_call', 'mcp_server_tool_result'].includes(step.type)) continue
        const data = step as unknown as Record<string, unknown>
        const content = data.result ?? data.arguments
        if (content === undefined) continue
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
        const terminal = `${step.type}${data.name ? `: ${String(data.name)}` : ''}\n${text}`.slice(0, 16000)
        if (seenSteps.has(terminal)) continue
        seenSteps.add(terminal)
        this.emit({ phase: 'agent-tool', message: 'Managed Agent sandbox output received.', terminal })
      }
      if (interaction.status === 'completed') return interaction
      if (interaction.status === 'failed' || interaction.status === 'cancelled' || interaction.status === 'requires_action') {
        const reason = interaction.errors?.map((error) => error.message).filter(Boolean).join('\n')
        throw new Error(`${label} ended with status ${interaction.status}${reason ? `: ${reason}` : ''}`)
      }
      this.emit({ phase: 'thinking', message: `${label} is ${interaction.status ?? 'running'}…` })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
    }
  }
}

function parsePatch(output: string): { files: GeneratedFile[]; diagnosis?: string; skillContent?: string } {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Model returned no JSON file patch')
  let parsed: unknown
  try {
    parsed = JSON.parse(output.slice(start, end + 1))
  } catch (error) {
    throw new Error(`Model returned invalid patch JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { files?: unknown }).files)) {
    throw new Error('Model patch must have a files array')
  }
  const value = parsed as { files: unknown[]; diagnosis?: unknown; skillContent?: unknown }
  const files = value.files.map((file) => {
    if (!file || typeof file !== 'object') throw new Error('Model patch contains a non-object file')
    const entry = file as { path?: unknown; content?: unknown }
    if (typeof entry.path !== 'string' || typeof entry.content !== 'string') throw new Error('Model patch files need path and content strings')
    return { path: entry.path, content: entry.content }
  })
  return { files, diagnosis: typeof value.diagnosis === 'string' ? value.diagnosis : undefined, skillContent: typeof value.skillContent === 'string' ? value.skillContent.slice(0, 64000) : undefined }
}
