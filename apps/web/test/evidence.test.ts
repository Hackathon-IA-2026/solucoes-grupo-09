/**
 * What a card may say about a retrieved passage, and the records it refuses.
 *
 * The service returns an audit: a verdict, a trace, several claims and every
 * citation behind them. A card has room for one line, so this narrows — and
 * the interesting part is which records produce no line at all.
 */

import { describe, expect, it } from "bun:test";
import { firstCitation } from "../src/lib/evidence";

const CITATION = {
  external_id: "IO-ON.NE.5NE",
  revision: "Rev.61",
  title: "IO-ON.NE.5NE - Operação Normal da Área 500 kV da Região Nordeste",
  url: "https://www.ons.org.br/MPO/…/IO-ON.NE.5NE_Rev.61.pdf",
  locator: { page: 12, row: null, table: null, section: "5.2" },
};

const FOUND = [{ verdict: "found", payload: { items: [{ citations: [CITATION] }] } }];

describe("what a card states", () => {
  it("the document, its revision and its page", () => {
    const citation = firstCitation(FOUND);
    expect(citation?.documentCode).toBe("IO-ON.NE.5NE");
    expect(citation?.revision).toBe("Rev.61");
    expect(citation?.page).toBe(12);
  });

  it("the first citation, not a re-ranked one", () => {
    // The service ranks them. A client that picked differently would be
    // forming a second opinion about evidence it did not retrieve.
    const citation = firstCitation([
      {
        verdict: "found",
        payload: {
          items: [
            { citations: [CITATION, { ...CITATION, external_id: "IO-ON.NE.2LE" }] },
          ],
        },
      },
    ]);
    expect(citation?.documentCode).toBe("IO-ON.NE.5NE");
  });
});

describe("the records that produce no line", () => {
  it("`insufficient` is not an answer, whatever it carries", () => {
    /*
      The service has three outcomes and only one is an answer. `insufficient`
      means the gates rejected every claim — printing its citations anyway
      would show the passages a rule had just decided do not support the claim,
      which is worse than showing nothing.
    */
    expect(
      firstCitation([
        { verdict: "insufficient", payload: { items: [{ citations: [CITATION] }] } },
      ]),
    ).toBeNull();
  });

  it("`not_found` produces nothing", () => {
    expect(firstCitation([{ verdict: "not_found", payload: { items: [] } }])).toBeNull();
  });

  it("a citation with no document code is not a citation", () => {
    // A quote whose source cannot be named is a quote nobody can check, which
    // is the one thing the corpus exists to prevent.
    expect(
      firstCitation([
        {
          verdict: "found",
          payload: { items: [{ citations: [{ ...CITATION, external_id: null }] }] },
        },
      ]),
    ).toBeNull();
  });

  it("and it skips a bad row to reach a good one", () => {
    // Non-vacuity for the rule above: a refusal must not swallow the record
    // after it.
    const citation = firstCitation([
      { verdict: "insufficient", payload: { items: [] } },
      ...FOUND,
    ]);
    expect(citation?.documentCode).toBe("IO-ON.NE.5NE");
  });
});

describe("shapes that are not the shape", () => {
  it("survives an empty list, a null and a wrong type", () => {
    // It reads another service's payload across a network. A client that threw
    // on an unexpected body would take the dashboard down for an annotation.
    expect(firstCitation([])).toBeNull();
    expect(firstCitation(null)).toBeNull();
    expect(firstCitation("rows")).toBeNull();
    expect(firstCitation([{ verdict: "found" }])).toBeNull();
  });

  it("an HTML source with no page still cites", () => {
    // BDO is a table, not a PDF: no pagination, and the document is still the
    // answer. A missing page must not discard the citation.
    const citation = firstCitation([
      {
        verdict: "found",
        payload: {
          items: [{ citations: [{ ...CITATION, locator: { page: null } }] }],
        },
      },
    ]);
    expect(citation?.page).toBeNull();
    expect(citation?.documentCode).toBe("IO-ON.NE.5NE");
  });
});
