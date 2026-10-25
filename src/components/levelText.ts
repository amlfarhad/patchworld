import type { LevelGoal } from '../engine/types'

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  space: 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  enter: 'Enter',
  escape: 'Esc',
  esc: 'Esc',
  shift: 'Shift',
  shiftleft: 'Shift',
  shiftright: 'Shift',
  control: 'Ctrl',
  controlleft: 'Ctrl',
  controlright: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  altleft: 'Alt',
  altright: 'Alt',
  tab: 'Tab',
  backspace: 'Backspace',
  pointer: 'Click',
  pointerdown: 'Click',
  click: 'Click',
  mouse: 'Click',
}

/** How a level's declared key reads on a keycap: "Space", "←", "W", "Shift". */
export function keyLabel(key: string): string {
  const trimmed = key.trim()
  if (trimmed.includes('/')) {
    return trimmed
      .split('/')
      .map((part) => keyLabel(part))
      .filter((label, index, list) => list.indexOf(label) === index)
      .join(' / ')
  }
  const named = KEY_NAMES[trimmed.toLowerCase()]
  if (named) return named
  const code = /^(?:Key|Digit)(.)$/i.exec(trimmed)
  if (code) return code[1].toUpperCase()
  return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed
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
