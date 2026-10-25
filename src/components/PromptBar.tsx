import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { ArrowUpRight, Crosshair, Film, LoaderCircle, Orbit, Rocket, Sparkles, Waves, X } from 'lucide-react'
import { clipToWebm, type ConvertedClip } from './clipToWebm'

const CLIP_GOAL = 'Recreate the attached phone video as a playable 3D physics level.'
const MAX_CLIP_BYTES = 300 * 1024 * 1024

type ClipState = { name: string; progress: number; clip?: ConvertedClip; error?: string }

const presets = [
  { name: 'Catapult chaos', icon: Rocket, goal: 'Build a catapult that launches a boulder through a bridge and drops a red boss cube into a lava pit.' },
  { name: 'Orbital slingshot', icon: Orbit, goal: 'Build a gravity slingshot puzzle where a small sphere orbits a massive sphere and escapes through a target ring.' },
  { name: 'Domino cascade', icon: Waves, goal: 'Build a cascading domino course that knocks a ball down a ramp and into a goal cup.' },
]

export function PromptBar({ compact, busy, disabled, error, onSubmit, onSubmitVideo }: {
  compact: boolean; busy: boolean; disabled: boolean; error: string; onSubmit: (goal: string) => void;
  /** Present only when the loop can send a clip with the goal; the attach button is hidden otherwise. */
  onSubmitVideo?: (goal: string, clip: Blob) => void;
}) {
  const [goal, setGoal] = useState('')
  const [clip, setClip] = useState<ClipState | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const converting = !!clip && !clip.clip && !clip.error
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || disabled || converting) return
    if (clip?.clip && onSubmitVideo) onSubmitVideo(goal.trim() || CLIP_GOAL, clip.clip.blob)
    else if (goal.trim()) onSubmit(goal.trim())
  }
  const attach = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_CLIP_BYTES) { setClip({ name: file.name, progress: 0, error: 'That file is over 300 MB. Trim it on the phone first.' }); return }
    setClip({ name: file.name, progress: 0 })
    try {
      const converted = await clipToWebm(file, (progress) => setClip((c) => (c?.name === file.name && !c.clip ? { ...c, progress } : c)))
      setClip((c) => (c?.name === file.name ? { name: file.name, progress: 1, clip: converted } : c))
    } catch (e) {
      setClip((c) => (c?.name === file.name ? { name: file.name, progress: 0, error: e instanceof Error ? e.message : String(e) } : c))
    }
  }
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
        {onSubmitVideo && <><input ref={fileRef} type="file" accept="video/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void attach(e)} /><button type="button" className="icon-button clip-button" onClick={() => fileRef.current?.click()} disabled={disabled || busy || converting} aria-label="Attach a phone video as the goal" title="Attach a phone video (first 10 s)"><Film size={17} /></button></>}
        <button className="generate-button" type="submit" disabled={disabled || busy || converting || !(goal.trim() || clip?.clip)} aria-label="Generate world">
          {busy ? <LoaderCircle size={18} className="animate-spin" /> : <><span>Build</span><ArrowUpRight size={19} /></>}
        </button>
      </div>
      <div className="prompt-meta">{clip
        ? <span className={`clip-chip ${clip.error ? 'clip-error' : ''}`} role="status"><Film size={11} /><span className="clip-name">{clip.name}</span>{clip.error ?? (clip.clip ? `${clip.clip.seconds.toFixed(1)} S · ${clip.clip.width}×${clip.clip.height} · ${Math.max(1, Math.round(clip.clip.blob.size / 1024))} KB WEBM` : `CONVERTING ${Math.round(clip.progress * 100)}%`)}<button type="button" onClick={() => setClip(null)} aria-label="Remove the video"><X size={11} /></button></span>
        : <span><Crosshair size={11} /> A WHOLE WORLD, IN YOUR OWN WORDS</span>}<span>{busy ? 'BUILDING…' : 'PRESS ENTER ↵'}</span></div>
    </form>
    {!compact && <div className="preset-row"><span className="micro-label">QUICK START</span>{presets.map(({ name, icon: Icon, goal: preset }) => <button key={name} className="preset-pill" disabled={disabled || busy} onClick={() => { setGoal(preset); onSubmit(preset) }}><Icon size={13} strokeWidth={1.5} />{name}<ArrowUpRight size={11} className="opacity-40" /></button>)}</div>}
    {error && <p className="prompt-error" role="alert">{error}</p>}
  </section>
}
