import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * There is exactly **one** implementation of the execution rule. This is the
 * edge that keeps it one.
 *
 * `docs/specs/flex-optimizer.md` calls it "the single most important line" in
 * the spec: *the simulator that scores a live plan and the one that scores a
 * replayed plan are the same function, imported, not reimplemented.* A backtest
 * number and a forecast number are the same kind of number because of that and
 * because of nothing else. Every other test around the optimizer runs against
 * code that exists; this one asserts a property of the **repository**, because
 * "there is only one of these" is otherwise an unverifiable claim that decays
 * the first time somebody in a hurry needs the rule somewhere the import is
 * inconvenient.
 *
 * **It runs here, in `bun test ./test/`, which is the default `bun run test`.**
 * `docs/specs/api-surface.md` seam 8 asks for the count "run in the default
 * path, asserted against the whole repository including `apps/web`", and a
 * guard that only runs under `bun run check:ml` is a guard the change that
 * needs guarding will not run. It reads Python as well as TypeScript, because
 * the one site is Python and the copy this test exists to refuse would most
 * likely be TypeScript.
 *
 * **One site, not a list to append to.** `apps/web` used to hold a second,
 * proved identical against shared golden vectors; `docs/specs/api-surface.md`
 * decision 6 deleted it rather than porting it, because a proved-identical copy
 * is still a copy and this one was known wrong (it clipped absorption but not
 * the state of charge). Adding an entry to {@link REGISTERED} without deleting
 * a site is a change to that decision, not a change to a test.
 *
 * **How this resists a well-meaning copy**, which is the failure mode worth
 * designing for — nobody reimplements the rule in bad faith, they reimplement
 * it because Replay needed it and importing across a package felt heavy:
 *
 *  1. The files it governs are **discovered by walking the repository**, never
 *     listed. A new file cannot escape by not being named in this test.
 *  2. The detector is a **vocabulary co-occurrence** scan, not a search for a
 *     marker comment or a function name. A copy written in fresh names — `room`
 *     for headroom, `level` for the state of charge, `spilled` for the
 *     realisation — still trips it, because it must still speak about charging,
 *     discharging, a state of charge, an efficiency, a realisation and
 *     absorption, and it must still clip. Drop any one of those and it stops
 *     being the rule.
 *  3. Comments and string literals are **stripped before matching**, so a file
 *     that merely *documents* the rule is not a hit and nobody has to weaken the
 *     detector to make prose legal. This file's own doc comments and its
 *     controls, which are string literals, are covered by that.
 *  4. The detector's sensitivity is pinned by {@link POSITIVE_CONTROLS} — two
 *     plausible second implementations, one per language, sharing not one
 *     identifier with the registered site and held as *strings* rather than as
 *     files. Loosening the detector far enough to let a real copy through
 *     breaks the controls first, so the cheap way out of a failure is closed.
 *  5. {@link NEGATIVE_CONTROLS} pins the other end: the MILP builder, which
 *     speaks the same vocabulary while expressing the rule as *constraints*
 *     rather than executing it, must not be flagged. Tightening the detector
 *     until a failure goes away breaks these.
 *
 * What it cannot do is stop somebody editing this file, and it does not pretend
 * to. It makes a second copy a deliberate, reviewable act with a written
 * justification attached, instead of an accident nothing notices.
 */

/** `test/` → the repository root. */
const ROOT = join(import.meta.dir, "..");

/**
 * The one implementation. Not a list to append to: a second entry is the thing
 * this file exists to prevent.
 */
const PYTHON_SITE = join(
  "apps",
  "ml",
  "src",
  "wattsteer_ml",
  "optimizer",
  "simulator.py",
);
const REGISTERED: readonly string[] = [PYTHON_SITE];

const SOURCE_SUFFIXES = [".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "node_modules",
  "dist",
  "build",
  ".expo",
  ".next",
  "test-results",
  "playwright-report",
  ".ruff_cache",
  ".mypy_cache",
  ".pytest_cache",
]);

/** One thing the execution rule cannot be written without. */
interface Concept {
  readonly name: string;
  readonly pattern: RegExp;
}

