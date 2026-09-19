import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiUrl } from "../src/lib/api-url";

describe("a URL under the API origin", () => {
  it("keeps the origin's own path, with or without a trailing slash", () => {
    for (const base of ["https://host/app/8081", "https://host/app/8081/"]) {
      expect(apiUrl(base, "/v1/forecast/day-ahead").href).toBe(
        "https://host/app/8081/v1/forecast/day-ahead",
      );
    }
    expect(apiUrl("https://api.wattsteer.com", "/v1/meta").href).toBe(
      "https://api.wattsteer.com/v1/meta",
    );
  });

  // Source-level, because the link is a component and the defect was in how
  // its URL was spelled: `new URL("/v1/…", API_URL)` dropped `/app/8081`.
  it("is how the forecast's JSON link builds its URL", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/components/app/forecast-json-link.tsx"),
      "utf8",
    );
    expect(source).toContain('apiUrl(API_URL, "/v1/forecast/day-ahead")');
    expect(source).not.toMatch(/new URL\("\//);
    // Non-vacuous: the pattern finds the shape it forbids.
    expect('new URL("/v1/forecast/day-ahead", API_URL)').toMatch(/new URL\("\//);
  });
});
