import { useEffect, useRef, useState, type FormEvent } from 'react'
import { KeyRound, PlayCircle } from 'lucide-react'
import { getLivePasscode, setLivePasscode } from '../hosted/inPageDaemon'

/** Hosted builds only: Demo replays a recorded run for free; Live calls Gemini and needs the team passcode. */
export function ModeSwitch({ busy }: { busy: boolean }) {
  const [live, setLive] = useState(() => Boolean(getLivePasscode()))
  const [open, setOpen] = useState(false)
  const [passcode, setPasscode] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('argon:connection', { detail: { connected: true, mock: !live } }))
  }, [live])
  const useLive = (event: FormEvent) => {
    event.preventDefault()
    if (!passcode.trim()) return
    setLivePasscode(passcode.trim())
    setLive(true)
    setOpen(false)
    setPasscode('')
  }
  const useDemo = () => {
    setLivePasscode('')
    setLive(false)
    setOpen(false)
  }
  return <div className="mode-switch">
    <button className={`mode-chip ${live ? 'mode-live' : 'mode-demo'}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" disabled={busy} title={busy ? 'Finish or take over the current run to switch modes' : 'Switch between demo and live mode'}>
      {live ? <KeyRound size={12} /> : <PlayCircle size={12} />}{live ? 'LIVE · GEMINI' : 'DEMO MODE'}
    </button>
    {open && <div className="mode-popover glass-panel" role="dialog" aria-label="Choose mode">
      <p><b>Demo</b> replays a recorded catapult run in your browser. Free, no setup.</p>
      <p><b>Live</b> builds any world you describe with Gemini. It needs the team passcode.</p>
      <form onSubmit={useLive} className="mode-form">
        <label htmlFor="live-passcode" className="sr-only">Team passcode</label>
        <input id="live-passcode" ref={inputRef} type="password" autoComplete="off" placeholder="Team passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
        <button type="submit" disabled={!passcode.trim()}>Use live</button>
      </form>
      {live && <button className="mode-back" onClick={useDemo}>Back to demo</button>}
    </div>}
  </div>
}
