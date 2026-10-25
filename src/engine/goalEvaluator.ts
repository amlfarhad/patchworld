import type { LevelGoal } from './types'

export interface PositionLike {
  x: number
  y: number
  z: number
}

export interface TranslatableBody {
  translation: () => PositionLike
}

export function evaluateLevelGoal(
  goal: LevelGoal | null | undefined,
  namedBodies: ReadonlyMap<string, TranslatableBody>,
): boolean {
  if (!goal) return false
  const body = namedBodies.get(goal.body)
  if (!body) return false
  const pos = body.translation()

  switch (goal.type) {
    case 'below-y':
      return pos.y < goal.y
    case 'above-y':
      return pos.y > goal.y
    case 'in-region': {
      const [minX, minY, minZ] = goal.min
      const [maxX, maxY, maxZ] = goal.max
      const loX = Math.min(minX, maxX)
      const hiX = Math.max(minX, maxX)
      const loY = Math.min(minY, maxY)
      const hiY = Math.max(minY, maxY)
      const loZ = Math.min(minZ, maxZ)
      const hiZ = Math.max(minZ, maxZ)
      return (
        pos.x >= loX &&
        pos.x <= hiX &&
        pos.y >= loY &&
        pos.y <= hiY &&
        pos.z >= loZ &&
        pos.z <= hiZ
      )
    }
    case 'near-point': {
      const [tx, ty, tz] = goal.target
      const dist = Math.hypot(pos.x - tx, pos.y - ty, pos.z - tz)
      return dist <= goal.radius
    }
    default:
      return false
  }
}
