import assert from 'node:assert/strict'
import test from 'node:test'
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
          dispose: () => undefined,
        }
      }
    `,
  }])

  const diagnostics = await checkGeneratedTypeScript(files, process.cwd())

  assert.deepEqual(diagnostics, [])
})

test('preflight ignores unused locals so a working level does not cost a repair pass', async () => {
  const files = validateGeneratedFiles([{
    path: 'src/generated/activeLevel.ts',
    content: `
      import type { GeneratedLevelModule } from '../engine/types'
      export const buildWorld: GeneratedLevelModule['buildWorld'] = (scene, world, bodies, events) => {
        const unusedHeight = 3
        return {
          stepBotAndRules: () => ({ botState: 'ready', goalReached: false }),
          dispose: () => undefined,
        }
      }
    `,
  }])
  assert.deepEqual(await checkGeneratedTypeScript(files, process.cwd()), [])
})
