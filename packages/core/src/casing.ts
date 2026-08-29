/**
 * The project's one spelling of `snake_case` → `camelCase`.
 *
 * It is its own module for a boring reason with a real consequence: the
 * generator (`scripts/generate-types.ts`) needs it to *build* the translation
 * table, and `src/wire.ts` — which owns the table and does the actual renaming
 * — imports the generated file. Putting the convention in `wire.ts` would make
 * the generator import its own output. So the convention lives here, the table
 * is generated from it, and the renaming happens in exactly one place
 * downstream of both.
 *
 * **Nothing at runtime calls this.** Reads and writes go through the generated
 * table in `src/wire.ts`, because a regular expression over keys is not
 * invertible: `last_24h_constrained_off_mwh` camel-cases to
 * `last24hConstrainedOffMwh` and no rule takes that back. The function exists
 * so the table can be *built* consistently and so a test can assert the
 * checked-in table still obeys the convention.
 */

/**
 * `snake_case` → `camelCase`.
 *
 * Digits stay attached to the segment they were written with: `last_24h_x`
 * becomes `last24hX`, not `last24HX`. A name with no separator — `p10`, `v` —
 * survives untouched.
 */
export function toCamelKey(wire: string): string {
  const [head, ...rest] = wire.split("_");
  return (
    (head ?? "") +
    rest
      .map((part) => (part === "" ? "" : (part[0] ?? "").toUpperCase() + part.slice(1)))
      .join("")
  );
}
