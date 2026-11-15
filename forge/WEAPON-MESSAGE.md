# Weapon messages: game and call side

A proposal for Adam. The game and the Chert agent are two programs. These are the only messages between them, so each side can be built alone and joined at the end.

## Connection

- The Chert agent runs a WebSocket server on the demo laptop: `ws://localhost:8787`.
- The game (browser) connects to it on load and reconnects if it drops.
- Every message is one JSON object with a `type` field.
- 3D model files are served by the same process: `http://localhost:8787/weapons/<id>.glb`.

## Game to agent

### `call_me`: the player made the "call me" hand sign

```json
{ "type": "call_me" }
```

The agent starts the outbound FaceTime call. Sending it again during a call does nothing.

## Agent to game

### `call_status`: the call changed state

```json
{ "type": "call_status", "status": "dialing" }
```

`status` is one of `dialing`, `connected`, `ended`, `failed`. The game can show it on screen.

### `weapon`: the friend showed an object (send at once, before any 3D model exists)

```json
{
  "type": "weapon",
  "id": "w3",
  "name": "coffee mug",
  "class": "throw",
  "color": "#e8e4dc",
  "crop": "data:image/jpeg;base64,..."
}
```

- `id`: unique per weapon, used to match the later `weapon_model` message.
- `name`: what Gemini called the object. Show it as the weapon's name.
- `class`: one of `throw`, `bow`, `sword`, `shield`. The game picks its template weapon from this.
- `color`: main color of the object, as hex. The game tints the template with it.
- `crop`: the object's picture, cut from the call video. Optional for the game to use (a decal, an inventory icon).

The game shows the tinted template weapon as soon as this arrives.

### `weapon_model`: the 3D model is ready (a few seconds later)

```json
{ "type": "weapon_model", "id": "w3", "glb": "http://localhost:8787/weapons/w3.glb" }
```

The game loads the GLB (Three.js `GLTFLoader`) and swaps it in for the template with the same `id`. If this message never comes, the template stays. That is fine.

### `weapon_failed`: no 3D model for this one

```json
{ "type": "weapon_failed", "id": "w3" }
```

The game keeps the template. No other action.

## Measured so far

Stable Fast 3D on one mug crop from a real call: 2.5 s (512 texture, 287 KB GLB) and 3.7 s (1024 texture, 360 KB GLB), round trip from the laptop. Script: `forge/sf3d.mjs`.

That raw crop (hand in it) gave a lumpy shape. With a cleanup first, it looks like a mug: `forge/clean.mjs` (SD3.5 Large Turbo image-to-image, strength 0.8, 3.5 s, 4 credits) then Stable Point Aware 3D (4.9 s, 4 credits). About 8.4 s and 8 credits per weapon.
