# The web app

Expo SDK 57, React Native Web, Expo Router, exported as a **static site**
(`bun run web:export` → `apps/web/dist`, served by `apps/web/server.ts`).

**Read the versioned Expo docs before writing Expo code**: the SDK moves and
`apps/web/AGENTS.md` says so at <https://docs.expo.dev/versions/v57.0.0/>.

## react-native-web is not CSS, and the differences have cost time

- **`flexShrink` defaults to `0`** where CSS defaults it to `1` (ADR-0001). A
  `flexBasis` without an explicit `flexShrink` is a **floor**, not a preference:
  the box sizes to its content and never gives anything back. A row that clips
  at 400 px but not at 1440 is almost always this. Shrink the row *and* the
  `Text` — shrinking only the child is not enough, because the parent sizes to
  content first and never asks.
- **A `.tsx` file exports components and nothing else** (ADR-0002). Helpers,
  constants and hooks go in a `.ts` beside it — Fast Refresh remounts a module
  that mixes them.
- **An SVG `Path` takes no `role` prop** (ADR-0003). Put the semantics on the
  wrapper.
- **Contrast is measured from the tokens, not by axe** (ADR-0004): axe cannot
  read a colour that never reaches the DOM as a computed style.

## The static export has no server, so the URL arrives late

`use-app-params.ts` — read it in full before touching the selection. The export
prerenders with defaults, so the hook deliberately does **not** read the URL on
the first client render: hydration must match, and only the second render may
differ. React diffs a re-render against its own virtual tree, not the DOM, so
"compute it correctly on the first render" silently leaves the markup and the
app disagreeing for the life of the page. That was measured, and the cost of the
current shape is one frame of default selection on a deep link.

The bundle is one chunk and mostly framework (ADR-0007); do not chase code
splitting without reading it.

## Reads and absences

One hook per read, three states — `reading` / `read` / `refused` — and a
**re-read keeps the previous answer on screen**, marked, rather than collapsing
to a skeleton. Selecting a region once collapsed a section from 618 px to 331 px
under a reader mid-sentence; `use-network.ts` states the rule and the others
follow it.

`/v1/meta` is read **once**, through `ServingProvider`, because two readers of
one fact must never disagree. The model card is read once per lane through
`use-model-card.ts`, for the same reason.

Render the absence the gateway stated. Never `?? 0`, never an empty panel —
see [`honesty.md`](honesty.md).

## Layout

Tokens from `@wattsteer/ui`: `space` is `xs:4 sm:8 md:12 lg:16 xl:24`; press
scale is `0.96` via `usePressScale`, which returns `1` under reduced motion.

The Overview's grid arithmetic is load-bearing and documented where it lives
(`overview-hero.tsx`): five cards above, three columns below, and the map is
worth exactly three cards plus the two gaps between them — which only closes
when both rows use the same gap.

## Tests

`bun run test:web` is the unit suite; `bun run test:e2e` drives a **real
export** in Chromium. The export is what catches a class of defect a dev server
cannot, so do not replace it with a dev-server run. The server caches HTML at
boot: after `web:export`, restart it or you are testing the previous build.
