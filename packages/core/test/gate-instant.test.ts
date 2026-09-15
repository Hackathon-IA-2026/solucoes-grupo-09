import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// The API's implementation, imported straight from the other workspace so the
// vectors exercise the shipping code and not a copy of it — the same move
// `canonical-contract.test.ts` makes, and the reason
// `apps/api/src/forecast/gate.ts` imports nothing but this package and a type.
import { gateAt } from "../../../apps/api/src/forecast/gate.js";
import { GATES, localWallClock } from "../src/schedule.js";

/**
 * Parity of the gate instant across the three places it is written.
 *
 * `apps/ml/tests/test_gate_instant_vectors.py` reads the **same** directory and
 * asserts the **same** values against the Python spelling and — under a real
 * Postgres — against `gate_at(target_date, gate_profile)` itself. No side is
 * ever compared against another, only against the vectors, so a shared
 * misunderstanding cannot cancel out. See
 * `packages/core/fixtures/gate-instant/README.md`.
 *
 * `schedule.test.ts` already asserts that the migration's *text* contains the
 * hours this table names. That is a check on two spellings of an integer; this
 * one is a check on the instant they resolve to, which is the thing a zone read
 * as a fixed `-03:00` gets wrong while passing the other.
 */

const FIXTURES = join(import.meta.dir, "..", "fixtures", "gate-instant");

interface GateVector {
  name: string;
  why: string;
  target_date: string;
  gate_profile: "gate_early" | "gate_late";
  expected_local_date: string;
  expected_local_time: string;
  expected_utc_offset_minutes: number;
  expected_gate_at: string;
}

const vectors: Array<{ file: string; body: GateVector }> = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    body: JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as GateVector,
  }));

describe("the gate instant, vector by vector", () => {
  it("the directory is not empty, so a passing run means something", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  it("no vector file is skipped", () => {
    // The half that stops a vector added for the Python or SQL side being
    // ignored here. The listing above is flat, so the comparison is against a
    // *recursive* walk: a vector filed under a subdirectory would otherwise be
    // read by neither language and by no one's count.
    const consumed = new Set(vectors.map((vector) => vector.file));
    const onDisk = new Set(
      readdirSync(FIXTURES, { recursive: true, encoding: "utf8" }).filter((entry) =>
        entry.endsWith(".json"),
      ),
    );
    expect([...onDisk].sort()).toEqual([...consumed].sort());
  });

  for (const { file, body } of vectors) {
    describe(`${file}: ${body.name}`, () => {
      it("the gateway's gateAt resolves the expected instant", () => {
        expect(gateAt(body.target_date, body.gate_profile).toISOString()).toBe(
          body.expected_gate_at,
        );
      });

      it("the published gate table names the expected local hour", () => {
        // The half a wrong instant cannot distinguish from a wrong zone: if
        // this fails, the table moved; if only the assertion above fails, the
        // zone did.
        const gate = GATES.find((candidate) => candidate.profile === body.gate_profile);
        expect(gate?.publishesAtLocal).toBe(body.expected_local_time);
      });

      it("that hour on the expected local date is the expected instant", () => {
        // The zone, on its own. `localWallClock` is given the D−1 date the
        // vector states rather than deriving it, so this assertion fails only
        // when the offset is wrong.
        expect(
          localWallClock(
            body.expected_local_date,
            body.expected_local_time,
          ).toISOString(),
        ).toBe(body.expected_gate_at);
      });

      it("the offset between the wall clock and the instant is the expected one", () => {
        const naive = Date.parse(
          `${body.expected_local_date}T${body.expected_local_time}:00Z`,
        );
        const instant = Date.parse(body.expected_gate_at);
        expect((naive - instant) / 60_000).toBe(body.expected_utc_offset_minutes);
      });
    });
  }
});

describe("the test of the test", () => {
  it("a gate read as a fixed −03:00 fails the summer-time vectors", () => {
    // The deliberately broken implementation, written out here so the suite
    // proves something: subtracting three hours from the wall clock is right
    // on every date the product serves and wrong on the vectors that exist for
    // exactly that reason. If this ever stops finding a disagreement, the
    // summer-time cases have been deleted and the suite is asserting nothing
    // about the zone at all.
    const fixedOffset = (date: string, time: string): string =>
      new Date(Date.parse(`${date}T${time}:00Z`) + 3 * 3_600_000).toISOString();

    const disagreements = vectors.filter(
      ({ body }) =>
        fixedOffset(body.expected_local_date, body.expected_local_time) !==
        body.expected_gate_at,
    );
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it("the two profiles do not resolve to the same instant", () => {
    // A profile switch read as a label rather than an hour would make the 00Z
    // lane claim the 12Z run's inputs, and every per-vector assertion above
    // would still pass if both hours were the same.
    expect(gateAt("2026-08-29", "gate_early").getTime()).not.toBe(
      gateAt("2026-08-29", "gate_late").getTime(),
    );
  });
});
