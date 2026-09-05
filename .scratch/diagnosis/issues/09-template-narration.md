# 09 — A sentence that is always there, before there is a model to write one

**What to build:** the deterministic narration. The Explain panel is never empty
— not when the language model is down, not when a rule withheld the model
narration, not when the daily cap is reached. This ships **before** the model
call, so the endpoint is complete and useful with no language-model dependency
at all, and so the fallback is exercised in normal development rather than only
in an outage.

The template is assembled from the same closed payload through translation keys
with interpolation, one key per locale, living in the message catalogues. It
names the risk class, the day's expected MWh against the baseline, the top two
groups with their directions and their observed/typical pair, and every rule
flag.

It is the one narration surface that *is* a translated string, and that is
consistent rather than an exception: a template is a fixed string catalogue,
which is exactly what the API returns everywhere except generated prose.

The response carries `narration.source: "model" | "template"`, so the panel's
footnote can be true in both cases. The screen currently asserts unconditionally
that the paragraph was written by a language model; correcting that copy is part
of this ticket.

**This ticket adds user-facing copy.** Portuguese is the default locale, all
strings go through the dictionaries in both locales, and the hardcoded-string
guard applies — a template sentence written inline in a component or a handler
is exactly what that guard exists to catch. Numbers are interpolated and
formatted in the client's locale, never assembled server-side into a string.

**Blocked by:** 08. Also **01**, whose banned-vocabulary check scans the message
catalogues this ticket writes into.

**Status:** done

- [ ] A complete narration is produced from the payload alone, with no network call
- [ ] It exists in both locales, with Portuguese as the default
- [ ] It names the risk class, the expectation against the baseline, the top two groups with directions and observed/typical, and every rule flag
- [ ] Every string lives in the message catalogues and the hardcoded-string guard passes
- [ ] Numbers are interpolated and formatted client-side, so decimal comma and decimal point are a locale property and not a server one
- [ ] The response states which source produced the narration
- [ ] The panel footnote no longer asserts unconditionally that a language model wrote the paragraph
- [ ] The banned-vocabulary check passes over the new catalogue entries
