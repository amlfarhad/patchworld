import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PlaytestFailedMetadata } from '../src/shared/protocol.ts'
import type { GeneratedFile } from './generatedFiles.ts'

const model = process.env.ARGON_MODEL ?? 'gemini-4-argon'
const critiqueModel = process.env.ARGON_CRITIQUE_MODEL ?? 'gemini-3.8-flash'
const managedAgent = process.env.ARGON_AGENT ?? 'antigravity-preview-09-2026'
const pollIntervalMs = 2_000
const defaultSkillPath = resolve(process.cwd(), '.agents/SKILL.md')

export const patchResponseSchema = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    diagnosis: { type: 'string' },
    skillContent: { type: 'string' },
  },
  required: ['files'],
} as const

export interface CritiqueTextMessage {
  type: 'critique-text'
  iteration: number
  text: string
  final: boolean
  timestamp: string
}

export function createCritiqueTextMessage(
  iteration: number,
  text: string,
  final: boolean,
): CritiqueTextMessage {
  return {
    type: 'critique-text',
    iteration,
    text,
    final,
    timestamp: new Date().toISOString(),
  }
}

export interface OrchestratorEvent {
  phase: string
  message: string
  iteration?: number
  diagnosis?: string
  critiqueText?: string
  critiqueFinal?: boolean
  critiqueMessage?: CritiqueTextMessage
  skillContent?: string
  terminal?: string
  durationMs?: number
  timings?: Record<string, number>
}

export interface GeneratedPatch {
  files: GeneratedFile[]
  interactionId: string
  skillContent?: string
  diagnosis?: string
  timings?: Record<string, number>
}

export interface FailedRunInput {
  videoBytes: Uint8Array
  metadata: PlaytestFailedMetadata
  currentFiles: GeneratedFile[]
  previousInteractionId?: string
  iteration: number
}

export interface MountFailureInput {
  error: string
  stack?: string
  currentFiles: GeneratedFile[]
  previousInteractionId?: string
  iteration: number
}

export interface TwistInput {
  goal: string
  twist: string
  currentFiles: GeneratedFile[]
  previousInteractionId?: string
}

export type ReviseWorldInput = TwistInput | {
  goal?: string
  twist?: string
  instruction: string
  currentFiles: GeneratedFile[]
  previousInteractionId?: string
  iteration?: number
}

export const levelContract = `
Generated TypeScript must export buildWorld(scene, world, namedBodies, eventQueue) and return MountedLevel matching src/engine/types.ts.
The exact host contract is:
export interface ControlBinding {
  key: string;
  action: string;
}
export type LevelGoal =
  | { type: 'below-y'; body: string; y: number }
  | { type: 'above-y'; body: string; y: number }
  | { type: 'in-region'; body: string; min: [number, number, number]; max: [number, number, number] }
  | { type: 'near-point'; body: string; target: [number, number, number]; radius: number };
export interface StepResult {
  botState: string;
  goalReached: boolean;
  failedEarly?: string;
}
export interface MountedLevel {
  dispose: () => void;
  stepBotAndRules: (frameIndex: number, elapsedSeconds: number) => StepResult;
  stepHumanAndRules: (frameIndex: number, elapsedSeconds: number) => StepResult;
  controls: ControlBinding[];
  goal: LevelGoal;
  onPointerOrKey?: (event: { type: string; key?: string; code?: string; ndc?: [number, number] }) => void;
}
export interface GeneratedLevelModule {
  buildWorld: (
    scene: THREE.Scene,
    world: RAPIER.World,
    namedBodies: Map<string, RAPIER.RigidBody>,
    eventQueue: RAPIER.EventQueue,
  ) => MountedLevel;
}

Host stage & physics rules:
- EngineHost already creates the sky dome, directional/hemisphere lights with shadows, and a fixed ground collider at y = -0.25 (top surface at y = 0, size 120x0.5x120). Do not duplicate the ground collider or dispose host lights/stage objects in dispose().
- Register every key rigid body in namedBodies (especially the body referenced by MountedLevel.goal.body) via namedBodies.set(name, body); EngineHost evaluates MountedLevel.goal against namedBodies every frame.
- Both stepBotAndRules and stepHumanAndRules are required. stepHumanAndRules must update visuals and rule checks for interactive human takeover without applying autonomous bot impulses/motors.
- Controls contract: the host passes { type, key, code, ndc } to onPointerOrKey, where code is KeyboardEvent.code (e.g. 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Space', 'ShiftLeft', 'KeyF'). Declare controls: ControlBinding[] using those exact KeyboardEvent.code values, match input on event.code in onPointerOrKey, and handle every declared binding in onPointerOrKey and stepHumanAndRules so each binding produces a real physical effect. If both WASD and Arrow keys (or multiple ability keys) are declared, every declared binding must work.
- Mechanics rules (genre-agnostic):
  1. Directional contact over proximity: interactions must fire only on the specific physical contact the goal implies (e.g. hit from below, stomp from above, direct collision/touch), never on mere distance/proximity checks.
  2. Finite rewards and spawns: blocks, triggers, pickups, and spawners must be finite (single-payout or bounded state) unless the goal explicitly asks for continuous/infinite spawning.
  3. Reachability: every interactive object, platform, hazard, and target mentioned in the goal must be physically reachable by both the autonomous bot and a human player.
- Bot playtest coverage: stepBotAndRules must actively exercise the level's main mechanics on its way to the goal (use the declared jump/ability, hit interactive blocks/switches, engage targets/obstacles) so the playtest verifies mechanics rather than taking a straight run to the goal.
- Optional breakage & sensor kit helpers may be imported from '../engine/breakageKit':
  createBreakableWall(scene, world, namedBodies, options), createSnapJoint(world, options), createSensorZone(scene, world, options), createLavaSensor(scene, world, options), createGoalSensor(scene, world, options), applyLaunchImpulse(body, options).
- Import * as THREE from 'three' and RAPIER from '@dimforge/rapier3d-compat'. Keep all generated files as direct children of src/generated/ (with entry module src/generated/activeLevel.ts).
- Return one JSON object only matching the response schema: {"files":[{"path":"src/generated/activeLevel.ts","content":"..."}],"diagnosis":"short summary with video timestamps when available","skillContent":"Markdown physical invariants learned from evidence, or empty when none"}.
- For patches, return only the files in src/generated/ that changed. Never use eval, Function, remote script loading, or write outside src/generated/.
`

