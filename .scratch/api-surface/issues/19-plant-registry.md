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

**Status:** ready-for-agent

- [ ] The registry is downloadable as JSON and as CSV, filterable by subsystem and technology
- [ ] Installed capacity is computed as of the request date, and that date is stamped on the response
- [ ] An absent coordinate is null and never a zero pair; an out-of-bounds coordinate is treated as absent
- [ ] The plant name is never rendered raw from the registry's alias-carrying field
- [ ] The licence notice and the source attribution are on the payload itself
- [ ] The bilingual notice reaches the public surfaces and passes the hardcoded-string guard
- [ ] The legal reading is recorded on the ticket so the endpoint can be withdrawn cheaply if it is wrong
