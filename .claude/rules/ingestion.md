# Ingestion

ONS's CKAN catalogue plus a weather source, into a bitemporal record.
`docs/specs/data-platform.md` is the authority; `docs/research/ons-datasets.md`
records what each dataset actually contains.

## Resource URLs are read, never constructed

`apps/api/src/ingest/ons/catalogue.ts` — `package_show` on
`https://dados.ons.org.br/api/3/action`. The S3 path segment is frequently not
the CKAN slug and filenames are irregular, so a constructed URL is a guess that
works until it does not.

## The adapter is where a convention dies

Everything ONS got wrong or said oddly is resolved **at the adapter**, so no
feature and no route can meet it: the padded subsystem code, `SECO` → `SE`, the
`SIN` aggregate row, average power vs energy, end-of-interval timestamps,
half-hour → hour.

Two decisions worth knowing before you add one:

- **A half-empty hour is a hole, not a half-sized one.** `programmed_load`'s
  hour is summed only where both half hours survive the gate; with one, the hour
  would publish at roughly half its true size, which looks exactly like a quiet
  evening.
- **A publication instant that the source does not give is decided at the
  adapter, with the argument in the file.** `programmePublishedAt` in
  `ons/load.ts` stamps the programme for day D at D−1 15:00 BRT, because the
  fetch instant would have made `published_at > valid_time` on every row — the
  shape `docs/domain-model.md` §4 reserves for an **Observation**, inverting the
  one structural guarantee that stops a forecast being read as an actual.

## The three refresh tiers

`apps/api/src/ingest/refresh.ts` — `live` hourly (`17 * * * *`), `recent`
Mondays, `history` monthly, which is the bulk-republication detector. A source
belongs in `live` when yesterday's cut is unrecoverable upstream (the plant
registry and SIGA are overwritten in place twice a day, so they are there
despite having no period at all).

## Upstream silence is a real state, and the health surface is where you look

`GET /ingest/health` gives, per source: `latestValidTime`, `latestIngestedAt`,
`lagHours` against a per-source `toleranceHours`, `stale`, `lastRunStatus`,
`failedRuns24h` and `republications30d`.

**`lastRunStatus: "ok"` with `stale: true` means the job ran and there was
nothing to fetch.** That is the shape of an upstream gone quiet, and it is not a
bug in the adapter. On 2026-09-18 `dessem_balance` read `ok` with a 108 h lag;
ONS's own catalogue for `balanco_dessem_detalhe` had published nothing since the
14th. Check the catalogue before you debug the adapter:

```
curl -s "https://dados.ons.org.br/api/3/action/package_show?id=<slug>" \
  | python3 -c "import sys,json,re; …"
```

A silence that outlasts the tolerance is an operator's problem, not a code
change. What the *code* owes is saying so — see the `latest_programmed_day` on
`/v1/similar-days`'s refusal, and `unusable_reason` on `/v1/meta`.

## Archive and custody

Payloads are archived and a retention pass runs weekly, **after** the weekly
sweep: retention should never be the reason a payload the sweep was about to
reprocess is gone.
