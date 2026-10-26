import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ArgonOrchestrator,
  BUILDER_FILE_PATHS,
  MAX_CONTEXT_WINDOW_TOKENS,
  buildCritiquePrompt,
  buildEngineContextPack,
  buildModuleBuilderPrompt,
  buildPatchPrompt,
  buildWorldGenerationPrompt,
  buildWorldPlanPrompt,
  createContextTelemetry,
  createCritiqueTextMessage,
  extractInteractionText,
  extractInteractionThoughts,
  filterChangedFiles,
  identifyFailingFiles,
  levelContract,
  loadLearnedSkill,
  mergeWithCurrentFiles,
  patchResponseSchema,
  resolveChainedInteractionId,
  resolveWorldThinkingLevel,
  shrinkTelemetry,
  waitForUploadedFileActive,
  worldPlanSchema,
  type FailedRunInput,
  type OrchestratorEvent,
  type TelemetryFrame,
  type WorldPlanSpec,
} from './argonOrchestrator.ts'

test('extractInteractionText concatenates all model_output steps and falls back to output_text', () => {
  const multiStep = extractInteractionText({
    output_text: 'step 2 only',
    steps: [
      { type: 'model_output', content: [{ type: 'text', text: 'step 1 text' }] },
      { type: 'code_execution_result', content: [{ type: 'text', text: 'ignored tool output' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'step 2 only' }] },
    ],
  })
  assert.equal(multiStep, 'step 1 text\nstep 2 only')
  assert.equal(extractInteractionText({ output_text: 'fallback text' }), 'fallback text')
})

test('waitForUploadedFileActive polls until ACTIVE, rejects FAILED, and enforces timeout', async () => {
  let polls = 0
  const active = await waitForUploadedFileActive(
    {
      get: async ({ name }) => {
        polls += 1
        return {
          name,
          uri: 'https://example.com/video.webm',
          mimeType: 'video/webm',
          state: polls < 2 ? 'PROCESSING' : 'ACTIVE',
        }
      },
    },
    { name: 'files/abc123', state: 'PROCESSING' },
    5_000,
    5,
  )
  assert.equal(active.state, 'ACTIVE')
  assert.equal(polls, 2)

  await assert.rejects(
    () =>
      waitForUploadedFileActive(
        { get: async () => ({ name: 'files/fail', state: 'FAILED' }) },
        { name: 'files/fail', state: 'PROCESSING' },
        5_000,
        5,
      ),
    /FAILED/,
  )

  await assert.rejects(
    () =>
      waitForUploadedFileActive(
        { get: async () => ({ name: 'files/slow', state: 'PROCESSING' }) },
        { name: 'files/slow', state: 'PROCESSING' },
        20,
        5,
      ),
    /Timed out/,
  )
})

test('shrinkTelemetry rounds to 3 decimals, samples every 4th frame, drops resting bodies, and extracts key events', () => {
  const frames: TelemetryFrame[] = Array.from({ length: 8 }, (_, index) => ({
    frame: index,
    timestampMs: index * 16.6667,
    botState: 'launching',
    bodies: [
      {
        name: 'restingBlock',
        pos: [1.123456, 0.5, -2.987654],
        linvel: [0.0001, 0, 0],
        angvel: [0, 0.0002, 0],
      },
      {
        name: 'projectile',
        pos: [index * 1.1119, index === 5 ? -0.4567 : 2.3456, 0],
        linvel: [4.56789, -1.23456, 0],
        angvel: [0, 0, 0.54321],
      },
    ],
    contacts:
      index === 2
        ? [{ bodyA: 'projectile', bodyB: 'wall', totalForce: 12.3456 }]
        : index === 4
          ? [{ bodyA: 'projectile', bodyB: 'wall', totalForce: 48.9876 }]
          : [],
  }))

  const shrunk = shrinkTelemetry(frames)
  assert.equal(shrunk.totalFrames, 8)
  assert.equal(shrunk.sampledFrames, 2)
  assert.equal(shrunk.frames[0]?.frame, 0)
  assert.equal(shrunk.frames[1]?.frame, 4)
  assert.equal(shrunk.frames[0]?.bodies.length, 1)
  assert.equal(shrunk.frames[0]?.bodies[0]?.name, 'projectile')
  assert.deepEqual(shrunk.frames[0]?.bodies[0]?.linvel, [4.568, -1.235, 0])
  assert.equal(shrunk.keyEvents.firstContact?.frame, 2)
  assert.equal(shrunk.keyEvents.firstContact?.totalForce, 12.346)
  assert.equal(shrunk.keyEvents.peakForce?.frame, 4)
  assert.equal(shrunk.keyEvents.peakForce?.totalForce, 48.988)
  assert.equal(shrunk.keyEvents.fellBelowHeight.length, 1)
  assert.equal(shrunk.keyEvents.fellBelowHeight[0]?.frame, 5)
  assert.equal(shrunk.keyEvents.fellBelowHeight[0]?.y, -0.457)
})

