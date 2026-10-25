import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePlaytestPacket, encodePlaytestPacket } from '../src/shared/protocol.js'

test('playtest packet keeps telemetry aligned with its binary WebM payload', () => {
  const metadata = {
    type: 'PLAYTEST_FAILED_PAYLOAD' as const,
    runId: 'run-42',
    frameCount: 240,
    telemetry: [{ frame: 240, timestampMs: 8000, bodies: [], contacts: [], botState: 'timeout' }],
  }
  const video = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01])

  const packet = encodePlaytestPacket(metadata, video)
  const decoded = decodePlaytestPacket(packet)

  assert.deepEqual(decoded.metadata, metadata)
  assert.deepEqual(decoded.videoBytes, video)
})

test('playtest packet rejects a truncated or invalid header', () => {
  assert.throws(() => decodePlaytestPacket(Uint8Array.from([0, 0, 0, 8, 123, 125])), /header/i)
})
