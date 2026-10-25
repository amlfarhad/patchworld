import assert from 'node:assert/strict'
import test from 'node:test'
import { applyEdits, mergePatchFiles } from './patchEdits.ts'
import { parseEditPatch } from './argonOrchestrator.ts'

const level = { path: 'src/generated/activeLevel.ts', content: 'const LAUNCH = { x: -7, y: 4.5 }\ncollider.setSensor(true)\nconst SPEED = 1\n' }
const helper = { path: 'src/generated/helpers.ts', content: 'export const g = 9.81\n' }

test('edits replace exactly one occurrence and return whole touched files', () => {
  const { files, errors } = applyEdits([level, helper], [
    { path: level.path, find: 'x: -7', replace: 'x: 7' },
    { path: level.path, find: 'collider.setSensor(true)\n', replace: '' },
  ])
  assert.deepEqual(errors, [])
  assert.equal(files.length, 1)
  assert.equal(files[0].content, 'const LAUNCH = { x: 7, y: 4.5 }\nconst SPEED = 1\n')
})

test('edits that miss, repeat or target unknown files are reported, not guessed', () => {
  const doubled = { path: level.path, content: 'a = 1\na = 1\n' }
  const { errors } = applyEdits([doubled], [
    { path: level.path, find: 'a = 1', replace: 'a = 2' },
    { path: level.path, find: 'missing', replace: 'x' },
    { path: 'src/generated/nope.ts', find: 'a', replace: 'b' },
  ])
  assert.equal(errors.length, 3)
  assert.match(errors[0], /more than once/)
  assert.match(errors[1], /does not appear/)
  assert.match(errors[2], /does not exist/)
})

test('merged patch always carries activeLevel.ts so the level remounts', () => {
  const { files } = applyEdits([level, helper], [{ path: helper.path, find: '9.81', replace: '3.7' }])
  const merged = mergePatchFiles([level, helper], files, [])
  assert.deepEqual(merged.map((file) => file.path).sort(), [level.path, helper.path].sort())
  assert.equal(merged.find((file) => file.path === helper.path)?.content, 'export const g = 3.7\n')
})

test('edit patch parser reads edits, new files and notes', () => {
  const parsed = parseEditPatch('{"edits":[{"path":"src/generated/activeLevel.ts","find":"x: -7","replace":"x: 7"}],"files":[{"path":"src/generated/extra.ts","content":"export {}"}],"diagnosis":"flip launch","skillContent":""}')
  assert.equal(parsed.edits.length, 1)
  assert.equal(parsed.files[0].path, 'src/generated/extra.ts')
  assert.equal(parsed.diagnosis, 'flip launch')
  assert.throws(() => parseEditPatch('{"edits":[{"path":"a"}],"files":[]}'), /path, find and replace/)
})
