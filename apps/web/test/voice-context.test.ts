import { describe, expect, test } from "bun:test";

import type {
  CurtailmentEpisodes,
  DiagnosisDayAhead,
  ForecastDayAhead,
} from "@wattsteer/core/api";
import type { AppParams } from "../src/components/app/params";
import type { ExplainState } from "../src/components/app/use-explain";
import type { NetworkState } from "../src/components/app/use-network";
import type { ServingState } from "../src/components/app/use-serving";
import { LOCALES } from "../src/i18n/locale";
import {
  bandPhrase,
  contextLines,
  contextSentence,
  forecastRefusal,
  hasForecast,
  type VoiceContextInput,
  type VoiceScreen,
} from "../src/lib/voice/context";

/**
 * The block the model is given, and the sentence in it that carries the absence.
 *
 * The state this is built for is not hypothetical. `/v1/meta`, production,
 * 2026-09-15: both lanes `present_unpromoted`, the hot-swap gate having refused
 * the only artifact on each, `forecast.latest_published` empty. So the forecast
 * endpoints refuse and the model card refuses, and the agent's only honest move
 * is to say so. The assertions below are mostly about the *absence*, because
 * that is the path the product is actually on and the path a demo will take.
 */

const PARAMS: AppParams = {
  subsystem: "NE",
  technology: "WIND",
  run: "12Z",
  date: "2026-09-16",
  episode: "2026-08-11-ne",
};

/** Today: two lanes, both refused by the gate, nothing promoted. */
const NOTHING_PROMOTED: ServingState = {
  status: "known",
  lanes: [
    { name: "gate_early", condition: "present_unpromoted", usable: false },
    { name: "gate_late", condition: "present_unpromoted", usable: false },
  ],
  modelReachable: true,
  serving: false,
};

const PROMOTED: ServingState = {
  status: "known",
  lanes: [
    { name: "gate_early", condition: "promoted", usable: true },
    { name: "gate_late", condition: "present_unpromoted", usable: false },
  ],
  modelReachable: true,
  serving: true,
};

const EPISODES = { episodes: [] } as unknown as CurtailmentEpisodes;

const OBSERVED = {
  now: {} as never,
  hours: [
    { validTime: "2026-09-14T03:00:00Z", hourLocal: 0, constrainedOffMwh: 120 },
    { validTime: "2026-09-14T04:00:00Z", hourLocal: 1, constrainedOffMwh: 80 },
  ],
  hoursDate: "2026-09-14",
  episodes: EPISODES,
};

const FORECAST = {
  riskClass: "high",
  dayEnergyMwh: { p10: 120, p50: 480, p90: 1900 },
} as unknown as ForecastDayAhead;

const DIAGNOSIS = {
  attribution: { drivers: [{ code: "export_stress" }] },
} as unknown as DiagnosisDayAhead;

function input(over: Partial<VoiceContextInput> = {}): VoiceContextInput {
  return {
    locale: "pt",
    screen: "overview",
    params: PARAMS,
    serving: NOTHING_PROMOTED,
    ...over,
  };
}

const OBSERVED_ONLY: NetworkState = {
  status: "observedOnly",
  observed: OBSERVED,
  code: "FORECAST_NOT_YET_PUBLISHED",
};

const READ: NetworkState = {
  status: "read",
  observed: OBSERVED,
  forecast: { outlook: {} as never, forecast: FORECAST },
};

const EXPLAINED: ExplainState = {
  status: "explained",
  observed: { reasons: {} as never, card: { status: "card", card: {} as never } },
  day: { forecast: FORECAST, diagnosis: DIAGNOSIS },
};

describe("the context describes the selection", () => {
  test("it names the screen, the subsystem, the fleet, the run and the day", () => {
    const first = contextLines(input())[0];
    expect(first).toContain("Grid Overview");
    expect(first).toContain("NE");
    expect(first).toContain("WIND");
    expect(first).toContain("12Z");
    expect(first).toContain("2026-09-16");
  });

  const screens: VoiceScreen[] = ["overview", "explain", "mitigate", "replay"];
  for (const screen of screens) {
    test(`${screen} is named in the first line`, () => {
      expect(contextLines(input({ screen }))[0].startsWith("The reader is on ")).toBe(
        true,
      );
    });
  }

  test("only the Time Machine states an episode", () => {
    const withEpisode = contextSentence(input({ screen: "replay" }));
    expect(withEpisode).toContain("2026-08-11-ne");
    // Elsewhere the episode is not what the reader is looking at, and a model
    // told about it would offer to replay a day nobody asked about.
    expect(contextSentence(input({ screen: "explain" }))).not.toContain("2026-08-11-ne");
  });

  test("the reader's locale is stated", () => {
    expect(contextSentence(input({ locale: "pt" }))).toContain("Answer in pt-BR.");
    expect(contextSentence(input({ locale: "en" }))).toContain("Answer in en.");
  });

  test("the block is the same grid in both locales", () => {
    // The block is machine-facing, and writing it twice would create a surface
    // on which a Portuguese reader could be told about a different day than an
    // English one.
    const [pt, en] = LOCALES.map((locale) =>
      contextSentence(input({ locale, network: READ })).replace(/Answer in .*$/m, ""),
    );
    expect(pt).toBe(en);
  });
});

