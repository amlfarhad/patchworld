import { useEffect, useMemo, useRef, useState } from 'react'
import { Braces, Check, Copy, FileCode2, GitCompareArrows, History, Play, Terminal, X } from 'lucide-react'
import { selectReplay, type PatchRecord, type SandboxState } from '../hooks/useSandbox'
import { collapseDiff, lineDiff } from '../lib/lineDiff'

type Tab = 'terminal' | 'code' | 'history' | 'skill'

function CodeDiff({ patch }: { patch: PatchRecord }) {
  const files = useMemo(() => patch.changes.map((change) => {
    const lines = lineDiff(change.before ?? '', change.after)
    return {
      path: change.path,
      added: lines.filter((line) => line.kind === 'added').length,
      removed: lines.filter((line) => line.kind === 'removed').length,
      rows: change.before === null ? lines.map((line) => line) : collapseDiff(lines),
    }
  }), [patch])
  return <div className="diff-view">{files.map((file) => <section key={file.path} className="diff-file">
    <header className="diff-file-head"><span>{file.path.replace('src/generated/', '')}</span><span className="diff-stat"><b className="diff-plus">+{file.added}</b> <b className="diff-minus">−{file.removed}</b></span></header>
    <pre className="diff-body">{file.rows.map((row, index) => row.kind === 'skip'
      ? <div key={index} className="diff-row diff-skip">⋯ {row.count} unchanged lines</div>
      : <div key={index} className={`diff-row diff-${row.kind}`}><span className="diff-no">{row.newNo ?? row.oldNo}</span><span className="diff-sign">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span>{row.text}</div>)}</pre>
  </section>)}</div>
}

const outcomeLabel: Record<string, string> = { pending: 'Running', passed: 'Passed', failed: 'Failed', 'mount-failed': 'Crashed', abandoned: 'Stopped' }

