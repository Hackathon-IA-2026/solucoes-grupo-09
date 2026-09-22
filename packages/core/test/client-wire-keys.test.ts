import { describe, expect, it } from "bun:test";
import { createClient } from "../src/client.js";

/**
 * Every argument this client takes reaches the wire under the gateway's name.
 *
 * The suite next door is about failure, and says so: a read that works is "a
 * fetch and a rename". This file is about the rename — in the one direction
 * that nothing else checks.
 *
 * Responses are renamed by the generated table in `src/wire.ts`, and
 * `one-translator.test.ts` holds that table against the schema. **Requests are
 * not.** Each method spells its own query out by hand, camelCase argument to
 * snake_case key, fourteen methods and about thirty keys of it. A typo there
 * does not fail to compile and does not fail to fetch: the gateway sees a
 * parameter it does not know, ignores it, and answers something plausible for
 * the default. `as_of` sent as `asOf` is a caveat silently dropped;
 * `threshold_mw` sent as `thresholdMw` is an episode list cut at the wrong
 * threshold, with the stamped parameters on the answer saying so in a footnote
 * nobody reads twice.
 *
 * So two properties. The first is the table: each method, its path, and the
 * exact set of keys it sends. The second is the general form of the same bug —
 * **no key this client sends may contain an uppercase letter** — which holds
 * for methods added after this file and is the reason it is worth having
 * beyond the enumeration.
 */

/** A fetch that answers an empty object and records the URL it was asked for. */
function recorder() {
  const urls: string[] = [];
  const doFetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { urls, doFetch };
}

const BASE = "https://api.example.com";

/**
 * Every value is distinct, so a mapping that crosses two keys over is caught.
 * `from`/`to` in particular are adjacent, same-typed and easy to swap.
 */
const CALLS: ReadonlyArray<{
  readonly name: string;
  readonly path: string;
  readonly keys: readonly string[];
  readonly invoke: (client: ReturnType<typeof createClient>) => Promise<unknown>;
}> = [
  { name: "meta", path: "/v1/meta", keys: [], invoke: (c) => c.meta() },
  { name: "gridNow", path: "/v1/grid/now", keys: [], invoke: (c) => c.gridNow() },
  {
    name: "similarDays",
    path: "/v1/similar-days",
    keys: ["k", "lane", "subsystem", "target_date"],
    invoke: (c) =>
      c.similarDays({
        subsystem: "NE",
        lane: "dessem_free_v1__gate_late__thr5",
        targetDate: "2026-09-19",
        k: 3,
      }),
  },
  {
    name: "gridContext",
    path: "/v1/grid/context",
    keys: ["date", "subsystem"],
    invoke: (c) => c.gridContext({ subsystem: "NE", date: "2026-09-17" }),
  },
  {
    name: "gridOutlook",
    path: "/v1/grid/outlook",
    keys: ["gate_profile", "target_date"],
    invoke: (c) => c.gridOutlook({ targetDate: "2026-09-17", gateProfile: "gate_late" }),
  },
  {
    name: "forecastDayAhead",
    path: "/v1/forecast/day-ahead",
    keys: ["gate_profile", "subsystem", "target_date"],
    invoke: (c) =>
      c.forecastDayAhead({
        subsystem: "NE",
        targetDate: "2026-09-17",
        gateProfile: "gate_late",
      }),
  },
  {
    name: "diagnosisDayAhead",
    path: "/v1/diagnosis/day-ahead",
    keys: ["date", "gate_profile", "locale", "subsystem"],
    invoke: (c) =>
      c.diagnosisDayAhead({
        subsystem: "NE",
        date: "2026-09-17",
        gateProfile: "gate_late",
        locale: "pt-BR",
      }),
  },
  {
    name: "curtailmentHours",
    path: "/v1/curtailment/hours",
    keys: ["as_of", "cursor", "from", "subsystem", "technology", "to"],
    invoke: (c) =>
      c.curtailmentHours({
        subsystem: "NE",
        from: "2026-09-01",
        to: "2026-09-15",
        technology: "wind",
        asOf: "2026-09-16T00:00:00Z",
        cursor: "abc",
      }),
  },
  {
    name: "gridDay",
    path: "/v1/grid/day",
    keys: ["as_of", "date"],
    invoke: (c) => c.gridDay({ date: "2026-09-22", asOf: "2026-09-23T00:00:00Z" }),
  },
  {
    name: "curtailmentEpisodes",
    path: "/v1/curtailment/episodes",
    keys: [
      "as_of",
      "from",
      "max_gap_hours",
      "subsystem",
      "technology",
      "threshold_mw",
      "to",
    ],
    invoke: (c) =>
      c.curtailmentEpisodes({
        subsystem: "NE",
        from: "2026-09-01",
        to: "2026-09-15",
        technology: "solar",
        thresholdMw: 42,
        maxGapHours: 3,
        asOf: "2026-09-16T00:00:00Z",
      }),
  },
  {
    /*
      The same route with no subsystem — the whole-grid answer, which is the
      case the parameter was made optional for. The key must be **absent** from
      the query string rather than sent as `subsystem=undefined`, which is a
      subsystem outside the enum and a 422.
    */
    name: "curtailmentEpisodes",
    path: "/v1/curtailment/episodes",
    keys: ["from", "max_gap_hours", "to"],
    invoke: (c) =>
      c.curtailmentEpisodes({
        from: "2026-09-01",
        to: "2026-09-15",
        maxGapHours: 3,
      }),
  },
  {
    name: "observedReasons",
    path: "/v1/curtailment/reasons",
    keys: ["as_of", "date", "limit", "subsystem"],
    invoke: (c) =>
      c.observedReasons({
        subsystem: "NE",
        date: "2026-09-15",
        limit: 7,
        asOf: "2026-09-16T00:00:00Z",
      }),
  },
  {
    name: "modelCard",
    path: "/v1/model/card",
    keys: ["lane"],
    invoke: (c) => c.modelCard({ lane: "dessem_free_v1__gate_late__thr5" }),
  },
];

