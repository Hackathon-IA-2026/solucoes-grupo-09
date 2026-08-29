# 04 — The wire contract is a schema, and exactly one thing translates it

**What to build:** a field renamed in the API becomes a **compile error in the
web app**, not an `undefined` on a chart — and the Python service asserts against
the same contract the TypeScript client is generated from.

The wire is `snake_case`. That is forced rather than chosen: two sibling specs
publish `snake_case` contracts and declare them fixed, the modelling service is
Python, and the database columns are `snake_case`. The web app speaks
`camelCase`. Something converts, and it converts **once**, in the shared
package's generated client — not in each screen, not in a fetch wrapper per
feature, not in the gateway.

**JSON Schema is the cross-language authority.** The framework's own end-to-end
type treaty gives TypeScript-to-TypeScript parity for free and gives Python
nothing, so it stays as a convenience; where the two disagree the schema wins and
a test says so.

**Nine vocabulary rules the schema enforces**, each because something has
already got it wrong once:

1. A band is `{p10, p50, p90}` and is a single shared reference, so a grep over
   the schema finds every one.
2. An expectation is never inside a band object — the day expectation is a
   sibling of the day band, never its `p50`.
3. A technology split is **two scalars** with no additional properties, so an
   object carrying a `p10` under the split fails validation.
4. Avoidability is `number | null` and null is meaningful; no code path emits
   `0` where the domain requires null.
5. Lead time is absent.
6. `SIN` is not a subsystem value; a national figure lives under a `national`
   key with its derivation named.
7. Reason codes are the identifier and the English gloss is not returned.
8. `threshold_mw` is on every object it applies to, every episode and every
   optimization result included.
9. `vintage_fidelity` is on every object carrying a metric or a historical
   number, and nothing averages across it.

**Timestamps**: every instant is a UTC ISO-8601 string with an explicit `Z`;
every civil date is `YYYY-MM-DD` and is a Brasília civil date, named so in the
schema description; `hour_local` is an integer 0–23 in Brasília. There is no
offset-carrying local timestamp anywhere.

**No envelope.** A successful response is the resource. Pagination is needed on
exactly two routes and carries its own cursor field.

The client is a fetch wrapper returning typed results and throwing an error
object carrying the status, the domain code from ticket 02 and a `retryable`
flag for 429/5xx/network — which is what a screen needs in order to choose
between "retry" and "show the no-model state".

**Blocked by:** 02, 03.

**Status:** ready-for-agent

- [ ] The schema directory is the authority and the generated TypeScript types are checked in, with CI asserting they are current
- [ ] The generated client converts `snake_case` to `camelCase` in exactly one place, and a grep-level test says so
- [ ] Every example in the API-surface spec and its four upstream specs validates against the schema
- [ ] A split object containing a quantile fails validation; a band with `p10 > p50` fails; a `SIN` subsystem fails
- [ ] The nine vocabulary rules each have a failing-case test
- [ ] The typed error carries status, domain code and a retryable flag
- [ ] Where the schema and the framework's type treaty disagree, the schema wins, asserted by a test
