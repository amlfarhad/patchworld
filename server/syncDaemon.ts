import { watchFile } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, resolve, sep } from 'node:path'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { decodePlaytestPacket, type FileChange, type IterationEntry, type WriteFilesMessage } from '../src/shared/protocol.ts'
import { checkGeneratedTypeScript, validateGeneratedFiles, type GeneratedFile } from './generatedFiles.ts'
import type { GeneratedPatch } from './argonOrchestrator.ts'
import { createWorldOrchestrator, mockScriptFromArgs, type ValidateFiles, type WorldEvent, type WorldOrchestrator } from './orchestrator.ts'
import { RunRecorder, type RecordedStep } from './runRecorder.ts'

type ClientRole = 'browser' | 'agent'

interface ClientRecord {
  socket: WebSocket
  role: ClientRole
}

const host = '127.0.0.1'
const port = Number(process.env.ARGON_SYNC_PORT ?? 4174)
const projectRoot = process.cwd()
const generatedRoot = resolve(projectRoot, 'src/generated')
const artifactRoot = resolve(projectRoot, 'artifacts/playtests')
const maxBytes = 12 * 1024 * 1024
const allowedOrigin = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/
const clients = new Set<ClientRecord>()
const maxIterations = Math.min(20, Math.max(1, Number(process.env.ARGON_MAX_ITERATIONS) || 8))
const mountTimeoutMs = Math.max(2_000, Number(process.env.ARGON_MOUNT_TIMEOUT_MS) || 15_000)
const skillPath = resolve(projectRoot, '.agents/SKILL.md')
const runsRoot = resolve(projectRoot, 'artifacts/runs')
/** Set by --mock[=name or folder] or ARGON_MOCK: replay a scripted run instead of calling Gemini. */
const mockScript = mockScriptFromArgs()
let goalEpoch = 0
let activeGoal = ''
/** The goal the world on screen was built for; unlike activeGoal it survives pause and completion. */
let worldGoal = ''
let iteration = 0
let previousInteractionId: string | undefined
let awaitingLevelMount = false
let mountWatchdog: ReturnType<typeof setTimeout> | undefined
let history: IterationEntry[] = []
/** Live goals are recorded as replayable mock scripts under artifacts/runs/. */
let recording: Promise<RunRecorder | null> | null = null
/** The browser that runs autonomous playtests for the current goal; other open tabs only mirror progress. */
let engineSocket: WebSocket | null = null
/** Signature of the last batch that passed the typecheck, so applying it does not check it twice. */
let lastCleanBatch = ''
let writeQueue: Promise<void> = Promise.resolve()

const batchSignature = (files: GeneratedFile[]) =>
  createHash('sha256').update(JSON.stringify(files.map(({ path, content }) => [path, content]))).digest('hex')

const validateFiles: ValidateFiles = async (files) => {
  const safeFiles = validateGeneratedFiles(files)
  const diagnostics = await checkGeneratedTypeScript(safeFiles, projectRoot)
  lastCleanBatch = diagnostics.length === 0 ? batchSignature(safeFiles) : ''
  return diagnostics
}

/** True when `socket` is the engine browser. Adopts it when the engine tab closed or reloaded. */
function isEngine(socket: WebSocket): boolean {
  if (!engineSocket || engineSocket.readyState !== engineSocket.OPEN) engineSocket = socket
  return engineSocket === socket
}

function emitProgress(event: WorldEvent): void {
  const timestamp = new Date().toISOString()
  if (event.critiqueText !== undefined) {
    sendToRole('browser', { type: 'critique-text', iteration: event.iteration ?? iteration, text: event.critiqueText, final: event.critiqueFinal ?? false, timestamp })
    return
  }
  sendToRole('browser', { type: 'progress', iteration, maxIterations, ...event, timestamp })
}

function createOrchestrator(epoch: number): WorldOrchestrator {
  return createWorldOrchestrator((event) => { if (epoch === goalEpoch) emitProgress(event) }, { mockScript, projectRoot })
}

