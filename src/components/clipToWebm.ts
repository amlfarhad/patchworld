export interface ConvertedClip { blob: Blob; seconds: number; width: number; height: number }

/**
 * Re-encodes the start of a phone clip (MP4, MOV, WebM…) as a small WebM in the browser: plays it into
 * a canvas whose longer side is at most `maxSide` and records that with MediaRecorder, the same way playtests are
 * recorded. Only WebM crosses the local WebSocket (AGENTS.md). Runs in real time; rejects when the
 * browser cannot decode the file.
 */
export async function clipToWebm(file: File, onProgress: (fraction: number) => void, maxSeconds = 10, maxSide = 640): Promise<ConvertedClip> {
  const url = URL.createObjectURL(file)
  const video = Object.assign(document.createElement('video'), { src: url, muted: true, playsInline: true, preload: 'auto' })
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('This browser cannot play that video. Try exporting it as an H.264 MP4 or a WebM.'))
    })
    const seconds = Math.min(Number.isFinite(video.duration) ? video.duration : maxSeconds, maxSeconds)
    if (!video.videoWidth || seconds <= 0) throw new Error('That file has no video track.')
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight))
    const width = Math.round((video.videoWidth * scale) / 2) * 2
    const height = Math.round((video.videoHeight * scale) / 2) * 2
    const canvas = Object.assign(document.createElement('canvas'), { width, height })
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is unavailable.')
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) throw new Error('This browser cannot record WebM.')
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType, videoBitsPerSecond: 600_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
    recorder.start(250)
    await video.play()
    await new Promise<void>((resolve) => {
      const draw = () => {
        context.drawImage(video, 0, 0, width, height)
        onProgress(Math.min(1, video.currentTime / seconds))
        if (video.ended || video.currentTime >= seconds) resolve()
        else requestAnimationFrame(draw)
      }
      requestAnimationFrame(draw)
    })
    video.pause()
    recorder.stop()
    await stopped
    onProgress(1)
    return { blob: new Blob(chunks, { type: 'video/webm' }), seconds, width, height }
  } finally {
    video.removeAttribute('src')
    URL.revokeObjectURL(url)
  }
}
