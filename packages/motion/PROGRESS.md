# Part C: progress

Branch `part-c-motion`. All of §8 is implemented and tested on a real player: the Lab **gesture test passes 12/12**
and all **5 reference recordings** replay correctly. There are 77 automated tests, including a golden test that pins
the 10 original passing moves and calibration byte-for-byte.

## Commands (PowerShell, from the repo root)

```powershell
pnpm install                                   # once
pnpm --filter @ithaca/motion fetch-models      # once per machine: models + wasm → apps/web/public/models
pnpm --filter @ithaca/motion lab               # Motion Lab → open http://localhost:5174
pnpm --filter @ithaca/motion test              # unit tests + replays every recording in fixtures/
pnpm --filter @ithaca/motion typecheck
```

## Acceptance criteria (§8 C.10)

| | Criterion | Status |
|---|---|---|
| ✅ | `createMotionController()` satisfies `InputController`; one-line swap | Met (typechecked against `@ithaca/shared`) |
| ⚠️ | ≥ 30 Hz on an M-series Mac with the game running | **Not verified.** The Windows dev laptop recorded at 15–17 fps (auto low-fps mode). Check on the Mac with the game running |
| ⚠️ | Grab/release < 5 % false triggers in a 60 s session | **Not measured yet.** Needs a 60 s free-play recording |
| ❌ | Throw direction within ~20° of intended | **Not met in the recording:** releases came out 35° and 56° off forward (downward follow-through). Passes the Lab throw test (> 1.5 m/s, toward the screen). Needs tuning or aim assist in the game |
| ⚠️ | Bow, block, drink, call_sign, request_weapon fire reliably with 2 teammates | **1 of 2 teammates done** (12/12 in the gesture test plus the 5 recordings). Needs a second person |
| ✅ | Calibration < 20 s | Met. About 6 s of holds plus 3 fist cycles; it waits for each movement and passed live |
| ✅ | Works offline after first load | Met by design (models + wasm served from `/models`, nothing from a CDN). Not yet hand-tested with Wi-Fi off |

## Done

| Spec | What | Where |
|---|---|---|
| C.1 | Pose (full/lite) + Hand landmarkers, VIDEO mode, GPU with automatic CPU fallback (also rebuilds on CPU if the GPU dies mid-run), local wasm | `src/tracker.ts` |
| C.1 | Windows-safe model fetch (Node), size checks, skips files it already has, models git-ignored | `scripts/fetch-models.mjs` |
| C.2 | rVFC loop (rAF fallback), hand↔pose-wrist association, un-mirroring, ≤ 50 ms extrapolation in `getState()` | `tracker.ts`, `mapping.ts`, `engine.ts` |
| C.3 | Game-space mapping, 50/50 depth fusion, z clamp, One-Euro, forward/up vectors, lean/crouch/yaw | `src/mapping.ts`, `src/oneEuro.ts` |
| C.4 | Finger-curl grip, 0.65/0.35 hysteresis × 2 frames, hold-through-blips. Release velocity = **peak** speed in the last 300 ms (extended over motion-blur gaps), including image-plane wrist speed | `src/grip.ts` |
| C.5 | swing, block, bow, drink, call_sign (+ progress ring), request_weapon, tracking_lost/ok. Bow: arm readiness latched through the nock, stays nocked while drawing, looses on any clear open above 30 % draw | `src/gestures.ts` |
| C.5 | Every threshold in `config.ts`, with live sliders in the Lab | `src/config.ts`, `src/lab/panels.ts` |
| C.6 | 4-step calibration that only advances while you do each move, with live hints and a PASS/FAIL panel. A step fails after 15 s with the reason | `src/calibration.ts` |
| C.7 | Motion Lab: overlay, game-space view, readouts, detector chips, sliders, calibrate, **Test gestures** (12 guided moves with PASS/FAIL), record / load replay | `src/lab/*`, `lab/` |
| C.7 | `createReplayController`, `runReplay`. Recordings now store the calibration; older ones get the grip range rebuilt from their own data (`replayProfile`) | `src/replay.ts`, `src/recording.ts` |
| C.7 | 5 reference recordings: throw, bow, block, call, drink | `fixtures/` |
| C.8 | fps, ms/frame (pose · hands), per-side hand hit rate and IMAGE retries in the Lab. Perf fallback only when detection is the bottleneck: alternate L/R hand crops (960×540 + hands every 2nd frame only on the old full-frame path); reset on stop | `tracker.ts` |
| C.2 | Pose-guided hand crops: one VIDEO HandLandmarker per side on a 256² crop placed from the pose wrist (Holistic geometry), same-frame IMAGE retry, full-frame re-seed, duplicate-hand guard. Finds hands down to ~40 px that the full-frame palm detector misses below ~60–90 px | `handRoi.ts`, `tracker.ts` |
| C.9 | `degraded` when visibility < 0.5 or on CPU; venue guide | `engine.ts`, `DEMO_SETUP.md` |