async function recordStep(step: RecordedStep): Promise<void> {
  try {
    await (await recording)?.record(step)
  } catch (error) {
    console.warn('[Argon sync] Could not record this run step:', error)
  }
}

function publishHistory(socket?: WebSocket): void {
  const payload = { type: 'iteration-history', goal: worldGoal, entries: history }
  if (socket) sendJson(socket, payload)
  else sendToRole('browser', payload)
}

function settleLatestIteration(outcome: IterationEntry['outcome'], details: Pick<IterationEntry, 'runId' | 'failureReason'> = {}): void {
  const latest = history.at(-1)
  if (!latest || latest.outcome !== 'pending') return
  history = [...history.slice(0, -1), { ...latest, outcome, ...details }]
  publishHistory()
}

async function publishSkill(socket?: WebSocket): Promise<void> {
  try {
    const skillContent = (await readFile(skillPath, 'utf8')).slice(0, 64000)
    const payload = { type: 'progress', phase: 'skill-evolving', message: 'Learned physics invariants updated.', skillContent, timestamp: new Date().toISOString() }
    if (socket) sendJson(socket, payload)
    else sendToRole('browser', payload)
  } catch { /* No learned skill has been published yet. */ }
}

async function persistSkill(content?: string): Promise<void> {
  if (!content?.trim()) return
  await mkdir(resolve(projectRoot, '.agents'), { recursive: true })
  await writeFile(skillPath, content.slice(0, 64000), 'utf8')
  await publishSkill()
}
watchFile(skillPath, { persistent: false, interval: 1000 }, () => { void publishSkill() })

async function readCurrentGeneratedFiles(): Promise<GeneratedFile[]> {
  const entries = await readdir(generatedRoot, { withFileTypes: true })
  return Promise.all(entries
    .filter((entry) => entry.isFile() && /\.(ts|glsl)$/.test(entry.name) && !entry.name.startsWith('.'))
    .map(async (entry) => ({
      path: `src/generated/${entry.name}`,
      content: await readFile(resolve(generatedRoot, entry.name), 'utf8'),
    })))
}

async function describeChanges(files: GeneratedFile[]): Promise<FileChange[]> {
  return Promise.all(files.map(async ({ path, content }) => ({
    path,
    before: await readFile(resolve(projectRoot, path), 'utf8').catch(() => null),
    after: content,
  })))
}

/** Typechecks and writes a batch. Returns the written files, or null when rejected or superseded. */
async function validateAndApply(files: GeneratedFile[], runId?: string, epoch = goalEpoch): Promise<GeneratedFile[] | null> {
  const safeFiles = validateGeneratedFiles(files)
  const diagnostics = batchSignature(safeFiles) === lastCleanBatch ? [] : await checkGeneratedTypeScript(safeFiles, projectRoot)
  if (diagnostics.length > 0) {
    const rejected = { type: 'patch-rejected', runId, diagnostics: diagnostics.join('\n') }
    sendToRole('browser', rejected)
    sendToRole('agent', rejected)
    return null
  }
  if (epoch !== goalEpoch) return null
  const changes = await describeChanges(safeFiles)
  if (epoch !== goalEpoch) return null
  await writeBatch(safeFiles)
  const paths = safeFiles.map(({ path }) => path)
  sendToRole('agent', { type: 'patch-applied', runId, files: paths })
  sendToRole('browser', { type: 'patch-applied', runId, files: paths, iteration, changes })
  return safeFiles
}

/** Writes an orchestrator patch as the next iteration and starts waiting for the browser to mount it. */
async function applyIterationPatch(patch: GeneratedPatch, runId: string | undefined, epoch: number): Promise<boolean> {
  const applied = await validateAndApply(patch.files, runId, epoch)
  if (epoch !== goalEpoch) return false
  if (!applied) {
    activeGoal = ''
    emitProgress({ phase: 'error', message: 'The generated patch failed validation, so the loop stopped. Start the goal again or take over.', iteration })
    return false
  }
  iteration += 1
  awaitingLevelMount = true
  armMountWatchdog(epoch)
  history = [...history, {
    iteration,
    outcome: 'pending',
    files: applied.map(({ path }) => path),
    diagnosis: patch.diagnosis,
    timestamp: new Date().toISOString(),
  }]
  publishHistory()
  void recordStep({ files: applied, diagnosis: patch.diagnosis, skillContent: patch.skillContent })
  previousInteractionId = patch.interactionId
  await persistSkill(patch.skillContent)
  return true
}

