# apps/agent: the Quartermaster (Part B)

The Chert FaceTime agent. It joins two LiveKit rooms per call: the game room (`game-<sid>`) as `quartermaster-relay`, and the FaceTime room (`ft-<sid>-<n>`) as `quartermaster`, where it is the only audio publisher.

## Run the mock loop (no Chert minutes)

1. Put `.env.local` in this folder (git-ignored). It needs the LiveKit three, `AGENT_SHARED_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, and `AGENT_MODE=mock-call`.
2. `pnpm install`
3. `pnpm fake-hub` (stand-in for Part D on :8787)
4. `pnpm dev` (the agent; health on :8788)
5. Check it headless: `pnpm e2e`. It prints greeting latency, relayed tracks, and the scan-to-weapon loop.
6. Or by hand: open `http://localhost:8787/` (game stub), click Start, then Call Telemachus. Open the URL the agent logs (`/dev/fake-phone?sid=...`) and click Answer.

## Live mode

Set `AGENT_MODE=live` plus `CHERT_FACETIME_TOKEN`, `CHERT_PROJECT_ID`, `CHERT_LINE_ID`. The fake hub dials `OUTBOUND_TO`. Each test call costs Chert minutes (5 min per call, 50 min per day).

## Files

- `src/call-session.ts`: one call, spec B.4. Every exit path goes through `end()`.
- `src/mixer.ts`: one 48 kHz mono audio source: TTS plus the player mic, ducked.
- `src/tts.ts`: ElevenLabs streaming TTS (`pcm_48000`). Fixed lines are cached in `.cache/tts/`.
- `src/narrator.ts`, `src/lines.ts`: what the Quartermaster says, and when.
- `src/scanner.ts`: caller frames to `POST /api/forge`.
- `src/recovery.ts`: on start, ends a Chert call left over from a crash and deletes stale `ft-` rooms.
- `src/contracts/`: local copy of spec 4.1. Swap to `packages/shared` when Part D pushes it.
- `../web/src/call/callMedia.ts`: the browser side (spec B.8) for Part A.
