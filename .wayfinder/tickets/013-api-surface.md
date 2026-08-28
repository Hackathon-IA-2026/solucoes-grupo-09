---
id: "013"
title: Public API surface
type: wayfinder:grilling
status: open
assignee:
blocked_by: ["009", "010", "011", "012"]
---

## Question

What does Elysia expose to the web app, and what does it proxy to the Python
service?

IDEA.md §41 sketches `GET /forecast`, `GET /diagnosis`, `POST /optimize`.

- Full endpoint list including the landing page's live grid data, the replay
  endpoints, and whatever the four screens need.
- Response shapes, in the vocabulary from ticket 006.
- Which endpoints are cached and for how long — forecasts change daily, replays
  never change.
- Where the boundary sits: does Elysia call the Python service per request, or
  does the worker precompute forecasts nightly into Postgres so the public API
  never depends on the ml service being up? This materially changes the failure
  modes.
- Rate limiting posture for a public unauthenticated API.
- Error contract, and what the UI shows when a forecast is unavailable.
- Whether `packages/core` still holds a typed API client and shared types the
  way it did for Zalytix — it is the natural home, and the parity-test pattern
  from the template may transfer.

Use `/grilling`.