test('mergeWithCurrentFiles and filterChangedFiles keep only modified files', () => {
  const current = [
    { path: 'src/generated/activeLevel.ts', content: 'export const v = 1;' },
    { path: 'src/generated/helper.ts', content: 'export const h = 1;' },
  ]
  const partialPatch = [{ path: 'src/generated/activeLevel.ts', content: 'export const v = 2;' }]
  const merged = mergeWithCurrentFiles(partialPatch, current)
  assert.equal(merged.length, 2)
  const changed = filterChangedFiles(merged, current)
  assert.deepEqual(changed, partialPatch)
})

test('critiqueAndPatchWorld tries Managed Agent critique first, falls back to streamed model critique on error/timeout, and runs low-thinking patch call', async () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'
  const events: OrchestratorEvent[] = []
  const orchestrator = new ArgonOrchestrator((event) => events.push(event))
  const createCalls: Array<Record<string, unknown>> = []

  ;(orchestrator as unknown as { ai: unknown }).ai = {
    files: {
      upload: async () => ({
        name: 'files/run1',
        uri: 'https://example.com/run1.webm',
        mimeType: 'video/webm',
        state: 'PROCESSING',
      }),
      get: async () => ({
        name: 'files/run1',
        uri: 'https://example.com/run1.webm',
        mimeType: 'video/webm',
        state: 'ACTIVE',
      }),
    },
    interactions: {
      create: async (params: Record<string, unknown>) => {
        createCalls.push(params)
        if (params.agent) {
          throw new Error('400 Video input is not supported.')
        }
        if (params.stream) {
          return (async function* () {
            yield {
              event_type: 'step.delta',
              delta: { type: 'text', text: 'At 0:02.1 the boulder ' },
            }
            yield {
              event_type: 'step.delta',
              delta: { content: [{ type: 'text', text: 'falls short of the wall.' }] },
            }
          })()
        }
        return {
          id: 'patch-interaction-1',
          status: 'completed',
          output_text: JSON.stringify({
            files: [
              { path: 'src/generated/activeLevel.ts', content: 'export const v = 2;' },
              { path: 'src/generated/helper.ts', content: 'export const h = 1;' },
            ],
            diagnosis: 'At 0:02.1 the boulder falls short of the wall.',
            skillContent: '# Invariant\nIncrease launch impulse.',
          }),
        }
      },
      get: async () => ({
        id: 'patch-interaction-1',
        status: 'completed',
        output_text: JSON.stringify({
          files: [
            { path: 'src/generated/activeLevel.ts', content: 'export const v = 2;' },
            { path: 'src/generated/helper.ts', content: 'export const h = 1;' },
          ],
          diagnosis: 'At 0:02.1 the boulder falls short of the wall.',
          skillContent: '# Invariant\nIncrease launch impulse.',
        }),
      }),
    },
  }

  const patch = await orchestrator.critiqueAndPatchWorld(
    {
      videoBytes: new Uint8Array([1, 2, 3, 4]),
      metadata: {
        type: 'PLAYTEST_FAILED_PAYLOAD',
        runId: 'run_1',
        frameCount: 1,
        failureReason: 'Goal not reached',
        telemetry: [
          {
            frame: 0,
            timestampMs: 0,
            botState: 'launching',
            bodies: [{ name: 'boulder', pos: [0, 1, 0], linvel: [1, 0, 0], angvel: [0, 0, 0] }],
            contacts: [],
          },
        ],
      },
      currentFiles: [
        { path: 'src/generated/activeLevel.ts', content: 'export const v = 1;' },
        { path: 'src/generated/helper.ts', content: 'export const h = 1;' },
      ],
      iteration: 1,
    },
    async () => [],
  )

  assert.equal(createCalls.length, 3)
  assert.equal(createCalls[0]?.agent, 'antigravity-preview-09-2026')
  assert.equal(createCalls[0]?.environment, 'remote')
  assert.equal(createCalls[1]?.stream, true)
  assert.equal(createCalls[2]?.background, true)
  assert.equal(createCalls[2]?.response_mime_type, 'application/json')
  assert.deepEqual(createCalls[2]?.response_format, patchResponseSchema)
  assert.equal(
    (createCalls[2]?.generation_config as { thinking_level?: string })?.thinking_level,
    'low',
  )

  const critiqueEvents = events.filter((event) => event.critiqueText !== undefined)
  assert.equal(critiqueEvents.length, 3)
  assert.equal(critiqueEvents[0]?.critiqueText, 'At 0:02.1 the boulder ')
  assert.equal(critiqueEvents[0]?.critiqueFinal, false)
  assert.equal(
    critiqueEvents[2]?.critiqueText,
    'At 0:02.1 the boulder falls short of the wall.',
  )
  assert.equal(critiqueEvents[2]?.critiqueFinal, true)
  assert.equal(critiqueEvents[2]?.critiqueMessage?.type, 'critique-text')

  const directMessage = createCritiqueTextMessage(1, critiqueEvents[2]!.critiqueText!, true)
  assert.equal(directMessage.type, 'critique-text')
  assert.equal(directMessage.final, true)

  assert.deepEqual(patch.files, [
    { path: 'src/generated/activeLevel.ts', content: 'export const v = 2;' },
  ])
  assert.equal(typeof patch.timings?.uploadMs, 'number')
  assert.equal(typeof patch.timings?.critiqueMs, 'number')
  assert.equal(typeof patch.timings?.patchMs, 'number')
  assert.equal(typeof patch.timings?.totalMs, 'number')
})

