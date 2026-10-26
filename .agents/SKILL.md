# Learned Physics & Architectural Invariants (Argon Engine AAA Reference)

## 1. Catapult & Torsion Siege Mechanics
- Keep `armHalfLength >= 2.2` and pivot anchor height `y >= 1.5` so the throwing cup clears the frame base cleanly during launch arc (`-0.38 rad` to `+1.05 rad`).
- Use Rapier `IntegrationParameters` or explicit angular velocity drives (`armBody.setAngvel({ x: 0, y: 0, z: -9.5 }, true)`) combined with tangential impulse on release when arm angle passes `0.38 rad` for repeatable parabolic trajectories across `14m - 26m` spans.
- Release boulders from the cup by removing the fixed/revolute hold joint at peak angular velocity and applying a forward-upward boost (`{ x: 16.5, y: 8.5, z: 0 }`) so the boulder arcs high over the magma caldera and strikes the target tower at `y = 2.0 - 4.5`.

## 2. Destructible Structures & Breakage Thresholds
- Pre-fracture target towers and bridge spans into individual dynamic `RAPIER.RigidBodyDesc.dynamic()` blocks (`mass: 1.5 - 3.2`, `friction: 0.85`, `restitution: 0.12`).
- Allow a `graceSteps: 45` settling window at world boot before arming `createBreakableJointTracker` so initial gravity stacking settles without premature joint snaps.
- Set structural mortar `breakForce` between `22` and `38` so the structure stands rock-solid at rest under gravity, yet shatters dramatically when struck by a high-momentum projectile (`speed >= 8.5 m/s`).

## 3. Character Controller & Bot Navigation
- Standardize player capsule collider at `halfHeight = 0.45, radius = 0.35` (`totalHeight = 1.6m`) with `body.lockRotations(true, true)` and `ccdEnabled = true`.
- Grounded checks must cast a downward ray from `pos.y - 0.48` with `maxToi = 0.42` excluding `player.body` so jump triggers reliably on sloped or jointed planks.
- Always bind both autonomous bot progression (`!ctx.controls.paused`) and responsive human keyboard controls (`ArrowLeft/KeyA`, `ArrowRight/KeyD`, `ArrowUp/KeyW`, `ArrowDown/KeyS`, `Space`, `ShiftLeft/KeyE`, `KeyF`) in `onStep`.

## 4. Orbital & N-Body Slingshot Dynamics
- Set world gravity to `{ x: 0, y: 0, z: 0 }` and compute pairwise inverse-square gravitational forces `F = G * m1 * m2 / max(r^2, softening^2)` with `softening >= 1.8` to prevent infinite slingshot ejection near stellar cores.
- Render predictive trajectory ribbons ahead of the probe using Verlet integration steps so both the human pilot and autonomous bot can align transfer burns.

## 5. Domino Cascades & 10-Pin Bowling
- Space dominoes at `0.55 * height` intervals along smooth parametric splines with `friction: 0.45` and `ccdEnabled: true` on the trigger striker.
- Arrange 10 bowling pins in an equilateral triangle (`rowSpacing = 0.92`, `colSpacing = 0.54`) on a low-friction oiled lane (`friction: 0.08`) with raised gutter bumpers so slightly off-center strikes still transfer lateral kinetic energy across all 10 pins.
