import type * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'

export interface ControlBinding {
  key: string
  action: string
}

export type LevelGoal =
  | {
      type: 'below-y'
      body: string
      y: number
    }
  | {
      type: 'above-y'
      body: string
      y: number
    }
  | {
      type: 'in-region'
      body: string
      min: [number, number, number]
      max: [number, number, number]
    }
  | {
      type: 'near-point'
      body: string
      target: [number, number, number]
      radius: number
    }

export interface MountedLevel {
  dispose: () => void
  stepBotAndRules: (frameIndex: number, elapsedSeconds: number) => StepResult
  /** Required human-mode update; must not apply autonomous bot actions. */
  stepHumanAndRules: (frameIndex: number, elapsedSeconds: number) => StepResult
  controls: ControlBinding[]
  goal: LevelGoal
  onPointerOrKey?: (event: { type: string; key?: string; ndc?: [number, number] }) => void
}

export interface StepResult {
  botState: string
  goalReached: boolean
  failedEarly?: string
}

export interface GeneratedLevelModule {
  buildWorld: (
    scene: THREE.Scene,
    world: RAPIER.World,
    namedBodies: Map<string, RAPIER.RigidBody>,
    eventQueue: RAPIER.EventQueue,
  ) => MountedLevel
}

export interface ContactSnapshot {
  bodyA: string
  bodyB: string
  totalForce: number
}
