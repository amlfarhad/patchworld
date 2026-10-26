import { useCallback, useState } from 'react'
import { AudioLines, Braces, Camera, ChevronRight, Cpu, Expand, Layers, Network, Radio, Shrink } from 'lucide-react'
import type { CameraDirectorMode, EngineHost } from './engine/EngineHost'
import { useSandbox } from './hooks/useSandbox'
import { PixelScene } from './components/PixelScene'
import { Viewport } from './components/Viewport'
import { PromptBar } from './components/PromptBar'
import { StatusTicker } from './components/StatusTicker'
import { PiPCard } from './components/PiPCard'
import { AgentDrawer } from './components/AgentDrawer'
import { ControlOverlay } from './components/ControlOverlay'
import { HumanResultScreen } from './components/HumanResultScreen'
import { ModeSwitch } from './components/ModeSwitch'
import { isHosted } from './hosted/mode'

const CAMERA_MODES: Array<{ id: CameraDirectorMode; label: string }> = [
  { id: 'overview', label: 'Panorama' },
  { id: 'follow', label: 'Follow' },
  { id: 'cinematic', label: 'Orbit' },
  { id: 'citadel', label: 'Citadel' },
]

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
  const activeCameraMode = state.engineStats.cameraMode ?? 'overview'
  const selectCameraMode = (mode: CameraDirectorMode) => {
    host?.setCameraMode(mode)
    window.dispatchEvent(new CustomEvent('argon:camera-mode', { detail: mode }))
  }

  return <main className={`sandbox-shell ${state.hasLevel ? 'world-loaded' : 'world-empty'} ${focusMode ? 'focus-mode' : ''}`}>
    <Viewport onReady={setHost} />
    {!state.hasLevel && <div className="idle-atmosphere" aria-hidden="true"><div className="stage-grid" /><div className="sky-cloud sky-cloud-left" /><div className="sky-cloud sky-cloud-right" /><PixelScene /></div>}
    <div className="viewport-frame" aria-hidden="true"><i /><i /><i /><i /></div>
    <header className="command-header">
      <div className="brand" aria-label="Patchworld">
        <span className="brand-symbol"><span /><span /><span /><span /></span>
        <span>patchworld<span className="brand-period">✦</span></span>
        <span className="brand-divider" />
        <span className="brand-subtitle">AAA PHYSICS<br />WORLD ENGINE</span>
      </div>
      <div className="header-center micro-label">
        <Camera size={11} />
        <div className="flex items-center gap-1" role="group" aria-label="Camera Director">
          {CAMERA_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => selectCameraMode(m.id)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase transition ${
                activeCameraMode === m.id
                  ? 'bg-emerald-700 text-white font-semibold'
                  : 'bg-black/5 text-black/65 hover:bg-black/10'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="header-actions">
        <button
          type="button"
          className="context-header-pill micro-label"
          onClick={() => setDrawerOpen(true)}
          title="Inspect 1,048,576 input/output token window, 17 packed codebase files, and physics telemetry"
        >
          <Cpu size={11} />
          <span>1M IN / 1M OUT · {(state.contextTelemetry.contextTokensEstimate / 1000).toFixed(1)}K PACKED</span>
        </button>
        {isHosted && <ModeSwitch busy={busy} />}
        {state.mock && <span className="mock-badge" title="The sync daemon is replaying a scripted run; no Gemini calls are made">MOCK REPLAY</span>}
        <span className="connection-badge micro-label">
          <span className={`status-beacon ${state.connected ? 'connected' : ''}`} />
          {state.connected ? 'READY TO PLAY' : 'LOCAL ENGINE'}
        </span>
        <button className="icon-button" aria-label={focusMode ? 'Show interface' : 'Focus viewport'} aria-pressed={focusMode} onClick={() => setFocusMode(!focusMode)}>
          {focusMode ? <Shrink size={16} /> : <Expand size={16} />}
        </button>
      </div>
    </header>
    <div className="hud-layer" inert={focusMode}><StatusTicker state={state} /><PiPCard state={state} /></div>
    {(!state.human || !state.hasLevel) && <div className="hud-layer" inert={focusMode}><PromptBar compact={state.hasLevel} busy={busy || state.phase === 'running'} disabled={!state.ready} error={state.error} onSubmit={startGoal} /></div>}
    {state.hasLevel && <div className="hud-layer" inert={focusMode}><ControlOverlay active={state.human} onTakeOver={takeover} onReset={reset} onTwist={twist} onNewWorld={startGoal} busy={busy} host={host} controls={state.controls} goal={state.levelGoal} levelMounts={state.levelMounts} /></div>}
    {state.human && <HumanResultScreen state={state} onPlayAgain={reset} />}
    <AgentDrawer open={drawerOpen && !focusMode} onClose={closeDrawer} state={state} />
    <footer className="command-footer">
      <button className={`brain-trigger ${drawerOpen ? 'is-open' : ''}`} onClick={() => setDrawerOpen(!drawerOpen)} aria-expanded={drawerOpen} aria-label="Toggle agent brain">
        <Braces size={17} />
        <span>Workshop</span>
        <span className="brain-tag">1M CTX</span>
        <ChevronRight size={13} className={drawerOpen ? 'rotate-180' : ''} />
      </button>
      <div className="footer-center micro-label">
        <Radio size={12} /> RAPIER 3D + THREE.JS PBR <span className="text-white/20">/</span> {state.hasLevel ? '3-MODULE WORLD ACTIVE' : 'GOOD IDEAS START HERE'}
      </div>
      <div className="telemetry-strip">
        <span><AudioLines size={13} /><b>{state.engineStats.fps}</b> FPS · <b>{state.engineStats.stepMs.toFixed(1)}</b> MS</span>
        <span><Layers size={13} /><b>{(state.engineStats.triangles / 1000).toFixed(1)}K</b> TRIS</span>
        <span><Network size={13} /><b>{String(state.bodyCount).padStart(2, '0')}</b> BODIES</span>
      </div>
    </footer>
  </main>
}
