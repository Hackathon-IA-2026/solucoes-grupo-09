import { describe, expect, it } from "bun:test";
import type { FiredRule } from "../src/diagnosis/index.js";
import { narrationDecision, renderNarration } from "../src/diagnosis/index.js";

/**
 * The half of the one-way valve that is not a column.
 *
 * `docs/specs/diagnosis.md` seam 8: *"a `withhold` rule means the LLM is never
 * called (assert the client is not invoked, not merely that its output is
 * discarded)"*. That distinction is the whole test file. A gate that called the
 * model and threw the paragraph away would pass every assertion about the
 * response body and would still be wrong — it would spend the call, warm the
 * cache with a narration nobody may read, and leave "withheld" meaning nothing
 * at the only layer where it means something.
 *
 * The other assertion here is the one `api-surface.md` had to be corrected for:
 * **withholding acts on the narration and never on the attribution.** The gate
 * is not handed the drivers at all, so a withheld response cannot come back
 * with `drivers: []` however the route is later assembled.
 */

function flag(code: string, action: FiredRule["action"]): FiredRule {
  return { code, action, facts: {} };
}

describe("the narration gate · what `withhold` does and does not do", () => {
  it("never invokes the language model when a rule withheld", async () => {
    let invoked = 0;
    const rendered = await renderNarration(
      [flag("stale_inputs", "annotate"), flag("attribution_is_noise", "withhold")],
      {
        model: async () => {
          invoked += 1;
          return "the model's paragraph";
        },
        template: () => "the template's paragraph",
      },
    );

    // Not "the model's output was discarded" — the client was not called.
    expect(invoked).toBe(0);
    expect(rendered.source).toBe("template");
    expect(rendered.narration).toBe("the template's paragraph");
    expect(rendered.withheldBy).toEqual(["attribution_is_noise"]);
  });

  it("calls the model when nothing withheld, annotations included", async () => {
    let invoked = 0;
    const rendered = await renderNarration(
      [flag("stale_inputs", "annotate"), flag("fixture_demote", "demote")],
      {
        model: async () => {
          invoked += 1;
          return "the model's paragraph";
        },
        template: () => "the template's paragraph",
      },
    );

    // `annotate` and `demote` shape what is said; only `withhold` silences it.
    expect(invoked).toBe(1);
    expect(rendered.source).toBe("model");
    expect(rendered.withheldBy).toEqual([]);
  });

  it("names every rule that withheld, in the order they fired", () => {
    const decision = narrationDecision([
      flag("nothing_to_explain", "withhold"),
      flag("stale_inputs", "annotate"),
      flag("attribution_is_noise", "withhold"),
    ]);

    expect(decision.source).toBe("template");
    expect(decision.withheldBy).toEqual(["nothing_to_explain", "attribution_is_noise"]);
  });

  it("decides nothing when no rule fired", () => {
    expect(narrationDecision([])).toEqual({ source: "model", withheldBy: [] });
  });

  it("cannot touch the ranking, because it is never given one", () => {
    // The structural half: the gate's whole input is the fired rules. There is
    // no drivers parameter for a later edit to reach for, so the corrected
    // contract — a 200 with the drivers untouched — cannot regress into
    // `drivers: []` inside this module.
    expect(narrationDecision.length).toBe(1);
    expect(renderNarration.length).toBe(2);
    const source = narrationDecision.toString() + renderNarration.toString();
    for (const forbidden of ["drivers", "phiMwh", "share", "demoted"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
