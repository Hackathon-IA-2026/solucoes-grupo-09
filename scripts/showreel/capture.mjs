/**
 * Capture the live product for the showreel: the landing hero, the Overview
 * with each subsystem selected, both drawers open, and the Time Machine — plus
 * boxes.json, the measured rect of every element the camera lands on.
 *
 * The rects are measured rather than typed into reel.html because the layout
 * moves; a camera aimed at a hard-coded pixel points at the wrong card the
 * week someone adds a row above it.
 *
 * Every shot is taken scrolled to the top of *every* scroll container, not
 * just the window: selecting a region scrolls the React Native ScrollView,
 * and a 50 px offset on two of the four map frames made the map jump between
 * cuts.
 *
 *   WATTSTEER_BASIC_AUTH=user:password bun scripts/showreel/capture.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUndeclaredDependencies: a local tool, not a workspace; playwright is hoisted from apps/web's @playwright/test, and declaring it at the root for a showreel would be a dependency with no product reason.
import { chromium } from "playwright";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "output", "shots");
const ORIGIN = process.env.WATTSTEER_ORIGIN ?? "https://www.wattsteer.com";
const [username, password] = (process.env.WATTSTEER_BASIC_AUTH ?? "").split(":");
if (!password)
  throw new Error("set WATTSTEER_BASIC_AUTH=user:password (the /app basic auth)");

// The episode the reel replays: NE, 18 Sep 2026, with a battery and a
// shiftable load in the plan. `s` is the app's own encoded scenario.
const TIME_MACHINE =
  "/app/time-machine?subsystem=N&technology=wind&run=00Z&date=2026-09-27&s=eyJhc3NldHMiOlt7ImFzc2V0X3R5cGUiOiJiYXR0ZXJ5IiwiZW5lcmd5X2NhcGFjaXR5X213aCI6MzAwLCJpbml0aWFsX3N0YXRlX29mX2NoYXJnZSI6MC4yLCJsYWJlbCI6IkJhdHRlcnkiLCJtYXhfcG93ZXJfbXciOjEwMCwicm91bmRfdHJpcF9lZmZpY2llbmN5IjowLjkyLCJzdWJzeXN0ZW0iOiJORSJ9LHsiYXNzZXRfdHlwZSI6InNoaWZ0YWJsZV9sb2FkIiwiZGFpbHlfZW5lcmd5X213aCI6MTcwMCwibGFiZWwiOiJGbGV4aWJsZSBsb2FkIiwibWF4X3Bvd2VyX213Ijo3MCwibWF4X3NoaWZ0X213Ijo1MCwic2hpZnRfd2luZG93X2hvdXJzIjozLCJzdWJzeXN0ZW0iOiJORSJ9XSwiZWNvbm9taWNfYXNzdW1wdGlvbnMiOnsiYnJsX3Blcl9td2giOjE4MH0sInN1YnN5c3RlbSI6Ik5FIiwidGFyZ2V0X2RhdGUiOiIyMDI2LTA5LTE4IiwidiI6MX0&episode=2026-09-18-ne";

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
// 3× density: the card beats zoom ~2.5×, and at 2× the text went soft.
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 3,
  httpCredentials: { username, password },
});
const p = await ctx.newPage();
const boxes = {};

const hideDock = () =>
  p.addStyleTag({ content: "[data-testid=voice-dock]{display:none!important}" });
const toTop = () =>
  p.evaluate(() => {
    scrollTo(0, 0);
    for (const e of document.querySelectorAll("*")) if (e.scrollTop) e.scrollTop = 0;
  });
const shot = async (name, settle = 1500) => {
  await p.waitForTimeout(settle);
  await p.screenshot({ path: join(OUT, `${name}.png`) });
  console.log("shot", name);
};
const box = async (name, loc) => {
  boxes[name] = await loc.boundingBox();
};
const openApp = async () => {
  await p.goto(`${ORIGIN}/app`, { waitUntil: "networkidle" });
  await p.waitForTimeout(6000);
  await hideDock();
};
const select = async (code) => {
  await p.locator(`[data-region="${code}"]`).first().click({ force: true });
  await toTop();
  await p.waitForTimeout(2500);
};

await p.goto(`${ORIGIN}/pt/`, { waitUntil: "networkidle" });
await p.waitForTimeout(2500);
await shot("landing");
// the logo lockup for the outro, cropped from the landing's own nav
await p.getByTestId("nav-home-link").screenshot({ path: join(OUT, "logo.png") });

await openApp();
for (const code of ["N", "NE", "SE", "S"]) {
  await select(code);
  await shot(`map-${code}`);
}
await select("NE");
await shot("app-NE");
// The card labels are uppercased by CSS, so match the text case-insensitively.
for (const label of ["VAI CORTAR?", "QUANTO?", "QUANDO?", "POR QUÊ?", "ONDE?"]) {
  const text = p.getByText(new RegExp(`^${label.replace("?", "\\?")}$`, "i")).first();
  const card = await text.evaluateHandle((el) => {
    let n = el;
    while (n && n.getBoundingClientRect().height < 120) n = n.parentElement;
    return n;
  });
  boxes[label] = await card.boundingBox();
}
await box("map", p.getByTestId("region-map"));
await box("tmTab", p.getByText("Máquina do tempo", { exact: true }).first());
// The drawer buttons sit on the fold, so they get their own shot with the
// bar scrolled into view — measured in the state it is shot in, because a
// rect taken from one scroll position and a picture from another put the
// cursor 60 px off the button.
await p.getByTestId("selected-region-explain").scrollIntoViewIfNeeded();
await p.mouse.wheel(0, 140);
await p.waitForTimeout(1200);
await box("explainBtn", p.getByTestId("selected-region-explain"));
await box("mitigateBtn", p.getByTestId("selected-region-mitigate"));
await shot("app-NE-btn", 0);

await p.getByTestId("selected-region-explain").click();
await toTop();
await p.waitForTimeout(6000);
await shot("explain");

await openApp();
await select("NE");
await p.getByTestId("selected-region-mitigate").click();
await p.waitForTimeout(8000);
await shot("mitigate");

await p.goto(`${ORIGIN}${TIME_MACHINE}`, { waitUntil: "networkidle" });
await p.waitForTimeout(8000);
await hideDock();
await shot("tm");
for (const k of [
  "kpi-forecast",
  "kpi-settled",
  "kpi-deviation",
  "kpi-coverage",
  "kpi-fleet",
]) {
  await box(k, p.getByTestId(k));
}

writeFileSync(join(OUT, "boxes.json"), JSON.stringify(boxes, null, 1));
await browser.close();
