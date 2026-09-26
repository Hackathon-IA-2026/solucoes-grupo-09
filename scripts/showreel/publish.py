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

import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
MEDIA = ROOT / ".github" / "media"
POSTER_FRAME = HERE / "output" / "frames" / "0490.jpg"  # t = 8.17 s, NE selected

MEDIA.mkdir(parents=True, exist_ok=True)
subprocess.run(
    ["ffmpeg", "-loglevel", "error", "-y", "-i", str(HERE / "output" / "wattsteer-reel.mp4"),
     "-c:v", "libx264", "-preset", "veryslow", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "copy",
     "-movflags", "+faststart", str(MEDIA / "wattsteer-reel.mp4")],
    check=True,
)

im = Image.open(POSTER_FRAME).convert("RGB")
d = ImageDraw.Draw(im, "RGBA")
cx, cy, r = 960, 540, 78
d.ellipse([cx - r - 10, cy - r - 10, cx + r + 10, cy + r + 10], fill=(0, 0, 0, 110))
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(212, 245, 74, 240))
d.polygon([(cx - 24, cy - 38), (cx - 24, cy + 38), (cx + 40, cy)], fill=(19, 19, 22, 255))
im.resize((1600, 900), Image.LANCZOS).save(MEDIA / "wattsteer-reel.jpg", quality=86, optimize=True)
print(MEDIA / "wattsteer-reel.mp4", MEDIA / "wattsteer-reel.jpg", sep="\n")
