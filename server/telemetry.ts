import type { FrameSnapshot } from '../src/engine/TelemetryRecorder'

/** Bounded summary of a playtest ledger for the critic prompt. */
export interface CompactTelemetry {
  /** Every `sampleEvery`-th recorded frame is kept. */
  sampleEvery: number
  /** Bodies that never moved more than `restThreshold` metres are left out of `frames`. */
  restingBodies: string[]
  frames: Array<{ f: number; ms: number; bot: string; bodies: Record<string, { p: number[]; speed: number }> }>
  /** Moments the critic should look at first. */
  events: string[]
}

const restThreshold = 0.05
const maxChars = 40_000

const round = (value: number) => Math.round(value * 100) / 100
const length = ([x, y, z]: readonly number[]) => Math.hypot(x, y, z)

/** Keeps the critic prompt small: rounds values, samples frames, drops resting bodies, and lists key events. */
export function compactTelemetry(frames: readonly FrameSnapshot[]): CompactTelemetry {
  const start = new Map<string, readonly number[]>()
  const moved = new Set<string>()
  for (const frame of frames) {
    for (const body of frame.bodies) {
      const first = start.get(body.name)
      if (!first) start.set(body.name, body.pos)
      else if (length(body.pos.map((value, index) => value - first[index])) > restThreshold) moved.add(body.name)
    }
  }
  const restingBodies = [...start.keys()].filter((name) => !moved.has(name))

  const events: string[] = []
  const seenPairs = new Set<string>()
  const peak = new Map<string, { force: number; frame: number }>()
  const fell = new Set<string>()
  let lastBot = ''
  for (const frame of frames) {
    if (frame.botState !== lastBot) {
      events.push(`frame ${frame.frame} (${frame.timestampMs} ms): bot state "${frame.botState}"`)
      lastBot = frame.botState
    }
    for (const contact of frame.contacts) {
      const pair = [contact.bodyA, contact.bodyB].sort().join(' + ')
      if (!seenPairs.has(pair)) {
        seenPairs.add(pair)
        events.push(`frame ${frame.frame} (${frame.timestampMs} ms): first contact ${pair}, force ${round(contact.totalForce)}`)
      }
      const best = peak.get(pair)
      if (!best || contact.totalForce > best.force) peak.set(pair, { force: contact.totalForce, frame: frame.frame })
    }
    for (const body of frame.bodies) {
      if (body.pos[1] < -5 && !fell.has(body.name)) {
        fell.add(body.name)
        events.push(`frame ${frame.frame} (${frame.timestampMs} ms): ${body.name} fell below y = -5`)
      }
    }
  }
  for (const [pair, { force, frame }] of peak) events.push(`peak force ${round(force)} between ${pair} at frame ${frame}`)

  const build = (sampleEvery: number): CompactTelemetry => ({
    sampleEvery,
    restingBodies,
    events: events.slice(0, 80),
    frames: frames
      .filter((_frame, index) => index % sampleEvery === 0 || index === frames.length - 1)
      .map((frame) => ({
        f: frame.frame,
        ms: frame.timestampMs,
        bot: frame.botState,
        bodies: Object.fromEntries(frame.bodies
          .filter((body) => moved.has(body.name))
          .map((body) => [body.name, { p: body.pos.map(round), speed: round(length(body.linvel)) }])),
      })),
  })

  let sampleEvery = 4
  let compact = build(sampleEvery)
  while (JSON.stringify(compact).length > maxChars && sampleEvery < frames.length) {
    sampleEvery *= 2
    compact = build(sampleEvery)
  }
  return compact
}
