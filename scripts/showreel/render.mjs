/**
 * Step reel.html frame by frame and encode it.
 *
 *   bun scripts/showreel/render.mjs            → output/wattsteer-reel.mp4
 *   bun scripts/showreel/render.mjs --preview  → a contact sheet, no encode
 *   bun scripts/showreel/render.mjs --at 7.2   → one still, for tuning a beat
 *   bun scripts/showreel/render.mjs --mux      → re-score and re-mux the frames on disk
 *
 * Frames go to disk as JPEG and ffmpeg encodes them afterwards: piping into
 * ffmpeg saves nothing measurable here, and a frames directory is what you
 * want open when a single cut looks wrong.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUndeclaredDependencies: a local tool, not a workspace; playwright is hoisted from apps/web's @playwright/test, and declaring it at the root for a showreel would be a dependency with no product reason.
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "output");
const FPS = 60;
const args = process.argv.slice(2);
const at = args.includes("--at") ? Number(args[args.indexOf("--at") + 1]) : null;
const preview = args.includes("--preview");
const muxOnly = args.includes("--mux");

const boxes = readFileSync(join(OUT, "shots", "boxes.json"), "utf8");
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(`window.BOXES = ${boxes};`);
await page.goto(`file://${join(HERE, "reel.html")}`);
await page.evaluate(() => window.ready);
await page.waitForTimeout(500);

// The cue table the soundtrack is placed from — see score.py.
const DUR = await page.evaluate(() => window.DUR);
writeFileSync(
  join(OUT, "score.json"),
  JSON.stringify(await page.evaluate(() => window.SCORE), null, 1),
);

// Synthesise the score from that table, then mux it under the frames,
// loudness-normalised to -14 LUFS, where the platforms play it back.
const encode = () => {
  execFileSync("uv", ["run", "--quiet", join(HERE, "score.py")], { stdio: "inherit" });
  const audio = join(OUT, "score.wav");
  // Two passes, so loudnorm applies one linear gain: single-pass it compresses
  // dynamically and flattened the impacts into the groove (LRA 4 LU).
  const probe = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      audio,
      "-af",
      "loudnorm=I=-14:TP=-1:LRA=20:print_format=json",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const m = JSON.parse(
    probe.stderr.slice(probe.stderr.lastIndexOf("{"), probe.stderr.lastIndexOf("}") + 1),
  );
  const af = `loudnorm=I=-14:TP=-1:LRA=20:linear=true:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;
  execFileSync("ffmpeg", [
    ...[
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      String(FPS),
      "-i",
      join(OUT, "frames", "%04d.jpg"),
    ],
    ...(existsSync(audio)
      ? ["-i", audio, "-af", af, "-c:a", "aac", "-b:a", "256k", "-ar", "48000"]
      : []),
    ...[
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    ],
    ...["-shortest", join(OUT, "wattsteer-reel.mp4")],
  ]);
  console.log(join(OUT, "wattsteer-reel.mp4"));
};

const still = async (t, path) => {
  await page.evaluate((x) => window.render(x), t);
  await page.screenshot({ path, type: "jpeg", quality: 94 });
};

if (muxOnly) {
  encode();
} else if (at === null) {
  const dir = join(OUT, "frames");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const step = preview ? DUR / 30 : 1 / FPS;
  const n = Math.round(DUR / step);
  for (let i = 0; i < n; i++) {
    await still(i * step, join(dir, `${String(i).padStart(4, "0")}.jpg`));
    if (i % 60 === 0) console.log(`frame ${i}/${n}`);
  }
  if (preview) {
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      join(dir, "%04d.jpg"),
      "-vf",
      "scale=480:-1,tile=5x6:padding=6:color=black",
      "-frames:v",
      "1",
      join(OUT, "contact.jpg"),
    ]);
    console.log(join(OUT, "contact.jpg"));
  } else {
    encode();
  }
} else {
  // render the preceding frame first so the motion blur has a velocity
  await page.evaluate((x) => window.render(x), at - 1 / FPS);
  await still(at, join(OUT, `still-${at}.jpg`));
  console.log(join(OUT, `still-${at}.jpg`));
}
await browser.close();
