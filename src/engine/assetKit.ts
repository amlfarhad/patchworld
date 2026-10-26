import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

export type Vec3 = [number, number, number]

export interface AssetOptions {
  position?: Vec3
  scale?: number | Vec3
  color?: number
}

export interface PlatformTileOptions extends AssetOptions {
  size?: Vec3
  topColor?: number
}

export type ProceduralSurfaceKind = 'stone' | 'wood' | 'metal' | 'tech'

const materialCache = new Map<string, THREE.MeshPhysicalMaterial>()
const textureCache = new Map<string, THREE.CanvasTexture>()

/**
 * Generates a deterministic, tileable grayscale procedural CanvasTexture for bumpMap / roughnessMap micro-relief.
 * Safe in both browser and headless/Node environments (returns a 1x1 DataTexture fallback if document is absent).
 */
export function getProceduralNoiseTexture(
  kind: ProceduralSurfaceKind = 'stone',
  size = 128,
): THREE.Texture {
  const key = `${kind}_${size}`
  const existing = textureCache.get(key)
  if (existing) return existing

  if (typeof document === 'undefined') {
    const data = new Uint8Array([128, 128, 128, 255])
    const fallback = new THREE.DataTexture(data, 1, 1)
    fallback.needsUpdate = true
    return fallback
  }

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    let seed =
      kind === 'stone' ? 104729 : kind === 'wood' ? 224737 : kind === 'metal' ? 350377 : 49979693
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0xffffffff
    }

    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4
        let v = 128
        if (kind === 'wood') {
          const grain = Math.sin((x / size) * Math.PI * 10 + Math.sin((y / size) * Math.PI * 4) * 1.5)
          v = Math.round(128 + grain * 42 + (nextRand() - 0.5) * 24)
        } else if (kind === 'metal') {
          const streak = Math.sin((x / size) * Math.PI * 24) * 14
          v = Math.round(132 + streak + (nextRand() - 0.5) * 32)
        } else if (kind === 'tech') {
          const grid = x % 16 === 0 || y % 16 === 0 ? -36 : (x + y) % 8 === 0 ? 18 : 0
          v = Math.round(130 + grid + (nextRand() - 0.5) * 16)
        } else {
          const cell =
            Math.sin((x / size) * Math.PI * 6) * Math.cos((y / size) * Math.PI * 6) * 32
          v = Math.round(126 + cell + (nextRand() - 0.5) * 58)
        }
        const clamped = Math.max(0, Math.min(255, v))
        d[idx] = clamped
        d[idx + 1] = clamped
        d[idx + 2] = clamped
        d[idx + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(2, 2)
  tex.needsUpdate = true
  textureCache.set(key, tex)
  return tex
}

export interface PBRMaterialOptions {
  color: number
  roughness?: number
  metalness?: number
  emissive?: number
  emissiveIntensity?: number
  clearcoat?: number
  clearcoatRoughness?: number
  surface?: ProceduralSurfaceKind
  bumpKind?: ProceduralSurfaceKind
  bumpScale?: number
}

export function createPBRMaterial(options: PBRMaterialOptions): THREE.MeshPhysicalMaterial {
  const {
    color,
    roughness = 0.6,
    metalness = 0.1,
    emissive = 0x000000,
    emissiveIntensity = 0,
    clearcoat = 0,
    clearcoatRoughness = 0.2,
    bumpScale = 0.015,
  } = options
  const surface = options.surface ?? options.bumpKind
  const key = `${color}_${roughness}_${metalness}_${emissive}_${emissiveIntensity}_${clearcoat}_${clearcoatRoughness}_${surface ?? 'none'}_${bumpScale}`
  const existing = materialCache.get(key)
  if (existing) return existing

  const bumpMap = surface ? getProceduralNoiseTexture(surface) : null
  const mat = new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness,
    emissive,
    emissiveIntensity,
    clearcoat,
    clearcoatRoughness,
    ...(bumpMap ? { bumpMap, bumpScale } : {}),
  })
  materialCache.set(key, mat)
  return mat
}

function getMaterial(
  color: number,
  roughness = 0.65,
  metalness = 0.08,
  emissive = 0x000000,
  emissiveIntensity = 0,
  clearcoat = 0,
  surface?: ProceduralSurfaceKind,
): THREE.MeshPhysicalMaterial {
  return createPBRMaterial({
    color,
    roughness,
    metalness,
    emissive,
    emissiveIntensity,
    clearcoat,
    surface,
  })
}

function applyTransform(group: THREE.Group, options?: AssetOptions): THREE.Group {
  if (options?.position) {
    group.position.set(options.position[0], options.position[1], options.position[2])
  }
  if (options?.scale !== undefined) {
    if (typeof options.scale === 'number') {
      group.scale.setScalar(options.scale)
    } else {
      group.scale.set(options.scale[0], options.scale[1], options.scale[2])
    }
  }
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && !mesh.userData.noShadow) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })
  return group
}

function addPart(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  pos: Vec3,
  rot?: Vec3,
  scale?: Vec3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(pos[0], pos[1], pos[2])
  if (rot) mesh.rotation.set(rot[0], rot[1], rot[2])
  if (scale) mesh.scale.set(scale[0], scale[1], scale[2])
  parent.add(mesh)
  return mesh
}

/**
 * Articulated 18-part Cyber-Knight / Siege Vanguard character:
 * Primary silhouette (armored torso, helmet, thrusters), secondary read (pauldrons, articulated limbs, boots),
 * and accent details (glossy clearcoat visor, chest arc core, antenna, gauntlets).
 * Origin is centered at the character's vertical midpoint (height ~1.25m, radius ~0.36m).
 */
