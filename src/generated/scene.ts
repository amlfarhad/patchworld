import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import {
  createArchwayGate,
  createBodyWithCollider,
  createCastleTower,
  createGoalFlag,
  createJumpPad,
  createPBRMaterial,
  createPlatformTile,
  createRock,
  createTree,
  scatter,
} from '../engine/assetKit'

export interface SceneHandle {
  stepScene: (elapsedSeconds: number) => void
  dispose: () => void
}

export function buildScene(
  scene: THREE.Scene,
  world: RAPIER.World,
  namedBodies: Map<string, RAPIER.RigidBody>,
): SceneHandle {
  const disposables: Array<{ dispose: () => void }> = []
  const sceneObjects: THREE.Object3D[] = []

  const trackGroup = <T extends THREE.Object3D>(obj: T): T => {
    scene.add(obj)
    sceneObjects.push(obj)
    return obj
  }

  // ============================================================================
  // ZONE 1: SIEGE COMMAND BASTION (x = -22 to -6)
  // ============================================================================
  trackGroup(
    createPlatformTile({
      position: [-14.0, 0.5, 0],
      size: [16.0, 1.0, 11.5],
      color: 0x334155,
      topColor: 0x64748b,
    }),
  )
  const startPlatform = createBodyWithCollider(world, {
    type: 'fixed',
    shape: 'box',
    position: [-14.0, 0.5, 0],
    size: [16.0, 1.0, 11.5],
    friction: 0.9,
  })
  namedBodies.set('startPlatform', startPlatform)

  // Elevated Siege Battery Terrace
  trackGroup(
    createPlatformTile({
      position: [-9.2, 1.25, 0],
      size: [5.4, 0.5, 6.2],
      color: 0x475569,
      topColor: 0x94a3b8,
    }),
  )
  const batteryPlatform = createBodyWithCollider(world, {
    type: 'fixed',
    shape: 'box',
    position: [-9.2, 1.25, 0],
    size: [5.4, 0.5, 6.2],
    friction: 0.85,
  })
  namedBodies.set('batteryPlatform', batteryPlatform)

  // Twin Blue Command Bastion Towers + Connecting Rampart Archway
  trackGroup(
    createCastleTower({
      position: [-19.5, 1.0, -4.4],
      radius: 1.85,
      height: 6.4,
      color: 0x64748b,
      roofColor: 0x1d4ed8,
    }),
  )
  trackGroup(
    createCastleTower({
      position: [-19.5, 1.0, 4.4],
      radius: 1.85,
      height: 6.4,
      color: 0x64748b,
      roofColor: 0x1d4ed8,
    }),
  )
  trackGroup(
    createArchwayGate({
      position: [-16.8, 1.0, 0],
      span: 5.4,
      height: 4.8,
      color: 0x475569,
      accentColor: 0x38bdf8,
    }),
  )

  // ============================================================================
  // ZONE 2: MOLTEN MAGMA CALDERA & OBSIDIAN CAUSEWAY (x = -6 to +6)
  // ============================================================================
  const lavaGeo = new THREE.BoxGeometry(12.0, 0.38, 12.5)
  const lavaMat = createPBRMaterial({
    color: 0xff4500,
    emissive: 0xff2200,
    emissiveIntensity: 1.15,
    roughness: 0.22,
    metalness: 0.08,
    clearcoat: 0.45,
  })
  const lavaMesh = new THREE.Mesh(lavaGeo, lavaMat)
  lavaMesh.position.set(0.0, 0.19, 0)
  trackGroup(lavaMesh)
  disposables.push(lavaGeo, lavaMat)

  const lavaPit = createBodyWithCollider(world, {
    type: 'fixed',
    shape: 'box',
    position: [0.0, 0.19, 0],
    size: [12.0, 0.38, 12.5],
    friction: 0.5,
  })
  namedBodies.set('lavaPit', lavaPit)

  // 24 animated convection magma bubbles across the caldera
  const bubbleGeo = new THREE.SphereGeometry(0.24, 12, 10)
  const bubbleMat = createPBRMaterial({
    color: 0xffb703,
    emissive: 0xff5400,
    emissiveIntensity: 1.5,
    roughness: 0.15,
  })
  disposables.push(bubbleGeo, bubbleMat)
  const bubbles: Array<{ mesh: THREE.Mesh; baseX: number; baseZ: number; speed: number; phase: number }> = []
  for (let i = 0; i < 24; i++) {
    const bMesh = new THREE.Mesh(bubbleGeo, bubbleMat)
    const bx = -5.2 + ((i * 1.37) % 10.4)
    const bz = -5.2 + (((i * 2.93) + 1.1) % 10.4)
    bMesh.position.set(bx, 0.42, bz)
    trackGroup(bMesh)
    bubbles.push({
      mesh: bMesh,
      baseX: bx,
      baseZ: bz,
      speed: 1.6 + (i % 5) * 0.45,
      phase: i * 0.85,
    })
  }

  // 3 Obsidian Stepping Pillars + 2 Flanking Suspension Causeway Planks
  const stepPositions: Array<{ name: string; pos: [number, number, number]; size: [number, number, number] }> = [
    { name: 'stepStone1', pos: [-3.4, 1.35, 0], size: [2.2, 0.55, 3.0] },
    { name: 'stepStone2', pos: [0.0, 1.75, 0], size: [2.4, 0.55, 3.2] },
    { name: 'stepStone3', pos: [3.4, 1.45, 0], size: [2.2, 0.55, 3.0] },
    { name: 'stepStone4', pos: [-1.7, 1.15, -3.2], size: [2.0, 0.45, 2.0] },
    { name: 'stepStone5', pos: [1.7, 1.15, -3.2], size: [2.0, 0.45, 2.0] },
  ]
  for (const st of stepPositions) {
    trackGroup(
      createPlatformTile({
        position: st.pos,
        size: st.size,
        color: 0x1e293b,
        topColor: 0x64748b,
      }),
    )
    const body = createBodyWithCollider(world, {
      type: 'fixed',
      shape: 'box',
      position: st.pos,
      size: st.size,
      friction: 0.9,
    })
    namedBodies.set(st.name, body)
  }

  // Overhead Pendulum Gantry Arch spanning the center of the caldera
  trackGroup(
    createArchwayGate({
      position: [0.0, 0.4, 0],
      span: 7.4,
      height: 5.8,
      color: 0x1e293b,
      accentColor: 0xf43f5e,
    }),
  )

  // ============================================================================
  // ZONE 3: KINETIC COURTYARD & LAUNCH GEYSER (x = +6 to +15)
  // ============================================================================
  trackGroup(
    createPlatformTile({
      position: [10.5, 0.6, 0],
      size: [9.0, 1.2, 11.5],
      color: 0x1e293b,
      topColor: 0x475569,
    }),
  )
  const courtyardPlatform = createBodyWithCollider(world, {
    type: 'fixed',
    shape: 'box',
    position: [10.5, 0.6, 0],
    size: [9.0, 1.2, 11.5],
    friction: 0.9,
  })
  namedBodies.set('courtyardPlatform', courtyardPlatform)

  // Twin Courtyard Guard Towers
  trackGroup(
    createCastleTower({
      position: [9.2, 1.2, -4.6],
      radius: 1.35,
      height: 4.8,
      color: 0x475569,
      roofColor: 0x0f172a,
    }),
  )
  trackGroup(
    createCastleTower({
      position: [9.2, 1.2, 4.6],
      radius: 1.35,
      height: 4.8,
      color: 0x475569,
      roofColor: 0x0f172a,
    }),
  )

  // Kinetic Jump Pad / Gravity Geyser at x = 12.2
  const jumpPadGroup = trackGroup(
    createJumpPad({
      position: [12.2, 1.2, 0],
      ringColor: 0x00f5d4,
    }),
  )

  // ============================================================================
  // ZONE 4: GRAND OBSIDIAN CITADEL & DESTRUCTIBLE KEEP (x = +15 to +27)
  // ============================================================================
  trackGroup(
    createPlatformTile({
      position: [21.0, 0.7, 0],
      size: [12.0, 1.4, 12.0],
      color: 0x0f172a,
      topColor: 0x334155,
    }),
  )
  const goalPlatform = createBodyWithCollider(world, {
    type: 'fixed',
    shape: 'box',
    position: [21.0, 0.7, 0],
    size: [12.0, 1.4, 12.0],
    friction: 0.9,
  })
  namedBodies.set('goalPlatform', goalPlatform)

  // Citadel Gatehouse Archway
  trackGroup(
    createArchwayGate({
      position: [15.4, 1.4, 0],
      span: 6.2,
      height: 5.4,
      color: 0x334155,
      accentColor: 0xf97316,
    }),
  )

  // Raised Citadel Keep Pedestal at x = 18.2
  trackGroup(
    createPlatformTile({
      position: [18.2, 1.65, 0],
      size: [4.2, 0.5, 4.6],
      color: 0x475569,
      topColor: 0x94a3b8,
    }),
  )
  const towerPedestal = createBodyWithCollider(world, {
    type: 'fixed',
    shape: 'box',
    position: [18.2, 1.65, 0],
    size: [4.2, 0.5, 4.6],
    friction: 0.92,
  })
  namedBodies.set('towerPedestal', towerPedestal)

  // 4 Towering Red & Obsidian Citadel Keeps framing the throne
  trackGroup(
    createCastleTower({
      position: [21.8, 1.4, -4.4],
      radius: 1.75,
      height: 6.6,
      color: 0x334155,
      roofColor: 0xdc2626,
    }),
  )
  trackGroup(
    createCastleTower({
      position: [21.8, 1.4, 4.4],
      radius: 1.75,
      height: 6.6,
      color: 0x334155,
      roofColor: 0xdc2626,
    }),
  )
  trackGroup(
    createCastleTower({
      position: [25.2, 1.4, -2.8],
      radius: 1.5,
      height: 7.8,
      color: 0x1e293b,
      roofColor: 0xb91c1c,
    }),
  )
  trackGroup(
    createCastleTower({
      position: [25.2, 1.4, 2.8],
      radius: 1.5,
      height: 7.8,
      color: 0x1e293b,
      roofColor: 0xb91c1c,
    }),
  )

  // Victory Beacon Flag behind the destructible Citadel Keep
  trackGroup(
    createGoalFlag({
      position: [23.2, 1.4, 0],
      scale: 1.45,
      color: 0x10b981,
    }),
  )

  // ============================================================================
  // ZONE 5: FLOATING SKY CITADELS & INSTANCED ALPINE FORESTS
  // ============================================================================
  const skyIslands: Array<{ group: THREE.Group; baseY: number; phase: number }> = []
  const islandConfigs: Array<{ pos: [number, number, number]; scale: number; roof: number }> = [
    { pos: [-12, 11.5, -13], scale: 0.75, roof: 0x38bdf8 },
    { pos: [2, 13.0, -15], scale: 0.85, roof: 0xa855f7 },
    { pos: [17, 12.0, -13], scale: 0.78, roof: 0xf43f5e },
  ]
  for (let i = 0; i < islandConfigs.length; i++) {
    const cfg = islandConfigs[i]!
    const isl = new THREE.Group()
    isl.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2])
    isl.add(
      createPlatformTile({
        position: [0, 0, 0],
        size: [4.6 * cfg.scale, 0.9, 4.6 * cfg.scale],
        color: 0x334155,
        topColor: 0x64748b,
      }),
    )
    isl.add(
      createCastleTower({
        position: [0, 0.45, 0],
        radius: 1.2 * cfg.scale,
        height: 3.8 * cfg.scale,
        color: 0x475569,
        roofColor: cfg.roof,
      }),
    )
    trackGroup(isl)
    skyIslands.push({ group: isl, baseY: cfg.pos[1], phase: i * 2.1 })
  }

  // Instanced Forest & Volcanic Boulders around the battlefield perimeter
  const treeTemplate = createTree()
  const rockTemplate = createRock()
  sceneObjects.push(
    scatter(scene, treeTemplate, 26, { min: [-36, -24], max: [36, -9.5], y: 0, minRadius: 8 }, 101),
    scatter(scene, treeTemplate, 22, { min: [-36, 9.5], max: [36, 24], y: 0, minRadius: 8 }, 202),
    scatter(scene, rockTemplate, 20, { min: [-34, -22], max: [34, -9.0], y: 0, minRadius: 7 }, 303),
    scatter(scene, rockTemplate, 18, { min: [-34, 9.0], max: [34, 22], y: 0, minRadius: 7 }, 404),
  )

  return {
    stepScene(elapsedSeconds: number) {
      for (const b of bubbles) {
        const cycle = (elapsedSeconds * b.speed + b.phase) % 1
        b.mesh.position.y = 0.34 + cycle * 0.62
        const s = Math.sin(cycle * Math.PI) * 1.2
        b.mesh.scale.setScalar(Math.max(0.15, s))
      }
      const pulseRing = jumpPadGroup.userData.pulseRing as THREE.Object3D | undefined
      if (pulseRing) {
        pulseRing.position.y = 0.38 + ((elapsedSeconds * 1.8) % 0.65)
        const s = 1 + ((elapsedSeconds * 1.8) % 0.65) * 0.45
        pulseRing.scale.set(s, s, 1)
      }
      for (const isl of skyIslands) {
        isl.group.position.y = isl.baseY + Math.sin(elapsedSeconds * 1.1 + isl.phase) * 0.45
        isl.group.rotation.y = elapsedSeconds * 0.12
      }
    },
    dispose() {
      for (const obj of sceneObjects) {
        scene.remove(obj)
      }
      for (const d of disposables) {
        d.dispose()
      }
    },
  }
}
