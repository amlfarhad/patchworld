import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CircleCheck, FileCode2, LoaderCircle, ScanLine, X } from 'lucide-react'
import type { CodeIteration, Replay, SandboxState } from '../hooks/useSandbox'
import { CritiqueText } from './CritiqueText'
import { diffLines, diffStats } from './lineDiff'
import { STAGE_LABELS } from './buildStages'

const pad = (n: number) => String(n).padStart(2, '0')
type FileStat = { path: string; added: number; removed: number; isNew: boolean }

function AttemptCard({ replay, critique, live, patch, patching }: { replay: Replay; critique: string; live: boolean; patch?: FileStat[]; patching: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const seek = (seconds: number) => { const video = videoRef.current; if (video) { video.pause(); video.currentTime = seconds } }
  const next = pad(replay.iteration + 1)
  return <li className={`timeline-item ${replay.failed ? 'is-failed' : 'is-passed'}`}>
    <span className="timeline-node" aria-hidden="true">{replay.failed ? <X size={11} /> : <CircleCheck size={11} />}</span>
    <article className="timeline-card" aria-label={`Attempt ${replay.iteration}, ${replay.failed ? 'failed' : 'goal reached'}`}>
      <div className="replay-video-wrap timeline-video"><video ref={videoRef} src={replay.videoUrl} preload="metadata" controls muted playsInline loop aria-label={`Recorded bot attempt ${replay.iteration}`} /><span className={`replay-result ${replay.failed ? '' : 'passed'}`}>{replay.failed ? <ScanLine size={11} /> : <CircleCheck size={11} />}{replay.failed ? 'FAILED' : 'GOAL REACHED'}</span></div>
      <div className="timeline-details">
        <h3>Attempt {pad(replay.iteration)}{replay.iteration === 1 ? <small>DRAFT 1</small> : null}</h3>
        <p className="timeline-reason">{replay.failed ? replay.failureReason || 'The bot did not reach the goal.' : `Goal reached ${(replay.frameCount / 30).toFixed(1)} s into the run.`}</p>
        {replay.failed && <section>
          <h4 className="micro-label">{live ? 'CRITIQUE · LIVE' : 'CRITIQUE'}</h4>
          <p className="timeline-critique">{critique ? <CritiqueText text={critique} onSeek={seek} /> : live ? 'The agent is watching this attempt…' : 'No critique was recorded for this attempt.'}</p>
        </section>}
        {replay.failed && <section>
          <h4 className="micro-label">NEXT PATCH → ATTEMPT {next}</h4>
          {patch ? <ul className="timeline-files">{patch.map((f) => <li key={f.path} title={f.path}><FileCode2 size={11} /><span className="code-file-name">{f.path.split('/').at(-1)}</span>{f.isNew && <i className="code-new">NEW</i>}<span className="stat-add">+{f.added}</span><span className="stat-del">−{f.removed}</span></li>)}</ul>
            : <p className="timeline-muted">{patching ? 'Being written now…' : 'No patch was applied after this attempt.'}</p>}
        </section>}
      </div>
    </article>
  </li>
}

/** Every attempt at the current goal on one screen: its clip, outcome, the critique that followed and what the next patch changed. */
export function ReplayTimeline({ state, onClose }: { state: SandboxState; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // Changed-line counts for every patch, keyed by the attempt that patch became.
  const patches = useMemo(() => new Map(state.code.map((entry: CodeIteration) => [entry.iteration, entry.changes.map((c) => ({ path: c.path, isNew: c.before === null, ...diffStats(diffLines(c.before, c.after)) }))])), [state.code])
  const replays = state.replays
  const last = replays.at(-1)
  const winner = replays.find((r) => !r.failed)
  const building = state.build
  return createPortal(<div className="timeline-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <section className="timeline-panel glass-panel" role="dialog" aria-modal="true" aria-labelledby="timeline-title">
      <header className="timeline-heading">
        <div><h2 id="timeline-title">Every attempt</h2><p className="micro-label">{replays.length} {replays.length === 1 ? 'ATTEMPT' : 'ATTEMPTS'}{winner ? ` · GOAL REACHED ON ATTEMPT ${pad(winner.iteration)}` : building ? ' · STILL FIXING' : ''}</p></div>
        <button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close the attempt timeline"><X size={17} /></button>
      </header>
      {replays.length ? <ol className="timeline-list">
        {replays.map((r) => {
          const live = r === last && state.critique.iteration === r.iteration && (state.critique.status === 'watching' || state.critique.status === 'streaming')
          return <AttemptCard key={r.runId} replay={r} critique={live ? state.critique.text : state.critiques[r.iteration] ?? ''} live={live} patch={patches.get(r.iteration + 1)} patching={r === last && !!building} />
        })}
        {building && !(building.kind === 'patch' && (building.stage === 'critique' || building.stage === 'patch')) && <li className="timeline-item is-building"><span className="timeline-node" aria-hidden="true"><LoaderCircle size={11} className="animate-spin" /></span><p className="timeline-muted">Attempt {pad(building.attempt)} is being built: {STAGE_LABELS[building.stage]}.</p></li>}
      </ol> : <p className="timeline-empty">No attempts yet. Each bot run will appear here with its critique and the fix that followed.</p>}
    </section>
  </div>, document.body)
}
