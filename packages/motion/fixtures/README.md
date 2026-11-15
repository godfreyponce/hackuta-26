# Reference recordings (spec C.7)

Five human recordings belong here: **throw, bow, block, call, drink** (plus optional `request`, `swing`).

How to make one:

1. `pnpm --filter @ithaca/motion lab` → Start camera → Calibrate (optional).
2. Type the gesture name in the **label** box (e.g. `throw`), press **● Record**, do the move 2–3 times, press **■ Stop**.
3. Move the downloaded `throw-<timestamp>.json` into this folder.

`pnpm --filter @ithaca/motion test` then replays every file here and checks that the gesture in its
file-name prefix fires (`throw` → grab + release, `bow` → bow_nock + bow_release, `block` → block_start + block_end,
`call` → call_sign, `drink` → drink, `request` → request_weapon, `swing` → swing). Replays use the
uncalibrated default profile so results don't depend on whose browser recorded them.

(The repo-wide `.gitignore` ignores folders named `recordings/`, which is why this is `fixtures/`.)
