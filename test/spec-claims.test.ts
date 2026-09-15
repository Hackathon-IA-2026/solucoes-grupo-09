import { describe, expect, it } from "bun:test";
import {
  type Claim,
  claimsMatching,
  drifted,
  driverCodes,
  errorStatuses,
  featureDictionary,
  featureRowAttributes,
  flatSpec,
  gateLocalHours,
  live,
  numberOf,
  pagedResponseSchemas,
  pathReferences,
  scenarioRefusalCodes,
  servedRoutes,
  specFiles,
  specTexts,
  treeFiles,
} from "./spec-claims.js";

/**
 * The nine specs' mechanical claims, checked against the tree they describe.
 *
 * api-surface 27's evidence was eleven claims in `docs/specs/*.md` that were
 * **false when found**, each discovered by accident by somebody working on
 * something else: a count that had drifted, a file that had been deleted, a
 * route described as unserved four months after it was served. None of them
 * broke a test. Several misled an *agent* into building the wrong thing.
 *
 * Every number below is derived — from the migrations, the route
 * registrations, the published error enum, the cross-language fixture
 * directory, the generated types — and then bound to the spec's own words by a
 * regex over the prose. **Nothing here is a list a human has to keep in step**,
 * which is the failure this suite exists to end rather than to repeat: a
 * hardcoded roster of claims would be one more artefact to forget, and the
 * ticket says plainly that such a guard is worse than none.
 *
 * The structure is three parts, and the first is load-bearing:
 *
 * 1. **The inputs are not empty.** Every derivation is asserted non-trivial
 *    before anything is compared against it, and every binder is asserted to
 *    have matched. This repository has shipped four guards that read green
 *    while governing nothing — an enumeration that listed only what it already
 *    knew, a control at an address nothing imported, a comment stripper that
 *    ate its own input, a coverage figure over zero rows — and every one of
 *    them passed its own suite.
 * 2. **The claims agree with the tree.**
 * 3. **The guard can fail.** `describe("the guard is not vacuous")` drifts each
 *    binder's spec text by one and asserts it goes red, and empties each
 *    derivation's input and asserts that goes red too.
 *
 * ### What this suite deliberately does not check
 *
 * Listed rather than hidden, because a sweep that pretends everything is
 * checkable is worse than one that scopes itself:
 *
 *  - **Prose about intent, judgement and the future.** "A refusal is legible;
 *    a repair is a plausible answer to a question nobody asked" is an argument,
 *    not a fact about the tree. Most of every spec is this, and rightly.
 *  - **Counts whose value exists only inside a live Postgres.** The nine rows
 *    of `canonical_read_go_live`, the ~84,500 rows of set A, the 11,904 rows
 *    over 62 target dates: these come from `information_schema` and from real
 *    data, and the gated `database-features.test.ts` is where they belong.
 *  - **Bare file names.** A reference to `grid.ts` names one of three files
 *    called `grid.ts`, so "a file of that name exists" is true of nearly any
 *    name and proves nothing. Only path-form references are checked, and the
 *    doc comment on `pathReferences` says so.
 *  - **Measured physical quantities.** RMSE 4.38 vs 4.76 km/h, the 0.03%
 *    DESSEM agreement, the S3 `Last-Modified` timestamps: these trace to
 *    `docs/research/`, which is the evidence base and is not re-derivable here.
 */

const SPECS = specTexts();
const attributes = featureRowAttributes();
const dictionary = featureDictionary();
const gate = gateLocalHours();
const statuses = errorStatuses();
const routes = servedRoutes();
const refusals = scenarioRefusalCodes();
const drivers = driverCodes();
const references = pathReferences();
const tree = treeFiles();

