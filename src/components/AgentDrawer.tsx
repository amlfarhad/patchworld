import { useEffect, useRef, useState } from 'react'
import { Braces, Check, Copy, Cpu, FileCode2, FileDiff, Layers, Terminal, X } from 'lucide-react'
import type { SandboxState } from '../hooks/useSandbox'
import { CodeTab } from './CodeTab'
import { iterationLabel, pickCode, type CodePick } from './codePick'

export function AgentDrawer({ open, onClose, state }: { open: boolean; onClose: () => void; state: SandboxState }) {
  const [tab, setTab] = useState<'terminal' | 'code' | 'context' | 'skill'>('context')
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

  const ctx = state.contextTelemetry
  const stats = state.engineStats
  const contextPercent = Math.min(100, Math.max(2, (ctx.contextTokensEstimate / ctx.maxContextTokens) * 100))

  const copy = async () => {
    try {
      const payload =
        tab === 'skill'
          ? state.skillContent
          : tab === 'code'
            ? codeFile?.after ?? ''
            : tab === 'context'
              ? JSON.stringify({ contextTelemetry: ctx, engineStats: stats }, null, 2)
              : state.logs.map((log) => `${log.timestamp} ${log.message}`).join('\n')
      await navigator.clipboard.writeText(payload)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return <aside className={`agent-drawer glass-panel ${open ? 'drawer-open' : ''}`} aria-label="Agent brain" inert={!open} aria-hidden={!open}>
    <div className="drawer-heading"><div className="flex items-center gap-3"><div className="drawer-icon"><Braces size={18} /></div><div><h2>The workshop</h2><p className="micro-label">1M CONTEXT · MULTI-MODULE ENGINE · RAPIER 3D</p></div></div><button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close agent brain"><X size={17} /></button></div>
    <div className="drawer-tabs" role="tablist" aria-label="Agent inspection">
      <button role="tab" aria-selected={tab === 'context'} aria-controls="agent-content" className={tab === 'context' ? 'selected' : ''} onClick={() => setTab('context')}><Cpu size={13} />1M Context<span>{(ctx.contextTokensEstimate / 1000).toFixed(1)}k</span></button>
      <button role="tab" aria-selected={tab === 'code'} aria-controls="agent-content" className={tab === 'code' ? 'selected' : ''} onClick={() => setTab('code')}><FileDiff size={13} />Code<span>{state.code.length}</span></button>
      <button role="tab" aria-selected={tab === 'terminal'} aria-controls="agent-content" className={tab === 'terminal' ? 'selected' : ''} onClick={() => setTab('terminal')}><Terminal size={13} />Events<span>{state.logs.length}</span></button>
      <button role="tab" aria-selected={tab === 'skill'} aria-controls="agent-content" className={tab === 'skill' ? 'selected' : ''} onClick={() => setTab('skill')}><FileCode2 size={13} />SKILL.md{state.skillContent && <span className="skill-dot" />}</button>
      <button className="icon-button ml-auto" aria-label="Copy current panel" onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
    </div>
    <div className="drawer-path micro-label">
      {tab === 'context'
        ? 'GEMINI-4-ARGON · 1,048,576 TOKEN CONTEXT WINDOW'
        : tab === 'terminal'
          ? 'MANAGED AGENT / LIVE EVENT STREAM'
          : tab === 'code'
            ? codeFile?.path ?? 'src/generated/'
            : '.agents/SKILL.md'}
      <span>
        {tab === 'context'
          ? `THINKING: ${ctx.thinkingLevel.toUpperCase()} · MAX OUT ${(ctx.maxOutputTokens / 1024).toFixed(0)}K`
          : tab === 'terminal'
            ? 'READ ONLY'
            : tab === 'code'
              ? codeEntry
                ? `${iterationLabel(codeEntry)} · ${new Date(codeEntry.timestamp).toLocaleTimeString([], { hour12: false })}`
                : 'ACTIVE MODULES'
              : state.skillUpdated
                ? 'UPDATED ' + new Date(state.skillUpdated).toLocaleTimeString([], { hour12: false })
                : 'ACTIVE INVARIANTS'}
      </span>
    </div>
    <div ref={scrollRef} id="agent-content" className="drawer-content" role="tabpanel" tabIndex={0}>
      {tab === 'context' ? (
        <div className="context-panel">
          <div className="context-card">
            <div className="context-card-head">
              <span className="micro-label">1M CONTEXT WINDOW PACKING</span>
              <span className="context-Readout">{ctx.contextTokensEstimate.toLocaleString()} / {ctx.maxContextTokens.toLocaleString()} TOKENS</span>
            </div>
            <div className="context-bar">
              <i style={{ width: `${contextPercent}%` }} />
            </div>
            <div className="context-pack-list">
              {ctx.packedFiles.map((file) => (
                <span key={file} className="context-chip">
                  <Layers size={10} />
                  {file}
                </span>
              ))}
            </div>
          </div>

          <div className="context-card">
            <div className="context-card-head">
              <span className="micro-label">REAL-TIME RAPIER 3D & WEBGL TELEMETRY</span>
              <span className="context-Readout">{stats.fps} FPS · {stats.stepMs.toFixed(2)} MS/STEP</span>
            </div>
            <div className="telemetry-grid">
              <div><small>RIGID BODIES</small><b>{stats.bodies}</b></div>
              <div><small>COLLIDERS</small><b>{stats.colliders}</b></div>
              <div><small>TRIANGLES</small><b>{stats.triangles.toLocaleString()}</b></div>
              <div><small>DRAW CALLS</small><b>{stats.drawCalls}</b></div>
              <div><small>PEAK FORCE</small><b>{stats.peakForce.toFixed(1)} N</b></div>
              <div><small>MAX OUTPUT</small><b>{ctx.maxOutputTokens.toLocaleString()}</b></div>
            </div>
          </div>

          <div className="context-card">
            <div className="context-card-head">
              <span className="micro-label">ARCHITECTURAL REASONING & BALLISTIC TRACE</span>
              <span className="context-Readout">THINKING: {ctx.thinkingLevel.toUpperCase()}</span>
            </div>
            <pre className="skill-document">{ctx.thoughtSummary || state.diagnosis || 'Standing by for world synthesis or critique trace.'}</pre>
          </div>
        </div>
      ) : tab === 'code' ? (
        <CodeTab code={state.code} pick={codePick} onPick={setCodePick} />
      ) : tab === 'terminal' ? (
        state.logs.length ? (
          state.logs.map((entry) => (
            <div key={entry.id} className={`terminal-line terminal-${entry.kind}`}>
              <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</time>
              <span className="terminal-prompt">{entry.kind === 'terminal' ? '$' : '›'}</span>
              <pre>{entry.message}</pre>
            </div>
          ))
        ) : (
          <div className="drawer-empty">
            <Terminal size={25} strokeWidth={1} />
            <p>The agent is standing by.</p>
            <span>Start a world to inspect orchestration events and sandbox tool output as it arrives.</span>
          </div>
        )
      ) : state.skillContent ? (
        <pre className="skill-document">{state.skillContent}</pre>
      ) : (
        <div className="drawer-empty">
          <FileCode2 size={25} strokeWidth={1} />
          <p>No learned invariants yet.</p>
          <span>When the managed agent publishes SKILL.md, its actual contents will appear here.</span>
        </div>
      )}
    </div>
    <div className="drawer-footer micro-label"><span className="tiny-square" />{state.connected ? 'CONNECTED TO LOCAL ORCHESTRATOR' : 'STANDALONE AAA SANDBOX READY'}<span className="ml-auto">1M CTX · 64K OUT</span></div>
  </aside>
}
