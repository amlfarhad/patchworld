import { resolve } from 'node:path'
import ts from 'typescript'

export interface GeneratedFile {
  path: string
  content: string
}

const maxFiles = 64
const maxBytes = 12 * 1024 * 1024
const generatedPath = /^src\/generated\/[A-Za-z0-9_.-]+\.(ts|glsl)$/

// Parsed (and bound) source files survive between checks, so library typings such as
// lib.dom.d.ts and three's are parsed once rather than on every patch.
const sourceFileCache = new Map<string, { text: string; file: ts.SourceFile }>()
let previousProgram: ts.Program | undefined

export function validateGeneratedFiles(value: unknown): GeneratedFile[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxFiles) {
    throw new Error(`File batch must contain 1 to ${maxFiles} files`)
  }

  const seen = new Set<string>()
  let totalBytes = 0
  for (const file of value as GeneratedFile[]) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error('Every generated file needs string path and content fields')
    }
    if (!generatedPath.test(file.path) || file.path.split('/').some((part) => part.startsWith('.'))) {
      throw new Error(`Generated path must be a direct TypeScript or GLSL child: ${file.path}`)
    }
    if (seen.has(file.path)) throw new Error(`Duplicate generated path: ${file.path}`)
    seen.add(file.path)
    totalBytes += Buffer.byteLength(file.content, 'utf8')
  }
  if (totalBytes > maxBytes) throw new Error(`File batch exceeds ${maxBytes} byte limit`)

  return (value as GeneratedFile[]).slice().sort((a, b) =>
    Number(a.path.endsWith('/activeLevel.ts')) - Number(b.path.endsWith('/activeLevel.ts')),
  )
}

/**
 * Unused locals, parameters, imports and labels: lint rules from tsconfig, not runtime problems.
 * A generated level with an unused variable runs fine, so it should not cost a model repair pass.
 */
const lintOnlyCodes = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205, 7027, 7028])

export async function checkGeneratedTypeScript(
  files: GeneratedFile[],
  projectRoot: string,
  /** Check only the generated files and what they import (engine types, three, Rapier), not the whole app. */
  options: { generatedOnly?: boolean } = {},
): Promise<string[]> {
  const configPath = resolve(projectRoot, 'tsconfig.app.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) return [formatDiagnostics([config.error], projectRoot)]

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot, undefined, configPath)
  const candidateSources = new Map<string, string>()
  for (const file of files) {
    if (file.path.endsWith('.ts')) candidateSources.set(resolve(projectRoot, file.path), file.content)
  }

  if (candidateSources.size === 0) return []

  const compilerOptions = options.generatedOnly ? { ...parsed.options, types: [] } : parsed.options
  const host = ts.createCompilerHost(compilerOptions)
  const baseFileExists = host.fileExists.bind(host)
  const baseReadFile = host.readFile.bind(host)
  host.fileExists = (fileName) => candidateSources.has(resolve(fileName)) || baseFileExists(fileName)
  host.readFile = (fileName) => candidateSources.get(resolve(fileName)) ?? baseReadFile(fileName)
  host.getSourceFile = (fileName, languageVersion, onError) => {
    const text = candidateSources.get(resolve(fileName)) ?? baseReadFile(fileName)
    if (text === undefined) {
      onError?.(`File not found: ${fileName}`)
      return undefined
    }
    const cached = sourceFileCache.get(fileName)
    if (cached?.text === text) return cached.file
    const file = ts.createSourceFile(fileName, text, languageVersion)
    sourceFileCache.set(fileName, { text, file })
    return file
  }

  const rootNames = options.generatedOnly ? [...candidateSources.keys()] : [...new Set([...parsed.fileNames, ...candidateSources.keys()])]
  const program = ts.createProgram({ rootNames, options: compilerOptions, host, oldProgram: previousProgram })
  previousProgram = program
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && !lintOnlyCodes.has(diagnostic.code))
  return diagnostics.length === 0 ? [] : [formatDiagnostics(diagnostics, projectRoot)]
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], projectRoot: string): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => projectRoot,
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => '\n',
  })
}
