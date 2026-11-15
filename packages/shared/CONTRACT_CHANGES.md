# Contract changes (additive only)

Log every change to `packages/shared` here: date, one-line reason, who.

- 2026-11-14 — initial contracts from HACKUTA_BUILD_SPEC §4 (D).
- 2026-11-14 — exported `Envelope` type and zod `serverToWebSchema` / `serverToAgentSchema` (for fake clients/tests). (D)
- 2026-11-14 — REST (not shared types): `POST /api/matches` accepts optional `playerName`, `weaponKills`; `/api/forge` honors `x-session-id` header for rate limiting; armory rows also include `fallback`, `quip`. (D)
- 2026-11-15 — merged Part A's hour-0 scaffold into D's (A): D's files kept verbatim; A's `WEAPON_CLASS_LIST` convenience export dropped (unused). A feature-detects optional InputController extras without type changes: `getPendingGesture()`, `onCalibrationStep(cb)` → `{ index, done }`, `drawOverlay(ctx, w, h)`; and the optional CallMedia `startAudio()` (B ships it). (A)
