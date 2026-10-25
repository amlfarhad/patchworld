import type RAPIER from '@dimforge/rapier3d-compat'
import type { ContactSnapshot } from './types'
import { isHosted } from '../hosted/mode'

export interface FrameSnapshot {
  frame: number
  timestampMs: number
  bodies: Array<{
    name: string
    pos: [number, number, number]
    linvel: [number, number, number]
    angvel: [number, number, number]
  }>
  contacts: ContactSnapshot[]
  botState: string
}

export interface RecordingResult {
  videoBlob: Blob
  telemetry: FrameSnapshot[]
}

export class SynchronizedRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private frames: FrameSnapshot[] = []
  private startTime = 0
  private readonly canvas: HTMLCanvasElement
  public isRecording = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  start(fps = 30): void {
    if (this.isRecording) throw new Error('A recording is already in progress')
    if (typeof MediaRecorder === 'undefined' || !this.canvas.captureStream) {
      throw new Error('Canvas recording is not supported in this browser')
    }

    this.chunks = []
    this.frames = []
    this.startTime = performance.now()
    this.stream = this.canvas.captureStream(fps)
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm'

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType,
        // Hosted uploads go through a serverless function with a 4.5 MB request limit.
        videoBitsPerSecond: isHosted ? 1_200_000 : 4_000_000,
      })
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data)
      }
      this.mediaRecorder.start(100)
      this.isRecording = true
    } catch (error) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
      this.mediaRecorder = null
      throw error
    }
  }

  capturePhysicsFrame(
    frameIndex: number,
    namedBodies: Map<string, RAPIER.RigidBody>,
    contacts: ContactSnapshot[],
    botState: string,
  ): void {
    if (!this.isRecording) return

    const bodies: FrameSnapshot['bodies'] = []
    namedBodies.forEach((body, name) => {
      const position = body.translation()
      const linearVelocity = body.linvel()
      const angularVelocity = body.angvel()
      bodies.push({
        name,
        pos: [position.x, position.y, position.z],
        linvel: [linearVelocity.x, linearVelocity.y, linearVelocity.z],
        angvel: [angularVelocity.x, angularVelocity.y, angularVelocity.z],
      })
    })

    this.frames.push({
      frame: frameIndex,
      timestampMs: Math.round(performance.now() - this.startTime),
      bodies,
      contacts: contacts.map((contact) => ({ ...contact })),
      botState,
    })
  }

  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      const recorder = this.mediaRecorder
      if (!recorder || !this.isRecording) {
        reject(new Error('No recording is in progress'))
        return
      }

      this.isRecording = false
      recorder.onstop = () => {
        const videoBlob = new Blob(this.chunks, { type: 'video/webm' })
        this.stream?.getTracks().forEach((track) => track.stop())
        this.stream = null
        this.mediaRecorder = null
        resolve({ videoBlob, telemetry: this.frames })
      }
      recorder.onerror = (event) => {
        this.stream?.getTracks().forEach((track) => track.stop())
        this.stream = null
        this.mediaRecorder = null
        reject(new Error(`Recording failed: ${event.type}`))
      }
      recorder.stop()
    })
  }
}
