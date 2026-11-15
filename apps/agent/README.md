# apps/agent: the Quartermaster (Part B)

The Chert FaceTime agent. It joins two LiveKit rooms per call: the game room (`game-<sid>`) as `quartermaster-relay`, and the FaceTime room (`ft-<sid>-<n>`) as `quartermaster`, where it is the only audio publisher.

## Run the mock loop (no Chert minutes)

1. Put `.env.local` in this folder (git-ignored). It needs the LiveKit three, `AGENT_SHARED_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, and `AGENT_MODE=mock-call`.
2. `pnpm install`
3. `pnpm fake-hub` (stand-in for Part D on :8787)
4. `pnpm dev` (the agent; health on :8788)
5. Check it headless: `pnpm e2e`. It runs three scenarios (main loop, call.end during setup, web tab killed) and exits 1 on any failed check. Unit tests: `pnpm test`.
6. Or by hand: open `http://localhost:8787/` (game stub), click Start, then Call Telemachus. Open the URL the agent logs (`/dev/fake-phone?sid=...`) and click Answer.

## With the real server (Part D)

The server reads `apps/server/.env.local` first, then the root `.env.local` (the first file to set a key wins); the agent reads `apps/agent/.env.local`. Both need the same `AGENT_SHARED_SECRET` and LiveKit keys. The fake hub and the real server both listen on 8787, so run only one of them.

## Live path without Chert minutes

`pnpm dev:fake-chert` runs the agent with `AGENT_MODE=live` against a fake Chert inside the fake hub (`/fake-chert`). With `pnpm fake-hub` running, `pnpm e2e` then checks the live path: `when_busy: 'queue'`, a busy line (wait in the queue, then the turn comes; the web ends the wait; Chert drops the entry), video published before create, `bridge_ready` greeting, Chert's failure reason, and `call.end` while POST /calls is in flight. The e2e refuses to run against an agent pointed at the real Chert.

## Live mode

Set `AGENT_MODE=live` plus `CHERT_FACETIME_TOKEN`, `CHERT_PROJECT_ID`, `CHERT_LINE_ID`. The fake hub dials `OUTBOUND_TO`. Each test call costs Chert minutes (5 min per call, 50 min per day). Our line is shared with other teams, so POST /calls sends `when_busy: 'queue'`. A busy line gets a 202 with a queue entry and no call id: the agent keeps the room and its video up, sends `call.status` dialing with reason `line_busy_<position>`, polls `GET /calls/queue/<id>` every 1.5 s, and repeats the create with the same Idempotency-Key when the entry is no longer waiting. It waits at most 2 minutes. An end through `end()` before the call exists sends `DELETE /calls/queue/<id>` (a second Ctrl-C or the hard stop skips it; Chert drops the entry after 2 minutes). The call deadline counts from when Chert allocates the call; the 60 s no-answer clock starts at the first dialing or ringing status or event. Ctrl-C ends the call through Chert; a second Ctrl-C quits at once.

## Files

- `src/call-session.ts`: one call, spec B.4. Every exit path goes through `end()`.
- `src/mixer.ts`: one 48 kHz mono audio source: TTS plus the player mic, ducked.
- `src/tts.ts`: ElevenLabs streaming TTS (`pcm_48000`). Fixed lines are cached in `.cache/tts/`.
- `src/narrator.ts`, `src/lines.ts`: what the Quartermaster says, and when.
- `src/scanner.ts`: caller frames to `POST /api/forge`.
- `src/recovery.ts`: on start, ends a Chert call left over from a crash and deletes stale `ft-` rooms.
- Contracts (spec 4.1) come from `@ithaca/shared`. `src/hub.ts` checks every outgoing message against `agentToServerSchema` and drops one that fails, and cuts a narration longer than 400 characters at a word. The agent's `tsconfig.json` uses `moduleResolution: Bundler` because shared's imports have no file extension; tsx runs the agent, so this changes only the typecheck.
- `../web/src/call/callMedia.ts`: the browser side (spec B.8) for Part A.
