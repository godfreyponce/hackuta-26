# @ithaca/server — Part D (hub, forge, MongoDB)

```bash
corepack pnpm install
cp .env.example .env            # fill in what you have; everything degrades gracefully
corepack pnpm --filter @ithaca/server dev     # http://localhost:8787
```

Runs with **zero keys**: `VISION_PROVIDER` defaults to `mock`, `MODEL3D_PROVIDER` to `prefab`, and without
`MONGODB_URI` sessions/forge/armory work in memory (players, friends, calls, matches, leaderboard, killcams return 503).

| Tool | Command |
|---|---|
| Forge one photo (vision → crop → 3D), writes `out/` | `pnpm --filter @ithaca/server forge:test ~/pan.jpg` |
| Upload page with vision JSON + 3D preview | `http://localhost:8787/dev/forge` (dev only) |
| Fake agent (fakes dialing→connected, scan, narration) | `pnpm --filter @ithaca/server fake-agent` |
| Seed the armory from `scripts/seed/*.jpg` | `pnpm --filter @ithaca/server seed:armory` |
| Delete all stored phone numbers (after the event) | `pnpm --filter @ithaca/server purge:friends` |

Notes for other parts:
- **Session ids are 24-hex strings.** `/ws?role=web&sessionId=<sid>` rejects anything else.
- `/api/forge`: send header `x-session-id: <sid>` so the 3 req/s limit is per session (else per IP).
  Add field `debug=1` to get the raw vision JSON back.
- `POST /api/matches` also accepts optional `playerName` and `weaponKills: { [weaponId]: n }` (feeds Armory kill counts).
- Forge: `FORGE_CLEAN_IMAGE=1` redraws the object without the hand (SD3.5 turbo) before 3D;
  `FORGE_3D_MODEL=spar` uses Stable Point Aware 3D. Measured: clean + spar ≈ 8.4 s and a much better shape than fast-on-raw.
- `weapon.spawn` is guaranteed (prefab fallback) within `SF3D_TIMEOUT_MS` + 5 s of detection.
- Same object name forged in the last 2 h reuses its GLB (instant, no credits).
