import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ArgonOrchestrator,
  buildCritiquePrompt,
  buildPatchPrompt,
  buildWorldGenerationPrompt,
  createCritiqueTextMessage,
  extractInteractionText,
  filterChangedFiles,
  levelContract,
  loadLearnedSkill,
  mergeWithCurrentFiles,
  patchResponseSchema,
  resolveChainedInteractionId,
  shrinkTelemetry,
  waitForUploadedFileActive,
  type FailedRunInput,
  type OrchestratorEvent,
  type TelemetryFrame,
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

test('critiqueAndPatchWorld splits streamed critique from low-thinking patch call and emits critique-text', async () => {
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

  assert.equal(createCalls.length, 2)
  assert.equal(createCalls[0]?.stream, true)
  assert.equal(createCalls[1]?.background, true)
  assert.equal(createCalls[1]?.response_mime_type, 'application/json')
  assert.deepEqual(createCalls[1]?.response_format, patchResponseSchema)
  assert.equal(
    (createCalls[1]?.generation_config as { thinking_level?: string })?.thinking_level,
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

test('generateInitialWorld uses structured JSON schema, injects .agents/SKILL.md, and includes Vedant levelContract', async () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'
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

    const result = await orchestrator.generateInitialWorld('Knock the tower down', async () => [])
    assert.equal(capturedParams?.response_mime_type, 'application/json')
    assert.deepEqual(capturedParams?.response_format, patchResponseSchema)
    assert.ok(String(capturedParams?.input).includes('Use counterweight density >= 3.0.'))
    assert.equal(result.files.length, 1)
    assert.equal( resolveChainedInteractionId('world-1', 'model'), 'world-1')
    assert.equal(resolveChainedInteractionId('world-1', 'agent'), undefined)
  } finally {
    await rm(tempSkill, { force: true })
  }
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

