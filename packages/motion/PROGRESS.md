# Part C: progress

Branch `part-c-motion`. All of §8 is implemented. 40 unit tests run on synthetic skeletons, and a headless
Chrome smoke test (fake camera) loaded the models on the **GPU delegate** and ran the frame loop. Nothing has been
tested on a real person yet; that's the checklist below.

## Commands (PowerShell, from the repo root)

```powershell
pnpm install                                   # once
pnpm --filter @ithaca/motion fetch-models      # once per machine: models + wasm → apps/web/public/models
pnpm --filter @ithaca/motion lab               # Motion Lab → open http://localhost:5174
pnpm --filter @ithaca/motion test              # unit tests (+ any recordings in fixtures/)
pnpm --filter @ithaca/motion typecheck
```

## Done

| Spec | What | Where |
|---|---|---|
| C.1 | Pose (full/lite) + Hand landmarkers, VIDEO mode, GPU with automatic CPU fallback (also rebuilds on CPU if the GPU dies mid-run), local wasm | `src/tracker.ts` |
| C.1 | Windows-safe model fetch (Node), size checks, skips files it already has, models git-ignored | `scripts/fetch-models.mjs` |
| C.2 | rVFC loop (rAF fallback), hand↔pose-wrist association, un-mirroring, ≤ 50 ms extrapolation in `getState()` | `tracker.ts`, `mapping.ts`, `engine.ts` |
| C.3 | Game-space mapping, 50/50 depth fusion (world z + foreshortening), z clamp, One-Euro, forward/up vectors, lean/crouch/yaw | `src/mapping.ts`, `src/oneEuro.ts` |
| C.4 | Finger-curl grip, 0.65/0.35 hysteresis × 2 frames, hold-through-blips, 80 ms release velocity | `src/grip.ts` |
| C.5 | swing, block, bow (nock/draw/release), drink, call_sign (+ progress ring), request_weapon, tracking_lost/ok | `src/gestures.ts`, `engine.ts` |
| C.5 | Every threshold in `config.ts`, with live sliders in the Lab (saved per browser; "copy JSON" button) | `src/config.ts`, `src/lab/panels.ts` |
| C.6 | 4-step calibration with `onCalibrationStep`, saved to localStorage, ~10 s end-to-end, 30 s timeout | `src/calibration.ts` |
| C.7 | Motion Lab: skeleton overlay, front/top game-space view, state readout, event log, detector chips, sliders, calibrate, record → download, load replay | `src/lab/*`, `lab/` |
| C.7 | `createReplayController(json)` (real time, loops) + `runReplay()` (instant, deterministic) | `src/replay.ts`, `src/recording.ts` |
| C.8 | ms/frame + fps in the Lab header; auto-drop to 960×540 + hands every 2nd frame when fps < 40 | `tracker.ts` |
| C.9 | `degraded` when average visibility < 0.5 or on CPU; demo setup guide | `engine.ts`, `DEMO_SETUP.md` |

## For Adam (A): wiring it in

```ts
import { createMotionController } from '@ithaca/motion';          // add "@ithaca/motion": "workspace:*" to apps/web
const input = createMotionController();                            // models served from /models (apps/web/public)
// optional extras: input.getPendingGesture(), input.calibrate(), input.onCalibrationStep(cb), input.getDebugVideo()

import { MotionLab } from '@ithaca/motion/lab';                     // dev route: <MotionLab />
import { createReplayController } from '@ithaca/motion';            // VITE_INPUT=replay: createReplayController(json)
```

- `getState()` returns the **same object every call**, to avoid per-frame allocations. Read it each frame; don't keep a reference to it across frames.
- `release` fires for the right hand when a bow shot is loosed, and the phone gesture can fire `grab`. Ignore grab/release when the hand holds nothing.
- Gameplay events are muted during calibration. Calibration starts by sending `release` for any gripping hand.
- No changes to `packages/shared`. The extras live on `MotionController`, which extends `InputController`.

