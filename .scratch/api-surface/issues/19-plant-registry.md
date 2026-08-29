# 19 — The plant registry, machine-readable, because a licence requires it

**What to build:** a downloadable, machine-readable plant registry in JSON and
CSV, filterable by subsystem and technology.

This endpoint exists for a **licence**, not for a screen, and it is the one
endpoint in this spec that no upstream ticket asked for. The plant table is a
Derivative Database; the share-alike clause pulls it in because public charts are
Publicly Used Produced Works; and the licence then **requires machine-readable
access**. That obligation bites from day one, not at monetisation, and nothing
else in the product discharges it.

It returns the ONS plant code, the version-stripped CEG, the name, the subsystem,
the state, the technology, the operation modality, the municipality, ownership,
and the installed capacity as of the request date, with the as-of date stamped on
the response.

Two shapes carry decisions rather than data:

- **Capacity is a function of time, not an attribute.** It is summed over
  generating units live as of the requested date, never read from a stored
  scalar — fixed present-day weights were measured to misallocate half the
  SE-solar weight mass at window start.
- **Coordinates are optional, and absent means `null`.** A coordinate outside the
  Brazil bounding box, zeros included, is *absent*: nearly two percent of registry
  rows sit at exactly (0,0), and Null Island is not a location. It must never be
  emitted as a zero pair.

The licence notice and the source attribution ride on **this payload**, not only
on the meta endpoint.

**This is flagged as a call for the dev.** If the legal reading is wrong, this
endpoint should go; if it is right, it is not optional, and the bilingual notice
needs to reach the public surfaces too — which is copy, in both locales,
Portuguese first, under the hardcoded-string guard.

**Blocked by:** 04. Also the plant and generating-unit registry ingestion, which
the data-platform ticket set already delivered.

**Status:** done — branch `api-19-plant-registry`

- [x] The registry is downloadable as JSON and as CSV, filterable by subsystem and technology
- [x] Installed capacity is computed as of the request date, and that date is stamped on the response
- [x] An absent coordinate is null and never a zero pair; an out-of-bounds coordinate is treated as absent
- [x] The plant name is never rendered raw from the registry's alias-carrying field
- [x] The licence notice and the source attribution are on the payload itself
- [x] The bilingual notice reaches the public surfaces and passes the hardcoded-string guard
- [x] The legal reading is recorded on the ticket so the endpoint can be withdrawn cheaply if it is wrong

---

## The legal reading, recorded

Written down here so that withdrawing the endpoint is a decision someone can
make in one sitting rather than an archaeology exercise. Every clause below is
from the [ODbL 1.0 text](https://opendatacommons.org/licenses/odbl/1-0/);
`docs/research/plant-registry.md` §7 is the long form.

**The chain, in four steps.**

1. ANEEL SIGA is published under `odc-odbl` (the dataset's own `license_id`).
2. Loading 1,619 SIGA rows' coordinates, municipalities and ownership into
   Postgres, keyed to ONS identifiers, is **Extraction into a new Database** —
   §4.4(b). WattSteer's `plant_geo` is therefore a **Derivative Database**.
3. Charts, KPIs and narration built from it are **Produced Works**, not
   Derivative Databases (§4.5(b)) — so *they* do not trigger share-alike. But
   §4.4(c) says a Derivative Database is Publicly Used, and so must comply with
   §4.4, **if a Produced Work created from it is Publicly Used**. WattSteer
   publishes those charts on a public, unauthenticated site. §4.5(c)'s
   internal-use exemption does not apply: a public site is not "internally
   within an organisation".
4. §4.6 then obliges an offer, free of charge over the internet, of a
   machine-readable copy of **either** the whole Derivative Database **or** a
   file describing the alterations. WattSteer offers both: `GET /v1/plants` is
   (a), `docs/research/plant-registry.md` §7 is (b).

**What is deliberately *not* claimed.** §3.1 grants commercial use explicitly;
charging money changes none of this. The obligation therefore bites from day
one, which is why it is not deferred to a monetisation ticket.

**Two narrowings that keep the boundary tight.**

- §4.5(a)'s Collective Database exemption is what stops share-alike being an
  argument about the whole schema, and it only holds while the SIGA-sourced
  columns live in their own table. They do: `plant_geo`. ONS (CC-BY) capacity
  and commissioning stay in `generating_unit`.
- §2.4 does not license rights in individual Contents, and SIGA's
  `DscPropriRegimePariticipacao` carries **CNPJs of named legal persons**. It is
  ingested because ownership is a modelled attribute; it is **not** published by
  this endpoint. `owner_name` / `operator_name` on the payload are ONS's agent
  names, which are CC-BY. A test asserts the CNPJ text never reaches the wire.

**If the reading is wrong, withdrawing costs:** delete `apps/api/src/api/plants.ts`,
`apps/api/src/contract/plant-registry.ts`, their two test files, the
`canonical_plant_registry` view (a `drop view` migration), the
`registryAccess` copy key in both locales and the two lines that render it, and
the `SOURCE_ATTRIBUTION` / `ODBL_*` constants in `packages/core/src/constants.ts`.
Nothing else in the product imports any of it — that isolation is deliberate.