function concept(name: string, ...alternatives: string[]): Concept {
  return { name, pattern: new RegExp(alternatives.join("|"), "i") };
}

/**
 * The six lexical concepts. Each carries every synonym a reasonable author
 * might reach for, because the point is to catch a copy written in *different*
 * words — matching one vocabulary would only catch a copy-paste, which is the
 * easy case and not the one that happens.
 */
const CONCEPTS: readonly Concept[] = [
  concept(
    "state of charge",
    "\\bsoc\\b",
    "state_?of_?charge",
    "stored",
    "storage_?level",
    "energy_?level",
    "charge_?level",
    "charge_?state",
    "\\blevel\\b",
  ),
  concept(
    "efficiency",
    "efficien",
    // Not `\beta\b`: an underscore is a word character, so that would miss
    // `one_way_eta` — exactly the sort of name a second implementation gets
    // written with.
    "(?<![a-z])eta(?![a-z])",
    "\\brte\\b",
    "round_?trip",
    "one_?way",
    "\\blosses?\\b",
  ),
  concept("the charging leg", "charg(e|ing)", "\\bin_?flow", "\\bintake"),
  concept(
    "the discharging leg",
    "dis_?charg(e|ing)",
    "\\bdrawn?\\b",
    "\\bdrain",
    "\\brelease",
    "withdraw",
    "\\bout_?flow",
  ),
  concept(
    "a realisation of the day",
    "offered",
    "realisation",
    "realization",
    "curtail",
    "\\bcurt\\b",
    "spill",
    "constrained_?off",
  ),
  concept("absorption", "absorb", "recovered", "avoided"),
];

/**
 * The seventh, detected structurally rather than by pattern: a call to `min` /
 * `Math.min` / `clamp` **with more than one argument**. The rule *clips* — "the
 * scheduled amount or what actually arrived, whichever is smaller" is a
 * two-argument comparison — where a model *constrains*. That is the whole
 * difference between executing the rule and building the MILP that plans
 * against it, and it is why `milp.py` speaks every concept above and is still
 * not a hit. A one-argument aggregate over a sequence is not a clip.
 */
const CLIPPING = "clipping";

