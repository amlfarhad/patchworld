import type { LevelGoal } from '../engine/types'

const KEY_NAMES: Record<string, string> = { ' ': 'Space', space: 'Space', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', enter: 'Enter', escape: 'Esc', shift: 'Shift', pointer: 'Click', pointerdown: 'Click', click: 'Click', mouse: 'Click' }

/** How a level's declared key reads on a keycap: "Space", "←", "A". */
export function keyLabel(key: string): string {
  const named = KEY_NAMES[key.toLowerCase()]
  if (named) return named
  const code = /^(?:Key|Digit)(.)$/.exec(key)
  if (code) return code[1]
  return key.length === 1 ? key.toUpperCase() : key
}

/** A level's declared goal as one sentence for players. */
export function describeGoal(goal: LevelGoal): string {
  switch (goal.type) {
    case 'below-y': return `Get the ${goal.body} below height ${goal.y}`
    case 'above-y': return `Get the ${goal.body} above height ${goal.y}`
    case 'in-region': return `Get the ${goal.body} into the target zone`
    case 'near-point': return `Get the ${goal.body} within ${goal.radius} m of the target`
  }
}