test('critiqueAndPatchWorld uses Managed Agent critique output when agent succeeds within 90s budget', async () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'
  const events: OrchestratorEvent[] = []
  const orchestrator = new ArgonOrchestrator((event) => events.push(event))
  assert.equal(orchestrator.managedAgentTimeoutMs, 90_000)

  const createCalls: Array<Record<string, unknown>> = []
  ;(orchestrator as unknown as { ai: unknown }).ai = {
    files: {
      upload: async () => ({
        name: 'files/run2',
        uri: 'https://example.com/run2.webm',
        mimeType: 'video/webm',
        state: 'ACTIVE',
      }),
      get: async () => ({
        name: 'files/run2',
        uri: 'https://example.com/run2.webm',
        mimeType: 'video/webm',
        state: 'ACTIVE',
      }),
    },
    interactions: {
      create: async (params: Record<string, unknown>) => {
        createCalls.push(params)
        if (params.agent) {
          return {
            id: 'agent-critique-1',
            status: 'completed',
            output_text: 'Sandbox calculation: boulder needs vx >= 14.2 m/s to clear the gap.',
          }
        }
        return {
          id: 'patch-interaction-2',
          status: 'completed',
          output_text: JSON.stringify({
            files: [{ path: 'src/generated/activeLevel.ts', content: 'export const v = 3;' }],
          }),
        }
      },
      get: async (id: string) => {
        if (id === 'agent-critique-1') {
          return {
            id: 'agent-critique-1',
            status: 'completed',
            output_text: 'Sandbox calculation: boulder needs vx >= 14.2 m/s to clear the gap.',
          }
        }
        return {
          id: 'patch-interaction-2',
          status: 'completed',
          output_text: JSON.stringify({
            files: [{ path: 'src/generated/activeLevel.ts', content: 'export const v = 3;' }],
          }),
        }
      },
    },
  }

  const patch = await orchestrator.critiqueAndPatchWorld(
    {
      videoBytes: new Uint8Array([1, 2]),
      metadata: {
        type: 'PLAYTEST_FAILED_PAYLOAD',
        runId: 'run_2',
        frameCount: 1,
        failureReason: 'Goal not reached',
        telemetry: [],
      },
      currentFiles: [{ path: 'src/generated/activeLevel.ts', content: 'export const v = 1;' }],
      iteration: 1,
    },
    async () => [],
  )

  assert.equal(createCalls.length, 2)
  assert.equal(createCalls[0]?.agent, 'antigravity-preview-09-2026')
  assert.equal(createCalls[0]?.environment, 'remote')
  assert.equal(typeof createCalls[0]?.input, 'string')
  assert.ok(String(createCalls[0]?.input).includes('Goal not reached'))
  assert.equal(patch.diagnosis, 'Sandbox calculation: boulder needs vx >= 14.2 m/s to clear the gap.')
  assert.ok(events.some((e) => e.critiqueFinal && e.critiqueText?.includes('vx >= 14.2 m/s')))
})

