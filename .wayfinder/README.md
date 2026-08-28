# Wayfinder tracker (local markdown)

No issue tracker is configured for this repo, so the map lives here as files.

- `map.md` — the map. Destination, Notes, Decisions so far, Not yet specified,
  Out of scope. Load it once per session; it is an **index**, not a store.
- `tickets/NNN-slug.md` — one ticket per file. Frontmatter carries `id`,
  `title`, `type` (`wayfinder:research|prototype|grilling|task`), `status`
  (`open` / `closed`), `assignee`, `blocked_by` (list of ids).

## Operations

**Frontier** — open, unblocked, unclaimed tickets:

```sh
.wayfinder/frontier.sh
```

**Claim** — set `assignee:` to the dev **before** any work, so concurrent
sessions skip the ticket. An open, unassigned ticket is unclaimed.

**Resolve** — append a `## Resolution` section to the ticket body, set
`status: closed`, and add one line to the map's **Decisions so far** linking
the ticket. The decision lives in the ticket; the map only gists it.

**Rule out of scope** — close the ticket and add one line to the map's
**Out of scope** section. It stays out of Decisions so far.

Refer to tickets by **name** in anything a human reads, never by bare number.
