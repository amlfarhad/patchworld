import { useState, type FormEvent } from 'react'
import { ArrowUpRight, Flag, Gamepad2, MousePointer2, RotateCcw, Sparkles, Trophy } from 'lucide-react'
import type { EngineHost } from '../engine/EngineHost'
import type { ControlBinding, LevelGoal } from '../engine/types'
import { describeGoal, keyLabel } from './levelText'
import { useGoalWatch } from './useGoalWatch'

export function ControlOverlay({ active, onTakeOver, onReset, onTwist, onNewWorld, busy, host, controls, goal, levelMounts }: {
  active: boolean; onTakeOver: () => void; onReset: () => void; onTwist: (twist: string) => void; onNewWorld: (goal: string) => void; busy: boolean
  host: EngineHost | null; controls: ControlBinding[]; goal: LevelGoal | null; levelMounts: number
}) {
  const [twist, setTwist] = useState('')
  // The player bar either twists the world on screen or starts a brand-new one.
  const [newWorld, setNewWorld] = useState(false)
  // The bot's winning run leaves the level solved; the player has to reset it before their own attempt counts.
  const solved = useGoalWatch(host, goal, active, levelMounts)
  const submit = (event: FormEvent) => { event.preventDefault(); if (twist.trim()) { (newWorld ? onNewWorld : onTwist)(twist.trim()); setTwist('') } }
  return <section className={`control-overlay glass-panel ${active ? 'controls-active' : ''}`} aria-label="Human control">
    {active && solved && <div className="handoff-row"><Trophy size={14} /><span><b>The bot beat this level.</b> Your turn: reset it and play.</span><button className="takeover-button ml-auto" onClick={onReset} disabled={busy}><RotateCcw size={13} />Reset and play</button></div>}
    <div className="control-row">
      <div className="control-label"><Gamepad2 size={16} /><span>{active ? 'PLAYER CONTROL' : 'BOT AT PLAY'}</span></div>
      {active ? <div className="control-keys" aria-label="Level controls">{controls.length
        ? controls.map((c) => <span key={`${c.key}-${c.action}`}><kbd>{keyLabel(c.key)}</kbd>{c.action}</span>)
        : <span><MousePointer2 size={13} />Click to interact</span>}</div>
        : <span className="control-hint">Step into the simulation.</span>}
      <div className="ml-auto flex gap-2"><button className="quiet-button" onClick={onReset} disabled={busy}><RotateCcw size={13} /><span>Reset level</span></button>{!active && <button className="takeover-button" onClick={onTakeOver}><Gamepad2 size={13} />Take over</button>}</div>
    </div>
    {active && goal && <div className="goal-row"><Flag size={12} /><span className="micro-label">GOAL</span>{describeGoal(goal)}</div>}
    {active && <form onSubmit={submit} className="twist-form"><div className="twist-modes" role="radiogroup" aria-label="What your text should do"><button type="button" role="radio" aria-checked={!newWorld} onClick={() => setNewWorld(false)}>Twist this world</button><button type="button" role="radio" aria-checked={newWorld} onClick={() => setNewWorld(true)}>New world</button></div><Sparkles size={14} /><label htmlFor="world-twist" className="sr-only">{newWorld ? 'Describe a new world' : 'Add a twist to the world'}</label><input id="world-twist" value={twist} onChange={(e) => setTwist(e.target.value)} placeholder={newWorld ? 'Describe a new world… Super Mario with parkour and Goombas' : 'Add a twist… lower gravity, a moving target, one more obstacle'} maxLength={newWorld ? 2000 : 800} /><button disabled={!twist.trim() || busy} type="submit" aria-label={newWorld ? 'Build the new world' : 'Apply feature twist'}><ArrowUpRight size={17} /></button></form>}
  </section>
}
