# Patchworld handoff

## Goal
Bright arcade / pixel-inspired frontend for the persistent self-healing physics sandbox. Patchworld is the working product name; Argon remains an internal model/protocol name.

## Implementation
- `src/App.tsx`, `src/components/`, `src/hooks/useSandbox.ts`, `src/index.css`: componentized UI, real progress/replay/terminal/skill events, local fonts, responsive fixed overlays.
- `src/engine/EngineHost.ts`, `AutonomousLoop.ts`: persistent canvas, resize caching, reset, human takeover and recorder cancellation.
- `server/syncDaemon.ts`: pre-HMR typecheck, entry commit fix, iteration limit, stale-response cancellation, skill publication.
- `server/argonOrchestrator.ts`: Google SDK interaction/file API shapes and real tool-output forwarding.
- `vite.config.ts`: Tailwind integration and heavy library chunks. `tsconfig.server.json`: backend build checking.

## Verification
- Final `npm run build` passed with no warnings (frontend and backend typechecked).
- Final `npm test`: 5 tests passed, 0 failures.
- Workshop open/close and SKILL.md tab checked in the browser; preview saved as `patchworld-preview.png`.
- Local no-credit dry-run passed: 240-frame failure, 598734 WebM bytes + telemetry; HMR retry reached goal at frame 60. Temporary generated files/artifacts restored/removed.
- Desktop 1280x720 appearance inspected in browser.
- Live provider generation was not verified: earlier credential smoke found no usable GEMINI_API_KEY assignment in `.env`. Never expose its contents.

## Running
`npm run dev`: Vite at localhost:5173 (or the next free port), daemon ws://127.0.0.1:4174. Server changes require restart; frontend uses HMR. Run `npm run build`, `npm test`, and (with open browser) `npm run dry-run` for verification. Do not submit live presets without intending to use provider credits.

## Mock mode (no API key, no credits)
`npm run dev:mock` replays a scripted run through the real daemon, HMR, playtest and replay path: any prompt plays the catapult script in `src/fixtures/` (draft 1 fires backwards, draft 2's boulder is a sensor and passes through the boss, draft 3 wins). Use it to rehearse the demo and as the fallback if the API is slow or down. Every live goal is also recorded under `artifacts/runs/<time>-<goal>/`; replay a good one with `tsx server/syncDaemon.ts --mock=artifacts/runs/<folder>` (or `ARGON_MOCK=<folder>`). Settings are listed in `.env.example`.

## Daemon reliability notes (Oct 25)
- Only one browser tab drives playtests: the one that started the goal. Other open tabs mirror progress. Previously every open tab ran and uploaded each playtest, which doubled critiques and raced file writes.
- If a generated level throws while mounting, the browser reports it (`level-mount-failed`) and the daemon repairs it when the orchestrator implements `repairMountFailure`, or stops the loop with the error instead of hanging. A 15 s watchdog covers modules that never mount.
- Vite no longer watches `.agents/`, `artifacts/` or Markdown files: writing SKILL.md used to reload the page mid-playtest and stall the loop from iteration 2 onward.
- A batch the orchestrator already typechecked is not checked again before writing, and parsed library typings are cached between checks (about 1 to 4 s per check instead of 7 to 16 s on this machine).
- Protocol additions for the UI are documented in `src/shared/protocol.ts`: `critique-text`, `iteration-history`, and `patch-applied` with before/after file contents. The browser re-dispatches them as `argon:critique-text`, `argon:iteration-history` and `argon:patch-applied` window events.
