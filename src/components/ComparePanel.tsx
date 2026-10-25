import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CircleCheck, Play, ScanLine, X } from 'lucide-react'
import type { Replay } from '../hooks/useSandbox'

const pad = (n: number) => String(n).padStart(2, '0')

/** Draft 1 and the winning run side by side, for the "here is what it fixed" moment of the demo. */
export function ComparePanel({ draft, winner, draftNotes, onClose }: { draft: Replay; winner: Replay; draftNotes: string; onClose: () => void }) {
  const draftRef = useRef<HTMLVideoElement>(null)
  const winnerRef = useRef<HTMLVideoElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const playBoth = () => [draftRef.current, winnerRef.current].forEach((video) => { if (video) { video.currentTime = 0; void video.play().catch(() => {}) } })
  return createPortal(<div className="compare-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <section className="compare-panel glass-panel" role="dialog" aria-modal="true" aria-labelledby="compare-title">
      <header className="compare-heading">
        <div><h2 id="compare-title">Draft 1 vs the winning run</h2><p className="micro-label">SAME GOAL · FIXED BY THE AGENT ON ITERATION {pad(winner.iteration)}</p></div>
        <div className="flex items-center gap-2"><button type="button" className="compare-play" onClick={playBoth}><Play size={12} />Play both</button><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close comparison"><X size={17} /></button></div>
      </header>
      <div className="compare-grid">
        <figure>
          <div className="replay-video-wrap"><video ref={draftRef} src={draft.videoUrl} autoPlay loop muted playsInline controls aria-label="Draft 1 attempt" /><span className="replay-result"><ScanLine size={11} />DRAFT 1 · FAILED</span></div>
          <figcaption>{draftNotes || 'The first draft did not reach the goal.'}</figcaption>
        </figure>
        <figure>
          <div className="replay-video-wrap"><video ref={winnerRef} src={winner.videoUrl} autoPlay loop muted playsInline controls aria-label="Winning attempt" /><span className="replay-result passed"><CircleCheck size={11} />ITER {pad(winner.iteration)} · GOAL REACHED</span></div>
          <figcaption>Goal reached {(winner.frameCount / 30).toFixed(1)} s into the run. Your turn: take over and play it.</figcaption>
        </figure>
      </div>
    </section>
  </div>, document.body)
}
