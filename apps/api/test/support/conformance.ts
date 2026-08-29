/**
 * The vocabulary the network-gated suites report in.
 *
 * Lifted verbatim out of `test/live-conformance.test.ts` when a second gated
 * suite arrived — `test/publication-lag-conformance.test.ts`, the feature
 * layer's own scheduled measurement — because the thing worth sharing between
 * them is not the plumbing. It is the *shape of the failure*: an expired
 * assumption names the note that recorded it, the claim in prose, what the
 * source does now, what breaks, and the module encoding it; an unreachable
 * source is held apart from an expired assumption because the first proves
 * nothing; and neither is ever reported as a bare value diff.
 *
 * Two suites writing that shape twice would be two chances to drift, and the
 * one that drifts is the one whose failure lands at 04:00 in a CI log nobody
 * has context for.
 *
 * This file is not a `*.test.ts` and declares no cases, so `bun test test`
 * neither collects nor runs it.
 */

/**
 * A documented claim, and everything a human needs in order to act when the
 * world stops honouring it.
 *
 * `code` is not decoration. The point of naming it is that the reader of a
 * failed CI run learns *where the assumption is spent* — a research note that
 * expires with no code depending on it is a documentation edit, and one with an
 * adapter behind it is an outage waiting for the next ingest.
 */
export interface Claim {
  /** Repo-relative path of the research note that recorded it. */
  note: string;
  /** Section or heading within the note. */
  section: string;
  /** The claim, in the note's own terms. */
  claim: string;
  /** What in WattSteer stops working when the claim stops being true. */
  breaks: string;
  /** The module that encodes the assumption. */
  code: string;
}

/**
 * The failure these suites exist to produce.
 *
 * Named rather than a bare `Error` so the output says what kind of event this
 * is before it says anything else: an assumption reached its expiry date.
 */
export class AssumptionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssumptionExpiredError";
  }
}

/** Wrap a long prose line so a CI log stays readable. */
export function wrap(text: string, indent: string, width = 76): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") {
      line = word;
    } else if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines
    .map((entry, index) => (index === 0 ? entry : `${indent}${entry}`))
    .join("\n");
}

/**
 * Assert one documented claim against what the live source actually did.
 *
 * `expect(x).toBe(y)` is deliberately not used anywhere in the suites that call
 * this. A diff tells the reader that two values differ; it does not tell them
 * which research finding just expired, and that is the entire product of a
 * conformance run. `observed` is prose too, for the same reason — "16 columns,
 * `dsc_restricao` absent" is actionable where `false !== true` is not.
 */
export function assertClaim(claim: Claim, holds: boolean, observed: string): void {
  if (holds) {
    return;
  }
  throw new AssumptionExpiredError(
    [
      "",
      `ASSUMPTION EXPIRED — ${claim.section}`,
      "",
      `  Documented in : ${claim.note} § ${claim.section}`,
      `  The claim     : ${wrap(claim.claim, "                  ")}`,
      `  Observed now  : ${wrap(observed, "                  ")}`,
      `  What it breaks: ${wrap(claim.breaks, "                  ")}`,
      `  Encoded in    : ${claim.code}`,
      "",
      `  ${wrap(
        "This suite is expected to fail when the world moves. Nothing is wrong " +
          "with the code that ran — a source WattSteer depends on changed. Fix " +
          "it by re-measuring the source, updating the research note above and " +
          "the adapter together, and re-pinning the claim in this file. Do not " +
          "relax the assertion without changing the note.",
        "  ",
      )}`,
      "",
    ].join("\n"),
  );
}

/**
 * A source that could not be reached at all.
 *
 * Distinct from an expired assumption, and the distinction is the actionable
 * part: an expiry says *the world changed and the platform is now wrong*, while
 * this says *the question was not answered, so nothing below was proven either
 * way*. Both fail the scheduled run — a source WattSteer cannot reach is also
 * news — but the reader is told which of the two they are looking at before
 * they start investigating.
 */
export class SourceUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnreachableError";
  }
}

/**
 * Run one live measurement, turning a transport failure into prose as well.
 *
 * Without this, a DNS failure or a refused TLS handshake reaches the log as a
 * stack trace from inside an adapter — which reads exactly like a WattSteer
 * bug and is the opposite of what these suites promise to report.
 */
export function measuring(
  source: string,
  body: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (error) {
      if (error instanceof AssumptionExpiredError) {
        throw error;
      }
      if (error instanceof SourceUnreachableError) {
        throw error;
      }
      throw new SourceUnreachableError(
        [
          "",
          `SOURCE UNREACHABLE — ${source}`,
          "",
          `  What happened : ${wrap(
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            "                  ",
          )}`,
          "",
          `  ${wrap(
            "No documented assumption was disproved here — the source did not " +
              "answer, so this run measured nothing. Treat a single occurrence as " +
              "the source being down or throttling (the registry cases pull whole " +
              "files, and both agencies rate-limit), and a persistent one as a " +
              "finding in its own right: the endpoint moved, and the adapter that " +
              "reads it is about to start failing in production too.",
            "  ",
          )}`,
          "",
        ].join("\n"),
      );
    }
  };
}

/**
 * Parse a live payload with the platform's own parser, and report a refusal as
 * an expired claim rather than as an unreachable source.
 *
 * The adapters assert their required columns and throw when one is missing.
 * That throw *is* a conformance finding — the header moved — but it reaches
 * the suite as an ordinary exception, which `measuring` would otherwise
 * mislabel as a transport failure. The distinction matters: "ONS is down"
 * and "ONS renamed a column" call for very different mornings.
 */
export function parsing<T>(claim: Claim, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    assertClaim(
      claim,
      false,
      `the platform's own parser refused the live file: ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }`,
    );
    throw error;
  }
}

/** GET, with a prose failure rather than a status code. */
export async function get(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok && response.status !== 206) {
    throw new AssumptionExpiredError(
      `\n\nSOURCE UNREACHABLE — GET ${url} answered HTTP ${response.status}.\n` +
        "  Conformance could not be measured, so nothing below was proven either\n" +
        "  way. If this persists it is itself a finding: the URL moved.\n",
    );
  }
  return response;
}

/**
 * Print a measurement, whether or not anything failed.
 *
 * The lag suite's product is a *number*, not only an alarm: "the balance file
 * was 36.6 h stale when this ran, against a configured 40 h" is what a human
 * needs in order to decide whether a conservative default is costing the
 * platform a day of actuals, and it has to be in the log of the run that
 * passed — by the time a run fails, the series of numbers that would have
 * explained the drift was never written down.
 */
export function publish(heading: string, lines: readonly string[]): void {
  const body = lines.map((line) => `  ${line}`).join("\n");
  console.log(`\nMEASURED — ${heading}\n\n${body}\n`);
}
