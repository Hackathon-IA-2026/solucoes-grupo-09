import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES } from "../src/i18n/locale";
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_URL,
  OG_IMAGE_WIDTH,
  siteGraph,
} from "../src/lib/seo";

/**
 * The claims the head makes about things outside itself.
 *
 * `og:image:width` and `og:image:height` are assertions about a file, and a
 * crawler believes them: it lays the card out from the numbers and fetches the
 * bytes afterwards. If `scripts/generate-assets.ts` is ever rerun at another
 * size, nothing in the type system notices and every share on every network
 * renders at the wrong aspect ratio. So the numbers are read back off the PNG.
 *
 * The structured data is checked for the two properties that are easy to get
 * wrong and silent when wrong: every `@id` a node references must resolve
 * inside the same graph (a dangling reference makes Google read the nodes as
 * unrelated entities), and every URL must be absolute (a relative URL in
 * JSON-LD is not resolved against the page).
 */

const WEB = join(import.meta.dir, "..");

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the share card", () => {
  it("is the size the head says it is", () => {
    const actual = pngSize(join(WEB, "public", OG_IMAGE_PATH.replace(/^\//, "")));
    expect(actual).toEqual({ width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT });
  });

  it("is declared as an absolute URL", () => {
    // A crawler fetches `og:image` without a base. A relative path is simply
    // not fetched, and the share renders with no image at all.
    expect(OG_IMAGE_URL.startsWith("https://")).toBe(true);
    expect(OG_IMAGE_URL.endsWith(OG_IMAGE_PATH)).toBe(true);
  });
});

describe("the structured data", () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      const graph = siteGraph(locale, "a description") as {
        "@context": string;
        "@graph": Record<string, unknown>[];
      };

      it("declares the three entities the site is", () => {
        expect(graph["@context"]).toBe("https://schema.org");
        expect(graph["@graph"].map((node) => node["@type"])).toEqual([
          "Organization",
          "WebSite",
          "SoftwareApplication",
        ]);
      });

      it("every `@id` referenced is a node in the same graph", () => {
        const declared = new Set(graph["@graph"].map((node) => node["@id"] as string));
        const referenced: string[] = [];
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) {
            for (const item of value) {
              walk(item);
            }
            return;
          }
          if (typeof value !== "object" || value === null) {
            return;
          }
          const record = value as Record<string, unknown>;
          // A reference is an object whose *only* key is `@id` — a node that
          // declares its own `@id` alongside a `@type` is a definition.
          if (Object.keys(record).length === 1 && typeof record["@id"] === "string") {
            referenced.push(record["@id"]);
            return;
          }
          for (const item of Object.values(record)) {
            walk(item);
          }
        };
        walk(graph["@graph"]);

        expect(referenced.length).toBeGreaterThan(0);
        expect(referenced.filter((id) => !declared.has(id))).toEqual([]);
      });

      it("every URL in it is absolute", () => {
        const urls: string[] = [];
        const walk = (value: unknown): void => {
          if (Array.isArray(value)) {
            for (const item of value) {
              walk(item);
            }
            return;
          }
          if (typeof value === "string") {
            return;
          }
          if (typeof value !== "object" || value === null) {
            return;
          }
          for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (typeof item === "string" && (key === "url" || key === "image")) {
              urls.push(item);
            } else {
              walk(item);
            }
          }
        };
        walk(graph["@graph"]);

        expect(urls.length).toBeGreaterThan(0);
        expect(urls.filter((url) => !url.startsWith("https://"))).toEqual([]);
      });
    });
  }
});
