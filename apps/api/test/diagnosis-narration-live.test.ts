import { describe, expect, it } from "bun:test";
import {
  NARRATION_LOCALES,
  narrationAttempt,
  narrationComplaint,
  validateNarration,
} from "../src/diagnosis/index.js";
import { narrationPayload } from "./support/narration-payload.js";

/**
 * Seam 13 — **live, scheduled**. The only test in this spec that spends money.
 *
 * One real call per locale per deployment, against the real model, asserting
 * only that the response passes all three gates. `docs/specs/diagnosis.md`:
 * "This is the test that catches a prompt regression."
 *
 * ### What it asserts, and the two things it deliberately does not
 *
 * It asserts the **gates**, and nothing else. It does not compare the paragraph
 * to a golden string, because prose from a language model is not reproducible
 * and a snapshot here would fail on every run for no reason anybody could act
 * on. It does not judge whether the paragraph is *good*, because nothing
 * mechanical can — that limit is named in the spec as one of the four places it
 * is weakest, and it is a limit rather than an oversight.
 *
 * What it does catch is the failure the offline suites structurally cannot: a
 * prompt edit, a model change or a schema change that leaves the request
 * perfectly well-formed and the paragraph unusable. Seam 11 proves the call is
 * assembled as the spec says; only this proves the call *works*.
 *
 * ### Gating: no key, no network, no cost on the default path
 *
 * `WATTSTEER_NARRATION_LIVE` — the same `describe.skip`-on-env-var shape
 * `live-conformance.test.ts` uses. The default `bun test test` discovers this
 * file and skips every case in it, so a commit never makes a call and never
 * reads a credential. Run it deliberately:
 *
 *     bun run --cwd apps/api test:narration
 *
 * and on a schedule from `.github/workflows/narration-live.yml`, never on a
 * commit. Two calls per run, at cents.
 *
 * A failure here is a notification, not a broken build: the endpoint keeps
 * serving, because a paragraph that fails the gates falls back to the
 * deterministic template exactly as a withheld day does.
 */
const ENABLED = process.env.WATTSTEER_NARRATION_LIVE;
const suite = ENABLED ? describe : describe.skip;

/** Adaptive thinking on a real call is not instant, and this is not a benchmark. */
const TIMEOUT_MS = 120_000;

suite("the real model, once per locale", () => {
  for (const locale of NARRATION_LOCALES) {
    it(
      `writes a paragraph in ${locale} that passes all three gates`,
      async () => {
        const payload = narrationPayload({ locale });
        // The first attempt, with no complaint. A prompt that needs the retry
        // to produce an acceptable paragraph is a prompt that has regressed,
        // so this asks for one call and judges that one.
        const text = await narrationAttempt({ payload })(undefined);
        const findings = validateNarration(text, payload);
        // The complaint is the failure message on purpose: it names the gate,
        // the code and the offending fragment, which is what somebody woken by
        // a scheduled run needs before opening a file.
        expect(narrationComplaint(findings)).toBe("");
        expect(findings).toEqual([]);
      },
      TIMEOUT_MS,
    );
  }
});
