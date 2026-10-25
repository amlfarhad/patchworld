// Drives a headless Chrome through one preset run and reports the phases it saw.
// Usage: node scripts/headlessCheck.mjs <url> [preset name] [timeout seconds]
// Hidden browser tabs get no animation frames, so this is the reliable way to check the loop unattended.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const url = process.argv[2] ?? 'http://localhost:5180'
const preset = process.argv[3] ?? 'Catapult chaos'
const timeoutSeconds = Number(process.argv[4] ?? 120)
const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const port = 9341
const profile = mkdtempSync(join(tmpdir(), 'pw-chrome-'))

const browser = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
let targets
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(250)
  targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => undefined)
}
const page = targets.find((t) => t.type === 'page')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((done) => socket.once('open', done))
let id = 0
const pending = new Map()
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString())
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') console.log('[page error]', message.params.args.map((a) => a.value ?? a.description).join(' '))
  if (message.method === 'Runtime.exceptionThrown') console.log('[page exception]', message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
})
const send = (method, params = {}) => new Promise((done) => { const call = ++id; pending.set(call, done); socket.send(JSON.stringify({ id: call, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url })
await sleep(4000)
if (process.env.LIVE === '1') {
  // Switch the hosted page to Live mode (an empty passcode works when the deployment has none).
  await evaluate(`localStorage.setItem('patchworld.livePasscode', ${JSON.stringify(process.env.PASSCODE || 'open')})`)
  await send('Page.reload')
  await sleep(4000)
  console.log('mode:', await evaluate(`document.querySelector('.mode-chip')?.innerText`))
}
const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(preset)})); b?.click(); return !!b })()`)
console.log(`clicked "${preset}": ${clicked}`)

const seen = []
let outcome = 'timeout'
for (let s = 0; s < timeoutSeconds; s++) {
  await sleep(1000)
  const state = await evaluate(`({ title: document.querySelector('.ticker-title')?.innerText, detail: document.querySelector('.ticker-detail')?.innerText, passed: !!document.querySelector('.replay-result.passed'), error: document.querySelector('.prompt-error')?.innerText ?? '' })`)
  const label = `${state.title} | ${state.detail}`
  if (seen.at(-1) !== label) { seen.push(label); console.log(`[${s}s] ${label}`) }
  if (state.passed && state.title === 'LEVEL UP!') { outcome = 'passed'; break }
  if (state.title === 'ATTENTION REQUIRED') { outcome = `error: ${state.error}`; break }
}
const summary = await evaluate(`({ tabs: [...document.querySelectorAll('[role=tab]')].map((t) => t.innerText.replace(/\\n/g, ' ')), notes: document.querySelector('.critique-block p')?.innerText })`)
console.log('outcome:', outcome)
console.log('tabs:', summary?.tabs?.join(' · '))
console.log('notes:', summary?.notes)
socket.close()
browser.kill()
await sleep(500)
try { rmSync(profile, { recursive: true, force: true }) } catch { /* Chrome may still hold files briefly */ }
process.exit(outcome === 'passed' ? 0 : 1)
