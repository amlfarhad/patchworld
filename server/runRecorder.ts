import { mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { GeneratedFile } from './generatedFiles.ts'

export interface RecordedStep {
  files: GeneratedFile[]
  diagnosis?: string
  skillContent?: string
}

/**
 * Saves each patch of a live run as a mock script (script.json plus one file per generated
 * module), so a good run can be replayed later with `--mock=<folder>`.
 */
export class RunRecorder {
  private readonly steps: Array<{ files: Record<string, string>; diagnosis?: string; skillContent?: string }> = []
  private tail = Promise.resolve()

  private constructor(readonly directory: string, private readonly goal: string) {}

  static async start(goal: string, root: string, now = new Date()): Promise<RunRecorder> {
    const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'goal'
    const directory = resolve(root, `${now.toISOString().replace(/[:.]/g, '-')}-${slug}`)
    await mkdir(directory, { recursive: true })
    return new RunRecorder(directory, goal)
  }

  record(step: RecordedStep): Promise<void> {
    this.tail = this.tail.catch(() => {}).then(() => this.write(step))
    return this.tail
  }

  private async write(step: RecordedStep): Promise<void> {
    const prefix = `step${String(this.steps.length + 1).padStart(2, '0')}`
    const files: Record<string, string> = {}
    for (const file of step.files) {
      const name = `${prefix}-${basename(file.path)}`
      await writeFile(resolve(this.directory, name), file.content, 'utf8')
      files[file.path] = name
    }
    this.steps.push({ files, diagnosis: step.diagnosis, skillContent: step.skillContent })
    await writeFile(resolve(this.directory, 'script.json'), JSON.stringify({ goal: this.goal, steps: this.steps }, null, 2), 'utf8')
  }
}
