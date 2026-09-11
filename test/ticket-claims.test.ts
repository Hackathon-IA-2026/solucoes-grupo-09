/**
 * A ticket's stated count of open boxes is derived from its own boxes.
 *
 * api-surface 29. The reasoning, the surveyed shapes and the out-of-scope list
 * are in `ticket-claims.ts`; this file is the polarity — that the binders bind
 * something, that a drifted count goes red, that an empty parse cannot pass,
 * and that a `done` ticket with all its boxes unticked is *not* a violation.
 */

import { describe, expect, test } from "bun:test";
import {
  BINDERS,
  type BoxClaim,
  boxCountClaims,
  describeBoxClaim,
  driftedBoxClaims,
  liveBoxClaims,
  type Ticket,
  tickets,
} from "./ticket-claims";

const ALL = tickets();
const CLAIMS = boxCountClaims(ALL);
const LIVE = liveBoxClaims(CLAIMS);

/** A ticket whose text is `text` and whose path is a label. */
function synthetic(file: string, text: string): Ticket {
  const open = (text.match(/^[ \t]*- \[ \]/gm) ?? []).length;
  return {
    file,
    text,
    open,
    ticked: (text.match(/^[ \t]*- \[[xX]\]/gm) ?? []).length,
    status: /^\*\*Status:\*\*[ \t]*(.*)$/m.exec(text)?.[1]?.trim() ?? "",
  };
}

describe("the corpus is discovered by shape, not by a list", () => {
  test("every lane's tickets are walked", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(100);
    const lanes = new Set(ALL.map((one) => one.file.split("/")[1]));
    expect(lanes.size).toBeGreaterThanOrEqual(8);
  });

  test("a ticket is a file with a **Status:** line, and nothing else is", () => {
    for (const ticket of ALL) {
      expect(ticket.status.length).toBeGreaterThan(0);
      expect(ticket.file.endsWith("00-README.md")).toBe(false);
    }
  });

  test("a ticket written today is covered without an edit here", () => {
    // The registry-free property, asserted rather than asserted-about: a file
    // this suite has never seen is bound the moment it exists. This is the
    // shape `.scratch/data-platform/issues/21-*` arrived in mid-wave.
    const fresh = synthetic(
      ".scratch/nowhere/issues/99-written-today.md",
      "# 99 — written today\n\n**Status:** done (**four boxes open** — see below)\n\n- [ ] a\n- [ ] b\n",
    );
    const claims = boxCountClaims([fresh]);
    expect(claims.length).toBe(1);
    expect(driftedBoxClaims(claims).map(describeBoxClaim)).toEqual([
      ".scratch/nowhere/issues/99-written-today.md:3 — N boxes open states 4, derived 2 — “**four boxes open”",
    ]);
  });
});

