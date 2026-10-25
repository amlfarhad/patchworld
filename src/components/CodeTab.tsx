import { useMemo, useState } from 'react'
import { FileCode2, FileDiff } from 'lucide-react'
import type { CodeIteration } from '../hooks/useSandbox'
import { iterationLabel, pickCode, type CodePick } from './codePick'
import { diffLines, diffStats, toHunks, type DiffLine } from './lineDiff'

function CodeLine({ line, fileView }: { line: DiffLine; fileView: boolean }) {
  return <div className={`code-line code-${line.kind}`}>
    {!fileView && <span className="code-no">{line.oldNo ?? ''}</span>}
    <span className="code-no">{line.newNo ?? ''}</span>
    <span className="code-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
    <span className="code-text">{line.text}</span>
  </div>
}

export function CodeTab({ code, pick, onPick }: { code: CodeIteration[]; pick: CodePick; onPick: (pick: CodePick) => void }) {
  const [view, setView] = useState<'diff' | 'file'>('diff')
  const { entry, file } = pickCode(code, pick)
  const diffs = useMemo(() => new Map(entry?.changes.map((c) => [c.path, diffLines(c.before, c.after)])), [entry])
  if (!entry || !file) return <div className="drawer-empty"><FileDiff size={25} strokeWidth={1} /><p>No code yet.</p><span>The files each iteration writes, and what changed from the last one, appear here once a patch lands.</span></div>
  const lines = diffs.get(file.path) ?? []
  const rows = view === 'diff' ? toHunks(lines) : lines.filter((line) => line.kind !== 'del')
  return <div className="code-tab">
    <div className="code-toolbar">
      <div className="code-pills" role="group" aria-label="Iteration">{code.map((it, i) => <button key={i} type="button" className="code-pill" aria-pressed={it === entry} onClick={() => onPick({ index: i === code.length - 1 ? null : i, path: pick.path })}>{iterationLabel(it)}</button>)}</div>
      <div className="code-files" role="group" aria-label="Files in this patch">{entry.changes.map((c) => {
        const stats = diffStats(diffs.get(c.path) ?? [])
        return <button key={c.path} type="button" className="code-file" aria-pressed={c === file} onClick={() => onPick({ index: pick.index, path: c.path })} title={c.path}>
          <FileCode2 size={11} /><span className="code-file-name">{c.path.split('/').at(-1)}</span>{c.before === null && <i className="code-new">NEW</i>}<span className="stat-add">+{stats.added}</span><span className="stat-del">−{stats.removed}</span>
        </button>
      })}</div>
      <div className="code-view-toggle" role="group" aria-label="View">
        <button type="button" aria-pressed={view === 'diff'} onClick={() => setView('diff')}>Diff</button>
        <button type="button" aria-pressed={view === 'file'} onClick={() => setView('file')}>Full file</button>
      </div>
    </div>
    {rows.length ? <div className={`code-view ${view === 'file' ? 'file-view' : ''}`} aria-label={`${view === 'diff' ? 'Changes to' : 'Contents of'} ${file.path}`}><div className="code-lines">
      {rows.map((row, i) => 'skipped' in row ? <div key={i} className="code-skip">⋯ {row.skipped} unchanged {row.skipped === 1 ? 'line' : 'lines'}</div> : <CodeLine key={i} line={row} fileView={view === 'file'} />)}
    </div></div> : <p className="code-unchanged">{view === 'diff' ? 'This patch rewrote the file without changing it.' : 'This file is empty.'}</p>}
  </div>
}
