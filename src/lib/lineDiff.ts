export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string; oldNo?: number; newNo?: number }

/** Line diff via longest common subsequence. Fine for generated levels (a few hundred lines). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 4_000_000) {
    return [...a.map((text, i) => ({ kind: 'removed' as const, text, oldNo: i + 1 })), ...b.map((text, i) => ({ kind: 'added' as const, text, newNo: i + 1 }))]
  }
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 }); i++; j++ }
    else if (table[i + 1][j] >= table[i][j + 1]) { lines.push({ kind: 'removed', text: a[i], oldNo: i + 1 }); i++ }
    else { lines.push({ kind: 'added', text: b[j], newNo: j + 1 }); j++ }
  }
  while (i < a.length) { lines.push({ kind: 'removed', text: a[i], oldNo: i + 1 }); i++ }
  while (j < b.length) { lines.push({ kind: 'added', text: b[j], newNo: j + 1 }); j++ }
  return lines
}

/** Keeps changed lines plus `context` lines around them; long unchanged runs collapse to one marker. */
export function collapseDiff(lines: DiffLine[], context = 3): Array<DiffLine | { kind: 'skip'; count: number }> {
  const keep = lines.map(() => false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true
  })
  const out: Array<DiffLine | { kind: 'skip'; count: number }> = []
  let skipped = 0
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) out.push({ kind: 'skip', count: skipped })
      skipped = 0
      out.push(line)
    } else skipped++
  })
  if (skipped) out.push({ kind: 'skip', count: skipped })
  return out
}