test('generateSingleCallWorld respects ARGON_WORLD_THINKING and generateInitialWorld retries planner on transient failure without single-call fallback', async () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'
  assert.equal(resolveWorldThinkingLevel({}), 'medium')
  assert.equal(resolveWorldThinkingLevel({ ARGON_WORLD_THINKING: 'low' }), 'low')
  assert.equal(resolveWorldThinkingLevel({ ARGON_WORLD_THINKING: 'high' }), 'high')

  const tempSkill = join(tmpdir(), `skill-${Date.now()}.md`)
  await writeFile(tempSkill, '# Catapult Invariant\nUse counterweight density >= 3.0.', 'utf8')
  try {
    const skillText = await loadLearnedSkill(tempSkill)
    const prompt = buildWorldGenerationPrompt('Knock the tower down', skillText)
    assert.ok(prompt.includes('Use counterweight density >= 3.0.'))
    assert.ok(levelContract.includes('ControlBinding'))
    assert.ok(levelContract.includes('LevelGoal'))
    assert.ok(levelContract.includes('stepHumanAndRules'))
    assert.ok(levelContract.includes('createBreakableWall'))

    const orchestrator = new ArgonOrchestrator(() => {}, tempSkill)
    let capturedParams: Record<string, unknown> | undefined
    ;(orchestrator as unknown as { ai: unknown }).ai = {
      interactions: {
        create: async (params: Record<string, unknown>) => {
          capturedParams = params
          return {
            id: 'world-1',
            status: 'completed',
            output_text: JSON.stringify({
              files: [{ path: 'src/generated/activeLevel.ts', content: 'export const ok = true;' }],
              diagnosis: 'Initial world',
              skillContent: '',
            }),
          }
        },
        get: async () => ({
          id: 'world-1',
          status: 'completed',
          output_text: JSON.stringify({
            files: [{ path: 'src/generated/activeLevel.ts', content: 'export const ok = true;' }],
            diagnosis: 'Initial world',
            skillContent: '',
          }),
        }),
      },
    }

    const result = await orchestrator.generateSingleCallWorld('Knock the tower down', skillText, async () => [])
    assert.equal(capturedParams?.response_mime_type, 'application/json')
    assert.deepEqual(capturedParams?.response_format, patchResponseSchema)
    assert.deepEqual(capturedParams?.generation_config, {
      max_output_tokens: 1_048_576,
      thinking_level: 'medium',
    })
    assert.ok(String(capturedParams?.input).includes('Use counterweight density >= 3.0.'))
    assert.equal(result.files.length, 1)
    assert.equal(resolveChainedInteractionId('world-1', 'model'), 'world-1')
    assert.equal(resolveChainedInteractionId('world-1', 'agent'), undefined)
  } finally {
    await rm(tempSkill, { force: true })
  }
})

