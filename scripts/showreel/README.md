# Showreel

A 30-second motion piece built from real captures of the live product.

```
WATTSTEER_BASIC_AUTH=user:password bun scripts/showreel/capture.mjs   # screens + boxes.json
bun scripts/showreel/render.mjs --preview                             # 30-tile contact sheet
bun scripts/showreel/render.mjs --at 12.3                             # one still
bun scripts/showreel/render.mjs                                       # 1800 frames → mp4
```

Everything lands in `output/` (gitignored). Timing lives in the `BEATS`
table at the top of the timeline in `reel.html`; the camera aims at the rects
in `boxes.json`, so re-capture after a layout change rather than editing
coordinates. The contact sheet's blur is an artefact of its 1 s step — the
motion blur is measured between consecutive frames — so judge a whip on a
`--at` still or the real render.

`python3 scripts/showreel/publish.py` then re-encodes the render into
`.github/media/` with its poster — the pair the repository README shows.
