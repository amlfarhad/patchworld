import { useEffect, useRef, useState, type FormEvent } from 'react'
import { KeyRound, PlayCircle } from 'lucide-react'
import { getHostedMode, getLivePasscode, setHostedMode, setLivePasscode } from '../hosted/inPageDaemon'

/** Hosted builds only: Live (the default) builds any prompt with Gemini; Demo replays a recorded run for free. */
export function ModeSwitch({ busy }: { busy: boolean }) {
  const [live, setLive] = useState(() => getHostedMode() === 'live')
  const [open, setOpen] = useState(false)
  const [passcodeRequired, setPasscodeRequired] = useState(false)
  const [notice, setNotice] = useState('')
  const [passcode, setPasscode] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('argon:connection', { detail: { connected: true, mock: !live } }))
  }, [live])
  // Ask the deployment whether it can serve live mode; fall back to the demo when it cannot.
  useEffect(() => {
    let cancelled = false
    fetch('/api/argon', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() as Promise<{ live?: boolean; passcodeRequired?: boolean }> : null))
      .then((status) => {
        if (cancelled || !status) return
        setPasscodeRequired(Boolean(status.passcodeRequired))
        if (!status.live) {
          setHostedMode('demo')
          setLive(false)
          setNotice('Live mode is not set up on this deployment, so you are in the demo.')
        } else if (status.passcodeRequired && !getLivePasscode() && getHostedMode() === 'live') {
          setNotice('This site needs the team passcode for live mode.')
          setOpen(true)
        }
      })
      .catch(() => { /* Keep the current mode; a failed request surfaces when a goal is submitted. */ })
    return () => { cancelled = true }
  }, [])
  const useLive = (event: FormEvent) => {
    event.preventDefault()
    setLivePasscode(passcode.trim())
    setHostedMode('live')
    setLive(true)
    setOpen(false)
    setNotice('')
    setPasscode('')
  }
  const useDemo = () => {
    setHostedMode('demo')
    setLive(false)
    setOpen(false)
  }
  return <div className="mode-switch">
    <button className={`mode-chip ${live ? 'mode-live' : 'mode-demo'}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" disabled={busy} title={busy ? 'Finish or take over the current run to switch modes' : 'Switch between live and demo mode'}>
      {live ? <KeyRound size={12} /> : <PlayCircle size={12} />}{live ? 'LIVE · GEMINI' : 'DEMO MODE'}
    </button>
    {open && <div className="mode-popover glass-panel" role="dialog" aria-label="Choose mode">
      {notice && <p role="status"><b>{notice}</b></p>}
      <p><b>Live</b> builds any world you describe with Gemini, then keeps playtesting and fixing it.</p>
      <p><b>Demo</b> replays one recorded catapult run in your browser. Free, but it ignores your prompt.</p>
      <form onSubmit={useLive} className="mode-form">
        {passcodeRequired && <>
          <label htmlFor="live-passcode" className="sr-only">Team passcode</label>
          <input id="live-passcode" ref={inputRef} type="password" autoComplete="off" placeholder="Team passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
        </>}
        <button type="submit">{live ? 'Stay live' : 'Use live'}</button>
      </form>
      {live && <button className="mode-back" onClick={useDemo}>Switch to the demo</button>}
    </div>}
  </div>
}
