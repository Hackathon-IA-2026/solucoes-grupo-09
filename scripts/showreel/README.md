# Showreel

A 30-second motion piece built from real captures of the live product, with a
soundtrack synthesised from the same cue table.

```
WATTSTEER_BASIC_AUTH=user:password bun scripts/showreel/capture.mjs   # screens + boxes.json
bun scripts/showreel/render.mjs --preview                             # 30-tile contact sheet
bun scripts/showreel/render.mjs --at 12.3                             # one still
bun scripts/showreel/render.mjs                                       # 1800 frames + score → mp4
bun scripts/showreel/render.mjs --mux                                 # re-score, keep the frames
```

The score (`score.py`, run through `uv` for numpy and scipy) is placed from
`output/score.json`, which render.mjs writes from the page's `SCHED`: every
hit, whoosh and chord change is a cue of the picture, and the pulse takes
its tempo from each section's cut length. It is muxed at -14 LUFS with a
two-pass linear loudnorm.

Everything lands in `output/` (gitignored). Timing lives in the `BEATS`
table at the top of the timeline in `reel.html`; the camera aims at the rects
in `boxes.json`, so re-capture after a layout change rather than editing
coordinates. The contact sheet's blur is an artefact of its 1 s step — the
motion blur is measured between consecutive frames — so judge a whip on a
`--at` still or the real render.

`uv run scripts/showreel/publish.py` then re-encodes the render into
`.github/media/` with its poster — the pair the repository README shows.