export function createCharacter(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-character'

  const primaryColor = options.color ?? 0x2563eb
  const armorMat = getMaterial(primaryColor, 0.38, 0.45, 0x000000, 0, 0.35, 'metal')
  const trimMat = getMaterial(0xf59e0b, 0.28, 0.78, 0x78350f, 0.15, 0.4, 'metal')
  const undersuitMat = getMaterial(0x1e293b, 0.72, 0.18, 0x000000, 0, 0, 'tech')
  const visorMat = getMaterial(0x38bdf8, 0.12, 0.25, 0x0284c7, 0.85, 0.95)
  const coreMat = getMaterial(0x67e8f9, 0.15, 0.1, 0x06b6d4, 1.35, 0.8)
  const bootMat = getMaterial(0x0f172a, 0.55, 0.5, 0x000000, 0, 0.2, 'metal')

  // 1. Torso chassis & waist belt
  addPart(group, new THREE.BoxGeometry(0.48, 0.46, 0.3), armorMat, [0, 0.0, 0])
  addPart(group, new THREE.BoxGeometry(0.44, 0.12, 0.28), undersuitMat, [0, -0.24, 0])
  addPart(group, new THREE.BoxGeometry(0.47, 0.07, 0.31), trimMat, [0, -0.2, 0])

  // Chest arc reactor emblem
  addPart(
    group,
    new THREE.CylinderGeometry(0.08, 0.08, 0.04, 12),
    coreMat,
    [0, 0.04, 0.15],
    [Math.PI / 2, 0, 0],
  )

  // 2. Jetpack & dual thruster nozzles
  addPart(group, new THREE.BoxGeometry(0.36, 0.38, 0.18), trimMat, [0, 0.02, -0.22])
  addPart(group, new THREE.CylinderGeometry(0.055, 0.08, 0.14, 10), bootMat, [-0.1, -0.18, -0.23])
  addPart(group, new THREE.CylinderGeometry(0.055, 0.08, 0.14, 10), bootMat, [0.1, -0.18, -0.23])
  addPart(group, new THREE.SphereGeometry(0.045, 8, 8), coreMat, [-0.1, -0.25, -0.23])
  addPart(group, new THREE.SphereGeometry(0.045, 8, 8), coreMat, [0.1, -0.25, -0.23])

  // 3. Sculpted Helmet, Crest, Visor & Antenna
  const headGroup = new THREE.Group()
  headGroup.position.set(0, 0.42, 0)
  addPart(headGroup, new THREE.BoxGeometry(0.42, 0.38, 0.4), armorMat, [0, 0, 0])
  addPart(headGroup, new THREE.BoxGeometry(0.45, 0.1, 0.44), trimMat, [0, 0.18, 0.02])
  addPart(headGroup, new THREE.BoxGeometry(0.1, 0.12, 0.46), trimMat, [0, 0.24, -0.01])
  addPart(headGroup, new THREE.BoxGeometry(0.36, 0.14, 0.06), visorMat, [0, 0.02, 0.19])
  addPart(headGroup, new THREE.CylinderGeometry(0.015, 0.02, 0.22, 6), trimMat, [0.22, 0.18, -0.05])
  addPart(headGroup, new THREE.SphereGeometry(0.035, 8, 8), coreMat, [0.22, 0.3, -0.05])
  group.add(headGroup)

  // 4. Articulated Left & Right Arms (pivoted at shoulder)
  const leftArm = new THREE.Group()
  leftArm.position.set(-0.33, 0.16, 0)
  addPart(leftArm, new THREE.SphereGeometry(0.11, 10, 10), trimMat, [0, 0, 0])
  addPart(leftArm, new THREE.BoxGeometry(0.15, 0.36, 0.15), armorMat, [0, -0.18, 0])
  addPart(leftArm, new THREE.BoxGeometry(0.17, 0.14, 0.17), bootMat, [0, -0.32, 0.01])
  group.add(leftArm)

  const rightArm = new THREE.Group()
  rightArm.position.set(0.33, 0.16, 0)
  addPart(rightArm, new THREE.SphereGeometry(0.11, 10, 10), trimMat, [0, 0, 0])
  addPart(rightArm, new THREE.BoxGeometry(0.15, 0.36, 0.15), armorMat, [0, -0.18, 0])
  addPart(rightArm, new THREE.BoxGeometry(0.17, 0.14, 0.17), bootMat, [0, -0.32, 0.01])
  group.add(rightArm)

  // 5. Articulated Left & Right Legs (pivoted at hip)
  const leftLeg = new THREE.Group()
  leftLeg.position.set(-0.13, -0.28, 0)
  addPart(leftLeg, new THREE.BoxGeometry(0.16, 0.24, 0.18), undersuitMat, [0, -0.1, 0])
  addPart(leftLeg, new THREE.BoxGeometry(0.18, 0.18, 0.24), bootMat, [0, -0.24, 0.03])
  group.add(leftLeg)

  const rightLeg = new THREE.Group()
  rightLeg.position.set(0.13, -0.28, 0)
  addPart(rightLeg, new THREE.BoxGeometry(0.16, 0.24, 0.18), undersuitMat, [0, -0.1, 0])
  addPart(rightLeg, new THREE.BoxGeometry(0.18, 0.18, 0.24), bootMat, [0, -0.24, 0.03])
  group.add(rightLeg)

  group.userData.limbs = { leftArm, rightArm, leftLeg, rightLeg, headGroup }
  group.userData.walkPhase = 0

  return applyTransform(group, options)
}

/**
 * Articulated 15-part Dread-Sentinel / Armored Enemy:
 * Domed carapace, angry glowing optical sensors, brow armor plate, metallic horns, side vents, and heavy treads/feet.
 */