export function AgentDrawer({ open, onClose, state }: { open: boolean; onClose: () => void; state: SandboxState }) {
  const [tab, setTab] = useState<Tab>('terminal')
  const [patchStamp, setPatchStamp] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const selectedIndex = Math.max(0, state.patches.findIndex((record) => record.timestamp === patchStamp))
  const patchIndex = patchStamp && state.patches.some((record) => record.timestamp === patchStamp) ? selectedIndex : state.patches.length - 1
  const patch = state.patches[patchIndex]
  useEffect(() => { if (open) closeRef.current?.focus() }, [open])
  useEffect(() => { const el = scrollRef.current; if (el && open && tab === 'terminal') el.scrollTop = el.scrollHeight }, [state.logs, open, tab])
  useEffect(() => { if (!open) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [open, onClose])
  useEffect(() => { if (!copied) return; const id = window.setTimeout(() => setCopied(false), 1800); return () => clearTimeout(id) }, [copied])
  const copyText = () => {
    if (tab === 'skill') return state.skillContent
    if (tab === 'code') return patch?.changes.map((change) => `// ${change.path}\n${change.after}`).join('\n\n') ?? ''
    if (tab === 'history') return state.history.map((entry) => `#${entry.iteration} ${entry.outcome}${entry.failureReason ? `: ${entry.failureReason}` : ''}${entry.diagnosis ? `\n  ${entry.diagnosis}` : ''}`).join('\n')
    return state.logs.map((log) => `${log.timestamp} ${log.message}`).join('\n')
  }
  const copy = async () => { try { await navigator.clipboard.writeText(copyText()); setCopied(true) } catch { setCopied(false) } }
  const tabs: Array<{ id: Tab; label: string; icon: typeof Terminal; badge?: string | number | null }> = [
    { id: 'terminal', label: 'Log', icon: Terminal, badge: state.logs.length },
    { id: 'code', label: 'Code', icon: GitCompareArrows, badge: state.patches.length || null },
    { id: 'history', label: 'History', icon: History, badge: state.history.length || null },
    { id: 'skill', label: 'Lessons', icon: FileCode2 },
  ]
  const path = tab === 'terminal' ? 'ORCHESTRATOR / LIVE EVENT STREAM' : tab === 'code' ? patch ? `ITERATION ${patch.iteration} / WHAT CHANGED` : 'GENERATED LEVEL' : tab === 'history' ? 'EVERY ATTEMPT AT THIS GOAL' : '.agents/SKILL.md'
  const pathNote = tab === 'skill' ? (state.skillUpdated ? 'UPDATED ' + new Date(state.skillUpdated).toLocaleTimeString([], { hour12: false }) : 'AWAITING LEARNING') : tab === 'code' && state.patches.length > 1 ? `${patchIndex + 1} OF ${state.patches.length}` : 'READ ONLY'
  return <aside className={`agent-drawer glass-panel ${open ? 'drawer-open' : ''}`} aria-label="Workshop" inert={!open} aria-hidden={!open}>
    <div className="drawer-heading"><div className="flex items-center gap-3"><div className="drawer-icon"><Braces size={18} /></div><div><h2>The workshop</h2><p className="micro-label">A PEEK BEHIND THE PIXELS</p></div></div><button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close workshop"><X size={17} /></button></div>
    <div className="drawer-tabs" role="tablist" aria-label="Workshop views">{tabs.map(({ id, label, icon: Icon, badge }) => <button key={id} role="tab" aria-selected={tab === id} aria-controls="agent-content" className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}><Icon size={13} />{label}{badge ? <span>{badge}</span> : null}{id === 'skill' && state.skillContent && <span className="skill-dot" />}</button>)}<button className="icon-button ml-auto" aria-label="Copy current panel" onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
    <div className="drawer-path micro-label">{path}<span>{pathNote}</span></div>
    {tab === 'code' && state.patches.length > 1 && <div className="patch-picker">{state.patches.map((record, index) => <button key={record.timestamp} className={index === patchIndex ? 'selected' : ''} onClick={() => setPatchStamp(index === state.patches.length - 1 ? null : record.timestamp)}>#{record.iteration}</button>)}</div>}
    <div ref={scrollRef} id="agent-content" className="drawer-content" role="tabpanel" tabIndex={0}>
      {tab === 'terminal' && (state.logs.length ? state.logs.map((entry) => <div key={entry.id} className={`terminal-line terminal-${entry.kind}`}><time>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</time><span className="terminal-prompt">{entry.kind === 'terminal' ? '$' : '›'}</span><pre>{entry.message}</pre></div>) : <div className="drawer-empty"><Terminal size={25} strokeWidth={1} /><p>Nothing has happened yet.</p><span>Start a world to follow generation, playtests and critiques as they happen.</span></div>)}
      {tab === 'code' && (patch ? <CodeDiff patch={patch} /> : <div className="drawer-empty"><GitCompareArrows size={25} strokeWidth={1} /><p>No code yet.</p><span>Each generated level and every patch the critic makes will show up here as a diff.</span></div>)}
      {tab === 'history' && (state.history.length ? <ol className="history-list">{state.history.map((entry) => {
        const replay = state.replays.find((r) => r.runId === entry.runId)
        return <li key={`${entry.iteration}-${entry.timestamp}`} className={`history-row outcome-${entry.outcome}`}>
          <div className="history-head"><span className="history-iter">#{entry.iteration}</span><span className="history-outcome">{outcomeLabel[entry.outcome] ?? entry.outcome}</span>{replay && <button className="history-play" onClick={() => selectReplay(replay.runId)} aria-label={`Show the replay of attempt ${entry.iteration}`}><Play size={11} />Replay</button>}</div>
          {entry.diagnosis && <p className="history-diagnosis">{entry.diagnosis}</p>}
          {entry.failureReason && <p className="history-reason">{entry.failureReason}</p>}
        </li>
      })}</ol> : <div className="drawer-empty"><History size={25} strokeWidth={1} /><p>No attempts yet.</p><span>Every attempt, with its replay and the critique that led to it, is listed here.</span></div>)}
      {tab === 'skill' && (state.skillContent ? <pre className="skill-document">{state.skillContent}</pre> : <div className="drawer-empty"><FileCode2 size={25} strokeWidth={1} /><p>No lessons yet.</p><span>Physical rules the critic learns from failed runs appear here and feed into the next world.</span></div>)}
    </div>
    <div className="drawer-footer micro-label"><span className="tiny-square" />{state.connected ? 'CONNECTED TO LOCAL ORCHESTRATOR' : 'WAITING FOR CONNECTION'}<span className="ml-auto">{state.mock ? 'MOCK REPLAY' : 'LIVE LAB'}</span></div>
  </aside>
}
