# forge: photo to 3D test scripts (for Part D)

Tested on a real FaceTime call frame of a mug held in a hand:

- Stable Fast 3D straight on the crop: 2.5 to 3.7 s, 10 credits, but a lumpy shape (the hand gets merged in).
- `clean.mjs` first (SD3.5 Large Turbo redraws the object without the hand, 3.5 s, 4 credits), then `sf3d.mjs <image> 1024 spar` (Stable Point Aware 3D, 4.9 s, 4 credits): about 8.4 s and 8 credits per weapon, and the model looks like a mug.

Keys go in `forge/.env.local` (git-ignored): `STABILITY_API_KEY`.