test('generateInitialWorld runs planner + 3 parallel builders and repairs only failing file(s)', async () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'
  const spec: WorldPlanSpec = {
    layoutAlongX: 'Start platform at x=-10, gap at x=0, goal platform at x=10',
    namedBodies: [
      { name: 'groundTile', owner: 'scene', bodyType: 'fixed', shape: 'box', position: [-10, 0, 0], size: [6, 1, 4], role: 'Start platform' },
      { name: 'player', owner: 'mechanics', bodyType: 'dynamic', shape: 'capsule', position: [-10, 2, 0], size: [0.8, 1.4, 0.8], role: 'Player body' },
    ],
    controls: [
      { key: 'KeyD', action: 'Move right' },
      { key: 'Space', action: 'Jump' },
    ],
    goal: { type: 'near-point', body: 'player', target: [10, 2, 0], radius: 2 },
    fileOwnership: {
      scene: 'Terrain and start/goal platforms',
      mechanics: 'Player movement, jump, and hazards',
      activeLevel: 'Entry buildWorld wiring scene and mechanics',
    },
  }

  const createInputs: string[] = []
  let callIndex = 0
  const orchestrator = new ArgonOrchestrator(() => {})
  ;(orchestrator as unknown as { ai: unknown }).ai = {
    interactions: {
      create: async (params: Record<string, unknown>) => {
        callIndex += 1
        const id = `call-${callIndex}`
        const inputText = String(params.input)
        createInputs.push(inputText)
        if (params.response_format === worldPlanSchema) {
          return { id, status: 'completed', output_text: JSON.stringify(spec) }
        }
        for (const targetPath of BUILDER_FILE_PATHS) {
          if (inputText.includes(`{"files":[{"path":"${targetPath}"`)) {
            return {
              id,
              status: 'completed',
              output_text: JSON.stringify({
                files: [{ path: targetPath, content: `// draft ${targetPath}` }],
              }),
            }
          }
        }
        // Targeted repair call
        return {
          id,
          status: 'completed',
          output_text: JSON.stringify({
            files: [{ path: 'src/generated/mechanics.ts', content: '// repaired src/generated/mechanics.ts' }],
          }),
        }
      },
      get: async (id: string) => {
        if (id === 'call-1') return { id, status: 'completed', output_text: JSON.stringify(spec) }
        if (id === 'call-2') {
          return {
            id,
            status: 'completed',
            output_text: JSON.stringify({ files: [{ path: 'src/generated/scene.ts', content: '// draft src/generated/scene.ts' }] }),
          }
        }
        if (id === 'call-3') {
          return {
            id,
            status: 'completed',
            output_text: JSON.stringify({ files: [{ path: 'src/generated/mechanics.ts', content: '// draft src/generated/mechanics.ts' }] }),
          }
        }
        if (id === 'call-4') {
          return {
            id,
            status: 'completed',
            output_text: JSON.stringify({ files: [{ path: 'src/generated/activeLevel.ts', content: '// draft src/generated/activeLevel.ts' }] }),
          }
        }
        return {
          id,
          status: 'completed',
          output_text: JSON.stringify({ files: [{ path: 'src/generated/mechanics.ts', content: '// repaired src/generated/mechanics.ts' }] }),
        }
      },
    },
  }

  let validateCalls = 0
  const result = await orchestrator.generateInitialWorld('Parkour course', async (files) => {
    validateCalls += 1
    assert.equal(files.length, 3)
    if (validateCalls === 1) {
      return ['src/generated/mechanics.ts(12,5): error TS2322: Type string is not assignable to number.']
    }
    return []
  })

  // 1 planner + 3 parallel builders + 1 targeted repair
  assert.equal(createInputs.length, 5)
  const repairPrompt = createInputs[4]!
  assert.ok(repairPrompt.includes('src/generated/mechanics.ts'))
  assert.ok(!repairPrompt.includes('// draft src/generated/scene.ts'))
  assert.ok(!repairPrompt.includes('// draft src/generated/activeLevel.ts'))
  assert.equal(result.files.length, 3)
  assert.equal(
    result.files.find((f) => f.path === 'src/generated/mechanics.ts')?.content,
    '// repaired src/generated/mechanics.ts',
  )

  const failingOnly = identifyFailingFiles(result.files, [
    'src/generated/scene.ts(4,1): error TS1005: ";" expected.',
  ])
  assert.equal(failingOnly.length, 1)
  assert.equal(failingOnly[0]?.path, 'src/generated/scene.ts')
})

