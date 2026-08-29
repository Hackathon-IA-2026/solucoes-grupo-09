/**
 * The calendar artifact — read, checked, and never computed here.
 *
 * `docs/specs/feature-engineering.md` §"The holiday calendar — data, not a
 * library call" puts the Brazilian holiday calendar in a table rather than in a
 * library call at feature time, because Carnival moves and a library that moved
 * it would restate three years of training features with nothing to show for
 * it. The generator is Python — `apps/ml/src/wattsteer_ml/calendar_generator.py`,
 * pinned to `holidays==0.103` — and it writes the artifact this module reads.
 *
 * So there are three parties and each does one thing:
 *
 * | who | what |
 * |---|---|
 * | `calendar_generator.py` | produces the artifact from the pinned library |
 * | this module | parses it and checks the digest is the one over its own rows |
 * | `calendar-repository.ts` | writes it once, and refuses to restate a version |
 *
 * **No holiday rule is written in TypeScript**, and that is the point: a second
 * implementation of "when is Corpus Christi" would be a second calendar, kept
 * in step by hand, which is the failure the materialisation exists to prevent.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadInputError } from "../../errors.js";

/**
 * The active calendar version.
 *
 * Also spelled in `drizzle/0018_calendar_and_astronomy.sql`, which reads the
 * table under this literal rather than under "whichever calendar is newest" —
 * "whichever happens to be loaded" is exactly the silent restatement the design
 * prevents. `features-gate.test.ts` asserts the two spellings agree, and
 * `calendar_generator.py` holds the third.
 */
export const CALENDAR_VERSION = "br_calendar_v1";

/** The pinned generator, spelled as the requirement that produces it. */
export const CALENDAR_GENERATOR = "holidays==0.103";

/** `public` and `optional`, `holidays`' own taxonomy. */
export type CalendarHolidayCategory = "public" | "optional";

/** The national scope. A two-letter UF is a state that observes it alone. */
export const NATIONAL_SCOPE = "BR";

/** One `(day, uf, name, category)` row of the materialised calendar. */
export interface CalendarDay {
  /** Civil date in `America/Sao_Paulo`, `YYYY-MM-DD`. */
  day: string;
  /** `BR` for national, otherwise the UF observing it. */
  uf: string;
  name: string;
  category: CalendarHolidayCategory;
}

/** The artifact as a whole: the days, plus what produced them. */
export interface CalendarArtifact {
  version: string;
  generator: string;
  dayFrom: string;
  dayTo: string;
  digest: string;
  days: CalendarDay[];
}

const ARTIFACT_PATH = join(
  import.meta.dir,
  "../../../../../packages/core/fixtures/calendar",
);

/**
 * The digest, in the one serialisation both languages compute.
 *
 * `day|uf|category|name` per line, newline-joined, SHA-256. Deliberately
 * trivial — `calendar_generator.py` computes the same string, and a format
 * needing a library on one side would be a format the two sides could disagree
 * about.
 */
export function calendarDigest(days: readonly CalendarDay[]): string {
  const joined = days
    .map((day) => `${day.day}|${day.uf}|${day.category}|${day.name}`)
    .join("\n");
  return `sha256:${createHash("sha256").update(joined, "utf8").digest("hex")}`;
}

const isCategory = (value: unknown): value is CalendarHolidayCategory =>
  value === "public" || value === "optional";

/**
 * Parse an artifact, and refuse one whose digest is not the digest of its rows.
 *
 * The check is not ceremony. The artifact travels as a file between a Python
 * job and a TypeScript loader, and the digest is what the loader stores as the
 * identity of the version it wrote — an artifact edited by hand between the two
 * would otherwise be loaded under a version name that no longer describes it,
 * and every later comparison against that version would be against the wrong
 * rows.
 */
export function parseCalendarArtifact(raw: string): CalendarArtifact {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new BadInputError("Calendar artifact is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const days: CalendarDay[] = [];

  if (!Array.isArray(record.days)) {
    throw new BadInputError("Calendar artifact carries no days");
  }
  for (const entry of record.days) {
    const row = entry as Record<string, unknown>;
    if (
      typeof row.day !== "string" ||
      typeof row.uf !== "string" ||
      typeof row.name !== "string" ||
      !isCategory(row.category)
    ) {
      throw new BadInputError(
        `Calendar artifact holds a malformed day: ${JSON.stringify(entry)}`,
      );
    }
    days.push({ day: row.day, uf: row.uf, name: row.name, category: row.category });
  }

  const artifact: CalendarArtifact = {
    version: String(record.version ?? ""),
    generator: String(record.generator ?? ""),
    dayFrom: String(record.day_from ?? ""),
    dayTo: String(record.day_to ?? ""),
    digest: String(record.digest ?? ""),
    days,
  };

  const recomputed = calendarDigest(days);
  if (artifact.digest !== recomputed) {
    throw new BadInputError(
      `Calendar artifact ${artifact.version} does not match its own digest: ` +
        `it claims ${artifact.digest} and its rows hash to ${recomputed}. ` +
        "Regenerate it with calendar_generator.py rather than editing it.",
    );
  }
  if (!(artifact.version && artifact.generator)) {
    throw new BadInputError("Calendar artifact must name its version and its generator");
  }
  return artifact;
}

/** The artifact shipped with the repository, for `CALENDAR_VERSION`. */
export function loadCalendarArtifact(
  version: string = CALENDAR_VERSION,
): CalendarArtifact {
  return parseCalendarArtifact(
    readFileSync(join(ARTIFACT_PATH, `${version}.json`), "utf8"),
  );
}
