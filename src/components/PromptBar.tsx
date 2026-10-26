import { useState, type FormEvent } from 'react'
import { ArrowUpRight, Crosshair, Disc3, LoaderCircle, Orbit, Rocket, Sparkles, Waves } from 'lucide-react'

const presets = [
  { name: 'Catapult chaos', icon: Rocket, goal: 'Build a catapult that launches a boulder through a bridge and drops a red boss cube into a lava pit.' },
  { name: 'Orbital slingshot', icon: Orbit, goal: 'Build a gravity slingshot puzzle where a small sphere orbits a massive sphere and escapes through a target ring.' },
  { name: 'Domino cascade', icon: Waves, goal: 'Build a cascading domino course that knocks a ball down a ramp and into a goal cup.' },
  { name: '10-Pin bowling', icon: Disc3, goal: 'Build a bowling lane where a heavy ball rolls down the lane and knocks down a rack of ten pins.' },
]

export function PromptBar({ compact, busy, disabled, error, onSubmit }: {
  compact: boolean; busy: boolean; disabled: boolean; error: string; onSubmit: (goal: string) => void;
}) {
  const [goal, setGoal] = useState('')
  const submit = (event: FormEvent) => { event.preventDefault(); if (goal.trim() && !busy && !disabled) onSubmit(goal.trim()) }
  return <section className={`prompt-position ${compact ? 'prompt-compact' : ''}`} aria-label="Create a physics world">
    {!compact && <div className="hero-copy">
      <div className="micro-label mb-5 flex items-center justify-center gap-2"><span className="tiny-square" /> IMAGINATION IN. ADVENTURE OUT.</div>
      <h1>Make a little <span>chaos.</span></h1>
      <p>You dream it. We build it, play it, and make it better.</p>
    </div>}
    <form className="prompt-glass" onSubmit={submit}>
      <div className="prompt-field">
        <Sparkles size={19} strokeWidth={1.6} className="shrink-0 text-cyan-200" />
        <label className="sr-only" htmlFor="world-goal">Describe a 3D physics world</label>
        <input id="world-goal" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={2000} autoComplete="off"
          placeholder="Describe a 3D physics world (e.g., Catapult shatters bridge into lava pit)..." />
        <button className="generate-button" type="submit" disabled={disabled || busy || !goal.trim()} aria-label="Generate world">
          {busy ? <LoaderCircle size={18} className="animate-spin" /> : <><span>Build</span><ArrowUpRight size={19} /></>}
        </button>
      </div>
      <div className="prompt-meta"><span><Crosshair size={11} /> A WHOLE WORLD, IN YOUR OWN WORDS · 1M CONTEXT ENGINE</span><span>{busy ? 'BUILDING…' : 'PRESS ENTER ↵'}</span></div>
    </form>
    <div className={`preset-row ${compact ? 'preset-row-compact' : ''}`}>
      <span className="micro-label">SHOWCASE WORLDS</span>
      {presets.map(({ name, icon: Icon, goal: preset }) => (
        <button
          key={name}
          type="button"
          className="preset-pill"
          disabled={disabled || busy}
          onClick={() => {
            setGoal(preset)
            onSubmit(preset)
          }}
        >
          <Icon size={13} strokeWidth={1.5} />
          {name}
          <ArrowUpRight size={11} className="opacity-40" />
        </button>
      ))}
    </div>
    {error && <p className="prompt-error" role="alert">{error}</p>}
  </section>
}
