import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { PlaytestFailedMetadata } from '../src/shared/protocol.ts'
import type { GeneratedFile } from './generatedFiles.ts'

const model = process.env.ARGON_MODEL ?? 'gemini-4-argon'
const critiqueModel = process.env.ARGON_CRITIQUE_MODEL ?? 'gemini-3.8-flash'
const managedAgent = process.env.ARGON_AGENT ?? 'antigravity-preview-09-2026'
const pollIntervalMs = 1_000
const defaultManagedAgentTimeoutMs = 90_000
export const MAX_CONTEXT_WINDOW_TOKENS = 1_048_576
export const MAX_OUTPUT_TOKENS = Number(process.env.ARGON_MAX_OUTPUT_TOKENS) || 1_048_576
const defaultWorldMaxOutputTokens = MAX_OUTPUT_TOKENS
const defaultSkillPath = resolve(process.cwd(), '.agents/SKILL.md')

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

export function resolveWorldThinkingLevel(env: NodeJS.ProcessEnv = process.env): ThinkingLevel {
  const raw = (env.ARGON_WORLD_THINKING ?? '').trim().toLowerCase()
  if (raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high') {
    return raw
  }
  return 'medium'
}

export function isAssetKitAvailable(projectRoot = process.cwd()): boolean {
  return existsSync(resolve(projectRoot, 'src/engine/assetKit.ts'))
}

export const BUILDER_FILE_PATHS = [
  'src/generated/scene.ts',
  'src/generated/mechanics.ts',
  'src/generated/activeLevel.ts',
] as const

export type BuilderFilePath = (typeof BUILDER_FILE_PATHS)[number]

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

export const worldPlanSchema = {
  type: 'object',
  properties: {
    layoutAlongX: { type: 'string' },
    namedBodies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          owner: { type: 'string' },
          bodyType: { type: 'string' },
          shape: { type: 'string' },
          position: { type: 'array', items: { type: 'number' } },
          size: { type: 'array', items: { type: 'number' } },
          role: { type: 'string' },
        },
        required: ['name', 'owner', 'bodyType', 'position', 'size', 'role'],
      },
    },
    controls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          action: { type: 'string' },
        },
        required: ['key', 'action'],
      },
    },
    goal: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        body: { type: 'string' },
        y: { type: 'number' },
        min: { type: 'array', items: { type: 'number' } },
        max: { type: 'array', items: { type: 'number' } },
        target: { type: 'array', items: { type: 'number' } },
        radius: { type: 'number' },
      },
      required: ['type', 'body'],
    },
    fileOwnership: {
      type: 'object',
      properties: {
        scene: { type: 'string' },
        mechanics: { type: 'string' },
        activeLevel: { type: 'string' },
      },
      required: ['scene', 'mechanics', 'activeLevel'],
    },
  },
  required: ['layoutAlongX', 'namedBodies', 'controls', 'goal', 'fileOwnership'],
} as const

export interface PlannedBodySpec {
  name: string
  owner: 'scene' | 'mechanics'
  bodyType: 'fixed' | 'dynamic' | 'kinematicPosition'
  shape?: 'box' | 'ball' | 'capsule'
  position: [number, number, number]
  size: [number, number, number]
  role: string
}

export interface WorldPlanSpec {
  layoutAlongX: string
  namedBodies: PlannedBodySpec[]
  controls: Array<{ key: string; action: string }>
  goal: {
    type: 'below-y' | 'above-y' | 'in-region' | 'near-point'
    body: string
    y?: number
    min?: [number, number, number]
    max?: [number, number, number]
    target?: [number, number, number]
    radius?: number
  }
  fileOwnership: {
    scene: string
    mechanics: string
    activeLevel: string
  }
}

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

export interface ContextTelemetry {
  promptChars: number
  contextTokensEstimate: number
  maxContextTokens: number
  maxOutputTokens: number
  thinkingLevel: ThinkingLevel
  packedFiles: string[]
  thoughtSummary?: string
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
  contextTelemetry?: ContextTelemetry
  thoughtSummary?: string
}