const CLIP_CALL = /(?:\bMath\.min|\bmin|\bclamp)\s*\(/gi;

/** Is one quantity anywhere held down to another? */
function hasClipping(code: string): boolean {
  CLIP_CALL.lastIndex = 0;
  for (let call = CLIP_CALL.exec(code); call !== null; call = CLIP_CALL.exec(code)) {
    let depth = 0;
    for (let i = call.index + call[0].length; i < code.length; i++) {
      const character = code[i];
      if (character === "(" || character === "[" || character === "{") {
        depth++;
      } else if (character === ")" || character === "]" || character === "}") {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (character === "," && depth === 0) {
        return true;
      }
    }
  }
  return false;
}

const CONCEPT_NAMES: readonly string[] = [
  ...CONCEPTS.map((each) => each.name),
  CLIPPING,
].sort();

/**
 * A plausible second implementation, in Python — the one somebody writes when
 * Replay needs the rule and importing across a package feels heavy. It shares
 * no identifier with `wattsteer_ml.optimizer.simulator`: not a name, not a
 * field, not the shape of the loop. If the detector stops flagging it, the
 * detector has been loosened past the point of catching a real one.
 */
const PYTHON_CONTROL = `
def score_replay(schedule, observed_mwh, cell):
    level = cell.opening_mwh
    recovered = 0.0
    for hour, curtailed in enumerate(observed_mwh):
        room = cell.ceiling_mwh - level
        charged = min(schedule.charge_mw[hour], room / cell.one_way_eta, curtailed)
        drawn = min(
            schedule.discharge_mw[hour],
            (level - cell.floor_mwh) * cell.one_way_eta,
        )
        level += cell.one_way_eta * charged - drawn / cell.one_way_eta
        recovered += max(0.0, min(charged - drawn, curtailed))
    return recovered
`;

/**
 * The same, in TypeScript, and a different shape again — a `reduce` rather than
 * a loop, camelCase throughout — so the two controls share no giveaway between
 * them either.
 */
const TYPESCRIPT_CONTROL = `
export function scoreReplay(schedule, observedMwh, cell) {
  let level = cell.openingMwh;
  return observedMwh.reduce((recovered, curtailed, hour) => {
    const room = cell.ceilingMwh - level;
    const charged = Math.min(
      schedule.chargeMw[hour],
      room / cell.roundTripEta,
      curtailed,
    );
    const drawn = Math.min(
      schedule.dischargeMw[hour],
      (level - cell.floorMwh) * cell.roundTripEta,
    );
    level += cell.roundTripEta * charged - drawn / cell.roundTripEta;
    return recovered + Math.max(0, Math.min(charged - drawn, curtailed));
  }, 0);
}
`;

const POSITIVE_CONTROLS: readonly [string, string, string][] = [
  ["python", "py", PYTHON_CONTROL],
  ["typescript", "ts", TYPESCRIPT_CONTROL],
];

/**
 * The other end of the calibration. Each speaks most of the vocabulary and none
 * of them executes the rule: the first *constrains* a model that plans against
 * it, the second *calls* the one implementation, and the last two only describe
 * it — one in a `//` comment, one in a Python docstring, because the two
 * languages are stripped by two different pieces of code and a stripper that
 * went blind in one of them would otherwise flag every file that explains the
 * rule.
 */
const NEGATIVE_CONTROLS: readonly [string, string, string][] = [
  [
    "the MILP builder, which constrains rather than clips",
    "py",
    `
def build(solver, curt, battery):
    for hour, offered in enumerate(curt):
        soc = solver.NumVar(battery.soc_floor_mwh, battery.soc_ceiling_mwh, "soc")
        charge = solver.NumVar(0.0, battery.charge_limit_mw, "ch")
        discharge = solver.NumVar(0.0, battery.discharge_limit_mw, "dis")
        absorbed = solver.NumVar(0.0, offered, "absorb")
        solver.Add(
            soc
            - battery.charge_efficiency * charge
            + discharge / battery.discharge_efficiency
            == battery.initial_soc_mwh
        )
        solver.Add(absorbed <= charge - discharge)
`,
  ],
  [
    "a caller, which imports the one implementation",
    "py",
    `
from wattsteer_ml.optimizer import simulate

def score(plan, p10, p50, threshold_mw):
    floor = simulate(plan, p10, threshold_mw=threshold_mw)
    median = simulate(plan, p50, threshold_mw=threshold_mw)
    return min(floor.recovered_mwh, median.recovered_mwh)
`,
  ],
  [
    "prose about the rule in TypeScript, which is not the rule",
    "ts",
    `
// On the day an asset charges the scheduled amount or the amount actually
// being curtailed, whichever is smaller, and discharges the scheduled amount
// or what its state of charge permits: Math.min(charge, offered, headroom).
// Absorbed energy is the net increase in flexible demand, after efficiency.
export const EXECUTION_RULE = "follow_curtailment";
`,
  ],
  [
    "prose about the rule in a Python docstring, which is not the rule either",
    "py",
    `
"""On the day an asset charges the scheduled amount or the amount actually
being curtailed, whichever is smaller — min(charge_mw, offered, headroom / eta)
— and discharges what its state of charge permits. Absorbed energy is the net
increase in flexible demand, after the round-trip efficiency; what the battery
recovered is never more than what was spilled.
"""

RULE = "follow_curtailment"
`,
  ],
];

/**
 * Python code with its comments and string literals removed — docstrings
 * included, which is the whole point: a module that *documents* the rule must
 * not be a hit, or the honest response to this test failing would be to delete
 * an explanation.
 *
 * Triple-quoted forms are matched first so a docstring is consumed whole rather
 * than as three empty strings, and an optional literal prefix (`r`, `f`, `b`,
 * `rb`, …) is consumed with the quote so a prefixed string is not left half
 * standing.
 */
const PYTHON_NOISE =
  /[rRbBuUfF]{0,3}'''[\s\S]*?'''|[rRbBuUfF]{0,3}"""[\s\S]*?"""|[rRbBuUfF]{0,3}"(?:\\[\s\S]|[^"\\\n])*"|[rRbBuUfF]{0,3}'(?:\\[\s\S]|[^'\\\n])*'|#[^\n]*/g;

