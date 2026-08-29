# 01 — Tell the user whose fault it was

**What to build:** when the modelling service refuses a scenario, the user sees
"your scenario is invalid" and not "the service is down"; when the solver gives
up, the user is told *which* way it gave up. Today both come out as one
sentence.

The gateway's proxy module is right and stays. Its failure mapping is the reason
it deserves to exist: an unconfigured upstream URL is distinguished from a
broken one rather than dialling `undefined` and reporting the fetch error as an
upstream fault; a timeout becomes "busy, retry" while a refused connection
becomes "upstream is down, don't bother yet"; an upstream 502/503/504 becomes
"busy" rather than passing through, so a modelling outage is not reported as a
WattSteer bug. Keep all of it, and keep the comment that argues for it.

**Two live defects**, both of which bite the moment the module is pointed at the
solver, which is the only thing that will be left behind it:

1. **Every non-`ok` upstream status that is not 502/503/504 collapses into a
   502.** The modelling service returns **422** for a scenario it re-validated
   and rejected, and **500** for a solver bug. Both currently surface as
   "optimizer unavailable" — a user's bad scenario reads as an outage, and a
   WattSteer bug reads as an outage. Gateway-side validation makes the 422 case
   *unlikely*, not impossible, because the modelling service trusts nothing it
   did not validate itself, by design. **A 4xx from upstream must pass through
   with its code and its body.**
2. **`SOLVER_GAP_UNCLOSED` (503) and `SOLVER_TIMEOUT` (504) are not distinct.**
   Both land in the single "busy" sentence today, and "the gap was not closed"
   is a different thing to tell a user than "we gave up waiting".

Deliberately **not** in this ticket: deleting the forecast route the module
currently carries. That route stays, documented as provisional, until there is a
persisted forecast to serve instead — ticket 11 removes it.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] An upstream 4xx passes through with its own status, its own code and its own body
- [ ] An upstream 422 is distinguishable, at the client, from an unreachable modelling service
- [ ] An upstream 500 is distinguishable from both
- [ ] `SOLVER_GAP_UNCLOSED` and `SOLVER_TIMEOUT` produce distinct statuses and distinct codes
- [ ] An unconfigured upstream URL, a refused connection and a timeout keep their existing three distinct outcomes
- [ ] One test per branch, each asserting a distinct status **and** a distinct code — the module's whole purpose is that the caller can tell whose fault it is
- [ ] The module's design comment survives and is updated to say it is the edge onto the solver