export interface GeneratedPatch {
  files: GeneratedFile[]
  interactionId: string
  skillContent?: string
  diagnosis?: string
  timings?: Record<string, number>
  contextTelemetry?: ContextTelemetry
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

export const assetKitGuidance = `
Reusable 3D Asset & Gameplay Kit ('../engine/assetKit'):
Prefer importing ready-made models and helpers from '../engine/assetKit' instead of building raw box/sphere programmer art:
- Models (return THREE.Group, take { position?: [x,y,z], scale?: number | [x,y,z], color?: number }):
  createCharacter(opts?), createEnemy(opts?), createTree(opts?), createRock(opts?),
  createCrate(opts?), createCoin(opts?), createItemBlock(opts?), createGoalFlag(opts?),
  createCastleTower({ position?, scale?, color?, roofColor? }),
  createPlatformTile({ position?, scale?, color?, topColor?, size?: [w,h,d] })
- VFX & procedural animation helpers:
  createPooledParticles(scene, maxParticles?) -> { burst(origin, color, count?, speed?), step(dt), dispose() }
  animateCharacterGroup(group, speed, elapsedSeconds, grounded?)
  createPBRMaterial({ color, metalness?, roughness?, clearcoat?, bumpKind?: 'stone' | 'wood' | 'metal' | 'tech' })
- Background scenery instancing:
  scatter(scene, templateGroup, count, { min: [minX, minZ], max: [maxX, maxZ], y?: number, minRadius?: number }, seed?)
- Physics collider helper:
  createBodyWithCollider(world, { type?: 'dynamic' | 'fixed' | 'kinematicPosition', shape?: 'box' | 'capsule' | 'ball', position?: [x,y,z], size?: [w,h,d], halfHeight?: number, radius?: number, density?: number, friction?: number, restitution?: number, lockRotations?: boolean })
- Gameplay helpers:
  - createPlayerController(world, body, { moveSpeed?, jumpSpeed?, leftKeys?, rightKeys?, jumpKeys? }) -> { heldKeys, onPointerOrKey(event), step(), syncMesh(mesh) }
  - collectOnce(mesh, { radius?, onCollect? }) -> { triggered, check(actorBody), reset() }
  - hitFromBelow(blockMesh, { width?, reachY?, once?, onHit? }) -> { triggered, check(actorBody), reset() }
`

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
- When '../engine/assetKit' is available, import models and helpers from '../engine/assetKit' (createCharacter, createEnemy, createTree, createRock, createCrate, createCoin, createItemBlock, createGoalFlag, createPlatformTile, scatter, createBodyWithCollider, createPlayerController, collectOnce, hitFromBelow) instead of building everything from boxes.
- Import * as THREE from 'three' and RAPIER from '@dimforge/rapier3d-compat'. Keep all generated files as direct children of src/generated/ (with entry module src/generated/activeLevel.ts).
- Return one JSON object only matching the response schema: {"files":[{"path":"src/generated/activeLevel.ts","content":"..."}],"diagnosis":"short summary with video timestamps when available","skillContent":"Markdown physical invariants learned from evidence, or empty when none"}.
- For patches, return only the files in src/generated/ that changed. Never use eval, Function, remote script loading, or write outside src/generated/.
`

export const multiFileModuleContract = `
Shared 3-file module contract for parallel builders (MUST match these exact exports and signatures):
1. src/generated/scene.ts:
   - Owns static/environment terrain, platforms, structures, scenery, and all namedBodies where owner === "scene".
   - Must export:
     export interface SceneHandle {
       dispose: () => void;
     }
     export function buildScene(
       scene: THREE.Scene,
       world: RAPIER.World,
       namedBodies: Map<string, RAPIER.RigidBody>,
     ): SceneHandle
2. src/generated/mechanics.ts:
   - Owns player controller, enemies, interactive blocks, pickups, projectiles, contact/interaction logic, and all namedBodies where owner === "mechanics".
   - Must export:
     export interface MechanicsHandle {
       onPointerOrKey: (event: { type: string; key?: string; code?: string; ndc?: [number, number] }) => void;
       stepBot: (frameIndex: number, elapsedSeconds: number) => { botState: string; failedEarly?: string };
       stepHuman: (frameIndex: number, elapsedSeconds: number) => { botState: string; failedEarly?: string };
       dispose: () => void;
     }
     export function buildMechanics(
       scene: THREE.Scene,
       world: RAPIER.World,
       namedBodies: Map<string, RAPIER.RigidBody>,
       eventQueue: RAPIER.EventQueue,
     ): MechanicsHandle
3. src/generated/activeLevel.ts:
   - Entry module that imports { buildScene } from './scene' and { buildMechanics } from './mechanics'.
   - Exports buildWorld(scene, world, namedBodies, eventQueue): MountedLevel matching src/engine/types.ts.
   - Declares controls: ControlBinding[] and goal: LevelGoal from the planner spec, evaluates goalReached in stepBotAndRules and stepHumanAndRules, forwards onPointerOrKey to mechanics.onPointerOrKey, and calls mechanics.dispose() and sceneHandle.dispose() in dispose().
`

export async function loadLearnedSkill(skillFilePath = defaultSkillPath): Promise<string> {
  try {
    return (await readFile(skillFilePath, 'utf8')).trim()
  } catch {
    return ''
  }
}

export const ENGINE_CONTEXT_FILES = [
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
  'src/fixtures/cached-bowling-01-mechanics.level',
  'src/fixtures/cached-domino-01-activeLevel.level',
  'src/fixtures/cached-orbital-01-activeLevel.level',
] as const

let cachedEnginePack: { root: string; text: string; files: string[] } | null = null

export function buildEngineContextPack(projectRoot = process.cwd()): { text: string; files: string[] } {
  if (cachedEnginePack && cachedEnginePack.root === projectRoot) {
    return { text: cachedEnginePack.text, files: cachedEnginePack.files }
  }
  const chunks: string[] = []
  const packedFiles: string[] = []
  for (const relPath of ENGINE_CONTEXT_FILES) {
    try {
      const absPath = resolve(projectRoot, relPath)
      if (!existsSync(absPath)) continue
      const source = readFileSync(absPath, 'utf8').trim()
      if (!source) continue
      packedFiles.push(relPath)
      chunks.push(`// === FULL ENGINE & WORLD REFERENCE: ${relPath} ===\n${source}`)
    } catch {
      // Ignore unreadable optional files
    }
  }
  const text = chunks.length > 0
    ? `1M-Context Full Engine & Multi-World Architecture Pack (Verbatim TypeScript contracts, AAA procedural kits, & multi-module reference worlds):\n${chunks.join('\n\n')}`
    : ''
  cachedEnginePack = { root: projectRoot, text, files: packedFiles }
  return { text, files: packedFiles }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.8))
}