export function createEnemy(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-enemy'

  const bodyMat = getMaterial(options.color ?? 0xe11d48, 0.38, 0.35, 0x4c0519, 0.18, 0.3, 'metal')
  const armorTrim = getMaterial(0x1e1b4b, 0.45, 0.65, 0x000000, 0, 0.2, 'metal')
  const hornMat = getMaterial(0xfef08a, 0.25, 0.7, 0xca8a04, 0.2, 0.5)
  const eyeGlow = getMaterial(0xffffff, 0.15, 0.05, 0xfbbf24, 1.1)
  const pupilMat = getMaterial(0x111827, 0.2, 0.2)
  const footMat = getMaterial(0x1f2937, 0.75, 0.4, 0x000000, 0, 0, 'metal')

  // Armored core & domed top carapace
  addPart(group, new THREE.BoxGeometry(0.68, 0.52, 0.62), bodyMat, [0, 0.0, 0])
  addPart(group, new THREE.CylinderGeometry(0.28, 0.36, 0.18, 12), armorTrim, [0, 0.32, 0])
  addPart(group, new THREE.BoxGeometry(0.72, 0.1, 0.66), armorTrim, [0, -0.18, 0])

  // Dual curved horns & dorsal spike
  addPart(group, new THREE.ConeGeometry(0.1, 0.32, 8), hornMat, [-0.25, 0.44, 0], [0, 0, 0.32])
  addPart(group, new THREE.ConeGeometry(0.1, 0.32, 8), hornMat, [0.25, 0.44, 0], [0, 0, -0.32])
  addPart(group, new THREE.ConeGeometry(0.07, 0.22, 8), hornMat, [0, 0.48, -0.12], [-0.25, 0, 0])

  // Glowing angry eyes & V-shaped brow plate
  addPart(group, new THREE.BoxGeometry(0.17, 0.16, 0.04), eyeGlow, [-0.15, 0.08, 0.32])
  addPart(group, new THREE.BoxGeometry(0.17, 0.16, 0.04), eyeGlow, [0.15, 0.08, 0.32])
  addPart(group, new THREE.BoxGeometry(0.08, 0.09, 0.05), pupilMat, [-0.13, 0.06, 0.34])
  addPart(group, new THREE.BoxGeometry(0.08, 0.09, 0.05), pupilMat, [0.13, 0.06, 0.34])
  addPart(group, new THREE.BoxGeometry(0.28, 0.07, 0.06), armorTrim, [-0.14, 0.19, 0.33], [0, 0, -0.22])
  addPart(group, new THREE.BoxGeometry(0.28, 0.07, 0.06), armorTrim, [0.14, 0.19, 0.33], [0, 0, 0.22])

  // Heavy stomping feet
  addPart(group, new THREE.BoxGeometry(0.25, 0.16, 0.36), footMat, [-0.19, -0.34, 0.05])
  addPart(group, new THREE.BoxGeometry(0.25, 0.16, 0.36), footMat, [0.19, -0.34, 0.05])

  return applyTransform(group, options)
}

/**
 * Multi-tier alpine tree with root buttresses, bark relief trunk, and 4 rotated foliage tiers.
 */
export function createTree(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-tree'

  const trunkMat = getMaterial(0x78350f, 0.88, 0.04, 0x000000, 0, 0, 'wood')
  const baseLeafColor = options.color ?? 0x22c55e
  const leafMatDark = getMaterial(baseLeafColor, 0.76, 0.04, 0x052e16, 0.08)
  const leafMatMid = getMaterial(0x4ade80, 0.7, 0.05, 0x064e3b, 0.08)
  const leafMatTop = getMaterial(0x86efac, 0.65, 0.06)

  // Trunk & root flares
  addPart(group, new THREE.CylinderGeometry(0.15, 0.25, 0.95, 8), trunkMat, [0, 0.47, 0])
  addPart(group, new THREE.ConeGeometry(0.32, 0.35, 6), trunkMat, [0, 0.17, 0])

  // 4 layered foliage cones with slight rotational offset
  addPart(group, new THREE.ConeGeometry(0.92, 1.05, 7), leafMatDark, [0, 1.2, 0], [0, 0.2, 0])
  addPart(group, new THREE.ConeGeometry(0.74, 0.95, 7), leafMatMid, [0, 1.75, 0], [0, 0.65, 0])
  addPart(group, new THREE.ConeGeometry(0.54, 0.82, 7), leafMatDark, [0, 2.25, 0], [0, 1.1, 0])
  addPart(group, new THREE.ConeGeometry(0.34, 0.62, 7), leafMatTop, [0, 2.68, 0], [0, 1.55, 0])

  return applyTransform(group, options)
}

/**
 * Multi-faceted basalt/granite boulder cluster with procedural stone bump relief and mineral accents.
 */
export function createRock(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-rock'

  const rockMat = getMaterial(options.color ?? 0x94a3b8, 0.84, 0.12, 0x000000, 0, 0, 'stone')
  const darkRockMat = getMaterial(0x475569, 0.9, 0.15, 0x000000, 0, 0, 'stone')
  const crystalMat = getMaterial(0x38bdf8, 0.2, 0.35, 0x0284c7, 0.45, 0.8)

  addPart(group, new THREE.DodecahedronGeometry(0.52, 0), rockMat, [0, 0.02, 0], [0.2, 0.4, 0.1])
  addPart(group, new THREE.DodecahedronGeometry(0.35, 0), darkRockMat, [0.32, -0.1, 0.18], [0.5, 0.1, 0.3])
  addPart(group, new THREE.DodecahedronGeometry(0.28, 0), rockMat, [-0.3, -0.14, -0.14], [0.1, 0.7, 0.2])
  addPart(group, new THREE.OctahedronGeometry(0.16, 0), crystalMat, [0.12, 0.36, 0.14], [0.3, 0.4, -0.2])

  return applyTransform(group, options)
}

/**
 * Reinforced siege supply crate with recessed wood grain planks, iron corner brackets, and cross-straps.
 */
