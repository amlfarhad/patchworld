import { transform } from 'sucrase'
import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import * as RAPIER_NAMESPACE from '@dimforge/rapier3d-compat'
import * as BREAKAGE_KIT from '../engine/breakageKit'
import * as ASSET_KIT from '../engine/assetKit'
import type { GeneratedLevelModule } from '../engine/types'
import type { GeneratedFilePayload } from '../shared/protocol'

/**
 * Hosted builds have no Vite dev server to hot-reload src/generated/, so generated levels are
 * compiled here and loaded as ES modules from blob URLs. Imports of `three` and Rapier resolve to
 * the instances the engine already uses, so meshes and bodies interoperate with the host.
 */

declare global {
  var __patchworld: { three: unknown; rapier: unknown; rapierNamespace: unknown; breakageKit: unknown; assetKit: unknown } | undefined
}

const shimUrls = new Map<string, string>()
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function shimModule(globalKey: 'three' | 'rapierNamespace' | 'breakageKit' | 'assetKit', defaultKey: 'three' | 'rapier' | 'breakageKit' | 'assetKit', names: string[]): string {
  const lines = [`const M = globalThis.__patchworld.${globalKey};`, `export default globalThis.__patchworld.${defaultKey};`]
  for (const name of names) if (identifier.test(name) && name !== 'default') lines.push(`export const ${name} = M[${JSON.stringify(name)}];`)
  return lines.join('\n')
}

function shimFor(specifier: string): string | null {
  const cached = shimUrls.get(specifier)
  if (cached) return cached
  let source: string | null = null
  if (specifier === 'three') source = shimModule('three', 'three', Object.keys(THREE))
  else if (specifier === '@dimforge/rapier3d-compat') source = shimModule('rapierNamespace', 'rapier', Object.keys(RAPIER_NAMESPACE))
  // The physics and visual helpers generated levels may import at run time.
  else if (specifier === '../engine/breakageKit') source = shimModule('breakageKit', 'breakageKit', Object.keys(BREAKAGE_KIT))
  else if (specifier === '../engine/assetKit') source = shimModule('assetKit', 'assetKit', Object.keys(ASSET_KIT))
  else if (/^\.\.\/engine\//.test(specifier)) source = 'export {}' // type-only host modules
  if (source === null) return null
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  shimUrls.set(specifier, url)
  return url
}

const importPattern = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\2/g

/** Compiles and imports a generated file set; returns the activeLevel module. */
export async function loadGeneratedLevel(files: GeneratedFilePayload[]): Promise<GeneratedLevelModule> {
  globalThis.__patchworld = { three: THREE, rapier: RAPIER, rapierNamespace: RAPIER_NAMESPACE, breakageKit: BREAKAGE_KIT, assetKit: ASSET_KIT }
  const byName = new Map(files.map((file) => [file.path.split('/').at(-1)!.replace(/\.ts$/, ''), file]))
  const urls = new Map<string, string>()
  const loading = new Set<string>()
  const created: string[] = []

  const compile = (name: string): string => {
    const existing = urls.get(name)
    if (existing) return existing
    if (loading.has(name)) throw new Error(`Generated files import each other in a cycle at ${name}.ts`)
    const file = byName.get(name)
    if (!file) throw new Error(`Generated code imports ./${name}, which was not generated`)
    loading.add(name)
    let code: string
    try {
      code = transform(file.content, { transforms: ['typescript'], filePath: file.path }).code
    } catch (error) {
      throw new Error(`${file.path} could not be compiled: ${error instanceof Error ? error.message : String(error)}`)
    }
    code = code.replace(importPattern, (_match, prefix: string, quote: string, specifier: string) => {
      if (specifier.startsWith('./')) return `${prefix}${quote}${compile(specifier.slice(2).replace(/\.(ts|js)$/, ''))}${quote}`
      const shim = shimFor(specifier)
      if (!shim) throw new Error(`${file.path} imports "${specifier}", which levels may not use`)
      return `${prefix}${quote}${shim}${quote}`
    })
    loading.delete(name)
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    created.push(url)
    urls.set(name, url)
    return url
  }

  try {
    const entryUrl = compile('activeLevel')
    const module = (await import(/* @vite-ignore */ entryUrl)) as Partial<GeneratedLevelModule>
    if (typeof module.buildWorld !== 'function') throw new TypeError('activeLevel.ts must export a buildWorld function')
    return module as GeneratedLevelModule
  } finally {
    // The modules are evaluated once imported; their URLs are no longer needed.
    created.forEach((url) => URL.revokeObjectURL(url))
  }
}
