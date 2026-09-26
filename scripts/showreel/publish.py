# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10"]
# ///
"""Publish the rendered reel as the README's media.

Re-encodes output/wattsteer-reel.mp4 at CRF 23 for the repository (32 MB → 10 MB,
no visible loss on the screen captures) and cuts a poster from the map beat
with a play button, because GitHub plays a repository video only from its blob
view: the README shows the poster and links to the file.

    uv run scripts/showreel/publish.py
"""

import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
MEDIA = ROOT / ".github" / "media"
FPS = 60


def poster_frame() -> Path:
    """The frame where the map beat is settled on NE, from the cue table.

    **Not a hardcoded number, because that one rotted.** It was `0490.jpg`,
    annotated "t = 8.17 s, NE selected", and it was right until the reel was
    retimed — after which frame 490 landed in the landing-page beat and the
    poster became a marketing page with a play button over its headline. The
    README showed that for as long as nobody looked.

    `render.mjs` writes `output/score.json` from the page's own schedule, so
    the moment is derivable: the map beat tours N, NE, SE/CO, S in
    `sched.map.slot` each from `sched.map.t0`, and NE is the second. Taking it
    late in its own slot lands after the camera has settled.
    """
    score = json.loads((HERE / "output" / "score.json").read_text())
    m = score["sched"]["map"]
    at = m["t0"] + 1.9 * m["slot"]
    frame = HERE / "output" / "frames" / f"{round(at * FPS):04d}.jpg"
    if not frame.is_file():
        raise SystemExit(f"no frame at {at:.2f} s ({frame.name}) — render first")
    return frame


POSTER_FRAME = poster_frame()

MEDIA.mkdir(parents=True, exist_ok=True)
subprocess.run(
    [
        "ffmpeg",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(HERE / "output" / "wattsteer-reel.mp4"),
        "-c:v",
        "libx264",
        "-preset",
        "veryslow",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        str(MEDIA / "wattsteer-reel.mp4"),
    ],
    check=True,
)

im = Image.open(POSTER_FRAME).convert("RGB")
d = ImageDraw.Draw(im, "RGBA")
cx, cy, r = 960, 540, 78
d.ellipse([cx - r - 10, cy - r - 10, cx + r + 10, cy + r + 10], fill=(0, 0, 0, 110))
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(212, 245, 74, 240))
d.polygon(
    [(cx - 24, cy - 38), (cx - 24, cy + 38), (cx + 40, cy)], fill=(19, 19, 22, 255)
)
im.resize((1600, 900), Image.LANCZOS).save(
    MEDIA / "wattsteer-reel.jpg", quality=86, optimize=True
)
print(MEDIA / "wattsteer-reel.mp4", MEDIA / "wattsteer-reel.jpg", sep="\n")