export function createCrate(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-crate'

  const woodMat = getMaterial(options.color ?? 0xd97706, 0.76, 0.08, 0x000000, 0, 0, 'wood')
  const frameMat = getMaterial(0x78350f, 0.82, 0.15, 0x000000, 0, 0, 'wood')
  const ironMat = getMaterial(0x334155, 0.4, 0.75, 0x000000, 0, 0.25, 'metal')

  addPart(group, new THREE.BoxGeometry(0.86, 0.86, 0.86), woodMat, [0, 0, 0])
  // Outer frame bars
  addPart(group, new THREE.BoxGeometry(0.96, 0.12, 0.96), frameMat, [0, 0.4, 0])
  addPart(group, new THREE.BoxGeometry(0.96, 0.12, 0.96), frameMat, [0, -0.4, 0])
  addPart(group, new THREE.BoxGeometry(0.12, 0.96, 0.96), frameMat, [-0.4, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.12, 0.96, 0.96), frameMat, [0.4, 0, 0])
  // Iron corner caps
  for (const sx of [-0.41, 0.41]) {
    for (const sy of [-0.41, 0.41]) {
      addPart(group, new THREE.BoxGeometry(0.16, 0.16, 0.98), ironMat, [sx, sy, 0])
    }
  }

  return applyTransform(group, options)
}

/**
 * Gleaming star-emblem medallion coin pickup with beveled rim and inner star crest.
 */
export function createCoin(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-coin'

  const goldMat = getMaterial(options.color ?? 0xfacc15, 0.18, 0.88, 0xca8a04, 0.32, 0.65, 'metal')
  const coreMat = getMaterial(0xfef08a, 0.15, 0.92, 0xf59e0b, 0.45, 0.8)

  addPart(group, new THREE.CylinderGeometry(0.34, 0.34, 0.09, 20), goldMat, [0, 0, 0], [Math.PI / 2, 0, 0])
  addPart(group, new THREE.TorusGeometry(0.32, 0.045, 10, 20), coreMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.12, 0.3, 0.14), coreMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.3, 0.12, 0.14), coreMat, [0, 0, 0])

  return applyTransform(group, options)
}

/**
 * Ornate riveted mechanical item/question block with corner bolts and glowing emblem core.
 */
export function createItemBlock(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-item-block'

  const blockMat = getMaterial(options.color ?? 0xf59e0b, 0.3, 0.55, 0xb45309, 0.22, 0.45, 'metal')
  const emblemMat = getMaterial(0xfef9c3, 0.2, 0.3, 0xfde047, 0.5, 0.6)
  const boltMat = getMaterial(0x475569, 0.35, 0.82, 0x000000, 0, 0.3, 'metal')

  addPart(group, new THREE.BoxGeometry(0.92, 0.92, 0.92), blockMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.98, 0.42, 0.42), emblemMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.42, 0.42, 0.98), emblemMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.96, 0.1, 0.96), boltMat, [0, 0.43, 0])
  addPart(group, new THREE.BoxGeometry(0.96, 0.1, 0.96), boltMat, [0, -0.43, 0])

  return applyTransform(group, options)
}

/**
 * Goal post / flag with stepped pedestal, brass collar, metallic spire, finial orb, and fluttering pennant.
 */
export function createGoalFlag(options: AssetOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-goal-flag'

  const poleMat = getMaterial(0xe2e8f0, 0.25, 0.82, 0x000000, 0, 0.4, 'metal')
  const baseMat = getMaterial(0x334155, 0.65, 0.35, 0x000000, 0, 0, 'stone')
  const flagColor = options.color ?? 0x22c55e
  const flagMat = getMaterial(flagColor, 0.38, 0.15, flagColor, 0.35, 0.2)
  const orbMat = getMaterial(0xfacc15, 0.15, 0.9, 0xd97706, 0.45, 0.8)

  addPart(group, new THREE.CylinderGeometry(0.42, 0.5, 0.18, 16), baseMat, [0, 0.09, 0])
  addPart(group, new THREE.CylinderGeometry(0.26, 0.34, 0.16, 16), orbMat, [0, 0.24, 0])
  addPart(group, new THREE.CylinderGeometry(0.06, 0.075, 2.5, 12), poleMat, [0, 1.4, 0])
  addPart(group, new THREE.SphereGeometry(0.16, 14, 14), orbMat, [0, 2.7, 0])
  addPart(group, new THREE.BoxGeometry(0.55, 0.46, 0.06), flagMat, [0.32, 2.28, 0])
  addPart(group, new THREE.ConeGeometry(0.24, 0.48, 4), flagMat, [0.76, 2.28, 0], [0, 0, -Math.PI / 2])

  return applyTransform(group, options)
}

/**
 * Architectural platform tile with stone/earth bump-mapped base, bevel-trimmed cap, and underside corbel ribs.
 */
export function createPlatformTile(options: PlatformTileOptions = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-platform-tile'

  const [w, h, d] = options.size ?? [2, 0.5, 2]
  const capHeight = Math.min(0.16, h * 0.35)
  const baseHeight = Math.max(0.05, h - capHeight)

  const baseMat = getMaterial(options.color ?? 0x78350f, 0.85, 0.08, 0x000000, 0, 0, 'stone')
  const topMat = getMaterial(options.topColor ?? 0x4ade80, 0.62, 0.06, 0x000000, 0, 0.15, 'stone')

  addPart(group, new THREE.BoxGeometry(w, baseHeight, d), baseMat, [0, -capHeight / 2, 0])
  addPart(group, new THREE.BoxGeometry(w * 1.02, capHeight, d * 1.02), topMat, [0, baseHeight / 2, 0])

  return applyTransform(group, options)
}

/**
 * Fortified medieval/citadel stone bastion tower with crenellated battlements and glowing brazier.
 */
