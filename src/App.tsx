import { useCallback, useState } from 'react'
import { AudioLines, Braces, ChevronRight, Expand, Network, Radio, Shrink } from 'lucide-react'
import type { EngineHost } from './engine/EngineHost'
import { useSandbox } from './hooks/useSandbox'
import { PixelScene } from './components/PixelScene'
import { Viewport } from './components/Viewport'
import { PromptBar } from './components/PromptBar'
import { StatusTicker } from './components/StatusTicker'
import { PiPCard } from './components/PiPCard'
import { AgentDrawer } from './components/AgentDrawer'
import { ControlOverlay } from './components/ControlOverlay'
import { ModeSwitch } from './components/ModeSwitch'
import { isHosted } from './hosted/mode'

export default function App() {
  const [host, setHost] = useState<EngineHost | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const state = useSandbox()
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const busy = ['accepted', 'synthesizing', 'thinking', 'critiquing', 'typecheck-retry', 'running', 'recording', 'uploading', 'awaiting-patch', 'hmr-pending'].includes(state.phase)
  const startGoal = (goal: string) => host?.autonomousLoop.startGoal(goal)
  const takeover = () => { host?.autonomousLoop.takeOver(); document.querySelector<HTMLCanvasElement>('.engine-canvas')?.focus({ preventScroll: true }) }
  const reset = () => { void host?.resetLevel().catch((e: unknown) => window.dispatchEvent(new CustomEvent('argon:goal-error', { detail: String(e) }))) }
  const twist = (value: string) => host?.autonomousLoop.applyTwist(value)

  return <main className={`sandbox-shell ${state.hasLevel ? 'world-loaded' : 'world-empty'} ${focusMode ? 'focus-mode' : ''}`}>
    <Viewport onReady={setHost} />
    {!state.hasLevel && <div className="idle-atmosphere" aria-hidden="true"><div className="stage-grid" /><div className="sky-cloud sky-cloud-left" /><div className="sky-cloud sky-cloud-right" /><PixelScene /></div>}
    <div className="viewport-frame" aria-hidden="true"><i /><i /><i /><i /></div>
    <header className="command-header"><div className="brand" aria-label="Patchworld"><span className="brand-symbol"><span /><span /><span /><span /></span><span>patchworld<span className="brand-period">✦</span></span><span className="brand-divider" /><span className="brand-subtitle">A PHYSICS<br />PLAYGROUND</span></div><div className="header-center micro-label"><span className="tiny-square" /> WORLD 01 <ChevronRight size={10} /> <span className="text-white/35 header-goal" title={state.goal || undefined}>{state.goal || (state.hasLevel ? 'NOW PLAYING' : 'NEW GAME')}</span></div><div className="header-actions">{isHosted && <ModeSwitch busy={busy} />}{!isHosted && state.mock && <span className="mock-badge" title="The daemon replays a scripted run; no Gemini calls are made">MOCK REPLAY</span>}<span className="connection-badge micro-label"><span className={`status-beacon ${state.connected ? 'connected' : ''}`} />{state.connected ? 'READY TO PLAY' : 'CONNECTING'}</span><button className="icon-button" aria-label={focusMode ? 'Show interface' : 'Focus viewport'} aria-pressed={focusMode} onClick={() => setFocusMode(!focusMode)}>{focusMode ? <Shrink size={16} /> : <Expand size={16} />}</button></div></header>
    <div className="hud-layer" inert={focusMode}><StatusTicker state={state} /><PiPCard state={state} /></div>
    {(!state.human || !state.hasLevel) && <div className="hud-layer" inert={focusMode}><PromptBar compact={state.hasLevel} busy={busy || state.phase === 'running'} disabled={!state.connected || !state.ready} error={state.error} onSubmit={startGoal} /></div>}
    {state.hasLevel && <div className="hud-layer" inert={focusMode}><ControlOverlay active={state.human} onTakeOver={takeover} onReset={reset} onTwist={twist} onNewWorld={startGoal} busy={busy} /></div>}
    {state.human && state.humanWon && <div className="win-banner" role="status"><strong>You did it!</strong><span>{state.goal || "Level beaten"}</span><button onClick={reset}>Play again</button></div>}
    <AgentDrawer open={drawerOpen && !focusMode} onClose={closeDrawer} state={state} />
    <footer className="command-footer"><button className={`brain-trigger ${drawerOpen ? 'is-open' : ''}`} onClick={() => setDrawerOpen(!drawerOpen)} aria-expanded={drawerOpen} aria-label="Toggle agent brain"><Braces size={17} /><span>Workshop</span><span className="brain-tag">LIVE</span><ChevronRight size={13} className={drawerOpen ? 'rotate-180' : ''} /></button><div className="footer-center micro-label"><Radio size={12} /> YOUR PLAYGROUND <span className="text-white/20">/</span> {state.hasLevel ? 'WORLD IN MOTION' : 'GOOD IDEAS START HERE'}</div><div className="telemetry-strip"><span><AudioLines size={13} /><b>60</b> HZ</span><span><Network size={13} /><b>{String(state.bodyCount).padStart(2, '0')}</b> BODIES</span></div></footer>
  </main>
}
