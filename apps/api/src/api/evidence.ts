/**
 * `GET /v1/curtailment/evidence` — the ONS passage behind a settled
 * restriction, read from a row a schedule wrote.
 *
 * ## What it is
 *
 * Given a subsystem and a settled day, the documents `apps/rag` found for that
 * day's restrictions: the operating instruction or network procedure that
 * states the limit, the page, and the quoted text. It answers "why was this
 * curtailed?" with a citation rather than with a model's opinion.
 *
 * ## Why this reads and never builds
 *
 * Building evidence runs a language model against a free tier and can take a
 * minute. `jobs/rag-evidence.ts` does that on a schedule; this route reads what
 * it wrote. The boundary is the same one `ml-boundary.test.ts` guards for the
 * modelling service and is the same defect if crossed — a page view must not
 * start a model. `apps/rag`'s own `read_evidence` docstring says it first:
 * *"apps/api reads what a job wrote, and never calls a model to serve a page."*
 *
 * ## Absent is an answer
 *
 * A day with no evidence row is the ordinary case, not a fault. The corpus
 * covers what it covers, the gate refuses claims it cannot support, and a
 * restriction whose rule is in a document nobody has crawled simply has no
 * citation. So an empty list is a 200 and the screen shows a reason without a
 * document, rather than a screen that fails because a lookup did.
 */

import { Elysia, t } from "elysia";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";
import { readRag } from "./rag-proxy.js";

/** How long the gateway waits on the evidence service before giving up. */
const TIMEOUT_MS = 4000;

export function createEvidenceRoutes() {
  return new Elysia({ name: "curtailment-evidence" }).get(
    "/v1/curtailment/evidence",
    async ({ query, set, request }) => {
      const body = await readRag(
        "/internal/rag/evidence",
        new URLSearchParams({
          subsystem: query.subsystem,
          target_date: query.date,
          limit: String(query.limit ?? 10),
        }),
      );
      /*
        `observedSettled`, which is the policy this data actually has: the row
        is about a day that has settled and changes only when a job rewrites
        it, which is once a morning. Built through `applyCachePolicy` rather
        than by setting the header here — `cache-policy.test.ts` holds that
        there is one place these are made, and it caught the first draft
        writing its own.
      */
      applyCachePolicy({ set, request }, CACHE_POLICIES.observedSettled);
      return body;
    },
    {
      query: t.Object({
        subsystem: t.String({ description: "N, NE, SE or S." }),
        date: t.String({ description: "The settled civil day, YYYY-MM-DD." }),
        limit: t.Optional(t.Number({ minimum: 1, maximum: 50 })),
      }),
      detail: {
        summary: "The ONS passages behind a settled day's restrictions",
        description:
          "Read from rows a schedule wrote. No model runs on this path, and an " +
          "empty list is the ordinary answer for a day whose rules are not in " +
          "the corpus — a reason without a citation is still a reason.",
      },
    },
  );
}

export const evidenceRoutes = createEvidenceRoutes();
