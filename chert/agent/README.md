> **Dry-run prototype.** It predates the monorepo. If this folder has `armory.mjs`, it serves port 8787, the same port as `apps/server`. Never run the two together: neither fails to start, and requests to `127.0.0.1:8787` then reach the prototype instead of the server. The agent in use is `apps/agent`. The game sends its messages only to `apps/server` (spec 4.1).

# Chert video agent (camera test)

A voice and video agent for FaceTime Video calls through Chert. The caller holds up
an object. The agent names it out loud and sends back a cropped view of it on its
own video. Node 22.23.2 or later, Node 24 or Node 26 is required.

## What it does on a call

1. It publishes its own camera track at once, before the caller joins: 640 by 360,
   15 frames a second. Until it sees the caller's video, the picture says
   "hold up an object".
2. It watches the caller's video. At most once every 4 seconds it sends the newest
   frame to Gemini (`VISION_MODEL`, default `gemini-2.5-flash`) and asks for the
   held-up object's name and bounding box. The 4-second gap keeps a free-tier key
   under its rate limit.
3. When Gemini finds an object with a bounding box, the agent's video shows that
   object cropped from the caller's view, with its name and the agent's clock in a
   bar at the bottom. With no boxed object in the last 6 seconds, it shows the full
   caller view under "hold up an object".
4. When the object name changes, the voice (Gemini Live, voice Puck) names it in
   one short sentence. The voice listens to the caller's audio and answers too.

## Run it

1. Install it:
   ```sh
   npm install
   ```
2. Create your private env file, then replace each `YOUR_` placeholder in it:
   ```sh
   cp .env.example .env.local && chmod 600 .env.local
   ```
   - `GOOGLE_API_KEY`: a Gemini API key. It runs both the voice and the object finder.
   - `AGENT_NAME`: a name no other team uses.
   - The three LiveKit values come from one LiveKit Cloud project (Settings, API
     keys). For inbound calls in Chert rooms (Shared plan), leave all three empty.
3. Terminal 1, your agent:
   ```sh
   npm start
   ```
4. Terminal 2, in this same folder:
   ```sh
   chert login     # once per computer
   chert dev
   ```
5. When `chert dev` says your agent is in a waiting room, make a **FaceTime Video**
   call to the line it shows. The agent greets you as soon as FaceTime is ready.

A few seconds into each call `chert dev` says what the Mac is taking from your
agent: video and audio, audio only, or what is wrong.

## Where it runs

`chert-rooms.mjs` picks the mode from the three LiveKit values:

- All three set: the agent registers with your own LiveKit project as `AGENT_NAME`.
- Otherwise (any of them empty or still a `YOUR_` placeholder): the agent runs in Chert rooms. It reads how to reach `chert dev` from
  `~/.chert/rooms/<AGENT_NAME>.json` (or `$CHERT_HOME/rooms/`), and joins each call
  with the token `chert dev` hands it.

## Call out instead (outbound.mjs)

`outbound.mjs` places one outbound FaceTime Video call from your line to
`OUTBOUND_TO`. It needs the three LiveKit values (your own project), `AGENT_NAME`,
`CHERT_API_KEY`, `CHERT_PROJECT_ID`, `CHERT_LINE_ID` and `OUTBOUND_TO`.
`CHERT_API_BASE` is optional.

1. Stop `chert dev`, so the line is free.
2. Start the agent in terminal 1 (`npm start`).
3. In terminal 2:
   ```sh
   node --env-file=.env.local outbound.mjs
   ```

It creates a LiveKit room, sends your agent to it, and waits 5 seconds so the
agent's video is up before it dials. Then it asks the Chert API for the call. If
the line is busy, the call waits in the queue. It checks the call every 1.5
seconds, for about 5 minutes at most. It prints one JSON line per step. On
`bridge_ready` it writes the greeting signal into the room metadata itself,
because `chert dev` is not running.

## The greeting

The Mac ends a call that hears nothing from the agent within 10 seconds of
FaceTime being ready (`remote_audio_timeout`). When the Mac reports `bridge_ready`,
`chert dev` writes `"chert_bridge_ready": true` into the room metadata, and the
agent greets once (`greet.mjs`, the `greeting` line in `agent.mjs`). It never
greets just because the caller joined. Without the signal it does not greet,
and the caller speaks first.

## The one rule for video

The Mac that answers FaceTime takes audio from the **one** participant that
publishes an audio track, and shows video **only from that same participant**.

- This agent follows the rule: it publishes its own voice and its own camera track.
- Two participants publishing audio ends the call.
- Video from a participant that does not speak is not shown.

## Logs and saved frames

Each run writes to `runs/<start time>/`:

- `events.jsonl`: one line per event (caller frames and frame rate, each Gemini
  answer with its delay, what the agent was asked to say, errors).
- `frames/`: one JPEG of the caller's video a second, named by receive time.

These frames show the caller. `runs/` is in `.gitignore`: never commit or share it.

## Settings

| Variable | Needed by | Default |
| --- | --- | --- |
| `GOOGLE_API_KEY` | `agent.mjs` | none |
| `AGENT_NAME` | `agent.mjs`, `outbound.mjs` | `video-agent` in `agent.mjs` |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | own LiveKit project, `outbound.mjs` | empty: Chert rooms |
| `VISION_MODEL` | `agent.mjs` | `gemini-2.5-flash` |
| `CHERT_API_KEY`, `CHERT_PROJECT_ID`, `CHERT_LINE_ID`, `OUTBOUND_TO` | `outbound.mjs` | none |
| `CHERT_API_BASE` | `outbound.mjs` | `https://facetime.trychert.com/api/v1` |
| `CHERT_HOME` | Chert rooms mode | `~/.chert` |
| `LOG_LEVEL` | Chert rooms mode | `info` |

`face.mjs` is the animated face from the Chert starter. `agent.mjs` does not use it.

## What it does not check

- The waiting room shows that the agent joined LiveKit. It does not verify the
  Gemini key or the media path. The first call does.
- `npm run check` only checks the syntax of each file.
- Never commit or share `.env.local`. LiveKit and Gemini usage may cost money.