export function createCastleTower(options: AssetOptions & { height?: number; radius?: number; roofColor?: number } = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-castle-tower'

  const r = options.radius ?? 1.6
  const h = options.height ?? 5.2
  const stoneMat = getMaterial(options.color ?? 0x64748b, 0.86, 0.12, 0x000000, 0, 0, 'stone')
  const darkStone = getMaterial(options.roofColor ?? 0x334155, 0.9, 0.18, 0x000000, 0, 0, 'stone')
  const emberMat = getMaterial(0xff5500, 0.25, 0.1, 0xff3300, 1.2)

  // Plinth base, main shaft, upper cornice
  addPart(group, new THREE.CylinderGeometry(r * 1.08, r * 1.2, h * 0.18, 12), darkStone, [0, h * 0.09, 0])
  addPart(group, new THREE.CylinderGeometry(r * 0.95, r * 1.06, h * 0.72, 12), stoneMat, [0, h * 0.54, 0])
  addPart(group, new THREE.CylinderGeometry(r * 1.12, r * 0.98, h * 0.12, 12), darkStone, [0, h * 0.94, 0])

  // Crenellations around the crown
  const merlonCount = 8
  for (let i = 0; i < merlonCount; i++) {
    const angle = (i / merlonCount) * Math.PI * 2
    const mx = Math.cos(angle) * (r * 0.98)
    const mz = Math.sin(angle) * (r * 0.98)
    addPart(
      group,
      new THREE.BoxGeometry(r * 0.36, 0.42, r * 0.26),
      stoneMat,
      [mx, h + 0.2, mz],
      [0, -angle + Math.PI / 2, 0],
    )
  }

  // Brazier flame beacon at top center
  addPart(group, new THREE.CylinderGeometry(r * 0.35, r * 0.22, 0.28, 10), darkStone, [0, h + 0.14, 0])
  addPart(group, new THREE.ConeGeometry(r * 0.28, 0.55, 8), emberMat, [0, h + 0.48, 0])

  return applyTransform(group, options)
}

/**
 * Fortified twin-pillar citadel gatehouse archway with glowing rune keystone.
 */
export function createArchwayGate(options: AssetOptions & { span?: number; height?: number; accentColor?: number } = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-archway-gate'

  const span = options.span ?? 4.6
  const height = options.height ?? 5.4
  const stoneMat = getMaterial(options.color ?? 0x475569, 0.85, 0.16, 0x000000, 0, 0, 'stone')
  const trimMat = getMaterial(0x1e293b, 0.72, 0.28, 0x000000, 0, 0, 'stone')
  const runeMat = getMaterial(options.accentColor ?? 0x38bdf8, 0.2, 0.15, options.accentColor ?? 0x38bdf8, 1.35)

  const halfZ = span / 2
  // Twin buttressed pillars along Z so actors pass along X
  for (const side of [-1, 1]) {
    const z = side * halfZ
    addPart(group, new THREE.BoxGeometry(1.4, height * 0.18, 1.4), trimMat, [0, height * 0.09, z])
    addPart(group, new THREE.BoxGeometry(1.1, height * 0.78, 1.1), stoneMat, [0, height * 0.48, z])
    addPart(group, new THREE.BoxGeometry(1.35, 0.32, 1.35), trimMat, [0, height * 0.88, z])
    addPart(group, new THREE.BoxGeometry(0.18, height * 0.52, 0.18), runeMat, [-0.56, height * 0.48, z])
    addPart(group, new THREE.BoxGeometry(0.18, height * 0.52, 0.18), runeMat, [0.56, height * 0.48, z])
  }

  // Overhead lintel bridge + crenellations + central keystone
  const lintelLen = span + 1.6
  addPart(group, new THREE.BoxGeometry(1.3, 0.65, lintelLen), stoneMat, [0, height + 0.18, 0])
  addPart(group, new THREE.BoxGeometry(1.46, 0.22, lintelLen + 0.2), trimMat, [0, height + 0.56, 0])
  addPart(group, new THREE.OctahedronGeometry(0.45, 0), runeMat, [0, height + 0.2, 0])
  for (let i = -3; i <= 3; i++) {
    addPart(group, new THREE.BoxGeometry(0.45, 0.38, 0.45), stoneMat, [0, height + 0.84, i * (span / 6)])
  }

  return applyTransform(group, options)
}

/**
 * High-tech kinetic launch pad / gravity geyser with concentric glowing rings.
 */
export function createJumpPad(options: AssetOptions & { ringColor?: number } = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-jump-pad'

  const baseMat = getMaterial(options.color ?? 0x1e293b, 0.45, 0.65, 0x000000, 0, 0.3, 'tech')
  const glowColor = options.ringColor ?? 0x00f5d4
  const glowMat = getMaterial(glowColor, 0.18, 0.2, glowColor, 1.45, 0.5)

  addPart(group, new THREE.CylinderGeometry(1.15, 1.35, 0.24, 16), baseMat, [0, 0.12, 0])
  addPart(group, new THREE.CylinderGeometry(0.88, 0.96, 0.12, 16), glowMat, [0, 0.26, 0])
  const ring = addPart(group, new THREE.TorusGeometry(0.72, 0.06, 10, 24), glowMat, [0, 0.42, 0], [Math.PI / 2, 0, 0])
  group.userData.pulseRing = ring

  return applyTransform(group, options)
}

/**
 * Heavy obsidian & plasma wrecking pendulum hammer assembly.
 */
