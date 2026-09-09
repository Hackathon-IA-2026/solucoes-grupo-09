import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { explain, validate } from "@wattsteer/core/schema";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { createMetaRoutes } from "../src/api/meta.js";
import type { MlEndpoint } from "../src/api/ml-proxy.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/**
 * `/v1/meta`'s census of the figures WattSteer publishes *with* a caveat.
 *
 * Forecaster 28, and the mirror of `declined-figures.test.ts`. An absent figure
 * cannot mislead anybody: a reader who wanted it is told why it is not there. A
 * figure that is published carrying a caveat nobody reads is a number that will
 * be quoted - `coverage_p10 = 1.0`, computed over zero rows on which the served
 * floor was a positive number, read for months as evidence that the floor was
 * perfect.
 *
 * ### The claim this file exists to hold
 *
 * **A caveat that exists is a caveat this surface can show.** Asserted the same
 * two ways as an absence, neither of which restates a count:
 *
 *  1. **A scan of the modelling service's own source.** Every
 *     `CaveatedFigure(` under `apps/ml/src/wattsteer_ml` is parsed out, handed
 *     to a stubbed modelling service, and required to arrive. A caveat added
 *     over there with no gateway change lands here; a gateway that started
 *     filtering fails. Guarded against matching nothing.
 *  2. **A caveat nobody has heard of.** An entry whose name and module this
 *     build has never seen is forwarded whole.
 *
 * ### And the two things it may not do
 *
 * **It may not re-word.** Several of these sentences already reach a consumer
 * and are load-bearing there - `NOT_A_NINETY_PERCENT_BAND` says a band "must
 * not be described as" a 90% band, `COMPARABILITY` is what keeps five of the
 * sweep's six figures from being read across its arms. The gateway is a pipe.
 *
 * **It may not have a `kind`.** That is the one shape difference from the
 * declines census and it is the ticket's second judgement call answered:
 * `unrunnable` and `unrun` are two answers to *does this figure exist*, and
 * every row here answers yes. `packages/core/test/declines.test.ts` still holds
 * `DECLINE_KINDS` at two members.
 */

/** `apps/ml/src/wattsteer_ml`, from `apps/api/test`. */
const ML_SRC = join(import.meta.dir, "..", "..", "ml", "src", "wattsteer_ml");

/**
 * A caveat declaration in the modelling service's source, either shape.
 *
 * Two, because unlike a declined reason a caveat is sometimes declared as the
 * value of a *published* mapping: `COMPARABILITY` is one figure-to-sentence
 * table and stays one, and splitting it into six module constants so that a
 * regex could anchor on them would be a worse module. `caveated.py`'s walk
 * descends one level into a module-level mapping for exactly that reason, and
 * names the row by the subscript.
 */