/** The endpoint-list rows' paths, normalised to the shape a route registers. */
function endpointListPaths(): string[] {
  const spec = SPECS.get("api-surface.md") as string;
  const section = spec.slice(spec.indexOf("\n### The endpoint list\n"));
  const body = section.slice(0, section.indexOf("\n**Three things"));
  const paths = new Set<string>();
  for (const row of body.split("\n").filter((one) => /^\| \d+ \|/.test(one))) {
    for (const match of row.matchAll(/(?:GET|POST) (\/[^\s`?·]*)/g)) {
      paths.add((match[1] as string).replace(/<(\w+)>/g, ":$1"));
    }
  }
  return [...paths].sort();
}

/** The `/v1` paths the gateway serves, minus the canonical reads. */
function productPaths(served = routes): string[] {
  return [
    ...new Set(
      served
        .filter(
          (route) =>
            route.path.startsWith("/v1/") && !route.path.startsWith("/v1/canonical"),
        )
        .map((route) => route.path),
    ),
  ].sort();
}

// --- part 1: the inputs are not empty ----------------------------------------

describe("nothing below is asserted over an empty input", () => {
  it("found all nine specs, by discovery", () => {
    // Discovery, not enumeration: a tenth spec is swept the day it lands, and
    // the count is here only so that a `readdirSync` that started returning
    // nothing cannot make every assertion in this file vacuously true.
    expect(specFiles().length).toBe(9);
    expect([...SPECS.values()].every((text) => text.length > 2000)).toBe(true);
  });

  it("walked the working tree, into subdirectories and hidden ones", () => {
    // The file-reference check is a claim about the whole tree, and a walk that
    // stopped at the top level would resolve nothing and report everything.
    expect(tree.length).toBeGreaterThan(500);
    expect(tree).toContain("docs/specs/api-surface.md");
    expect(tree).toContain(".github/workflows/publication-lag-conformance.yml");
    expect(tree.some((file) => file.startsWith("apps/api/src/api/plugins/"))).toBe(true);
  });

  it("replayed `feature_row` from the migrations", () => {
    expect(attributes.length).toBeGreaterThan(100);
    expect(new Set(attributes).size).toBe(attributes.length);
    expect(attributes).toContain("observed_constrained_off_same_hour_exceedance_7d");
  });

  it("parsed the seeded feature dictionary, with its booleans", () => {
    expect(dictionary.length).toBeGreaterThan(100);
    // A parse that read the rows but not the flags would make four of the
    // counts below identically zero and still pass a length check.
    expect(dictionary.filter((entry) => entry.isProxy).length).toBeGreaterThan(0);
    expect(dictionary.filter((entry) => entry.modelInput).length).toBeGreaterThan(0);
    expect(
      dictionary.filter((entry) => !entry.availableAtGateEarly).length,
    ).toBeGreaterThan(0);
  });

  it("read both of `gate_at`'s local hours", () => {
    expect(Number.isInteger(gate.gateEarly)).toBe(true);
    expect(Number.isInteger(gate.gateLate)).toBe(true);
    expect(gate.gateLate).toBeGreaterThan(gate.gateEarly);
  });

  it("read the whole error enum, and the routes, and the fixtures", () => {
    expect(statuses.size).toBeGreaterThan(30);
    expect(routes.length).toBeGreaterThan(20);
    // All three literal forms parsed: a plain path, the canonical base
    // constant, and `canonicalReadPath("<read>")`. A regex that read only the
    // first would silently drop ten routes and still look healthy.
    expect(routes.some((route) => route.path === "/v1/canonical")).toBe(true);
    expect(routes.some((route) => route.path.startsWith("/v1/canonical/"))).toBe(true);
    expect(routes.some((route) => route.method === "POST")).toBe(true);
    expect(refusals.length).toBeGreaterThan(10);
    expect(drivers.length).toBeGreaterThan(4);
  });

  it("found the specs' path-form file references", () => {
    expect(references.length).toBeGreaterThan(100);
    expect(references.some((reference) => reference.spec === "api-surface.md")).toBe(
      true,
    );
    // Both halves of the resolver work: something resolves, and the resolver
    // is not simply answering "true".
    expect(references.some((reference) => reference.resolves)).toBe(true);
    expect(references.filter((reference) => !reference.resolves).length).toBeGreaterThan(
      0,
    );
  });
});

// --- part 2: the claims agree with the tree -----------------------------------

/** Assert a binder matched something, and that every live match is `expected`. */
function bind(label: string, pattern: RegExp, expected: number, atLeast = 1): Claim[] {
  const all = claimsMatching(pattern, SPECS);
  const asserted = live(all);
  expect(asserted.length, `${label}: the binder matched nothing`).toBeGreaterThanOrEqual(
    atLeast,
  );
  expect(
    drifted(asserted, expected).map(
      (claim) => `${claim.spec}:${claim.line} ${claim.quoted}`,
    ),
    `${label}: derived ${expected}`,
  ).toEqual([]);
  return all;
}

describe("counts the specs state are the counts the tree has", () => {
  it("`feature_row` has as many attributes as the specs say", () => {
    // The number that was wrong in five places at once when `0036` added the
    // 112th, and the reason this suite exists.
    bind(
      "feature_row attributes",
      /\*{0,2}(\d+)\*{0,2} attributes\b/g,
      attributes.length,
      3,
    );
  });

  it("the operator-notice interval is the gap between `gate_at`'s two hours", () => {
    // `gate_early` is local hour 9 and `gate_late` is 19, so the interval is
    // ten. `feature-engineering.md` said eleven in five places — including a
    // table row reading "09:00 BRT … eleven hours later … 19:00 BRT" — and
    // `forecaster.md` had said the same until forecaster 18 corrected it. Both
    // specs are bound to the SQL here, so the third place cannot open.
    bind(
      "operator notice",
      /\*{0,2}([\w-]+)\*{0,2} (?:fewer )?hours?\*{0,2}(?: later| less notice| of lost| of operator notice| of notice)/g,
      gate.gateLate - gate.gateEarly,
      5,
    );
  });

  it("the gate clock times in the prose are `gate_at`'s own", () => {
    // The interval check above is satisfied by any two hours ten apart; this
    // pins the two hours themselves, so a `gate_at` moved to 8 and 18 fails
    // rather than passing on the difference.
    const spec = SPECS.get("feature-engineering.md") as string;
    const clock = (hour: number): string => `D−1 ${String(hour).padStart(2, "0")}:00 BRT`;
    expect(spec).toContain(clock(gate.gateEarly));
    expect(spec).toContain(clock(gate.gateLate));
  });

  it("the dictionary's boolean censuses match the prose", () => {
    const count = (predicate: (entry: (typeof dictionary)[number]) => boolean): number =>
      dictionary.filter(predicate).length;

    bind(
      "is_proxy",
      /`is_proxy` is \*{0,2}([\w-]+)\*{0,2} columns/g,
      count((entry) => entry.isProxy),
    );
    bind(
      "augmented set size",
      /augmented set is exactly (\d+) names/g,
      count((entry) => entry.inAugmented && !entry.inFree),
    );

    // The two model-input counts and the attribute total, in one sentence.
    const inputs = [
      ...flatSpec("feature-engineering.md", SPECS).matchAll(
        /counts are now (\d+) and (\d+) over (\d+) attributes/g,
      ),
    ];
    expect(inputs.length, "model-input binder matched nothing").toBe(1);
    const [, free, augmented, total] = inputs[0] as RegExpMatchArray;
    expect([Number(free), Number(augmented), Number(total)]).toEqual([
      count((entry) => entry.modelInput && entry.inFree),
      count((entry) => entry.modelInput && entry.inAugmented),
      dictionary.length,
    ]);

    // The three prefixes that are unavailable at the early gate, and their sum.
    const absences = [
      ...flatSpec("feature-engineering.md", SPECS).matchAll(
        /all ([\w-]+) `programmed_\*`, all ([\w-]+) `proxy_\*` and all (\d+) `dessem_\*` columns/g,
      ),
    ];
    expect(absences.length, "gate-early binder matched nothing").toBe(1);
    const stated = (absences[0] as RegExpMatchArray)
      .slice(1)
      .map((one) => numberOf(one) ?? -1);
    const byPrefix = (prefix: string): number =>
      count((entry) => entry.column.startsWith(prefix));
    expect(stated).toEqual([
      byPrefix("programmed_"),
      byPrefix("proxy_"),
      byPrefix("dessem_"),
    ]);
    expect(stated.reduce((a, b) => a + b, 0)).toBe(
      count((entry) => !entry.availableAtGateEarly),
    );
  });

  it("the eighteen-rule validation table is eighteen refusals", () => {
    // Derived from `packages/core/fixtures/scenario-validation/refusals/`,
    // which both language's suites read, so it is the table *as implemented*
    // rather than as transcribed. `flex-optimizer.md`'s table has nineteen
    // rows; the nineteenth, `FORECAST_UNAVAILABLE`, is a database question and
    // is thrown from elsewhere, which is what "eighteen" has always meant.
    bind("validation codes", /optimizer's ([\w-]+) validation codes/g, refusals.length);
    expect(refusals.every((code) => statuses.has(code))).toBe(true);
  });

  it("the grouped-Shapley players are the `DriverCode` union", () => {
    const players = bind(
      "Shapley players",
      /([\w-]+) players is (\d+) coalitions/g,
      drivers.length,
    );
    const coalitions = /players is (\d+) coalitions/.exec(
      (SPECS.get("diagnosis.md") as string).replace(/\n/g, " "),
    );
    expect(players.length).toBe(1);
    expect(Number(coalitions?.[1])).toBe(2 ** drivers.length);
  });

  it("as many surfaces page as declare a cursor", () => {
    const paged = pagedResponseSchemas();
    expect(paged.length).toBeGreaterThan(0);
    bind("pagination", /pagination is needed on exactly ([\w-]+) route/g, paged.length);
  });
});

describe("the endpoint list is the surface, in both directions", () => {
  const tabled = endpointListPaths();
  const served = productPaths();

  it("lists every `/v1` path the gateway serves", () => {
    // The half that catches a route shipping without a row. Two did:
    // `GET /v1/model/card/raw` and `POST /v1/replay/observed-only` were served,
    // cached and rate-limited while the list said fourteen.
    expect(served.filter((path) => !tabled.includes(path))).toEqual([]);
  });

  it("lists nothing the gateway does not serve", () => {
    // And the half that catches a row outliving its route — the shape the
    // `/v1/backtest` claim had for four months, in the other direction.
    expect(tabled.filter((path) => !served.includes(path))).toEqual([]);
  });

  it("states the count of them in the two places it states it, and both agree", () => {
    // Scoped to the two sentences that make the claim rather than to every
    // "N routes" in the document — three of those are about subsets ("the two
    // routes with a cursor", "three routes shipped with no directive") and a
    // binder that swept them all in would be comparing different quantities.
    bind("header route count", /One gateway, ([\w-]+) routes/g, served.length);
    bind(
      "out-of-scope route count",
      // The sentence gained a clause when row 19 arrived — it mints a
      // credential and reads nothing, so "read-shaped" stopped describing the
      // whole surface. The binder tracks the count, not the adjective, and the
      // `atLeast` check above is what caught the reword: a sentence quietly
      // rephrased out of this pattern fails as "the binder matched nothing"
      // rather than passing as "no drift".
      /The surface is ([\w-]+) routes/g,
      served.length,
    );
  });

  it("counts the POST contracts off the registrations", () => {
    const posts = new Set(
      routes.filter((route) => route.method === "POST").map((route) => route.path),
    );
    expect(posts.size).toBeGreaterThan(0);
    bind("POST contracts", /with ([\w-]+) fixed-by-spec POST/g, posts.size);
  });
});

describe("the error contract is the published enum", () => {
  const spec = SPECS.get("api-surface.md") as string;

  it("names every code the enum can return", () => {
    // `api-surface.md` calls its table "the code table" and defers the whole
    // vocabulary to it. Eleven of the forty-nine were reachable and named
    // nowhere in it — the six `ml-proxy` mappings, which the spec settles in
    // prose, and five framework-level refusals nobody writes a route for.
    const missing = [...statuses.keys()].filter((code) => !spec.includes(code));
    expect(missing).toEqual([]);
  });

  it("pairs every code with the status `errors.ts` publishes", () => {
    // Both spellings the specs use: a `| CODE | 422 |` table row, and an inline
    // `503 CODE`. The inline form is how `OPTIMIZER_NOT_READY` came to be
    // written `502` in the `/v1/backtest` paragraph.
    const wrong: string[] = [];
    let pairs = 0;
    for (const [name, text] of SPECS) {
      const flat = text.replace(/\n/g, " ");
      for (const row of text.matchAll(
        /\|\s*`([A-Z][A-Z0-9_]{4,})`\s*\|\s*`?(\d{3})`?\s*\|/g,
      )) {
        const code = row[1] as string;
        if (!statuses.has(code)) {
          continue;
        }
        pairs += 1;
        if (statuses.get(code) !== Number(row[2])) {
          wrong.push(`${name}: ${code} is ${row[2]}, enum says ${statuses.get(code)}`);
        }
      }
      for (const inline of flat.matchAll(/`(\d{3}) ([A-Z][A-Z0-9_]{4,})`/g)) {
        const code = inline[2] as string;
        if (!statuses.has(code)) {
          continue;
        }
        pairs += 1;
        if (statuses.get(code) !== Number(inline[1])) {
          wrong.push(`${name}: ${code} is ${inline[1]}, enum says ${statuses.get(code)}`);
        }
      }
    }
    expect(pairs, "the status binder matched nothing").toBeGreaterThan(20);
    expect(wrong).toEqual([]);
  });

  it("invents no code the enum has never heard of", () => {
    // The other direction: a code spelled in a spec and in no enum is a client
    // told to handle something that cannot arrive. Scoped to the code-shaped
    // tokens in the error sections, since the specs' backticks also carry
    // constants, env vars and solver statuses.
    const section = spec.slice(spec.indexOf("### The error contract"));
    const codes = [...section.matchAll(/\|\s*`([A-Z][A-Z0-9_]{4,})`\s*\|/g)].map(
      (match) => match[1] as string,
    );
    expect(codes.length).toBeGreaterThan(20);
    expect(codes.filter((code) => !statuses.has(code))).toEqual([]);
  });
});

describe("every path a spec names is a path that exists", () => {
  it("resolves every path-form reference, or has the prose say it is gone", () => {
    // The class the ticket names beside counts, and the one that misled an
    // agent: `apps/web/src/lib/domain.ts` was named as "the single frontend
    // definition" two tickets after it was promoted into `packages/core` and
    // deleted, and `apps/web/src/lib/economics.ts` was still "the single place
    // it is written down".
    //
    // A reference is exempt only when its own paragraph says the file is gone,
    // in the ordinary English the specs already use for it — see
    // `ABSENCE_MARKERS`. That is a vocabulary, not a list of files: it needs no
    // edit when a spec changes, and a rotted path dropped into present-tense
    // prose is still caught.
    const unresolved = references
      .filter((reference) => !(reference.resolves || reference.marked))
      .map((reference) => `${reference.spec}:${reference.line} ${reference.ref}`);
    expect(unresolved).toEqual([]);
  });

  it("has some references it is exempting, and can name them", () => {
    // The exemption is the weak half, so it is measured rather than trusted: if
    // this ever became the majority of the corpus, the check above would be
    // governing almost nothing and somebody should know.
    const exempt = references.filter(
      (reference) => !reference.resolves && reference.marked,
    );
    expect(exempt.length).toBeGreaterThan(0);
    expect(exempt.length).toBeLessThan(references.length / 4);
  });
});

// --- part 3: the guard can fail ----------------------------------------------

describe("the guard is not vacuous: it goes red when the thing it governs moves", () => {
  /** One spec's text with `find` replaced by `replace`, and proof it changed. */
  function drift(spec: string, find: string, replace: string): Map<string, string> {
    const text = SPECS.get(spec) as string;
    expect(text).toContain(find);
    return new Map([...SPECS, [spec, text.replace(find, replace)]]);
  }

  it("fails when an attribute count in the prose drifts by one", () => {
    const drifted_ = drift(
      "feature-engineering.md",
      `${attributes.length} attributes`,
      `${attributes.length + 1} attributes`,
    );
    const claims = live(claimsMatching(/\*{0,2}(\d+)\*{0,2} attributes\b/g, drifted_));
    expect(drifted(claims, attributes.length).length).toBeGreaterThan(0);
  });

  it("fails when the operator-notice interval drifts", () => {
    const drifted_ = drift(
      "feature-engineering.md",
      "ten hours of lost",
      "eleven hours of lost",
    );
    const claims = live(
      claimsMatching(
        /\*{0,2}([\w-]+)\*{0,2} (?:fewer )?hours?\*{0,2}(?: later| less notice| of lost| of operator notice| of notice)/g,
        drifted_,
      ),
    );
    expect(drifted(claims, gate.gateLate - gate.gateEarly).length).toBeGreaterThan(0);
  });

  it("fails when a route is served with no row in the endpoint list", () => {
    const invented = [
      ...routes,
      { method: "GET", path: "/v1/grid/history", module: "grid.ts" },
    ];
    expect(
      productPaths(invented).filter((path) => !endpointListPaths().includes(path)),
    ).toEqual(["/v1/grid/history"]);
  });

  it("fails when a spec names a path nothing answers to", () => {
    const drifted_ = drift(
      "api-surface.md",
      "`apps/api/src/api/ml-proxy.ts`",
      "`apps/api/src/api/ml-bridge.ts`",
    );
    const found = pathReferences(drifted_, tree).filter(
      (reference) => !(reference.resolves || reference.marked),
    );
    expect(found.map((reference) => reference.ref)).toContain(
      "apps/api/src/api/ml-bridge.ts",
    );
  });

  it("fails when a code is added to the enum and reaches no spec", () => {
    const withNew = new Map([...statuses, ["TOTALLY_NEW_REFUSAL", 418]]);
    const spec = SPECS.get("api-surface.md") as string;
    expect([...withNew.keys()].filter((code) => !spec.includes(code))).toEqual([
      "TOTALLY_NEW_REFUSAL",
    ]);
  });
});

describe("the guard is not vacuous: an empty parse does not pass", () => {
  // The defect this repository has hit four times, in four different shapes,
  // every one of which passed its own suite. Each derivation is starved of its
  // input and the assertion that reads it must notice.

  it("a binder that matches nothing fails rather than passing", () => {
    // The exact failure mode: `drifted([], n)` is `[]`, which is what every
    // "expect no violations" assertion wants to see. So the emptiness is a
    // separate assertion, and this is the proof it is the one that fires.
    expect(drifted([], 112)).toEqual([]);
    const nothing = live(claimsMatching(/(\d+) widgets\b/g, SPECS));
    expect(nothing).toEqual([]);
    expect(() => {
      expect(nothing.length).toBeGreaterThanOrEqual(1);
    }).toThrow();
  });

  it("an empty spec corpus fails rather than passing", () => {
    const empty = new Map<string, string>();
    expect(claimsMatching(/\*{0,2}(\d+)\*{0,2} attributes\b/g, empty)).toEqual([]);
    expect(pathReferences(empty, tree)).toEqual([]);
    // Which is why `nothing below is asserted over an empty input` asserts the
    // corpus size first, and why it would fail here.
    expect(() => {
      expect(empty.size).toBe(9);
    }).toThrow();
  });

  it("an empty file listing makes every reference unresolved, not resolved", () => {
    // The direction matters. A tree walk that returned nothing must report the
    // whole corpus as broken, never as fine — the parity READMEs' defect was
    // exactly the opposite polarity, and it read green.
    const blind = pathReferences(SPECS, []);
    expect(blind.length).toBeGreaterThan(100);
    expect(blind.some((reference) => reference.resolves)).toBe(false);
    expect(
      blind.filter((reference) => !(reference.resolves || reference.marked)).length,
    ).toBeGreaterThan(50);
  });

  it("an empty derivation cannot satisfy the count it feeds", () => {
    // `featureRowAttributes()` returning `[]` would make the bound expectation
    // `0`, and every "112 attributes" in the specs would then be a violation
    // rather than a pass — the safe polarity, asserted rather than assumed.
    const claims = live(claimsMatching(/\*{0,2}(\d+)\*{0,2} attributes\b/g, SPECS));
    expect(claims.length).toBeGreaterThan(0);
    expect(drifted(claims, 0).length).toBe(claims.length);
  });
});
