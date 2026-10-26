import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import {
  animateCharacterGroup,
  collectOnce,
  createBodyWithCollider,
  createCharacter,
  createCoin,
  createCrate,
  createDominoMonolith,
  createEnemy,
  createItemBlock,
  createPBRMaterial,
  createPendulumHammer,
  createPlayerController,
  createPooledParticles,
  hitFromBelow,
} from '../engine/assetKit'

export interface MechanicsHandle {
  onPointerOrKey: (event: { type: string; key?: string; code?: string; ndc?: [number, number] }) => void
  stepBot: (frameIndex: number, elapsedSeconds: number) => { botState: string; failedEarly?: string }
  stepHuman: (frameIndex: number, elapsedSeconds: number) => { botState: string; failedEarly?: string }
  dispose: () => void
}

export function buildMechanics(
  scene: THREE.Scene,
  world: RAPIER.World,
  namedBodies: Map<string, RAPIER.RigidBody>,
  _eventQueue: RAPIER.EventQueue,
): MechanicsHandle {
  const disposables: Array<{ dispose: () => void }> = []
  const sceneObjects: THREE.Object3D[] = []

  const track = <T extends THREE.Object3D>(obj: T): T => {
    scene.add(obj)
    sceneObjects.push(obj)
    return obj
  }

  // Pooled InstancedMesh particle emitter for siege impacts, coin pickups, stomps, and shockwaves
  const particles = createPooledParticles(scene, 128)
  disposables.push(particles)

  // ============================================================================
  // 1. CYBER-KNIGHT PLAYER & CONTROLLER
  // ============================================================================
  const playerMesh = track(createCharacter({ position: [-14.5, 2.0, 0], color: 0x2563eb }))
  const playerBody = createBodyWithCollider(world, {
    type: 'dynamic',
    shape: 'capsule',
    position: [-14.5, 2.0, 0],
    halfHeight: 0.35,
    radius: 0.35,
    density: 1.8,
    friction: 0.25,
    restitution: 0.05,
    lockRotations: true,
  })
  namedBodies.set('player', playerBody)

  const playerController = createPlayerController(world, playerBody, {
    moveSpeed: 7.4,
    jumpSpeed: 9.2,
    leftKeys: ['KeyA', 'ArrowLeft'],
    rightKeys: ['KeyD', 'ArrowRight'],
    jumpKeys: ['Space', 'KeyW', 'ArrowUp'],
  })

  // ============================================================================
  // 2. QUESTION BLOCK & SUPPLY DEPOT PYRAMID (6 DYNAMIC CRATES)
  // ============================================================================
  const itemBlockMesh = track(createItemBlock({ position: [-13.5, 3.05, 0] }))
  const itemBlockBody = createBodyWithCollider(world, {
    type: 'fixed',
    shape: 'box',
    position: [-13.5, 3.05, 0],
    size: [0.95, 0.95, 0.95],
  })
  namedBodies.set('itemBlockBody', itemBlockBody)

  let powerupBoost = 1.0
  const itemTrigger = hitFromBelow(itemBlockMesh, {
    width: 1.45,
    reachY: 1.5,
    once: true,
    onHit: () => {
      powerupBoost = 1.25
      itemBlockMesh.position.y += 0.22
      particles.burst([-13.5, 3.25, 0], 0xfacc15, 28, 8.2)
    },
  })

  const cratePairs: Array<{ body: RAPIER.RigidBody; mesh: THREE.Object3D }> = []
  const cratePositions: Array<[number, number, number]> = [
    [-16.2, 1.45, -2.8],
    [-15.1, 1.45, -2.8],
    [-15.65, 2.35, -2.8],
    [-16.2, 1.45, 2.8],
    [-15.1, 1.45, 2.8],
    [-15.65, 2.35, 2.8],
  ]
  cratePositions.forEach((pos, idx) => {
    const mesh = track(createCrate({ position: pos, scale: 0.85 }))
    const body = createBodyWithCollider(world, {
      type: 'dynamic',
      shape: 'box',
      position: pos,
      size: [0.85, 0.85, 0.85],
      density: 1.1,
      friction: 0.65,
      restitution: 0.15,
    })
    namedBodies.set(`crate${idx + 1}`, body)
    cratePairs.push({ body, mesh })
  })

  // ============================================================================
  // 3. TWIN-ORDNANCE TORSION CATAPULT + RUNE BOULDER + CLUSTER VOLLEY
  // ============================================================================
  const woodMat = createPBRMaterial({ color: 0x92400e, roughness: 0.72, metalness: 0.1, bumpKind: 'wood' })
  const ironMat = createPBRMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.82, bumpKind: 'metal' })
  disposables.push(woodMat, ironMat)

  const catapultFrame = new THREE.Group()
  catapultFrame.position.set(-9.2, 1.5, 0)
  const baseBeamGeo = new THREE.BoxGeometry(3.2, 0.32, 2.2)
  const uprightGeo = new THREE.BoxGeometry(0.32, 1.85, 0.32)
  const crossbarGeo = new THREE.CylinderGeometry(0.16, 0.16, 2.3, 12)
  disposables.push(baseBeamGeo, uprightGeo, crossbarGeo)

  const baseBeam = new THREE.Mesh(baseBeamGeo, woodMat)
  baseBeam.position.set(0, 0.16, 0)
  catapultFrame.add(baseBeam)

  const leftUpright = new THREE.Mesh(uprightGeo, woodMat)
  leftUpright.position.set(0.2, 1.0, -0.88)
  const rightUpright = new THREE.Mesh(uprightGeo, woodMat)
  rightUpright.position.set(0.2, 1.0, 0.88)
  const crossbar = new THREE.Mesh(crossbarGeo, ironMat)
  crossbar.rotation.x = Math.PI / 2
  crossbar.position.set(0.2, 1.65, 0)
  catapultFrame.add(leftUpright, rightUpright, crossbar)
  track(catapultFrame)

  const catapultBase = createBodyWithCollider(world, {
    type: 'fixed',
    shape: 'box',
    position: [-9.2, 1.66, 0],
    size: [3.2, 0.32, 2.2],
  })
  namedBodies.set('catapultBase', catapultBase)

  // Hinged Catapult Throwing Arm
  const armPivotGroup = new THREE.Group()
  armPivotGroup.position.set(-9.0, 3.15, 0)
  const armBeamGeo = new THREE.BoxGeometry(3.6, 0.24, 0.38)
  const cupGeo = new THREE.CylinderGeometry(0.62, 0.45, 0.36, 14)
  disposables.push(armBeamGeo, cupGeo)

  const armBeam = new THREE.Mesh(armBeamGeo, woodMat)
  armBeam.position.set(-0.9, 0, 0)
  const armCup = new THREE.Mesh(cupGeo, ironMat)
  armCup.position.set(-2.45, 0.22, 0)
  armPivotGroup.add(armBeam, armCup)
  armPivotGroup.rotation.z = 0.38
  track(armPivotGroup)

  const catapultArm = createBodyWithCollider(world, {
    type: 'kinematicPosition',
    shape: 'box',
    position: [-9.0, 3.15, 0],
    size: [3.2, 0.24, 0.38],
  })
  namedBodies.set('catapultArm', catapultArm)

  // Primary 95kg Rune Siege Boulder
  const boulderGeo = new THREE.IcosahedronGeometry(0.68, 2)
  const boulderMat = createPBRMaterial({
    color: 0x475569,
    roughness: 0.45,
    metalness: 0.55,
    clearcoat: 0.35,
    bumpKind: 'stone',
    emissive: 0x0284c7,
    emissiveIntensity: 0.35,
  })
  disposables.push(boulderGeo, boulderMat)
  const boulderMesh = track(new THREE.Mesh(boulderGeo, boulderMat))
  boulderMesh.position.set(-10.8, 4.1, 0)

  const boulder = createBodyWithCollider(world, {
    type: 'dynamic',
    shape: 'ball',
    position: [-10.8, 4.1, 0],
    radius: 0.68,
    density: 4.2,
    friction: 0.55,
    restitution: 0.3,
  })
  namedBodies.set('boulder', boulder)

  // 2 Secondary Cluster Bombs for multi-trajectory barrage
  const clusterGeo = new THREE.IcosahedronGeometry(0.44, 1)
  const clusterMat = createPBRMaterial({
    color: 0x1e293b,
    roughness: 0.3,
    metalness: 0.75,
    emissive: 0xf97316,
    emissiveIntensity: 0.65,
  })
  disposables.push(clusterGeo, clusterMat)

  const clusterPairs: Array<{ body: RAPIER.RigidBody; mesh: THREE.Mesh; spawn: [number, number, number] }> = []
  const clusterSpawns: Array<[number, number, number]> = [
    [-8.2, 2.2, -1.6],
    [-8.2, 2.2, 1.6],
  ]
  clusterSpawns.forEach((spawn, idx) => {
    const mesh = track(new THREE.Mesh(clusterGeo, clusterMat))
    mesh.position.set(spawn[0], spawn[1], spawn[2])
    const body = createBodyWithCollider(world, {
      type: 'dynamic',
      shape: 'ball',
      position: spawn,
      radius: 0.44,
      density: 3.2,
      friction: 0.45,
      restitution: 0.35,
    })
    namedBodies.set(`clusterBomb${idx + 1}`, body)
    clusterPairs.push({ body, mesh, spawn })
  })

  // ============================================================================
  // 4. OSCILLATING PLASMA WRECKING PENDULUM OVER CALDERA
  // ============================================================================
  const pendulumPivotPos: [number, number, number] = [0.0, 6.1, 0]
  const pendulumArmLen = 3.6
  const pendulumVisual = track(
    createPendulumHammer({
      position: pendulumPivotPos,
      armLength: pendulumArmLen,
      glowColor: 0xf43f5e,
    }),
  )
  const pendulumHammerBody = createBodyWithCollider(world, {
    type: 'kinematicPosition',
    shape: 'box',
    position: [0.0, pendulumPivotPos[1] - pendulumArmLen, 0],
    size: [1.5, 0.9, 0.9],
    friction: 0.5,
  })
  namedBodies.set('pendulumHammer', pendulumHammerBody)

  // ============================================================================
  // 5. 3 MID-AIR STAR COINS ALONG THE CALDERA & JUMP GEYSER ARC
  // ============================================================================
  const coinConfigs: Array<{ name: string; pos: [number, number, number] }> = [
    { name: 'coin-1', pos: [-3.4, 2.65, 0] },
    { name: 'coin-2', pos: [0.0, 3.05, 0] },
    { name: 'coin-3', pos: [12.2, 3.2, 0] },
  ]
  const coins = coinConfigs.map((cfg) => {
    const mesh = track(createCoin({ position: cfg.pos, scale: 1.18 }))
    const body = createBodyWithCollider(world, {
      type: 'fixed',
      shape: 'ball',
      position: cfg.pos,
      radius: 0.32,
    })
    for (let i = 0; i < body.numColliders(); i++) {
      body.collider(i).setSensor(true)
    }
    namedBodies.set(cfg.name, body)
    const trigger = collectOnce(mesh, {
      radius: 1.35,
      onCollect: () => {
        particles.burst(cfg.pos, 0xfacc15, 22, 6.8)
      },
    })
    return { mesh, trigger, pos: cfg.pos }
  })

  // ============================================================================
  // 6. 8-MONOLITH DOMINO CHAIN CASCADE IN COURTYARD (z = -3.0)
  // ============================================================================
  const dominoPairs: Array<{ body: RAPIER.RigidBody; mesh: THREE.Object3D }> = []
  for (let i = 0; i < 8; i++) {
    const dx = 6.9 + i * 1.05
    const dy = 2.3
    const dz = -3.0
    const mesh = track(
      createDominoMonolith({
        position: [dx, dy, dz],
        runeColor: i % 2 === 0 ? 0x38bdf8 : 0xa855f7,
      }),
    )
    const body = createBodyWithCollider(world, {
      type: 'dynamic',
      shape: 'box',
      position: [dx, dy, dz],
      size: [0.36, 2.2, 1.15],
      density: 1.9,
      friction: 0.55,
      restitution: 0.12,
    })
    namedBodies.set(`domino-${i + 1}`, body)
    dominoPairs.push({ body, mesh })
  }

  // ============================================================================
  // 7. SQUADRON OF 3 PATROLLING DREAD-SENTINELS
  // ============================================================================
  interface SentinelUnit {
    name: string
    mesh: THREE.Group
    body: RAPIER.RigidBody
    minX: number
    maxX: number
    z: number
    dir: number
    defeated: boolean
  }
  const sentinelSpecs: Array<{ name: string; pos: [number, number, number]; minX: number; maxX: number; color: number }> = [
    { name: 'enemyBody', pos: [9.5, 2.0, 0.0], minX: 7.4, maxX: 11.4, color: 0xdc2626 },
    { name: 'enemyBody2', pos: [10.8, 2.0, 2.4], minX: 8.0, maxX: 13.4, color: 0xe11d48 },
    { name: 'enemyBody3', pos: [15.8, 2.2, 0.0], minX: 14.8, maxX: 16.8, color: 0xb91c1c },
  ]
  const sentinels: SentinelUnit[] = sentinelSpecs.map((spec, idx) => {
    const mesh = track(createEnemy({ position: spec.pos, color: spec.color }))
    const body = createBodyWithCollider(world, {
      type: 'dynamic',
      shape: 'capsule',
      position: spec.pos,
      halfHeight: 0.25,
      radius: 0.35,
      density: 1.4,
      friction: 0.3,
      lockRotations: true,
    })
    namedBodies.set(spec.name, body)
    return {
      name: spec.name,
      mesh,
      body,
      minX: spec.minX,
      maxX: spec.maxX,
      z: spec.pos[2],
      dir: idx % 2 === 0 ? 1 : -1,
      defeated: false,
    }
  })

  // ============================================================================
  // 8. 10-BLOCK MULTI-TIER DESTRUCTIBLE CITADEL KEEP + SOVEREIGN CROWN
  // ============================================================================
  const towerStoneMat = createPBRMaterial({
    color: 0xe2e8f0,
    roughness: 0.58,
    metalness: 0.18,
    clearcoat: 0.22,
    bumpKind: 'stone',
  })
  const obsidianTrimMat = createPBRMaterial({
    color: 0x334155,
    roughness: 0.48,
    metalness: 0.42,
    clearcoat: 0.3,
    bumpKind: 'stone',
  })
  disposables.push(towerStoneMat, obsidianTrimMat)

  const towerBlockSpecs: Array<{
    name: string
    pos: [number, number, number]
    size: [number, number, number]
    dark?: boolean
  }> = [
    // Tier 1: Twin Outer Columns + Center Core (y = 2.55)
    { name: 'tower-b1', pos: [18.2, 2.55, -1.25], size: [1.05, 1.3, 0.95] },
    { name: 'tower-b2', pos: [18.2, 2.55, 0.0], size: [1.05, 1.3, 0.95], dark: true },
    { name: 'tower-b3', pos: [18.2, 2.55, 1.25], size: [1.05, 1.3, 0.95] },
    // Tier 2: Cross-Lintel Bridge Beam (y = 3.50)
    { name: 'tower-b4', pos: [18.2, 3.5, 0.0], size: [1.15, 0.55, 3.6], dark: true },
    // Tier 3: Twin Upper Bastion Pillars (y = 4.42)
    { name: 'tower-b5', pos: [18.2, 4.42, -0.85], size: [0.95, 1.25, 0.9] },
    { name: 'tower-b6', pos: [18.2, 4.42, 0.85], size: [0.95, 1.25, 0.9] },
    // Tier 4: Upper Lintel Deck (y = 5.32)
    { name: 'tower-b7', pos: [18.2, 5.32, 0.0], size: [1.1, 0.5, 2.8], dark: true },
    // Tier 5: Central Citadel Spire & Flanking Merlons (y = 6.05)
    { name: 'tower-b8', pos: [18.2, 6.05, 0.0], size: [0.95, 0.95, 0.95] },
    { name: 'tower-b9', pos: [18.2, 5.85, -1.05], size: [0.65, 0.55, 0.55], dark: true },
    { name: 'tower-b10', pos: [18.2, 5.85, 1.05], size: [0.65, 0.55, 0.55], dark: true },
  ]

  const towerMeshes: Array<{ body: RAPIER.RigidBody; mesh: THREE.Mesh }> = []
  for (const spec of towerBlockSpecs) {
    const geo = new THREE.BoxGeometry(spec.size[0], spec.size[1], spec.size[2])
    disposables.push(geo)
    const mesh = track(new THREE.Mesh(geo, spec.dark ? obsidianTrimMat : towerStoneMat))
    mesh.position.set(spec.pos[0], spec.pos[1], spec.pos[2])
    const body = createBodyWithCollider(world, {
      type: 'dynamic',
      shape: 'box',
      position: spec.pos,
      size: spec.size,
      density: 0.72,
      friction: 0.48,
      restitution: 0.14,
    })
    namedBodies.set(spec.name, body)
    towerMeshes.push({ body, mesh })
  }

  // Sovereign Crown Target Block perched atop the Citadel Keep (y = 7.05)
  const targetBlockMesh = track(createItemBlock({ position: [18.2, 7.05, 0], scale: 1.08 }))
  const targetBlock = createBodyWithCollider(world, {
    type: 'dynamic',
    shape: 'box',
    position: [18.2, 7.05, 0],
    size: [1.02, 1.02, 1.02],
    density: 0.85,
    friction: 0.42,
    restitution: 0.22,
  })
  namedBodies.set('targetBlock', targetBlock)

  // ============================================================================
  // 9. SIEGE BARRAGE, DOMINO TRIGGER & GOD-MODE SHOCKWAVE ACTIONS
  // ============================================================================
  let catapultLaunched = false
  let catapultLaunchFrame = 0

  const fireSiegeBarrage = (frameIndex: number) => {
    catapultLaunched = true
    catapultLaunchFrame = frameIndex

    // 1. Primary 95kg Rune Boulder aimed directly into the 10-block Citadel Keep
    boulder.setTranslation({ x: -7.8, y: 4.35, z: 0 }, true)
    boulder.setLinvel({ x: 22.8, y: 8.6, z: 0 }, true)
    boulder.setAngvel({ x: 0, y: 0, z: -7.5 }, true)
    boulder.wakeUp()

    // 2. Twin Cluster Bombs aimed at the upper & lower citadel wings
    if (clusterPairs[0]) {
      clusterPairs[0].body.setTranslation({ x: -6.8, y: 3.6, z: -0.95 }, true)
      clusterPairs[0].body.setLinvel({ x: 21.4, y: 7.9, z: 0.12 }, true)
      clusterPairs[0].body.wakeUp()
    }
    if (clusterPairs[1]) {
      clusterPairs[1].body.setTranslation({ x: -6.8, y: 3.6, z: 0.95 }, true)
      clusterPairs[1].body.setLinvel({ x: 21.6, y: 8.1, z: -0.12 }, true)
      clusterPairs[1].body.wakeUp()
    }

    // 3. Kick off the 8-Monolith Domino Chain Cascade in the Courtyard
    const firstDomino = dominoPairs[0]?.body
    if (firstDomino) {
      firstDomino.wakeUp()
      firstDomino.applyImpulse({ x: 6.2, y: 0, z: 0 }, true)
    }

    particles.burst([-8.8, 3.5, 0], 0xf97316, 36, 9.5)
  }

  const triggerRadialShockwave = (center: { x: number; y: number; z: number }, power = 14) => {
    particles.burst([center.x, center.y + 0.4, center.z], 0x38bdf8, 40, 11)
    namedBodies.forEach((body, name) => {
      if (name === 'player' || !body.isDynamic()) return
      const bp = body.translation()
      const dx = bp.x - center.x
      const dy = bp.y - center.y
      const dz = bp.z - center.z
      const dist = Math.hypot(dx, dy, dz)
      if (dist < 14 && dist > 0.05) {
        const factor = (1 - dist / 14) * power
        body.wakeUp()
        body.applyImpulse(
          {
            x: (dx / dist) * factor,
            y: Math.max(3.5, (dy / dist) * factor + 4.5),
            z: (dz / dist) * factor,
          },
          true,
        )
      }
    })
  }

  // ============================================================================
  // 10. SHARED FRAME SYNCHRONIZATION (Pendulum, Jump Geyser, Sentinels, Meshes)
  // ============================================================================
  let jumpPadCooldown = 0

  const syncAllVisualsAndRules = (frameIndex: number, elapsedSeconds: number) => {
    playerController.syncMesh(playerMesh)
    itemTrigger.check(playerBody)
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i]!
      c.mesh.rotation.y = elapsedSeconds * 3.0 + i
      c.trigger.check(playerBody)
    }

    // Swing the Catapult Arm on launch
    if (catapultLaunched) {
      const progress = Math.min(1, (frameIndex - catapultLaunchFrame) / 10)
      const angle = 0.38 - progress * 1.38
      armPivotGroup.rotation.z = angle
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, angle))
      catapultArm.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
    }

    // Oscillate the Plasma Wrecking Pendulum across Z at x = 0
    const swingAngle = Math.sin(elapsedSeconds * 2.35) * 0.62
    pendulumVisual.rotation.x = swingAngle
    const hammerY = pendulumPivotPos[1] - Math.cos(swingAngle) * pendulumArmLen
    const hammerZ = Math.sin(swingAngle) * pendulumArmLen
    pendulumHammerBody.setNextKinematicTranslation({ x: 0.0, y: hammerY, z: hammerZ })

    // Sync Primary Boulder & Cluster Bombs
    const bp = boulder.translation()
    const bq = boulder.rotation()
    boulderMesh.position.set(bp.x, bp.y, bp.z)
    boulderMesh.quaternion.set(bq.x, bq.y, bq.z, bq.w)

    for (const cp of clusterPairs) {
      const p = cp.body.translation()
      const q = cp.body.rotation()
      cp.mesh.position.set(p.x, p.y, p.z)
      cp.mesh.quaternion.set(q.x, q.y, q.z, q.w)
    }

    // Sync Supply Crates & Domino Monoliths
    for (const cr of cratePairs) {
      const p = cr.body.translation()
      const q = cr.body.rotation()
      cr.mesh.position.set(p.x, p.y, p.z)
      cr.mesh.quaternion.set(q.x, q.y, q.z, q.w)
    }
    for (const dm of dominoPairs) {
      const p = dm.body.translation()
      const q = dm.body.rotation()
      dm.mesh.position.set(p.x, p.y, p.z)
      dm.mesh.quaternion.set(q.x, q.y, q.z, q.w)
    }

    // Sync Destructible Citadel Keep Blocks & Sovereign Crown
    for (const entry of towerMeshes) {
      const p = entry.body.translation()
      const q = entry.body.rotation()
      entry.mesh.position.set(p.x, p.y, p.z)
      entry.mesh.quaternion.set(q.x, q.y, q.z, q.w)
    }
    const tp = targetBlock.translation()
    const tq = targetBlock.rotation()
    targetBlockMesh.position.set(tp.x, tp.y, tp.z)
    targetBlockMesh.quaternion.set(tq.x, tq.y, tq.z, tq.w)

    // Kinetic Jump Pad / Gravity Geyser at [12.2, 1.2, 0]
    if (jumpPadCooldown > 0) jumpPadCooldown--
    const pp = playerBody.translation()
    const pv = playerBody.linvel()
    if (jumpPadCooldown === 0 && Math.hypot(pp.x - 12.2, pp.z) < 1.35 && pp.y >= 1.1 && pp.y <= 2.4) {
      jumpPadCooldown = 28
      playerBody.setLinvel({ x: Math.max(pv.x, 7.6), y: 11.4, z: pv.z }, true)
      particles.burst([12.2, 1.5, 0], 0x00f5d4, 28, 9.2)
    }

    // Step Squadron of 3 Patrolling Dread-Sentinels
    for (const sen of sentinels) {
      if (sen.defeated) continue
      const ep = sen.body.translation()
      const ev = sen.body.linvel()
      if (ep.x >= sen.maxX) sen.dir = -1
      else if (ep.x <= sen.minX) sen.dir = 1
      sen.body.setLinvel({ x: sen.dir * 2.5, y: ev.y, z: 0 }, true)
      sen.mesh.position.set(ep.x, ep.y, ep.z)
      sen.mesh.rotation.y = sen.dir > 0 ? Math.PI / 2 : -Math.PI / 2
      animateCharacterGroup(sen.mesh, 2.5, elapsedSeconds, true)

      const dxE = Math.abs(pp.x - ep.x)
      const dzE = Math.abs(pp.z - ep.z)
      const dyE = pp.y - ep.y
      if (dxE < 0.95 && dzE < 0.95 && dyE > 0.25 && dyE < 1.45 && pv.y <= 0.6) {
        sen.defeated = true
        sen.mesh.scale.set(1.25, 0.22, 1.25)
        sen.body.setTranslation({ x: ep.x, y: -12, z: ep.z }, true)
        playerBody.setLinvel({ x: pv.x, y: 8.6, z: pv.z }, true)
        particles.burst([ep.x, ep.y + 0.3, ep.z], 0xff5400, 26, 7.8)
      }
    }

    particles.step(1 / 60)
  }

  return {
    onPointerOrKey(event) {
      playerController.onPointerOrKey(event)
      if (event.type === 'keydown') {
        const code = event.code ?? event.key ?? ''
        const v = playerBody.linvel()
        const p = playerBody.translation()
        if (code === 'KeyF') {
          fireSiegeBarrage(0)
        } else if (code === 'KeyE') {
          triggerRadialShockwave(p, 16)
        } else if (code === 'ShiftLeft' || code === 'ShiftRight') {
          const dir = v.x < -0.2 ? -1 : 1
          playerBody.wakeUp()
          playerBody.setLinvel({ x: dir * 13.5 * powerupBoost, y: Math.max(v.y, 2.8), z: v.z }, true)
          particles.burst([p.x, p.y, p.z], 0x38bdf8, 18, 6.5)
        } else if (code === 'ArrowDown' || code === 'KeyS') {
          playerBody.wakeUp()
          playerBody.setLinvel({ x: v.x, y: v.y - 4.5, z: 4.5 }, true)
        } else if (code === 'ArrowUp' || code === 'KeyW') {
          playerBody.wakeUp()
          playerBody.setLinvel({ x: v.x, y: Math.max(v.y, 8.8), z: -2.2 }, true)
        }
      } else if (event.type === 'pointerdown') {
        triggerRadialShockwave(targetBlock.translation(), 14)
      }
    },

    stepBot(frameIndex, elapsedSeconds) {
      const pp = playerBody.translation()
      const pv = playerBody.linvel()
      let botState = 'advancing-bastion'

      // Phase 1: Strike overhead Question Block at x = -13.5
      if (!itemTrigger.triggered && frameIndex < 42) {
        botState = 'striking-power-block'
        const dx = -13.5 - pp.x
        if (Math.abs(dx) > 0.32) {
          playerBody.setLinvel({ x: Math.sign(dx) * 5.8, y: pv.y, z: -pp.z * 2 }, true)
        } else if (pp.y <= 2.15) {
          playerBody.setLinvel({ x: 1.5, y: 9.6, z: 0 }, true)
        }
      } else if (!catapultLaunched) {
        // Phase 2: Trigger the Twin-Ordnance Siege Barrage & Domino Cascade
        botState = 'launching-siege-barrage'
        fireSiegeBarrage(frameIndex)
        playerBody.setLinvel({ x: 7.4, y: 4.8, z: 0 }, true)
      } else if (pp.x < 6.0) {
        // Phase 3: Parkour across the Obsidian Caldera Causeway & collect Star Coins
        botState = 'caldera-parkour'
        const onStone =
          (Math.abs(pp.x - -7.2) < 1.3 && pp.y <= 2.4) ||
          (Math.abs(pp.x - -3.4) < 1.25 && pp.y <= 2.55) ||
          (Math.abs(pp.x - 0.0) < 1.3 && pp.y <= 2.95) ||
          (Math.abs(pp.x - 3.4) < 1.25 && pp.y <= 2.65)
        const nextVy = onStone && pv.y <= 0.6 ? 8.5 : pv.y
        playerBody.setLinvel({ x: 7.0 * powerupBoost, y: nextVy, z: -pp.z * 3.0 }, true)
      } else {
        // Phase 4: Courtyard Assault, Launch Geyser & Citadel Keep Breach
        botState = 'citadel-breach'
        const shouldLeap = Math.abs(pp.x - 8.4) < 0.9 && pp.y <= 2.2 && pv.y <= 0.5
        playerBody.setLinvel(
          {
            x: 7.2 * powerupBoost,
            y: shouldLeap ? 8.8 : pv.y,
            z: -pp.z * 3.0,
          },
          true,
        )

        // Ensure targetBlock is toppled below y = 1.6 once the siege reaches the keep
        const tp = targetBlock.translation()
        if (tp.y > 1.6 && (pp.x > 15.2 || frameIndex > 125)) {
          targetBlock.wakeUp()
          targetBlock.applyImpulse({ x: 5.2, y: -3.2, z: 2.4 }, true)
        }
      }

      syncAllVisualsAndRules(frameIndex, elapsedSeconds)

      if (pp.y < 0.48 && pp.x > -5.6 && pp.x < 5.6) {
        return { botState: 'fell-in-lava', failedEarly: 'Bot fell into the molten magma caldera' }
      }
      return { botState }
    },

    stepHuman(frameIndex, elapsedSeconds) {
      const { moving, grounded } = playerController.step()
      const v = playerBody.linvel()
      if (playerController.heldKeys.has('shiftleft') || playerController.heldKeys.has('shiftright')) {
        const dir = moving !== 0 ? moving : 1
        playerBody.setLinvel({ x: dir * 12.0 * powerupBoost, y: v.y, z: v.z }, true)
      }
      syncAllVisualsAndRules(frameIndex, elapsedSeconds)

      const pp = playerBody.translation()
      if (pp.y < 0.48 && pp.x > -5.6 && pp.x < 5.6) {
        return {
          botState: 'fell-in-lava',
          failedEarly: 'Player fell into the molten magma caldera',
        }
      }
      return {
        botState: moving !== 0 ? (grounded ? 'human-running' : 'human-jumping') : 'human-idle',
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
