# Art direction & UX decisions (Part A)

Research synthesis that drove the build. "Inferred" values were translated from reviews and interviews, not sampled from film frames.

## Look: "the orange and the blue"
- **Source mood:** reviews of Nolan's *The Odyssey* (2026) describe:
  - desaturated blues, greys and browns broken by firelight amber;
  - sooty, sepia, torchlit interiors;
  - a print-matched, photochemical grade.
- **Palette** (`src/theme.ts`, CSS vars):
  - soot `#14110E`, timber `#3B2E22`, linen `#D6CCBA`
  - oxidized bronze `#4E3D2A`, worn bronze `#8A6A40`, brass `#C49A4A`
  - verdigris `#3E5B50` is the single cool accent
  - Ithaca red `#7A2622`, Ithaca blue `#233554`
  - fire `#F08A2E` / `#FFC070`
- **Grade** (`gradeEffect.ts`, one pass):
  - saturation 0.72, with fire hues exempt
  - split tone: cool shadows, warm highlights
  - grain 0.026, weighted toward shadows
  - vignette 0.3
  - AgX tone mapping and fire-only bloom (threshold 0.82)
- **Camera:**
  - 55° vertical FOV (50mm on IMAX 15/70); 42° while drawing the bow
  - handheld sway of 0.3° at 0.7 Hz
  - trauma² shake, capped at 2°
- **Letterbox:** 2.20:1, used only for slow-motion killcams. It's baked into the canvas, so it also appears in recorded clips and on FaceTime.

## World: a Mycenaean megaron (archaeology, not the film's sets)
- round painted hearth with a smoke-hole moonlight shaft
- red columns, wider at the top, with black cushion capitals
- fresco band (running spirals, meander), soot-blackened upper walls
- clerestory windows (Melanthius climbs "by the clerestory", *Od.* XXII)

## Costume
- **Odysseus:** dark oxidized bronze gauntlets.
- **Wooers:** gleaming brass belts. In the film, the suitors wear the only bright bronze.
- **Antinous:** deep red and brass.
- **Emblem:** the Homeric boar's-tusk helmet, *not* the film's helmet.

## Type
- **Montserrat** 700–800, all caps, wide tracking, for titles and UI. The film's titling is a bold geometric sans, not a classical serif.
- **Cormorant Garamond** italic for Homer's lines.
- **Cinzel** is reserved for inscriptions.
- Avoid Trajan and Greek-letter substitutions.

## Sound
No orchestra and no samples:
- bronze gongs from inharmonic partials (1, 1.47, 2.09, 2.56, 3.18, 4.1)
- found-metal hits: noise into high-Q bandpasses
- Karplus-Strong bowstring whose pitch rises with draw, and a lyre
- two-reed aulos drone
- 40–55 Hz pulse that scales with wave intensity
- generated hall reverb, about 2.1 s

## UX rules applied
- **Killcams:** ramp to 0.2× in 150 ms, hold 1.6 s, ramp out over 250 ms. At most one per 15 s, but the first of each trickshot type always plays. The UI runs on an unscaled clock.
- **Hitstop:** 45–70 ms on hits and about 150 ms on kills, on meaningful hits only. Only the world freezes; the player's real arm can't be frozen.
- **Damage:** red edge flash per hit, at most 3 flashes/s. The persistent vignette and desaturation start below 35 HP, and the audio low-pass starts below 25 HP.
- **Diegetic health:** an inlay on the left bracer, in addition to the HUD bar.
- **Telegraphs:**
  - melee wind-up 0.75 s, with a glint at 55%
  - archers show a visible draw for 1.15 s, with a glint at least 0.4 s before release
  - fire arrows leave trails so they're readable
- **FaceTime view (640×360):**
  - all four corners stay clear for the self-view tile and iOS controls
  - status strip top-center; banner bottom-center at most 60% wide
  - text: banners ≥ 28 px, subtitles 22 px, title cards ≥ 48 px
- **Subtitles:** speaker label, 70% black box, at most about 42 characters per line and 2 lines. Duration is max(1 s, chars/17) + 0.3 s, capped at 7 s.
- **Keyboard:** 2 px+ focus rings, arrow-key menus that wrap, Esc always goes back.
- **Network states:** every network wait shows a visible state, and every failure gives a one-key action.

## IP boundaries (hold these)
No film logo, title lockup, key art, stills, taglines, score or melody imitation, actor likenesses, distinctive costumes, or implied affiliation. Homer, the public-domain translations, and archaeology are free to use.