export function createPendulumHammer(options: AssetOptions & { armLength?: number; glowColor?: number } = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-pendulum-hammer'

  const armLen = options.armLength ?? 4.2
  const ironMat = getMaterial(options.color ?? 0x1e293b, 0.42, 0.78, 0x000000, 0, 0.25, 'metal')
  const plasmaColor = options.glowColor ?? 0xf43f5e
  const plasmaMat = getMaterial(plasmaColor, 0.2, 0.2, plasmaColor, 1.35)

  // Overhead gantry crossbar
  addPart(group, new THREE.CylinderGeometry(0.28, 0.28, 1.4, 12), ironMat, [0, 0, 0], [0, 0, Math.PI / 2])
  // Rod descending from pivot (y = 0 down to y = -armLen)
  addPart(group, new THREE.CylinderGeometry(0.11, 0.11, armLen, 10), ironMat, [0, -armLen / 2, 0])
  // Massive double-headed warhammer at bottom (y = -armLen)
  addPart(group, new THREE.CylinderGeometry(0.58, 0.58, 1.65, 12), ironMat, [0, -armLen, 0], [0, 0, Math.PI / 2])
  addPart(group, new THREE.CylinderGeometry(0.64, 0.64, 0.18, 12), plasmaMat, [-0.72, -armLen, 0], [0, 0, Math.PI / 2])
  addPart(group, new THREE.CylinderGeometry(0.64, 0.64, 0.18, 12), plasmaMat, [0.72, -armLen, 0], [0, 0, Math.PI / 2])

  return applyTransform(group, options)
}

/**
 * Tall beveled rune domino monolith for chain-reaction cascades.
 */
export function createDominoMonolith(options: AssetOptions & { runeColor?: number } = {}): THREE.Group {
  const group = new THREE.Group()
  group.name = 'asset-domino-monolith'

  const slabMat = getMaterial(options.color ?? 0x334155, 0.55, 0.35, 0x000000, 0, 0.25, 'stone')
  const runeColor = options.runeColor ?? 0x38bdf8
  const runeMat = getMaterial(runeColor, 0.2, 0.15, runeColor, 1.1)

  addPart(group, new THREE.BoxGeometry(0.36, 2.2, 1.15), slabMat, [0, 0, 0])
  addPart(group, new THREE.BoxGeometry(0.39, 0.14, 0.85), runeMat, [0, 0.55, 0])
  addPart(group, new THREE.BoxGeometry(0.39, 0.14, 0.85), runeMat, [0, -0.55, 0])
  addPart(group, new THREE.OctahedronGeometry(0.22, 0), runeMat, [0, 0, 0])

  return applyTransform(group, options)
}

/**
 * Zero-GC pooled particle emitter using a single THREE.InstancedMesh for debris, sparks, and splashes.
 */
export interface PooledParticleSystem {
  mesh: THREE.InstancedMesh
  emitBurst: (origin: Vec3, count?: number, speed?: number) => void
  burst: (origin: Vec3, color?: number, count?: number, speed?: number) => void
  step: (dt?: number) => void
  dispose: () => void
}

export function createPooledParticles(
  scene: THREE.Scene,
  capacity = 64,
  color = 0xff7b00,
): PooledParticleSystem {
  const geo = new THREE.DodecahedronGeometry(0.16, 0)
  const mat = createPBRMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.95,
    roughness: 0.25,
    metalness: 0.1,
  })
  const inst = new THREE.InstancedMesh(geo, mat, capacity)
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  scene.add(inst)

  const px = new Float32Array(capacity)
  const py = new Float32Array(capacity)
  const pz = new Float32Array(capacity)
  const vx = new Float32Array(capacity)
  const vy = new Float32Array(capacity)
  const vz = new Float32Array(capacity)
  const life = new Float32Array(capacity)
  const maxLife = new Float32Array(capacity)
  let cursor = 0
  let seed = 987654321

  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff
  }

  const dummy = new THREE.Object3D()
  for (let i = 0; i < capacity; i++) {
    dummy.position.set(0, -999, 0)
    dummy.scale.setScalar(0.001)
    dummy.updateMatrix()
    inst.setMatrixAt(i, dummy.matrix)
  }
  inst.instanceMatrix.needsUpdate = true

  const doBurst = (origin: Vec3, count = 16, speed = 6.5) => {
    for (let i = 0; i < count; i++) {
      const idx = cursor % capacity
      cursor++
      const theta = nextRand() * Math.PI * 2
      const elev = 0.35 + nextRand() * 0.95
      const spd = speed * (0.55 + nextRand() * 0.75)
      px[idx] = origin[0] + (nextRand() - 0.5) * 0.3
      py[idx] = origin[1] + (nextRand() - 0.5) * 0.3
      pz[idx] = origin[2] + (nextRand() - 0.5) * 0.3
      vx[idx] = Math.cos(theta) * spd
      vy[idx] = elev * spd + 2.5
      vz[idx] = Math.sin(theta) * spd
      life[idx] = 0.001
      maxLife[idx] = 0.55 + nextRand() * 0.55
    }
  }

  return {
    mesh: inst,
    emitBurst(origin: Vec3, count = 16, speed = 6.5) {
      doBurst(origin, count, speed)
    },
    burst(origin: Vec3, burstColor?: number, count = 16, speed = 6.5) {
      if (typeof burstColor === 'number') {
        mat.color.setHex(burstColor)
        mat.emissive.setHex(burstColor)
      }
      doBurst(origin, count, speed)
    },
    step(dt = 1 / 60) {
      let dirty = false
      for (let i = 0; i < capacity; i++) {
        if (life[i] <= 0) continue
        dirty = true
        life[i] += dt
        if (life[i] >= maxLife[i]) {
          life[i] = 0
          dummy.position.set(0, -999, 0)
          dummy.scale.setScalar(0.001)
          dummy.updateMatrix()
          inst.setMatrixAt(i, dummy.matrix)
          continue
        }
        vy[i] -= 14.5 * dt
        px[i] += vx[i] * dt
        py[i] += vy[i] * dt
        pz[i] += vz[i] * dt
        const t = 1 - life[i] / maxLife[i]
        dummy.position.set(px[i], py[i], pz[i])
        dummy.rotation.set(life[i] * 6, life[i] * 4, 0)
        dummy.scale.setScalar(Math.max(0.05, t))
        dummy.updateMatrix()
        inst.setMatrixAt(i, dummy.matrix)
      }
      if (dirty) inst.instanceMatrix.needsUpdate = true
    },
    dispose() {
      scene.remove(inst)
      geo.dispose()
      mat.dispose()
    },
  }
}

