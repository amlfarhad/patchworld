import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PlaytestFailedMetadata } from '../src/shared/protocol.ts'
import type { GeneratedFile } from './generatedFiles.ts'
import type { MountFailureInput, TwistInput, ValidateFiles, WorldEvent, WorldOrchestrator } from './orchestrator.ts'
import { compactTelemetry } from './telemetry.ts'
import { applyEdits, mergePatchFiles, type FileEdit } from './patchEdits.ts'

const model = process.env.ARGON_MODEL ?? 'gemini-4-argon'
/** Thinking effort per call. The first world benefits from more; patches and critiques need speed. */
const worldThinking = process.env.ARGON_WORLD_THINKING ?? 'medium'
const patchThinking = process.env.ARGON_PATCH_THINKING ?? 'low'
const critiqueThinking = process.env.ARGON_CRITIQUE_THINKING ?? 'low'
const callTimeoutMs = Math.max(30_000, Number(process.env.ARGON_CALL_TIMEOUT_MS) || 8 * 60_000)
/** Inline video is fastest; larger recordings go through the Files API instead. */
const maxInlineVideoBytes = 14 * 1024 * 1024
const progressIntervalMs = 1_500
const skillPath = resolve(process.cwd(), '.agents/SKILL.md')

export type OrchestratorEvent = {
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
Import the host types instead of redeclaring them: import type { GeneratedLevelModule, MountedLevel, StepResult } from '../engine/types'
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
Rules:
- Import THREE from 'three' and RAPIER from '@dimforge/rapier3d-compat'. Keep every generated file a direct child of src/generated/.
- The host camera looks at the level from the front. Keep everything inside x from -6 to 6, y from 0 to 6, z from -3 to 3, with the action along x.
- Register every important body in namedBodies with a short name; telemetry and the critic only see named bodies.
- Enable RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS on colliders whose impacts matter.
- The bot acts only in stepBotAndRules. Return failedEarly as soon as success is impossible (for example the projectile left the arena), so failed runs end quickly.
- Implement onPointerOrKey and stepHumanAndRules so a person can play after the bot succeeds. Human updates must not apply bot actions. Keep meshes in sync with bodies in both modes.
- Rapier has no fracture and joints never break on their own: to break something, remove its joints or switch bodies to dynamic when a contact force passes a threshold.
- Keep the code compact and readable (well under 700 lines). No eval, Function, network calls, DOM access, timers or infinite loops.
`

const patchSchema = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    diagnosis: { type: 'string' },
    skillContent: { type: 'string' },
  },
  required: ['files', 'diagnosis', 'skillContent'],
}

const patchFormat = { type: 'text', mime_type: 'application/json', schema: patchSchema } as const

const editSchema = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } },
        required: ['path', 'find', 'replace'],
      },
    },
    files: patchSchema.properties.files,
    diagnosis: { type: 'string' },
    skillContent: { type: 'string' },
  },
  required: ['edits', 'files', 'diagnosis', 'skillContent'],
}

const editFormat = { type: 'text', mime_type: 'application/json', schema: editSchema } as const

const editInstructions = `Return one JSON object: {"edits":[{"path":"src/generated/activeLevel.ts","find":"exact current code","replace":"new code"}],"files":[],"diagnosis":"one or two sentences on what this version changes","skillContent":"Markdown list of physical invariants learned so far, or empty"}.
Each "find" must be copied exactly from the current file (whitespace included) and appear in it exactly once; include a few surrounding lines to make it unique. Keep edits small. Put only brand-new files in "files", whole.`

const outputInstructions =`Return one JSON object: {"files":[{"path":"src/generated/activeLevel.ts","content":"..."}],"diagnosis":"one or two sentences on what this version changes","skillContent":"Markdown list of physical invariants learned so far, or empty"}. Include activeLevel.ts in every response with its complete content.`

const systemInstruction = 'You write safe, typed Three.js and Rapier physics levels for the Patchworld engine. Follow the host contract exactly and return only the requested JSON.'

type InteractionInput = string | Array<Record<string, unknown>>

interface StreamOptions {
  label: string
  input: InteractionInput
  thinking: string
  previousInteractionId?: string
  /** Structured JSON output format; omitted for plain text. */
  format?: typeof patchFormat | typeof editFormat
  onText?: (text: string) => void
}

export class ArgonOrchestrator implements WorldOrchestrator {
  private readonly ai: GoogleGenAI

  constructor(private readonly emit: (event: WorldEvent) => void) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing; add it to .env in the project folder')
    this.ai = new GoogleGenAI({ apiKey })
  }

  async generateInitialWorld(goal: string, validate: ValidateFiles): Promise<GeneratedPatch> {
    const skill = await readLearnedSkill()
    const prompt = `Create a complete physics sandbox level for this goal: ${goal}\n${skill ? `\nPhysical invariants learned from earlier runs:\n${skill}\n` : ''}\n${levelContract}\n${outputInstructions}`
    this.emit({ phase: 'synthesizing', message: 'Synthesizing the first physics world…' })
    const result = await this.stream({ label: 'World generation', input: prompt, thinking: worldThinking, format: patchFormat })
    return this.parseAndRepair(parsePatch(result.text), result.id, validate)
  }

  async critiqueAndPatchWorld(input: FailedRunInput, validate: ValidateFiles): Promise<GeneratedPatch> {
    this.emit({ phase: 'critiquing', message: 'The critic is watching the failed run…', iteration: input.iteration })
    const video = await this.videoContent(input.videoBytes)
    const telemetry = compactTelemetry(input.metadata.telemetry)
    const critiquePrompt = `You are reviewing an autonomous playtest of a generated physics level. The attached video is the bot's attempt; the telemetry below was recorded alongside it.
Failure reported by the level: ${input.metadata.failureReason ?? 'Goal not reached before the time limit'}
Telemetry (${input.metadata.frameCount} recorded frames, positions in metres, compacted):
${JSON.stringify(telemetry)}
Current level code:
${formatFiles(input.currentFiles)}

Diagnose why the goal was not reached. Cite video timestamps (for example "At 0:03") and the specific code cause. Then say exactly what to change. Plain text, at most 120 words, no code.`
    const critiqueResult = await this.stream({
      label: 'Critique',
      input: [video, { type: 'text', text: critiquePrompt }],
      thinking: critiqueThinking,
      previousInteractionId: input.previousInteractionId,
      onText: (text) => this.emit({ phase: 'critiquing', message: 'Critic is writing…', iteration: input.iteration, critiqueText: text, critiqueFinal: false }),
    })
    const critique = critiqueResult.text.trim()
    this.emit({ phase: 'critiquing', message: 'Critique complete.', iteration: input.iteration, critiqueText: critique, critiqueFinal: true })
    const patch = await this.patch({
      label: 'Patch',
      previousInteractionId: critiqueResult.id,
      prompt: `Apply your diagnosis to the current level code. Prefer the smallest change that fixes the failure; keep everything that already works.\n${levelContract}`,
      iteration: input.iteration,
      currentFiles: input.currentFiles,
    }, validate)
    return { ...patch, diagnosis: critique || patch.diagnosis }
  }

  async repairMountFailure(input: MountFailureInput, validate: ValidateFiles): Promise<GeneratedPatch> {
    this.emit({ phase: 'critiquing', message: 'Repairing a level that crashed while loading…', iteration: input.iteration })
    return this.patch({
      label: 'Load repair',
      previousInteractionId: input.previousInteractionId,
      prompt: `The level below threw while the engine mounted it, so it never ran.
Error: ${input.error}
${input.stack ? `Stack:\n${input.stack}\n` : ''}Current level code:
${formatFiles(input.currentFiles)}

Fix the cause of the error. Keep the design otherwise unchanged.
${levelContract}`,
      iteration: input.iteration,
      currentFiles: input.currentFiles,
    }, validate)
  }

  async reviseWorld(input: TwistInput, validate: ValidateFiles): Promise<GeneratedPatch> {
    this.emit({ phase: 'synthesizing', message: `Adding the twist: ${input.twist}` })
    return this.patch({
      label: 'Twist',
      previousInteractionId: input.previousInteractionId,
      prompt: `The current level was built for this goal: ${input.goal}
Add this twist to it: ${input.twist}
Change the existing level rather than starting over, and keep the bot able to reach the (possibly updated) goal.
Current level code:
${formatFiles(input.currentFiles)}
${levelContract}`,
      iteration: 0,
      currentFiles: input.currentFiles,
    }, validate)
  }

  /** Asks for targeted edits to the current files; falls back to one whole-file pass when an edit does not apply. */
  private async patch(
    request: { label: string; prompt: string; previousInteractionId?: string; iteration: number; currentFiles: GeneratedFile[] },
    validate: ValidateFiles,
  ): Promise<GeneratedPatch> {
    this.emit({ phase: 'thinking', message: `${request.label}: editing the level…`, iteration: request.iteration })
    const result = await this.stream({
      label: request.label,
      input: `${request.prompt}\n${editInstructions}`,
      thinking: patchThinking,
      previousInteractionId: request.previousInteractionId,
      format: editFormat,
    })
    const parsed = parseEditPatch(result.text)
    const { files: edited, errors } = applyEdits(request.currentFiles, parsed.edits)
    if (errors.length > 0 || (parsed.edits.length === 0 && parsed.files.length === 0)) {
      const reason = errors.length > 0 ? errors.join('\n') : 'The response contained no edits.'
      console.log(`[Argon] ${request.label} edits did not apply; asking for whole files:\n${reason}`)
      this.emit({ phase: 'thinking', message: `${request.label}: an edit did not match the code; asking for the whole file instead.`, iteration: request.iteration })
      const whole = await this.stream({
        label: `${request.label} (whole file)`,
        input: `Your edits could not be applied:\n${reason}\nReturn the complete corrected files instead.\n${outputInstructions}`,
        thinking: patchThinking,
        previousInteractionId: result.id,
        format: patchFormat,
      })
      return this.parseAndRepair(parsePatch(whole.text), whole.id, validate)
    }
    const files = mergePatchFiles(request.currentFiles, edited, parsed.files)
    return this.parseAndRepair({ files, diagnosis: parsed.diagnosis, skillContent: parsed.skillContent }, result.id, validate)
  }

  private async parseAndRepair(
    first: { files: GeneratedFile[]; diagnosis?: string; skillContent?: string },
    interactionId: string,
    validate: ValidateFiles,
  ): Promise<GeneratedPatch> {
    let candidate = first
    let diagnostics = await validate(candidate.files)
    if (diagnostics.length > 0) {
      console.log(`[Argon] TypeScript rejected the draft:\n${diagnostics.join('\n').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 3_000)}`)
      this.emit({ phase: 'typecheck-retry', message: 'TypeScript rejected the draft; sending the compiler errors back for one repair pass.' })
      const repair = await this.stream({
        label: 'TypeScript repair',
        input: `The files you returned fail to compile:\n${diagnostics.join('\n')}\nReturn the full corrected file set.\n${outputInstructions}`,
        thinking: patchThinking,
        previousInteractionId: interactionId,
        format: patchFormat,
      })
      candidate = parsePatch(repair.text)
      diagnostics = await validate(candidate.files)
      if (diagnostics.length > 0) throw new Error(`Generated TypeScript still fails after one repair pass:\n${diagnostics.join('\n')}`)
      interactionId = repair.id
    }
    return { files: candidate.files, diagnosis: candidate.diagnosis, skillContent: candidate.skillContent, interactionId }
  }

  /** Runs one streamed model interaction, reporting progress, and returns its id and full text output. */
  private async stream(options: StreamOptions): Promise<{ id: string; text: string }> {
    const started = Date.now()
    const stream = await this.ai.interactions.create({
      model,
      stream: true,
      input: options.input as never,
      system_instruction: systemInstruction,
      generation_config: { thinking_level: options.thinking, max_output_tokens: 65_536 },
      ...(options.format ? { response_format: options.format } : {}),
      ...(options.previousInteractionId ? { previous_interaction_id: options.previousInteractionId } : {}),
    }, { timeout_ms: callTimeoutMs })

    let id = ''
    let text = ''
    let lastProgress = 0
    const progress = (message: string) => {
      const now = Date.now()
      if (now - lastProgress < progressIntervalMs) return
      lastProgress = now
      this.emit({ phase: 'thinking', message: `${options.label}: ${message} (${Math.round((now - started) / 1000)} s)` })
    }
    for await (const event of stream) {
      if (event.event_type === 'interaction.created' || event.event_type === 'interaction.completed') {
        id ||= event.interaction.id
        const status = (event.interaction as { status?: string }).status
        if (event.event_type === 'interaction.completed' && status && status !== 'completed') {
          throw new Error(`${options.label} ended with status ${status}`)
        }
      } else if (event.event_type === 'step.delta') {
        if (event.delta.type === 'text') {
          text += event.delta.text
          options.onText?.(text)
          progress(options.format ? `writing level code, ${(text.length / 1000).toFixed(1)}k characters` : 'writing')
        } else if (event.delta.type === 'thought_summary') {
          progress('thinking')
        }
      } else if (event.event_type === 'error') {
        const error = (event as { error?: { message?: string } }).error
        throw new Error(`${options.label} failed: ${error?.message ?? 'unknown error'}`)
      }
    }
    if (!id) throw new Error(`${options.label} returned no interaction id`)
    if (!text.trim()) throw new Error(`${options.label} returned no text`)
    console.log(`[Argon] ${options.label} finished in ${((Date.now() - started) / 1000).toFixed(1)} s, ${text.length} chars`)
    return { id, text }
  }

  private async videoContent(videoBytes: Uint8Array): Promise<Record<string, unknown>> {
    if (videoBytes.byteLength <= maxInlineVideoBytes) {
      return { type: 'video', data: Buffer.from(videoBytes).toString('base64'), mime_type: 'video/webm' }
    }
    const videoPath = join(tmpdir(), `argon-${randomUUID()}.webm`)
    await writeFile(videoPath, videoBytes)
    try {
      const uploaded = await this.ai.files.upload({ file: videoPath, config: { mimeType: 'video/webm' } })
      const deadline = Date.now() + 120_000
      let file = uploaded
      while (file.state === 'PROCESSING') {
        if (Date.now() > deadline) throw new Error('Uploaded video was still processing after 120 s')
        await new Promise((done) => setTimeout(done, 2_000))
        file = await this.ai.files.get({ name: uploaded.name! })
      }
      if (file.state === 'FAILED') throw new Error('Gemini could not process the uploaded video')
      return { type: 'video', uri: file.uri, mime_type: file.mimeType ?? 'video/webm' }
    } finally {
      await rm(videoPath, { force: true })
    }
  }
}

async function readLearnedSkill(): Promise<string> {
  try {
    return (await readFile(skillPath, 'utf8')).slice(0, 8_000).trim()
  } catch {
    return ''
  }
}

function formatFiles(files: GeneratedFile[]): string {
  return files.map((file) => `--- ${file.path} ---\n${file.content}`).join('\n\n')
}

export function parsePatch(output: string): { files: GeneratedFile[]; diagnosis?: string; skillContent?: string } {
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
  return {
    files,
    diagnosis: typeof value.diagnosis === 'string' ? value.diagnosis : undefined,
    skillContent: typeof value.skillContent === 'string' ? value.skillContent.slice(0, 64000) : undefined,
  }
}

export function parseEditPatch(output: string): { edits: FileEdit[]; files: GeneratedFile[]; diagnosis?: string; skillContent?: string } {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Model returned no JSON edit patch')
  let parsed: unknown
  try {
    parsed = JSON.parse(output.slice(start, end + 1))
  } catch (error) {
    throw new Error(`Model returned invalid edit JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const value = (parsed ?? {}) as { edits?: unknown; files?: unknown; diagnosis?: unknown; skillContent?: unknown }
  const edits = (Array.isArray(value.edits) ? value.edits : []).map((edit, index) => {
    const entry = (edit ?? {}) as { path?: unknown; find?: unknown; replace?: unknown }
    if (typeof entry.path !== 'string' || typeof entry.find !== 'string' || typeof entry.replace !== 'string') {
      throw new Error(`Edit ${index + 1} needs path, find and replace strings`)
    }
    return { path: entry.path, find: entry.find, replace: entry.replace }
  })
  const files = Array.isArray(value.files) && value.files.length > 0
    ? parsePatch(JSON.stringify({ files: value.files })).files
    : []
  return {
    edits,
    files,
    diagnosis: typeof value.diagnosis === 'string' ? value.diagnosis : undefined,
    skillContent: typeof value.skillContent === 'string' ? value.skillContent.slice(0, 64000) : undefined,
  }
}
