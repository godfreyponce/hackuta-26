# MediaPipe models (Part C)

Populated by `pnpm --filter @ithaca/motion fetch-models` (Node, works on Windows/macOS):

- `pose_landmarker_full.task`, `pose_landmarker_lite.task`, `hand_landmarker.task`
- `wasm/` — copied from `@mediapipe/tasks-vision` so there is no CDN dependency at the venue.

The binaries are git-ignored. Served by Vite at `/models/...`.
