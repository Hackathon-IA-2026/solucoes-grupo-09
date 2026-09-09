import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  asErrorStatus,
  ERROR_CODES,
  ERROR_STATUS,
  errorCopyKey,
  isErrorCode,
  LANE_STATES,
  NO_FORECAST_STATES,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "../src/errors";
import { ERROR_CODES as FROM_ROOT } from "../src/index";

/**
 * The enum is only closed if there is one of it.
 *
 * The gateway imports `@wattsteer/core/errors` and the web app imports the
 * package root; both have to be the same list, or "closed" means "closed in
 * two places that can drift". That is what the first test is for — the rest
 * pin the properties the two ticket decisions turn on.
 */
describe("the published error contract", () => {
  it("is one list, whichever entry point reads it", () => {
    expect(FROM_ROOT).toEqual(ERROR_CODES);
    expect(ERROR_CODES.length).toBe(Object.keys(ERROR_STATUS).length);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("gives every code a status this API can actually answer with", () => {
    const unanswerable = ERROR_CODES.filter(
      (code) => asErrorStatus(ERROR_STATUS[code]) === null,
    );
    expect(unanswerable).toEqual([]);
  });

  it("carries the statuses the surface needed adding: 404, 413, 422, 429", () => {
    const statuses = new Set(ERROR_CODES.map((code) => ERROR_STATUS[code]));
    for (const status of [404, 413, 422, 429]) {
      expect(statuses.has(status as 404)).toBe(true);
    }
  });

  it("builds the translation key a client renders, never the message", () => {
    expect(errorCopyKey("RATE_LIMITED")).toBe("error.RATE_LIMITED");
    expect(ERROR_CODES.every((code) => errorCopyKey(code).startsWith("error."))).toBe(
      true,
    );
  });

  it("recognises a code and refuses one it has no room for", () => {
    expect(isErrorCode("MODEL_UNAVAILABLE")).toBe(true);
    expect(isErrorCode("MODEL_SLIGHTLY_OFF")).toBe(false);
  });
});

describe("the four 'no forecast' states", () => {
  it("is four, and the codes among them are members of the enum", () => {
    expect(NO_FORECAST_STATES).toHaveLength(4);
    for (const state of NO_FORECAST_STATES) {
      if (state.code !== null) {
        expect(isErrorCode(state.code)).toBe(true);
        expect(ERROR_STATUS[state.code]).toBe(state.status);
      }
    }
  });

  it("keeps 'stale' outside the enum, because it is a 200", () => {
    const stale = NO_FORECAST_STATES.filter((s) => s.code === null);
    expect(stale.map((s) => s.state)).toEqual(["stale"]);
    expect(stale[0]?.status).toBe(200);
  });

  it("names the lane states MODEL_UNAVAILABLE distinguishes, and not `promoted`", () => {
    expect(LANE_STATES).toEqual(["no_artifact", "present_unpromoted", "unresolvable"]);
    // The forecaster has a fourth, `promoted`. It is deliberately absent: a lane
    // with a promoted artifact has something to serve and never reaches this
    // envelope. These three are all reasons a request found nothing.
    expect(LANE_STATES).not.toContain("promoted");
  });

  it("says, where it is defined, that it is not the only `lane_state`", () => {
    // The defect this vocabulary carried was legibility, not membership.
    // `/v1/meta` reports a four-member *condition* vocabulary under the same
    // field name and legitimately disagrees with a `/v1/model/card` 503 about
    // one lane at one moment, and nothing here said so — leaving a reader
    // comparing two endpoints to conclude one of them is broken. The prose is
    // the fix, so it is asserted rather than trusted to survive an edit.
    const source = readFileSync(new URL("../src/errors.ts", import.meta.url), "utf-8");
    const doc = source.slice(0, source.indexOf("export const LANE_STATES"));
    const comment = doc.slice(doc.lastIndexOf("/**"));
    // Which vocabulary this is, and where the other one lives.
    expect(comment).toContain("error-envelope vocabulary");
    expect(comment).toContain("LaneCondition");
    expect(comment).toContain("artifacts.py");
    // And that `unresolvable` never travels without the key naming the repair,
    // since four conditions produce it and they are fixed four ways.
    expect(comment).toContain("contract_fault");
    expect(comment).toContain("card_error");
  });
});

describe("locale resolution", () => {
  it("matches the primary subtag, so the gateway can serve its own client", () => {
    // `apps/web`'s languageTag emits "pt-BR" and plain "en".
    expect(resolveLocale("pt-BR")).toBe("pt-BR");
    expect(resolveLocale("en")).toBe("en-US");
    // And anything else Portuguese or English resolves too.
    expect(resolveLocale("pt")).toBe("pt-BR");
    expect(resolveLocale("en-GB")).toBe("en-US");
  });

  it("resolves only into the published set", () => {
    for (const tag of ["pt", "pt-BR", "en", "en-US", "en-AU"]) {
      const resolved = resolveLocale(tag);
      expect(resolved === null || SUPPORTED_LOCALES.includes(resolved)).toBe(true);
    }
  });

  it("refuses a third language — that is LOCALE_UNSUPPORTED, and 422", () => {
    expect(resolveLocale("fr-CA")).toBeNull();
    expect(ERROR_STATUS.LOCALE_UNSUPPORTED).toBe(422);
  });
});