async function urlFor(entry: (typeof CALLS)[number]): Promise<URL> {
  const { urls, doFetch } = recorder();
  const client = createClient({ baseUrl: BASE, fetch: doFetch });
  await entry.invoke(client).catch(() => undefined);
  const [first] = urls;
  if (first === undefined) {
    throw new Error(`${entry.name} issued no request`);
  }
  return new URL(first);
}

describe("each read asks for the path and the keys the gateway publishes", () => {
  for (const entry of CALLS) {
    it(`${entry.name} → ${entry.path}`, async () => {
      const url = await urlFor(entry);
      expect(url.pathname).toBe(entry.path);
      expect([...url.searchParams.keys()].sort()).toEqual([...entry.keys].sort());
    });
  }

  it("every supplied value arrives, and none is the string `undefined`", async () => {
    // The sibling suite holds that an *omitted* optional is not sent. This is
    // the other half: a supplied one must not be dropped on the way.
    for (const entry of CALLS) {
      const url = await urlFor(entry);
      for (const [key, value] of url.searchParams) {
        expect(value).not.toBe("undefined");
        expect(value.length).toBeGreaterThan(0);
        expect(key).not.toBe("");
      }
    }
  });
});

describe("the general form of the bug, for methods added after this file", () => {
  it("no query key this client sends contains an uppercase letter", async () => {
    // The gateway's parameters are snake_case without exception. A camelCase
    // key is therefore always a typo, and always a silent one: the gateway
    // ignores what it does not know and answers for the default.
    const offenders: string[] = [];
    for (const entry of CALLS) {
      const url = await urlFor(entry);
      for (const key of url.searchParams.keys()) {
        if (/[A-Z]/.test(key)) {
          offenders.push(`${entry.name}: ${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the table covers every GET method the client exposes", () => {
    /*
      Non-vacuity for the file as a whole. Without this, a method added later
      is simply absent from `CALLS` and every assertion above still passes —
      the enumeration would quietly stop being an enumeration.

      POST bodies are excluded: they leave in the wire's casing as whole
      documents and `client.test.ts` already holds that, byte for byte.
    */
    const posts = new Set([
      "optimize",
      "replay",
      "replayObservedOnly",
      "voiceSession",
      // A write, and the one call here that is not a read at all: the body
      // leaves in the wire's casing and the answer is about the submission.
      "fileFeedback",
    ]);
    const client = createClient({ baseUrl: BASE, fetch: recorder().doFetch });
    const exposed = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
      .filter((name) => name !== "constructor" && !name.startsWith("request"))
      .filter((name) => !posts.has(name));
    /*
      Unique names, because the table is keyed by *call*, not by method: one
      method can appear twice where two call shapes send different keys —
      `curtailmentEpisodes` with a subsystem and without, which is the whole
      point of that parameter being optional. What this check is about is that
      no exposed GET is missing from the table, and that no row names a method
      that no longer exists.
    */
    expect(exposed.sort()).toEqual([...new Set(CALLS.map((entry) => entry.name))].sort());
  });
});