export async function loadLearnedSkill(skillFilePath = defaultSkillPath): Promise<string> {
  try {
    const content = (await readFile(skillFilePath, 'utf8')).trim()
    return content.slice(0, 64_000)
  } catch {
    return ''
  }
}

export function buildWorldGenerationPrompt(goal: string, skillMarkdown = ''): string {
  const sections = [
    `Create a complete physics sandbox level for this goal: ${goal}`,
    levelContract.trim(),
  ]
  if (skillMarkdown.trim()) {
    sections.push(`Learned physics invariants from .agents/SKILL.md (apply these invariants when designing the level):\n${skillMarkdown.trim()}`)
  }
  return sections.join('\n\n')
}

const fileUploadTimeoutMs = 60_000
const fileUploadPollIntervalMs = 1_000
const interactionKinds = new Map<string, 'model' | 'agent'>()

export interface UploadedFileHandle {
  name?: string
  uri?: string
  mimeType?: string
  state?: string
}

export async function waitForUploadedFileActive(
  filesApi: { get: (params: { name: string }) => Promise<UploadedFileHandle> },
  uploaded: UploadedFileHandle,
  timeoutMs = fileUploadTimeoutMs,
  intervalMs = fileUploadPollIntervalMs,
): Promise<UploadedFileHandle> {
  const initialState = String(uploaded.state ?? '').toUpperCase()
  if (initialState === 'FAILED') {
    throw new Error(`Uploaded video ${uploaded.name ?? ''} failed processing (state: FAILED)`.trim())
  }
  if (initialState === 'ACTIVE') {
    return uploaded
  }
  if (!uploaded.name) {
    throw new Error('Uploaded video is missing a resource name for state polling')
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for uploaded video ${uploaded.name} to become ACTIVE`)
    }
    const current = await filesApi.get({ name: uploaded.name })
    const state = String(current.state ?? '').toUpperCase()
    if (state === 'ACTIVE') {
      return { ...uploaded, ...current }
    }
    if (state === 'FAILED') {
      throw new Error(`Uploaded video ${uploaded.name} failed processing (state: FAILED)`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
}

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

export function mergeWithCurrentFiles(
  proposedFiles: GeneratedFile[],
  currentFiles: GeneratedFile[] = [],
): GeneratedFile[] {
  if (currentFiles.length === 0) return proposedFiles
  const merged = new Map<string, GeneratedFile>()
  for (const existing of currentFiles) {
    merged.set(existing.path, existing)
  }
  for (const updated of proposedFiles) {
    merged.set(updated.path, updated)
  }
  return [...merged.values()]
}

export function filterChangedFiles(
  proposedFiles: GeneratedFile[],
  currentFiles: GeneratedFile[] = [],
): GeneratedFile[] {
  if (currentFiles.length === 0) return proposedFiles
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file.content]))
  const changed = proposedFiles.filter((file) => currentByPath.get(file.path) !== file.content)
  return changed.length > 0 ? changed : proposedFiles.slice(0, 1)
}

export type TelemetryFrame = PlaytestFailedMetadata['telemetry'][number]

export interface TelemetryContactEvent {
  frame: number
  timestampMs: number
  bodyA: string
  bodyB: string
  totalForce: number
}

export interface TelemetryFallEvent {
  frame: number
  timestampMs: number
  body: string
  y: number
  thresholdY: number
}

export interface TelemetryKeyEvents {
  firstContact: TelemetryContactEvent | null
  peakForce: TelemetryContactEvent | null
  fellBelowHeight: TelemetryFallEvent[]
}

export interface ShrunkTelemetry {
  totalFrames: number
  sampledFrames: number
  keyEvents: TelemetryKeyEvents
  frames: TelemetryFrame[]
}

export function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

export function roundTuple3(tuple: [number, number, number]): [number, number, number] {
  return [round3(tuple[0]), round3(tuple[1]), round3(tuple[2])]
}

export function isBodyAtRest(
  body: { linvel: [number, number, number]; angvel: [number, number, number] },
  restEpsilon = 0.001,
): boolean {
  const linSpeed = Math.hypot(body.linvel[0], body.linvel[1], body.linvel[2])
  const angSpeed = Math.hypot(body.angvel[0], body.angvel[1], body.angvel[2])
  return linSpeed <= restEpsilon && angSpeed <= restEpsilon
}

export function shrinkTelemetry(
  telemetry: TelemetryFrame[],
  options: { frameStride?: number; restEpsilon?: number; fallBelowY?: number } = {},
): ShrunkTelemetry {
  const frameStride = Math.max(1, options.frameStride ?? 4)
  const restEpsilon = options.restEpsilon ?? 0.001
  const fallBelowY = options.fallBelowY ?? 0

  let firstContact: TelemetryContactEvent | null = null
  let peakForce: TelemetryContactEvent | null = null
  const fellBodies = new Set<string>()
  const fellBelowHeight: TelemetryFallEvent[] = []

  for (const snapshot of telemetry) {
    for (const contact of snapshot.contacts) {
      const event: TelemetryContactEvent = {
        frame: snapshot.frame,
        timestampMs: snapshot.timestampMs,
        bodyA: contact.bodyA,
        bodyB: contact.bodyB,
        totalForce: round3(contact.totalForce),
      }
      if (!firstContact) firstContact = event
      if (!peakForce || event.totalForce > peakForce.totalForce) {
        peakForce = event
      }
    }
    for (const body of snapshot.bodies) {
      if (!fellBodies.has(body.name) && body.pos[1] < fallBelowY) {
        fellBodies.add(body.name)
        fellBelowHeight.push({
          frame: snapshot.frame,
          timestampMs: snapshot.timestampMs,
          body: body.name,
          y: round3(body.pos[1]),
          thresholdY: fallBelowY,
        })
      }
    }
  }

  const frames = telemetry
    .filter((_, index) => index % frameStride === 0)
    .map((snapshot) => ({
      frame: snapshot.frame,
      timestampMs: snapshot.timestampMs,
      botState: snapshot.botState,
      bodies: snapshot.bodies
        .filter((body) => !isBodyAtRest(body, restEpsilon))
        .map((body) => ({
          name: body.name,
          pos: roundTuple3(body.pos),
          linvel: roundTuple3(body.linvel),
          angvel: roundTuple3(body.angvel),
        })),
      contacts: snapshot.contacts.map((contact) => ({
        bodyA: contact.bodyA,
        bodyB: contact.bodyB,
        totalForce: round3(contact.totalForce),
      })),
    }))

  return {
    totalFrames: telemetry.length,
    sampledFrames: frames.length,
    keyEvents: {
      firstContact,
      peakForce,
      fellBelowHeight,
    },
    frames,
  }
}

export function buildCritiquePrompt(
  input: FailedRunInput,
  compactTelemetry: ShrunkTelemetry,
): string {
  const failureReason = input.metadata.failureReason ?? 'Goal not reached'
  return [
    'Inspect the attached browser playtest video, the compacted frame telemetry, and the current generated files.',
    'Check declared controls and interactive object behaviour against the goal, not just whether the goal was reached:',
    '1. TOP PRIORITY — Dead controls: If the failure reason reports dead controls (e.g. "Declared controls did nothing: ..."), treat fixing every dead binding as the #1 priority. Verify that controls are declared with KeyboardEvent.code (e.g. \'KeyW\', \'KeyA\', \'ArrowUp\', \'Space\', \'ShiftLeft\'), onPointerOrKey matches on event.code, and every declared binding (including both WASD and Arrow keys when both are declared) produces a physical action in onPointerOrKey/stepHumanAndRules.',
    '2. Directional contact over proximity: Check that interactive objects fire on the specific physical contact implied by the goal (hit from below, stomp from above, direct touch/collision), never on mere proximity.',
    '3. Finite rewards & reachability: Check that rewards/spawns are finite unless the goal requests endless spawning, and that every interactive object is physically reachable by both the bot and a human player.',
    '4. Bot mechanic coverage: Check that stepBotAndRules exercises the level\'s main mechanics on its way to the goal (uses the declared jump/ability, hits interactive blocks/targets) rather than taking a straight run to the goal.',
    'Write a concise, plain-text diagnosis citing video timestamps, telemetry events, and exact control/mechanic defects to fix. Do not output code or JSON in this critique step.',
    `Iteration: ${input.iteration}`,
    `Failure: ${failureReason}`,
    `Telemetry summary (${compactTelemetry.sampledFrames} sampled of ${input.metadata.frameCount} frames, 3-decimal rounded, resting bodies omitted):`,
    JSON.stringify(compactTelemetry),
    `Current generated files:\n${JSON.stringify(input.currentFiles)}`,
  ].join('\n')
}

export function buildPatchPrompt(
  input: FailedRunInput,
  critiqueText: string,
  compactTelemetry: ShrunkTelemetry,
  skillMarkdown = '',
): string {
  const failureReason = input.metadata.failureReason ?? 'Goal not reached'
  return [
    'Apply the playtest critique below to fix the physics level.',
    'If the failure reason or critique reports dead controls ("Declared controls did nothing: ..."), treat fixing every declared control binding (matching event.code in onPointerOrKey and applying movement/actions in stepHumanAndRules, including both WASD and Arrow keys if declared) as the top priority.',
    'Ensure interactive objects trigger only on the specific contact the goal implies (never proximity), keep rewards/spawns finite unless specified otherwise, make every interactive object reachable by both bot and player, and make stepBotAndRules exercise the main mechanics on its way to the goal.',
    'Return only the files in src/generated/ that changed and a skillContent Markdown document containing physical invariants learned from this run for .agents/SKILL.md.',
    `Iteration: ${input.iteration}`,
    `Failure: ${failureReason}`,
    `Streamed critique:\n${critiqueText}`,
    `Telemetry summary (${compactTelemetry.sampledFrames} sampled of ${input.metadata.frameCount} frames, 3-decimal rounded, resting bodies omitted):`,
    JSON.stringify(compactTelemetry),
    `Current generated files:\n${JSON.stringify(input.currentFiles)}`,
    ...(skillMarkdown ? [`Learned physics invariants (.agents/SKILL.md):\n${skillMarkdown}`] : []),
    levelContract.trim(),
  ].join('\n\n')
}

export class ArgonOrchestrator {
  private readonly ai: GoogleGenAI

  constructor(
    private readonly emit: (event: OrchestratorEvent) => void,
    private readonly skillFilePath = defaultSkillPath,
  ) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is missing; add it to physics-sandbox/.env')
    this.ai = new GoogleGenAI({ apiKey })
  }

  private emitCritiqueText(iteration: number, text: string, final: boolean) {
    const critiqueMessage = createCritiqueTextMessage(iteration, text, final)
    this.emit({
      phase: 'critiquing',
      message: final ? 'Playtest critique complete.' : 'Streaming playtest critique…',
      iteration,
      diagnosis: final ? text : undefined,
      critiqueText: text,
      critiqueFinal: final,
      critiqueMessage,
    })
  }

  async generateInitialWorld(goal: string, validate: (files: GeneratedFile[]) => Promise<string[]>): Promise<GeneratedPatch> {
    const startedAt = performance.now()
    const timings: Record<string, number> = {}
    const skillMarkdown = await loadLearnedSkill(this.skillFilePath)
    const prompt = buildWorldGenerationPrompt(goal, skillMarkdown)
    this.emit({ phase: 'synthesizing', message: 'Synthesizing the first physics world…' })
    const synthStart = performance.now()
    const interaction = await this.ai.interactions.create({
      model,
      background: true,
      input: prompt,
      response_mime_type: 'application/json',
      response_format: patchResponseSchema,
      generation_config: {
        max_output_tokens: 131_072,
        thinking_level: 'high',
      },
      system_instruction: 'You generate safe, typed Three.js and Rapier level modules for the Argon engine. Follow the output contract and JSON schema exactly.',
    })
    interactionKinds.set(interaction.id, 'model')
    const completed = await this.waitForInteraction(interaction.id, 'Long-decode world generation')
    timings.synthesisMs = Math.round(performance.now() - synthStart)
    const result = await this.parseAndRepair(extractInteractionText(completed), interaction.id, validate, prompt, [], timings)
    timings.totalMs = Math.round(performance.now() - startedAt)
    this.emit({ phase: 'synthesized', message: `Initial world synthesized in ${timings.totalMs}ms.`, durationMs: timings.totalMs, timings })
    return { ...result, timings }
  }

  private async streamFastCritique(
    activeVideo: UploadedFileHandle,
    compactTelemetry: ShrunkTelemetry,
    input: FailedRunInput,
  ): Promise<string> {
    const critiquePrompt = buildCritiquePrompt(input, compactTelemetry)

    const response = await this.ai.interactions.create({
      model: critiqueModel,
      stream: true,
      input: [
        { type: 'video', uri: activeVideo.uri, mime_type: activeVideo.mimeType ?? 'video/webm' },
        { type: 'text', text: critiquePrompt },
      ],
      generation_config: {
        max_output_tokens: 4_096,
        thinking_level: 'low',
      },
    })

    let accumulated = ''
    if (response && typeof (response as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response as AsyncIterable<{
        event_type?: string
        delta?: {
          type?: string
          text?: string
          content?: Array<{ type?: string; text?: string }>
        }
        interaction?: { id?: string; output_text?: string | null }
      }>) {
        if (chunk.interaction?.id) {
          interactionKinds.set(chunk.interaction.id, 'model')
        }
        if (chunk.event_type === 'step.delta') {
          if (chunk.delta?.type === 'text' && typeof chunk.delta.text === 'string' && chunk.delta.text.length > 0) {
            accumulated += chunk.delta.text
            this.emitCritiqueText(input.iteration, accumulated, false)
          }
          for (const part of chunk.delta?.content ?? []) {
            if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
              accumulated += part.text
              this.emitCritiqueText(input.iteration, accumulated, false)
            }
          }
        } else if (
          (chunk.event_type === 'interaction.complete' || chunk.event_type === 'interaction.completed') &&
          !accumulated &&
          chunk.interaction?.output_text
        ) {
          accumulated = chunk.interaction.output_text
        }
      }
    } else if (response && typeof response === 'object' && 'id' in response) {
      const nonStream = response as { id: string; status?: string; output_text?: string | null }
      interactionKinds.set(nonStream.id, 'model')
      const completed =
        nonStream.status === 'completed'
          ? nonStream
          : await this.waitForInteraction(nonStream.id, 'Playtest critique')
      accumulated = extractInteractionText(completed)
    }

    const finalCritique = accumulated.trim() || `Failure at iteration ${input.iteration}: ${input.metadata.failureReason ?? 'Goal not reached'}`
    this.emitCritiqueText(input.iteration, finalCritique, true)
    return finalCritique
  }

  async runManagedAgentCritique(
    prompt: string,
    previousInteractionId?: string,
  ): Promise<{ id: string; text: string }> {
    const chainedAgentId = resolveChainedInteractionId(previousInteractionId, 'agent')
    const interaction = await this.ai.interactions.create({
      agent: managedAgent,
      environment: 'remote',
      ...(chainedAgentId ? { previous_interaction_id: chainedAgentId } : {}),
      input: prompt,
      background: true,
    })
    interactionKinds.set(interaction.id, 'agent')
    const completed = await this.waitForInteraction(interaction.id, 'Managed Agent critique')
    return { id: interaction.id, text: extractInteractionText(completed) }
  }

  async critiqueAndPatchWorld(
    input: FailedRunInput,
    validate: (files: GeneratedFile[]) => Promise<string[]>,
  ): Promise<GeneratedPatch> {
    const startedAt = performance.now()
    const timings: Record<string, number> = {}
    const videoPath = join(tmpdir(), `argon-${randomUUID()}.webm`)
    await writeFile(videoPath, input.videoBytes)
    try {
      this.emit({ phase: 'critiquing', message: 'Uploading the failed run for playtest critique…', iteration: input.iteration })
      const uploadStart = performance.now()
      const uploadedVideo = await this.ai.files.upload({
        file: videoPath,
        config: { mimeType: 'video/webm' },
      })
      const activeVideo = await waitForUploadedFileActive(this.ai.files, uploadedVideo)
      timings.uploadMs = Math.round(performance.now() - uploadStart)

      const compactTelemetry = shrinkTelemetry(input.metadata.telemetry)
      const skillMarkdown = await loadLearnedSkill(this.skillFilePath)

      const critiqueStart = performance.now()
      const critiqueText = await this.streamFastCritique(activeVideo, compactTelemetry, input)
      timings.critiqueMs = Math.round(performance.now() - critiqueStart)

      this.emit({
        phase: 'patching',
        message: 'Synthesizing physics patch from streamed critique…',
        iteration: input.iteration,
        diagnosis: critiqueText,
      })
      const patchPrompt = buildPatchPrompt(input, critiqueText, compactTelemetry, skillMarkdown)

      const patchStart = performance.now()
      const chainedModelId = resolveChainedInteractionId(input.previousInteractionId, 'model')
      const patchInteraction = await this.ai.interactions.create({
        model,
        background: true,
        ...(chainedModelId ? { previous_interaction_id: chainedModelId } : {}),
        input: patchPrompt,
        response_mime_type: 'application/json',
        response_format: patchResponseSchema,
        generation_config: {
          max_output_tokens: 65_536,
          thinking_level: 'low',
        },
        system_instruction: 'You patch Three.js and Rapier level modules for the Argon engine. Return only the files in src/generated/ that changed matching the JSON schema.',
      })
      interactionKinds.set(patchInteraction.id, 'model')
      const completedPatch = await this.waitForInteraction(patchInteraction.id, 'Physics level patch')
      timings.patchMs = Math.round(performance.now() - patchStart)

      const patched = await this.parseAndRepair(
        extractInteractionText(completedPatch),
        patchInteraction.id,
        validate,
        patchPrompt,
        input.currentFiles,
        timings,
      )
      const diagnosis = patched.diagnosis ?? critiqueText
      timings.totalMs = Math.round(performance.now() - startedAt)
      this.emit({
        phase: 'patched',
        message: `Critique and patch completed in ${timings.totalMs}ms (upload ${timings.uploadMs}ms, critique ${timings.critiqueMs}ms, patch ${timings.patchMs}ms).`,
        iteration: input.iteration,
        diagnosis,
        durationMs: timings.totalMs,
        timings,
      })
      return { ...patched, diagnosis, timings }
    } finally {
      await rm(videoPath, { force: true })
    }
  }

  async repairMountFailure(
    input: MountFailureInput,
    validate: (files: GeneratedFile[]) => Promise<string[]>,
  ): Promise<GeneratedPatch> {
    const startedAt = performance.now()
    const timings: Record<string, number> = {}
    const skillMarkdown = await loadLearnedSkill(this.skillFilePath)
    const prompt = [
      `Repair the runtime mount failure in the generated physics level: ${input.error}`,
      ...(input.stack ? [`Stack trace:\n${input.stack}`] : []),
      `Iteration: ${input.iteration}`,
      `Current generated files:\n${JSON.stringify(input.currentFiles)}`,
      ...(skillMarkdown ? [`Learned physics invariants (.agents/SKILL.md):\n${skillMarkdown}`] : []),
      levelContract.trim(),
    ].join('\n\n')
    const chainedModelId = resolveChainedInteractionId(input.previousInteractionId, 'model')
    const interaction = await this.ai.interactions.create({
      model,
      background: true,
      ...(chainedModelId ? { previous_interaction_id: chainedModelId } : {}),
      input: prompt,
      response_mime_type: 'application/json',
      response_format: patchResponseSchema,
      generation_config: {
        max_output_tokens: 65_536,
        thinking_level: 'low',
      },
    })
    interactionKinds.set(interaction.id, 'model')
    const completed = await this.waitForInteraction(interaction.id, 'Mount failure repair')
    const patched = await this.parseAndRepair(
      extractInteractionText(completed),
      interaction.id,
      validate,
      prompt,
      input.currentFiles,
      timings,
    )
    timings.totalMs = Math.round(performance.now() - startedAt)
    return { ...patched, timings }
  }

  async reviseWorld(
    input: ReviseWorldInput,
    validate: (files: GeneratedFile[]) => Promise<string[]>,
  ): Promise<GeneratedPatch> {
    const startedAt = performance.now()
    const timings: Record<string, number> = {}
    const skillMarkdown = await loadLearnedSkill(this.skillFilePath)
    const revisionInstruction = 'twist' in input && input.twist ? input.twist : ('instruction' in input ? input.instruction : '')
    const prompt = [
      `Revise the current physics level according to this instruction: ${revisionInstruction}`,
      ...(input.goal ? [`Original level goal: ${input.goal}`] : []),
      ...('iteration' in input && input.iteration !== undefined ? [`Iteration: ${input.iteration}`] : []),
      `Current generated files:\n${JSON.stringify(input.currentFiles)}`,
      ...(skillMarkdown ? [`Learned physics invariants (.agents/SKILL.md):\n${skillMarkdown}`] : []),
      levelContract.trim(),
    ].join('\n\n')
    const chainedModelId = resolveChainedInteractionId(input.previousInteractionId, 'model')
    const interaction = await this.ai.interactions.create({
      model,
      background: true,
      ...(chainedModelId ? { previous_interaction_id: chainedModelId } : {}),
      input: prompt,
      response_mime_type: 'application/json',
      response_format: patchResponseSchema,
      generation_config: {
        max_output_tokens: 65_536,
        thinking_level: 'low',
      },
    })
    interactionKinds.set(interaction.id, 'model')
    const completed = await this.waitForInteraction(interaction.id, 'World revision')
    const patched = await this.parseAndRepair(
      extractInteractionText(completed),
      interaction.id,
      validate,
      prompt,
      input.currentFiles,
      timings,
    )
    timings.totalMs = Math.round(performance.now() - startedAt)
    return { ...patched, timings }
  }

  private async parseAndRepair(
    output: string,
    interactionId: string,
    validate: (files: GeneratedFile[]) => Promise<string[]>,
    originalPrompt: string,
    currentFiles: GeneratedFile[] = [],
    timings: Record<string, number> = {},
  ): Promise<GeneratedPatch> {
    const typecheckStart = performance.now()
    let candidate = parsePatch(output)
    let diagnostics = await validate(mergeWithCurrentFiles(candidate.files, currentFiles))
    timings.typecheckMs = Math.round(performance.now() - typecheckStart)

    if (diagnostics.length > 0) {
      const repairStart = performance.now()
      this.emit({ phase: 'typecheck-retry', message: 'TypeScript rejected the draft; sending diagnostics for one repair pass.' })
      const chainedModelId = resolveChainedInteractionId(interactionId, 'model')
      const repair = await this.ai.interactions.create({
        model,
        background: true,
        ...(chainedModelId ? { previous_interaction_id: chainedModelId } : {}),
        input: `${originalPrompt}\n\nCompiler diagnostics from the proposed files (repair once):\n${diagnostics.join('\n')}\nReturn only the corrected changed file set as the required JSON object.`,
        response_mime_type: 'application/json',
        response_format: patchResponseSchema,
        generation_config: { max_output_tokens: 65_536, thinking_level: 'low' },
      })
      interactionKinds.set(repair.id, 'model')
      const completed = await this.waitForInteraction(repair.id, 'TypeScript repair pass')
      candidate = parsePatch(extractInteractionText(completed))
      diagnostics = await validate(mergeWithCurrentFiles(candidate.files, currentFiles))
      timings.repairMs = Math.round(performance.now() - repairStart)
      if (diagnostics.length > 0) throw new Error(`Generated TypeScript still fails after one repair pass:\n${diagnostics.join('\n')}`)
      interactionId = repair.id
    }
    const changedFiles = filterChangedFiles(candidate.files, currentFiles)
    return {
      files: changedFiles,
      diagnosis: candidate.diagnosis,
      skillContent: candidate.skillContent,
      interactionId,
      timings,
    }
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
