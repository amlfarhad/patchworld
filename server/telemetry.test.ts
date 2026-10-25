import assert from 'node:assert/strict'
import test from 'node:test'
import { compactTelemetry } from './telemetry.js'
import { parsePatch } from './argonOrchestrator.js'
import type { FrameSnapshot } from '../src/engine/TelemetryRecorder'

function ledger(frameCount: number, extraBodies = 0): FrameSnapshot[] {
  type V = [number, number, number]
  return Array.from({ length: frameCount }, (_unused, index) => ({
    frame: index + 1,
    timestampMs: Math.round(index * 33.333),
    botState: index < 15 ? 'aiming' : 'launched',
    contacts: index === 40 ? [{ bodyA: 'boss', bodyB: 'boulder', totalForce: 812.3456 }] : [],
    bodies: [
      { name: 'boulder', pos: [index * 0.05, 1 - index * 0.04, 0] as V, linvel: [3, -1.2, 0] as V, angvel: [0, 0, 0] as V },
      { name: 'ground', pos: [0, 0, 0] as V, linvel: [0, 0, 0] as V, angvel: [0, 0, 0] as V },
      ...Array.from({ length: extraBodies }, (_body, n) => ({ name: `debris${n}`, pos: [n + index * 0.01, 2.123456, 0] as V, linvel: [0.1, 0, 0] as V, angvel: [0, 0, 0] as V })),
    ],
  }))
}

test('compact telemetry drops resting bodies, rounds values and lists key events', () => {
  const compact = compactTelemetry(ledger(240))
  assert.deepEqual(compact.restingBodies, ['ground'])
  assert.equal(compact.sampleEvery, 4)
  assert.ok(compact.frames.every((frame) => !('ground' in frame.bodies)))
  assert.deepEqual(compact.frames[1].bodies.boulder.p, [0.2, 0.84, 0])
  assert.ok(compact.events.some((event) => event.includes('first contact boss + boulder')))
  assert.ok(compact.events.some((event) => event.includes('boulder fell below y = -5')))
  assert.ok(compact.events.some((event) => event.includes('bot state "launched"')))
})

test('compact telemetry stays under its size budget for busy scenes', () => {
  const compact = compactTelemetry(ledger(240, 60))
  assert.ok(JSON.stringify(compact).length <= 40_000)
  assert.ok(compact.sampleEvery > 4)
})

test('patch parser accepts JSON with surrounding text and rejects malformed patches', () => {
  const patch = parsePatch('Here you go:\n{"files":[{"path":"src/generated/activeLevel.ts","content":"export {}"}],"diagnosis":"fixed","skillContent":"- launch toward +x"}')
  assert.equal(patch.files[0].path, 'src/generated/activeLevel.ts')
  assert.equal(patch.diagnosis, 'fixed')
  assert.throws(() => parsePatch('no json here'), /no JSON/)
  assert.throws(() => parsePatch('{"files":[{"path":1}]}'), /path and content/)
})
