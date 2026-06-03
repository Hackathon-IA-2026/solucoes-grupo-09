import { launch, launchPersistentContext } from "cloakbrowser";
import { config } from "./config.js";
import type { ScrapeOptions, StealthPreset, StealthProfile } from "./types.js";

// In containers Chromium runs as root with a tiny /dev/shm, so it needs these.
// Off locally (config.noSandbox=false) to keep the real sandbox + full stealth.
const CONTAINER_ARGS = config.noSandbox
  ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  : [];

// cloakbrowser is built on Playwright and returns Playwright-compatible objects
// but doesn't re-export their types, so we derive them straight from
// cloakbrowser's own API. This keeps our source referencing only cloakbrowser —
// playwright-core stays installed solely as cloakbrowser's engine (peer dep).
type Browser = Awaited<ReturnType<typeof launch>>;
type BrowserContext = Awaited<ReturnType<Browser["newContext"]>>;
export type Page = Awaited<ReturnType<BrowserContext["newPage"]>>;

export const STEALTH: Record<StealthPreset, StealthProfile> = {
  max: {
    humanize: true,
    humanPreset: "careful",
    geoip: true,
    pageDelayMs: [1400, 3200],
    warmupScroll: true,
    maxRetries: 5,
    backoffBaseMs: 10_000,
  },
  balanced: {
    humanize: true,
    humanPreset: "default",
    geoip: false,
    pageDelayMs: [600, 1400],
    warmupScroll: false,
    maxRetries: 4,
    backoffBaseMs: 6_000,
  },
  fast: {
    humanize: false,
    geoip: false,
    pageDelayMs: [150, 400],
    warmupScroll: false,
    maxRetries: 3,
    backoffBaseMs: 3_000,
  },
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Random delay in an inclusive [min, max] window — avoids fixed cadence. */
export function jitter([min, max]: [number, number]): Promise<void> {
  return sleep(min + Math.random() * (max - min));
}

export interface Session {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Launch cloakbrowser and navigate to a store page like a human. Issuing the
 * API calls from this same browser context means they inherit the real
 * fingerprint, cookies, Origin and Referer of an actual visit — far harder to
 * flag than a bare HTTP client. Shared by every store adapter.
 */
export async function openSession(
  landingUrl: string,
  opts: ScrapeOptions,
  profile: StealthProfile,
): Promise<Session> {
  // Maximum stealth: real human emulation, source-level fingerprint patches,
  // and (with a proxy) timezone/locale matched to the exit IP.
  const launchOpts = {
    headless: !opts.headed,
    humanize: profile.humanize,
    stealthArgs: true, // cloakbrowser's default fingerprint flags
    geoip: profile.geoip || Boolean(opts.geoip),
    ...(profile.humanize && profile.humanPreset
      ? { humanPreset: profile.humanPreset }
      : {}),
    ...(CONTAINER_ARGS.length ? { args: CONTAINER_ARGS } : {}),
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  };

  let browser: Browser | null = null;
  let context: BrowserContext;
  if (opts.profileDir) {
    context = await launchPersistentContext({
      userDataDir: opts.profileDir,
      ...launchOpts,
    });
  } else {
    browser = await launch(launchOpts);
    context = await browser.newContext();
  }

  const close = async () => {
    await context.close().catch(() => {});
    await browser?.close().catch(() => {});
  };

  try {
    const page = await context.newPage();
    const resp = await page.goto(landingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (resp && resp.status() >= 400) {
      throw new Error(
        `Store returned HTTP ${resp.status()} for ${landingUrl}. ` +
          `Check the app id and country code.`,
      );
    }

    if (profile.warmupScroll) {
      // Mimic a visitor skimming the page before we start fetching.
      await jitter([500, 1200]);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 600 + Math.random() * 400);
        await jitter([300, 900]);
      }
    } else {
      // Let the SPA settle its session cookies.
      await sleep(800);
    }

    return { context, page, close };
  } catch (err) {
    await close();
    throw err;
  }
}

export interface RawFetch {
  status: number;
  body: string;
}

/**
 * Run a fetch from inside the page so it carries page-origin context (cookies,
 * Origin, Referer). `init` must be JSON-serializable (no functions).
 */
export async function pageFetch(
  page: Page,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<RawFetch> {
  return page.evaluate(
    async ({ url, init }) => {
      const res = await fetch(url, init);
      return { status: res.status, body: await res.text() };
    },
    { url, init: init ?? {} },
  );
}
