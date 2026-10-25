import { useEffect, useState, type FormEvent } from 'react'
import { ArrowUpRight, ChevronUp, Flag, Gamepad2, Minus, MousePointer2, RotateCcw, Sparkles, Trophy } from 'lucide-react'
import type { EngineHost } from '../engine/EngineHost'
import type { ControlBinding, LevelGoal } from '../engine/types'
import { describeGoal, keyLabel } from './levelText'
import { useGoalWatch } from './useGoalWatch'
import { OPEN_TWIST_EVENT } from './buildStages'

const MINIMIZED_KEY = 'patchworld:controls-minimized'
const readMinimized = () => { try { return sessionStorage.getItem(MINIMIZED_KEY) === '1' } catch { return false } }
const saveMinimized = (value: boolean) => { try { sessionStorage.setItem(MINIMIZED_KEY, value ? '1' : '0') } catch { /* private mode: keep it for this page only */ } }

export function ControlOverlay({ active, onTakeOver, onReset, onTwist, onNewWorld, busy, host, controls, goal, levelMounts }: {
  active: boolean; onTakeOver: () => void; onReset: () => void; onTwist: (twist: string) => void; onNewWorld: (goal: string) => void; busy: boolean
  host: EngineHost | null; controls: ControlBinding[]; goal: LevelGoal | null; levelMounts: number
}) {
  const [twist, setTwist] = useState('')
  // The player bar either twists the world on screen or starts a brand-new one.
  const [newWorld, setNewWorld] = useState(false)
  const [twistOpen, setTwistOpen] = useState(false)
  // Minimized to a pill so the level is unobstructed; remembered for the browser session.
  const [minimized, setMinimized] = useState(readMinimized)
  // The bot's winning run leaves the level solved; the player has to reset it before their own attempt counts.
  const solved = useGoalWatch(host, goal, active, levelMounts)
  const minimize = (value: boolean) => { setMinimized(value); saveMinimized(value) }
  useEffect(() => {
    const open = () => { setMinimized(false); saveMinimized(false); setTwistOpen(true) }
    window.addEventListener(OPEN_TWIST_EVENT, open)
    return () => window.removeEventListener(OPEN_TWIST_EVENT, open)
  }, [])
  const submit = (event: FormEvent) => { event.preventDefault(); if (twist.trim()) { (newWorld ? onNewWorld : onTwist)(twist.trim()); setTwist(''); setTwistOpen(false) } }
  const keys = controls.length
    ? controls.map((c) => <span key={`${c.key}-${c.action}`}><kbd>{keyLabel(c.key)}</kbd>{c.action}</span>)
    : [<span key="click"><MousePointer2 size={13} />Click to interact</span>]

  if (minimized) {
    return <button type="button" className={`control-pill glass-panel ${active && solved ? 'pill-alert' : ''}`} onClick={() => minimize(false)} aria-label="Show the player controls">
      {active && solved ? <Trophy size={13} /> : <Gamepad2 size={14} />}
      <span>{!active ? 'BOT AT PLAY' : solved ? 'YOUR TURN · RESET TO PLAY' : 'PLAYER CONTROL'}</span>
      {active && !solved && controls[0] && <span className="pill-key"><kbd>{keyLabel(controls[0].key)}</kbd>{controls[0].action}</span>}
      <ChevronUp size={13} />
    </button>
  }

  return <section className={`control-overlay glass-panel ${active ? 'controls-active' : ''}`} aria-label="Human control">
    {active && solved && <div className="handoff-row"><Trophy size={14} /><span><b>The bot beat this level.</b> Your turn: reset it and play.</span><button className="takeover-button ml-auto" onClick={onReset} disabled={busy}><RotateCcw size={13} />Reset and play</button></div>}
    {active && twistOpen && <form onSubmit={submit} className="twist-form"><div className="twist-modes" role="radiogroup" aria-label="What your text should do"><button type="button" role="radio" aria-checked={!newWorld} onClick={() => setNewWorld(false)}>Twist this world</button><button type="button" role="radio" aria-checked={newWorld} onClick={() => setNewWorld(true)}>New world</button></div><Sparkles size={14} /><label htmlFor="world-twist" className="sr-only">{newWorld ? 'Describe a new world' : 'Add a twist to the world'}</label><input id="world-twist" autoFocus value={twist} onChange={(e) => setTwist(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setTwistOpen(false) }} placeholder={newWorld ? 'Describe a new world… Super Mario with parkour and Goombas' : 'Add a twist… lower gravity, a moving target, one more obstacle'} maxLength={newWorld ? 2000 : 800} /><button disabled={!twist.trim() || busy} type="submit" aria-label={newWorld ? 'Build the new world' : 'Apply feature twist'}><ArrowUpRight size={17} /></button></form>}
    <div className="control-row">
      <div className="control-label"><Gamepad2 size={16} /><span>{active ? 'PLAYER CONTROL' : 'BOT AT PLAY'}</span></div>
      {active ? <div className="control-keys" aria-label="Level controls">{keys}</div> : <span className="control-hint">Step into the simulation.</span>}
      {active && goal && <span className="control-goal" title={describeGoal(goal)}><Flag size={11} /><span>{describeGoal(goal)}</span></span>}
      <div className="ml-auto flex shrink-0 gap-2">
        {active && <button className={`quiet-button ${twistOpen ? 'is-on' : ''}`} onClick={() => setTwistOpen(!twistOpen)} aria-expanded={twistOpen} aria-controls={twistOpen ? 'world-twist' : undefined}><Sparkles size={13} /><span>Twist</span></button>}
        <button className="quiet-button" onClick={onReset} disabled={busy}><RotateCcw size={13} /><span>Reset</span></button>
        {!active && <button className="takeover-button" onClick={onTakeOver}><Gamepad2 size={13} />Take over</button>}
        <button className="icon-button control-minimize" onClick={() => minimize(true)} aria-label="Minimize the player controls" title="Minimize"><Minus size={14} /></button>
      </div>
    </div>
  </section>
}