function armMountWatchdog(epoch: number): void {
  clearMountWatchdog()
  mountWatchdog = setTimeout(() => {
    mountWatchdog = undefined
    if (epoch !== goalEpoch || !awaitingLevelMount) return
    const seconds = Math.round(mountTimeoutMs / 1000)
    void handleMountFailure(`The updated level did not load within ${seconds} s. The module may have thrown while evaluating; check the browser console.`)
  }, mountTimeoutMs)
}

function clearMountWatchdog(): void {
  if (mountWatchdog) clearTimeout(mountWatchdog)
  mountWatchdog = undefined
}

function beginGoal(goal: string): number {
  clearMountWatchdog()
  activeGoal = goal
  worldGoal = goal
  iteration = 0
  previousInteractionId = undefined
  awaitingLevelMount = false
  history = []
  publishHistory()
  recording = mockScript ? null : RunRecorder.start(goal, runsRoot).catch((error: unknown) => {
    console.warn('[Argon sync] Could not start recording this run:', error)
    return null
  })
  return ++goalEpoch
}

function reportGoalError(error: unknown, socket?: WebSocket): void {
  awaitingLevelMount = false
  clearMountWatchdog()
  const message = error instanceof Error ? error.message : String(error)
  if (socket) sendJson(socket, { type: 'goal-error', message })
  emitProgress({ phase: 'error', message, iteration })
}

async function startGoal(socket: WebSocket, goal: string): Promise<void> {
  if (!goal.trim() || goal.length > 2_000) {
    sendJson(socket, { type: 'goal-error', message: 'Enter a level goal between 1 and 2,000 characters.' })
    return
  }
  const epoch = beginGoal(goal.trim())
  engineSocket = socket
  sendToRole('browser', { type: 'start-goal-accepted', goal: activeGoal })
  try {
    const patch = await createOrchestrator(epoch).generateInitialWorld(activeGoal, validateFiles)
    if (epoch !== goalEpoch) return
    if (!await applyIterationPatch(patch, patch.interactionId, epoch)) return
    emitProgress({ phase: 'hmr-pending', message: 'World generated; waiting for the browser to mount the updated module.', iteration })
  } catch (error) {
    if (epoch !== goalEpoch) return
    reportGoalError(error, socket)
  }
}

/** Changes the current world instead of starting over; history, attempt numbering and the Gemini conversation carry on. */
async function startTwist(socket: WebSocket, twist: string): Promise<void> {
  const text = twist.trim()
  if (!text || text.length > 800) {
    sendJson(socket, { type: 'goal-error', message: 'Enter a twist between 1 and 800 characters.' })
    return
  }
  const baseGoal = worldGoal
  const combinedGoal = baseGoal ? `${baseGoal} Twist: ${text}` : text
  // Take ownership first: bumping the epoch drops any critique patch still in flight.
  const epoch = ++goalEpoch
  const orchestrator = createOrchestrator(epoch)
  if (!baseGoal || !orchestrator.reviseWorld) return startGoal(socket, combinedGoal)
  clearMountWatchdog()
  awaitingLevelMount = false
  activeGoal = combinedGoal
  worldGoal = combinedGoal
  engineSocket = socket
  // A twist continues the same history and numbering, so earlier attempts stay comparable.
  settleLatestIteration('abandoned')
  const chainId = previousInteractionId
  const currentFiles = await readCurrentGeneratedFiles()
  if (epoch !== goalEpoch) return
  sendToRole('browser', { type: 'start-goal-accepted', goal: combinedGoal })
  try {
    const patch = await orchestrator.reviseWorld({ goal: baseGoal, twist: text, currentFiles, previousInteractionId: chainId }, validateFiles)
    if (epoch !== goalEpoch) return
    if (!await applyIterationPatch(patch, patch.interactionId, epoch)) return
    emitProgress({ phase: 'hmr-pending', message: 'Twist applied; waiting for the browser to mount the updated module.', iteration })
  } catch (error) {
    if (epoch !== goalEpoch) return
    reportGoalError(error, socket)
  }
}

