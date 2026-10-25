import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { FailedRunInput, GeneratedPatch } from './argonOrchestrator.ts'
import { validateGeneratedFiles, type GeneratedFile } from './generatedFiles.ts'
import type { TwistInput, ValidateFiles, WorldEvent, WorldOrchestrator } from './orchestrator.ts'

export interface MockStep {
  files: GeneratedFile[]
  diagnosis?: string
  skillContent?: string
}

export interface MockScript {
  name: string
  goal: string
  steps: MockStep[]
}

/**
 * A script name maps to src/fixtures/<name>.script.json. Anything with a slash or a .json
 * extension is a path to a script file, or to a run folder recorded by RunRecorder.
 */
export async function resolveMockScriptPath(nameOrPath: string, projectRoot: string): Promise<string> {
  if (!/[\\/]/.test(nameOrPath) && !nameOrPath.endsWith('.json')) {
    return resolve(projectRoot, 'src/fixtures', `${nameOrPath}.script.json`)
  }
  const target = isAbsolute(nameOrPath) ? nameOrPath : resolve(projectRoot, nameOrPath)
  return (await stat(target)).isDirectory() ? resolve(target, 'script.json') : target
}

/** The recorded Gemini run (src/fixtures/cached-<name>.script.json) for exactly this goal, i.e. a quick-start preset. */
export async function findCachedScript(goal: string, projectRoot: string): Promise<string | null> {
  const folder = resolve(projectRoot, 'src/fixtures')
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => /^cached-.+.script.json$/.test(name))
  for (const name of names) {
    try {
      const script = JSON.parse(await readFile(resolve(folder, name), 'utf8')) as { goal?: unknown }
      if (script.goal === goal.trim()) return name.replace(/.script.json$/, '')
    } catch { /* A broken script is skipped; the goal then runs live. */ }
  }
  return null
}

export async function loadMockScript(nameOrPath: string, projectRoot: string): Promise<MockScript> {
  const scriptPath = await resolveMockScriptPath(nameOrPath, projectRoot)
  const raw: unknown = JSON.parse(await readFile(scriptPath, 'utf8'))
  const steps = (raw as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps) || steps.length === 0) throw new Error(`Mock script ${scriptPath} needs a non-empty steps array`)
  const baseDir = dirname(resolve(scriptPath))
  const loaded = await Promise.all(steps.map(async (step: unknown, index): Promise<MockStep> => {
    const entry = step as { files?: unknown; diagnosis?: unknown; skillContent?: unknown } | null
    if (!entry?.files || typeof entry.files !== 'object') throw new Error(`Mock script step ${index + 1} needs a files map`)
    const files = await Promise.all(Object.entries(entry.files).map(async ([path, source]) => {
      if (typeof source !== 'string') throw new Error(`Mock script step ${index + 1}: ${path} must name a file`)
      const sourcePath = resolve(baseDir, source)
      if (dirname(sourcePath) !== baseDir) throw new Error(`Mock script step ${index + 1} reads outside its folder: ${source}`)
      return { path, content: await readFile(sourcePath, 'utf8') }
    }))
    return {
      files: validateGeneratedFiles(files),
      diagnosis: typeof entry.diagnosis === 'string' ? entry.diagnosis : undefined,
      skillContent: typeof entry.skillContent === 'string' ? entry.skillContent : undefined,
    }
  }))
  const goal = (raw as { goal?: unknown }).goal
  return { name: nameOrPath, goal: typeof goal === 'string' ? goal : '', steps: loaded }
}

function delayScaleFromEnv(): number {
  const value = Number(process.env.ARGON_MOCK_SPEED ?? 1)
  return Number.isFinite(value) && value >= 0 ? value : 1
}

/**
 * Replays a scripted run through the same daemon path as live generation, with realistic
 * pauses and a streamed critique. Step 0 is the first draft; the critique of iteration N
 * returns step N. Makes no network calls and needs no API key.
 */
export class MockOrchestrator implements WorldOrchestrator {
  private script?: Promise<MockScript>

  constructor(
    private readonly emit: (event: WorldEvent) => void,
    private readonly scriptName: string,
    private readonly projectRoot: string,
    private readonly delayScale = delayScaleFromEnv(),
  ) {}

  async generateInitialWorld(_goal: string, validate: ValidateFiles): Promise<GeneratedPatch> {
    const script = await this.loadScript()
    this.emit({ phase: 'synthesizing', message: `Mock mode: replaying the scripted "${script.name}" run instead of calling Gemini.` })
    for (const message of ['Laying out the level…', 'Placing bodies and colliders…', 'Writing the bot…']) {
      await this.wait(1_500)
      this.emit({ phase: 'thinking', message })
    }
    await this.wait(1_000)
    return this.patchFor(script, 0, validate)
  }

  async critiqueAndPatchWorld(input: FailedRunInput, validate: ValidateFiles): Promise<GeneratedPatch> {
    const script = await this.loadScript()
    const step = script.steps[input.iteration]
    if (!step) {
      throw new Error(`Mock script "${script.name}" has no step after iteration ${input.iteration}, and that level still fails: ${input.metadata.failureReason ?? 'goal not reached'}`)
    }
    this.emit({ phase: 'critiquing', message: `Mock mode: replaying the scripted critique of iteration ${input.iteration}.`, iteration: input.iteration })
    await this.wait(1_200)
    await this.streamCritique(step.diagnosis ?? 'The script has no critique for this step.', input.iteration)
    await this.wait(800)
    this.emit({ phase: 'thinking', message: 'Patching the level…', iteration: input.iteration })
    await this.wait(1_200)
    return this.patchFor(script, input.iteration, validate)
  }

  async reviseWorld(input: TwistInput, validate: ValidateFiles): Promise<GeneratedPatch> {
    const script = await this.loadScript()
    this.emit({ phase: 'synthesizing', message: `Mock mode cannot apply new twists, so "${input.twist}" reloads the final scripted level.` })
    await this.wait(1_500)
    return this.patchFor(script, script.steps.length - 1, validate)
  }

  private loadScript(): Promise<MockScript> {
    this.script ??= loadMockScript(this.scriptName, this.projectRoot)
    return this.script
  }

  private async streamCritique(text: string, iteration: number): Promise<void> {
    const pieces = text.split(/(\s+)/)
    let shown = ''
    for (let index = 0; index < pieces.length; index += 6) {
      shown += pieces.slice(index, index + 6).join('')
      this.emit({ phase: 'critiquing', message: '', critiqueText: shown, critiqueFinal: false, iteration })
      await this.wait(90)
    }
    this.emit({ phase: 'critiquing', message: '', critiqueText: text, critiqueFinal: true, iteration })
  }

  private async patchFor(script: MockScript, index: number, validate: ValidateFiles): Promise<GeneratedPatch> {
    const step = script.steps[index]
    const diagnostics = await validate(step.files)
    if (diagnostics.length > 0) {
      throw new Error(`Mock script "${script.name}" step ${index + 1} fails the typecheck:\n${diagnostics.join('\n')}`)
    }
    return { files: step.files, diagnosis: step.diagnosis, skillContent: step.skillContent, interactionId: `mock-${index + 1}` }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms * this.delayScale))
  }
}
