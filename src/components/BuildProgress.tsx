import { useEffect, useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import type { SandboxState } from '../hooks/useSandbox'
import { STAGE_LABELS, STAGE_ORDER, estimate, formatDuration } from './buildStages'

const pad = (n: number) => String(n).padStart(2, '0')

/** While a world or patch is being built: its stages with the current one highlighted, elapsed time and an estimated bar. */
export function BuildProgress({ state }: { state: SandboxState }) {
  const build = state.build
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!build) return
    const tick = () => setNow(Date.now())
    const id = window.setInterval(tick, 1000)
    const first = window.setTimeout(tick, 0)
    return () => { window.clearInterval(id); window.clearTimeout(first) }
  }, [build])
  if (!build) return null
  const order = STAGE_ORDER[build.kind]
  const current = order.indexOf(build.stage)
  const elapsed = Math.max(0, (now - build.startedAt) / 1000)
  const typical = estimate(build.kind, state.mock, state.patchSeconds)
  const over = elapsed > typical.seconds * 1.15
  const fill = Math.min(0.97, elapsed / typical.seconds)
  const title = build.kind === 'world' ? 'BUILDING THE FIRST WORLD' : build.kind === 'twist' ? `APPLYING YOUR TWIST · ATTEMPT ${pad(build.attempt)}` : `FIXING ATTEMPT ${pad(build.attempt - 1)} → ATTEMPT ${pad(build.attempt)}`
  // Keyed by cycle so a new cycle starts with an empty bar instead of animating back down from the last one.
  return <section key={build.startedAt} className="build-progress" aria-label="Build progress">
    <div className="build-head"><span>{title}</span><span className="build-time"><b>{formatDuration(elapsed)}</b> elapsed</span></div>
    <div className={`build-bar ${over ? 'build-over' : ''}`} role="progressbar" aria-label={`Estimated progress, typical ${typical.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)}><i style={{ transform: `scaleX(${fill})` }} /></div>
    <div className="build-estimate">{over ? `Taking longer than the usual ${typical.label}. Still working.` : `Estimate: usually ${typical.label}`}</div>
    <ol className="build-stages">{order.map((id, i) => <li key={id} className={i < current ? 'stage-done' : i === current ? 'stage-current' : 'stage-todo'} aria-current={i === current ? 'step' : undefined}>
      <span className="stage-mark" aria-hidden="true">{i < current ? <Check size={10} /> : i === current ? <LoaderCircle size={10} className="animate-spin" /> : null}</span>{STAGE_LABELS[id]}
    </li>)}</ol>
  </section>
}