async function critiqueFailedRun(packet: Awaited<ReturnType<typeof savePlaytestPacket>>): Promise<void> {
  if (!activeGoal) return
  const epoch = goalEpoch
  if (iteration >= maxIterations) {
    activeGoal = ''
    emitProgress({ phase: 'limit-reached', message: 'Iteration limit reached. Review the replay, take over, or start a new goal.' })
    return
  }
  try {
    emitProgress({ phase: 'critiquing', message: mockScript ? 'Mock mode: replaying the scripted critique (no video is analyzed).' : 'Managed Agent sandbox is reviewing the video and frame telemetry.', iteration })
    const currentFiles = await readCurrentGeneratedFiles()
    const patch = await createOrchestrator(epoch).critiqueAndPatchWorld({
      videoBytes: packet.videoBytes,
      metadata: packet.metadata,
      currentFiles,
      previousInteractionId,
      iteration,
    }, validateFiles)
    if (epoch !== goalEpoch) return
    emitProgress({ phase: 'diagnosis', message: patch.diagnosis ?? 'Patch is ready for the next playtest.', diagnosis: patch.diagnosis, iteration })
    if (!await applyIterationPatch(patch, packet.metadata.runId, epoch)) return
    emitProgress({ phase: 'hmr-pending', message: 'Patch accepted; waiting for the updated level to mount.', iteration })
  } catch (error) {
    if (epoch !== goalEpoch) return
    reportGoalError(error)
  }
}

/** A generated level threw while mounting, or never mounted. Repairs it when the orchestrator can, otherwise stops the loop. */
async function handleMountFailure(error: string, stack?: string): Promise<void> {
  clearMountWatchdog()
  sendToRole('agent', { type: 'level-mount-failed', error, stack })
  const wasAwaiting = awaitingLevelMount
  awaitingLevelMount = false
  if (!wasAwaiting) {
    // Not a patch the loop is waiting on: a crash after Reset level (show it), or a duplicate report during a repair (ignore it).
    if (!activeGoal) emitProgress({ phase: 'error', message: `The level threw while loading: ${error}`, iteration })
    return
  }
  settleLatestIteration('mount-failed', { failureReason: error })
  if (!activeGoal) {
    emitProgress({ phase: 'error', message: `Generated level failed to load: ${error}`, iteration })
    return
  }
  const epoch = goalEpoch
  const stop = (reason: string) => {
    activeGoal = ''
    emitProgress({ phase: 'error', message: `Generated level failed to load: ${error} ${reason}`, iteration })
  }
  if (iteration >= maxIterations) return stop('The iteration limit is reached, so the loop stopped.')
  if (![...clients].some((client) => client.role === 'browser')) return stop('No browser engine is connected, so the loop stopped.')
  try {
    const orchestrator = createOrchestrator(epoch)
    if (!orchestrator.repairMountFailure) return stop('This orchestrator cannot repair load failures yet, so the loop stopped. Start the goal again or take over.')
    emitProgress({ phase: 'critiquing', message: 'The level crashed while loading; asking for a repair.', iteration })
    const patch = await orchestrator.repairMountFailure({ error, stack, currentFiles: await readCurrentGeneratedFiles(), previousInteractionId, iteration }, validateFiles)
    if (epoch !== goalEpoch) return
    emitProgress({ phase: 'diagnosis', message: patch.diagnosis ?? 'Repair is ready for the next playtest.', diagnosis: patch.diagnosis, iteration })
    if (!await applyIterationPatch(patch, undefined, epoch)) return
    emitProgress({ phase: 'hmr-pending', message: 'Repair accepted; waiting for the updated level to mount.', iteration })
  } catch (repairError) {
    if (epoch !== goalEpoch) return
    activeGoal = ''
    reportGoalError(repairError)
  }
}

