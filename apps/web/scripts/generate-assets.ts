/**
 * Deterministic brand-asset generator (design system v3, ported from the
 * reference app): the NoviqMark — lime rounded square with the stroked
 * N-path — on charcoal. Rerun after any brand change:
 * `bun scripts/generate-assets.ts` (from apps/web).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(import.meta.dir, "..");
const LIME = "#D0F244";
const ON_LIME = "#1E2B10";
const CHARCOAL = "#131316";
const CARD = "#1B1B1F";
const FG = "#F7F7F7";
const MUTED = "#A2A2AC";
const GRAPE = "#8D5DF6";
const BORDER = "rgba(255,255,255,0.08)";

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The reference NoviqMark: rounded square + stroked N-path. */
function mark(
  size: number,
  opts: { bg?: string; stroke?: string; radius?: number } = {},
) {
  const { bg = LIME, stroke = ON_LIME } = opts;
  const rx = opts.radius ?? 9;
  return `
  <svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:${size}px;height:${size}px">
    <rect width="32" height="32" rx="${rx}" fill="${bg}"/>
    <path d="M9 23V9l14 14V9" stroke="${stroke}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

interface Asset {
  file: string;
  width: number;
  height: number;
  transparent?: boolean;
  html: string;
}

const ASSETS: Asset[] = [
  {
    file: "assets/images/icon.png",
    width: 1024,
    height: 1024,
    html: mark(1024, { radius: 0 }),
  },
  {
    // Favicon = the bolt mark (extracted from the brand image, lime on
    // transparent) — sourced from the committed asset, not redrawn.
    file: "assets/images/favicon.png",
    width: 64,
    height: 64,
    transparent: true,
    html: `<img src="data:image/png;base64,${readFileSync(join(ROOT, "assets/images/bolt-logo.png")).toString("base64")}" style="width:60px;height:64px;object-fit:contain" />`,
  },
  {
    file: "assets/images/splash-icon.png",
    width: 512,
    height: 512,
    transparent: true,
    html: `<div style="width:512px;height:512px;display:grid;place-items:center">${mark(320)}</div>`,
  },
  {
    file: "assets/images/android-icon-foreground.png",
    width: 1024,
    height: 1024,
    transparent: true,
    // Adaptive safe zone: N-path only, centered (background layer is lime).
    html: `<div style="width:1024px;height:1024px;display:grid;place-items:center">
      <svg width="560" height="560" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 23V9l14 14V9" stroke="${ON_LIME}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg></div>`,
  },
  {
    file: "assets/images/android-icon-background.png",
    width: 1024,
    height: 1024,
    html: `<div style="width:1024px;height:1024px;background:${LIME}"></div>`,
  },
  {
    file: "assets/images/android-icon-monochrome.png",
    width: 1024,
    height: 1024,
    transparent: true,
    html: `<div style="width:1024px;height:1024px;display:grid;place-items:center">
      <svg width="560" height="560" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 23V9l14 14V9" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg></div>`,
  },
  {
    file: "public/og.png",
    width: 1200,
    height: 630,
    html: `
      <div style="width:1200px;height:630px;background:${CHARCOAL};position:relative;overflow:hidden;
                  font-family:${FONT};box-sizing:border-box;padding:72px 80px;
                  display:flex;flex-direction:column;justify-content:space-between">
        <div style="position:absolute;top:-260px;left:50%;transform:translateX(-50%);width:640px;height:520px;border-radius:50%;
                    background:radial-gradient(closest-side, ${LIME}, transparent);opacity:0.18;filter:blur(60px)"></div>
        <div style="position:absolute;bottom:-160px;right:-80px;width:420px;height:420px;border-radius:50%;
                    background:radial-gradient(closest-side, ${GRAPE}, transparent);opacity:0.22;filter:blur(60px)"></div>
        <div style="display:flex;align-items:center;gap:16px;position:relative">
          ${mark(56)}
          <span style="font-size:30px;font-weight:600;color:${FG};letter-spacing:-0.5px">Noviq</span>
        </div>
        <div style="position:relative">
          <div style="font-size:80px;line-height:1.06;font-weight:600;color:${FG};letter-spacing:-2.5px">
            Turn any app's reviews<br/>into <span style="color:${LIME}">clean data.</span>
          </div>
          <div style="margin-top:26px;font-size:28px;line-height:1.4;color:${MUTED};max-width:820px">
            App Store &amp; Google Play review scraping — free, no signup.
          </div>
        </div>
        <div style="display:flex;gap:12px;position:relative">
          ${["Every rating & version", "Developer responses", "CSV & JSON"]
            .map(
              (
                chip,
              ) => `<span style="border:2px solid ${BORDER};border-radius:999px;background:${CARD};
                           padding:12px 26px;font-size:22px;font-weight:500;color:${MUTED}">${chip}</span>`,
            )
            .join("")}
        </div>
      </div>`,
  },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const asset of ASSETS) {
  await page.setViewportSize({ width: asset.width, height: asset.height });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;${asset.transparent ? "background:transparent;" : ""}display:grid;place-items:center">${asset.html}</body></html>`,
  );
  await page.screenshot({
    path: join(ROOT, asset.file),
    omitBackground: asset.transparent ?? false,
    clip: { x: 0, y: 0, width: asset.width, height: asset.height },
  });
  console.log(`✓ ${asset.file} (${asset.width}×${asset.height})`);
}
await browser.close();
