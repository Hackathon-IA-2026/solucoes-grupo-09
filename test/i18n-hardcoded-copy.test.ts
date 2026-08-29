import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * User-visible copy must go through the dictionaries.
 *
 * Every string on the site already lives in `apps/web/src/i18n/`, and the
 * `Copy` type makes a *missing* translation a compile error. What nothing
 * catches is a new component shipping with English baked into its JSX — which
 * is exactly how a bilingual product quietly becomes monolingual again, one
 * screen at a time. The type system cannot see that failure, because a literal
 * is a perfectly valid string.
 *
 * The standard tool for this is `eslint-plugin-i18next`'s `no-literal-string`.
 * This repo lints with Biome, so that rule is not available; the substitute is
 * a repo-level check in the shape of `repo-hygiene.test.ts`, which already
 * demonstrates the pattern by forbidding a token repo-wide.
 *
 * **This is a heuristic and says so.** A regex cannot parse JSX, so it looks
 * for the two shapes that account for essentially all real leaks:
 *
 *  A. a **copy-carrying prop** assigned a string literal — `title="…"`,
 *     `label="…"`, `accessibilityLabel="…"` and friends, including the same
 *     names as object keys, which is where a screen or step table hides them;
 *  B. a **JSX text node** — words sitting directly between `>` and `<`.
 *
 * Everything else is deliberately out of scope. `testID`, `accessibilityRole`,
 * `pathname`, `href`, `key`, `name`, `code` and every style property are not
 * copy and are never inspected: the check is keyed on the prop name, so a
 * route or a test id can stay a literal without an exemption.
 * `accessibilityLabel` is inspected, though, because a screen reader reading
 * English over a Portuguese page is the same bug with a smaller audience.
 */

const ROOT = join(import.meta.dir, "..");

/** Where user-visible copy is rendered. Scoped honestly, per the ticket. */
const SCOPE = [
  join("apps", "web", "src", "app"),
  join("apps", "web", "src", "components"),
];

/**
 * Props whose value is read by a human. An object key of the same name counts:
 * `{ label: "Grid Overview" }` in a table of screens is the same leak as
 * `label="Grid Overview"` in JSX, and is where it usually hides.
 */
const COPY_PROPS = [
  "label",
  "title",
  "subtitle",
  "lede",
  "heading",
  "headline",
  "footnote",
  "note",
  "caption",
  "detail",
  "placeholder",
  "alt",
  "description",
  "observedLabel",
  "accessibilityLabel",
  "accessibilityHint",
];

/**
 * Vocabulary that is identical in `pt` and `en`, and therefore is not a
 * translation failure when it appears inline.
 *
 * Two families, both settled by `docs/specs/i18n.md` and the domain model's
 * naming rule 2:
 *
 *  - **ONS/ANEEL's own vocabulary.** "Curtailment" has no clean Portuguese
 *    equivalent and the sector's own term is the English "constrained-off";
 *    `conjunto` is a reporting grain that would be blurred by translating it
 *    to "cluster". The institutions, the reason codes and the subsystem
 *    display names are proper nouns.
 *  - **Notation and units.** `P10`–`P90`, `MW`, `MWh`, `R$`, `BRT`: symbols,
 *    not words.
 *
 * Deliberately short. The instinct when this check fires is to widen the list
 * until it stops firing, at which point it means nothing — so a term earns a
 * place here only if it genuinely renders the same in both locales.
 */
const DOMAIN_TERMS = [
  // ONS / ANEEL vocabulary and institutions
  "constrained-off",
  "conjunto",
  "conjuntos",
  "ONS",
  "ANEEL",
  "SIN",
  "SIGA",
  "DESSEM",
  "BESS",
  "SOC",
  "SHAP",
  "MILP",
  "SCIP",
  // Reason codes and restriction origins, verbatim from the ONS dictionary
  "REL",
  "CNF",
  "ENE",
  "PAR",
  "LOC",
  "SIS",
  // Subsystem display names and their short forms
  "NORTE",
  "NORDESTE",
  "SUDESTE",
  "CENTRO-OESTE",
  "SUL",
  "SE",
  "CO",
  "NE",
  // The product's own name
  "WattSteer",
  // Notation, units and symbols
  "P10",
  "P50",
  "P90",
  "MW",
  "MWh",
  "GW",
  "GWh",
  "kV",
  "kW",
  "kWh",
  "BRT",
  "UTC",
  "RTE",
  "PV",
  "km",
];

/**
 * Exceptions, each with the reason it is one.
 *
 * There are none. The list exists so that the next one has to be written down
 * rather than absorbed into `DOMAIN_TERMS`, where it would quietly widen the
 * check for everything else too.
 */
const EXCEPTIONS: { file: string; reason: string }[] = [];

const SKIP_DIRS = new Set(["node_modules", "dist", ".expo"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        walk(full, out);
      }
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Remove comments and imports before looking for copy.
 *
 * These files carry long explanatory block comments, and an import path is a
 * module specifier rather than a sentence; both would otherwise dominate the
 * findings with noise and teach the reader to ignore this test.
 */
function strip(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?from\s+"[^"]*";$/gm, "");
}

