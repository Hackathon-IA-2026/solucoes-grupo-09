# 02 — The gate page at `/`

**What to build:** bare `/` becomes a small crawlable page that sends a human to
their locale and gives a crawler a real path to both.

Not a blank redirect: it ships visible links to `/pt/` and `/en/` so it works
with JavaScript disabled, plus a client script that reads the stored preference
(or the browser's) and replaces the URL for a real visitor, so nobody sees it
twice.

Two SEO details the spec is specific about, and both are easy to get wrong:
`robots` must be **`noindex,follow`** — the gate has no unique content worth
ranking, but `follow` lets crawl equity reach the two locale roots — and
`robots.txt` must **stay `Allow: /`**. Combining `Disallow` with a `noindex`
meta is a known anti-pattern: a disallowed page is never crawled, so the
`noindex` is never seen, and the URL can still be indexed from external links
with no snippet.

**Blocked by:** 01

**Status:** done

- [x] `/` ships real links to both locale roots and works with JS disabled
- [x] A returning visitor is sent to their stored locale; a new one to their browser's
- [x] `x-default` and both `hreflang` alternates are declared, `x-default` → `/pt/`
- [x] `robots` meta is `noindex,follow`
- [x] `robots.txt` still allows `/` — no `Disallow` for the gate
- [x] The redirect replaces rather than pushes, so Back does not trap the visitor
