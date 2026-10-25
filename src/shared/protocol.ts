import type { FrameSnapshot } from '../engine/TelemetryRecorder'

export interface PlaytestFailedMetadata {
  type: 'PLAYTEST_FAILED_PAYLOAD'
  runId: string
  frameCount: number
  failureReason?: string
  telemetry: FrameSnapshot[]
}

export interface PlaytestPassedMessage {
  type: 'playtest-passed'
  runId: string
  frameCount: number
}

/** One autonomous attempt at the current goal, as the daemon tracks it. */
export interface IterationEntry {
  iteration: number
  /** `pending` until the playtest of this iteration's level finishes. */
  outcome: 'pending' | 'passed' | 'failed' | 'mount-failed' | 'abandoned'
  /** Generated files this iteration wrote. */
  files: string[]
  /** The critique that produced this iteration's patch (absent for the first draft). */
  diagnosis?: string
  /** Matches the browser's `argon:video-preview` runId once the playtest ran. */
  runId?: string
  failureReason?: string
  timestamp: string
}

/** A generated file before and after a patch. `before` is null for a new file. */
export interface FileChange {
  path: string
  before: string | null
  after: string
}

export type DaemonMessage =
  | { type: 'registered'; role: 'browser' | 'agent'; mock?: boolean }
  | { type: 'progress'; phase: string; message: string; timestamp: string; iteration?: number; maxIterations?: number; diagnosis?: string; terminal?: string; skillContent?: string }
  | { type: 'video-preview'; runId: string; videoUrl: string }
  | { type: 'start-goal-accepted'; goal: string }
  | { type: 'goal-error'; message: string }
  | { type: 'start-playtest'; maxFrames?: number }
  | { type: 'playtest-accepted'; runId: string }
  | { type: 'playtest-started'; maxFrames: number }
  | PlaytestPassedMessage
  /** Browsers also get `iteration` and `changes` (full before/after text for diffs); agents get the paths only. */
  | { type: 'patch-applied'; runId?: string; files: string[]; iteration?: number; changes?: FileChange[] }
  | { type: 'patch-rejected'; runId?: string; diagnostics: string }
  | { type: 'files-deleted'; files: string[] }
  /** Streamed critique of the last failed run. `text` is the whole critique so far, not a delta; `final` marks the last update. */
  | { type: 'critique-text'; iteration: number; text: string; final: boolean; timestamp: string }
  /** Every attempt at the current goal, oldest first. Sent whole on each change and when a browser registers. */
  | { type: 'iteration-history'; goal: string; entries: IterationEntry[] }
  | { type: 'daemon-error'; message: string }

/** Messages the browser engine sends to the daemon after registering. */
export type BrowserMessage =
  | { type: 'start-goal'; goal: string }
  /** Change the current world instead of generating a new one. */
  | { type: 'twist'; twist: string }
  | { type: 'pause-goal' }
  | { type: 'level-mounted' }
  /** The generated level threw while mounting (in `buildWorld` or while the module evaluated). */
  | { type: 'level-mount-failed'; error: string; stack?: string }
  | PlaytestPassedMessage

export interface DecodedPlaytestPacket {
  metadata: PlaytestFailedMetadata
  videoBytes: Uint8Array
}

export interface GeneratedFilePayload {
  path: string
  content: string
}

export interface WriteFilesMessage {
  type: 'write-files'
  runId?: string
  files: GeneratedFilePayload[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodePlaytestPacket(metadata: PlaytestFailedMetadata, videoBytes: Uint8Array): Uint8Array {
  const header = encoder.encode(JSON.stringify(metadata))
  const packet = new Uint8Array(4 + header.byteLength + videoBytes.byteLength)
  new DataView(packet.buffer).setUint32(0, header.byteLength)
  packet.set(header, 4)
  packet.set(videoBytes, 4 + header.byteLength)
  return packet
}

export function decodePlaytestPacket(packet: Uint8Array): DecodedPlaytestPacket {
  if (packet.byteLength < 4) throw new Error('Playtest packet header is truncated')
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const headerLength = view.getUint32(0)
  if (headerLength === 0 || headerLength > packet.byteLength - 4) {
    throw new Error('Playtest packet header length is invalid')
  }

  let metadata: unknown
  try {
    metadata = JSON.parse(decoder.decode(packet.subarray(4, 4 + headerLength))) as unknown
  } catch {
    throw new Error('Playtest packet header is not valid JSON')
  }
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    (metadata as Partial<PlaytestFailedMetadata>).type !== 'PLAYTEST_FAILED_PAYLOAD' ||
    typeof (metadata as Partial<PlaytestFailedMetadata>).runId !== 'string' ||
    typeof (metadata as Partial<PlaytestFailedMetadata>).frameCount !== 'number' ||
    !Array.isArray((metadata as Partial<PlaytestFailedMetadata>).telemetry)
  ) {
    throw new Error('Playtest packet metadata is invalid')
  }

  return {
    metadata: metadata as PlaytestFailedMetadata,
    videoBytes: packet.slice(4 + headerLength),
  }
}
