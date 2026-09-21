/**
 * `POST /v1/feedback` — the refusals, and the one shape the body may take.
 *
 * No database here, which is the point of two of these cases: a deployment
 * without one has to *say* it did not record the sentence, because a 200 would
 * leave the reader believing they had told us. The write itself is a single
 * insert and is exercised by the round trip in the database suite.
 */

import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { createFeedbackRoutes, MAX_REASON_CHARS } from "../src/api/feedback.js";
import { errorHandler } from "../src/api/plugins/errors.js";

/** The route with no database, which is how the gateway runs in these suites. */
const app = new Elysia().use(errorHandler).use(createFeedbackRoutes({ db: undefined }));

const post = (body: unknown) =>
  app.handle(
    new Request("http://localhost/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/**
 * The one call the route makes, as a stub that keeps what it was handed.
 *
 * Not a real database: what these cases are about is the row the route decided
 * to write, and the round trip through Postgres belongs to the database suite.
 */
function recordingDb(written: Record<string, unknown>[]) {
  return {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        written.push(row);
        return {
          returning: async () => [
            {
              id: "00000000-0000-4000-8000-000000000000",
              recordedAt: new Date("2026-09-20T12:00:00Z"),
            },
          ],
        };
      },
    }),
  } as never;
}

const verdict = {
  surface: "evidence",
  verdict: "down",
  locale: "pt",
  subject: { document_code: "IO-ON.NE.5NE", document_page: 12 },
};

describe("filing a verdict about one answer", () => {
  it("says it did not record when there is no database", async () => {
    // Not a 200. The reader pressed a button that means "I have told them",
    // and a silent drop is the one failure this surface cannot absorb.
    const response = await post(verdict);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("DATA_UNAVAILABLE");
    expect(body.error.message).toContain("Nothing was recorded");
  });

  it("refuses a surface outside the contract", async () => {
    // Closed on purpose: a fourth kind of answer is a decision somebody makes,
    // and a free string is a column nobody can group by six weeks later.
    const response = await post({ ...verdict, surface: "vibes" });
    expect(response.status).toBe(422);
  });

  it("refuses a verdict that is not one of the two", async () => {
    for (const bad of ["maybe", "3", "", null]) {
      expect((await post({ ...verdict, verdict: bad })).status).toBe(422);
    }
  });

  it("refuses a locale it has no dictionary for", async () => {
    expect((await post({ ...verdict, locale: "es" })).status).toBe(422);
  });

  it("keeps a subject key nobody agreed on out of the row", async () => {
    /*
      The validator strips it rather than refusing, which is Elysia's behaviour
      and is fine — what must not happen is the invented key reaching the
      column a retrain groups by. Asserted against what was written, because
      the status alone cannot tell the two outcomes apart.
    */
    const written: Record<string, unknown>[] = [];
    const filed = new Elysia()
      .use(errorHandler)
      .use(createFeedbackRoutes({ db: recordingDb(written) }));
    const response = await filed.handle(
      new Request("http://localhost/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...verdict,
          subject: { document_code: "IO-ON.NE.5NE", mood: "annoyed" },
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(written).toHaveLength(1);
    expect(written[0].subject).toEqual({ document_code: "IO-ON.NE.5NE" });
  });

  it("answers the filed row, and leaves an empty reason as no reason", async () => {
    const written: Record<string, unknown>[] = [];
    const filed = new Elysia()
      .use(errorHandler)
      .use(createFeedbackRoutes({ db: recordingDb(written) }));
    const response = await filed.handle(
      new Request("http://localhost/v1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...verdict, verdict: "up", reason: "   " }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    // The wire's casing, from the generated table: `recorded_at`, never
    // `recordedAt`.
    expect(Object.keys(body).sort()).toEqual(["id", "recorded_at", "surface", "verdict"]);
    expect(body.verdict).toBe("up");
    // A string of spaces is not a sentence somebody wrote.
    expect(written[0].reason).toBeNull();
  });

  it("refuses a subsystem the product does not have", async () => {
    /*
      `SIN` is the case that matters: a real ONS row this product deliberately
      never uses, because it double-counts the four. Stored here it would have
      become a fifth subsystem in anything grouping the pile — which is the
      whole reason `FeedbackSubject`'s vocabulary is closed.
    */
    const response = await post({ ...verdict, subject: { subsystem: "SIN" } });
    expect(response.status).toBe(422);
  });

  it("refuses a gate nobody publishes, and a date that is not one", async () => {
    expect((await post({ ...verdict, subject: { gate_profile: "other" } })).status).toBe(
      422,
    );
    expect(
      (await post({ ...verdict, subject: { target_date: "tomorrow" } })).status,
    ).toBe(422);
    // And takes the two that are real.
    const ok = await post({
      ...verdict,
      subject: { subsystem: "NE", gate_profile: "gate_late", target_date: "2026-09-19" },
    });
    expect(ok.status).toBe(503);
  });

  it("refuses a reason longer than the limit rather than truncating it", async () => {
    /*
      A sentence cut in half says something its writer did not. The refusal
      names the limit, and it is checked before the database is reached — so
      this is a 422 here, not the 503 every other body gets in this suite.
    */
    const response = await post({
      ...verdict,
      reason: "x".repeat(MAX_REASON_CHARS + 1),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("REQUEST_INVALID");
    expect(body.error.message).toContain(String(MAX_REASON_CHARS));
  });

  it("takes a reason exactly at the limit", async () => {
    // The boundary the other way: 400 characters is a sentence, not an abuse,
    // and it must reach the database rather than the refusal above it.
    const response = await post({ ...verdict, reason: "x".repeat(MAX_REASON_CHARS) });
    expect(response.status).toBe(503);
  });

  it("serves no GET: reading the pile back is a retrain's job", async () => {
    const response = await app.handle(new Request("http://localhost/v1/feedback"));
    expect(response.status).toBe(404);
  });
});
