# Lint policy (Biome, all groups enabled)

Every Biome rule group runs at `recommended` strictness plus explicitly
promoted rules. Rules below are deliberately disabled — each with the
reason — so the config stays at zero warnings without hiding real signal.

| Rule | Why it's off |
| --- | --- |
| `style/noMagicNumbers` | Design tokens, chart geometry and layout math are inherently numeric; naming every constant would bury the signal. |
| `style/noJsxLiterals` | Product copy lives in JSX by design (no i18n layer yet). |
| `style/noProcessEnv`, `correctness/noProcessGlobal` | Expo inlines `EXPO_PUBLIC_*` only for literal `process.env.X` member expressions; importing `node:process` breaks that and the native bundle. |
| `correctness/noNodejsModules` | The API/CLI/scripts are server-side Bun programs. |
| `suspicious/noConsole` | The API logs operational events intentionally; scripts/probes report progress. |
| `suspicious/noEmptyBlockStatements` | Best-effort `catch {}` is a deliberate contract where a non-critical failure must never fail the operation around it. |
| `suspicious/useAwait` | `JobRunner` implementations satisfy an async interface even when a body is synchronous. |
| `suspicious/noBitwiseOperators` | Seeded RNG (mulberry32) and FNV hashing require bitwise math. |
| `performance/noAwaitInLoops` | Upstream pagination and job polling are sequential by design (rate-limit friendliness). |
| `performance/useTopLevelRegex` | Format/parse helpers run at human scale; locality beats micro-optimization. |
| `performance/noReExportAll`, `noBarrelFile`, `noNamespaceImport` | `@wattsteer/core` / `@wattsteer/ui` expose deliberate public-API barrels; `import * as Haptics` is the expo-haptics contract. |
| `style/noDefaultExport` | expo-router requires default exports for routes. |
| `style/useExportsLast`, `noNestedTernary`, `useNamingConvention`, `noParameterProperties`, `noImplicitBoolean` | Conflict with established codebase idiom (tone ternaries, RN prop style). |
| `style/noCommonJs` | React Native asset loading requires `require()`. |
| `complexity/noExcessiveLinesPerFunction`, `noExcessiveCognitiveComplexity`, `useMaxParams` | React component render bodies; splitting hurts cohesion. |
| `complexity/noVoid` | `void promise` is the codebase's fire-and-forget marker. |
| Tests/e2e: `noMisplacedAssertion`, `noSecrets` | Assertion helpers and fixture URLs/payloads are the point of test code. |

## React Doctor (`apps/web/doctor.config.json`, `packages/ui/doctor.config.json`)

React Doctor runs with every rule enabled except the suppressions below.

| Rule | Scope | Why it's off |
| --- | --- | --- |
| `react-doctor/rn-prefer-reanimated` | both packages | The hero float/fade loops use the built-in RN `Animated` API on purpose — pulling in `react-native-reanimated` would add substantial web-bundle weight for two decorative animations, working against the Lighthouse performance budget. |
| `deslop/unused-export` | `src/components/top-nav.tsx` | `TopNavFull` is exported-but-unused while the landing page is a placeholder; it is the full reference top nav, kept for the real landing page and the product screens. |
| `react-doctor/rn-no-scrollview-mapped-list` | `src/components/legal-screen.tsx` | Deliberate: the legal pages must render every section eagerly for SEO (static-export HTML) and for the scroll-measured TOC; a virtualized FlatList would omit offscreen sections. |
