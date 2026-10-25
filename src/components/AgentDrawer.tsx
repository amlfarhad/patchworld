import { useEffect, useRef, useState } from 'react'
import { Braces, Check, Copy, FileCode2, FileDiff, Terminal, X } from 'lucide-react'
import type { SandboxState } from '../hooks/useSandbox'
import { CodeTab } from './CodeTab'
import { iterationLabel, pickCode, type CodePick } from './codePick'

export function AgentDrawer({ open, onClose, state }: { open: boolean; onClose: () => void; state: SandboxState }) {
  const [tab, setTab] = useState<'terminal' | 'code' | 'skill'>('terminal')
  const [codePick, setCodePick] = useState<CodePick>({ index: null, path: null })
  const [copied, setCopied] = useState(false)
  const { entry: codeEntry, file: codeFile } = pickCode(state.code, codePick)
  const scrollRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) closeRef.current?.focus() }, [open])
  useEffect(() => { const el = scrollRef.current; if (el && open && tab === 'terminal') el.scrollTop = el.scrollHeight }, [state.logs, open, tab])
  useEffect(() => { const el = scrollRef.current; if (el && tab === 'code') el.scrollTop = 0 }, [tab, codeFile])
  useEffect(() => { if (!open) return; const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) }, [open, onClose])
  useEffect(() => { if (!copied) return; const id = window.setTimeout(() => setCopied(false), 1800); return () => clearTimeout(id) }, [copied])
  const copy = async () => { try { await navigator.clipboard.writeText(tab === 'skill' ? state.skillContent : tab === 'code' ? codeFile?.after ?? '' : state.logs.map((log) => `${log.timestamp} ${log.message}`).join('\n')); setCopied(true) } catch { setCopied(false) } }
  return <aside className={`agent-drawer glass-panel ${open ? 'drawer-open' : ''}`} aria-label="Agent brain" inert={!open} aria-hidden={!open}>
    <div className="drawer-heading"><div className="flex items-center gap-3"><div className="drawer-icon"><Braces size={18} /></div><div><h2>The workshop</h2><p className="micro-label">A PEEK BEHIND THE PIXELS</p></div></div><button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close agent brain"><X size={17} /></button></div>
    <div className="drawer-tabs" role="tablist" aria-label="Agent inspection"><button role="tab" aria-selected={tab === 'terminal'} aria-controls="agent-content" className={tab === 'terminal' ? 'selected' : ''} onClick={() => setTab('terminal')}><Terminal size={13} />Terminal<span>{state.logs.length}</span></button><button role="tab" aria-selected={tab === 'code'} aria-controls="agent-content" className={tab === 'code' ? 'selected' : ''} onClick={() => setTab('code')}><FileDiff size={13} />Code<span>{state.code.length}</span></button><button role="tab" aria-selected={tab === 'skill'} aria-controls="agent-content" className={tab === 'skill' ? 'selected' : ''} onClick={() => setTab('skill')}><FileCode2 size={13} />SKILL.md{state.skillContent && <span className="skill-dot" />}</button><button className="icon-button ml-auto" aria-label="Copy current panel" onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button></div>
    <div className="drawer-path micro-label">{tab === 'terminal' ? 'MANAGED AGENT / LIVE EVENT STREAM' : tab === 'code' ? codeFile?.path ?? 'src/generated/' : '.agents/SKILL.md'}<span>{tab === 'terminal' ? 'READ ONLY' : tab === 'code' ? codeEntry ? `${iterationLabel(codeEntry)} · ${new Date(codeEntry.timestamp).toLocaleTimeString([], { hour12: false })}` : 'AWAITING FIRST PATCH' : state.skillUpdated ? 'UPDATED ' + new Date(state.skillUpdated).toLocaleTimeString([], { hour12: false }) : 'AWAITING LEARNING'}</span></div>
    <div ref={scrollRef} id="agent-content" className="drawer-content" role="tabpanel" tabIndex={0}>
      {tab === 'code' ? <CodeTab code={state.code} pick={codePick} onPick={setCodePick} /> : tab === 'terminal' ? state.logs.length ? state.logs.map((entry) => <div key={entry.id} className={`terminal-line terminal-${entry.kind}`}><time>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</time><span className="terminal-prompt">{entry.kind === 'terminal' ? '$' : '›'}</span><pre>{entry.message}</pre></div>) : <div className="drawer-empty"><Terminal size={25} strokeWidth={1} /><p>The agent is standing by.</p><span>Start a world to inspect orchestration events and sandbox tool output as it arrives.</span></div> : state.skillContent ? <pre className="skill-document">{state.skillContent}</pre> : <div className="drawer-empty"><FileCode2 size={25} strokeWidth={1} /><p>No learned invariants yet.</p><span>When the managed agent publishes SKILL.md, its actual contents will appear here.</span></div>}
    </div>
    <div className="drawer-footer micro-label"><span className="tiny-square" />{state.connected ? 'CONNECTED TO LOCAL ORCHESTRATOR' : 'WAITING FOR CONNECTION'}<span className="ml-auto">LIVE LAB</span></div>
  </aside>
}