export function createContextTelemetry(
  prompt: string,
  thinkingLevel: ThinkingLevel,
  maxOutputTokens = defaultWorldMaxOutputTokens,
  thoughtSummary?: string,
  projectRoot = process.cwd(),
): ContextTelemetry {
  const { files } = buildEngineContextPack(projectRoot)
  return {
    promptChars: prompt.length,
    contextTokensEstimate: estimateTokens(prompt),
    maxContextTokens: MAX_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens,
    thinkingLevel,
    packedFiles: files,
    thoughtSummary,
  }
}

export function buildWorldGenerationPrompt(goal: string, skillMarkdown = ''): string {
  const enginePack = buildEngineContextPack()
  const sections = [
    `Create a complete physics sandbox level for this goal: ${goal}`,
    levelContract.trim(),
  ]
  if (isAssetKitAvailable()) {
    sections.push(assetKitGuidance.trim())
  }
  if (enginePack.text) {
    sections.push(enginePack.text)
  }
  if (skillMarkdown.trim()) {
    sections.push(`Learned physics invariants from .agents/SKILL.md (apply these invariants when designing the level):\n${skillMarkdown.trim()}`)
  }
  return sections.join('\n\n')
}

export function buildWorldPlanPrompt(
  goal: string,
  skillMarkdown = '',
  options: { useAssetKit?: boolean } = {},
): string {
  const useAssetKit = options.useAssetKit ?? isAssetKitAvailable()
  const sections = [
    `Plan a 3-file 3D physics level for this goal: ${goal}`,
    'Return ONLY a JSON specification matching the schema (no TypeScript or code):',
    '- layoutAlongX: concise spatial layout along the x-axis with coordinates, heights, and reachable gaps.',
    '- namedBodies: every key rigid body with exact name, owner ("scene" for static/terrain or "mechanics" for player/enemies/pickups/projectiles), bodyType ("fixed" | "dynamic" | "kinematicPosition"), shape ("box" | "ball" | "capsule"), position [x, y, z], size [w, h, d], and role.',
    '- controls: declared human controls using KeyboardEvent.code values (e.g. "KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight", "Space", "ShiftLeft").',
    '- goal: declarative LevelGoal referencing the target body name in namedBodies.',
    '- fileOwnership: what src/generated/scene.ts (terrain, scenery, models), src/generated/mechanics.ts (player controller, enemies, pickups, interactions), and src/generated/activeLevel.ts (imports the other two, bot, goal, controls, MountedLevel) each own.',
    useAssetKit
      ? `Tell the builders in fileOwnership to import models and gameplay helpers from '../engine/assetKit' (createCharacter, createEnemy, createTree, createRock, createCrate, createCoin, createItemBlock, createGoalFlag, createCastleTower, createPlatformTile, createPooledParticles, animateCharacterGroup, createPBRMaterial, scatter, createBodyWithCollider, createPlayerController, collectOnce, hitFromBelow) instead of building everything from boxes.\n\n${assetKitGuidance.trim()}`
      : "When '../engine/assetKit' is available, builders import models and helpers from '../engine/assetKit' instead of building everything from boxes.",
  ]
  if (skillMarkdown.trim()) {
    sections.push(`Learned physics invariants (.agents/SKILL.md):\n${skillMarkdown.trim()}`)
  }
  return sections.join('\n\n')
}

