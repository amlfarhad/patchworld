import type { CodeIteration } from '../hooks/useSandbox'

/** Which patch and file the Code tab shows. `index: null` follows the latest patch. */
export interface CodePick { index: number | null; path: string | null }

const pad = (n: number) => String(n).padStart(2, '0')
export const iterationLabel = (entry: CodeIteration) => (entry.iteration <= 1 ? 'DRAFT 1' : `ITER ${pad(entry.iteration)}`)

export function pickCode(code: CodeIteration[], pick: CodePick) {
  const entry = code[pick.index ?? code.length - 1] ?? code.at(-1)
  const file = entry && (entry.changes.find((c) => c.path === pick.path) ?? entry.changes.find((c) => c.path.endsWith('/activeLevel.ts')) ?? entry.changes[0])
  return { entry, file }
}