describe("the binders bind something", () => {
  test("the corpus states counts, and they are found", () => {
    expect(CLAIMS.length).toBeGreaterThanOrEqual(4);
    // The vacuity floor. Not a restatement of a count — a floor, and the point
    // of it is the marker vocabulary: a retrospective phrase broad enough to
    // start excusing live claims drops this below three and fails here rather
    // than passing quietly, which is api-surface 27's lesson applied to itself.
    expect(LIVE.length).toBeGreaterThanOrEqual(3);
    expect(new Set(LIVE.map((one) => one.binder)).size).toBeGreaterThanOrEqual(2);
  });

  test("every stated number parsed as a number", () => {
    // The patterns spell the numeral rather than capturing a word, so a bound
    // claim with no number would mean a binder had matched prose it does not
    // understand.
    expect(CLAIMS.filter((one) => one.stated === null)).toEqual([]);
  });

  test("corrections are recognised, and they are quotations rather than claims", () => {
    // Non-empty in the other direction: these tickets do quote their own wrong
    // numbers back, and a marker vocabulary that recognised none of them would
    // make every correction note a failure.
    expect(CLAIMS.filter((one) => one.quotation).length).toBeGreaterThanOrEqual(1);
  });

  test("a status line that states a count produces a live claim from that line", () => {
    // Derived coverage, so nobody has to remember to register the shape the
    // defect actually took: `**Status:** done (**two boxes open** …)`.
    //
    // The trigger is a *count* of boxes, not the word. `**Status:** decided,
    // nothing promoted, no threshold moved, the box stays open` states no
    // number — and the box it names belongs to another ticket, which
    // api-surface 29 put out of scope on purpose. Demanding a claim there
    // would fail a truthful status and push whoever writes the next one into
    // inventing a count to satisfy the guard, which is the disease rather
    // than the cure.
    const STATES_A_BOX_COUNT =
      /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|no|zero)\s+(?:more\s+)?box(?:es)?\b/i;
    for (const ticket of ALL) {
      if (!STATES_A_BOX_COUNT.test(ticket.status)) {
        continue;
      }
      const onStatusLine = LIVE.filter(
        (claim) => claim.file === ticket.file && ticket.status.includes(claim.quoted),
      );
      expect(onStatusLine.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("the count trigger reads a number, not the word box", () => {
    // Both halves, because a trigger that matched nothing would make the test
    // above pass by skipping every ticket.
    const TRIGGER =
      /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|no|zero)\s+(?:more\s+)?box(?:es)?\b/i;
    for (const counted of [
      "done (**one box open** — see below)",
      "done (**two boxes open**)",
      "done, three boxes open",
      "done — no boxes open",
    ]) {
      expect({ counted, fires: TRIGGER.test(counted) }).toEqual({ counted, fires: true });
    }
    for (const uncounted of [
      "decided, nothing promoted, no threshold moved, the box stays open",
      "done",
      "done — measured, and closed without a change",
      "landed (first half; the three card fields are not this ticket)",
    ]) {
      expect({ uncounted, fires: TRIGGER.test(uncounted) }).toEqual({
        uncounted,
        fires: false,
      });
    }
    // And it is live on the corpus rather than a rule about nothing: at least
    // one real ticket states a box count today.
    expect(ALL.filter((one) => TRIGGER.test(one.status)).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  test("a still-open section that leads with a count produces a live claim", () => {
    for (const ticket of ALL) {
      const lead = /^#{1,6}\s+[^\n]*still\s+open[^\n]*\n+(\*\*[^\n]*)/im.exec(
        ticket.text,
      );
      if (lead === null) {
        continue;
      }
      if (!/\*\*\s*\w+\s+box/i.test(lead[1] ?? "")) {
        continue;
      }
      const inSection = LIVE.filter(
        (claim) =>
          claim.file === ticket.file &&
          claim.binder === "N boxes, under a still-open heading",
      );
      expect(inSection.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("a ticket's stated count of open boxes is its own count of open boxes", () => {
  test("no live count disagrees with the file's `- [ ]` lines", () => {
    expect(driftedBoxClaims(CLAIMS).map(describeBoxClaim)).toEqual([]);
  });
});

describe("unticked boxes are not a signal of open work, and this guard says nothing about them", () => {
  const doneWithNothingTicked = ALL.filter(
    (one) => /^done\b/i.test(one.status) && one.ticked === 0 && one.open > 0,
  );

  test("that population is most of the repository", () => {
    // If this ever went empty the test below would be vacuous, which is the
    // one way this guard could become the thing it was written not to be.
    expect(doneWithNothingTicked.length).toBeGreaterThanOrEqual(80);
  });

  test("not one of them yields a claim, let alone a violation", () => {
    const claims = boxCountClaims(doneWithNothingTicked);
    expect(claims.map(describeBoxClaim)).toEqual([]);
  });

  test("a `done` ticket with five unticked boxes and no prose count is clean", () => {
    // forecaster 28's shape, found by shape rather than by name.
    const shaped = doneWithNothingTicked.filter((one) => one.open === 5);
    expect(shaped.length).toBeGreaterThanOrEqual(1);
    expect(boxCountClaims(shaped)).toEqual([]);
  });

  test("`done` is not read as “zero boxes open”", () => {
    const plainDone = synthetic(
      ".scratch/nowhere/issues/98-done-and-unticked.md",
      "**Status:** done\n\n- [ ] a\n- [ ] b\n- [ ] c\n",
    );
    expect(plainDone.open).toBe(3);
    expect(boxCountClaims([plainDone])).toEqual([]);
  });

  test("the prose shapes that are not self-counts stay out", () => {
    // Real sentences from the corpus, in the shapes named out of scope: a
    // count of another ticket's boxes, a delta, and “boxes” that are tiles on
    // a screen rather than checkboxes.
    const decoys = synthetic(
      ".scratch/nowhere/issues/97-decoys.md",
      [
        "**Status:** done",
        "",
        "So the last three boxes were ticked on arrival.",
        "",
        "Four of those six are now closed, and exactly one box moved.",
        "",
        "One headline for absorbed / recovered / avoided, because three boxes",
        "would imply three facts.",
        "",
        "- [ ] a",
      ].join("\n"),
    );
    expect(boxCountClaims([decoys])).toEqual([]);
  });
});

describe("the guard fails on drift", () => {
  const TICKET = ALL.find((one) => one.file.endsWith("10-forecast-publication.md"));

  /** The same ticket with one substitution, so the mutation is the only change. */
  function mutated(from: string, to: string): BoxClaim[] {
    expect(TICKET).toBeDefined();
    const text = (TICKET as Ticket).text;
    expect(text).toContain(from);
    return driftedBoxClaims(
      boxCountClaims([synthetic((TICKET as Ticket).file, text.replace(from, to))]),
    );
  }

  test("the status line's count moved", () => {
    const drifted = mutated("(**one box open**", "(**three boxes open**");
    expect(drifted.length).toBeGreaterThanOrEqual(1);
    expect(drifted[0]?.stated).toBe(3);
    expect(drifted[0]?.derived).toBe(1);
  });

  test("the still-open section's lead count moved", () => {
    const drifted = mutated(
      "**One box, and it is not a judgement call.**",
      "**Two boxes, and neither is one.**",
    );
    expect(drifted.map((one) => one.binder)).toContain(
      "N boxes, under a still-open heading",
    );
  });

  test("the re-grep note's count moved", () => {
    const drifted = mutated("in this file returns\none,", "in this file returns\nfive,");
    expect(drifted.map((one) => one.stated)).toContain(5);
  });

  test("the boxes moved and the prose did not — the wave's actual defect", () => {
    // Nothing in the prose is touched. A box is closed, exactly as three
    // agents did on three branches in one wave, and every count in the file
    // that was true becomes false.
    const text = (TICKET as Ticket).text;
    const closed = text.replace(
      "- [ ] The end-to-end job is exercised against real Postgres",
      "- [x] The end-to-end job is exercised against real Postgres",
    );
    expect(closed).not.toBe(text);
    const drifted = driftedBoxClaims(
      boxCountClaims([synthetic((TICKET as Ticket).file, closed)]),
    );
    expect(drifted.length).toBeGreaterThanOrEqual(3);
    for (const claim of drifted) {
      expect(claim.derived).toBe(0);
      expect(claim.stated).toBe(1);
    }
  });

  test("a box added below the prose that counts them", () => {
    const drifted = driftedBoxClaims(
      boxCountClaims([
        synthetic(
          (TICKET as Ticket).file,
          `${(TICKET as Ticket).text}\n- [ ] a box somebody appended\n`,
        ),
      ]),
    );
    expect(drifted.length).toBeGreaterThanOrEqual(3);
    expect(drifted.every((one) => one.derived === 2)).toBe(true);
  });
});

describe("the guard is not vacuous: an empty parse does not pass", () => {
  test("an empty corpus fails the non-emptiness assertions rather than the drift one", () => {
    // The polarity that has bitten this repository four times. With no tickets
    // there is nothing to drift, so `driftedBoxClaims` is empty and *looks*
    // green; what must go red is the assertion above it.
    const none = boxCountClaims([]);
    expect(none).toEqual([]);
    expect(driftedBoxClaims(none)).toEqual([]);
    expect(() => expect(none.length).toBeGreaterThanOrEqual(4)).toThrow();
    expect(() => expect(liveBoxClaims(none).length).toBeGreaterThanOrEqual(3)).toThrow();
  });

  test("a corpus with no boxes at all still fails the floor", () => {
    const boxless = synthetic(
      ".scratch/nowhere/issues/96-prose-only.md",
      "**Status:** done\n\nNo checklist at all.\n",
    );
    expect(() =>
      expect(boxCountClaims([boxless]).length).toBeGreaterThanOrEqual(4),
    ).toThrow();
  });

  test("a binder whose pattern stops matching fails the floor", () => {
    // Every binder broken at once — the state a refactor of the prose, or of
    // the regexes, could arrive at silently.
    const broken = BINDERS.map((binder) => ({
      ...binder,
      pattern: /\bxyzzy-no-such-token-(\d+)\b/i,
    }));
    expect(broken.length).toBeGreaterThanOrEqual(6);
    const claims = boxCountClaims(ALL, broken);
    expect(claims).toEqual([]);
    expect(() => expect(claims.length).toBeGreaterThanOrEqual(4)).toThrow();
  });

  test("a marker vocabulary broad enough to excuse every claim fails the floor", () => {
    // The other direction of vacuity, and the one 27 caught in itself: if
    // exemption grew until nothing was live, the drift assertion would pass
    // over a corpus it had stopped governing.
    const everythingQuoted = CLAIMS.map((claim) => ({ ...claim, quotation: true }));
    expect(driftedBoxClaims(everythingQuoted)).toEqual([]);
    expect(() =>
      expect(liveBoxClaims(everythingQuoted).length).toBeGreaterThanOrEqual(3),
    ).toThrow();
  });

  test("the exempt half is measured, not trusted", () => {
    // Reported rather than bounded by a ratio: unlike the specs' 135 path
    // references, the bound claims here are concentrated in the one ticket
    // that narrates three revisions of its own count, so a majority of them
    // being quotations is the honest state of that file and not a leak. The
    // floor on live claims above is what keeps the exemption from growing.
    const quoted = CLAIMS.filter((one) => one.quotation);
    expect(quoted.length).toBeLessThan(CLAIMS.length);
    expect(quoted.length).toBeGreaterThan(0);
  });
});
