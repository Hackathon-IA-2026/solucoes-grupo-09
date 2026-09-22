import { describe, expect, it } from "bun:test";
import { explain, validate } from "@wattsteer/core/schema";
import {
  GRID_CONTEXT,
  REPLAY_ATTRIBUTION,
  REPLAY_COMPARE,
  REPLAY_TIMELINE,
  SIMILAR_DAYS,
} from "../e2e/time-machine-fixtures";

/**
 * The e2e stubs behind the Time Machine dashboard's browser runs, held to the
 * contract. A stub the gateway could never send would make every screenshot
 * and every assertion over it a picture of a screen that cannot exist.
 */
describe("the dashboard's e2e stubs are shapes the gateway can send", () => {
  for (const [schema, body] of [
    ["replay-compare.schema.json", REPLAY_COMPARE],
    ["replay-timeline.schema.json", REPLAY_TIMELINE],
    ["replay-attribution.schema.json", REPLAY_ATTRIBUTION],
    ["similar-days.schema.json", SIMILAR_DAYS],
    ["grid-context.schema.json", GRID_CONTEXT],
  ] as const) {
    it(`${schema} accepts its stub`, () => {
      const result = validate(schema, body);
      expect(result.valid ? "" : explain(result)).toBe("");
    });
  }

  it("the national band is not four P50s added", () => {
    const sum = REPLAY_COMPARE.subsystems.reduce(
      (total, row) =>
        total + ((row as { day_total?: { p50: number } }).day_total?.p50 ?? 0),
      0,
    );
    expect(REPLAY_COMPARE.national.day_total?.p50).not.toBe(sum);
  });
});
