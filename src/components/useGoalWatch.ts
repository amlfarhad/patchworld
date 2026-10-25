import { useEffect, useState } from 'react'
import type { EngineHost } from '../engine/EngineHost'
import { evaluateLevelGoal } from '../engine/goalEvaluator'
import type { LevelGoal } from '../engine/types'

/**
 * While a person plays, checks the level's declared goal each animation frame (read-only, with the
 * engine's own evaluator) and dispatches `argon:human-won` with the time taken. A win only counts
 * after the goal was unmet at some point, so a level the bot left solved is reported as `solved`
 * (reset it to play) instead of as the person's win. Restarts on every level mount.
 */
export function useGoalWatch(host: EngineHost | null, goal: LevelGoal | null, active: boolean, mountKey: number): boolean {
  const [solved, setSolved] = useState(false)
  useEffect(() => {
    if (!host || !goal || !active) return
    let armed = false
    let startedAt = 0
    let lastSolved: boolean | null = null
    let frame = 0
    const tick = () => {
      const met = evaluateLevelGoal(goal, host.namedBodies)
      if (!met && !armed) { armed = true; startedAt = performance.now() }
      if (met && armed) {
        setSolved(false)
        window.dispatchEvent(new CustomEvent('argon:human-won', { detail: { seconds: (performance.now() - startedAt) / 1000 } }))
        return
      }
      const nowSolved = met && !armed
      if (nowSolved !== lastSolved) { lastSolved = nowSolved; setSolved(nowSolved) }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); setSolved(false) }
  }, [host, goal, active, mountKey])
  return solved
}
