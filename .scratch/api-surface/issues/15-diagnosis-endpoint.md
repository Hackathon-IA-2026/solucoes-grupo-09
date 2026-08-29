# 15 — The Explain screen gets its attribution and its paragraph from one call

**What to build:** the public diagnosis route. Attribution as codes and numbers,
narration as prose, one attribution per **subsystem-day**, served from a
persisted row plus a cached language-model call.

Parameters: subsystem, date, gate profile and locale. The diagnosis spec spells
the third one `run`; it is re-spelled `gate_profile` here for consistency with
the forecast route. **There is no technology parameter** — there is one
attribution per subsystem-day, because there is one model per subsystem-day.

Locale is one of the two supported values, defaulting from `Accept-Language`,
and this is **the only endpoint that varies by locale**, because it is the only
one that returns generated prose. It sets `Vary: Accept-Language` accordingly.

**The attribution half is a row read.** No model artifact is loaded and the
modelling service is not called — this route must return a 200 with the
modelling service's URL unset, and a test asserts exactly that.

**All eight groups are returned, ranked by absolute share.** The client applies
the display rule — the 3% cut, the six-row cap, the merge into `other` and its
mixed-direction test. Putting that rule server-side would mean the merged row's
direction computation lives in two places the first time a second client
appears.

**A withheld diagnosis is a success, not an error.** A withholding rule produces
a **200** carrying no drivers, the codes of the rules that withheld, and a
template narration. "There is nothing to explain" is an answer.

**Two caches, and inventing a third is forbidden.** The attribution is a row read
and caches like any other row. The narration is cached under the diagnosis spec's
exact key, with its stated TTL and its short-TTL template fallback. The HTTP
layer must **not** add a third key over the composed response: that response's
identity is already the pair, and a third key would have its own drift.

**The language model is protected by a lock, not by an IP limit.** The real
volume is four subsystems × two locales × two gate profiles — about sixteen
distinct narrations a day, and everything else is a cache hit. An IP budget would
protect nothing while ignoring the actual risk, which is a **cache stampede**: a
thousand concurrent misses on one cold key make a thousand calls. So a
single-flight lock on the narration key, with losers waiting on the winner's
result under a short deadline and falling back to the template on expiry; plus a
**global daily call cap** (default 200, an order of magnitude above the expected
sixteen) beyond which the endpoint serves the template and says so in the
response's narration-source field. The endpoint itself sits in the read tier.

**This ticket adds user-facing copy** for the withheld state and the narration
source footnote, in both locales, Portuguese first, under the hardcoded-string
guard.

**Blocked by:** 04, 05, 11 (the origin object it shares), and cross-spec
**diagnosis 06** (the persisted attribution), **diagnosis 07** (the rules and the
withheld state), **diagnosis 09** (the template) and **diagnosis 11** (the
generated narration whose key this endpoint caches). It can be built against fixtures for the attribution half
as soon as diagnosis 06 fixes the row shape.

**Status:** ready-for-agent

- [ ] The route returns a 200 with the modelling service's URL unset, resolving the attribution from Postgres alone
- [ ] All eight groups are returned ranked; the display rule is applied client-side and only there
- [ ] There is no technology parameter, and a request carrying one is refused rather than ignored
- [ ] A withheld diagnosis is a 200 with no drivers, the withholding codes, and a template narration
- [ ] The endpoint sets the language variation header and no other
- [ ] The narration cache key is the diagnosis spec's, unchanged; no third cache key exists over the composed response
- [ ] A hundred concurrent misses on one cold narration key produce exactly one language-model call, asserted on the client being invoked once
- [ ] Beyond the daily cap, the response is a 200 whose narration source says template
- [ ] A missing attribution row where a forecast exists produces the distinct diagnosis-unavailable code, not a generic not-found
- [ ] New copy exists in both locales and passes the hardcoded-string guard
