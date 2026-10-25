import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import type { ControlBinding, GeneratedLevelModule } from './types'

const FIXED_STEP = 1 / 60
const BASELINE_FRAMES = 90
const HOLD_FRAMES = 45
const POSITION_EPSILON = 1e-3

interface KeyCandidate {
  key: string
  code: string
  ndc?: [number, number]
}

const SPECIAL_KEYS: Record<string, { key: string; code: string }> = {
  ' ': { key: ' ', code: 'Space' },
  space: { key: ' ', code: 'Space' },
  spacebar: { key: ' ', code: 'Space' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
  up: { key: 'ArrowUp', code: 'ArrowUp' },
  '↑': { key: 'ArrowUp', code: 'ArrowUp' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
  down: { key: 'ArrowDown', code: 'ArrowDown' },
  '↓': { key: 'ArrowDown', code: 'ArrowDown' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft' },
  '←': { key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  right: { key: 'ArrowRight', code: 'ArrowRight' },
  '→': { key: 'ArrowRight', code: 'ArrowRight' },
  shift: { key: 'Shift', code: 'ShiftLeft' },
  shiftleft: { key: 'Shift', code: 'ShiftLeft' },
  shiftright: { key: 'Shift', code: 'ShiftRight' },
  enter: { key: 'Enter', code: 'Enter' },
  return: { key: 'Enter', code: 'Enter' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  tab: { key: 'Tab', code: 'Tab' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  control: { key: 'Control', code: 'ControlLeft' },
  ctrl: { key: 'Control', code: 'ControlLeft' },
  controlleft: { key: 'Control', code: 'ControlLeft' },
  controlright: { key: 'Control', code: 'ControlRight' },
  alt: { key: 'Alt', code: 'AltLeft' },
  altleft: { key: 'Alt', code: 'AltLeft' },
  altright: { key: 'Alt', code: 'AltRight' },
}

export function resolveKeyCandidates(declaredKey: string): KeyCandidate[] {
  const raw = declaredKey.trim()
  if (!raw) return []

  const lower = raw.toLowerCase()
  if (lower === 'wasd') {
    return ['w', 'a', 's', 'd'].flatMap((ch) => resolveKeyCandidates(ch))
  }
  if (lower === 'arrows' || lower === 'arrow keys' || lower === 'arrowkeys') {
    return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].flatMap((k) => resolveKeyCandidates(k))
  }
  if (raw.includes('/') || raw.includes(',')) {
    return raw
      .split(/[\/,]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .flatMap((part) => resolveKeyCandidates(part))
  }
  if (/^(?:pointer|pointerdown|click|mouse|tap)$/i.test(raw)) {
    return [{ key: ' ', code: 'Space', ndc: [0, 0] }]
  }

  const special = SPECIAL_KEYS[lower]
  if (special) return [special]

  const keyCodeMatch = /^Key([A-Za-z])$/i.exec(raw)
  if (keyCodeMatch) {
    const letter = keyCodeMatch[1]
    return [
      { key: letter.toLowerCase(), code: `Key${letter.toUpperCase()}` },
      { key: letter.toUpperCase(), code: `Key${letter.toUpperCase()}` },
    ]
  }

  const digitCodeMatch = /^Digit([0-9])$/i.exec(raw)
  if (digitCodeMatch) {
    const digit = digitCodeMatch[1]
    return [{ key: digit, code: `Digit${digit}` }]
  }

  if (/^[A-Za-z]$/.test(raw)) {
    return [
      { key: raw.toLowerCase(), code: `Key${raw.toUpperCase()}` },
      { key: raw.toUpperCase(), code: `Key${raw.toUpperCase()}` },
    ]
  }

  if (/^[0-9]$/.test(raw)) {
    return [{ key: raw, code: `Digit${raw}` }]
  }

  return [{ key: raw, code: raw }]
}

type TrajectorySnapshot = Array<Map<string, [number, number, number]>>

function createDefaultGround(world: RAPIER.World): void {
  const groundBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.25, 0),
  )
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(60, 0.25, 60).setFriction(0.8).setRestitution(0.2),
    groundBody,
  )
}

function disposeSceneObjects(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
    else material?.dispose()
  })
}

function simulateHumanFrames(
  levelModule: GeneratedLevelModule,
  totalFrames: number,
  candidate?: KeyCandidate,
  holdFrames = HOLD_FRAMES,
): { trajectory: TrajectorySnapshot; controls: ControlBinding[] } {
  const scene = new THREE.Scene()
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.timestep = FIXED_STEP
  const eventQueue = new RAPIER.EventQueue(true)
  const namedBodies = new Map<string, RAPIER.RigidBody>()
  let handle: ReturnType<GeneratedLevelModule['buildWorld']> | null = null

  try {
    handle = levelModule.buildWorld(scene, world, namedBodies, eventQueue)
    createDefaultGround(world)
    const controls = Array.isArray(handle.controls) ? handle.controls : []
    const trajectory: TrajectorySnapshot = []

    if (candidate) {
      if (candidate.ndc) {
        handle.onPointerOrKey?.({ type: 'pointerdown', ndc: candidate.ndc })
      } else {
        handle.onPointerOrKey?.({ type: 'keydown', key: candidate.key, code: candidate.code })
      }
    }

    for (let frame = 1; frame <= totalFrames; frame++) {
      if (candidate && frame === holdFrames + 1) {
        if (candidate.ndc) {
          handle.onPointerOrKey?.({ type: 'pointerup', ndc: candidate.ndc })
        } else {
          handle.onPointerOrKey?.({ type: 'keyup', key: candidate.key, code: candidate.code })
        }
      }
      handle.stepHumanAndRules(frame, frame * FIXED_STEP)
      world.step(eventQueue)
      const framePositions = new Map<string, [number, number, number]>()
      namedBodies.forEach((body, name) => {
        const p = body.translation()
        framePositions.set(name, [p.x, p.y, p.z])
      })
      trajectory.push(framePositions)
    }

    return { trajectory, controls }
  } finally {
    try {
      handle?.dispose()
    } catch {
      // Ignore cleanup errors in throwaway check world
    }
    disposeSceneObjects(scene)
    eventQueue.free()
    world.free()
  }
}

function trajectoriesDiffer(baseline: TrajectorySnapshot, tested: TrajectorySnapshot): boolean {
  const frames = Math.min(baseline.length, tested.length)
  for (let i = 0; i < frames; i++) {
    const baseMap = baseline[i]
    const testMap = tested[i]
    if (baseMap.size !== testMap.size) return true
    for (const [name, basePos] of baseMap) {
      const testPos = testMap.get(name)
      if (!testPos) return true
      const dist = Math.hypot(
        basePos[0] - testPos[0],
        basePos[1] - testPos[1],
        basePos[2] - testPos[2],
      )
      if (dist > POSITION_EPSILON) return true
    }
  }
  return false
}

/**
 * Builds the level module in a throwaway THREE.Scene and RAPIER.World, steps stepHumanAndRules
 * for 90 frames with no input as a baseline, then tests each declared control binding by holding
 * keydown (with both key and code) for 45 frames before keyup. Returns any bindings that did not
 * change named-body positions compared to the baseline.
 */
export function checkDeclaredControls(
  levelModule: GeneratedLevelModule,
  options?: { baselineFrames?: number; holdFrames?: number },
): ControlBinding[] {
  const baselineFrames = options?.baselineFrames ?? BASELINE_FRAMES
  const holdFrames = options?.holdFrames ?? HOLD_FRAMES

  const { trajectory: baseline, controls } = simulateHumanFrames(levelModule, baselineFrames)
  if (controls.length === 0) return []

  const deadBindings: ControlBinding[] = []
  for (const binding of controls) {
    const candidates = resolveKeyCandidates(binding.key)
    if (candidates.length === 0) {
      deadBindings.push(binding)
      continue
    }
    let moved = false
    for (const candidate of candidates) {
      const { trajectory } = simulateHumanFrames(levelModule, baselineFrames, candidate, holdFrames)
      if (trajectoriesDiffer(baseline, trajectory)) {
        moved = true
        break
      }
    }
    if (!moved) {
      deadBindings.push(binding)
    }
  }

  return deadBindings
}