const WORD = /[A-Za-zÀ-ÿ]{3,}/;

/**
 * Is this fragment still copy once the shared vocabulary is taken out of it?
 *
 * A candidate is reduced by deleting every allowed domain term, every number,
 * and every piece of punctuation. Whatever survives is prose that only one of
 * the two locales can read — and if nothing survives, the fragment was
 * notation all along.
 */
function residue(text: string): string {
  let rest = text;
  for (const term of DOMAIN_TERMS) {
    rest = rest.replace(new RegExp(`\\b${term}\\b`, "gi"), " ");
  }
  return (
    rest
      // Placeholders are filled with formatted values, not with words.
      .replace(/\{[^}]*\}/g, " ")
      // `snake_case` and `camelCase` identifiers are keys, not sentences.
      .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/gi, " ")
      .replace(/[\d.,:;·—–\-+%/()[\]|~`'"!?°ºª§#@$&*=<>\\]/g, " ")
  );
}

function isCopy(text: string): boolean {
  return WORD.test(residue(text));
}

interface Offender {
  file: string;
  line: number;
  text: string;
}

function findOffenders(file: string, source: string): Offender[] {
  const stripped = strip(source);
  const found: Offender[] = [];
  const lineOf = (index: number) => stripped.slice(0, index).split("\n").length;

  // A. A copy-carrying prop, or object key, assigned a string literal.
  const propPattern = new RegExp(
    `\\b(${COPY_PROPS.join("|")})\\s*[=:]\\s*(?:\\{\\s*)?(["'\`])((?:\\\\.|[^\\\\])*?)\\2`,
    "g",
  );
  for (const match of stripped.matchAll(propPattern)) {
    if (isCopy(match[3])) {
      found.push({
        file,
        line: lineOf(match.index ?? 0),
        text: `${match[1]}=${JSON.stringify(match[3])}`,
      });
    }
  }

  // B. A JSX text node: words sitting directly between two tags. Anything
  // containing an operator, a brace or a quote is expression territory, not a
  // text node, and is left alone rather than guessed at.
  for (const match of stripped.matchAll(/>([^<>{}"'`=;()]+)</g)) {
    const text = match[1].trim();
    // Two words, or one capitalised one: enough to be a sentence fragment,
    // little enough that `</Text>\n  <View` and stray operators do not qualify.
    const words = text.split(/\s+/).filter((w) => WORD.test(w));
    const looksLikeProse = words.length > 1 || /^[A-ZÀ-Þ]/.test(text);
    if (looksLikeProse && isCopy(text)) {
      found.push({ file, line: lineOf(match.index ?? 0), text });
    }
  }

  return found;
}

describe("i18n hygiene", () => {
  it("has no user-visible copy written inline instead of in the dictionaries", () => {
    const exempt = new Set(EXCEPTIONS.map((e) => e.file));
    const offenders: string[] = [];

    for (const root of SCOPE) {
      for (const file of walk(join(ROOT, root))) {
        const rel = relative(ROOT, file);
        if (exempt.has(rel)) {
          continue;
        }
        for (const found of findOffenders(rel, readFileSync(file, "utf8"))) {
          offenders.push(`${found.file}:${found.line}: ${found.text}`);
        }
      }
    }

    // Reported in full rather than one at a time: a screen that was written
    // without the dictionaries should be visible as a screen, not as a
    // sequence of thirty separate failures.
    expect(offenders).toEqual([]);
  });

  it("scans the directories the ticket scopes it to", () => {
    // A check that silently stops walking anything passes forever. Assert it
    // is actually reading the two trees, and a realistic number of files.
    const scanned = SCOPE.flatMap((root) => walk(join(ROOT, root)));
    expect(scanned.length).toBeGreaterThan(20);
  });

  it("still catches a leak, and still lets the domain vocabulary through", () => {
    // The check has to fail on the thing it exists for. If a future refactor
    // of the heuristic stops matching, this is what says so.
    const leak = findOffenders(
      "fake.tsx",
      "<Text>Expected curtailed energy, whole day</Text>",
    );
    expect(leak).toHaveLength(1);

    const alsoLeak = findOffenders("fake.tsx", '<Panel title="Grid Overview" />');
    expect(alsoLeak).toHaveLength(1);

    // Untranslated in both locales: ONS vocabulary, notation, units, ids.
    const clean = findOffenders(
      "fake.tsx",
      [
        "<Text>P10–P90 · 4.180 MWh</Text>",
        '<Badge label="NORDESTE" />',
        '<Badge label="REL" />',
        "<Text>conjunto</Text>",
        '<Panel testID="showcase-explain" accessibilityRole="button" />',
        '<Link href="/app/explain" pathname="/app" />',
        '<View style={{ flexDirection: "row", alignItems: "center" }} />',
      ].join("\n"),
    );
    expect(clean).toEqual([]);
  });
});
