import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Elysia } from "elysia";
import { createDiagnosisRoutes } from "../src/api/diagnosis.js";
import { dailyCap } from "../src/api/plugins/daily-cap.js";
import { errorHandler } from "../src/api/plugins/errors.js";
import { memoryStore } from "../src/api/plugins/limit-store.js";
import { memoryLockedCache } from "../src/api/plugins/locked-cache.js";
import type { Database } from "../src/database/connection.js";
import {
  type FiredRule,
  NARRATION_MODEL_ID,
  NARRATION_OUTPUT_FIELD,
  type NarrationStore,
} from "../src/diagnosis/index.js";
import type { PublishedAttributionRow } from "../src/diagnosis/reads.js";
import type { PublishedForecast } from "../src/forecast/reads.js";
import { attributionRow, publishedForecast } from "./support/attribution-rows.js";

/**
 * `/v1/diagnosis/day-ahead`, without a database and without a language model.
 *
 * Everything this endpoint promises that is not a row is provable here: the
 * refusals, the ranking it does *not* cut, the withheld state that is a 200,
 * the one `Vary` header, the two caches and the absence of a third, and the
 * single-flight that turns a hundred concurrent misses into one call. The
 * round trip through the canonical `AsOf` views is `database-diagnosis.test.ts`,
 * which needs real Postgres and says so.
 *
 * The two stored rows are injected, which is what makes the composition
 * testable at all; the narration is not stubbed — the real cache, the real
 * gate, the real validator and the real template run, and only the SDK's
 * `messages` is stood in for. A test that replaced the narration wholesale
 * would assert that the route calls a function, which is not what the ticket
 * asks anybody to believe.
 */

const NOW = new Date("2026-08-28T18:00:00.000Z");
const DATE = "2026-08-28";

/** A clean paragraph in each locale, quoting only figures the document carries. */
const CLEAN_PT = [
  "Para o NORDESTE em 28 de agosto de 2026, o modelo lê o risco de restrição",
  "acima de 5 MW como alto: 87% para pelo menos uma hora, com 9 horas cuja P50",
  "fica acima de zero. Ele espera 412,0 MWh no dia inteiro, contra um típico",
  "96,0 MWh, uma diferença de 316,0 MWh que os grupos dividem entre si. A maior",
  "hora é 13:00, com uma mediana de 118,0 MW.",
].join(" ");

const CLEAN_EN = [
  "For NORDESTE on 28 August 2026, the model reads the risk of curtailment",
  "above 5 MW as high: 87% for at least one hour, with 9 hours whose P50 is",
  "above zero. It expects 412.0 MWh over the whole day against a typical 96.0",
  "MWh, a difference of 316.0 MWh that the driver groups divide between them.",
  "The largest hour is 13:00, at a median 118.0 MW.",
].join(" ");

/** The rule that withholds, as `apps/ml`'s engine records it. */
const NOISE: FiredRule = {
  code: "attribution_is_noise",
  action: "withhold",
  facts: { sum_abs_attributed_mwh: 444, attribution_stderr_mwh: 4.1 },
};

