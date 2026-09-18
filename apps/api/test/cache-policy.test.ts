import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  decodeScenarioBody,
  decodeScenarioParam,
  encodeScenario,
  type Scenario,
} from "@wattsteer/core/scenario";
import {
  ALL_CACHE_POLICIES,
  applyCachePolicy,
  CACHE_POLICIES,
  type CacheContext,
  etagOf,
  refuseToCache,
} from "../src/api/plugins/cache-policy.js";
import { optimizeKey, replayKey } from "../src/api/plugins/result-cache.js";

/**
 * The caching policy — **a cache key is a provenance, never a duration.**
 *
 * `docs/specs/api-surface.md`'s caching table is one rule and one row per
 * surface, and the rule is the part a test can hold. **The number of rows is
 * not written down here**: it has drifted three times — the table grew the
 * error row, then the two reads that spec recorded as a hole, then the
 * unmetered tier, and the prose in this file and in `cache-policy.ts` each
 * claimed a stale number afterwards. It is derived instead, against the spec's
 * own table, below. Three kinds of claim live here:
 *
 * 1. **The table.** Each row's directive is the spec's, and no row is
 *    `immutable` — the thing that would freeze a response against an ONS
 *    restatement.
 * 2. **The mechanism.** `etagOf` renders a provenance and `applyCachePolicy`
 *    turns a matching one into a 304 that still carries its validator.
 * 3. **The grep-level assertions the ticket asks for**, which are the only
 *    kind that can say something about *every* response rather than about the
 *    twelve someone remembered to test. They read the route sources: nothing
 *    outside `cache-policy.ts` writes a `Cache-Control`, so a grep over that
 *    one file is a grep over the surface; and no validator anywhere is built
 *    from a clock or a TTL, which is the duration-as-a-key this ticket exists
 *    to prevent.
 *
 * The route-level pairings — which row each route names, and which provenance
 * it hands over — are asserted where the route is: `grid-outlook.test.ts`,
 * `forecast-day-ahead.test.ts`, `replay-days.test.ts`, `optimize.test.ts` and
 * the `database-*` suites that have real rows to supersede.
 */

const API_DIR = join(import.meta.dir, "..", "src", "api");

/** `docs/specs/api-surface.md`, from `apps/api/test` — the table this is one half of. */
const SPEC_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "specs",
  "api-surface.md",
);

/**
 * Every module under `src/api`, plugins included, as paths relative to it.
 *
 * **Recursive, and that is the whole point.** A scan of the top level only
 * would leave `src/api/plugins/` unread, and the claim this file makes — that a
 * grep over `cache-policy.ts` is a grep over every response — is only true if
 * nothing *else* can write a `Cache-Control`. A plugin is exactly the kind of
 * thing that would, since `errors.ts` legitimately does touch the header (it
 * clears it), and an assertion that could not see it would be asserting the
 * claim over the half of the tree least likely to be checked by hand.
 */
