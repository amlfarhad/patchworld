import type { GeneratedFile } from './generatedFiles.js'

/** A targeted change: replace the one occurrence of `find` in `path` with `replace`. */
export interface FileEdit {
  path: string
  find: string
  replace: string
}

/**
 * Applies edits to the current generated files. Every edit's `find` must occur exactly once in its
 * file (after earlier edits), so an ambiguous or stale edit is reported instead of guessed at.
 * Returns the full content of every file an edit touched.
 */
export function applyEdits(currentFiles: readonly GeneratedFile[], edits: readonly FileEdit[]): { files: GeneratedFile[]; errors: string[] } {
  const contents = new Map(currentFiles.map((file) => [file.path, file.content]))
  const touched = new Set<string>()
  const errors: string[] = []
  edits.forEach((edit, index) => {
    const content = contents.get(edit.path)
    if (content === undefined) {
      errors.push(`Edit ${index + 1}: ${edit.path} does not exist; send new files whole in "files".`)
      return
    }
    if (!edit.find) {
      errors.push(`Edit ${index + 1}: "find" is empty.`)
      return
    }
    const first = content.indexOf(edit.find)
    if (first < 0) {
      errors.push(`Edit ${index + 1} in ${edit.path}: the "find" text does not appear in the current file.`)
      return
    }
    if (content.indexOf(edit.find, first + 1) >= 0) {
      errors.push(`Edit ${index + 1} in ${edit.path}: the "find" text appears more than once; include more surrounding lines.`)
      return
    }
    contents.set(edit.path, content.slice(0, first) + edit.replace + content.slice(first + edit.find.length))
    touched.add(edit.path)
  })
  return { files: [...touched].map((path) => ({ path, content: contents.get(path)! })), errors }
}

/** Merges whole files over edited files; whole files win. activeLevel.ts is always included. */
export function mergePatchFiles(currentFiles: readonly GeneratedFile[], edited: readonly GeneratedFile[], whole: readonly GeneratedFile[]): GeneratedFile[] {
  const merged = new Map<string, string>()
  for (const file of edited) merged.set(file.path, file.content)
  for (const file of whole) merged.set(file.path, file.content)
  const entry = 'src/generated/activeLevel.ts'
  if (!merged.has(entry)) {
    const current = currentFiles.find((file) => file.path === entry)
    if (current) merged.set(entry, current.content)
  }
  return [...merged].map(([path, content]) => ({ path, content }))
}
