import { useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { ChevronDown, ChevronUp, Clapperboard, ScanLine, MessageSquareText, CircleCheck, ScanEye, Columns2, X, Check } from 'lucide-react'
import type { Critique, SandboxState } from '../hooks/useSandbox'
import { ComparePanel } from './ComparePanel'

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
  const [comparing, setComparing] = useState(false)
  // An older attempt picked from the strip; a newer attempt arriving switches back to the latest.
  const [pick, setPick] = useState<{ runId: string; latest: string } | null>(null)
  const replay = state.replay
  const shown = (pick && pick.latest === replay?.runId && state.replays.find((r) => r.runId === pick.runId)) || replay
  const past = !!shown && shown !== replay
  const draft = state.replays[0]
  const winner = state.replays.findLast((r) => !r.failed)
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
  const notes = past ? (shown.failed ? state.critiques[shown.iteration] || shown.failureReason || 'No critique was recorded for this attempt.' : 'Goal reached on this attempt.')
    : critique.status === 'idle' ? (replay && !replay.failed ? 'Goal reached on this attempt.' : replay?.failureReason || 'Every attempt teaches the builder something new.') : critique.text
  return <aside className={`pip-panel glass-panel ${open && (replay || critique.status !== 'idle') ? 'pip-open' : ''} ${shown?.failed ? 'pip-failed' : ''}`} aria-label="Playtest replay and critique">
    <button className="pip-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="replay-content">
      <span className="flex items-center gap-2.5"><Clapperboard size={15} /><span className="micro-label">INSTANT REPLAY</span></span>
      <span className="flex items-center gap-2"><span className="replay-count">{shown ? `ITER ${pad(shown.iteration)}${state.maxIterations ? ` / ${pad(state.maxIterations)}` : ''}` : 'NO REPLAYS YET'}</span>{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
    </button>
    {open && <div id="replay-content">
      {shown ? <div className="replay-video-wrap"><video ref={videoRef} key={shown.runId} src={shown.videoUrl} autoPlay loop controls muted playsInline aria-label={`Recorded bot attempt ${shown.iteration}`} /><span className={`replay-result ${shown.failed ? '' : 'passed'}`}>{shown.failed ? <ScanLine size={11} /> : <CircleCheck size={11} />}{shown.failed ? 'FAILED ATTEMPT' : 'GOAL REACHED'}</span></div> : <div className="replay-empty"><ScanLine size={27} strokeWidth={1} /><span>No attempts recorded yet.</span><small>The next bot run will appear here.</small></div>}
      {state.replays.length > 1 && <div className="attempt-strip">
        <div className="attempt-list" role="group" aria-label="Attempts">{state.replays.map((r) => <button key={r.runId} type="button" className={`attempt-chip ${r.failed ? '' : 'passed'}`} aria-pressed={r === shown} aria-label={`Attempt ${r.iteration}, ${r.failed ? 'failed' : 'goal reached'}`} onClick={() => setPick(r === replay || !replay ? null : { runId: r.runId, latest: replay.runId })}>{r.failed ? <X size={9} /> : <Check size={9} />}{pad(r.iteration)}</button>)}</div>
        {winner && winner !== draft && <button type="button" className="compare-button" onClick={() => setComparing(true)}><Columns2 size={11} />DRAFT 1 VS WIN</button>}
      </div>}
      <div className={`critique-block critique-${past ? 'done' : critique.status}`}>
        <div className="flex items-center justify-between"><span className="micro-label flex items-center gap-2"><MessageSquareText size={12} /> {past ? `ATTEMPT ${pad(shown.iteration)} NOTES` : LABELS[critique.status]}</span>{streaming && !past ? <span className="live-tag micro-label"><i className="live-dot" />LIVE</span> : <span className="micro-label opacity-50">{critique.updatedAt && !past ? new Date(critique.updatedAt).toLocaleTimeString([], { hour12: false }) : '—'}</span>}</div>
        <p ref={notesRef} onScroll={onNotesScroll} aria-live="polite" aria-busy={streaming && !past}>
          {watching && !past ? <span className="watching-line"><ScanEye size={13} className="critique-scan" />Watching attempt {pad(critique.iteration)} frame by frame…</span> : shown ? <CritiqueText text={notes} onSeek={seek} /> : notes}
          {streaming && !past && <span className="critique-caret" aria-hidden="true" />}
        </p>
      </div>
    </div>}
    {comparing && draft && winner && <ComparePanel draft={draft} winner={winner} draftNotes={state.critiques[draft.iteration] || draft.failureReason || ''} onClose={() => setComparing(false)} />}
  </aside>
}
