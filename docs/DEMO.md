# The 3-minute demo

One screen, no slides. A judge gives us a physical idea, Patchworld builds it, watches its own bot fail on video, fixes the code live, and then the judge plays the fixed level.

Timings below come from a rehearsal in mock mode at 1280×720 (Oct 25). In mock mode the whole loop, from pressing **Build** to the judge's "You did it!", took **63 seconds**, which leaves plenty of room to talk. Live Gemini timing has not been measured yet; see [Fallback](#fallback).

## Before judges arrive

- [ ] `npm install`, then `GEMINI_API_KEY=...` in `.env` for live mode.
- [ ] Start **one** daemon: `npm run dev` (live) or `npm run dev:mock` (recorded run). Restart it between judges so iterations start at 1.
- [ ] Open **one** browser tab at the Vite URL (usually `http://localhost:5173`), full screen, at least 1280×720. Only the tab that starts a goal drives playtests.
- [ ] Wait for **READY TO PLAY** in the top right. Close the Workshop drawer.
- [ ] Keep a second terminal ready with `npm run dev:mock` for the fallback.

## Script

| Time | On screen | Say / do |
|---|---|---|
| **0:00–0:20** | Empty world, "Make a little chaos." | "Physics code can compile and still be wrong: the bridge doesn't break, the boulder flies backwards. Patchworld writes a 3D physics level, watches its own bot play it on video, and fixes what it sees, live." |
| **0:20–0:40** | Prompt bar | **Ask the judge for a wild mechanic or twist.** Type it (or pick *Catapult chaos* and add their twist) and press **Build**. |
| **0:40–1:00** | Ticker: *PASS 1: LONG DECODE* | "Gemini writes the whole Three.js and Rapier level in one pass. The daemon typechecks it before it touches the page, then Vite hot-swaps it in. No reload, the page never dies." *(mock: Draft 1 appears ~11 s after Build)* |
| **1:00–1:15** | *BOT AT PLAY*, replay card | "A bot plays Draft 1 for eight seconds while the browser records it." |
| **1:15–1:35** | Replay card: **AGENT IS WATCHING**, then **CRITIQUE · LIVE** | "It failed. A Managed Agent is watching that video right now. Here's its critique streaming in, with timestamps." *(mock: critique ~28 s after Build, done ~2 s later)* **Click the first timestamp chip**: "It jumps the replay to the exact moment it's talking about." |
| **1:35–1:55** | **Workshop → Code** | Open the Workshop, **Code** tab: "This is the patch it wrote for that failure: a three-line diff, not a rewrite." Close the Workshop. |
| **1:55–2:15** | Attempt strip `✗01 ✗02 ✓03` | "Hot-reloaded, retried." Let iteration 2 fail and iteration 3 win. *(mock: goal ~49 s after Build)* |
| **2:15–2:35** | **DRAFT 1 VS WIN** | Click it, then **Play both**: "Same goal. Left is what it wrote first, right is what it fixed itself into." Press **Esc**. |
| **2:35–3:00** | Control bar: *The bot beat this level. Your turn* | **Hand over the laptop.** "Your turn." Judge clicks **Reset and play**; the keycaps show the level's real controls (catapult: **Space**). They play until **You did it!** Offer **Add a twist** if there's time. |

## Fallback

Decide fast and say it out loud; judges forgive a fallback, not a stall.

- **No level 60 s after Build (live):** stop the daemon, run `npm run dev:mock`, reload the tab, press Build again. Say: "Live generation is slow right now, so here's a recorded run of the same loop." Mock mode replays the scripted catapult run whatever the prompt is, so don't promise the judge's idea in this mode.
- **"TypeScript rejected the draft"** in the ticker: that's a feature. "The daemon refused to hot-load code that doesn't typecheck. It sends the errors back for one repair pass." Keep going.
- **Iteration limit reached** (4 by default, `ARGON_MAX_ITERATIONS`): open the attempt strip, show the critiques, then switch to mock for the handoff.
- **Judge's play fails:** the "So close!" screen offers **Try again**.

## Rehearsal log (mock mode, 1280×720, Oct 25)

| After Build | Beat |
|---|---|
| 11 s | Draft 1 mounted, bot playing |
| 28 s | Draft 1 failed, agent watching |
| 29 s → 31 s | Critique streaming → done |
| 39 s | Iteration 2 replay |
| 49 s | Goal reached on iteration 3 |
| 53 s | Draft 1 vs win panel |
| 58 s → 63 s | Judge: Reset and play → Space → "You did it!" |

No page errors during the run. The README GIF is this rehearsal at 2× speed.
