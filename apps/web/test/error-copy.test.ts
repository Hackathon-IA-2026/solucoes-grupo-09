import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ERROR_CODES, errorCopyKey } from "@wattsteer/core/errors";
import { en } from "../src/i18n/copy.en";
import { pt } from "../src/i18n/copy.pt";

/**
 * **The client translates codes; it never renders the API's prose.**
 *
 * The error envelope carries two strings and they have opposite audiences.
 * `code` is a stable identifier from a closed enum, and the reader's sentence
 * is `t("error." + code)` — authored here, in both locales. `message` is
 * English developer prose for logs and `/docs`, written by the gateway, never
 * translated and never shown to anyone. A screen that renders it is a screen
 * that shows a Brazilian operator an English sentence about `max_shift_mw`.
 *
 * Two checks, one for each half: every code has a sentence, and no screen
 * reaches for the message.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");

/** The same scope the hardcoded-copy guard walks: where copy is rendered. */
const SCOPE = [
  join("apps", "web", "src", "app"),
  join("apps", "web", "src", "components"),
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".expo"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        walk(full, out);
      }
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const dictionaries = { pt, en } as const;

describe("error copy · one key per code, in both locales", () => {
  for (const locale of ["pt", "en"] as const) {
    it(`${locale} has a sentence for every code in the closed enum`, () => {
      const table = dictionaries[locale].error as Record<string, string>;
      const missing = ERROR_CODES.filter(
        (code) => typeof table[code] !== "string" || table[code].trim() === "",
      );
      expect(missing).toEqual([]);
    });

    it(`${locale} has no sentence for a code that does not exist`, () => {
      // A key left behind by a removed code is a sentence nothing can render,
      // and the next reader cannot tell it is dead.
      const codes = new Set<string>(ERROR_CODES);
      const extra = Object.keys(dictionaries[locale].error).filter(
        (key) => !codes.has(key),
      );
      expect(extra).toEqual([]);
    });
  }

  it("builds the key the client actually looks up", () => {
    expect(errorCopyKey("SUBSYSTEM_UNKNOWN")).toBe("error.SUBSYSTEM_UNKNOWN");
  });

  it("keeps the four 'no forecast' states as four separate sentences", () => {
    // Not one spinner. "Not published yet", "no promoted artifact", "stale"
    // and "the gateway is down" are four different things to tell a reader.
    for (const locale of ["pt", "en"] as const) {
      const states = dictionaries[locale].noForecast as Record<string, string>;
      expect(Object.keys(states).sort()).toEqual(
        ["notYetPublished", "noPromotedArtifact", "stale", "unavailable"].sort(),
      );
      expect(new Set(Object.values(states)).size).toBe(4);
    }
    // The gate instant is data, from /v1/meta — never a hardcoded time.
    expect(en.noForecast.notYetPublished).toContain("{gate}");
    expect(pt.noForecast.notYetPublished).toContain("{gate}");
  });
});

describe("error copy · the developer message is never rendered", () => {
  /**
   * The envelope's `message` is the field a screen must not touch. The two
   * shapes that would do it: reading `.message` off a parsed error body, or
   * off a caught error and putting it on screen.
   */
  const FORBIDDEN = [
    /\berror\s*\.\s*message\b/,
    /\berr\s*\.\s*message\b/,
    /\bapiError\s*\.\s*message\b/,
  ];

  it("no screen reads the message off an API error", () => {
    const offenders: string[] = [];
    for (const root of SCOPE) {
      for (const file of walk(join(ROOT, root))) {
        const source = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^[ \t]*\/\/.*$/gm, "");
        source.split("\n").forEach((line, i) => {
          if (FORBIDDEN.some((pattern) => pattern.test(line))) {
            offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still catches the leak it exists for", () => {
    // A check that stopped matching would pass forever.
    expect(FORBIDDEN.some((p) => p.test("<Text>{error.message}</Text>"))).toBe(true);
    // The sanctioned shape — the code, translated — must not be flagged.
    const translated = `<Text>{t(\`error.$\{error.code}\`)}</Text>`;
    expect(FORBIDDEN.some((p) => p.test(translated))).toBe(false);
  });

  it("no dictionary sentence is the gateway's developer prose", () => {
    // The dev prose is English and names wire fields; the copy names neither.
    const sentences = [
      ...Object.values(en.error),
      ...Object.values(pt.error),
      ...Object.values(en.noForecast),
      ...Object.values(pt.noForecast),
    ];
    const leaked = sentences.filter((s) => /max_shift_mw|HTTP \d{3}|_mwh\b/.test(s));
    expect(leaked).toEqual([]);
  });
});