test('planner and builder prompts reference ../engine/assetKit models and helpers', () => {
  const spec: WorldPlanSpec = {
    layoutAlongX: 'x=-8 to x=12',
    namedBodies: [{ name: 'player', owner: 'mechanics', bodyType: 'dynamic', position: [0, 1, 0], size: [1, 1, 1], role: 'hero' }],
    controls: [{ key: 'Space', action: 'Jump' }],
    goal: { type: 'above-y', body: 'player', y: 5 },
    fileOwnership: { scene: 'terrain', mechanics: 'player', activeLevel: 'entry' },
  }
  const planPrompt = buildWorldPlanPrompt('Mario parkour', '', { useAssetKit: true })
  const scenePrompt = buildModuleBuilderPrompt('src/generated/scene.ts', 'Mario parkour', spec, '', { useAssetKit: true })
  const mechanicsPrompt = buildModuleBuilderPrompt('src/generated/mechanics.ts', 'Mario parkour', spec, '', { useAssetKit: true })
  assert.ok(planPrompt.includes('../engine/assetKit'))
  assert.ok(scenePrompt.includes("Reusable 3D Asset & Gameplay Kit ('../engine/assetKit'):"))
  assert.ok(scenePrompt.includes('createCharacter(opts?)'))
  assert.ok(scenePrompt.includes('createPlatformTile('))
  assert.ok(scenePrompt.includes('scatter(scene, templateGroup, count'))
  assert.ok(mechanicsPrompt.includes('createBodyWithCollider(world'))
  assert.ok(mechanicsPrompt.includes('createPlayerController(world, body'))
  assert.ok(mechanicsPrompt.includes('collectOnce(mesh'))
  assert.ok(mechanicsPrompt.includes('hitFromBelow(blockMesh'))
})

test('levelContract and generation prompt enforce KeyboardEvent.code controls, genre-agnostic contact/finite-spawn/reachability mechanics, and bot mechanic coverage', () => {
  const prompt = buildWorldGenerationPrompt('Platformer with jump blocks and moving hazards')
  // 1. Controls contract with KeyboardEvent.code
  assert.ok(levelContract.includes('code?: string'))
  assert.ok(prompt.includes('KeyboardEvent.code'))
  assert.ok(prompt.includes("'KeyW'"))
  assert.ok(prompt.includes("'KeyA'"))
  assert.ok(prompt.includes("'ArrowUp'"))
  assert.ok(prompt.includes("'Space'"))
  assert.ok(prompt.includes("'ShiftLeft'"))
  assert.ok(prompt.includes('event.code'))
  assert.ok(prompt.includes('If both WASD and Arrow keys'))

  // 2. Genre-agnostic mechanics rules
  assert.ok(prompt.includes('hit from below, stomp from above'))
  assert.ok(prompt.includes('never on mere distance/proximity checks'))
  assert.ok(prompt.includes('Finite rewards and spawns'))
  assert.ok(prompt.includes('reachable by both the autonomous bot and a human player'))

  // 3. Bot exercises main mechanics
  assert.ok(prompt.includes("stepBotAndRules must actively exercise the level's main mechanics"))
  assert.ok(prompt.includes('rather than taking a straight run to the goal'))
})

