# 10 — Nothing a language model invents ever reaches a user

**What to build:** the three mechanical gates every generated narration passes
before anyone sees it. Prompts ask; validators enforce. This ships before the
model call, fixture-driven, so the gates are proven against hand-written
adversarial narrations rather than against whatever the model happened to say.

**Gate 1 — the numeric whitelist.** Extract every numeric token from the
narration, locale-aware (`1.42` / `1,42`, `412` / `412,0`, `87%`, `1.900`). Each
must match a value present in the closed payload, rendered at one of the
permitted precisions for its field, in the requested locale. **A number that is
arithmetically correct but absent from the payload fails**, and that is the whole
point: from the outside, a correct computation and a lucky hallucination are
indistinguishable, so the only tractable rule is "no computation at all".

**Gate 2 — lexical.** The §26 banned-lemma set from ticket 01, plus banned advice
verbs (`should`, `recommend`, `deve`, `recomenda`) and banned certainty adverbs
(`certainly`, `definitely`, `certamente`).

**Gate 3 — structural.** Word count within `[35, 110]`; a single paragraph; no
markup; no URL; the locale of the output matches the request. A cheap
script/stopword check is sufficient for the last one — the failure mode is a
whole paragraph in the wrong language, not a stray word.

**On failure**: the validator's complaint is appended to a second and final
attempt. A second failure logs the rejected text with its payload hash and falls
back to the template. **The rejected text is never shown.**

What this deliberately does not do: nothing here validates that a narration is
*good*. A dull, unhelpful, technically-correct paragraph passes all three gates.
That is the right trade — the failure this product cannot survive is a confident
false claim, not a boring true one — but it is a stated limit, not an oversight.

**Blocked by:** 01 (the banned-lemma set), 08 (the payload the whitelist is
drawn from), 09 (the template that a second failure falls back to).

**Status:** ready-for-agent

- [ ] A narration stating a number correctly derived from the payload but absent from it is rejected
- [ ] A narration stating a payload number in the other locale's formatting passes
- [ ] A narration stating a plausible-looking number that appears nowhere is rejected
- [ ] Each banned lemma is rejected, in both locales
- [ ] Advice verbs and certainty adverbs are rejected
- [ ] Word count, paragraph count, markup, URLs and output language are each checked
- [ ] A first failure produces exactly one retry, with the complaint appended
- [ ] A second failure falls back to the template, logs the rejected text with the payload hash, and shows the user nothing of it
- [ ] Every case is fixture-driven with no network calls
