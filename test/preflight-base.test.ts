import { describe, expect, it } from "bun:test";
import { type BaseFacts, evaluateBase, explain } from "../scripts/preflight-base";

/**
 * The preflight guard decides whether a worktree is a legitimate place to start
 * a ticket. Its whole value is that it refuses, so the tests that matter are
 * the ones proving it *can* refuse — a base check that always passes is worse
 * than no base check, because it converts an invisible problem into an
 * invisible problem with a green tick beside it.
 *
 * `evaluateBase` is pure over five facts precisely so that every refusal below
 * is reachable without a network, a remote or a second clone.
 */

const TIP = "a".repeat(40);
const OLDER = "b".repeat(40);
const AHEAD = "c".repeat(40);

/** A worktree sitting exactly on the tip: the ordinary, healthy case. */
function onTip(overrides: Partial<BaseFacts> = {}): BaseFacts {
  return {
    headSha: TIP,
    originMainSha: TIP,
    mergeBaseSha: TIP,
    behind: 0,
    fetched: true,
    ...overrides,
  };
}

describe("preflight: the base of new work contains origin/main", () => {
  it("accepts a worktree sitting on the tip", () => {
    expect(evaluateBase(onTip())).toEqual({ ok: true, reason: "contains-origin-main" });
  });

  it("accepts a ticket branch already carrying commits on top of the tip", () => {
    // The merge base is still origin/main, which is the actual property being
    // asserted — not equality with HEAD. Requiring HEAD === origin/main would
    // refuse every ticket branch after its first commit and the guard would be
    // turned off within a day.
    const verdict = evaluateBase(onTip({ headSha: AHEAD, mergeBaseSha: TIP, behind: 0 }));
    expect(verdict).toEqual({ ok: true, reason: "contains-origin-main" });
  });

  it("refuses a base behind the tip, which is the case it exists for", () => {
    // origin/main has moved on and HEAD does not contain it: the merge base is
    // the older commit, not origin/main.
    const verdict = evaluateBase(
      onTip({ headSha: OLDER, originMainSha: TIP, mergeBaseSha: OLDER, behind: 143 }),
    );
    expect(verdict).toEqual({ ok: false, reason: "base-behind-tip" });
  });
});

describe("preflight: it fails closed", () => {
  it("refuses when the remote could not be fetched", () => {
    // Otherwise the comparison silently runs against whatever origin/main was
    // last time anyone fetched, which is the stale read the guard prevents.
    // Note the facts here are *otherwise perfect* — on the tip, zero behind —
    // so this asserts the fetch flag alone is decisive.
    expect(evaluateBase(onTip({ fetched: false }))).toEqual({
      ok: false,
      reason: "fetch-failed",
    });
  });

  it("refuses when a ref could not be read, rather than comparing empty strings", () => {
    // The vacuity trap this repository keeps falling into. A failed `rev-parse`
    // yields "", and "" === "" is true, so the unguarded shape of this function
    // reports its healthiest verdict at the moment it has read nothing at all.
    const blind: BaseFacts = {
      headSha: "",
      originMainSha: "",
      mergeBaseSha: "",
      behind: -1,
      fetched: true,
    };
    expect(evaluateBase(blind)).toEqual({ ok: false, reason: "unreadable-ref" });

    // And one unreadable ref among two good ones is still a refusal.
    for (const field of ["headSha", "originMainSha", "mergeBaseSha"] as const) {
      expect({ field, verdict: evaluateBase(onTip({ [field]: "" })) }).toEqual({
        field,
        verdict: { ok: false, reason: "unreadable-ref" },
      });
    }
  });

  it("refuses an abbreviated or malformed object name", () => {
    // A seven-character sha compared against a forty-character one is never
    // equal, so accepting short names would make the guard refuse at random.
    // Rejecting them outright turns that into one legible failure.
    for (const bad of ["076e4f3", "not-a-sha", "A".repeat(40), "a".repeat(39)]) {
      expect({ bad, verdict: evaluateBase(onTip({ mergeBaseSha: bad })) }).toEqual({
        bad,
        verdict: { ok: false, reason: "unreadable-ref" },
      });
    }
  });
});

describe("preflight: every verdict explains itself", () => {
  it("names a remedy for each refusal and never returns an empty message", () => {
    // A refusal nobody can act on gets bypassed. Each message must say what to
    // do next, so the guard is cheaper to satisfy than to disable.
    const cases: BaseFacts[] = [
      onTip(),
      onTip({ fetched: false }),
      onTip({ mergeBaseSha: "" }),
      onTip({ headSha: OLDER, mergeBaseSha: OLDER, behind: 143 }),
    ];
    const reasons = new Set<string>();
    for (const facts of cases) {
      const verdict = evaluateBase(facts);
      const message = explain(facts, verdict);
      reasons.add(verdict.reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("unrecognised verdict");
    }
    // All four verdicts were actually exercised — otherwise the loop above
    // could pass having explained one case four times.
    expect([...reasons].sort()).toEqual([
      "base-behind-tip",
      "contains-origin-main",
      "fetch-failed",
      "unreadable-ref",
    ]);
  });

  it("tells a stale base how far behind it is and how to fix it", () => {
    const facts = onTip({ headSha: OLDER, mergeBaseSha: OLDER, behind: 143 });
    const message = explain(facts, evaluateBase(facts));
    expect(message).toContain("143");
    expect(message).toContain("git rebase origin/main");
  });
});
