import { describe, expect, it } from "bun:test";
import {
  CALENDAR_GENERATOR,
  CALENDAR_VERSION,
  calendarDigest,
  loadCalendarArtifact,
  NATIONAL_SCOPE,
  parseCalendarArtifact,
} from "../src/features/index.js";

/**
 * The cross-language half of the calendar contract, before a database exists.
 *
 * The artifact is written by Python and read by TypeScript, and the only thing
 * binding the two is a digest both sides compute — `apps/ml`'s
 * `test_calendar_generator.py` asserts the file is what the pinned library
 * produces, and this asserts the loader agrees about what the file says. A
 * digest only one side can compute would not be a contract; it would be a
 * checksum one side hoped the other honoured.
 */

describe("the calendar artifact", () => {
  const artifact = loadCalendarArtifact();

  it("is the version and the generator this code expects", () => {
    // The pin is the point. An artifact that did not name the library version
    // could not be regenerated for comparison, and "regenerating reproduces the
    // stored table" would be an unverifiable claim.
    expect(artifact.version).toBe(CALENDAR_VERSION);
    expect(artifact.generator).toBe(CALENDAR_GENERATOR);
    expect(artifact.dayFrom < artifact.dayTo).toBe(true);
  });

  it("hashes to the digest it carries, in both languages' serialisation", () => {
    expect(calendarDigest(artifact.days)).toBe(artifact.digest);
    expect(artifact.digest.startsWith("sha256:")).toBe(true);
  });

  it("separates national days from regional ones", () => {
    // The separation is a property of the rows rather than a filter a reader
    // has to remember: national days are stored once, under `BR`, and are not
    // repeated under the 27 UFs. If they were, the state share would read 1.0
    // on every national holiday and would be a copy of the national binary.
    const national = artifact.days.filter((day) => day.uf === NATIONAL_SCOPE);
    const regional = artifact.days.filter((day) => day.uf !== NATIONAL_SCOPE);
    expect(national.length).toBeGreaterThan(0);
    expect(regional.length).toBeGreaterThan(0);

    const nationalDays = new Map(national.map((day) => [`${day.day}|${day.name}`, day]));
    for (const day of regional) {
      expect(nationalDays.has(`${day.day}|${day.name}`)).toBe(false);
      // Municipal is out of scope, so every non-national scope is a UF.
      expect(day.uf).toHaveLength(2);
    }
  });

  it("carries the moveable feasts, which is what the optional category buys", () => {
    const named = new Set(
      artifact.days
        .filter((day) => day.uf === NATIONAL_SCOPE)
        .map((day) => `${day.day}|${day.name}`),
    );
    expect(named.has("2025-03-03|Carnaval")).toBe(true);
    expect(named.has("2025-06-19|Corpus Christi")).toBe(true);
    expect(named.has("2025-04-18|Sexta-feira Santa")).toBe(true);
  });

  it("refuses an artifact whose digest is not the digest of its rows", () => {
    // The artifact travels as a file between a Python job and a TypeScript
    // loader. A hand-edited one would otherwise be written into the database
    // under a version name that no longer describes it, and every later
    // comparison against that version would be against the wrong rows.
    const tampered = JSON.stringify({
      version: CALENDAR_VERSION,
      generator: CALENDAR_GENERATOR,
      day_from: "2023-01-01",
      day_to: "2023-12-31",
      digest: artifact.digest,
      days: [{ day: "2023-01-01", uf: "BR", name: "Ano Novo", category: "public" }],
    });
    expect(() => parseCalendarArtifact(tampered)).toThrow(
      /does not match its own digest/,
    );
  });

  it("refuses a malformed day rather than storing it as a holiday", () => {
    const days = [{ day: "2023-01-01", uf: "BR", name: "Ano Novo", category: "feriado" }];
    const malformed = JSON.stringify({
      version: CALENDAR_VERSION,
      generator: CALENDAR_GENERATOR,
      day_from: "2023-01-01",
      day_to: "2023-12-31",
      digest: "sha256:whatever",
      days,
    });
    expect(() => parseCalendarArtifact(malformed)).toThrow(/malformed day/);
  });
});
