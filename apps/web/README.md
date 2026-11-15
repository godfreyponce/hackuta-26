# apps/web — Part A: the game & UI

Vite + React 18 + three.js (R3F canvas, imperative engine) + Rapier (direct, `@dimforge/rapier3d-compat`) + zustand.

```bash
pnpm install
pnpm dev:web                       # http://localhost:5173
# fully standalone, no backend, keyboard & mouse:
open "http://localhost:5173/?mock=1&input=keyboard_mouse"
```

| URL flag | Effect |
|---|---|
| `?mock=1` / `VITE_MOCK_SERVER=1` | Mock hub + mock REST (call → dialing → ringing → connected; Q → forge → weapon). Also used **automatically** if `/api/health` is unreachable. `?mock=0` forces live. |
| `?input=keyboard_mouse \| motion \| replay` | Input controller (`VITE_INPUT` default). Motion falls back to keyboard with a visible reason if `packages/motion` isn't there yet. |
| `?shadows=0` | Disable the hearth's shadow map (perf). |
| `?dev=friendview` | The friend-view stream in a phone-sized FaceTime mock (acceptance test A.11). |
| `?dev=motionlab` | Mounts Part C's `MotionLab` export if present. |

## Integration points (for B, C, D)

- **B — friend-view:** `getFriendViewStream(): MediaStream` from `src/game/friendView.ts` (640×360 @ 15 fps). Overlays keep the four corners clear for FaceTime's self-view tile and controls.
- **B — call module:** we glob-import `src/call/index.ts` and call `createCallMedia()` (spec B.8). Then `connect()`, `publishFriendView()`, `publishMic()`, `onFriendCam()`, plus `startAudio?()` on the connect gesture if you expose it. Until the file exists, calls are UI-only.
- **C — motion:** we glob-import `packages/motion/src/index.ts` and use `createMotionController(opts)`, `createReplayController(json)` and `MotionLab`. These optional extras are feature-detected:
  - `getPendingGesture()` drives the radial "Calling…" ring.
  - `onCalibrationStep(cb)` drives the calibration step checks (`{ index, done }`).
  - `drawOverlay(ctx, w, h)` draws the skeleton over the webcam.
  - `getDebugVideo()` provides the webcam preview.
- **D — hub/REST:** WS `/ws?role=web&sessionId=…` (reconnect with backoff; outbound queue so `game.event`s survive blips; zod-validated inbound). All REST calls have timeouts. `POST /api/matches` also sends additive `weaponKills: Record<weaponId, number>` and `playerName`.
- **D — prefabs:** `public/prefabs/{spear,sword,blunt,throwable,shield,bomb,potion}.glb` and `public/dev/sample-weapon.glb`. Regenerate with `pnpm --filter @ithaca/web prefabs`.

## Game events we emit

`match_start, wave_start, wave_cleared, player_hit, health_low (once per crossing <35), player_pinned (≥3 within 2.5 m or <25 HP; 20 s cooldown), enemy_killed (every 3rd or any trickshot), trickshot, item_kill, boss_spawn, weapon_broken, match_end`.

## Robustness behaviors

- Server down → mock hub with a visible chip.
- Call watchdog: 75 s.
- Forge stalls → after 16 s a stock spear flies in anyway.
- GLB load error → prefab, then procedural.
- Wave pacing guard: stragglers charge at 15 s, and the next wave storms in at 30 s, so a demo can't soft-lock.
- Tracking lost → the world slows to 0.2× with an overlay.
- Every screen is keyboard-navigable (arrows/Enter/Esc).
