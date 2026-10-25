import { useState, type FormEvent } from 'react'
import { ArrowUpRight, Gamepad2, Keyboard, MousePointer2, RotateCcw, Sparkles } from 'lucide-react'

type InputMode = 'twist' | 'new'

export function ControlOverlay({ active, onTakeOver, onReset, onTwist, onNewWorld, busy }: { active: boolean; onTakeOver: () => void; onReset: () => void; onTwist: (twist: string) => void; onNewWorld: (goal: string) => void; busy: boolean }) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<InputMode>('twist')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim()) return
    if (mode === 'new') onNewWorld(text.trim())
    else onTwist(text.trim())
    setText('')
  }
  return <section className={`control-overlay glass-panel ${active ? 'controls-active' : ''}`} aria-label="Human control">
    <div className="control-row"><div className="control-label"><Gamepad2 size={16} /><span>{active ? 'PLAYER CONTROL' : 'BOT AT PLAY'}</span></div>{active ? <div className="control-shortcuts"><span><Keyboard size={13} />Keys <i>Level controls</i></span><span><MousePointer2 size={13} />Click <i>Interact</i></span></div> : <span className="control-hint">Step into the simulation.</span>}<div className="ml-auto flex gap-2"><button className="quiet-button" onClick={onReset} disabled={busy}><RotateCcw size={13} /><span>Reset level</span></button>{!active && <button className="takeover-button" onClick={onTakeOver}><Gamepad2 size={13} />Take over</button>}</div></div>
    {active && <form onSubmit={submit} className="twist-form">
      <div className="twist-modes" role="radiogroup" aria-label="What your text should do">
        <button type="button" role="radio" aria-checked={mode === 'twist'} onClick={() => setMode('twist')}>Twist this world</button>
        <button type="button" role="radio" aria-checked={mode === 'new'} onClick={() => setMode('new')}>New world</button>
      </div>
      <Sparkles size={14} />
      <label htmlFor="world-twist" className="sr-only">{mode === 'new' ? 'Describe a new world' : 'Add a twist to the world'}</label>
      <input id="world-twist" value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === 'new' ? 'Describe a new world… Super Mario with parkour and Goombas' : 'Add a twist… lower gravity, a moving target, one more obstacle'} maxLength={mode === 'new' ? 2000 : 800} />
      <button disabled={!text.trim() || busy} type="submit" aria-label={mode === 'new' ? 'Build the new world' : 'Apply the twist'}><ArrowUpRight size={17} /></button>
    </form>}
  </section>
}