const DECLARATIONS = [
  /^(_?[A-Z][A-Z0-9_]*) = CaveatedFigure\(/gm,
  /^ +"([a-z0-9_]+)": CaveatedFigure\(/gm,
];

/** Every declared caveat over there, with the module it is in. */
function declaredByTheModellingService(): { name: string; module: string }[] {
  const found: { name: string; module: string }[] = [];
  for (const entry of readdirSync(ML_SRC, { recursive: true, withFileTypes: true })) {
    const python = entry.isFile() && entry.name.endsWith(".py");
    if (!python || entry.name === "caveated.py") {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const relative = path.slice(ML_SRC.length + 1);
    const source = readFileSync(path, "utf8");
    for (const pattern of DECLARATIONS) {
      for (const match of source.matchAll(pattern)) {
        found.push({
          name: match[1] ?? "",
          module: `apps/ml/src/wattsteer_ml/${relative}`,
        });
      }
    }
  }
  return found.sort(
    (one, other) =>
      one.module.localeCompare(other.module) || one.name.localeCompare(other.name),
  );
}

/** What the stubbed modelling service answers next. */
let reply: () => Response = () => new Response("{}");
const upstream: Server = Bun.serve({ port: 0, fetch: () => reply() });

afterAll(() => {
  upstream.stop(true);
});

const reachable = (): MlEndpoint => ({
  baseUrl: `http://127.0.0.1:${upstream.port}`,
  timeoutMs: 2000,
});

const NOW = new Date("2026-08-28T18:04:11.000Z");

function mlMeta(caveats: unknown): void {
  reply = () =>
    new Response(
      JSON.stringify({
        service: "wattsteer-ml",
        version: "0.1.0",
        environment: "test",
        database_configured: false,
        database_access: "read-only",
        artifacts: {
          path: "/data/models",
          mounted: false,
          writable: false,
          count: 0,
          lanes: [],
          promotion_log: { path: "/data/models/promotions.jsonl", decisions: 0 },
          unrecognised: [],
        },
        declines: [],
        ...(caveats === undefined ? {} : { caveats }),
      }),
      { headers: { "content-type": "application/json" } },
    );
}

interface WireCaveat {
  name: string;
  declared_in: string;
  figure: string;
  caveat: string;
  misreading: string;
  surface: string;
  fault?: string;
}

async function caveats(ml?: MlEndpoint): Promise<{
  body: Record<string, unknown>;
  figures: WireCaveat[];
  incompleteReason: string | null;
}> {
  const response = await new Elysia()
    .use(errorHandler)
    .use(createMetaRoutes({ db: undefined, ml, now: () => NOW, environment: "test" }))
    .handle(
      new Request("http://localhost/v1/meta", {
        headers: { "x-forwarded-for": "9.9.9.9" },
      }),
    );
  const body = (await response.json()) as Record<string, unknown>;
  const block = body.caveats as {
    figures: WireCaveat[];
    incomplete_reason: string | null;
  };
  return {
    body,
    figures: block.figures,
    incompleteReason: block.incomplete_reason,
  };
}

/** One census row as the modelling service writes it. */
function caveat(overrides: Partial<WireCaveat> & { name: string }): WireCaveat {
  return {
    declared_in: "apps/ml/src/wattsteer_ml/evaluation/threshold_sweep.py",
    figure: "a figure this test invented",
    caveat:
      "A sentence long enough to be a caveat, written by a test so that the " +
      "gateway can be watched forwarding one it has never seen before.",
    misreading: "that this test measured something about the Brazilian grid",
    surface: "the model card",
    ...overrides,
  };
}

// --- the claim: a caveat that exists is a caveat this surface can show -------

describe("every caveat the modelling service declares reaches the surface", () => {
  it("finds some declarations in the modelling service's source", () => {
    // The guard on the guard. A regex that stopped matching would leave the
    // assertions below passing over an empty set.
    const declared = declaredByTheModellingService();
    expect(declared.length).toBeGreaterThanOrEqual(20);
    expect(new Set(declared.map((one) => one.module)).size).toBeGreaterThan(5);
  });

  it("finds the two declaration shapes, one of them inside a published map", () => {
    // `COMPARABILITY["pr_auc"]` is declared where it is *published*. A census
    // that could only see module constants would silently miss five caveats on
    // the one block whose entire contribution is which figures survive a
    // threshold change.
    const declared = declaredByTheModellingService();
    expect(declared.map((one) => one.name)).toContain("_NOT_A_READING");
    expect(declared.map((one) => one.name)).toContain("pr_auc");
  });

  it("shows every one of them, with no list of names in between", () => {
    const declared = declaredByTheModellingService();
    mlMeta(declared.map((one) => caveat({ name: one.name, declared_in: one.module })));
    return caveats(reachable()).then(({ figures }) => {
      // Keyed by the pair, because the name alone is deliberately not unique:
      // six blocks declare a `_NOT_A_READING`, each about its own figures.
      const shown = new Set(figures.map((row) => `${row.declared_in} ${row.name}`));
      for (const one of declared) {
        expect(shown.has(`${one.module} ${one.name}`)).toBe(true);
      }
      // No gateway half to add: this gateway publishes no figure of its own to
      // caveat. `no_joint_ensemble` withholds rather than states, which is why
      // it belongs to the other census.
      expect(figures).toHaveLength(declared.length);
    });
  });

  it("forwards a caveat this build has never heard of, whole", async () => {
    // The acceptance box from the gateway's side: adding a caveat requires
    // editing nothing here, and every field arrives unaltered - a re-wording
    // on the way out is a softening of a caveat that already reaches somebody.
    const invented = caveat({
      name: "A_FIGURE_THAT_LIES",
      declared_in: "apps/ml/src/wattsteer_ml/evaluation/a_new_module.py",
      figure: "something whose name says more than its value supports",
      surface: "a block that did not exist when this test was written",
    });
    mlMeta([invented]);
    const { figures } = await caveats(reachable());
    expect(figures).toContainEqual(invented);
  });

  it("keeps the same figure's two caveats apart", async () => {
    // `share_p50_zero` has no model-quality content *and* does not survive a
    // change of threshold: two different false take-aways about one number, so
    // two rows. A census keyed on the figure would have lost one of them.
    mlMeta([
      caveat({ name: "SHARE_P50_ZERO_IS_NOT_MODEL_QUALITY", figure: "share_p50_zero" }),
      caveat({ name: 'COMPARABILITY["share_p50_zero"]', figure: "share_p50_zero" }),
    ]);
    const { figures } = await caveats(reachable());
    expect(figures).toHaveLength(2);
    expect(new Set(figures.map((one) => one.figure)).size).toBe(1);
  });
});

// --- it forwards, and it does not classify ----------------------------------

describe("the gateway is a pipe, and it has no kind to guess at", () => {
  it("carries the sentence verbatim, with no re-wording", async () => {
    // The ticket's hard constraint at the boundary. `NOT_A_NINETY_PERCENT_BAND`
    // is the case: it already tells a consumer a band must not be described as
    // a 90% band, and it must still say that after passing through here.
    const refusal =
      "This fold's served band is NOT a 90% band over its curtailed hours " +
      "and must not be described as one.";
    mlMeta([caveat({ name: "NOT_A_NINETY_PERCENT_BAND", caveat: refusal })]);
    const { figures } = await caveats(reachable());
    expect(figures[0]?.caveat).toBe(refusal);
  });

  it("reports no kind on a caveat, because a published figure exists", async () => {
    // The second judgement call, as a shape rather than as prose: a caveated
    // figure answers *yes* to "does this figure exist", which is the only
    // question `kind` asks. A `kind` here would file a published number in a
    // census whose whole contract is absence.
    mlMeta([caveat({ name: "SOMETHING" })]);
    const { figures } = await caveats(reachable());
    expect(figures[0]).not.toHaveProperty("kind");
    expect(Object.keys(figures[0] ?? {}).sort()).toEqual([
      "caveat",
      "declared_in",
      "figure",
      "misreading",
      "name",
      "surface",
    ]);
  });

  it("keeps a row whose fields it could not read, and says which", async () => {
    // Shorter than the truth is the one direction this census may never be
    // wrong in, and here the missing row is a number somebody is still quoting.
    mlMeta([{ name: "HALF_A_ROW", caveat: "A sentence, and nothing else." }]);
    const { figures } = await caveats(reachable());
    expect(figures).toHaveLength(1);
    expect(figures[0]?.caveat).toBe("A sentence, and nothing else.");
    expect(figures[0]?.fault).toContain("no misreading");
    expect(figures[0]?.figure).toContain("not reported");
  });

  it("orders by module and then name, so two deployments are diffable", async () => {
    mlMeta([
      caveat({ name: "B", declared_in: "apps/ml/src/wattsteer_ml/z.py" }),
      caveat({ name: "B", declared_in: "apps/ml/src/wattsteer_ml/a.py" }),
      caveat({ name: "A", declared_in: "apps/ml/src/wattsteer_ml/z.py" }),
    ]);
    const { figures } = await caveats(reachable());
    expect(figures.map((one) => `${one.declared_in}:${one.name}`)).toEqual([
      "apps/ml/src/wattsteer_ml/a.py:B",
      "apps/ml/src/wattsteer_ml/z.py:A",
      "apps/ml/src/wattsteer_ml/z.py:B",
    ]);
  });
});

// --- it may be short, and it says so ----------------------------------------

describe("a short census says that it is short", () => {
  it("is whole when the modelling service answered with its half", async () => {
    mlMeta([caveat({ name: "SOMETHING" })]);
    expect((await caveats(reachable())).incompleteReason).toBeNull();
  });

  it("goes to nothing when the modelling service is unreachable, and says why", async () => {
    // The whole census is the modelling service's, so an unreachable one costs
    // all of it. An empty block with no note would read as a deployment every
    // one of whose published numbers means what it says.
    const { figures, incompleteReason } = await caveats();
    expect(figures).toEqual([]);
    expect(incompleteReason).toBe("OPTIMIZER_NOT_CONFIGURED");
  });

  it("distinguishes a service with nothing to caveat from one that did not say", async () => {
    mlMeta(undefined);
    expect((await caveats(reachable())).incompleteReason).toBe(
      "MODEL_CAVEATS_NOT_REPORTED",
    );
    mlMeta([]);
    expect((await caveats(reachable())).incompleteReason).toBeNull();
  });

  it("still answers the rest of the document when the census is missing", async () => {
    mlMeta(undefined);
    const { body } = await caveats(reachable());
    expect(body.service).toBe("wattsteer-api");
    expect((body.model as { reachable: boolean }).reachable).toBe(true);
  });
});

// --- the document, and the rule that produced these sentences ---------------

describe("the census is part of the schema's own document", () => {
  it("validates whole, with an unreadable row on it", async () => {
    mlMeta([caveat({ name: "FINE" }), { name: "ODD" }]);
    const { body } = await caveats(reachable());
    const result = validate("meta.schema.json", body);
    expect(result.valid ? "" : explain(result)).toBe("");
  });

  it("puts no number anywhere on it", async () => {
    // The rule that produced every one of these sentences, applied to the
    // census of them: a list of numbers that mean something other than what
    // they say is the last surface that could afford to carry one.
    mlMeta([caveat({ name: "SOMETHING" })]);
    const { figures } = await caveats(reachable());
    expect(figures.length).toBeGreaterThan(0);
    for (const one of figures) {
      for (const value of Object.values(one)) {
        expect(typeof value).toBe("string");
      }
    }
  });
});
