# Diagnosis tickets — see the combined README

The diagnosis and public-API-surface ticket sets were sliced together, because
the diagnosis output is part of the API's wire contract: the driver rows, the
reason codes and the `data_conditions` group all cross the boundary.

**The dependency graph for both sets — including every cross-spec edge and the
list of what can start in parallel today — lives in
`.scratch/api-surface/issues/00-README.md`.**

Tickets in this directory: `01`–`11`.

The two that can start immediately are **01** (the causality-boundary enforcer)
and **02** (the eight-group driver map). Everything from **03** onward waits on
the forecaster's composition function and its matched background sample, which
are the only two things this spec asks the forecaster's ticket set for.
