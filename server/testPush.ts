import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { WebSocket, type RawData } from 'ws'
import { decodePlaytestPacket } from '../src/shared/protocol.js'

interface QueuedMessage {
  data: RawData
  isBinary: boolean
}

class SyncPeer {
  private queue: QueuedMessage[] = []
  private waiters: Array<(message: QueuedMessage) => void> = []

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      const message = { data, isBinary }
      const waiter = this.waiters.shift()
      if (waiter) waiter(message)
      else this.queue.push(message)
    })
  }

  static async connect(url: string): Promise<SyncPeer> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolvePromise, reject) => {
      socket.once('open', resolvePromise)
      socket.once('error', reject)
    })
    const peer = new SyncPeer(socket)
    peer.send({ type: 'register', role: 'agent' })
    await peer.waitFor((message) => !message.isBinary && peer.asJson(message).type === 'registered')
    return peer
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message))
  }

  async waitFor(predicate: (message: QueuedMessage) => boolean, timeoutMs = 60_000, waitLabel = 'daemon message'): Promise<QueuedMessage> {
    const existingIndex = this.queue.findIndex(predicate)
    if (existingIndex >= 0) return this.queue.splice(existingIndex, 1)[0]

    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== inspect)
        reject(new Error(`Timed out waiting for ${waitLabel}`))
      }, timeoutMs)
      const inspect = (message: QueuedMessage) => {
        if (!message.isBinary) {
          const json = this.asJson(message)
          if (json.type === 'daemon-error' || json.type === 'patch-rejected') {
            clearTimeout(timeout)
            reject(new Error(`Daemon ${String(json.type)}: ${String(json.message ?? json.diagnostics ?? '')}`))
            return
          }
        }
        if (predicate(message)) {
          clearTimeout(timeout)
          resolvePromise(message)
        } else {
          this.queue.push(message)
          this.waiters.push(inspect)
        }
      }
      this.waiters.push(inspect)
    })
  }

  asJson(message: QueuedMessage): Record<string, unknown> {
    return JSON.parse(message.data.toString()) as Record<string, unknown>
  }

  close(): void {
    this.socket.close()
  }
}

const daemonUrl = process.env.ARGON_SYNC_URL ?? 'ws://127.0.0.1:4174'
const peer = await SyncPeer.connect(daemonUrl)
const projectRoot = process.cwd()
const activePath = resolve(projectRoot, 'src/generated/activeLevel.ts')
const runId = `dry-run-${Date.now()}`
const helperPath = `src/generated/dryRun_${runId.replaceAll('-', '_')}.ts`
const helperName = helperPath.split('/').at(-1)!.replace(/\.ts$/, '')
let originalActive = ''
let originalHelper: string | null = null
let installed = false
let uploadedRunId: string | null = null

const helperSource = `
import * as THREE from 'three'
export function createMarker(): THREE.Mesh {
  return new THREE.Mesh(new THREE.IcosahedronGeometry(0.5), new THREE.MeshStandardMaterial({ color: 0x58dab8 }))
}
`

function activeLevelSource(reachesGoal: boolean): string {
  return `
import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import type { GeneratedLevelModule } from '../engine/types'
import { createMarker } from './${helperName}'

export const buildWorld: GeneratedLevelModule['buildWorld'] = (scene, world, namedBodies, eventQueue) => {
  const marker = createMarker()
  scene.add(marker)
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0))
  world.createCollider(
    RAPIER.ColliderDesc.ball(0.5).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS),
    body,
  )
  namedBodies.set('dry-run-body', body)
  void eventQueue
  return {
    stepBotAndRules: (frameIndex) => {
      marker.rotation.y = frameIndex / 30
      return { botState: 'dry-run', goalReached: ${reachesGoal ? 'frameIndex >= 120' : 'false'} }
    },
    dispose: () => {
      scene.remove(marker)
      marker.geometry.dispose()
      ;(marker.material as THREE.Material).dispose()
    },
  }
}
`
}

async function waitForJson(type: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const message = await peer.waitFor((entry) => !entry.isBinary && peer.asJson(entry).type === type, timeoutMs, `daemon ${type}`)
  return peer.asJson(message)
}

try {
  originalActive = await readFile(activePath, 'utf8')
  try {
    originalHelper = await readFile(resolve(projectRoot, helperPath), 'utf8')
  } catch {
    originalHelper = null
  }

  installed = true
  peer.send({
    type: 'write-files',
    runId,
    files: [
      { path: helperPath, content: helperSource },
      { path: 'src/generated/activeLevel.ts', content: activeLevelSource(false) },
    ],
  })
  const installedMessage = await waitForJson('patch-applied')
  assert.ok(Array.isArray(installedMessage.files), 'daemon should confirm the installed multi-file patch')

  peer.send({ type: 'start-playtest', maxFrames: 240 })
  await waitForJson('playtest-started')
  const failedMessage = await peer.waitFor((message) => message.isBinary, 60_000)
  const failure = decodePlaytestPacket(new Uint8Array(failedMessage.data as Buffer))
  uploadedRunId = failure.metadata.runId
  assert.equal(failure.metadata.frameCount, 240)
  assert.equal(failure.metadata.telemetry.length, 240)
  assert.ok(failure.videoBytes.byteLength > 0, 'browser should return a WebM payload')
  await waitForJson('playtest-artifact-saved')

  peer.send({
    type: 'write-files',
    runId,
    files: [{ path: 'src/generated/activeLevel.ts', content: activeLevelSource(true) }],
  })
  await waitForJson('patch-applied')
  const passed = await waitForJson('playtest-passed', 60_000)
  assert.ok(Number(passed.frameCount) > 0 && Number(passed.frameCount) < 240)

  console.log(`Dry run passed: 240-frame failure produced ${failure.videoBytes.byteLength} WebM bytes and telemetry; HMR retry reached goal at frame ${passed.frameCount}.`)
} finally {
  try {
    if (installed) {
      peer.send({ type: 'write-files', runId, files: [{ path: 'src/generated/activeLevel.ts', content: originalActive }] })
      await waitForJson('patch-applied', 15_000)
      if (originalHelper === null) {
        peer.send({ type: 'delete-files', runId, paths: [helperPath] })
        await waitForJson('files-deleted', 15_000)
      } else {
        peer.send({ type: 'write-files', runId, files: [{ path: helperPath, content: originalHelper }] })
        await waitForJson('patch-applied', 15_000)
      }
    }
  } catch (error) {
    console.error('[Dry run] Could not restore generated files automatically:', error)
  }
  if (uploadedRunId) {
    await Promise.all([
      rm(resolve(projectRoot, `artifacts/playtests/${uploadedRunId}.webm`), { force: true }),
      rm(resolve(projectRoot, `artifacts/playtests/${uploadedRunId}.telemetry.json`), { force: true }),
    ])
  }
  peer.close()
}
