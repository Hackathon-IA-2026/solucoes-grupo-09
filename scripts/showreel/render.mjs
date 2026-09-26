/**
 * Step reel.html frame by frame and encode it.
 *
 *   bun scripts/showreel/render.mjs            → output/wattsteer-reel.mp4
 *   bun scripts/showreel/render.mjs --preview  → a contact sheet, no encode
 *   bun scripts/showreel/render.mjs --at 7.2   → one still, for tuning a beat
 *
 * Frames go to disk as JPEG and ffmpeg encodes them afterwards: piping into
 * ffmpeg saves nothing measurable here, and a frames directory is what you
 * want open when a single cut looks wrong.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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

const boxes = readFileSync(join(OUT, "shots", "boxes.json"), "utf8");
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(`window.BOXES = ${boxes};`);
await page.goto(`file://${join(HERE, "reel.html")}`);
await page.evaluate(() => window.ready);
await page.waitForTimeout(500);

const still = async (t, path) => {
  await page.evaluate((x) => window.render(x), t);
  await page.screenshot({ path, type: "jpeg", quality: 94 });
};

if (at === null) {
  const dir = join(OUT, "frames");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const DUR = await page.evaluate(() => window.DUR);
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
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      String(FPS),
      "-i",
      join(dir, "%04d.jpg"),
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
      join(OUT, "wattsteer-reel.mp4"),
    ]);
    console.log(join(OUT, "wattsteer-reel.mp4"));
  }
} else {
  // render the preceding frame first so the motion blur has a velocity
  await page.evaluate((x) => window.render(x), at - 1 / FPS);
  await still(at, join(OUT, `still-${at}.jpg`));
  console.log(join(OUT, `still-${at}.jpg`));
}
await browser.close();