const ROUTE_FILES: readonly string[] = readdirSync(API_DIR, {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => join(entry.parentPath.slice(API_DIR.length + 1), entry.name))
  .sort();

const sourceOf = (file: string): string => readFileSync(join(API_DIR, file), "utf8");

/** The one module allowed to write a `Cache-Control`, relative to `src/api`. */
const POLICY_MODULE = join("plugins", "cache-policy.ts");

/**
 * A module with its comments stripped.
 *
 * Every claim below is about what a module *does*, and these modules argue
 * their own case in prose that necessarily quotes the thing they refuse to do:
 * `cache-policy.ts` explains at length why nothing carries `immutable`, and a
 * `toContain` over the whole file would read the argument and call it the
 * defect.
 *
 * **Line comments go first, and the order is not a style choice.** Stripping
 * block comments first is what `forecast-day-ahead.test.ts` does, and on these
 * files it deletes the code: `grid.ts` names a wildcard path inside a `//`
 * comment, and the slash-star in it opens a block comment that runs to the
 * next comment terminator a hundred lines later. A source scan that quietly
 * matched nothing would pass every assertion below while proving nothing at
 * all, which is why the call-site census below is its own test.
 */
const codeOf = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

/** A `set`/`request` pair a policy can be applied to, with no framework in it. */
function context(ifNoneMatch?: string): CacheContext & {
  set: { headers: Record<string, string | number | undefined>; status?: number | string };
} {
  const headers = new Headers();
  if (ifNoneMatch !== undefined) {
    headers.set("if-none-match", ifNoneMatch);
  }
  return { set: { headers: {} }, request: { headers } };
}

// --- the table ---------------------------------------------------------------

describe("the caching table is the spec's, row for row", () => {
  it("gives each surface the directive api-surface.md gives it", () => {
    expect(CACHE_POLICIES.meta.directive).toBe("no-store");
    expect(CACHE_POLICIES.forecast.directive).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(CACHE_POLICIES.now.directive).toBe("public, max-age=60");
    expect(CACHE_POLICIES.observedSettled.directive).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(CACHE_POLICIES.observedTail.directive).toBe("public, max-age=300");
    expect(CACHE_POLICIES.diagnosis.directive).toBe("public, max-age=300");
    expect(CACHE_POLICIES.modelCard.directive).toBe("public, max-age=3600");
    expect(CACHE_POLICIES.solveShared.directive).toBe("public, max-age=300");
    expect(CACHE_POLICIES.solveBody.directive).toBe("no-store");
    expect(CACHE_POLICIES.replay.directive).toBe("public, max-age=600");
    expect(CACHE_POLICIES.featuredDays.directive).toBe("public, max-age=3600");
    expect(CACHE_POLICIES.registry.directive).toBe("public, max-age=86400");
    expect(CACHE_POLICIES.canonical.directive).toBe("no-store");
    expect(CACHE_POLICIES.canonicalManifest.directive).toBe("public, max-age=3600");
    expect(CACHE_POLICIES.ingestHealth.directive).toBe("no-store");
    expect(CACHE_POLICIES.serviceBanner.directive).toBe("public, max-age=3600");
    expect(CACHE_POLICIES.liveness.directive).toBe("no-store");
    expect(CACHE_POLICIES.readiness.directive).toBe("no-store");
    expect(CACHE_POLICIES.docs.directive).toBe("public, max-age=300");
  });

  it("closes the unmetered tier on four arguments rather than on one path prefix", () => {
    // `/`, `/health`, `/ready` and `/docs` were the last four routes shipping
    // with no `Cache-Control` — which is not "no caching policy" but a policy
    // an intermediary invents. They are four rows and not one, because a tier
    // is a rate-limiting fact and never a caching argument.
    //
    // The two probes may not be served stale by anyone: `/ready` for
    // `/ingest/health`'s reason exactly (a cached 200 during a database outage
    // is a monitor being told everything is fine), `/health` for a reason of
    // its own (its body is a constant, so the only information it carries is
    // that *this process* answered — which a stored copy cannot carry).
    expect(CACHE_POLICIES.readiness.directive).toBe(
      CACHE_POLICIES.ingestHealth.directive,
    );
    expect(CACHE_POLICIES.liveness.directive).toBe("no-store");

    // The two static-ish routes may, and they did not land on one window
    // either: the banner has a build digest to revalidate against and can
    // therefore afford an hour, `/docs` has none and so its window is the whole
    // guarantee and is short.
    expect(CACHE_POLICIES.serviceBanner.directive).not.toBe(
      CACHE_POLICIES.liveness.directive,
    );
    expect(CACHE_POLICIES.docs.directive).not.toBe(
      CACHE_POLICIES.serviceBanner.directive,
    );
  });

  it("closes the two rows the spec recorded as a hole, and not by copying one directive", () => {
    // `api-surface.md`'s Caching section used to end with "`/v1/canonical/*`
    // and `/ingest/health` ship with no `Cache-Control` and are therefore
    // subject to a shared cache's heuristic freshness". A route with no
    // directive is not a route with no caching policy — it is a route whose
    // policy an intermediary invents. Both now name a row.
    //
    // The part worth asserting is that they were decided separately: the
    // manifest under `/v1/canonical` is a build constant and *is* cacheable,
    // and giving it the reads' `no-store` because it shares their path prefix
    // would be the `/v1/replay/days` mistake a third time.
    expect(CACHE_POLICIES.canonicalManifest.directive).not.toBe(
      CACHE_POLICIES.canonical.directive,
    );
    expect(CACHE_POLICIES.canonical.directive).toBe(CACHE_POLICIES.meta.directive);
    expect(CACHE_POLICIES.ingestHealth.directive).toBe(CACHE_POLICIES.meta.directive);
  });

  it("varies on Accept-Language on the one route that generates prose, and nowhere else", () => {
    // Story: there are no accounts, no cookies and no Authorization header, so
    // every GET is shared-cacheable and a `Vary` anywhere else would fragment a
    // shared cache for nothing.
    const varying = ALL_CACHE_POLICIES.filter((policy) => policy.vary !== undefined);
    expect(varying.map((policy) => policy.name)).toEqual(["diagnosis"]);
    expect(CACHE_POLICIES.diagnosis.vary).toBe("Accept-Language");
  });

  it("gives the replay's date picker the read's row and not the solve's", () => {
    // The trap `rate-limit.ts` had to be told about by hand: `/v1/replay/days`
    // is a calendar read that happens to live under a solve's path. Caching has
    // the same trap, and an hour against the replay's ten minutes is what says
    // the two were decided separately.
    expect(CACHE_POLICIES.featuredDays.directive).not.toBe(
      CACHE_POLICIES.replay.directive,
    );
    expect(CACHE_POLICIES.solveBody.directive).toBe("no-store");
  });
});

describe("the table's size is derived from the spec's, never restated", () => {
  /**
   * The rows of `api-surface.md`'s caching table — the `| … |` lines of the
   * "### Caching" section, minus its header and its separator.
   */
  const specRows = (): readonly string[] => {
    const spec = readFileSync(SPEC_PATH, "utf8");
    const section = spec.slice(spec.indexOf("\n### Caching\n"));
    const body = section.slice(0, section.indexOf("\n### ", 1));
    return body
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => line.slice(1, line.indexOf("|", 1)).trim());
  };

  it("has one row per surface in the spec, plus the error row the spec argues in prose", () => {
    // The count has drifted three times, always the same way: a row was added
    // and a sentence somewhere still said how many there used to be. So no
    // sentence says how many there are — this does, out of the two artefacts
    // that would have disagreed. The error row is the one policy with no line
    // in the table, because it is not a surface: it applies to every route,
    // from `errors.ts`, and the spec argues it in the paragraph below the
    // table instead.
    expect(specRows().length).toBeGreaterThan(0);
    expect(ALL_CACHE_POLICIES.length).toBe(specRows().length + 1);
  });

  it("gives the unmetered tier a line in that table and not a footnote under it", () => {
    // The section used to end with "Still outside the table: `/`, `/health`,
    // `/ready` and `/docs`". A route argued about in prose under a table is a
    // route the table does not govern.
    const surfaces = specRows().join(" ");
    for (const path of ["`/`", "`/health`", "`/ready`", "`/docs`"]) {
      expect(surfaces).toContain(path);
    }
  });
});

