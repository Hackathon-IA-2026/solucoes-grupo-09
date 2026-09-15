import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_DECLINED_FIGURES } from "@wattsteer/core/declines";
import { explain, validate } from "@wattsteer/core/schema";
import type { Server } from "bun";
import { Elysia } from "elysia";
import { createMetaRoutes } from "../src/api/meta.js";
import type { MlEndpoint } from "../src/api/ml-proxy.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/**
 * `/v1/meta`'s census of the figures WattSteer declines to state.
 *
 * Forecaster 25: one surface answering "what does this system decline to tell
 * me, and why", **assembled from the named reasons and never hand-written**.
 * The set has two halves and this is where they meet — the modelling service's,
 * walked out of its own package, and the gateway's one, keyed by the schema
 * enum that owns it.
 *
 * ### The claim this file exists to hold
 *
 * **A reason that exists is a reason this surface can show.** That is a claim
 * about *every* named absence rather than about the seven somebody remembered
 * to test, so it is asserted two ways, neither of which restates a count:
 *
 *  1. **A scan of the modelling service's own source.** Every
 *     `NAME = DeclinedFigure(` under `apps/ml/src/wattsteer_ml` is parsed out,
 *     handed to a stubbed modelling service, and required to arrive on the
 *     response. A constant added over there with no gateway change lands here
 *     automatically; a gateway that started filtering fails. The scan is guarded
 *     against matching nothing, because a regex that quietly stopped matching
 *     would pass every assertion below while proving nothing at all — the
 *     failure `cache-policy.test.ts` records having had.
 *  2. **A ninth reason nobody has heard of.** An entry whose name, module and
 *     `kind` this build has never seen is still forwarded, whole. The gateway is
 *     a pipe here on purpose: anything it recognised selectively would be a
 *     surface that goes quietly short exactly when the modelling service grows.
 *
 * ### And the distinction it may not collapse
 *
 * `unrunnable` and `unrun` are two sentences — forecaster 16 against forecaster
 * 18 — and an unrecognised third value becomes `unresolvable` with a `fault`
 * naming what was reported, never one of the two and never a shared
 * "unavailable". That is the position `meta.ts` already takes on a lane state
 * it does not recognise, and the reason is identical: rounding an unknown value
 * down to a known one publishes a claim on the strength of not recognising a
 * name.
 */

/** `apps/ml/src/wattsteer_ml`, from `apps/api/test`. */
const ML_SRC = join(import.meta.dir, "..", "..", "ml", "src", "wattsteer_ml");

/**
 * A module-level `NAME = DeclinedFigure(` in the modelling service's source.
 *
 * Anchored to the start of a line, because that is the only shape
 * `declined.py`'s walk over module attributes can see. `apps/ml`'s own suite
 * reconciles the two directly; what this scan is for is the *gateway's* half of
 * the claim, which has to be assertable without a Python process.
 */
