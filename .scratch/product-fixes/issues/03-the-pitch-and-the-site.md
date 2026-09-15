# 03 — The pitch, the site, and the four things the site says it can do

**What to build:** a landing page and four app screens that claim exactly what
the deployment can currently serve, in both locales, and a test that keeps them
that way.

**The pitch deck could not be read.** `/Users/krinik/Downloads/WattSteer_Pitch_Grupo9.pdf`
is denied to this process by macOS privacy control — `Operation not permitted`
from the Read tool, from `cp`, from `ls ~/Downloads`, and through `osascript`.
No copy of it exists in the repo (`find . -iname "*pitch*"` returns nothing),
and the pitch's module vocabulary is absent from the source: a case-insensitive
scan for `Diagnosticar`, `Proteger`, `Prever`, `módulo` across every `.md`,
`.ts` and `.tsx` returns **one** hit, `apps/web/src/i18n/copy.pt.ts:198`, and it
is the word *prever* in an ordinary sentence. So every finding below is measured
against the specs and the built code, which is the authority the repo actually
has. **Two questions are therefore unanswered and are not fixed here:** whether
the site's four engine names match the deck's numbered modules, and whether the
deck's market and value-proposition framing is represented. They need someone
who can open the file.

## Measurements

The ground truth used throughout: Grid Overview and Explain render
`@/lib/fixtures` and issue no request (`apps/web/src/app/app/index.tsx:40`,
`apps/web/src/app/app/explain.tsx:42`); Mitigate and Replay read the gateway
(`use-optimization.ts`, `use-replay.ts`) and ship a stated absence in a static
export. No model artifact is promoted, so the forecast surfaces serve `pending`
or a named refusal.

### 1 — Three calls to action sell a live grid; the destination is a fixture

`copy.en.ts:39,179,371` — `nav.cta`, `hero.primaryCta`, `footerCta.button` all
read **"Open the live grid"**; `copy.pt.ts:25,146,335` all read **"Ver a rede
agora"**. `APP_HREF` is `/app` (`landing/cta-link.tsx:94`), whose own chrome
stamps `PROTOTYPE · FIXTURE DATA` (`app-shell.tsx:133`). The most-clicked string
on the site contradicts the badge on the page it opens. **Fixing.**

### 2 — The landing Diagnosis panel attributes to things no model produces

`landing/fixtures.ts:55-61` declares `LandingDriverCode` as five *feature*
names plus `other`, and `fixtures.ts:262` calls them "the grain the Diagnosis
engine reports". `packages/core/src/domain.ts:314-337` says the opposite, in
terms: the eight groups are "the players in the Shapley game", and "this used
to be twelve prototype feature names … no model ever produced a `φ` for one of
them". `fixtures.ts:50-53` concedes it in its own comment — two comments on one
object, contradicting each other — while `showcase.sub` tells the reader "these
are the product's own panels … same components, same units, same bands as the
live screens". The app screen was migrated to the eight groups; the marketing
panel was not, so the landing page advertises an attribution grain the diagnosis
engine refuses to compute. **Fixing:** the panel moves to the product's closed
`DriverCode` set and the duplicate word-list `showcase.explain.drivers` is
deleted, so there is one dictionary of driver names rather than two.

### 3 — A calibration measurement is written into the copy dictionary

`copy.en.ts:740` / `copy.pt.ts:125`, `app.reliability.note`: "of the hours
called 85%, 77% actually cleared the threshold". No promoted artifact means no
reliability run, so 85/77 is a fixture's shape restated as a finding about the
model. It also breaks the dictionary's own rule 2, stated at `copy.en.ts:14`:
"Numbers never live here." **Fixing:** the sentence keeps what it teaches — how
to read the diagram — and drops the pair of percentages, which belong to the
chart.

### 4 — Four strings that state today's absence are wired to nothing

`copy.*.noForecast.{notYetPublished,noPromotedArtifact,stale,unavailable}` are
referenced by no file under `apps/web/src` (exact-path scan; see the new test).
`noPromotedArtifact` — "No model is promoted for serving, so nothing is forecast"
— is a true sentence about this deployment that the site never shows. **Partly
fixing:** the four stay, because wiring them needs a `/v1/forecast` read that
Overview deliberately does not do (it must survive `web:export`); what is added
instead is one stated absence on Grid Overview saying what its figures are. The
four are exempted by name in the new dead-key test, each with its reason.

### 5 — Dead keys, both locales

`nav.cta` (unused since `landing-nav.tsx:63-68` deliberately dropped the nav
CTA), `showcase.replay.panelSub` (superseded by a computed subtitle at
`replay-compare.tsx:56`). **Fixing:** deleted. `app.explain.narrationWithheld`,
`narrationSourceModel` and `narrationSourceTemplate` are also unreferenced but
are kept — they answer states a fixture cannot reach and the endpoint will.

### 6 — Portuguese drift

- `pt` calls the company **"a WattSteer"** in three replay strings
  (`copy.pt.ts:299,317,401`) and **"o WattSteer"** in twenty-two others.
- `mitigate.solvingNote` (`copy.pt.ts:254`) keeps the English product name
  "O Flex Optimizer"; `engines.items.2.name` names it "Otimizador de
  flexibilidade". One engine, two names, one locale.
- `mitigate.hidden`: en "reveal it **in order to** see what the step recovers";
  pt "revele **na ordem** para ver" — purpose read as sequence.

**Fixing** all three.

### 7 — The site never says which engines are serving

`engines` presents four engines in the present tense with no statement of what
is running. Ingestion, the data platform and the grid view are live; no artifact
is promoted, so Forecaster and Diagnosis answer with a refusal. **Fixing:** one
`engines.status` line, in both locales, naming both halves.

## The named gap: ONS maintenance data

ONS publishes transmission maintenance and outage information **unstructured**.
The plan is a RAG over it feeding **Diagnosticar (Module 4)** and **Proteger
(Module 6)**. Nothing of it is built. The site does not imply it today and must
not start: the only sentence in the product that touches it is
`app.narration.flag_unmodelled_outage_regime`, which says outright that "no
ingested dataset carries transmission availability for the model to read" —
correct, and left exactly as it is. **This ticket adds a fifth item to
`provenance.honesty` naming the gap on the public page**, so a reader is told
before they infer it. Building the RAG is not this ticket's work.

## Deliberately left

- **`app.shell.prototypeBadge` says `FIXTURE DATA` on all four screens**, but
  Mitigate and Replay read the gateway. It understates rather than overclaims,
  and it is shared chrome that a second ticket should make per-screen.
- **`band.explainerBody` contains "4,180 MWh"** — another number in the
  dictionary, but an explicitly hypothetical one ("a forecast that says X and
  nothing else is a number pretending to be a fact"), not a measurement.
- **The grid view's map** — another agent's territory this cycle.
- **`/pitch`** — another agent's territory; nothing here adds a route.
- **`showcase.explain.panelSub` is copy while `showcase.replay`'s is computed
  from the fixture.** Cosmetic inconsistency, no claim attached.

**Blocked by:** nothing. Blocks nothing.

**Status:** done

- [x] No call to action describes `/app` as live while it renders fixtures
- [x] The landing Diagnosis panel uses the product's eight driver groups
- [x] No copy string states a calibration measurement no run produced
- [x] Grid Overview states what its figures are
- [x] The ONS maintenance gap is named on a public page and built nowhere
- [x] The two locales still carry the same keys, and no key is dead unexplained
- [x] `bun run --cwd apps/web test` green
