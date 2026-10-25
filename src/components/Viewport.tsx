import { useEffect, useRef } from 'react'
import * as InitialLevel from '../generated/activeLevel'
import { EngineHost } from '../engine/EngineHost'
import { setHostedMounter } from '../hosted/inPageDaemon'
import type { GeneratedLevelModule } from '../engine/types'

let currentModule: GeneratedLevelModule = InitialLevel
let activeHost: EngineHost | null = null
const reportError = (error: unknown) => window.dispatchEvent(new CustomEvent('argon:goal-error', { detail: error instanceof Error ? error.message : String(error) }))

export function Viewport({ onReady }: { onReady: (host: EngineHost | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const host = new EngineHost(canvas)
    activeHost = host
    onReady(host)
    setHostedMounter((module) => host.mountLevel(module))
    void host.initialize(currentModule).catch(reportError)
    const onKey = (event: KeyboardEvent) => {
      host.dispatchPointerOrKey({ type: event.type, key: event.key, code: event.code })
      if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || event.code === 'Space') event.preventDefault()
    }
    const onPointer = (event: PointerEvent) => {
      canvas.focus({ preventScroll: true })
      const bounds = canvas.getBoundingClientRect()
      host.dispatchPointerOrKey({ type: event.type, ndc: [((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1] })
    }
    canvas.addEventListener('keydown', onKey)
    canvas.addEventListener('keyup', onKey)
    canvas.addEventListener('pointerdown', onPointer)
    canvas.addEventListener('pointerup', onPointer)
    const resizeObserver = new ResizeObserver(() => host.resizeViewport())
    resizeObserver.observe(canvas)
    return () => {
      resizeObserver.disconnect()
      canvas.removeEventListener('keydown', onKey); canvas.removeEventListener('keyup', onKey)
      canvas.removeEventListener('pointerdown', onPointer); canvas.removeEventListener('pointerup', onPointer)
      if (activeHost === host) activeHost = null
      onReady(null)
      setHostedMounter(null)
      host.dispose()
    }
  }, [onReady])
  return <canvas ref={canvasRef} className="engine-canvas" tabIndex={0} aria-label="Interactive 3D physics viewport. Click to focus keyboard controls." />
}

if (import.meta.hot) {
  const reportMountFailure = (error: unknown) => {
    reportError(error)
    activeHost?.autonomousLoop.reportMountFailure(error)
  }
  import.meta.hot.accept('../generated/activeLevel', (module) => {
    if (!module || typeof module.buildWorld !== 'function') {
      reportMountFailure(new TypeError('src/generated/activeLevel.ts must export a buildWorld function'))
      return
    }
    currentModule = module as unknown as GeneratedLevelModule
    void activeHost?.mountLevel(currentModule).catch(reportMountFailure)
  })
}
