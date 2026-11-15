# Contract changes (`packages/shared`)

Additive changes only. Never rename or remove. One line per change: date — who — what — why.

- 2026-11-14 — A (hour-0 scaffold) — Created `protocol.ts`, `weapons.ts`, `input.ts` verbatim from spec §4; `schemas.ts` (zod 4) mirrors them. `{}` payloads are written as a named `Empty` alias (same type) to keep lint quiet.
- 2026-11-14 — A — Added `WEAPON_CLASS_LIST` export to `weapons.ts` (convenience array of class keys for UIs/scripts).
