import { useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { ChevronDown, ChevronUp, Clapperboard, ScanLine, MessageSquareText, CircleCheck, ScanEye } from 'lucide-react'
import type { Critique, SandboxState } from '../hooks/useSandbox'

const pad = (n: number) => String(n).padStart(2, '0')
const TIMESTAMP = /\b(\d{1,2}):([0-5]\d)(?:\.(\d+))?\b/g
const LABELS: Record<Critique['status'], string> = { idle: 'BUILDER NOTES', watching: 'AGENT IS WATCHING', streaming: 'CRITIQUE', done: 'DIAGNOSIS' }

/** Renders critique text with the video timestamps the agent cites ("At 0:03 …") as buttons that seek the replay. */
function CritiqueText({ text, onSeek }: { text: string; onSeek: (seconds: number) => void }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(TIMESTAMP)) {
    const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? 0}`)
    parts.push(text.slice(last, match.index), <button key={match.index} type="button" className="time-chip" onClick={() => onSeek(seconds)} aria-label={`Jump replay to ${match[0]}`}>{match[0]}</button>)
    last = match.index + match[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

export function PiPCard({ state }: { state: SandboxState }) {
  const [open, setOpen] = useState(false)
  const replay = state.replay
  const critique = state.critique
  const videoRef = useRef<HTMLVideoElement>(null)
  const notesRef = useRef<HTMLParagraphElement>(null)
  const stickToBottom = useRef(true)
  const watching = critique.status === 'watching'
  const streaming = critique.status === 'streaming'
  useEffect(() => { if (replay || watching) setOpen(true) }, [replay, watching])
  useEffect(() => { stickToBottom.current = true }, [critique.iteration])
  useEffect(() => { const notes = notesRef.current; if (notes && streaming && stickToBottom.current) notes.scrollTop = notes.scrollHeight }, [critique.text, streaming])
  const onNotesScroll = (e: UIEvent<HTMLParagraphElement>) => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24 }
  const seek = (seconds: number) => { const video = videoRef.current; if (!video) return; video.pause(); video.currentTime = seconds }
  const notes = critique.status === 'idle' ? (replay && !replay.failed ? 'Goal reached on this attempt.' : replay?.failureReason || 'Every attempt teaches the builder something new.') : critique.text
  return <aside className={`pip-panel glass-panel ${open && (replay || critique.status !== 'idle') ? 'pip-open' : ''} ${replay?.failed ? 'pip-failed' : ''}`} aria-label="Playtest replay and critique">
    <button className="pip-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="replay-content">
      <span className="flex items-center gap-2.5"><Clapperboard size={15} /><span className="micro-label">INSTANT REPLAY</span></span>
      <span className="flex items-center gap-2"><span className="replay-count">{replay ? `ITER ${pad(replay.iteration)}${state.maxIterations ? ` / ${pad(state.maxIterations)}` : ''}` : 'NO REPLAYS YET'}</span>{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
    </button>
    {open && <div id="replay-content">
      {replay ? <div className="replay-video-wrap"><video ref={videoRef} key={replay.runId} src={replay.videoUrl} autoPlay loop controls muted playsInline aria-label="Recorded bot attempt" /><span className={`replay-result ${replay.failed ? '' : 'passed'}`}>{replay.failed ? <ScanLine size={11} /> : <CircleCheck size={11} />}{replay.failed ? 'FAILED ATTEMPT' : 'GOAL REACHED'}</span></div> : <div className="replay-empty"><ScanLine size={27} strokeWidth={1} /><span>No attempts recorded yet.</span><small>The next bot run will appear here.</small></div>}
      <div className={`critique-block critique-${critique.status}`}>
        <div className="flex items-center justify-between"><span className="micro-label flex items-center gap-2"><MessageSquareText size={12} /> {LABELS[critique.status]}</span>{streaming ? <span className="live-tag micro-label"><i className="live-dot" />LIVE</span> : <span className="micro-label opacity-50">{critique.updatedAt ? new Date(critique.updatedAt).toLocaleTimeString([], { hour12: false }) : '—'}</span>}</div>
        <p ref={notesRef} onScroll={onNotesScroll} aria-live="polite" aria-busy={streaming}>
          {watching ? <span className="watching-line"><ScanEye size={13} className="critique-scan" />Watching attempt {pad(critique.iteration)} frame by frame…</span> : replay ? <CritiqueText text={notes} onSeek={seek} /> : notes}
          {streaming && <span className="critique-caret" aria-hidden="true" />}
        </p>
      </div>
    </div>}
  </aside>
}
