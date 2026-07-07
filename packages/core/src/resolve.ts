import type { Store } from "./types";

/** A resolved scrape target. */
export interface Target {
  store: Store;
  appId: string;
  /** Storefront country when the input carried one (Apple `/gb/` path, Google `gl=`). */
  country?: string;
}

/**
 * Result of validating raw user input. A discriminated union so the UI can
 * exhaustively render every case — no boolean flags to mis-combine.
 */
export type Validation =
  | { ok: true; target: Target; input: string }
  | { ok: false; reason: ValidationError; message: string; input: string };

export type ValidationError =
  | "empty"
  | "not-a-store-url"
  | "apple-no-id"
  | "google-no-id";

/**
 * Mirrors `apps/api/src/resolve.ts` (the backend's Chain of Responsibility) —
 * kept intentionally in sync via the parity fixtures in `test/resolve.test.ts`.
 * The client side is *more* liberal (Postel's law): it also accepts scheme-less
 * URLs, legacy `itunes.apple.com` hosts, and Android `market://` links, all of
 * which normalize to the same `{ store, appId, country }` the API expects.
 */
export function resolveTarget(raw: string): Target | null {
  const input = raw.trim();
  if (!input) {
    return null;
  }

  // Apple numeric id — "284882215"
  if (/^\d+$/.test(input)) {
    return { store: "apple", appId: input };
  }

  // Apple store URL — apps.apple.com/us/app/instagram/id389801252 (also the
  // legacy itunes.apple.com host, with or without a scheme).
  const appleId = input.match(/\/id(\d+)/);
  if (appleId) {
    const cc = input.match(/(?:apps|itunes)\.apple\.com\/([a-z]{2})(?:[/?#]|$)/i);
    return {
      store: "apple",
      appId: appleId[1],
      ...(cc ? { country: cc[1].toLowerCase() } : {}),
    };
  }

  // Google Play URL — play.google.com/store/apps/details?id=com.x.y — or an
  // Android market:// deep link, which carries the same ?id= param.
  const googleId = input.match(/[?&]id=([\w.]+)/);
  if (googleId) {
    const gl = input.match(/[?&]gl=([A-Za-z]{2})(?:[&#]|$)/);
    return {
      store: "google",
      appId: googleId[1],
      ...(gl ? { country: gl[1].toLowerCase() } : {}),
    };
  }

  // Google package name — "com.spotify.music"
  if (/^[A-Za-z]\w*(?:\.\w+)+$/.test(input)) {
    return { store: "google", appId: input };
  }

  return null;
}

/**
 * Validate raw input into either a `Target` or a *specific, actionable* error
 * message (Nielsen: helpful errors — say what was recognized and what's
 * missing, never just "invalid input").
 */
export function validateInput(raw: string): Validation {
  const input = raw.trim();
  if (!input) {
    return {
      ok: false,
      reason: "empty",
      message: "Paste an App Store or Google Play link to get started.",
      input,
    };
  }

  const target = resolveTarget(input);
  if (target) {
    return { ok: true, target, input };
  }

  // Diagnose *why* it failed so the message points at the fix.
  if (/(?:apps|itunes)\.apple\.com/i.test(input)) {
    return {
      ok: false,
      reason: "apple-no-id",
      message:
        // biome-ignore lint/security/noSecrets: user-facing example id in help copy, not a credential
        "That looks like an App Store link, but it's missing the app id (the “id123456789” part). Open the app's page and copy the full URL.",
      input,
    };
  }
  if (/play\.google\.com|market:\/\//i.test(input)) {
    return {
      ok: false,
      reason: "google-no-id",
      message:
        "That looks like a Google Play link, but it's missing the “?id=com.example.app” part. Open the app's page and copy the full URL.",
      input,
    };
  }
  return {
    ok: false,
    reason: "not-a-store-url",
    message:
      "We couldn't recognize that. Paste an App Store or Google Play app link — or just the app id (e.g. 389801252 or com.spotify.music).",
    input,
  };
}

/** Human label for a store, for chips and copy. */
export function storeLabel(store: Store): string {
  return store === "apple" ? "App Store" : "Google Play";
}

/** Canonical public store-page URL for a resolved target. */
export function storeUrl(target: Target): string {
  return target.store === "apple"
    ? `https://apps.apple.com/${target.country ?? "us"}/app/id${target.appId}`
    : `https://play.google.com/store/apps/details?id=${target.appId}${
        target.country ? `&gl=${target.country}` : ""
      }`;
}