## To test by hand in the Motion Lab

Stand 2 m back with light in front of you (see `DEMO_SETUP.md`). Watch the event log and the **Detectors** chips.

- [ ] Header shows **GPU** and **≥ 40 fps** (target 60); ms/frame ≤ 6 on the M-series Mac.
- [ ] **Mirroring:** raise your real right hand. The orange (right) dot in Game space moves on the **+X side**.
- [ ] **Depth:** punch toward the camera. The top view dot moves up (forward); it should feel proportional.
- [ ] **Calibrate:** all 4 steps finish in under 20 s and the badge says `calibrated · arm 0.xx m`. Arm length should be about 0.5–0.7 m.
- [ ] **Grab/release:** open and close each hand 20×. Exactly one grab + release each, no extras. For the < 5 % false-trigger criterion, record 60 s of normal play and count.
- [ ] **Throw:** grip, then throw forward and open. `release.vel` points forward (z < 0) and roughly where you aimed (~20°).
- [ ] **Swing:** a fast slash with a fist gives one `swing` per slash; no swing with an open hand.
- [ ] **Block:** forearms horizontal at face height → `block_start` after about 0.15 s; drop them → `block_end`.
- [ ] **Bow:** left arm straight forward, right fist to the left wrist → `bow_nock`; pull back to the chin (bowDraw rises in the state readout); open the right hand → `bow_release`.
- [ ] **Drink:** a fist at your mouth for 0.6 s → `drink`.
- [ ] **call_sign:** shaka/phone hand by your ear → progress ring fills over 1 s → `call_sign`; no repeat for 5 s.
- [ ] **request_weapon:** both hands overhead for 0.8 s → `request_weapon`; 4 s cooldown.
- [ ] **Tracking lost/ok:** walk out of frame → `tracking_lost` after 0.5 s; come back → `tracking_ok`.
- [ ] **Bad light:** turn the lights down → the `tracking` badge goes `degraded`.
- [ ] **Offline:** turn Wi-Fi off, reload the Lab, Start camera. It still works.
- [ ] Repeat the gesture checks with **a second teammate** (acceptance criterion).
- [ ] **Recordings:** record the 5 reference clips (`throw`, `bow`, `block`, `call`, `drink`) with the label box, put the files in `fixtures/`, and run the tests. See `fixtures/README.md`.

## Deviations and judgment calls

- **3D view:** the Lab draws a 2D front + top view of game space instead of the small R3F scene. It's dependency-free and shows the same thing (hands, forearms, velocity, grip).
- **Velocity:** derived from the *unfiltered* mapped position, then One-Euro-filtered (`velMinCutoff`). Deriving it from the heavily smoothed position adds ~150 ms of lag, which ruins throws.
- **One-Euro β = 0.02** is the spec value, but our units are meters, so it barely reacts to speed. Expect to raise `posBeta` toward ~1–5 while tuning.
- **Calibration step 3:** the arm goes **out to the side**, not forward. Pointing it at the camera foreshortens it, and the forearm image length would be wrong.
- **`CalibrationResult.neutral`** holds the image-space shoulder baseline (x → lean, y → crouch) that lean and crouch are measured from.
- **block "face line"** = within `blockFaceDist` of eye height; "forearms horizontal" = `|forward.y| < 0.6`. Both are tunable.
- **Bow** assumes a right-handed archer (left arm holds the bow), as in the spec.
- **Not done (stretch):** Web Worker / OffscreenCanvas detection. The main thread is fine unless the fps readout says otherwise.

## Housekeeping

- `pnpm-lock.yaml` (repo root) was updated by `pnpm install` for this package's dependencies but **is not committed**, because it's outside Part C's paths. Commit it with the merge, or let whoever merges run `pnpm install`.
- `@mediapipe/tasks-vision` is pinned to `1.2.0` (stable, released 2026-10-27).
