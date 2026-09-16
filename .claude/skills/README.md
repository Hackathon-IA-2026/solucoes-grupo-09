# Vendored interface-review skills

Not ours. Copied from [jakubkrehel/skills](https://github.com/jakubkrehel/skills)
at commit `267330e1adfc66a718fb65fa6918c1f06d0a689e` (2026-08-29), MIT licensed —
the licence travels with them in `LICENSE` and is not AGPL like the rest of this
repository.

Vendored rather than referenced because a review that depends on a network fetch
is a review that stops working the day the upstream moves, and because the
findings they produce end up in commits here: the exact wording of the rule that
produced a finding should be readable at the commit that answered it.

`better-interface` is the entry point. It orchestrates and owns nothing itself —
it routes to `better-accessibility`, `better-layout`, `better-writing`,
`better-typography`, `better-colors` and `better-ui`, which is why all six are
here and not just the two that were asked for: with an owner missing, that skill
marks its whole domain `Not reviewed` and the review has a hole in it.

**They are written for CSS, Tailwind and `motion`.** This project is
react-native-web, where there is no `cubic-bezier` string, no `box-shadow`
property and no `prefers-reduced-motion` media query — `useReducedMotion` and
`Animated` do that work. The skills say to write every fix in the project's own
idiom, so their exact values are the intent to match, not the literal code to
paste.
