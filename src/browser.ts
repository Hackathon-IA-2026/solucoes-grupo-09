import { launch, launchPersistentContext } from "cloakbrowser";
import { config } from "./config.js";
import { BadInputError, UpstreamError } from "./errors.js";
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
    await navigate(page, landingUrl);

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

/**
 * Navigate to the landing page with bounded retries. A 4xx (e.g. 404) means the
 * app/country doesn't exist → `BadInputError` (not retried). A 5xx, navigation
 * timeout or network error is transient → retried, then `UpstreamError`.
 */
async function navigate(page: Page, url: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: config.navTimeoutMs,
      });
      const httpStatus = resp?.status() ?? 0;
      if (httpStatus >= 500) throw new UpstreamError(`store responded ${httpStatus}`);
      if (httpStatus >= 400) {
        throw new BadInputError(
          `App not found (store returned ${httpStatus}) — check the app id and country`,
        );
      }
      return; // loaded ok
    } catch (err) {
      if (err instanceof BadInputError) throw err; // not retryable
      if (attempt >= config.navRetries) {
        throw err instanceof UpstreamError
          ? err
          : new UpstreamError("Failed to load the store page", { cause: err });
      }
      await sleep(500 * (attempt + 1));
    }
  }
}

export interface RawFetch {
  status: number;
  body: string;
}

/**
 * Run a fetch from inside the page so it carries page-origin context (cookies,
 * Origin, Referer). `init` must be JSON-serializable (no functions). The fetch
 * is aborted after `fetchTimeoutMs` so a stalled connection can't hang the
 * request (the engine's `finally` then closes the browser).
 */
export async function pageFetch(
  page: Page,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<RawFetch> {
  return page.evaluate(
    async ({ url, init, timeoutMs }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    { url, init: init ?? {}, timeoutMs: config.fetchTimeoutMs },
  );
}
