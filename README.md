# Patchworld

Describe a physical goal and Patchworld builds it as a playable 3D level, sends a bot in to play it, watches the recording when the bot fails, and rewrites the level live until the bot wins. Then you take the controls.

The whole screen is one Three.js + Rapier physics canvas. Levels hot-swap into it without a page reload, so you watch each fix land in the same world.

## The loop

1. **Generate.** Gemini writes the level as a TypeScript module (geometry, physics bodies, the bot's plan, the win rule). It's typechecked before it touches the screen.
2. **Playtest.** The bot gets up to 8 seconds. The canvas is recorded to video, with physics telemetry alongside it.
3. **Critique.** On a failure, the video goes back to Gemini. The critic's notes stream into the corner card, citing timestamps you can click to scrub the replay ("At 0:05 the boulder flies over the bridge…").
4. **Patch.** Gemini edits the level code and the new version hot-swaps in. The bot tries again, up to eight times. Every attempt stays in one Gemini conversation, so each critique compares the new run with all the earlier ones; the replay card shows how much context Gemini is holding.
5. **Play.** Once the bot wins, take over: right-drag to orbit, the level's own keys to play, and a box to either twist the world ("make the cup slide back and forth") or describe a brand-new one. Twists edit the current level rather than starting over.

The Workshop drawer (bottom left) shows the live log, a code diff for every iteration, the history of attempts with their replays, and the lessons the critic has learned so far.

## Run it

You need Node 22 or later.

```bash
npm install
```

**Demo mode (no API key, no cost).** Replays a scripted three-attempt Catapult run through the real loop: the bot fails twice, gets critiqued, gets patched, then wins.

```bash
npm run dev:mock
```

**Live mode.** Put your Gemini key in `.env`, then start the app.

```text
GEMINI_API_KEY=your-key
```

```bash
npm run dev
```

Open the page Vite prints (normally http://localhost:5173) and keep the tab visible. Browsers pause animation in hidden tabs, so a playtest only runs while the page is on screen. Pick a preset or describe your own world.

Typical live timings: about 50 to 80 s for the first world, about 7 s for a video critique, and then the patch. Every live run is saved under `artifacts/runs/`. Replay any of them later, with no API calls, using `npm run dev:mock -- --mock=artifacts/runs/<folder>`.

## Settings

All optional, in `.env`:

| Setting | Default | What it does |
|---|---|---|
| `ARGON_MODEL` | `gemini-4-argon` | Model for every call |
| `ARGON_WORLD_THINKING` | `medium` | Thinking effort for the first world |
| `ARGON_PATCH_THINKING` / `ARGON_CRITIQUE_THINKING` | `low` | Thinking effort for patches and critiques |
| `ARGON_MAX_ITERATIONS` | `8` | Attempts before the loop stops |
| `ARGON_MOCK` | off | `1` or a fixture or run folder: replay instead of calling Gemini |
| `ARGON_SYNC_PORT` / `VITE_ARGON_SYNC_URL` | `4174` | Move the local sync daemon off its default port |

## How it fits together

- `src/engine/`: the persistent engine. It mounts each generated level into a fresh Rapier world, frames the camera to it, runs the bot at a fixed 60 Hz and records playtests.
- `server/syncDaemon.ts`: the local WebSocket broker. It drives the loop, typechecks generated files before writing them into `src/generated/`, and tracks the history of attempts.
- `server/argonOrchestrator.ts`: the Gemini side. It runs streamed calls, sends the video inline, keeps the critique and the patch as separate calls, applies find-and-replace edits (falling back to whole files), and repairs levels that crash on load.
- `src/generated/activeLevel.ts`: the level contract. It exports `buildWorld(scene, world, namedBodies, eventQueue)`, returning `stepBotAndRules`, an optional `stepHumanAndRules` and `onPointerOrKey`, and `dispose`. See `src/engine/types.ts`.

The API key stays in the daemon. The browser only ever sees goals, progress, video and code.

## Checks

```bash
npm test
npm run build
npm run probe:live   # one real world generation, timed, no browser needed
```
