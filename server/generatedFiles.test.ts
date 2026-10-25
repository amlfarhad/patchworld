import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateLevelGoal } from '../src/engine/goalEvaluator.ts'
import { checkGeneratedTypeScript, validateGeneratedFiles } from './generatedFiles.ts'

test('generated writer accepts only direct TypeScript and GLSL children', () => {
  assert.doesNotThrow(() => validateGeneratedFiles([
    { path: 'src/generated/activeLevel.ts', content: 'export const buildWorld = () => ({ dispose() {} })' },
    { path: 'src/generated/water.glsl', content: 'void main() {}' },
  ]))
  assert.throws(() => validateGeneratedFiles([
    { path: 'src/generated/../../server/other.ts', content: 'unsafe' },
  ]), /path/i)
})

test('preflight reports generated TypeScript that violates the mounted level contract', async () => {
  const files = validateGeneratedFiles([{
    path: 'src/generated/activeLevel.ts',
    content: `
      import type { GeneratedLevelModule } from '../engine/types'
      export const buildWorld: GeneratedLevelModule['buildWorld'] = (
        scene,
        world,
        bodies,
        events: string,
      ) => ({
          stepBotAndRules: () => ({ botState: 'run', goalReached: false }),
          dispose: () => { void scene; void world; void bodies; void events },
        })
    `,
  }])

  const diagnostics = await checkGeneratedTypeScript(files, process.cwd())

  assert.ok(diagnostics.length > 0)
  assert.match(diagnostics.join('\n'), /events|EventQueue|GeneratedLevelModule/i)
})

test('preflight accepts a generated module matching the mounted level contract', async () => {
  const files = validateGeneratedFiles([{
    path: 'src/generated/activeLevel.ts',
    content: `
      import type { GeneratedLevelModule } from '../engine/types'
      export const buildWorld: GeneratedLevelModule['buildWorld'] = (scene, world, bodies, events) => {
        void scene; void world; void bodies; void events
        return {
          stepBotAndRules: () => ({ botState: 'ready', goalReached: false }),
          stepHumanAndRules: () => ({ botState: 'human', goalReached: false }),
          controls: [{ key: 'Space', action: 'Jump' }],
          goal: { type: 'below-y', body: 'ball', y: 0 },
          dispose: () => undefined,
        }
      }
    `,
  }])

  const diagnostics = await checkGeneratedTypeScript(files, process.cwd())

  assert.deepEqual(diagnostics, [])
})

test('preflight accepts generated modules importing from ../engine/breakageKit', async () => {
  const files = validateGeneratedFiles([{
    path: 'src/generated/activeLevel.ts',
    content: `
      import type { GeneratedLevelModule } from '../engine/types'
      import {
        createBreakableWall,
        createSnapJoint,
        createLavaSensor,
        createGoalSensor,
        applyLaunchImpulse,
      } from '../engine/breakageKit'

      export const buildWorld: GeneratedLevelModule['buildWorld'] = (scene, world, bodies, events) => {
        const wall = createBreakableWall(scene, world, bodies, {
          position: [0, 1.5, 0],
          size: [3, 3, 0.5],
          rows: 3,
          cols: 3,
        })
        const lava = createLavaSensor(scene, world, { position: [0, -2, 0], size: [10, 0.5, 10] })
        const goalZone = createGoalSensor(scene, world, { position: [4, 1, 0], size: [2, 2, 2] })
        if (wall.bricks.length >= 2) {
          const joint = createSnapJoint(world, {
            bodyA: wall.bricks[0].body,
            bodyB: wall.bricks[1].body,
            breakForce: 50,
          })
          joint.step()
          applyLaunchImpulse(wall.bricks[0].body, { direction: [1, 0.5, 0], magnitude: 10 })
        }
        return {
          stepBotAndRules: () => {
            wall.step(events)
            const failed = lava.containsNamedBody(bodies, 'wall_0_0_0')
            const won = goalZone.containsNamedBody(bodies, 'wall_0_0_0')
            return { botState: 'testing', goalReached: won, ...(failed ? { failedEarly: 'fell in lava' } : {}) }
          },
          stepHumanAndRules: () => {
            wall.step(events)
            return { botState: 'human', goalReached: false }
          },
          controls: [{ key: 'Space', action: 'Launch' }],
          goal: { type: 'in-region', body: 'wall_0_0_0', min: [3, 0, -1], max: [5, 2, 1] },
          dispose: () => {
            wall.dispose()
            lava.dispose()
            goalZone.dispose()
          },
        }
      }
    `,
  }])

  const diagnostics = await checkGeneratedTypeScript(files, process.cwd())
  assert.deepEqual(diagnostics, [])
})

test('evaluateLevelGoal checks declared goal against named body positions', () => {
  const bodies = new Map([
    ['ball', { translation: () => ({ x: 4, y: -2, z: 0.5 }) }],
  ])

  assert.equal(evaluateLevelGoal({ type: 'below-y', body: 'ball', y: -1 }, bodies), true)
  assert.equal(evaluateLevelGoal({ type: 'below-y', body: 'ball', y: -3 }, bodies), false)
  assert.equal(evaluateLevelGoal({ type: 'above-y', body: 'ball', y: -3 }, bodies), true)
  assert.equal(
    evaluateLevelGoal({ type: 'in-region', body: 'ball', min: [3, -3, 0], max: [5, -1, 1] }, bodies),
    true,
  )
  assert.equal(
    evaluateLevelGoal({ type: 'in-region', body: 'ball', min: [0, 0, 0], max: [2, 2, 2] }, bodies),
    false,
  )
  assert.equal(
    evaluateLevelGoal({ type: 'near-point', body: 'ball', target: [4, -2, 0], radius: 1 }, bodies),
    true,
  )
  assert.equal(
    evaluateLevelGoal({ type: 'near-point', body: 'missing', target: [4, -2, 0], radius: 10 }, bodies),
    false,
  )
})