describe("with nothing promoted, the absence is stated", () => {
  test("the absence line is present and unambiguous", () => {
    const block = contextSentence(input({ network: OBSERVED_ONLY }));
    expect(block).toContain("NO FORECAST IS AVAILABLE");
    expect(block).toContain("Do not estimate");
    expect(hasForecast(input({ network: OBSERVED_ONLY }))).toBe(false);
  });

  test("it names the clause that refused", () => {
    // `FORECAST_NOT_YET_PUBLISHED` resolves at tonight's gate and
    // `FORECAST_UNAVAILABLE` does not. A reader can act on the difference.
    expect(contextSentence(input({ network: OBSERVED_ONLY }))).toContain(
      "FORECAST_NOT_YET_PUBLISHED",
    );
    const unavailable: NetworkState = { ...OBSERVED_ONLY, code: "FORECAST_UNAVAILABLE" };
    expect(contextSentence(input({ network: unavailable }))).toContain(
      "FORECAST_UNAVAILABLE",
    );
    expect(forecastRefusal(input({ network: unavailable }))).toBe("FORECAST_UNAVAILABLE");
  });

  test("MODEL_UNAVAILABLE on Explain is carried the same way", () => {
    const refused: ExplainState = { status: "refused", code: "MODEL_UNAVAILABLE" };
    expect(contextSentence(input({ screen: "explain", explain: refused }))).toContain(
      "MODEL_UNAVAILABLE",
    );
  });

  test("no band, no risk class and no quantile is stated anywhere", () => {
    const block = contextSentence(input({ network: OBSERVED_ONLY }));
    // The one sentence the whole module exists to make impossible: a P50 in a
    // block with no forecast behind it.
    expect(/P50 \d/.test(block)).toBe(false);
    expect(block).not.toContain("risk high");
  });

  test("the lane state says why, and says the gate is working", () => {
    const block = contextSentence(input({ network: OBSERVED_ONLY }));
    expect(block).toContain("No model is promoted");
    expect(block).toContain("present_unpromoted");
    expect(block).toContain("the gate working");
  });

  test("the settled record survives and is offered as fact", () => {
    const block = contextSentence(input({ network: OBSERVED_ONLY }));
    expect(block).toContain("Observed and settled");
    expect(block).toContain("200 MWh");
    expect(block).toContain("2026-09-14");
  });

  test("an absence is stated even when no read has been attempted", () => {
    // The dock can open before a screen's hooks have answered. Saying nothing
    // about the forecast would let the model assume there is one.
    expect(contextSentence(input())).toContain("NO FORECAST IS AVAILABLE");
    expect(forecastRefusal(input())).toBeUndefined();
  });

  test("a reading serving state claims nothing either way", () => {
    expect(contextSentence(input({ serving: { status: "reading" } }))).toContain(
      "do not claim either way",
    );
  });

  test("an unreachable gateway is stated rather than guessed", () => {
    expect(contextSentence(input({ serving: { status: "unknown" } }))).toContain(
      "did not answer /v1/meta",
    );
  });

  test("an unreachable modelling service is its own sentence", () => {
    const unreachable: ServingState = {
      status: "known",
      lanes: [],
      modelReachable: false,
      serving: false,
    };
    expect(contextSentence(input({ serving: unreachable }))).toContain(
      "could not be reached",
    );
  });
});

describe("with a promoted model, the band is three numbers", () => {
  test("the forecast line carries P10, P50 and P90 together", () => {
    const block = contextSentence(input({ serving: PROMOTED, network: READ }));
    expect(block).toContain("P10 120 MWh");
    expect(block).toContain("P50 480 MWh");
    expect(block).toContain("P90 1900 MWh");
    expect(block).toContain("risk high");
    expect(block).not.toContain("NO FORECAST IS AVAILABLE");
    expect(hasForecast(input({ serving: PROMOTED, network: READ }))).toBe(true);
  });

  test("Explain adds the top driver", () => {
    const block = contextSentence(
      input({ screen: "explain", serving: PROMOTED, explain: EXPLAINED }),
    );
    expect(block).toContain("Top driver: export_stress");
    expect(block).toContain("P50 480 MWh");
  });

  test("the promoted lane count is stated", () => {
    expect(contextSentence(input({ serving: PROMOTED, network: READ }))).toContain(
      "1 of 2 serving lanes is promoted",
    );
  });

  test("bandPhrase never renders a centre alone", () => {
    const phrase = bandPhrase({ p10: 10, p50: 20, p90: 30 });
    expect(phrase).toContain("P10 10");
    expect(phrase).toContain("P50 20");
    expect(phrase).toContain("P90 30");
    // Three numbers or none: a phrase with one quantile in it is the thing the
    // whole product refuses to publish.
    expect(phrase.match(/P\d+/g)?.length).toBe(3);
  });

  test("every forecast line that names a P50 also names P10 and P90", () => {
    for (const state of [READ, OBSERVED_ONLY]) {
      for (const line of contextLines(input({ serving: PROMOTED, network: state }))) {
        if (line.includes("P50")) {
          expect(line).toContain("P10");
          expect(line).toContain("P90");
        }
      }
    }
  });
});

describe("the context issues no request", () => {
  test("it is a pure function of its argument", () => {
    // Called twice with the same input it must produce the same block: anything
    // that fetched, or read a clock, would not.
    expect(contextSentence(input({ network: READ }))).toBe(
      contextSentence(input({ network: READ })),
    );
  });

  test("the module names no endpoint it could call", () => {
    // `use-serving.ts` records what a second read of the same question costs:
    // the badge and the panel answering differently across a promotion. The
    // context builder taking already-fetched state is how that is prevented,
    // and the absence of an `api.` call is the mechanical form of it.
    const source = Bun.file(
      new URL("../src/lib/voice/context.ts", import.meta.url).pathname,
    );
    const text = source.text();
    return text.then((body) => {
      expect(body).not.toContain("api.");
      expect(body).not.toContain("fetch(");
    });
  });
});