/** The SDK's `messages`, standing in: it records every call it was asked for. */
function stub(): {
  create: (
    params: Anthropic.MessageCreateParamsNonStreaming,
  ) => Promise<Anthropic.Message>;
  sent: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    sent,
    create: async (params) => {
      sent.push(params);
      const blocks = Array.isArray(params.messages[0]?.content)
        ? params.messages[0].content
        : [];
      const asked = blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      const text = asked.includes("en-US") ? CLEAN_EN : CLEAN_PT;
      return {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: NARRATION_MODEL_ID,
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [
          { type: "text", text: JSON.stringify({ [NARRATION_OUTPUT_FIELD]: text }) },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Anthropic.Message;
    },
  };
}

/** A narration store that records every key anything was stored under. */
function recordingStore(): NarrationStore & { written: string[] } {
  const inner = memoryLockedCache();
  const written: string[] = [];
  return {
    written,
    detail: inner.detail,
    get: inner.get,
    set: async (key, value, ttlSec) => {
      written.push(key);
      await inner.set(key, value, ttlSec);
    },
    acquire: inner.acquire,
    release: inner.release,
    close: inner.close,
  };
}

interface Harness {
  handle: (query: string, headers?: Record<string, string>) => Promise<Response>;
  sent: Anthropic.MessageCreateParamsNonStreaming[];
  store: NarrationStore & { written: string[] };
}

async function harness(
  options: {
    attribution?: PublishedAttributionRow | null;
    forecast?: PublishedForecast | null;
    rows?: () => PublishedAttributionRow | null;
    capLimit?: number;
    spend?: number;
    db?: Database | undefined;
  } = {},
): Promise<Harness> {
  const messages = stub();
  const store = recordingStore();
  const cap = dailyCap({
    name: "narration",
    limit: options.capLimit ?? 200,
    store: memoryStore(),
  });
  // Awaited, not fired and forgotten: a budget spent concurrently with the
  // request under test would make this suite's own timing the assertion.
  for (let spent = 0; spent < (options.spend ?? 0); spent += 1) {
    await cap.take(NOW.getTime());
  }
  const attribution =
    options.attribution === undefined ? attributionRow() : options.attribution;
  const forecast =
    options.forecast === undefined ? publishedForecast() : options.forecast;
  const routes = new Elysia().use(errorHandler).use(
    createDiagnosisRoutes({
      db: "db" in options ? options.db : ({} as unknown as Database),
      now: () => NOW,
      sources: {
        attribution: async () => (options.rows ? options.rows() : attribution),
        forecast: async () => forecast,
      },
      narration: { store, cap, messages },
    }),
  );
  return {
    store,
    sent: messages.sent,
    handle: (query, headers = {}) =>
      routes.handle(
        new Request(`http://localhost/v1/diagnosis/day-ahead${query}`, { headers }),
      ),
  };
}

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const codeOf = async (response: Response): Promise<string> => {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
};

const attributionOf = (body: Record<string, unknown>): Record<string, unknown> =>
  body.attribution as Record<string, unknown>;

const driversOf = (body: Record<string, unknown>): Record<string, unknown>[] =>
  attributionOf(body).drivers as Record<string, unknown>[];

const narrationOf = (body: Record<string, unknown>): Record<string, unknown> =>
  body.narration as Record<string, unknown>;

describe("the attribution half is a row read", () => {
  it("answers 200 with the modelling service's URL unset", async () => {
    // The property, asserted rather than assumed: nothing in this path can
    // reach the modelling service, so its absence cannot change the answer.
    expect(process.env.WATTSTEER_ML_URL).toBeUndefined();
    const app = await harness();
    const response = await app.handle(`?subsystem=NE&date=${DATE}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.subsystem).toBe("NE");
    expect(body.target_date).toBe(DATE);
  });

  it("has no import that could reach the modelling service", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "api", "diagnosis.ts"),
      "utf8",
    );
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports.some((line) => line.includes("ml-proxy"))).toBe(false);
    expect(imports.some((line) => line.includes("ml-client"))).toBe(false);
  });

  it("refuses when persistence is not configured, rather than inventing", async () => {
    const app = await harness({ db: undefined });
    const response = await app.handle(`?subsystem=NE&date=${DATE}`);
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("DATA_UNAVAILABLE");
  });
});

describe("all eight groups, ranked, and the display rule is the client's", () => {
  it("returns eight rows including the two below the display cut", async () => {
    const app = await harness();
    const body = await json(await app.handle(`?subsystem=NE&date=${DATE}`));
    const drivers = driversOf(body);
    expect(drivers).toHaveLength(8);
    // `recent_history` (12/444 ≈ 0.027) and `data_conditions` (8/444 ≈ 0.018)
    // are under `share ≥ 0.03`: a server-side cut would have dropped them.
    expect(drivers.map((driver) => driver.code)).toContain("recent_history");
    expect(drivers.map((driver) => driver.code)).toContain("data_conditions");
    expect(drivers.map((driver) => driver.code)).not.toContain("other");
    const shares = drivers.map((driver) => Number(driver.share));
    expect([...shares].sort((a, b) => b - a)).toEqual(shares);
    expect(attributionOf(body).peak_hour_drivers).toHaveLength(8);
  });

  it("carries the peak hour's rows with a disagreement of zero, not a gap", async () => {
    // The schema requires the field on every driver and the publication stores
    // `null` at the peak hour, because one hour has nothing to disagree with.
    const app = await harness();
    const body = await json(await app.handle(`?subsystem=NE&date=${DATE}`));
    const peak = attributionOf(body).peak_hour_drivers as Record<string, unknown>[];
    for (const driver of peak) {
      expect(driver.hour_disagreement).toBe(0);
    }
  });
});

describe("the parameters this endpoint has, and the one it refuses", () => {
  it("refuses a technology parameter rather than ignoring it", async () => {
    const app = await harness();
    const response = await app.handle(`?subsystem=NE&date=${DATE}&technology=wind`);
    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe("BAD_INPUT");
    expect(app.sent).toHaveLength(0);
  });

  it("refuses an unknown subsystem and an unknown gate profile", async () => {
    const app = await harness();
    expect(await codeOf(await app.handle("?subsystem=SIN"))).toBe("SUBSYSTEM_UNKNOWN");
    expect(
      await codeOf(await app.handle(`?subsystem=NE&date=${DATE}&gate_profile=gate_x`)),
    ).toBe("GATE_PROFILE_UNKNOWN");
  });

  it("refuses a locale it cannot generate prose in", async () => {
    const app = await harness();
    const response = await app.handle(`?subsystem=NE&date=${DATE}&locale=es-AR`);
    expect(response.status).toBe(422);
    expect(await codeOf(response)).toBe("LOCALE_UNSUPPORTED");
  });
});

describe("locale: the one axis this endpoint varies on", () => {
  it("defaults to Portuguese with no parameter and no header", async () => {
    const app = await harness();
    const body = await json(await app.handle(`?subsystem=NE&date=${DATE}`));
    expect(narrationOf(body).locale).toBe("pt-BR");
  });

  it("negotiates from Accept-Language by quality, not by position", async () => {
    const app = await harness();
    const body = await json(
      await app.handle(`?subsystem=NE&date=${DATE}`, {
        "accept-language": "es-AR, en-GB;q=0.9, pt-BR;q=0.4",
      }),
    );
    expect(narrationOf(body).locale).toBe("en-US");
  });

  it("lets an explicit locale beat the header", async () => {
    const app = await harness();
    const body = await json(
      await app.handle(`?subsystem=NE&date=${DATE}&locale=en`, {
        "accept-language": "pt-BR",
      }),
    );
    expect(narrationOf(body).locale).toBe("en-US");
  });

  it("sets the language variation header and no other", async () => {
    const app = await harness();
    const response = await app.handle(`?subsystem=NE&date=${DATE}`);
    expect(response.headers.get("vary")).toBe("Accept-Language");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });
});

describe("a withheld diagnosis is a success", () => {
  it("is a 200 with the drivers untouched, the codes, and a template", async () => {
    const app = await harness({ attribution: attributionRow({ ruleFlags: [NOISE] }) });
    const response = await app.handle(`?subsystem=NE&date=${DATE}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.withheld_by).toEqual(["attribution_is_noise"]);
    expect(driversOf(body)).toHaveLength(8);
    expect(narrationOf(body).source).toBe("template");
    expect(narrationOf(body).text).toBeUndefined();
    expect(Array.isArray(narrationOf(body).clauses)).toBe(true);
    // The whole of what `withhold` does: the model is not called. Not called
    // and discarded — not called.
    expect(app.sent).toHaveLength(0);
    // And nothing was cached under the narration key on a withheld day.
    expect(app.store.written).toEqual([]);
  });

  it("still carries the rules that only annotate, without withholding", async () => {
    const app = await harness({
      attribution: attributionRow({
        ruleFlags: [
          {
            code: "stale_inputs",
            action: "annotate",
            facts: { weather_run_age_hours: 12 },
          },
        ],
      }),
    });
    const body = await json(await app.handle(`?subsystem=NE&date=${DATE}`));
    expect(body.withheld_by).toEqual([]);
    expect(narrationOf(body).source).toBe("model");
    expect((body.rule_flags as Record<string, unknown>[])[0]?.severity).toBe("annotate");
  });
});

describe("two caches, and no third", () => {
  it("stores the narration under one key and nothing under any other", async () => {
    const app = await harness();
    await app.handle(`?subsystem=NE&date=${DATE}`);
    await app.handle(`?subsystem=NE&date=${DATE}`);
    expect(app.store.written).toHaveLength(1);
    expect(app.store.written[0]).toMatch(
      /^narration:v1:[^:]+:claude-opus-5:pt-BR:[0-9a-f]{64}$/,
    );
    // The second request was served from that one entry, not from a second one
    // over the composed response.
    expect(app.sent).toHaveLength(1);
  });

  it("hits on jitter below display precision and misses on a real change", async () => {
    const jitter = await harness({
      rows: (() => {
        let call = 0;
        return () => {
          call += 1;
          // A recomputation's noise in the sixteenth decimal: the reader could
          // never see it, so it must not cost a second call.
          return attributionRow({
            attributionStderrMwh: call === 1 ? 4.1 : 4.100_000_000_000_001,
          });
        };
      })(),
    });
    await jitter.handle(`?subsystem=NE&date=${DATE}`);
    await jitter.handle(`?subsystem=NE&date=${DATE}`);
    expect(jitter.sent).toHaveLength(1);

    const real = await harness({
      rows: (() => {
        let call = 0;
        return () => {
          call += 1;
          return attributionRow({ attributionStderrMwh: call === 1 ? 4.1 : 9.9 });
        };
      })(),
    });
    await real.handle(`?subsystem=NE&date=${DATE}`);
    await real.handle(`?subsystem=NE&date=${DATE}`);
    expect(real.sent).toHaveLength(2);
  });

  it("keys the narration by locale, so two languages are two entries", async () => {
    const app = await harness();
    await app.handle(`?subsystem=NE&date=${DATE}&locale=pt-BR`);
    await app.handle(`?subsystem=NE&date=${DATE}&locale=en-US`);
    expect(app.sent).toHaveLength(2);
    expect(new Set(app.store.written).size).toBe(2);
  });

  it("puts the row's version and the narration key on the ETag", async () => {
    const app = await harness();
    const response = await app.handle(`?subsystem=NE&date=${DATE}`);
    const etag = response.headers.get("etag") ?? "";
    expect(etag).toContain("2026-08-27T22:11:07.000Z");
    expect(etag).toContain("narration:v1");
  });
});

describe("single-flight: the stampede, collapsed", () => {
  it("makes exactly one call for a hundred concurrent misses on a cold key", async () => {
    const app = await harness();
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => app.handle(`?subsystem=NE&date=${DATE}`)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    // The assertion the ticket asks for, on the client rather than on a timing.
    expect(app.sent).toHaveLength(1);
    const bodies = await Promise.all(responses.map((response) => json(response)));
    for (const body of bodies) {
      expect(narrationOf(body).source).toBe("model");
      expect(narrationOf(body).text).toBe(CLEAN_PT);
    }
  });

  it("collapses per key, so two locales at once are two calls and not more", async () => {
    const app = await harness();
    await Promise.all([
      ...Array.from({ length: 50 }, () =>
        app.handle(`?subsystem=NE&date=${DATE}&locale=pt-BR`),
      ),
      ...Array.from({ length: 50 }, () =>
        app.handle(`?subsystem=NE&date=${DATE}&locale=en-US`),
      ),
    ]);
    expect(app.sent).toHaveLength(2);
  });
});

describe("the daily cap never refuses", () => {
  it("serves the template beyond the cap and says so", async () => {
    // The budget is spent before the request arrives: one call allowed, one
    // already made elsewhere in the deployment.
    const app = await harness({ capLimit: 1, spend: 1 });
    const response = await app.handle(`?subsystem=NE&date=${DATE}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(narrationOf(body).source).toBe("template");
    expect(body.withheld_by).toEqual([]);
    expect(driversOf(body)).toHaveLength(8);
    expect(app.sent).toHaveLength(0);
  });

  it("counts calls rather than requests: a cache hit costs nothing", async () => {
    const app = await harness({ capLimit: 1 });
    await app.handle(`?subsystem=NE&date=${DATE}`);
    const second = await app.handle(`?subsystem=NE&date=${DATE}`);
    // The second request would be over a cap of one if requests were counted.
    expect(narrationOf(await json(second)).source).toBe("model");
    expect(app.sent).toHaveLength(1);
  });
});

describe("the absence states, told apart", () => {
  it("answers the distinct code when a forecast exists and no attribution does", async () => {
    const app = await harness({ attribution: null });
    const response = await app.handle(`?subsystem=NE&date=${DATE}`);
    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe("DIAGNOSIS_UNAVAILABLE");
  });

  it("answers about the forecast when there is no forecast either", async () => {
    const app = await harness({ attribution: null, forecast: null });
    const response = await app.handle(`?subsystem=NE&date=${DATE}`);
    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe("FORECAST_UNAVAILABLE");
  });

  it("says the gate has not passed rather than that nothing was explained", async () => {
    const app = await harness({ attribution: null, forecast: null });
    // Tomorrow's late gate is 2026-08-28T22:00Z, after the frozen now.
    const response = await app.handle("?subsystem=NE&date=2026-08-29");
    expect(await codeOf(response)).toBe("FORECAST_NOT_YET_PUBLISHED");
  });
});
