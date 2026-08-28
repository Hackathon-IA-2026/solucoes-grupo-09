# 03 — Per-locale SEO artifacts

**What to build:** the machine-readable surface tells the truth about both
locales.

`sitemap.xml` lists the six real pages and not the gate. Every page declares its
own canonical plus `hreflang` alternates pointing at its counterpart. The
manifest carries per-locale name and description.

`<html lang>` is the known hard part, and the spec flags it as unresolved:
`+html.tsx` is a single global document shell with no per-route access, so the
attribute cannot vary per page from React alone. It is currently pinned to
`pt-BR` because the export was Portuguese-only — once both locales are
prerendered that becomes wrong for half the pages. The spec proposes a
post-export HTML rewrite and explicitly marks it **unverified**. Verify it
before building on it, and if it does not work, say so rather than shipping a
wrong `lang` on the English tree.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `sitemap.xml` lists exactly the real indexable pages, not the gate
- [ ] Each page declares its own canonical and both `hreflang` alternates
- [ ] `manifest.webmanifest` carries per-locale name and description
- [ ] `<html lang>` is correct on every prerendered page, or the limitation is documented with evidence
- [ ] `llms.txt` describes both locales
