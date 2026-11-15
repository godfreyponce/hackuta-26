# Contract changes (`packages/shared`)

Additive changes only. Never rename or remove. One line per change: date — who — what — why.

- 2026-11-14 — A (hour-0 scaffold) — Created `protocol.ts`, `weapons.ts`, `input.ts` verbatim from spec §4; `schemas.ts` (zod 4) mirrors them. `{}` payloads are written as a named `Empty` alias (same type) to keep lint quiet.
- 2026-11-14 — A — Added `WEAPON_CLASS_LIST` export to `weapons.ts` (convenience array of class keys for UIs/scripts).
- 2026-11-14 — A — REST (additive, §4.4): `POST /api/matches` body also carries `weaponKills: Record<weaponId, number>` (per-forged-weapon kills, so D can `$inc weapons.kills`) and `playerName`. Both optional; ignore if unused.
- 2026-11-14 — A — Optional InputController extras A feature-detects (not in `input.ts`, no type change): `getPendingGesture()`, `onCalibrationStep(cb)` → `{ index, done }`, `drawOverlay(ctx, w, h)`. Optional CallMedia extra: `startAudio()`.