/**
 * Small collider helper so generated levels can pair an asset group with a matching box or capsule body in one call.
 */
export interface ColliderBodyOptions {
  type?: 'dynamic' | 'fixed' | 'kinematicPosition'
  shape?: 'box' | 'capsule' | 'ball'
  position?: Vec3
  size?: Vec3
  halfHeight?: number
  radius?: number
  density?: number
  friction?: number
  restitution?: number
  lockRotations?: boolean
}

export function createBodyWithCollider(
  world: RAPIER.World,
  options: ColliderBodyOptions = {},
): RAPIER.RigidBody {
  const [x, y, z] = options.position ?? [0, 0, 0]
  const bodyDesc =
    options.type === 'fixed'
      ? RAPIER.RigidBodyDesc.fixed()
      : options.type === 'kinematicPosition'
        ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.dynamic()
  bodyDesc.setTranslation(x, y, z)
  if (options.lockRotations) bodyDesc.lockRotations()

  const body = world.createRigidBody(bodyDesc)
  const shape = options.shape ?? 'box'
  let colliderDesc: RAPIER.ColliderDesc
  if (shape === 'capsule') {
    colliderDesc = RAPIER.ColliderDesc.capsule(options.halfHeight ?? 0.3, options.radius ?? 0.3)
  } else if (shape === 'ball') {
    colliderDesc = RAPIER.ColliderDesc.ball(options.radius ?? 0.4)
  } else {
    const [sx, sy, sz] = options.size ?? [1, 1, 1]
    colliderDesc = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
  }

  colliderDesc
    .setDensity(options.density ?? 1)
    .setFriction(options.friction ?? 0.6)
    .setRestitution(options.restitution ?? 0.15)
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | RAPIER.ActiveEvents.COLLISION_EVENTS)
  world.createCollider(colliderDesc, body)
  return body
}

export interface ScatterArea {
  min: [number, number]
  max: [number, number]
  y?: number
  minRadius?: number
}

/**
 * Scatters background scenery deterministically using THREE.InstancedMesh (one InstancedMesh per child mesh in `template`).
 */
export function scatter(
  scene: THREE.Scene,
  template: THREE.Object3D,
  count: number,
  area: ScatterArea,
  seed = 1337,
): THREE.Group {
  const container = new THREE.Group()
  container.name = 'asset-scatter'
  scene.add(container)
  if (count <= 0) return container

  let state = (seed >>> 0) || 1
  const nextRand = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }

  template.updateMatrixWorld(true)
  const meshParts: Array<{
    geometry: THREE.BufferGeometry
    material: THREE.Material | THREE.Material[]
    localMatrix: THREE.Matrix4
  }> = []
  template.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh) {
      meshParts.push({
        geometry: mesh.geometry,
        material: mesh.material,
        localMatrix: mesh.matrix.clone(),
      })
    }
  })

  const instancedMeshes = meshParts.map((part) => {
    const inst = new THREE.InstancedMesh(part.geometry, part.material, count)
    inst.castShadow = true
    inst.receiveShadow = true
    container.add(inst)
    return { inst, localMatrix: part.localMatrix }
  })

  const [minX, minZ] = area.min
  const [maxX, maxZ] = area.max
  const baseY = area.y ?? 0
  const minRadius = area.minRadius ?? 0
  const instanceTransform = new THREE.Matrix4()
  const finalMatrix = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const euler = new THREE.Euler()

  for (let i = 0; i < count; i++) {
    let x = 0
    let z = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      x = minX + nextRand() * (maxX - minX)
      z = minZ + nextRand() * (maxZ - minZ)
      if (Math.hypot(x, z) >= minRadius) break
    }
    const s = 0.75 + nextRand() * 0.55
    pos.set(x, baseY, z)
    euler.set(0, nextRand() * Math.PI * 2, 0)
    quat.setFromEuler(euler)
    scale.set(s, s * (0.9 + nextRand() * 0.25), s)
    instanceTransform.compose(pos, quat, scale)

    for (const { inst, localMatrix } of instancedMeshes) {
      finalMatrix.multiplyMatrices(instanceTransform, localMatrix)
      inst.setMatrixAt(i, finalMatrix)
    }
  }

  for (const { inst } of instancedMeshes) {
    inst.instanceMatrix.needsUpdate = true
  }

  return container
}

/**
 * Animates an articulated character group created by `createCharacter` based on linear velocity.
 */
export function animateCharacterGroup(
  mesh: THREE.Object3D,
  linvelOrSpeed: { x: number; y: number; z: number } | number,
  dtOrElapsed = 1 / 60,
  _grounded = true,
): void {
  const limbs = mesh.userData?.limbs as
    | {
        leftArm?: THREE.Object3D
        rightArm?: THREE.Object3D
        leftLeg?: THREE.Object3D
        rightLeg?: THREE.Object3D
        headGroup?: THREE.Object3D
      }
    | undefined
  if (!limbs) return

  const speedHoriz =
    typeof linvelOrSpeed === 'number'
      ? Math.abs(linvelOrSpeed)
      : Math.hypot(linvelOrSpeed.x, linvelOrSpeed.z)
  const phase = ((mesh.userData.walkPhase as number) ?? 0) + speedHoriz * (1 / 60) * 4.2
  mesh.userData.walkPhase = phase
  void dtOrElapsed

  const stride = Math.min(1, speedHoriz / 5.5) * 0.72
  const swing = Math.sin(phase) * stride
  if (limbs.leftArm) limbs.leftArm.rotation.x = swing
  if (limbs.rightArm) limbs.rightArm.rotation.x = -swing
  if (limbs.leftLeg) limbs.leftLeg.rotation.x = -swing * 1.1
  if (limbs.rightLeg) limbs.rightLeg.rotation.x = swing * 1.1
  if (limbs.headGroup) {
    limbs.headGroup.position.y = 0.42 + Math.abs(Math.cos(phase)) * 0.025 * Math.min(1, speedHoriz)
  }
}

