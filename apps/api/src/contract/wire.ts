/**
 * The one translation between the contract's in-process shape and its wire
 * shape.
 *
 * `docs/specs/api-surface.md` settles the vocabulary rule this implements:
 * **every field name on the wire is a domain-model term in `snake_case`**, and
 * the conversion happens in exactly one place. The reason it is one place is
 * the reason the whole ticket exists — a per-read hand-written serialiser is a
 * second copy of the vocabulary, and a second copy drifts.
 *
 * Two conversions, and nothing else:
 *
 * - `camelCase` → `snake_case` on every key. The rule is "insert `_` before an
 *   upper-case letter", which is what produced the database's own column names:
 *   `windSpeed120mKmh` → `wind_speed120m_kmh`, exactly as the schema spells it.
 * - `Date` → ISO-8601 UTC string, so a Python consumer parses one format.
 *
 * Values are otherwise untouched. `null` stays `null` — the standing rule is
 * that an absence is never a zero.
 */

const UPPER = /[A-Z]/g;

/** `camelCase` → `snake_case`. The database's own convention. */
export function snakeKey(key: string): string {
  return key.replace(UPPER, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Recursively convert a contract value to its wire form.
 *
 * Typed as `unknown` in and out on purpose: the compile-time contract is the
 * `types.ts` shape, and pretending the wire form has an independent static type
 * would mean maintaining a second declaration of every row — the drift this
 * function exists to prevent.
 */
export function toWire(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toWire);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[snakeKey(key)] = toWire(item);
    }
    return out;
  }
  return value;
}
