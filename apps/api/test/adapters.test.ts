import { describe, expect, test } from "bun:test";
import { appleAdapter } from "../src/apple.js";
import { UpstreamError } from "../src/errors.js";
import { googleAdapter } from "../src/google.js";
import type { ScrapeOptions } from "../src/types.js";

// A stub page whose in-page fetch returns a canned { status, body }. The
// adapters call pageFetch(page, ...) → page.evaluate(fn, {url, init}); we ignore
// fn and serve the canned response — so this drives the adapter's real status
// handling, JSON parsing and normalization without a browser.
function stubPage(resp: { status: number; body: string }) {
  return {
    async evaluate() {
      return resp;
    },
  } as never;
}

const opts: ScrapeOptions = { appId: "1", store: "apple", country: "us" };

describe("appleAdapter.fetchBatch", () => {
  test("HTTP 429 → rateLimited", async () => {
    const res = await appleAdapter.fetchBatch(
      stubPage({ status: 429, body: "" }),
      opts,
      0,
    );
    expect(res.kind).toBe("rateLimited");
  });

  test("HTTP 404 → end (past the last page)", async () => {
    const res = await appleAdapter.fetchBatch(
      stubPage({ status: 404, body: "" }),
      opts,
      99,
    );
    expect(res.kind).toBe("end");
  });

  test("a non-200/404 status throws UpstreamError (→ 502)", async () => {
    await expect(
      appleAdapter.fetchBatch(stubPage({ status: 503, body: "down" }), opts, 0),
    ).rejects.toThrow(UpstreamError);
  });

  test("200 with a normal page → reviews + next offset", async () => {
    const body = JSON.stringify({
      data: [{ id: 7, attributes: { rating: 5, date: "2025-01-01T00:00:00Z" } }],
      next: "/r?offset=20",
    });
    const res = await appleAdapter.fetchBatch(stubPage({ status: 200, body }), opts, 0);
    expect(res).toMatchObject({ kind: "page", next: 20 });
    if (res.kind === "page") {
      expect(res.reviews).toHaveLength(1);
    }
  });

  test("200 with an empty data array → end", async () => {
    const body = JSON.stringify({ data: [] });
    const res = await appleAdapter.fetchBatch(stubPage({ status: 200, body }), opts, 0);
    expect(res.kind).toBe("end");
  });

  test("200 with no data array (format drift) throws, not a silent end", async () => {
    const body = JSON.stringify({ unexpected: true });
    await expect(
      appleAdapter.fetchBatch(stubPage({ status: 200, body }), opts, 0),
    ).rejects.toThrow(UpstreamError);
  });

  test("200 with invalid JSON throws UpstreamError", async () => {
    await expect(
      appleAdapter.fetchBatch(stubPage({ status: 200, body: "<html>nope" }), opts, 0),
    ).rejects.toThrow(UpstreamError);
  });
});

const gOpts: ScrapeOptions = { appId: "com.x.y", store: "google", country: "us" };

/** A valid batchexecute envelope wrapping the given review rows + next token. */
function envelope(rows: unknown[], token: string | null): string {
  const payload = JSON.stringify([rows, token ? [null, token] : []]);
  const env = JSON.stringify([
    ["wrb.fr", "UsvDTd", payload, null, null, null, "generic"],
  ]);
  return `)]}'\n\n${env.length}\n${env}\n`;
}

describe("googleAdapter.fetchBatch", () => {
  test("HTTP 429 → rateLimited", async () => {
    const res = await googleAdapter.fetchBatch(
      stubPage({ status: 429, body: "" }),
      gOpts,
      { token: null },
    );
    expect(res.kind).toBe("rateLimited");
  });

  test("a non-200 status throws UpstreamError (→ 502)", async () => {
    await expect(
      googleAdapter.fetchBatch(stubPage({ status: 500, body: "err" }), gOpts, {
        token: null,
      }),
    ).rejects.toThrow(UpstreamError);
  });

  test("200 with rows → reviews + next cursor", async () => {
    const rows = [["id1", ["Alice"], 5, null, "great", [1_700_000_000, 0], 0, null]];
    const res = await googleAdapter.fetchBatch(
      stubPage({ status: 200, body: envelope(rows, "TOKEN2") }),
      gOpts,
      { token: null },
    );
    expect(res).toMatchObject({ kind: "page", next: { token: "TOKEN2" } });
    if (res.kind === "page") {
      expect(res.reviews[0].id).toBe("id1");
    }
  });

  test("200 with a valid-but-empty frame → end", async () => {
    const res = await googleAdapter.fetchBatch(
      stubPage({ status: 200, body: envelope([], null) }),
      gOpts,
      { token: null },
    );
    expect(res.kind).toBe("end");
  });

  test("200 with a junk body throws, not a silent end", async () => {
    await expect(
      googleAdapter.fetchBatch(
        stubPage({ status: 200, body: ")]}'\n\ngarbage" }),
        gOpts,
        {
          token: null,
        },
      ),
    ).rejects.toThrow(UpstreamError);
  });
});
