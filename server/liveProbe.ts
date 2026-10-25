// Live probe: runs world generation against the real Gemini API without a browser and reports timings.
// Usage: npm run probe:live -- "optional goal text"
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ArgonOrchestrator } from './argonOrchestrator.js'
import { checkGeneratedTypeScript, validateGeneratedFiles } from './generatedFiles.js'

const goal = process.argv.slice(2).join(' ').trim()
  || 'Build a catapult that launches a boulder through a bridge and drops a red boss cube into a lava pit.'
const projectRoot = process.cwd()
const started = Date.now()
const seconds = () => ((Date.now() - started) / 1000).toFixed(1)

const orchestrator = new ArgonOrchestrator((event) => {
  const detail = event.terminal ? ` [tool output ${event.terminal.length} chars]` : ''
  console.log(`[${seconds()}s] ${event.phase}: ${event.message}${detail}`)
})

try {
  const patch = await orchestrator.generateInitialWorld(goal, (files) => checkGeneratedTypeScript(validateGeneratedFiles(files), projectRoot))
  const outDir = resolve(projectRoot, 'artifacts/probe')
  await mkdir(outDir, { recursive: true })
  for (const file of patch.files) await writeFile(resolve(outDir, file.path.split('/').at(-1)!), file.content)
  const bytes = patch.files.reduce((sum, file) => sum + file.content.length, 0)
  console.log(`[${seconds()}s] OK: ${patch.files.length} file(s), ${bytes} chars, written to artifacts/probe/`)
} catch (error) {
  console.error(`[${seconds()}s] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