export function buildModuleBuilderPrompt(
  targetPath: BuilderFilePath,
  goal: string,
  spec: WorldPlanSpec,
  skillMarkdown = '',
  options: { useAssetKit?: boolean } = {},
): string {
  const useAssetKit = options.useAssetKit ?? isAssetKitAvailable()
  const enginePack = buildEngineContextPack()
  const roleSpecificInstructions =
    targetPath === 'src/generated/scene.ts'
      ? [
          'Write ONLY src/generated/scene.ts (terrain, platforms, scenery, models, and all namedBodies in the spec with owner === "scene").',
          'Export SceneHandle and buildScene(scene, world, namedBodies): SceneHandle exactly as specified in the 3-file contract.',
          'Register every "scene" body from spec.namedBodies in namedBodies.set(name, body) using the exact name and coordinates in the spec.',
        ].join('\n')
      : targetPath === 'src/generated/mechanics.ts'
        ? [
            'Write ONLY src/generated/mechanics.ts (player controller, enemies, pickups, interactive blocks, projectiles, and all namedBodies in the spec with owner === "mechanics").',
            'Export MechanicsHandle and buildMechanics(scene, world, namedBodies, eventQueue): MechanicsHandle exactly as specified in the 3-file contract.',
            'Register every "mechanics" body from spec.namedBodies in namedBodies.set(name, body) using the exact name and coordinates in the spec.',
            'Handle every control binding in spec.controls by matching event.code in onPointerOrKey and applying physical movement/impulses in stepHuman (if both WASD and Arrow keys are declared, both must work).',
            'Ensure interactions fire only on the directional contact implied by the goal (hit from below, stomp from above, touch—never mere proximity), keep rewards/spawns finite, and make stepBot exercise the main mechanics on its way to the goal.',
          ].join('\n')
        : [
            'Write ONLY src/generated/activeLevel.ts.',
            "Import { buildScene } from './scene' and { buildMechanics } from './mechanics'.",
            'Export buildWorld(scene, world, namedBodies, eventQueue): MountedLevel.',
            'Call buildScene(scene, world, namedBodies) and buildMechanics(scene, world, namedBodies, eventQueue), expose spec.controls and spec.goal, evaluate whether spec.goal is reached against namedBodies in stepBotAndRules and stepHumanAndRules, delegate onPointerOrKey to mechanics.onPointerOrKey, and dispose both in dispose().',
          ].join('\n')

  const assetLine = useAssetKit
    ? `${assetKitGuidance.trim()}\nImport models and helpers from '../engine/assetKit' instead of building everything from boxes.`
    : "Note: Do not add an import statement for '../engine/assetKit' unless src/engine/assetKit.ts is present on disk; use Three.js primitives and '../engine/breakageKit' when needed."

  const sections = [
    `Goal: ${goal}`,
    roleSpecificInstructions,
    `Planner JSON specification:\n${JSON.stringify(spec, null, 2)}`,
    multiFileModuleContract.trim(),
    assetLine,
    levelContract.trim(),
    ...(useAssetKit && enginePack.text ? [enginePack.text] : []),
    ...(skillMarkdown.trim() ? [`Learned physics invariants (.agents/SKILL.md):\n${skillMarkdown.trim()}`] : []),
    `Return ONLY a JSON object with a single file entry: {"files":[{"path":"${targetPath}","content":"..."}]}`,
  ]
  return sections.join('\n\n')
}