const DECLARATION = /^([A-Z][A-Z0-9_]*) = DeclinedFigure\(/gm;

/** Every declared reason constant over there, with the module it is in. */
function declaredByTheModellingService(): { name: string; module: string }[] {
  const found: { name: string; module: string }[] = [];
  for (const entry of readdirSync(ML_SRC, { recursive: true, withFileTypes: true })) {
    const python = entry.isFile() && entry.name.endsWith(".py");
    if (!python || entry.name === "declined.py") {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const relative = path.slice(ML_SRC.length + 1);
    for (const match of readFileSync(path, "utf8").matchAll(DECLARATION)) {
      found.push({
        name: match[1] ?? "",
        module: `apps/ml/src/wattsteer_ml/${relative}`,
      });
    }
  }
  return found.sort((one, other) => one.name.localeCompare(other.name));
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

/** The modelling service's `/v1/meta`, carrying whatever census a test wants. */
function mlMeta(census: unknown): void {
  reply = () =>
    Response.json({
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
      ...(census === undefined ? {} : { declines: census }),
    });
}

interface WireFigure {
  name: string;
  declared_in: string;
  figure: string;
  kind: string;
  reason: string;
  surface: string;
  fault?: string;
}

async function declines(ml?: MlEndpoint): Promise<{
  body: Record<string, unknown>;
  figures: WireFigure[];
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
  const block = body.declines as {
    figures: WireFigure[];
    incomplete_reason: string | null;
  };
  return {
    body,
    figures: block.figures,
    incompleteReason: block.incomplete_reason,
  };
}

/** One census row as the modelling service writes it. */
function figure(overrides: Partial<WireFigure> & { name: string }): WireFigure {
  return {
    declared_in: "apps/ml/src/wattsteer_ml/evaluation/dessem_ab.py",
    figure: "a figure this test invented",
    kind: "unrun",
    reason:
      "A sentence long enough to be a reason, written by a test so that the " +
      "gateway can be watched forwarding one it has never seen before.",
    surface: "the model card",
    ...overrides,
  };
}

// --- the claim: a reason that exists is a reason this surface can show -------

describe("every reason the modelling service declares reaches the surface", () => {
  it("finds some declarations in the modelling service's source", () => {
    // The guard on the guard, and it is the whole reason the scan is trusted
    // below. A regex that stopped matching would leave the next two assertions
    // passing over an empty set.
    const declared = declaredByTheModellingService();
    expect(declared.length).toBeGreaterThanOrEqual(7);
    expect(new Set(declared.map((one) => one.module)).size).toBeGreaterThan(1);
  });

  it("shows every one of them, with no list of names in between", () => {
    // The scan is the authority. A constant added in `apps/ml` with no change
    // here still arrives, because nothing on this side enumerates them — and a
    // gateway that grew an allowlist would fail this exactly where it should.
    const declared = declaredByTheModellingService();
    mlMeta(declared.map((one) => figure({ name: one.name, declared_in: one.module })));
    return declines(reachable()).then(({ figures }) => {
      const shown = new Map(figures.map((row) => [row.name, row]));
      for (const one of declared) {
        expect(shown.get(one.name)?.declared_in).toBe(one.module);
      }
      // The gateway's own is on it too, so the census is the two halves and
      // never one of them.
      expect(figures).toHaveLength(declared.length + GATEWAY_DECLINED_FIGURES.length);
    });
  });

  it("forwards a reason this build has never heard of, whole", async () => {
    // The acceptance box, from the gateway's side: adding a named reason
    // requires editing nothing here. Every field arrives unaltered, because the
    // forecaster owns the vocabulary of its own absences and a re-wording on the
    // way out is where two vocabularies start.
    const ninth = figure({
      name: "A_NINTH_ABSENCE",
      declared_in: "apps/ml/src/wattsteer_ml/evaluation/a_new_module.py",
      figure: "something nobody has measured",
      surface: "a block that did not exist when this test was written",
    });
    mlMeta([ninth]);
    const { figures } = await declines(reachable());
    expect(figures).toContainEqual(ninth);
  });
});

// --- unrunnable is not unrun, and neither is "unavailable" -------------------

describe("the two kinds stay two, and an unknown third is neither", () => {
  it("passes unrunnable and unrun through untouched", async () => {
    mlMeta([
      figure({ name: "CANNOT", kind: "unrunnable" }),
      figure({ name: "HAS_NOT", kind: "unrun" }),
    ]);
    const { figures } = await declines(reachable());
    const shown = new Map(figures.map((one) => [one.name, one]));
    expect(shown.get("CANNOT")?.kind).toBe("unrunnable");
    expect(shown.get("HAS_NOT")?.kind).toBe("unrun");
    for (const one of figures) {
      expect(one.fault).toBeUndefined();
    }
  });

  it("refuses to guess between them for a kind it does not recognise", async () => {
    // `unresolvable` is not a third kind. It is the same refusal `meta.ts`
    // already makes for a lane state it does not know: mapping an unrecognised
    // value onto a recognised one publishes a claim on the strength of not
    // recognising a name, and here the two claims available are the two this
    // ticket exists to keep apart.
    mlMeta([figure({ name: "SOMETHING_ELSE", kind: "unavailable" })]);
    const { figures } = await declines(reachable());
    const shown = figures.find((one) => one.name === "SOMETHING_ELSE");
    expect(shown?.kind).toBe("unresolvable");
    expect(shown?.fault).toContain("unavailable");
    // Kept, not dropped, and its reason survives — a reason the gateway cannot
    // classify is still a reason, and losing it is the one outcome this surface
    // may never have.
    expect(shown?.reason).toContain("A sentence long enough");
  });

  it("does not round an unrecognised kind onto either of the two", async () => {
    mlMeta([figure({ name: "SOMETHING_ELSE", kind: "unavailable" })]);
    const { figures } = await declines(reachable());
    const shown = figures.find((one) => one.name === "SOMETHING_ELSE");
    expect(shown?.kind).not.toBe("unrunnable");
    expect(shown?.kind).not.toBe("unrun");
  });
});

// --- the gateway's own half --------------------------------------------------

describe("the gateway's own declined figure is on it too", () => {
  it("carries the reason this gateway mints for the model card", async () => {
    // Forecaster 27's judgement call, from the outside: `metrics_absent_reason`
    // is authored in TypeScript, so no walk of the Python package could ever
    // reach it. It is on the census because the gateway half gained a typed
    // table for it, not because anybody listed it.
    mlMeta([]);
    const { figures } = await declines(reachable());
    const metrics = figures.find((one) => one.name === "metrics_absent_reason");
    expect(metrics?.kind).toBe("unrun");
    expect(metrics?.declared_in).toBe("packages/core/src/declines.ts");
    expect(metrics?.surface).toContain("/v1/model/card");
  });

  it("carries the national band's absence, which the modelling service never spells", async () => {
    mlMeta([]);
    const { figures } = await declines(reachable());
    const band = figures.find((one) => one.name === "no_joint_ensemble");
    expect(band?.kind).toBe("unrunnable");
    expect(band?.surface).toContain("band_unavailable_reason");
    expect(band?.declared_in).toBe("packages/core/src/declines.ts");
  });

  it("merges the two halves in one order, so two deployments are diffable", async () => {
    mlMeta([figure({ name: "ZZZ_LAST" }), figure({ name: "AAA_FIRST" })]);
    const { figures } = await declines(reachable());
    // One order over both halves, and it carries no argument about which half
    // matters more: `no_joint_ensemble` sorts between the two rather than being
    // appended after them.
    // Derived from the gateway's own tables rather than transcribed: forecaster
    // 27 added a second entry to this half and a hand-written expectation is
    // exactly the thing that would have gone stale.
    const gateway = GATEWAY_DECLINED_FIGURES.map((one) => one.name);
    expect(figures.map((one) => one.name)).toEqual(
      ["AAA_FIRST", ...gateway, "ZZZ_LAST"].sort((one, other) =>
        one.localeCompare(other),
      ),
    );
    for (const name of gateway) {
      expect(figures.map((one) => one.name)).toContain(name);
    }
  });
});

// --- it may be short, and it says so ----------------------------------------

describe("a short census says that it is short", () => {
  it("is whole when the modelling service answered with its half", async () => {
    mlMeta([figure({ name: "SOMETHING" })]);
    expect((await declines(reachable())).incompleteReason).toBeNull();
  });

  it("names the unreachable modelling service rather than going quietly short", async () => {
    // The point of this field. A census of what a system refuses to claim is
    // the last place that could imply a completeness it does not have: with the
    // modelling service down, seven of the eight absences are unknown, and a
    // one-row list with no note would read as "this deployment withholds one
    // figure" — which is a fabrication of exactly the kind these reasons exist
    // to prevent.
    const { figures, incompleteReason } = await declines();
    expect(incompleteReason).toBe("OPTIMIZER_NOT_CONFIGURED");
    expect(figures.map((one) => one.name)).toEqual(
      GATEWAY_DECLINED_FIGURES.map((one) => one.name).sort((one, other) =>
        one.localeCompare(other),
      ),
    );
  });

  it("distinguishes a service with nothing to declare from one that did not say", async () => {
    // An older modelling service answers `/v1/meta` with no census block at
    // all. That is not a build that withholds nothing.
    mlMeta(undefined);
    const absent = await declines(reachable());
    expect(absent.incompleteReason).toBe("MODEL_DECLINES_NOT_REPORTED");

    mlMeta([]);
    const empty = await declines(reachable());
    expect(empty.incompleteReason).toBeNull();
  });

  it("still answers the rest of the document when the census is missing", async () => {
    mlMeta(undefined);
    const { body } = await declines(reachable());
    expect(body.service).toBe("wattsteer-api");
    expect((body.model as { reachable: boolean }).reachable).toBe(true);
  });
});

// --- the document, and the rule that produced these reasons ------------------

describe("the census is part of the schema's own document", () => {
  it("validates whole, with a reason the gateway could not classify on it", async () => {
    mlMeta([
      figure({ name: "FINE", kind: "unrunnable" }),
      figure({ name: "ODD", kind: "who_knows" }),
    ]);
    const { body } = await declines(reachable());
    const result = validate("meta.schema.json", body);
    expect(result.valid ? "" : explain(result)).toBe("");
  });

  it("puts no number anywhere on it", async () => {
    // The rule that produced every one of these reasons, applied to the census
    // of them: nothing here may read as a measurement. Every field is prose, on
    // both halves, which is why there is nothing on this surface to mistake.
    mlMeta(GATEWAY_DECLINED_FIGURES.map((one) => figure({ name: one.name })));
    const { figures } = await declines(reachable());
    expect(figures.length).toBeGreaterThan(0);
    for (const one of figures) {
      for (const value of Object.values(one)) {
        expect(typeof value).toBe("string");
      }
    }
  });
});
