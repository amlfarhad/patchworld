import type * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import type { ControlBinding, LevelGoal, MountedLevel } from '../engine/types'
import { buildScene } from './scene'
import { buildMechanics } from './mechanics'

export const controls: ControlBinding[] = [
  { key: 'KeyA', action: 'Move knight left' },
  { key: 'KeyD', action: 'Move knight right' },
  { key: 'KeyW', action: 'Leap / Strafe north' },
  { key: 'KeyS', action: 'Slam / Strafe south' },
  { key: 'ArrowLeft', action: 'Move knight left' },
  { key: 'ArrowRight', action: 'Move knight right' },
  { key: 'ArrowUp', action: 'Leap / Strafe north' },
  { key: 'ArrowDown', action: 'Slam / Strafe south' },
  { key: 'Space', action: 'High-impulse jump' },
  { key: 'ShiftLeft', action: 'Overcharge cyber-dash' },
  { key: 'KeyF', action: 'Fire twin-ordnance siege barrage' },
  { key: 'KeyE', action: 'Radial gravity shockwave' },
]

export const goal: LevelGoal = {
  type: 'below-y',
  body: 'targetBlock',
  y: 1.6,
}

function isGoalReached(namedBodies: Map<string, RAPIER.RigidBody>): boolean {
  const target = namedBodies.get('targetBlock')
  if (!target) return false
  return target.translation().y < 1.6
}

export function buildWorld(
  scene: THREE.Scene,
  world: RAPIER.World,
  namedBodies: Map<string, RAPIER.RigidBody>,
  eventQueue: RAPIER.EventQueue,
): MountedLevel {
  const sceneHandle = buildScene(scene, world, namedBodies)
  const mechanics = buildMechanics(scene, world, namedBodies, eventQueue)

  return {
    controls,
    goal,
    onPointerOrKey(event) {
      mechanics.onPointerOrKey(event)
    },
    stepBotAndRules(frameIndex: number, elapsedSeconds: number) {
      sceneHandle.stepScene(elapsedSeconds)
      const res = mechanics.stepBot(frameIndex, elapsedSeconds)
      return {
        botState: res.botState,
        goalReached: isGoalReached(namedBodies),
        failedEarly: res.failedEarly,
      }
    },
    stepHumanAndRules(frameIndex: number, elapsedSeconds: number) {
      sceneHandle.stepScene(elapsedSeconds)
      const res = mechanics.stepHuman(frameIndex, elapsedSeconds)
      return {
        botState: res.botState,
        goalReached: isGoalReached(namedBodies),
        failedEarly: res.failedEarly,
      }
    },
    dispose() {
      mechanics.dispose()
      sceneHandle.dispose()
    },
  }
}