function stripPython(source: string): string {
  return source.replace(PYTHON_NOISE, " ");
}

/** The same for TypeScript and its relatives: comments and every string form. */
const TYPESCRIPT_NOISE =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g;

function stripTypescript(source: string): string {
  return source.replace(TYPESCRIPT_NOISE, " ");
}

function codeOf(suffix: string, source: string): string {
  return suffix === "py" ? stripPython(source) : stripTypescript(source);
}

function conceptsIn(code: string): string[] {
  const found = CONCEPTS.filter((each) => each.pattern.test(code)).map(
    (each) => each.name,
  );
  if (hasClipping(code)) {
    found.push(CLIPPING);
  }
  return found.sort();
}

/** Every concept present in executable code. Not most of them: all of them. */
function implementsTheRule(suffix: string, source: string): boolean {
  const found = conceptsIn(codeOf(suffix, source));
  return CONCEPT_NAMES.every((name) => found.includes(name));
}

function suffixOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1);
}

/**
 * Every source file in the repository — **discovered, not listed**.
 *
 * This is the property that makes the assertion below worth running. A guard
 * that enumerated the files it knows about would be escaped by the next file
 * anyone adds, silently and while still reading green.
 */
function sourceFiles(): string[] {
  const found: string[] = [];
  const stack = [ROOT];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(path);
        }
      } else if (SOURCE_SUFFIXES.some((each) => entry.name.endsWith(each))) {
        found.push(relative(ROOT, path));
      }
    }
  }
  return found.sort();
}

describe("the detector is calibrated", () => {
  // Before the scan is evidence of anything, it has to be able to fail.
  for (const [name, suffix, source] of POSITIVE_CONTROLS) {
    test(`a second implementation in ${name} is detected`, () => {
      const missing = CONCEPT_NAMES.filter(
        (each) => !conceptsIn(codeOf(suffix, source)).includes(each),
      );
      expect({ name, missing }).toEqual({ name, missing: [] });
    });
  }

  for (const [name, suffix, source] of NEGATIVE_CONTROLS) {
    test(`${name} is not detected`, () => {
      // Tightening the detector until a real failure goes away breaks this
      // first, and the next author deletes the guard rather than argue with it.
      expect(implementsTheRule(suffix, source)).toBe(false);
    });
  }

  test("the registered site is detected", () => {
    // The scan's own positive control, on the real file. If the one
    // implementation stops looking like the execution rule, either it moved or
    // the detector went blind — and either way the repository-wide assertion
    // below would pass for the wrong reason.
    for (const site of REGISTERED) {
      const source = readFileSync(join(ROOT, site), "utf8");
      expect({ site, detected: implementsTheRule(suffixOf(site), source) }).toEqual({
        site,
        detected: true,
      });
    }
  });
});

describe("there is exactly one implementation of the execution rule", () => {
  test("no other file in the repository implements it", () => {
    const found = sourceFiles().filter((path) =>
      implementsTheRule(suffixOf(path), readFileSync(join(ROOT, path), "utf8")),
    );
    const extra = found.filter((path) => !REGISTERED.includes(path));

    expect(
      extra.length === 0
        ? []
        : extra.concat([
            "^ a second implementation of the execution rule. " +
              "docs/specs/flex-optimizer.md: the simulator that scores a live " +
              "plan and the one that scores a replayed plan are the same " +
              "function, imported, not reimplemented. Call the solver — " +
              `POST /v1/optimize — or import ${PYTHON_SITE}. If the rule ` +
              "genuinely has to move, move it; do not add a second site here.",
          ]),
    ).toEqual([]);

    const missing = REGISTERED.filter((site) => !found.includes(site));
    expect(missing).toEqual([]);
  });

  test("the scan actually read the repository", () => {
    // A walk that found nothing would pass every assertion above.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    for (const site of REGISTERED) {
      expect(files).toContain(site);
    }
    // And it reached the app the second copy lived in, whatever `apps/web`
    // happens to contain today.
    expect(files.some((path) => path.startsWith(join("apps", "web") + sep))).toBe(true);
  });
});