test('buildCritiquePrompt and buildPatchPrompt audit declared controls and object behaviour and treat dead controls as top priority', () => {
  const failedRun: FailedRunInput = {
    videoBytes: new Uint8Array([1, 2, 3]),
    metadata: {
      type: 'PLAYTEST_FAILED_PAYLOAD',
      runId: 'run_dead_controls',
      frameCount: 60,
      failureReason: 'Declared controls did nothing: KeyW, ShiftLeft',
      telemetry: [],
    },
    currentFiles: [
      { path: 'src/generated/activeLevel.ts', content: 'export const controls = [{ key: "KeyW", action: "Jump" }];' },
    ],
    iteration: 2,
  }
  const compactTelemetry = shrinkTelemetry(failedRun.metadata.telemetry)
  const critiquePrompt = buildCritiquePrompt(failedRun, compactTelemetry)
  assert.ok(critiquePrompt.includes('Declared controls did nothing: KeyW, ShiftLeft'))
  assert.ok(critiquePrompt.includes('TOP PRIORITY — Dead controls'))
  assert.ok(critiquePrompt.includes('Check declared controls and interactive object behaviour against the goal'))
  assert.ok(critiquePrompt.includes('event.code'))
  assert.ok(critiquePrompt.includes('never on mere proximity'))
  assert.ok(critiquePrompt.includes('src/generated/activeLevel.ts'))

  const patchPrompt = buildPatchPrompt(failedRun, 'KeyW and ShiftLeft were ignored in onPointerOrKey.', compactTelemetry)
  assert.ok(patchPrompt.includes('Declared controls did nothing: KeyW, ShiftLeft'))
  assert.ok(patchPrompt.includes('top priority'))
  assert.ok(patchPrompt.includes('event.code'))
  assert.ok(patchPrompt.includes('stepBotAndRules exercise the main mechanics'))
})

test('1M context window engine source packing and thought extraction populate ContextTelemetry', () => {
  const pack = buildEngineContextPack()
  assert.ok(pack.files.includes('src/engine/types.ts'))
  assert.ok(pack.files.includes('src/engine/assetKit.ts'))
  assert.ok(pack.files.includes('src/engine/breakageKit.ts'))
  assert.ok(pack.text.includes('createCastleTower'))
  assert.ok(pack.text.includes('createPooledParticles'))

  const prompt = buildWorldGenerationPrompt('Siege catapult castle')
  const telemetry = createContextTelemetry(prompt, 'high', 65_536, 'Calculated parabolic arc for boulder launch.')
  assert.equal(telemetry.maxContextTokens, MAX_CONTEXT_WINDOW_TOKENS)
  assert.equal(telemetry.maxContextTokens, 1_048_576)
  assert.ok(telemetry.contextTokensEstimate > 1_000)
  assert.equal(telemetry.thinkingLevel, 'high')
  assert.equal(telemetry.thoughtSummary, 'Calculated parabolic arc for boulder launch.')

  const thoughts = extractInteractionThoughts({
    steps: [
      { type: 'thought', content: [{ type: 'text', text: 'First, compute torque on the catapult arm.' }] },
      { type: 'model_output', content: [{ type: 'thought', text: 'Second, set breakForce = 28 on tower mortar.' }] },
    ],
  })
  assert.equal(thoughts, 'First, compute torque on the catapult arm.\n\nSecond, set breakForce = 28 on tower mortar.')
})


