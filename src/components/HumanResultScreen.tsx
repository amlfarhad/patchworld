import { useEffect, useRef, useState } from 'react'
import { Frown, RotateCcw, Sparkles, Trophy, X } from 'lucide-react'
import type { HumanResult, SandboxState } from '../hooks/useSandbox'
import { describeGoal } from './levelText'

/** Win and lose screens for a person playing the level after the handoff. */
export function HumanResultScreen({ state, onPlayAgain }: { state: SandboxState; onPlayAgain: () => void }) {
  const result = state.humanResult
  const [dismissed, setDismissed] = useState<HumanResult | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const visible = !!result && result !== dismissed
  useEffect(() => { if (visible) primaryRef.current?.focus({ preventScroll: true }) }, [visible])
  if (!result || !visible) return null
  const won = result.outcome === 'won'
  const attempts = state.replays.length
  const misses = state.replays.filter((r) => r.failed).length
  const twist = () => { setDismissed(result); window.setTimeout(() => document.getElementById('world-twist')?.focus(), 0) }
  return <div className="result-layer" role="alertdialog" aria-labelledby="result-title" aria-describedby="result-detail" onKeyDown={(e) => { if (e.key === 'Escape') setDismissed(result) }}>
    <section className={`result-card glass-panel ${won ? 'result-won' : 'result-lost'}`}>
      <button type="button" className="icon-button result-close" onClick={() => setDismissed(result)} aria-label="Close and keep playing"><X size={16} /></button>
      <div className="result-badge">{won ? <Trophy size={26} /> : <Frown size={26} />}</div>
      <h2 id="result-title">{won ? 'You did it!' : 'So close!'}</h2>
      <p id="result-detail">{won
        ? `${state.levelGoal ? describeGoal(state.levelGoal) : 'Goal reached'}${result.seconds ? ` in ${result.seconds.toFixed(1)} s` : ''}.`
        : result.reason || 'That attempt did not reach the goal.'}</p>
      {won && attempts > 0 && <p className="micro-label result-stat">THE BOT NEEDED {attempts} {attempts === 1 ? 'ATTEMPT' : 'ATTEMPTS'} TO FIX THIS LEVEL</p>}
      {!won && misses > 0 && <p className="micro-label result-stat">THE BOT MISSED {misses} {misses === 1 ? 'TIME' : 'TIMES'} BEFORE IT GOT THERE</p>}
      <div className="result-actions">
        <button ref={primaryRef} type="button" className="generate-button" onClick={onPlayAgain}><RotateCcw size={15} />{won ? 'Play again' : 'Try again'}</button>
        <button type="button" className="quiet-button" onClick={twist}><Sparkles size={13} />Add a twist</button>
      </div>
    </section>
  </div>
}
