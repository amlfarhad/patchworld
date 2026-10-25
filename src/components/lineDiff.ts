export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }
export type DiffRow = DiffLine | { skipped: number }

// Above this many LCS cells (about 2000 x 2000 changed lines) a rewrite is shown as delete-all/add-all instead.
const MAX_CELLS = 4_000_000

const splitLines = (text: string) => (text === '' ? [] : text.split('\n'))

/** Line diff of two file versions: trims the shared prefix and suffix, then runs an LCS on the rest. */
export function diffLines(before: string | null, after: string): DiffLine[] {
  const a = splitLines(before ?? ''), b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }

  const lines: DiffLine[] = []
  let oldNo = 1, newNo = 1
  const same = (text: string) => lines.push({ kind: 'same', text, oldNo: oldNo++, newNo: newNo++ })
  const del = (text: string) => lines.push({ kind: 'del', text, oldNo: oldNo++ })
  const add = (text: string) => lines.push({ kind: 'add', text, newNo: newNo++ })

  for (let i = 0; i < start; i++) same(a[i])
  const n = endA - start, m = endB - start
  if (n * m > MAX_CELLS) {
    for (let i = start; i < endA; i++) del(a[i])
    for (let j = start; j < endB; j++) add(b[j])
  } else {
    // lcs[i * (m + 1) + j] = LCS length of a[start + i..endA) and b[start + j..endB).
    const lcs = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1])
      }
    }
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { same(a[start + i]); i++; j++ }
      else if (j >= m || (i < n && lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1])) { del(a[start + i]); i++ }
      else { add(b[start + j]); j++ }
    }
  }
  for (let i = endA; i < a.length; i++) same(a[i])
  return lines
}

/** Keeps `context` unchanged lines around each change and folds unchanged runs longer than `context` into one skipped row. */
export function toHunks(lines: DiffLine[], context = 3): DiffRow[] {
  if (!lines.some((line) => line.kind !== 'same')) return []
  const keep = new Uint8Array(lines.length)
  lines.forEach((line, i) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = 1
  })
  const rows: DiffRow[] = []
  let runStart = -1
  const flush = (end: number) => {
    // A fold row is only worth it when it hides more lines than it costs.
    if (end - runStart > context) rows.push({ skipped: end - runStart })
    else rows.push(...lines.slice(runStart, end))
    runStart = -1
  }
  lines.forEach((line, i) => {
    if (keep[i]) { if (runStart >= 0) flush(i); rows.push(line) }
    else if (runStart < 0) runStart = i
  })
  if (runStart >= 0) flush(lines.length)
  return rows
}

export function diffStats(lines: DiffLine[]) {
  let added = 0, removed = 0
  for (const line of lines) { if (line.kind === 'add') added++; else if (line.kind === 'del') removed++ }
  return { added, removed }
}
