/**
 * `POST /v1/feedback` — what a reader thought of one answer.
 *
 * ## Why the gateway holds this at all
 *
 * Every other write in this product is an ingestion: a fact somebody published,
 * stamped with when it was true and when WattSteer learned it. This is not one.
 * It is an opinion about an answer, collected because the team validating the
 * prototype is the only source of "this citation was wrong" the corpus and the
 * forecaster will ever get, and because a verdict nobody stored is a verdict
 * nobody can retrain on.
 *
 * It therefore reaches **no canonical view and no metric**. `answerFeedback`'s
 * own header says the same thing from the schema's side, and the screens say it
 * to the reader: filed for later, not acted on now.
 *
 * ## What it refuses, and why each one
 *
 * - **A surface or verdict outside the contract** — `REQUEST_INVALID`, 422,
 *   from the route's own schema. `FeedbackSurface` is closed because a fourth
 *   kind of answer is a decision somebody makes, and a free string is a column
 *   nobody can group by six weeks later.
 * - **A reason over 400 characters** — `REQUEST_INVALID`, 422. A paragraph is
 *   welcome; a pasted stack trace is a body this route would have to truncate,
 *   and a silently truncated sentence is worse than a refusal that says the
 *   limit.
 * - **No database** — `DATA_UNAVAILABLE`, 503, rather than a 200 that drops
 *   the reader's sentence on the floor. The button reports it, because a
 *   thumbs-down that quietly vanished is the one failure this surface cannot
 *   absorb: the reader believes they have told us.
 *
 * There is no `GET`. Reading the pile back is a retrain's job against the
 * database, and a public list of colleagues' sentences is not a product
 * surface.
 */

import type { AnswerFeedback } from "@wattsteer/core/api";
import { encodeWire } from "@wattsteer/core/wire";
import { Elysia, t } from "elysia";
import type { Database } from "../database/connection.js";
import { answerFeedback } from "../database/schema.js";
import { CodedError } from "../errors.js";
import { applyCachePolicy, CACHE_POLICIES } from "./plugins/cache-policy.js";

/** A sentence, not a transcript. See the header. */
export const MAX_REASON_CHARS = 400;

export interface FeedbackRoutesDeps {
  db: Database | undefined;
}

/** The body, as the contract's `FeedbackSubject` spells it. */
const subject = t.Object(
  {
    subsystem: t.Optional(t.String()),
    target_date: t.Optional(t.String()),
    lane: t.Optional(t.String()),
    gate_profile: t.Optional(t.String()),
    artifact_id: t.Optional(t.String()),
    document_code: t.Optional(t.String()),
    document_page: t.Optional(t.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export function createFeedbackRoutes(deps: FeedbackRoutesDeps) {
  return new Elysia({ name: "feedback" }).post(
    "/v1/feedback",
    async ({ body, set, request }) => {
      const reason = body.reason?.trim();
      if (reason !== undefined && reason.length > MAX_REASON_CHARS) {
        throw new CodedError(
          "REQUEST_INVALID",
          `reason is ${reason.length} characters; the limit is ${MAX_REASON_CHARS}`,
        );
      }
      if (deps.db === undefined) {
        throw new CodedError(
          "DATA_UNAVAILABLE",
          "this deployment has no database, so feedback cannot be filed. " +
            "Nothing was recorded, which is why this is a refusal and not a 200",
        );
      }
      const [row] = await deps.db
        .insert(answerFeedback)
        .values({
          surface: body.surface,
          verdict: body.verdict,
          subject: body.subject ?? {},
          // An empty sentence is no sentence: the column stays NULL rather than
          // holding a string a reader did not write.
          reason: reason === undefined || reason === "" ? null : reason,
          locale: body.locale,
        })
        .returning({ id: answerFeedback.id, recordedAt: answerFeedback.recordedAt });
      if (row === undefined) {
        throw new CodedError("INTERNAL", "the feedback row was not written");
      }
      // Nothing to cache and nothing to revalidate: a write's answer is about
      // this submission only.
      applyCachePolicy({ set, request }, CACHE_POLICIES.solveBody);
      set.status = 201;
      // Field by field against the generated interface, then translated by the
      // generated table: the rule `api-routes.md` states, and the reason a
      // hand-written `recorded_at` here was a compile error rather than a
      // response nobody validated.
      const answer: AnswerFeedback = {
        id: row.id,
        recordedAt: row.recordedAt.toISOString(),
        surface: body.surface,
        verdict: body.verdict,
      };
      return encodeWire("AnswerFeedback", answer);
    },
    {
      body: t.Object({
        surface: t.Union([
          t.Literal("forecast"),
          t.Literal("replay"),
          t.Literal("evidence"),
        ]),
        verdict: t.Union([t.Literal("up"), t.Literal("down")]),
        subject: t.Optional(subject),
        reason: t.Optional(t.String()),
        locale: t.Union([t.Literal("pt"), t.Literal("en")]),
      }),
      detail: {
        summary: "File a verdict about one answer",
        description:
          "An opinion, never a measurement: it reaches no canonical view and " +
          "no metric, and is stored for a later retrain to read.",
      },
    },
  );
}