/**
 * Gameplay helper 1: Player controller with articulated gait animation and ground raycast.
 */
export interface PlayerControllerOptions {
  moveSpeed?: number
  jumpSpeed?: number
  groundYThreshold?: number
  leftKeys?: string[]
  rightKeys?: string[]
  jumpKeys?: string[]
}

export interface PlayerControllerHandle {
  heldKeys: Set<string>
  onPointerOrKey: (event: { type: string; key?: string; code?: string }) => void
  step: () => { grounded: boolean; moving: number }
  syncMesh: (mesh: THREE.Object3D) => void
}

export function createPlayerController(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  options: PlayerControllerOptions = {},
): PlayerControllerHandle {
  const moveSpeed = options.moveSpeed ?? 6.5
  const jumpSpeed = options.jumpSpeed ?? 8.2
  const leftKeys = new Set(
    (options.leftKeys ?? ['ArrowLeft', 'KeyA', 'a', 'A']).map((k) => k.toLowerCase()),
  )
  const rightKeys = new Set(
    (options.rightKeys ?? ['ArrowRight', 'KeyD', 'd', 'D']).map((k) => k.toLowerCase()),
  )
  const jumpKeys = new Set(
    (options.jumpKeys ?? ['Space', ' ', 'ArrowUp', 'KeyW', 'w', 'W']).map((k) => k.toLowerCase()),
  )
  const heldKeys = new Set<string>()

  function isPressed(set: Set<string>): boolean {
    for (const k of heldKeys) {
      if (set.has(k)) return true
    }
    return false
  }

  function checkGrounded(): boolean {
    const pos = body.translation()
    const vel = body.linvel()
    if (
      options.groundYThreshold !== undefined &&
      pos.y <= options.groundYThreshold &&
      Math.abs(vel.y) < 0.6
    ) {
      return true
    }
    const ray = new RAPIER.Ray({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: -1, z: 0 })
    const hit = world.castRay(ray, 0.85, true, undefined, undefined, undefined, body)
    return hit !== null || (pos.y <= 0.75 && Math.abs(vel.y) < 0.25)
  }

  return {
    heldKeys,
    onPointerOrKey(event) {
      const tokens = [event.key, event.code]
        .filter((t): t is string => Boolean(t))
        .map((t) => t.toLowerCase())
      if (event.type === 'keydown') {
        tokens.forEach((t) => heldKeys.add(t))
      } else if (event.type === 'keyup') {
        tokens.forEach((t) => heldKeys.delete(t))
      }
    },
    step() {
      const left = isPressed(leftKeys)
      const right = isPressed(rightKeys)
      const jump = isPressed(jumpKeys)
      const moving = (right ? 1 : 0) - (left ? 1 : 0)
      const grounded = checkGrounded()
      const currentVel = body.linvel()
      const nextVx = moving !== 0 ? moving * moveSpeed : currentVel.x * 0.8
      const nextVy = jump && grounded && currentVel.y <= 0.5 ? jumpSpeed : currentVel.y
      body.wakeUp()
      body.setLinvel({ x: nextVx, y: nextVy, z: currentVel.z }, true)
      return { grounded, moving }
    },
    syncMesh(mesh) {
      const p = body.translation()
      const q = body.rotation()
      const v = body.linvel()
      mesh.position.set(p.x, p.y, p.z)
      mesh.quaternion.set(q.x, q.y, q.z, q.w)
      animateCharacterGroup(mesh, v)
    },
  }
}

/**
 * Gameplay helper 2: Finite pickup (`collectOnce`) and directional block trigger (`hitFromBelow`).
 */
export interface TriggerItemHandle {
  readonly triggered: boolean
  check: (actor: RAPIER.RigidBody) => boolean
  reset: () => void
}

export function collectOnce(
  targetMesh: THREE.Object3D,
  options: { radius?: number; onCollect?: () => void } = {},
): TriggerItemHandle {
  const radius = options.radius ?? 0.85
  let collected = false

  return {
    get triggered() {
      return collected
    },
    check(actor: RAPIER.RigidBody): boolean {
      if (collected) return false
      const p = actor.translation()
      const dist = Math.hypot(
        p.x - targetMesh.position.x,
        p.y - targetMesh.position.y,
        p.z - targetMesh.position.z,
      )
      if (dist <= radius) {
        collected = true
        targetMesh.visible = false
        options.onCollect?.()
        return true
      }
      return false
    },
    reset() {
      collected = false
      targetMesh.visible = true
    },
  }
}

export function hitFromBelow(
  blockMesh: THREE.Object3D,
  options: { width?: number; reachY?: number; once?: boolean; onHit?: () => void } = {},
): TriggerItemHandle {
  const halfWidth = (options.width ?? 1.1) / 2
  const reachY = options.reachY ?? 1.05
  const once = options.once ?? true
  let fired = false

  return {
    get triggered() {
      return fired
    },
    check(actor: RAPIER.RigidBody): boolean {
      if (once && fired) return false
      const p = actor.translation()
      const v = actor.linvel()
      const dy = blockMesh.position.y - p.y
      const dx = Math.abs(p.x - blockMesh.position.x)
      const dz = Math.abs(p.z - blockMesh.position.z)
      if (dy > 0.15 && dy <= reachY && dx <= halfWidth && dz <= halfWidth && v.y > 0.2) {
        fired = true
        options.onHit?.()
        return true
      }
      return false
    },
    reset() {
      fired = false
    },
  }
}