## For Adam (A): wiring it in

```ts
import { createMotionController } from '@ithaca/motion';          // add "@ithaca/motion": "workspace:*" to apps/web
const input = createMotionController();                            // models served from /models (apps/web/public)
// optional extras: input.getPendingGesture(), input.calibrate(), input.onCalibrationStep(cb), input.getDebugVideo()

import { MotionLab } from '@ithaca/motion/lab';                     // dev route: <MotionLab />
import { createReplayController, replayProfile } from '@ithaca/motion';
// VITE_INPUT=replay:  createReplayController(json, { profile: replayProfile(json) })
```

- **Calibrate every player before playing.** Uncalibrated, some hands never read as "open" (the open-hand curl differs between people), so `release` won't fire. Call `input.calibrate()` from the pre-match screen and the pause menu. `onCalibrationStep(cb)` gives `{ step, index, total, message, hint, progress, passed, failedStep, failedReason }` for your UI.
- `getState()` returns the **same object every call**, to avoid per-frame allocations. Read it each frame; don't keep a reference to it across frames.
- **Expect extra events and ignore the ones that don't apply:**
  - The bow fires `grab`/`release` for the right hand too.
  - The phone gesture can fire `grab`.
  - During a bow draw or a block, `drink` and `swing` can occasionally fire (both showed up in the recordings).
  - Gate them on game state: no `drink` unless a potion is held, no `release` throw unless something is held.
- **`release.vel` is fast but not precise in direction** (35–56° off in the recording). Use the speed for the throw and add aim assist toward the nearest suitor in front of the player.
- Gameplay events are muted during calibration. Calibration starts by sending `release` for any gripping hand.
- No changes to `packages/shared`. The extras live on `MotionController`, which extends `InputController`.

## Still to do by hand

- [ ] Run the gesture test on the **M-series Mac with the game running** and note the fps (criterion: ≥ 30).
- [ ] Run the gesture test with a **second teammate**.
- [ ] Record **60 s of free play** (label `freeplay`) and count unintended grab/release events (< 5 %).
- [ ] **Offline:** Wi-Fi off, reload the Lab, Start camera.

## Deviations and judgment calls

- **3D view:** the Lab draws a 2D front + top view of game space instead of the small R3F scene.
- **Velocity:** derived from the *unfiltered* mapped position, then One-Euro-filtered. Deriving it from the heavily smoothed position adds ~150 ms of lag.
- **Release velocity** uses the peak over 300 ms rather than the spec's last 80 ms, because the open hand is detected after the arm stops. A plain drop (hand still, then open) is still slow, and a test guards that.
- **Bow:** opens below 30 % draw are ignored as tracking noise. Once fully extended, the left arm stays nock-ready for 1.5 s while roughly held out (elbow > 125°).
- **One-Euro β = 0.02** is the spec value; in meters it barely reacts to speed. Raise `posBeta` if hands feel laggy.
- **Calibration step 3:** the arm goes **out to the side** (pointing it at the camera foreshortens it).
- **`CalibrationResult.neutral`** holds the image-space shoulder baseline that lean and crouch are measured from.
- **Bow** assumes a right-handed archer, as in the spec.
- **Not done (stretch):** Web Worker / OffscreenCanvas detection.

## Housekeeping

- `pnpm-lock.yaml` (repo root) was updated for this package's dependencies but **is not committed**, because it's outside Part C's paths. Commit it with the merge, or run `pnpm install` after merging.
- `@mediapipe/tasks-vision` is pinned to `1.2.0`.
- The 5 recordings in `fixtures/` total about 5 MB.
