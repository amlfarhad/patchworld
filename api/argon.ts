import { timingSafeEqual } from 'node:crypto'
import { transform } from 'sucrase'
import { ArgonOrchestrator, type GeneratedPatch } from '../server/argonOrchestrator.js'
import { checkGeneratedTypeScript, validateGeneratedFiles, type GeneratedFile } from '../server/generatedFiles.js'
import type { ValidateFiles, WorldEvent } from '../server/orchestrator.js'
import type { PlaytestFailedMetadata } from '../src/shared/protocol.js'

/**
 * Live mode for the hosted build. The browser runs the playtest loop and calls this function for
 * each Gemini step; progress streams back as newline-delimited JSON so the critique appears as it
 * is written. The Gemini key never leaves the server. Setting PATCHWORLD_PASSCODE keeps a public
 * link from spending the key; without it, live mode is open.
 */

export const config = { maxDuration: 300 }

const maxBodyBytes = 4_400_000

/** With no PATCHWORLD_PASSCODE set, live mode is open to anyone who has the link. */
function passcodeAccepted(given: string | null): boolean {
  const expected = process.env.PATCHWORLD_PASSCODE
  if (!expected) return true
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Full typecheck when the app sources were bundled with the function; otherwise a syntax check. */
const validate: ValidateFiles = async (files) => {
  const safe = validateGeneratedFiles(files)
  try {
    return await checkGeneratedTypeScript(safe, process.cwd(), { generatedOnly: true })
  } catch (error) {
    console.warn('[argon api] Full typecheck unavailable, falling back to a syntax check:', error)
    const problems: string[] = []
    for (const file of safe) {
      if (!file.path.endsWith('.ts')) continue
      try { transform(file.content, { transforms: ['typescript'], filePath: file.path }) } catch (syntaxError) {
        problems.push(`${file.path}: ${syntaxError instanceof Error ? syntaxError.message : String(syntaxError)}`)
      }
    }
    return problems
  }
}

function asFiles(value: unknown): GeneratedFile[] {
  if (!Array.isArray(value)) return []
  return value.filter((file): file is GeneratedFile => !!file && typeof file.path === 'string' && typeof file.content === 'string')
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')
const optionalText = (value: unknown, max: number) => (typeof value === 'string' && value ? value.slice(0, max) : undefined)
/** Only ids Gemini issued can continue a conversation. Demo replays use their own (demo-N), and Gemini rejects them with a 400. */
const geminiInteractionId = (value: unknown) => {
  const id = optionalText(value, 200)
  return id && !/^(demo|mock)-/.test(id) ? id : undefined
}

/** Lets the page open in live mode only when this deployment can serve it. */
export function GET(): Response {
  return Response.json(
    { live: Boolean(process.env.GEMINI_API_KEY), passcodeRequired: Boolean(process.env.PATCHWORLD_PASSCODE) },
    { headers: { 'cache-control': 'no-store' } },
  )
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.GEMINI_API_KEY) {
    return new Response('Live mode is not configured on this deployment.', { status: 503 })
  }
  if (!passcodeAccepted(request.headers.get('x-patchworld-passcode'))) return new Response('Passcode required.', { status: 401 })
  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > maxBodyBytes) return new Response('Request too large.', { status: 413 })

  let body: Record<string, unknown>
  try {
    body = await request.json() as Record<string, unknown>
  } catch {
    return new Response('Expected a JSON body.', { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (message: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`))
      const orchestrator = new ArgonOrchestrator((event: WorldEvent) => send({ type: 'event', event }))
      try {
        let patch: GeneratedPatch
        const iteration = Number(body.iteration) || 0
        const currentFiles = asFiles(body.currentFiles)
        const previousInteractionId = geminiInteractionId(body.previousInteractionId)
        switch (body.action) {
          case 'generate': {
            const goal = text(body.goal, 2_000).trim()
            if (!goal) throw new Error('A goal is required.')
            patch = await orchestrator.generateInitialWorld(goal, validate)
            break
          }
          case 'critique': {
            const video = Buffer.from(text(body.video, maxBodyBytes), 'base64')
            const metadata = body.metadata as PlaytestFailedMetadata | undefined
            if (!video.byteLength || !metadata || !Array.isArray(metadata.telemetry)) throw new Error('A recorded run is required.')
            patch = await orchestrator.critiqueAndPatchWorld({ videoBytes: new Uint8Array(video), metadata, currentFiles, previousInteractionId, iteration }, validate)
            break
          }
          case 'repair':
            patch = await orchestrator.repairMountFailure({ error: text(body.error, 4_000) || 'Unknown error', stack: optionalText(body.stack, 8_000), currentFiles, previousInteractionId, iteration }, validate)
            break
          case 'revise':
            patch = await orchestrator.reviseWorld({ goal: text(body.goal, 2_000), twist: text(body.twist, 800), currentFiles, previousInteractionId }, validate)
            break
          default:
            throw new Error('Unknown action.')
        }
        send({ type: 'patch', patch })
      } catch (error) {
        console.error('[argon api]', error)
        send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } })
}
