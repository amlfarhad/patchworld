import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { FailedRunInput } from './argonOrchestrator.ts'
import { checkGeneratedTypeScript } from './generatedFiles.ts'
import { loadMockScript, MockOrchestrator } from './mockOrchestrator.ts'
import { mockScriptFromArgs, type WorldEvent } from './orchestrator.ts'
import { RunRecorder } from './runRecorder.ts'

const failedRun = (iteration: number): FailedRunInput => ({
  videoBytes: new Uint8Array(),
  metadata: { type: 'PLAYTEST_FAILED_PAYLOAD', runId: `run-${iteration}`, frameCount: 0, telemetry: [] },
  currentFiles: [],
  iteration,
})

test('mock flag and environment pick a script, or live mode', () => {
  assert.equal(mockScriptFromArgs(['node', 'daemon'], {}), null)
  assert.equal(mockScriptFromArgs(['node', 'daemon', '--mock'], {}), 'catapult')
  assert.equal(mockScriptFromArgs(['node', 'daemon', '--mock=artifacts/runs/abc'], {}), 'artifacts/runs/abc')
  assert.equal(mockScriptFromArgs(['node', 'daemon'], { ARGON_MOCK: '1' }), 'catapult')
  assert.equal(mockScriptFromArgs(['node', 'daemon'], { ARGON_MOCK: '0' }), null)
})

test('every catapult fixture step typechecks as the generated level', async () => {
  const script = await loadMockScript('catapult', process.cwd())
  assert.equal(script.steps.length, 3)
  for (const [index, step] of script.steps.entries()) {
    assert.deepEqual(await checkGeneratedTypeScript(step.files, process.cwd()), [], `step ${index + 1}`)
  }
  assert.ok(script.steps.slice(1).every((step) => step.diagnosis), 'each critique step explains the previous failure')
})

test('mock orchestrator replays steps by iteration and streams the critique', async () => {
  const events: WorldEvent[] = []
  const orchestrator = new MockOrchestrator((event) => events.push(event), 'catapult', process.cwd(), 0)
  const validate = async () => []

  const first = await orchestrator.generateInitialWorld('any goal', validate)
  const second = await orchestrator.critiqueAndPatchWorld(failedRun(1), validate)
  assert.notEqual(second.files[0].content, first.files[0].content)

  const streamed = events.filter((event) => event.critiqueText !== undefined)
  assert.ok(streamed.length > 1, 'critique arrives in several updates')
  assert.equal(streamed.at(-1)?.critiqueFinal, true)
  assert.equal(streamed.at(-1)?.critiqueText, second.diagnosis)

  await assert.rejects(orchestrator.critiqueAndPatchWorld(failedRun(3), validate), /no step after iteration 3/)
})

test('a recorded live run replays as a mock script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patchworld-runs-'))
  try {
    const recorder = await RunRecorder.start('Drop the boss!', root)
    await recorder.record({
      files: [
        { path: 'src/generated/helper.ts', content: 'export const b = 2\n' },
        { path: 'src/generated/activeLevel.ts', content: 'export const a = 1\n' },
      ],
    })
    await recorder.record({ files: [{ path: 'src/generated/activeLevel.ts', content: 'export const a = 3\n' }], diagnosis: 'At 0:02 it fell.' })

    const script = await loadMockScript(recorder.directory, root)
    assert.equal(script.goal, 'Drop the boss!')
    assert.deepEqual(script.steps.map((step) => step.files.map((file) => file.content)), [
      ['export const b = 2\n', 'export const a = 1\n'],
      ['export const a = 3\n'],
    ])
    assert.equal(script.steps[1].diagnosis, 'At 0:02 it fell.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