// --- the grep-level assertion the ticket asks for ----------------------------

describe("the listing this file greps is the whole of `src/api`", () => {
  it("descended into `plugins/`, where the one policy module lives", () => {
    // The doc comment above calls the recursion "the whole point": a top-level
    // scan leaves `src/api/plugins/` unread, and the claim that a grep over
    // `cache-policy.ts` is a grep over every response is only true if nothing
    // *else* can write the header. Nothing asserted it. Measured: dropping
    // `recursive: true` from the listing left all 29 assertions in this file
    // green, so the property the comment argues for was governed by nobody.
    //
    // Emptiness alone was caught, but only incidentally — by a positive
    // expectation four boxes down. Narrowing is the failure that was silent.
    expect(ROUTE_FILES.length).toBeGreaterThan(5);
    expect(ROUTE_FILES).toContain(POLICY_MODULE);
    expect(ROUTE_FILES.some((file) => file.includes(sep))).toBe(true);
    // And the top level, so a listing that returned only the subtree is caught
    // in the other direction too.
    expect(ROUTE_FILES).toContain("grid.ts");
  });
});

describe("no response on this surface carries `immutable`", () => {
  it("holds of every row of the table", () => {
    for (const policy of ALL_CACHE_POLICIES) {
      expect(policy.directive).not.toContain("immutable");
    }
  });

  it("holds of every `Cache-Control` in the source, because there is one place they are built", () => {
    // The assertion that is worth having: not "the twelve policies are clean"
    // but "there is nothing else to check". A route assembling its own
    // directive would be a directive this suite cannot see, so the boundary is
    // what makes the grep above total.
    const offenders = ROUTE_FILES.filter(
      (file) =>
        file !== POLICY_MODULE &&
        /["'`]cache-control["'`]\s*\]?\s*=/i.test(codeOf(sourceOf(file))),
    );
    expect(offenders).toEqual([]);
  });

  it("finds the word nowhere in a directive the policy module builds", () => {
    // ONS restates a whole year in place, under the same filenames, with no
    // version marker. A response frozen against that would hide precisely what
    // `revision_optimistic` exists to surface, so the word is absent from the
    // code of the one module that could emit it — comments, which argue the
    // case at length, are stripped first.
    const policy = codeOf(sourceOf(POLICY_MODULE));
    expect(policy).not.toContain("immutable");
  });
});

describe("no validator is built from a clock or a duration", () => {
  /** Every `etagOf([...])` argument list in the route sources. */
  const etagArguments = (): { file: string; text: string }[] => {
    const found: { file: string; text: string }[] = [];
    for (const file of ROUTE_FILES) {
      const code = codeOf(sourceOf(file));
      for (const match of code.matchAll(/etagOf\(\s*\[([\s\S]*?)\]/g)) {
        found.push({ file, text: match[1] ?? "" });
      }
      // `applyCachePolicy(ctx, POLICY, [ … ])` — the same provenance, one call
      // deeper. The third argument is the one this is about.
      for (const match of code.matchAll(
        /applyCachePolicy\([\s\S]*?,[\s\S]*?,\s*\[([\s\S]*?)\]\s*\)/g,
      )) {
        found.push({ file, text: match[1] ?? "" });
      }
    }
    return found;
  };

  it("finds a provenance call site in every route that has one", () => {
    // A regex that matched nothing would pass the next two tests vacuously,
    // and one that matched only some of the routes would pass them for the
    // routes it happened to see. Named, so a route that stops building a
    // validator is a failure here rather than a silence.
    const files = new Set(etagArguments().map((entry) => entry.file));
    expect([...files].sort()).toEqual([
      "canonical.ts",
      "curtailment.ts",
      "diagnosis.ts",
      "forecast.ts",
      "grid.ts",
      // `index.ts` is on this list because the service banner is a build
      // constant with a digest, the same shape as the canonical manifest.
      "index.ts",
      "model-card.ts",
      "optimize.ts",
      "plants.ts",
      "replay.ts",
      // The analogue search. Its validator is deliberately **not** an artifact
      // id: the read touches no artifact — it is feature rows and settled
      // labels — so a promotion does not change the answer and must not
      // invalidate it.
      "similar-days.ts",
    ]);
  });

  it("never hands `etagOf` the request's own clock", () => {
    // `published_at` and `ingested_at` are facts about the record and belong in
    // a validator. `Date.now()` is a fact about the request: a validator
    // carrying it changes on every request, which is a cache that can never hit
    // wearing an ETag. `/v1/plants` shipped with exactly that on its
    // empty-registry path and it is fixed; this is what keeps it fixed.
    for (const { file, text } of etagArguments()) {
      expect({ file, text }).toMatchObject({ text: expect.not.stringContaining("now(") });
      expect({ file, text }).toMatchObject({
        text: expect.not.stringContaining("Date.now"),
      });
      expect({ file, text }).toMatchObject({
        text: expect.not.stringContaining("new Date("),
      });
    }
  });

  it("never hands `etagOf` a TTL or a max-age", () => {
    for (const { file, text } of etagArguments()) {
      for (const duration of ["TTL", "MAX_AGE", "_SEC", "max-age", "maxAge"]) {
        expect({ file, text }).toMatchObject({
          text: expect.not.stringContaining(duration),
        });
      }
    }
  });
});

// --- the mechanism -----------------------------------------------------------

describe("etagOf renders a provenance and nothing else", () => {
  it("is weak, colon-joined, and renders instants as ISO to the millisecond", () => {
    // Weak on every route, deliberately: these responses embed a computed
    // `as_of` and a lag, so two responses of one publication are the same
    // *version* of the same fact without being byte-identical, and weak
    // comparison is the only one that says that.
    expect(
      etagOf(["2026-08-28T03:11:07Z", new Date("2026-08-28T22:00:00.000Z"), 3]),
    ).toBe('W/"2026-08-28T03:11:07Z:2026-08-28T22:00:00.000Z:3"');
  });

  it("refuses a validator over nothing", () => {
    // A validator every response matches turns revalidation into a 304 on a
    // body that changed, which is worse than having no validator at all.
    expect(() => etagOf([])).toThrow(/not a validator/);
  });

  it("separates a changed component from an unchanged one", () => {
    const base = ["artifact", new Date("2026-08-28T22:00:00.000Z"), 1] as const;
    expect(etagOf(base)).toBe(etagOf([...base]));
    expect(etagOf(["artifact", new Date("2026-08-28T22:00:00.000Z"), 2])).not.toBe(
      etagOf(base),
    );
  });
});

describe("applyCachePolicy revalidates rather than re-answering", () => {
  it("sets the directive and the validator, and lets the body be built", () => {
    const ctx = context();
    expect(applyCachePolicy(ctx, CACHE_POLICIES.now, [new Date(0)])).toBe(false);
    expect(ctx.set.headers["cache-control"]).toBe("public, max-age=60");
    expect(ctx.set.headers.etag).toBe('W/"1970-01-01T00:00:00.000Z"');
    expect(ctx.set.status).toBeUndefined();
  });

  it("answers 304 when the client already holds this version", () => {
    const etag = etagOf(["artifact", 4]);
    const ctx = context(etag);
    expect(applyCachePolicy(ctx, CACHE_POLICIES.modelCard, ["artifact", 4])).toBe(true);
    expect(ctx.set.status).toBe(304);
    // A 304 with no ETag is a revalidation the client cannot repeat, and one
    // with no Cache-Control resets the freshness window it exists to extend.
    expect(ctx.set.headers.etag).toBe(etag);
    expect(ctx.set.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("does not 304 a client holding a different version", () => {
    const ctx = context(etagOf(["artifact", 3]));
    expect(applyCachePolicy(ctx, CACHE_POLICIES.modelCard, ["artifact", 4])).toBe(false);
    expect(ctx.set.status).toBeUndefined();
  });

  it("carries `Vary` onto the 304 as well as the 200", () => {
    const etag = etagOf(["row", 1, "narration:v1:x"]);
    const ctx = context(etag);
    expect(
      applyCachePolicy(ctx, CACHE_POLICIES.diagnosis, ["row", 1, "narration:v1:x"]),
    ).toBe(true);
    expect(ctx.set.headers.vary).toBe("Accept-Language");
  });

  it("takes the validator back when the work behind it fails", () => {
    // The regression the review caught, as its own assertion. `/v1/optimize`
    // revalidates a pinned scenario *before* it calls the solver, so on an
    // upstream failure the success directive and the success ETag are already
    // written on the same `set` the error envelope answers on. Left there, a
    // shared cache could store a 503 under `public, max-age=300` and then
    // revalidate it to a 304 against the validator the eventual 200 carries —
    // an outage with no expiry.
    const ctx = context();
    applyCachePolicy(ctx, CACHE_POLICIES.solveShared, ["sha256:abc", "origin", "build"]);
    expect(ctx.set.headers.etag).toBeDefined();

    refuseToCache(ctx.set);
    expect(ctx.set.headers["cache-control"]).toBe("no-store");
    expect(ctx.set.headers.etag).toBeUndefined();
    expect(ctx.set.headers.vary).toBeUndefined();
  });

  it("sets no validator where the spec says there is nothing to store", () => {
    // `/v1/meta` and the POST solves. An ETag on a `no-store` response would be
    // a validator for a version nobody may keep.
    const ctx = context('W/"anything"');
    expect(applyCachePolicy(ctx, CACHE_POLICIES.meta)).toBe(false);
    expect(ctx.set.headers["cache-control"]).toBe("no-store");
    expect(ctx.set.headers.etag).toBeUndefined();
  });
});

// --- the Redis keys, which are the same rule one layer down ------------------

describe("the solve keys are provenances", () => {
  const parts = {
    scenarioHash: "sha256:abc",
    forecastOrigin: "2026-08-28T12:00:00Z",
    optimizerBuild: "milp-v3",
  };

  it("changes when the origin changes, so a 12Z run is never served an 00Z plan", () => {
    expect(optimizeKey({ ...parts, forecastOrigin: "2026-08-28T00:00:00Z" })).not.toBe(
      optimizeKey(parts),
    );
  });

  it("changes when the optimizer build changes, which no TTL is short enough to catch", () => {
    expect(optimizeKey({ ...parts, optimizerBuild: "milp-v4" })).not.toBe(
      optimizeKey(parts),
    );
  });

  it("carries no duration at all", () => {
    // The whole rule, at the level of the string: nothing in the key is a
    // number of seconds, an expiry, or an instant the request happened at.
    expect(optimizeKey(parts)).toBe("opt:v1:sha256:abc:2026-08-28T12:00:00Z:milp-v3");
  });
});

describe("the replay key changes on the four things it can see", () => {
  const parts = {
    scenarioHash: "sha256:abc",
    targetDate: "2025-03-14",
    forecastOrigin: "served@2025-03-13T22:00:00Z",
    optimizerBuild: "milp-v3",
  };

  it("separates a record from the reconstruction that shares its instant", () => {
    // `replay.md` seam 6: a `backfilled_holdout` row's `published_at` *equals*
    // `gate_at(target_date, gate_profile)`, so an instant-only key would serve
    // one under the other's name. The kind is the discriminator.
    expect(
      replayKey({ ...parts, forecastOrigin: "backfilled_holdout@2025-03-13T22:00:00Z" }),
    ).not.toBe(replayKey(parts));
  });

  it("separates two days and two builds", () => {
    expect(replayKey({ ...parts, targetDate: "2025-03-15" })).not.toBe(replayKey(parts));
    expect(replayKey({ ...parts, optimizerBuild: "milp-v4" })).not.toBe(replayKey(parts));
  });

  it("is four components, and the fifth one lives on the validator instead", () => {
    // api-surface 24, decided. The caching table used to write this key with a
    // fifth component — `<obs_data_version>` — and the argument for it was
    // right: a replay's observed half is read `AsOf(now)` against a record ONS
    // restates in place, so a restatement ought to evict rather than be waited
    // out. It cannot live *here*, and the reason is structural rather than
    // effort: **a Redis lookup key has to be computable before the call that
    // produces an answer, and the observed vintage is knowable only from the
    // answer.** `replay.ts` does its `get`s holding a scenario, a pin and a
    // build, and it reads no rows; an entry keyed on a vintage the lookup
    // cannot spell is an entry nothing can ever hit.
    //
    // So the version is published — `replay_result` carries
    // `actual.data_version` — and it goes on the **ETag**, which is built from
    // the answer and can therefore carry it. `replay-endpoint.test.ts` asserts
    // that validator, including that it moves when ONS restates the day.
    //
    // What remains is written down rather than implied: a Redis entry stored
    // before a restatement is served after it for as long as the entry lives,
    // which is `REPLAY_TTL_SEC` — 24 hours — and no longer, because this cache
    // has no other eviction. Shortening that TTL is not the fix and is not
    // offered: it would answer a provenance question with a duration.
    //
    // The whole key, spelled out. Not a length and not a `not.toContain` of a
    // field name the builder could never emit — both of those pass under any
    // reordering or substitution, which is to say they cannot fail. This can:
    // the day a fifth component lands here, it fails, and whoever reads the
    // paragraph above is the person who put it there.
    expect(replayKey(parts)).toBe(
      "replay:v1:sha256:abc:2025-03-14:served@2025-03-13T22:00:00Z:milp-v3",
    );
  });
});

describe("a scenario re-encoded differently hits the same key", () => {
  const SCENARIO: Scenario = {
    v: 1,
    subsystem: "NE",
    targetDate: "2026-08-29",
    forecastOrigin: "2026-08-28T12:00:00Z",
    assets: [
      {
        assetType: "battery",
        label: "Battery",
        subsystem: "NE",
        maxPowerMw: 100,
        energyCapacityMwh: 300,
        roundTripEfficiency: 0.92,
        initialStateOfCharge: 0.2,
      },
    ],
    economicAssumptions: { brlPerMwh: 180 },
  };

  /** The same scenario as a client would type it: trailing zeros, keys reordered. */
  const SPELLED = `{
    "economic_assumptions": { "brl_per_mwh": 180.0 },
    "assets": [ { "initial_state_of_charge": 0.20, "asset_type": "battery",
      "round_trip_efficiency": 0.920, "subsystem": "NE", "label": "Battery",
      "energy_capacity_mwh": 300.0, "max_power_mw": 100 } ],
    "forecast_origin": "2026-08-28T12:00:00Z",
    "target_date": "2026-08-29",
    "subsystem": "NE",
    "v": 1
  }`;

  it("keys `0.920` and `0.92` identically, on both the optimize and the replay key", () => {
    // The hash is over the canonical bytes, so two spellings of one scenario
    // share an entry and "a cache that silently never hits" is not a failure
    // mode this surface has. Both keys are checked, because both are built from
    // that hash and a drift in either would be a cache miss nobody can see.
    const link = decodeScenarioParam(encodeScenario(SCENARIO));
    const typed = decodeScenarioBody(SPELLED);
    expect(typed.hash).toBe(link.hash);

    const rest = { forecastOrigin: "2026-08-28T12:00:00Z", optimizerBuild: "milp-v3" };
    expect(optimizeKey({ scenarioHash: typed.hash, ...rest })).toBe(
      optimizeKey({ scenarioHash: link.hash, ...rest }),
    );
    expect(
      replayKey({ scenarioHash: typed.hash, targetDate: "2026-08-29", ...rest }),
    ).toBe(replayKey({ scenarioHash: link.hash, targetDate: "2026-08-29", ...rest }));
  });
});
