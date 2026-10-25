import type { GeneratedFilePayload, PlaytestFailedMetadata } from '../shared/protocol'

/** Progress from a world generator, in the same shape the sync daemon forwards. */
export interface HostedEvent {
  phase: string
  message: string
  iteration?: number
  diagnosis?: string
  terminal?: string
  critiqueText?: string
  critiqueFinal?: boolean
}

export interface HostedPatch {
  files: GeneratedFilePayload[]
  interactionId: string
  diagnosis?: string
  skillContent?: string
}

export interface CritiqueRequest {
  videoBytes: Uint8Array
  metadata: PlaytestFailedMetadata
  currentFiles: GeneratedFilePayload[]
  previousInteractionId?: string
  iteration: number
}

export interface RepairRequest {
  error: string
  stack?: string
  currentFiles: GeneratedFilePayload[]
  previousInteractionId?: string
  iteration: number
}

export interface TwistRequest {
  goal: string
  twist: string
  currentFiles: GeneratedFilePayload[]
  previousInteractionId?: string
}

type Emit = (event: HostedEvent) => void

export interface HostedOrchestrator {
  readonly mock: boolean
  generate(goal: string, emit: Emit, signal: AbortSignal): Promise<HostedPatch>
  critique(request: CritiqueRequest, emit: Emit, signal: AbortSignal): Promise<HostedPatch>
  repair(request: RepairRequest, emit: Emit, signal: AbortSignal): Promise<HostedPatch>
  revise(request: TwistRequest, emit: Emit, signal: AbortSignal): Promise<HostedPatch>
}

// ---------------------------------------------------------------------------------------------
// Demo: replays the bundled catapult script in the browser. No network, no API key.
// ---------------------------------------------------------------------------------------------

const fixtureSources = import.meta.glob('../fixtures/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const fixtureScripts = import.meta.glob('../fixtures/*.script.json', { import: 'default', eager: true }) as Record<string, {
  goal: string
  steps: Array<{ files: Record<string, string>; diagnosis?: string; skillContent?: string }>
}>

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
})

export class DemoOrchestrator implements HostedOrchestrator {
  readonly mock = true
  private step = 0
  private readonly script = fixtureScripts['../fixtures/catapult.script.json']

  private stepPatch(index: number): HostedPatch {
    const steps = this.script.steps
    const step = steps[Math.min(index, steps.length - 1)]
    const files = Object.entries(step.files).map(([path, source]) => {
      const content = fixtureSources[`../fixtures/${source}`]
      if (content === undefined) throw new Error(`Demo fixture ${source} is missing`)
      return { path, content }
    })
    return { files, diagnosis: step.diagnosis, skillContent: step.skillContent, interactionId: `demo-${index}` }
  }

  async generate(goal: string, emit: Emit, signal: AbortSignal): Promise<HostedPatch> {
    this.step = 0
    const note = goal.trim() === this.script.goal ? '' : ' Demo mode always replays the catapult script; switch to Live to build your own idea.'
    emit({ phase: 'synthesizing', message: `Demo: replaying a recorded catapult build.${note}` })
    await sleep(1_500, signal)
    emit({ phase: 'thinking', message: 'Demo: writing level code…' })
    await sleep(1_500, signal)
    return this.stepPatch(0)
  }

  async critique(request: CritiqueRequest, emit: Emit, signal: AbortSignal): Promise<HostedPatch> {
    this.step = Math.min(this.step + 1, this.script.steps.length - 1)
    const patch = this.stepPatch(this.step)
    const words = (patch.diagnosis ?? 'The recorded critique for this step is missing.').split(' ')
    emit({ phase: 'critiquing', message: 'Demo critic is replaying a recorded review.', iteration: request.iteration })
    await sleep(700, signal)
    let text = ''
    for (const word of words) {
      text = text ? `${text} ${word}` : word
      emit({ phase: 'critiquing', message: 'Critic is writing…', iteration: request.iteration, critiqueText: text, critiqueFinal: false })
      await sleep(45, signal)
    }
    emit({ phase: 'critiquing', message: 'Critique complete.', iteration: request.iteration, critiqueText: text, critiqueFinal: true })
    emit({ phase: 'thinking', message: 'Demo: applying the recorded patch…', iteration: request.iteration })
    await sleep(1_000, signal)
    return patch
  }

  async repair(): Promise<HostedPatch> {
    throw new Error('The demo script has no repair step. Reset the level or start the demo again.')
  }

  async revise(request: TwistRequest, emit: Emit, signal: AbortSignal): Promise<HostedPatch> {
    emit({ phase: 'synthesizing', message: 'Demo mode cannot invent twists; switch to Live to change the world. Replaying the finished level.' })
    await sleep(800, signal)
    return { ...this.stepPatch(this.script.steps.length - 1), diagnosis: `Twists need Live mode ("${request.twist}").` }
  }
}

// ---------------------------------------------------------------------------------------------
// Live: Gemini runs in the /api/argon serverless function, streamed back as NDJSON.
// ---------------------------------------------------------------------------------------------

/** Rounds telemetry so the request stays well under the platform's 4.5 MB body limit. */
function slimMetadata(metadata: PlaytestFailedMetadata): PlaytestFailedMetadata {
  const round = (value: number) => Math.round(value * 1000) / 1000
  const triple = (v: [number, number, number]): [number, number, number] => [round(v[0]), round(v[1]), round(v[2])]
  return {
    ...metadata,
    telemetry: metadata.telemetry.map((frame) => ({
      ...frame,
      bodies: frame.bodies.map((body) => ({ name: body.name, pos: triple(body.pos), linvel: triple(body.linvel), angvel: triple(body.angvel) })),
      contacts: frame.contacts.map((contact) => ({ ...contact, totalForce: round(contact.totalForce) })),
    })),
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

export class LiveOrchestrator implements HostedOrchestrator {
  readonly mock = false

  private readonly passcode: string

  constructor(passcode: string) {
    this.passcode = passcode
  }

  private async call(action: string, payload: Record<string, unknown>, emit: Emit, signal: AbortSignal): Promise<HostedPatch> {
    const response = await fetch('/api/argon', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-patchworld-passcode': this.passcode },
      body: JSON.stringify({ action, ...payload }),
      signal,
    })
    if (!response.ok || !response.body) {
      const message = await response.text().catch(() => '')
      throw new Error(response.status === 401 ? 'The live-mode passcode was not accepted.' : `Live mode request failed (${response.status}): ${message.slice(0, 300)}`)
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        const message = JSON.parse(line) as { type: 'event'; event: HostedEvent } | { type: 'patch'; patch: HostedPatch } | { type: 'error'; message: string }
        if (message.type === 'event') emit(message.event)
        else if (message.type === 'patch') return message.patch
        else throw new Error(message.message)
      }
    }
    throw new Error('Live mode stream ended without a result')
  }

  generate(goal: string, emit: Emit, signal: AbortSignal) {
    return this.call('generate', { goal }, emit, signal)
  }

  critique(request: CritiqueRequest, emit: Emit, signal: AbortSignal) {
    return this.call('critique', {
      video: toBase64(request.videoBytes),
      metadata: slimMetadata(request.metadata),
      currentFiles: request.currentFiles,
      previousInteractionId: request.previousInteractionId,
      iteration: request.iteration,
    }, emit, signal)
  }

  repair(request: RepairRequest, emit: Emit, signal: AbortSignal) {
    return this.call('repair', { ...request }, emit, signal)
  }

  revise(request: TwistRequest, emit: Emit, signal: AbortSignal) {
    return this.call('revise', { ...request }, emit, signal)
  }
}
