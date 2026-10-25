import { Check, Cpu, FlaskConical, ScanLine, TriangleAlert } from 'lucide-react'
import type { SandboxState } from '../hooks/useSandbox'

export function StatusTicker({ state }: { state: SandboxState }) {
  const running = state.phase === 'running' || state.phase === 'recording'
  const critiquing = ['critiquing', 'awaiting-patch', 'typecheck-retry', 'skill-evolving'].includes(state.phase)
  const generating = ['accepted', 'synthesizing', 'thinking'].includes(state.phase)
  const success = ['complete', 'hmr-swapped'].includes(state.phase)
  const error = state.phase === 'error' || state.phase === 'limit-reached'
  const title = running ? 'PASS 2: AUTONOMOUS PLAYTEST' : critiquing ? 'PASS 3: VIDEO CRITIC' : generating ? 'PASS 1: LONG DECODE' : state.phase === 'human' ? 'HUMAN CONTROL' : success ? 'LEVEL UP!' : error ? 'ATTENTION REQUIRED' : 'READY, PLAYER ONE'
  const detail = running ? `8S BOT LOOP · FRAME ${String(state.frame).padStart(3, '0')}/${state.frameLimit}` : critiquing ? state.phase === 'skill-evolving' ? 'SKILL.md EVOLVING' : 'WATCHING THE REPLAY & PATCHING' : generating ? 'SYNTHESIZING 3D WORLD' : state.phase === 'hmr-swapped' ? 'HMR HOT-SWAPPED SUCCESSFULLY' : state.phase === 'complete' ? 'GOAL REACHED · READY FOR TAKEOVER' : state.phase === 'human' ? 'AUTONOMY PAUSED · YOU HAVE CONTROL' : error ? 'OPEN AGENT BRAIN FOR DETAILS' : state.connected ? 'YOUR NEXT WORLD IS ONE IDEA AWAY' : 'CONNECTING TO LOCAL SYNC'
  const Icon = error ? TriangleAlert : running ? ScanLine : critiquing ? FlaskConical : success ? Check : Cpu
  return <div className={`status-ticker glass-panel ${error ? 'status-error' : ''}`} role="status" aria-live="polite" aria-atomic="true">
    <div className={`status-icon ${generating || running || critiquing ? 'is-working' : ''}`}><Icon size={17} strokeWidth={1.5} /></div>
    <div className="min-w-0"><div className="ticker-title">{title}</div><div className="ticker-detail">{detail}</div></div>
    <span className={`status-beacon ${state.connected ? 'connected' : ''}`} />
    {running && <div className="ticker-progress" style={{ transform: `scaleX(${state.frame / state.frameLimit})` }} />}
  </div>
}
