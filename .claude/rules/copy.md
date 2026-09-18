# Copy and i18n

Two dictionaries: `apps/web/src/i18n/copy.pt.ts` and `copy.en.ts`. pt-BR is the
default and English is complete, not a fallback. `docs/specs/i18n.md` is the
spec; **ADR-0006** rejected co-locating copy with screens and says why — read it
before proposing that again.

## No user-visible string is a literal

`test/i18n-hardcoded-copy.test.ts` walks the app and fails on prose in a
component. Add the key to **both** dictionaries in the same commit; the structure
is mirrored, and a key in one and not the other is a type error.

Interpolate with `fill(template, { name })` and `{placeholders}`. Format numbers,
dates and hours through `useFormat()` — never `toLocaleString` at a call site,
or the two locales will drift in a way nothing checks.

## Every key is rendered or deleted

A key nothing renders is dead copy that reads as a feature. When you remove a
panel, remove its keys in the same commit; when you add one, the key and its use
land together. Twelve orphaned keys were removed in one pass after an accordion
was retired — they had survived because nothing asked.

## An error code is not a message

The gateway's closed enum is the contract; the dictionary holds the sentence.
`copy.error[code]` per locale. A screen never renders an envelope's `message`
— `apps/web/test/error-copy.test.ts` forbids it — because that text is developer
prose in English and often carries an upstream's words.

The same rule is why `MetaLane.unusable_reason` stays on `/v1/meta` for the
operator it was written for and is not printed to a reader: it is the gate's own
English paragraph.

## Say which claim the screen is making

A lede describes the panels that are *there* (ADR-0008). When a screen's state
changes what it draws, the lede changes with it — and it must not assert a cause
it has not read. Two shipped defects: a lede blaming an unpromoted model above a
promoted lane, and a note asserting the same about a lane the screen had
hard-coded.

Keep the two vocabularies apart — see [`honesty.md`](honesty.md). An observed
label may not say *previsão*, *risco* or *esperado*, and
`apps/web/test/observed-overview.test.ts` holds a closed list per locale.

## Style

Portuguese first, in the register a grid operator uses: ONS's own nouns
(*constrained-off*, *subsistema*, *liquidado*), no marketing, no exclamation
marks. A caveat the product must always carry belongs in a footnote or a card's
corner, not repeated on every panel — it is read once and then never again.

Write the English as its own sentence, not as a translation with the Portuguese
word order.
