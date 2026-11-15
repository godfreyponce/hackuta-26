# Demo setup: motion controls

How to set up the booth so webcam tracking holds up at the venue.

## The night before (needs internet once)

```powershell
pnpm install
pnpm --filter @ithaca/motion fetch-models
```

This puts the MediaPipe models and WASM in `apps/web/public/models/`. After that, tracking needs **no network**.
Open the Motion Lab once on the demo laptop and check that the header says **GPU** and **≥ 40 fps**.

## Space and camera

- **Distance:** the player stands **1.8–2.5 m** from the laptop. Hips must be in frame (calibration step 1 checks this).
- **Camera height:** chest height if you can. Prop the laptop on a box rather than having it look up from a low table.
- **Framing:** both arms raised overhead must stay in frame. If hands leave the top of the image, step back.
- **One person in frame.** Bystanders walking behind the player can steal the pose. Keep the queue off to the side.

## Light

- Put the light **in front of the player**, behind or beside the laptop. **Never put a window or bright lamp behind the player.**
- If the Lab's `vis` badge stays under 0.5, or the game shows "Find better light", add front light. A phone flashlight bounced off a white wall works.
- Use a **plain background** if you can. Busy posters and other people confuse the hand model.
- Avoid sleeves that match the background, and gloves.

## Per player (about 15 s): always calibrate

Every new player **must** calibrate. Without it, some people's open hand never reads as "open", so throws and drops don't release.

1. Pause menu → **Recalibrate**, or **Calibrate** in the Motion Lab.
2. "Step back until your hips are visible."
3. "Raise your guard: both fists up by your chin, hold still" (2 s). This records the neutral stance for lean and crouch.
4. "String the bow": **left arm straight out to your LEFT side, at shoulder height**. This measures arm length.
5. "Make a fist, then open your hand", 3 times. This sets the grip range.

Each step waits until it actually sees the move, shows a hint if something's off, and ends with **PASSED ✓** or **FAILED ✗** plus the reason. Calibration is saved per browser; recalibrate whenever the player changes.

**Before the judges arrive:** in the Motion Lab press **Test gestures** and run all 12 moves (about 2 minutes). Anything that fails tells you why: light, distance, or the move itself.

## Laptop

- Use Chrome. Close other tabs and apps that use the camera (Zoom, FaceTime, Photo Booth).
- Plug in the charger. Battery saver can throttle the GPU and halve the fps.
- If the header says **CPU** (degraded), reload the page. If it stays on CPU, switch the pose model to **lite**.
- Hands are found in two 256×256 crops placed from the pose wrists (the header shows `hand crops · hit L … R …`; the overlay draws the dashed `L crop` / `R crop` squares). If detection can't keep up with the camera (ms/frame > 0.8 × the frame interval for 3 s), the left and right crops run on alternate frames; the header shows `hands L/R alt`. With `handRoi` at 0 (old full-frame path) the fallback is 960×540 + hands every other frame (`hands ½`).
- The fps badge needs to stay **≥ 30**. The Windows dev laptop only managed 15–17 fps, so demo on the M-series Mac.

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| Hands jitter when still | More light; raise `posMinCutoff` in the Lab sliders |
| Throws feel laggy or weak | Raise `posBeta` / `velMinCutoff`; adjust `releaseLagMs` |
| Grab fires on its own | Recalibrate grip; raise `gripOn` |
| Weapon drops by itself | Lower `gripOff`; more light on the hands |
| `call_sign` won't trigger | Thumb and pinky out, other three fingers curled, hand right by the ear; raise `callEarDist` |
| Throw doesn't register / "Too soft" | Keep the open hand in view after throwing, palm toward the camera; recalibrate |
| Bow: "Arrow dropped" | Keep the left arm straight out while nocking and pulling |
| Bow: full draw but no shot | Turn the right palm toward the camera and open it wide. The hint shows the grip number |
| Left and right hands swapped | Make sure there's only one person in frame; recalibrate |
| "Camera is in use by another app" | Quit Zoom, FaceTime or Photo Booth and reload |
