import type { ReactNode } from 'react'

const TIMESTAMP = /\b(\d{1,2}):([0-5]\d)(?:\.(\d+))?\b/g

/** Renders critique text with the video timestamps the agent cites ("At 0:03 …") as buttons that seek the replay. */
export function CritiqueText({ text, onSeek }: { text: string; onSeek: (seconds: number) => void }) {
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
