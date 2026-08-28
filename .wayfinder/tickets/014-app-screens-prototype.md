---
id: "014"
title: The four /app screens
type: wayfinder:prototype
status: open
assignee:
blocked_by: ["006", "013"]
---

## Question

What do Grid Overview, Explain, Mitigate and Time Machine actually look like,
built in the existing design system?

IDEA.md §42–45 sketches them in ASCII. The prototype raises fidelity enough to
react to.

- **Grid Overview**: four subsystems with risk %, a colour scale, and the
  24-hour MW profile with its P10–P90 band. How is risk colour-coded without
  implying precision the model does not have?
- **Explain**: the driver breakdown, the narration, and the reliability curve.
- **Mitigate**: the stepwise "no action → + battery → + flexible load" reveal,
  with asset parameters editable. This is the screen that sells the product.
- **Time Machine**: the §45 / §47 comparison, plus its honesty labelling from
  ticket 012.
- Navigation between them, and whether subsystem and date live in the URL.
- Which template components survive, which need replacing, and what new charts
  are needed — this is the fog patch the map calls "chart component inventory",
  and this ticket should graduate it.
- Behaviour on mobile, since the same code ships to iOS and Android.

Use `/prototype`. Build it against fixture data — the point is the shape, not
the pipeline. Link the prototype as an asset.
