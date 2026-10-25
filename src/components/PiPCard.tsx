import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Clapperboard, ScanLine, MessageSquareText, CircleCheck } from 'lucide-react'
import type { SandboxState } from '../hooks/useSandbox'

/** Turns "0:03" or "0:01.2" in the critique into buttons that seek the replay. */
function CritiqueText({ text, onSeek }: { text: string; onSeek: (seconds: number) => void }) {
  const parts = text.split(/(\b\d{1,2}:\d{2}(?:\.\d)?\b)/g)
  return <>{parts.map((part, index) => {
    const match = /^(\d{1,2}):(\d{2}(?:\.\d)?)$/.exec(part)
    if (!match) return <span key={index}>{part}</span>
    const seconds = Number(match[1]) * 60 + Number(match[2])
    return <button key={index} type="button" className="timestamp-link" onClick={() => onSeek(seconds)} aria-label={`Jump the replay to ${part}`}>{part}</button>
  })}</>
}

export function PiPCard({ state }: { state: SandboxState }) {
  const [open, setOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const replay = state.replay
  useEffect(() => { if (replay) setOpen(true) }, [replay])
  const streaming = Boolean(state.critique) && !state.critiqueFinal
  const won = replay && !replay.failed && !streaming
  const notes = won
    ? `Goal reached on attempt ${replay.iteration}.${state.diagnosis ? ` The fix that got it there: ${state.diagnosis}` : ''}`
    : state.critique || state.diagnosis || replay?.failureReason || 'Every attempt teaches the builder something new.'
  const seek = (seconds: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.min(seconds, Number.isFinite(video.duration) ? video.duration : seconds)
    void video.play().catch(() => {})
  }
  return <aside className={`pip-panel glass-panel ${open && replay ? 'pip-open' : ''} ${replay?.failed ? 'pip-failed' : ''}`} aria-label="Playtest replay and critique">
    <button className="pip-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="replay-content">
      <span className="flex items-center gap-2.5"><Clapperboard size={15} /><span className="micro-label">INSTANT REPLAY</span></span>
      <span className="flex items-center gap-2"><span className="replay-count">{replay ? `ITER ${String(replay.iteration).padStart(2, '0')}${state.maxIterations ? ` / ${String(state.maxIterations).padStart(2, '0')}` : ''}` : 'NO REPLAYS YET'}</span>{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
    </button>
    {open && <div id="replay-content">
      {replay ? <div className="replay-video-wrap"><video ref={videoRef} key={replay.runId} src={replay.videoUrl} autoPlay loop controls muted playsInline aria-label="Recorded bot attempt" /><span className={`replay-result ${replay.failed ? '' : 'passed'}`}>{replay.failed ? <ScanLine size={11} /> : <CircleCheck size={11} />}{replay.failed ? 'FAILED ATTEMPT' : 'GOAL REACHED'}</span></div> : <div className="replay-empty"><ScanLine size={27} strokeWidth={1} /><span>No attempts recorded yet.</span><small>The next bot run will appear here.</small></div>}
      <div className="critique-block"><div className="flex items-center justify-between"><span className="micro-label flex items-center gap-2"><MessageSquareText size={12} /> {streaming ? 'CRITIC IS WRITING' : won ? 'LEVEL BEATEN' : 'CRITIC NOTES'}</span><span className="micro-label opacity-50">{state.diagnosisTime ? new Date(state.diagnosisTime).toLocaleTimeString([], { hour12: false }) : '—'}</span></div><p aria-live="polite"><CritiqueText text={notes} onSeek={seek} />{streaming && <span className="stream-caret" aria-hidden="true" />}</p></div>
    </div>}
  </aside>
}