function sendJson(socket: WebSocket, payload: object): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
}

function parseJsonMessage(data: RawData): Record<string, unknown> {
  if (Array.isArray(data) || data instanceof ArrayBuffer) throw new Error('Expected a text message')
  const parsed: unknown = JSON.parse(data.toString())
  if (!parsed || typeof parsed !== 'object') throw new Error('Expected a JSON object')
  return parsed as Record<string, unknown>
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return data
}

/** Serializes writes, so the goal loop and agent patches never race on the same files. */
function writeBatch(files: GeneratedFile[]): Promise<void> {
  const run = writeQueue.then(() => writeBatchNow(files))
  writeQueue = run.catch(() => {})
  return run
}

/** Windows briefly locks files that Vite's watcher is reading; retry the rename instead of failing the patch. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50 * (attempt + 1)))
    }
  }
}

async function writeBatchNow(files: GeneratedFile[]): Promise<void> {
  await mkdir(generatedRoot, { recursive: true })
  const staged: Array<{ temporary: string; destination: string }> = []

  try {
    for (const file of files) {
      const destination = resolve(projectRoot, file.path)
      if (!destination.startsWith(`${generatedRoot}${sep}`)) {
        throw new Error(`Resolved path escapes generated directory: ${file.path}`)
      }
      const temporary = `${destination}.${randomUUID()}.tmp`
      await writeFile(temporary, file.content, { encoding: 'utf8', flag: 'wx' })
      staged.push({ temporary, destination })
    }
    const entryModule = staged.find(({ destination }) => destination.endsWith(`${sep}activeLevel.ts`))
    for (const file of staged) {
      if (file !== entryModule) await renameWithRetry(file.temporary, file.destination)
    }
    if (entryModule) {
      // Let Vite observe imported helper modules before it recompiles activeLevel.ts.
      if (staged.length > 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
      await renameWithRetry(entryModule.temporary, entryModule.destination)
    }
  } catch (error) {
    await Promise.all(staged.map(({ temporary }) => rm(temporary, { force: true })))
    throw error
  }
}

async function deleteGeneratedFiles(paths: unknown): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 64) {
    throw new Error('Delete batch must contain 1 to 64 paths')
  }
  const safePaths = paths.map((path) => {
    if (typeof path !== 'string' || !/^src\/generated\/[A-Za-z0-9_.-]+\.(ts|glsl)$/.test(path)) {
      throw new Error(`Generated delete path is invalid: ${String(path)}`)
    }
    const fileName = basename(path)
    if (fileName.startsWith('.') || fileName.endsWith('.tmp')) {
      throw new Error(`Invalid generated filename: ${fileName}`)
    }
    return path
  })
  await Promise.all(safePaths.map((path) => rm(resolve(projectRoot, path), { force: true })))
  return safePaths
}

function sendToRole(role: ClientRole, payload: object): void {
  clients.forEach(({ role: clientRole, socket }) => {
    if (clientRole === role) sendJson(socket, payload)
  })
}

function forwardBinaryToRole(role: ClientRole, data: Uint8Array): void {
  clients.forEach(({ role: clientRole, socket }) => {
    if (clientRole === role && socket.readyState === socket.OPEN) socket.send(data, { binary: true })
  })
}

async function savePlaytestPacket(packetBytes: Uint8Array): Promise<ReturnType<typeof decodePlaytestPacket>> {
  const packet = decodePlaytestPacket(packetBytes)
  const { metadata, videoBytes } = packet
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(metadata.runId)) throw new Error('Invalid playtest runId')
  if (metadata.frameCount !== metadata.telemetry.length) {
    throw new Error('frameCount must match the telemetry frame count')
  }
  if (videoBytes.byteLength === 0) throw new Error('Failed playtest did not include a WebM payload')

  await mkdir(artifactRoot, { recursive: true })
  await writeFile(resolve(artifactRoot, `${metadata.runId}.webm`), videoBytes)
  await writeFile(
    resolve(artifactRoot, `${metadata.runId}.telemetry.json`),
    JSON.stringify(metadata, null, 2),
  )
  return packet
}

async function handleAgentMessage(socket: WebSocket, message: Record<string, unknown>): Promise<void> {
  if (message.type === 'start-playtest') {
    const maxFrames = typeof message.maxFrames === 'number'
      ? Math.max(1, Math.min(Math.floor(message.maxFrames), 240))
      : 240
    const browsers = [...clients].filter((client) => client.role === 'browser')
    if (browsers.length === 0) {
      sendJson(socket, { type: 'daemon-error', message: 'No browser engine is connected' })
      return
    }
    browsers.forEach(({ socket: browser }) => sendJson(browser, { type: 'start-playtest', maxFrames }))
    sendJson(socket, { type: 'playtest-started', maxFrames })
    return
  }

  if (message.type === 'delete-files') {
    try {
      const files = await deleteGeneratedFiles(message.paths)
      const result = { type: 'files-deleted', files }
      sendJson(socket, result)
      sendToRole('browser', result)
    } catch (error) {
      sendJson(socket, { type: 'patch-rejected', runId: message.runId, diagnostics: error instanceof Error ? error.message : 'Unable to delete generated files' })
    }
    return
  }

  if (message.type !== 'write-files' || !Array.isArray(message.files)) {
    sendJson(socket, { type: 'daemon-error', message: 'Unknown agent message type' })
    return
  }

  const writeMessage = message as unknown as WriteFilesMessage
  const runId = typeof message.runId === 'string' ? message.runId : undefined
  try {
    const files = validateGeneratedFiles(writeMessage.files)
    const diagnostics = await checkGeneratedTypeScript(files, projectRoot)
    if (diagnostics.length > 0) {
      sendJson(socket, { type: 'patch-rejected', runId, diagnostics: diagnostics.join('\n') })
      return
    }

    await writeBatch(files)
    const result = { type: 'patch-applied', runId, files: files.map(({ path }) => path) }
    sendJson(socket, result)
    sendToRole('browser', result)
  } catch (error) {
    sendJson(socket, {
      type: 'patch-rejected',
      runId,
      diagnostics: error instanceof Error ? error.message : 'Unable to apply generated files',
    })
  }
}

async function handleBrowserMessage(
  socket: WebSocket,
  data: RawData,
  isBinary: boolean,
): Promise<void> {
  if (isBinary) {
    try {
      const packet = await savePlaytestPacket(rawDataToBytes(data))
      sendJson(socket, { type: 'playtest-accepted', runId: packet.metadata.runId })
      forwardBinaryToRole('agent', rawDataToBytes(data))
      sendToRole('agent', { type: 'playtest-artifact-saved', runId: packet.metadata.runId })
      if (isEngine(socket) && history.at(-1)?.outcome === 'pending') {
        settleLatestIteration('failed', { runId: packet.metadata.runId, failureReason: packet.metadata.failureReason })
        void critiqueFailedRun(packet)
      }
    } catch (error) {
      sendJson(socket, {
        type: 'daemon-error',
        message: error instanceof Error ? error.message : 'Unable to save playtest artifact',
      })
    }
    return
  }

  try {
    const message = parseJsonMessage(data)
    if (message.type === 'playtest-passed') {
      sendToRole('agent', message)
      if (!isEngine(socket) || history.at(-1)?.outcome !== 'pending') return
      settleLatestIteration('passed', { runId: typeof message.runId === 'string' ? message.runId : undefined })
      activeGoal = ''
      emitProgress({ phase: 'complete', message: 'Goal reached. Human controls are available.' })
    } else if (message.type === 'pause-goal') {
      goalEpoch += 1
      activeGoal = ''
      awaitingLevelMount = false
      clearMountWatchdog()
      settleLatestIteration('abandoned')
      emitProgress({ phase: 'human', message: 'Autonomous loop paused. Human control enabled.' })
    }
    else if (message.type === 'start-goal' && typeof message.goal === 'string') void startGoal(socket, message.goal)
    else if (message.type === 'twist' && typeof message.twist === 'string') void startTwist(socket, message.twist)
    else if (message.type === 'level-mounted') {
      if (!isEngine(socket)) return
      clearMountWatchdog()
      sendToRole('browser', { type: 'progress', phase: 'hmr-swapped', message: 'Updated physics module mounted through Vite HMR.', timestamp: new Date().toISOString(), iteration })
      if (awaitingLevelMount) {
        awaitingLevelMount = false
        sendJson(socket, { type: 'start-playtest', maxFrames: 240 })
        emitProgress({ phase: 'recording', message: 'Recording the 8-second autonomous bot playtest.', iteration })
      }
    }
    else if (message.type === 'level-mount-failed') {
      if (!isEngine(socket)) return
      const error = typeof message.error === 'string' && message.error.trim() ? message.error.slice(0, 4_000) : 'Unknown error'
      const stack = typeof message.stack === 'string' ? message.stack.slice(0, 8_000) : undefined
      void handleMountFailure(error, stack)
    }
    else sendJson(socket, { type: 'daemon-error', message: 'Unknown browser message type' })
  } catch (error) {
    sendJson(socket, { type: 'daemon-error', message: error instanceof Error ? error.message : 'Invalid browser message' })
  }
}

const httpServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ service: 'argon-local-sync', status: 'ready' }))
})

const websocketServer = new WebSocketServer({
  server: httpServer,
  maxPayload: maxBytes + 1024 * 1024,
  verifyClient: ({ origin }, done) => {
    done(!origin || allowedOrigin.test(origin), origin ? 403 : 401, 'Localhost origin required')
  },
})

websocketServer.on('connection', (socket) => {
  let record: ClientRecord | null = null
  let writeTail = Promise.resolve()

  socket.on('message', (data, isBinary) => {
    if (!record) {
      try {
        const message = parseJsonMessage(data)
        if (message.type !== 'register' || (message.role !== 'browser' && message.role !== 'agent')) {
          throw new Error('First message must register role as browser or agent')
        }
        record = { socket, role: message.role }
        clients.add(record)
        sendJson(socket, { type: 'registered', role: record.role, mock: Boolean(mockScript) })
        if (record.role === 'browser') {
          void publishSkill(socket)
          if (history.length > 0) publishHistory(socket)
        }
      } catch (error) {
        sendJson(socket, { type: 'daemon-error', message: error instanceof Error ? error.message : 'Invalid registration' })
        socket.close(1008, 'Register client role first')
      }
      return
    }

    if (record.role === 'browser') {
      void handleBrowserMessage(socket, data, isBinary)
      return
    }

    writeTail = writeTail.then(async () => {
      try {
        if (isBinary) throw new Error('Agent messages must use JSON text frames')
        await handleAgentMessage(socket, parseJsonMessage(data))
      } catch (error) {
        sendJson(socket, { type: 'daemon-error', message: error instanceof Error ? error.message : 'Invalid agent message' })
      }
    })
  })

  socket.on('close', () => {
    if (record) clients.delete(record)
  })
})

httpServer.listen(port, host, () => {
  console.log(`[Argon sync] Listening on ws://${host}:${port}`)
  console.log(`[Argon sync] Writes are limited to ${generatedRoot}`)
  console.log(`[Argon sync] Failed playtests are saved under ${artifactRoot}`)
  if (mockScript) console.log(`[Argon sync] Mock mode: replaying "${mockScript}"; no Gemini calls are made`)
  else console.log(`[Argon sync] Live runs are recorded under ${runsRoot}; replay one with --mock=<folder>`)
})