export function parseWorldPlan(output: string): WorldPlanSpec {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Planner returned no JSON object')
  let parsed: unknown
  try {
    parsed = JSON.parse(output.slice(start, end + 1))
  } catch (error) {
    throw new Error(`Planner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Planner spec must be an object')
  const candidate = parsed as Partial<WorldPlanSpec>
  if (
    typeof candidate.layoutAlongX !== 'string' ||
    !Array.isArray(candidate.namedBodies) ||
    candidate.namedBodies.length === 0 ||
    !Array.isArray(candidate.controls) ||
    !candidate.goal ||
    typeof candidate.goal.type !== 'string' ||
    typeof candidate.goal.body !== 'string' ||
    !candidate.fileOwnership ||
    typeof candidate.fileOwnership.scene !== 'string' ||
    typeof candidate.fileOwnership.mechanics !== 'string' ||
    typeof candidate.fileOwnership.activeLevel !== 'string'
  ) {
    throw new Error('Planner spec is missing required fields (layoutAlongX, namedBodies, controls, goal, fileOwnership)')
  }
  return candidate as WorldPlanSpec
}

export function identifyFailingFiles(files: GeneratedFile[], diagnostics: string[]): GeneratedFile[] {
  const joined = diagnostics.join('\n')
  const matched = files.filter((file) => {
    const base = basename(file.path)
    return joined.includes(file.path) || joined.includes(base)
  })
  return matched.length > 0 ? matched : files
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

export function extractInteractionThoughts(interaction: {
  steps?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string; thought?: boolean }>
  }>
}): string {
  const thoughts: string[] = []
  for (const step of interaction.steps ?? []) {
    if (step.type === 'thought' || step.type === 'thinking' || step.type === 'reasoning') {
      for (const part of step.content ?? []) {
        if (typeof part.text === 'string' && part.text.trim()) {
          thoughts.push(part.text.trim())
        }
      }
      continue
    }
    for (const part of step.content ?? []) {
      if ((part.type === 'thought' || part.thought === true) && typeof part.text === 'string' && part.text.trim()) {
        thoughts.push(part.text.trim())
      }
    }
  }
  return thoughts.join('\n\n')
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
    'Inspect the compacted frame telemetry, key contact/fall events, and the current generated files.',
    'Check declared controls and interactive object behaviour against the goal, not just whether the goal was reached:',
    '1. TOP PRIORITY — Dead controls: If the failure reason reports dead controls (e.g. "Declared controls did nothing: ..."), treat fixing every dead binding as the #1 priority. Verify that controls are declared with KeyboardEvent.code (e.g. \'KeyW\', \'KeyA\', \'ArrowUp\', \'Space\', \'ShiftLeft\'), onPointerOrKey matches on event.code, and every declared binding (including both WASD and Arrow keys when both are declared) produces a physical action in onPointerOrKey/stepHumanAndRules.',
    '2. Directional contact over proximity: Check that interactive objects fire on the specific physical contact implied by the goal (hit from below, stomp from above, direct touch/collision), never on mere proximity.',
    '3. Finite rewards & reachability: Check that rewards/spawns are finite unless the goal requests endless spawning, and that every interactive object is physically reachable by both the bot and a human player.',
    '4. Bot mechanic coverage: Check that stepBotAndRules exercises the level\'s main mechanics on its way to the goal (uses the declared jump/ability, hits interactive blocks/targets) rather than taking a straight run to the goal.',
    'Write a concise, plain-text diagnosis (2-4 sentences) citing timestamps/frames, telemetry events, and exact control/mechanic defects to fix. Do not output code or JSON in this critique step. If you have a code execution sandbox, run at most one fast calculation only if strictly necessary; do not inspect files or run multi-step scripts.',
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
  const enginePack = buildEngineContextPack()
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
    ...(enginePack.text ? [enginePack.text] : []),
    levelContract.trim(),
  ].join('\n\n')
}

export class ArgonOrchestrator {
  private readonly ai: GoogleGenAI
  public managedAgentTimeoutMs = defaultManagedAgentTimeoutMs

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

  async generateSingleCallWorld(
    goal: string,
    skillMarkdown: string,
    validate: (files: GeneratedFile[]) => Promise<string[]>,
    timings: Record<string, number> = {},
    startedAt = performance.now(),
  ): Promise<GeneratedPatch> {
    const thinkingLevel = resolveWorldThinkingLevel()
    const prompt = buildWorldGenerationPrompt(goal, skillMarkdown)
    const initialContext = createContextTelemetry(prompt, thinkingLevel, defaultWorldMaxOutputTokens)
    this.emit({
      phase: 'synthesizing',
      message: `Synthesizing physics world (single-call, thinking: ${thinkingLevel})…`,
      contextTelemetry: initialContext,
    })
    const synthStart = performance.now()
    const interaction = await this.ai.interactions.create({
      model,
      background: true,
      input: prompt,
      response_mime_type: 'application/json',
      response_format: patchResponseSchema,
      generation_config: {
        max_output_tokens: defaultWorldMaxOutputTokens,
        thinking_level: thinkingLevel,
      },
      system_instruction: 'You generate safe, typed Three.js and Rapier level modules for the Argon engine. Follow the output contract and JSON schema exactly.',
    })
    interactionKinds.set(interaction.id, 'model')
    const completed = await this.waitForInteraction(interaction.id, 'Long-decode world generation')
    const thoughtSummary = extractInteractionThoughts(completed) || undefined
    const contextTelemetry = createContextTelemetry(prompt, thinkingLevel, defaultWorldMaxOutputTokens, thoughtSummary)
    timings.synthesisMs = Math.round(performance.now() - synthStart)
    const result = await this.parseAndRepair(extractInteractionText(completed), interaction.id, validate, prompt, [], timings)
    timings.totalMs = Math.round(performance.now() - startedAt)
    console.log(`[ArgonOrchestrator] Single-call world generation (thinking=${thinkingLevel}) completed in ${timings.totalMs}ms (synthesis ${timings.synthesisMs}ms).`)
    this.emit({
      phase: 'synthesized',
      message: `Initial world synthesized in ${timings.totalMs}ms.`,
      durationMs: timings.totalMs,
      timings,
      contextTelemetry,
      thoughtSummary,
    })
    return { ...result, timings, contextTelemetry }
  }

  private async runPlanner(goal: string, skillMarkdown: string): Promise<{ spec: WorldPlanSpec; interactionId: string; thoughtSummary?: string; prompt: string }> {
    const planPrompt = buildWorldPlanPrompt(goal, skillMarkdown)
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const interaction = await this.ai.interactions.create({
          model,
          background: true,
          input: planPrompt,
          ...(attempt < 3
            ? {
                response_mime_type: 'application/json',
                response_format: worldPlanSchema,
              }
            : {}),
          generation_config: {
            max_output_tokens: defaultWorldMaxOutputTokens,
            thinking_level: 'low',
          },
          system_instruction: 'You are the fast level planner for the Argon 3D physics engine. Return only a valid JSON specification with no code.',
        })
        interactionKinds.set(interaction.id, 'model')
        const completed = await this.waitForInteraction(interaction.id, 'World planner', 90_000)
        const spec = parseWorldPlan(extractInteractionText(completed))
        const thoughtSummary = extractInteractionThoughts(completed) || undefined
        return { spec, interactionId: interaction.id, thoughtSummary, prompt: planPrompt }
      } catch (error) {
        lastError = error
        if (attempt < 3) {
          this.emit({
            phase: 'synthesizing',
            message: `Planner attempt ${attempt} encountered a transient API error; retrying planner immediately…`,
          })
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async runModuleBuilder(
    targetPath: BuilderFilePath,
    goal: string,
    spec: WorldPlanSpec,
    skillMarkdown: string,
  ): Promise<{ file: GeneratedFile; interactionId: string; thoughtSummary?: string; prompt: string }> {
    const builderPrompt = buildModuleBuilderPrompt(targetPath, goal, spec, skillMarkdown)
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const interaction = await this.ai.interactions.create({
          model,
          background: true,
          input: builderPrompt,
          ...(attempt < 3
            ? {
                response_mime_type: 'application/json',
                response_format: patchResponseSchema,
              }
            : {}),
          generation_config: {
            max_output_tokens: defaultWorldMaxOutputTokens,
            thinking_level: 'low',
          },
          system_instruction: `You are the parallel module builder for ${targetPath}. Follow the shared 3-file TypeScript contract and return only ${targetPath} in the JSON files array.`,
        })
        interactionKinds.set(interaction.id, 'model')
        const completed = await this.waitForInteraction(interaction.id, `Builder ${basename(targetPath)}`)
        const parsed = parsePatch(extractInteractionText(completed))
        const matching = parsed.files.find((file) => file.path === targetPath) ?? parsed.files[0]
        if (!matching || !matching.content.trim()) {
          throw new Error(`Builder for ${targetPath} returned no file content`)
        }
        return {
          file: { path: targetPath, content: matching.content },
          interactionId: interaction.id,
          thoughtSummary: extractInteractionThoughts(completed) || undefined,
          prompt: builderPrompt,
        }
      } catch (error) {
        lastError = error
        if (attempt < 3) {
          this.emit({
            phase: 'synthesizing',
            message: `Builder ${basename(targetPath)} attempt ${attempt} encountered a transient API error; retrying ${basename(targetPath)} immediately…`,
          })
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  async generateInitialWorld(goal: string, validate: (files: GeneratedFile[]) => Promise<string[]>): Promise<GeneratedPatch> {
    const startedAt = performance.now()
    const timings: Record<string, number> = {}
    const skillMarkdown = await loadLearnedSkill(this.skillFilePath)

    if (process.env.ARGON_DISABLE_PARALLEL_BUILD === '1') {
      return this.generateSingleCallWorld(goal, skillMarkdown, validate, timings, startedAt)
    }

    const previewPrompt = buildWorldPlanPrompt(goal, skillMarkdown)
    const initialContext = createContextTelemetry(previewPrompt, resolveWorldThinkingLevel(), defaultWorldMaxOutputTokens)
    this.emit({
      phase: 'synthesizing',
      message: 'Planning level layout, named bodies, controls, and file ownership…',
      contextTelemetry: initialContext,
    })
    const planStart = performance.now()
    const { spec, thoughtSummary: planThoughts, prompt: planPrompt } = await this.runPlanner(goal, skillMarkdown)
    timings.planMs = Math.round(performance.now() - planStart)

    this.emit({
      phase: 'synthesizing',
      message: `Plan ready in ${timings.planMs}ms; running 3 parallel module builders (scene, mechanics, activeLevel)…`,
      thoughtSummary: planThoughts,
    })
    const buildersStart = performance.now()
    const builderResults = await Promise.all(
      BUILDER_FILE_PATHS.map((targetPath) => this.runModuleBuilder(targetPath, goal, spec, skillMarkdown)),
    )
    timings.buildersMs = Math.round(performance.now() - buildersStart)
    timings.synthesisMs = timings.planMs + timings.buildersMs

    let files = builderResults.map((result) => result.file)
    let lastInteractionId = builderResults[builderResults.length - 1]!.interactionId
    const combinedPrompts = [planPrompt, ...builderResults.map((r) => r.prompt)].join('\n\n')
    const combinedThoughts = [planThoughts, ...builderResults.map((r) => r.thoughtSummary)].filter(Boolean).join('\n\n') || undefined
    const contextTelemetry = createContextTelemetry(combinedPrompts, resolveWorldThinkingLevel(), defaultWorldMaxOutputTokens, combinedThoughts)

    const typecheckStart = performance.now()
    let diagnostics = await validate(files)
    timings.typecheckMs = Math.round(performance.now() - typecheckStart)

    if (diagnostics.length > 0) {
      const repairStart = performance.now()
      const failingFiles = identifyFailingFiles(files, diagnostics)
      this.emit({
        phase: 'typecheck-retry',
        message: `TypeScript reported errors in ${failingFiles.map((f) => basename(f.path)).join(', ')}; running one targeted repair pass…`,
      })
      const repairPrompt = [
        `Goal: ${goal}`,
        `Planner JSON specification:\n${JSON.stringify(spec, null, 2)}`,
        multiFileModuleContract.trim(),
        levelContract.trim(),
        `Failing file(s) to repair (resend ONLY these corrected file(s)):\n${JSON.stringify(failingFiles)}`,
        `Compiler diagnostics:\n${diagnostics.join('\n')}`,
        'Return only the repaired failing file(s) as the required JSON object.',
      ].join('\n\n')
      const repairInteraction = await this.ai.interactions.create({
        model,
        background: true,
        input: repairPrompt,
        response_mime_type: 'application/json',
        response_format: patchResponseSchema,
        generation_config: {
          max_output_tokens: defaultWorldMaxOutputTokens,
          thinking_level: 'low',
        },
        system_instruction: 'Repair only the failing TypeScript file(s) so all three generated modules compile cleanly together.',
      })
      interactionKinds.set(repairInteraction.id, 'model')
      const completedRepair = await this.waitForInteraction(repairInteraction.id, 'Parallel builder repair pass')
      const repairedPatch = parsePatch(extractInteractionText(completedRepair))
      files = mergeWithCurrentFiles(repairedPatch.files, files)
      diagnostics = await validate(files)
      timings.repairMs = Math.round(performance.now() - repairStart)
      if (diagnostics.length > 0) {
        throw new Error(`Parallel build still has TypeScript errors after repair:\n${diagnostics.join('\n')}`)
      }
      lastInteractionId = repairInteraction.id
    }

    timings.totalMs = Math.round(performance.now() - startedAt)
    console.log(
      `[ArgonOrchestrator] Parallel world generation completed in ${timings.totalMs}ms (plan ${timings.planMs}ms, builders ${timings.buildersMs}ms, typecheck ${timings.typecheckMs}ms${timings.repairMs ? `, repair ${timings.repairMs}ms` : ''}).`,
    )
    this.emit({
      phase: 'synthesized',
      message: `Initial world synthesized in ${timings.totalMs}ms (plan ${timings.planMs}ms, parallel builders ${timings.buildersMs}ms).`,
      durationMs: timings.totalMs,
      timings,
      contextTelemetry,
      thoughtSummary: combinedThoughts,
    })
    return {
      files,
      interactionId: lastInteractionId,
      diagnosis: `Built in ${timings.totalMs}ms via planner + 3 parallel builders.`,
      timings,
      contextTelemetry,
    }
  }

  private async streamFastCritique(
    compactTelemetry: ShrunkTelemetry,
    input: FailedRunInput,
  ): Promise<string> {
    const critiquePrompt = buildCritiquePrompt(input, compactTelemetry)

    const response = await this.ai.interactions.create({
      model: critiqueModel,
      stream: true,
      input: critiquePrompt,
      generation_config: {
        max_output_tokens: defaultWorldMaxOutputTokens,
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
    options: { video?: UploadedFileHandle; timeoutMs?: number; iteration?: number } = {},
  ): Promise<{ id: string; text: string }> {
    const chainedAgentId = resolveChainedInteractionId(previousInteractionId, 'agent')
    const timeoutMs = options.timeoutMs ?? this.managedAgentTimeoutMs
    const interaction = await this.ai.interactions.create({
      agent: managedAgent,
      environment: 'remote',
      ...(chainedAgentId ? { previous_interaction_id: chainedAgentId } : {}),
      input: prompt,
      background: true,
    })
    interactionKinds.set(interaction.id, 'agent')
    const completed = await this.waitForInteraction(interaction.id, 'Managed Agent critique', timeoutMs)
    const text = extractInteractionText(completed).trim()
    if (!text) {
      throw new Error('Managed Agent critique returned empty output')
    }
    if (options.iteration !== undefined) {
      this.emitCritiqueText(options.iteration, text, true)
    }
    return { id: interaction.id, text }
  }

  async critiqueAndPatchWorld(
    input: FailedRunInput,
    validate: (files: GeneratedFile[]) => Promise<string[]>,
  ): Promise<GeneratedPatch> {
    const startedAt = performance.now()
    const timings: Record<string, number> = { uploadMs: 0 }
    const compactTelemetry = shrinkTelemetry(input.metadata.telemetry)
    const skillMarkdown = await loadLearnedSkill(this.skillFilePath)
    const critiquePrompt = buildCritiquePrompt(input, compactTelemetry)

    this.emit({
      phase: 'critiquing',
      message: 'Running playtest critique on telemetry and level code…',
      iteration: input.iteration,
    })

    const critiqueStart = performance.now()
    let critiqueText: string
    try {
      const agentCritique = await this.runManagedAgentCritique(
        critiquePrompt,
        input.previousInteractionId,
        {
          timeoutMs: this.managedAgentTimeoutMs,
          iteration: input.iteration,
        },
      )
      critiqueText = agentCritique.text
    } catch {
      this.emit({
        phase: 'critiquing',
        message: 'Streaming playtest telemetry critique…',
        iteration: input.iteration,
      })
      critiqueText = await this.streamFastCritique(compactTelemetry, input)
    }
    timings.critiqueMs = Math.round(performance.now() - critiqueStart)

      this.emit({
        phase: 'patching',
        message: 'Synthesizing physics patch from critique…',
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
          max_output_tokens: defaultWorldMaxOutputTokens,
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
        max_output_tokens: defaultWorldMaxOutputTokens,
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
        max_output_tokens: defaultWorldMaxOutputTokens,
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
    let mergedFiles = mergeWithCurrentFiles(candidate.files, currentFiles)
    let diagnostics = await validate(mergedFiles)
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
        generation_config: { max_output_tokens: defaultWorldMaxOutputTokens, thinking_level: 'low' },
      })
      interactionKinds.set(repair.id, 'model')
      const completed = await this.waitForInteraction(repair.id, 'TypeScript repair pass')
      candidate = parsePatch(extractInteractionText(completed))
      mergedFiles = mergeWithCurrentFiles(candidate.files, currentFiles)
      diagnostics = await validate(mergedFiles)
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

  private async waitForInteraction(id: string, label: string, timeoutMs = 20 * 60_000) {
    const seenSteps = new Set<string>()
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (Date.now() > deadline) throw new Error(`${label} exceeded the ${Math.round(timeoutMs / 1000)}s polling limit`)
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
  return { files, diagnosis: typeof value.diagnosis === 'string' ? value.diagnosis : undefined, skillContent: typeof value.skillContent === 'string' ? value.skillContent : undefined }
}

