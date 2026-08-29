"""There is exactly one implementation of the execution rule. This is the edge.

`docs/specs/flex-optimizer.md` calls it "the single most important line" in the
spec: *the simulator that scores a live plan and the one that scores a replayed
plan are the same function, imported, not reimplemented.* A backtest number and
a forecast number are the same kind of number because of that and because of
nothing else. Every other test in the optimizer suite runs against code that
exists; this one asserts a property of the **repository**, because "there is
only one of these" is otherwise an unverifiable claim that decays the first time
somebody in a hurry needs the rule somewhere the import is inconvenient.

It walks every source file in the repository — both languages — and fails if the
execution rule appears anywhere except the two registered sites. It runs in the
Python suite because that is where an AST-accurate reading of a Python file is
free, and it reads TypeScript as text; ``bun run check:ml`` is what runs it, and
it covers `apps/web` and `packages/` exactly as it covers `apps/ml`.

**Why two sites and not one.** The rule runs in the browser as well as on the
server: `apps/web`'s prototype scores a plan with no Python in the room. A port
is not a second implementation *provided the two are proved identical*, so the
second half of this edge is a set of golden vectors both languages execute and
assert against — `packages/core/fixtures/execution-rule/`, checked by
``test_execution_rule_vectors.py`` here and by
``apps/web/test/execution-rule.test.ts`` there. Neither side compares against
the other, only against the vectors, so a shared misunderstanding cannot cancel
out. A *third* site is a second implementation whatever it is proved against,
and this test is what refuses it.

**How this resists a well-meaning copy**, which is the failure mode worth
designing for — nobody reimplements the rule in bad faith, they reimplement it
because Replay needed it and importing across a package felt heavy:

1. The detector is a **vocabulary co-occurrence** scan, not a search for a
   marker comment or a function name. A copy written in fresh names — ``room``
   for headroom, ``level`` for the state of charge, ``spilled`` for the
   realisation — still trips it, because it must still speak about charging,
   discharging, a state of charge, an efficiency, a realisation, absorption,
   and it must still clip. Removing any one of those stops it being the rule.
2. Comments and string literals are **stripped before matching**, so a file that
   merely *documents* the rule is not a hit and nobody has to weaken the
   detector to make prose legal. This test's own docstrings are covered by that.
3. The detector's sensitivity is pinned by :data:`POSITIVE_CONTROLS` — two
   plausible second implementations, one per language, sharing not one
   identifier with either registered site and held as *strings* rather than as
   files. Loosening the detector far enough to let a real copy through breaks
   the controls first, so the cheap way out of a failure here is not available.
4. :data:`NEGATIVE_CONTROLS` pins the other end: the MILP builder, which speaks
   the same vocabulary while expressing the rule as *constraints* rather than
   executing it, must not be flagged. Tightening the detector until the failure
   goes away breaks these.

What it cannot do is stop somebody editing this file, and it does not pretend
to. It makes a second copy a deliberate, reviewable act with a written
justification attached, instead of an accident nothing notices.
"""

from __future__ import annotations

import io
import re
import tokenize
from dataclasses import dataclass
from pathlib import Path

import pytest

# apps/ml/tests/… → apps/ml → apps → the repository root.
ROOT = Path(__file__).resolve().parents[3]

#: The one implementation, per language. Not a list to append to: a third entry
#: is the thing this file exists to prevent, and adding one without deleting a
#: site is a change to `docs/specs/flex-optimizer.md`'s central decision, not a
#: change to a test.
PYTHON_SITE = Path("apps/ml/src/wattsteer_ml/optimizer/simulator.py")
TYPESCRIPT_SITE = Path("apps/web/src/lib/fixtures/optimize.ts")
REGISTERED = frozenset({PYTHON_SITE, TYPESCRIPT_SITE})

SOURCE_SUFFIXES = frozenset({".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"})

SKIP_DIRS = frozenset(
    {
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
    }
)


@dataclass(frozen=True)
class Concept:
    """One thing the execution rule cannot be written without."""

    name: str
    pattern: re.Pattern[str]

    @classmethod
    def of(cls, name: str, *alternatives: str) -> Concept:
        return cls(name, re.compile("|".join(alternatives), re.IGNORECASE))


#: The seven concepts. Each carries every synonym a reasonable author might
#: reach for, because the point is to catch a copy written in *different* words
#: — matching one vocabulary would only catch a copy-paste, which is the easy
#: case and not the one that happens.
CONCEPTS: tuple[Concept, ...] = (
    Concept.of(
        "state of charge",
        r"\bsoc\b",
        r"state_?of_?charge",
        r"stored",
        r"storage_?level",
        r"energy_?level",
        r"charge_?level",
        r"charge_?state",
        r"\blevel\b",
    ),
    Concept.of(
        "efficiency",
        r"efficien",
        # Not ``\beta\b``: an underscore is a word character, so that would
        # miss ``one_way_eta`` — which is exactly the sort of name a second
        # implementation gets written with.
        r"(?<![a-z])eta(?![a-z])",
        r"\brte\b",
        r"round_?trip",
        r"\blosses?\b",
    ),
    Concept.of("the charging leg", r"charg(e|ing)"),
    Concept.of("the discharging leg", r"dis_?charg(e|ing)"),
    Concept.of(
        "a realisation of the day",
        r"offered",
        r"realisation",
        r"realization",
        r"curtail",
        r"\bcurt\b",
        r"spill",
        r"constrained_?off",
    ),
    Concept.of("absorption", r"absorb", r"recovered", r"avoided"),
)

#: The seventh, detected structurally rather than by pattern: a call to
#: ``min`` / ``Math.min`` / ``clamp`` **with more than one argument**. The rule
#: *clips* — "the scheduled amount or what actually arrived, whichever is
#: smaller" is a two-argument comparison — where a model *constrains*. That is
#: the whole difference between executing the rule and building the MILP that
#: plans against it, and it is why `milp.py` speaks every concept above and is
#: still not a hit. A one-argument ``min(deltas)`` over a sequence is an
#: aggregate, not a clip, and does not count.
CLIPPING = "clipping"

_CLIP_CALL = re.compile(r"(?:\bMath\.min|\bmin|\bclamp)\s*\(", re.IGNORECASE)


def has_clipping(code: str) -> bool:
    """Is one quantity anywhere held down to another?"""
    for call in _CLIP_CALL.finditer(code):
        depth = 0
        for character in code[call.end() :]:
            if character in "([{":
                depth += 1
            elif character in ")]}":
                if depth == 0:
                    break
                depth -= 1
            elif character == "," and depth == 0:
                return True
    return False


CONCEPT_NAMES: frozenset[str] = frozenset(
    [concept.name for concept in CONCEPTS] + [CLIPPING]
)

#: A plausible second implementation, in Python — the one somebody writes when
#: Replay needs the rule and importing across a package feels heavy. It shares
#: no identifier with :mod:`wattsteer_ml.optimizer.simulator`: not a name, not a
#: field, not the shape of the loop. If the detector stops flagging it, the
#: detector has been loosened past the point of catching a real one.
PYTHON_CONTROL = """
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
"""

#: The same, in TypeScript, and a different shape again — a `reduce` rather than
#: a loop, camelCase throughout — so the two controls share no giveaway between
#: them either.
TYPESCRIPT_CONTROL = """
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
"""

POSITIVE_CONTROLS: tuple[tuple[str, str, str], ...] = (
    ("python", "py", PYTHON_CONTROL),
    ("typescript", "ts", TYPESCRIPT_CONTROL),
)

#: The other end of the calibration. Each speaks most of the vocabulary and
#: none of them executes the rule: the first *constrains* a model that plans
#: against it, the second *calls* the one implementation, the third only
#: describes it.
NEGATIVE_CONTROLS: tuple[tuple[str, str, str], ...] = (
    (
        "the MILP builder, which constrains rather than clips",
        "py",
        """
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
""",
    ),
    (
        "a caller, which imports the one implementation",
        "py",
        """
from wattsteer_ml.optimizer import simulate

def score(plan, p10, p50, threshold_mw):
    floor = simulate(plan, p10, threshold_mw=threshold_mw)
    median = simulate(plan, p50, threshold_mw=threshold_mw)
    return min(floor.recovered_mwh, median.recovered_mwh)
""",
    ),
    (
        "prose about the rule, which is not the rule",
        "ts",
        """
// On the day an asset charges the scheduled amount or the amount actually
// being curtailed, whichever is smaller, and discharges the scheduled amount
// or what its state of charge permits: Math.min(charge, offered, headroom).
// Absorbed energy is the net increase in flexible demand, after efficiency.
export const EXECUTION_RULE = "follow_curtailment";
""",
    ),
)


def strip_python(source: str) -> str:
    """Code only: comments and string literals — docstrings included — removed.

    A file that *documents* the rule must not be a hit, or the honest response
    to this test failing would be to delete an explanation.
    """
    out: list[str] = []
    try:
        tokens = tokenize.generate_tokens(io.StringIO(source).readline)
        for token in tokens:
            if token.type in (tokenize.COMMENT, tokenize.STRING):
                continue
            out.append(token.string)
    except (tokenize.TokenError, IndentationError, SyntaxError):  # pragma: no cover
        # An unparseable file is scanned raw rather than skipped: skipping is
        # the one outcome that would let a copy through by being malformed.
        return source
    return "\n".join(out)


_TS_NOISE = re.compile(
    r"""
      //[^\n]*                # line comment
    | /\*.*?\*/               # block comment
    | "(?:\\.|[^"\\])*"       # double-quoted string
    | '(?:\\.|[^'\\])*'       # single-quoted string
    | `(?:\\.|[^`\\])*`       # template literal
    """,
    re.DOTALL | re.VERBOSE,
)


def strip_typescript(source: str) -> str:
    return _TS_NOISE.sub(" ", source)


def code_of(suffix: str, source: str) -> str:
    return strip_python(source) if suffix == "py" else strip_typescript(source)


def concepts_in(code: str) -> frozenset[str]:
    found = {concept.name for concept in CONCEPTS if concept.pattern.search(code)}
    if has_clipping(code):
        found.add(CLIPPING)
    return frozenset(found)


def implements_the_rule(suffix: str, source: str) -> bool:
    """Every concept present in executable code. Not most of them: all of them."""
    return concepts_in(code_of(suffix, source)) == CONCEPT_NAMES


def source_files() -> list[Path]:
    found: list[Path] = []
    stack = [ROOT]
    while stack:
        directory = stack.pop()
        for entry in directory.iterdir():
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if entry.name not in SKIP_DIRS:
                    stack.append(entry)
            elif entry.suffix in SOURCE_SUFFIXES:
                found.append(entry)
    return sorted(found)


class TestTheDetectorIsCalibrated:
    """Before the scan is evidence of anything, it has to be able to fail."""

    @pytest.mark.parametrize(
        ("name", "suffix", "source"),
        POSITIVE_CONTROLS,
        ids=[control[0] for control in POSITIVE_CONTROLS],
    )
    def test_a_second_implementation_is_detected(
        self, name: str, suffix: str, source: str
    ) -> None:
        missing = CONCEPT_NAMES - concepts_in(code_of(suffix, source))
        assert implements_the_rule(suffix, source), (
            f"the {name} control was not detected — the scan below now proves "
            f"nothing. Missing concepts: {sorted(missing)}."
        )

    @pytest.mark.parametrize(
        ("name", "suffix", "source"),
        NEGATIVE_CONTROLS,
        ids=[control[0] for control in NEGATIVE_CONTROLS],
    )
    def test_the_neighbours_of_the_rule_are_not_detected(
        self, name: str, suffix: str, source: str
    ) -> None:
        assert not implements_the_rule(suffix, source), (
            f"{name} was flagged as an implementation of the execution rule. "
            "The detector has been tightened past the point of being usable, "
            "and the next author will delete it rather than argue with it."
        )

    def test_the_registered_sites_are_detected(self) -> None:
        """The scan's own positive control, on the real files.

        If the one implementation stops looking like the execution rule, either
        it moved or the detector went blind — and either way the repo-wide
        assertion below would pass for the wrong reason.
        """
        for relative in sorted(REGISTERED):
            path = ROOT / relative
            assert path.exists(), f"{relative} — the registered site is gone."
            assert implements_the_rule(
                path.suffix.lstrip("."), path.read_text(encoding="utf-8")
            ), f"{relative} no longer implements the execution rule."


class TestThereIsExactlyOne:
    def test_no_other_file_in_the_repository_implements_the_execution_rule(
        self,
    ) -> None:
        found: set[Path] = set()
        for path in source_files():
            relative = path.relative_to(ROOT)
            source = path.read_text(encoding="utf-8", errors="ignore")
            if implements_the_rule(path.suffix.lstrip("."), source):
                found.add(relative)

        extra = sorted(str(path) for path in found - REGISTERED)
        assert not extra, (
            "a second implementation of the execution rule appeared in:\n  "
            + "\n  ".join(extra)
            + "\n\n`docs/specs/flex-optimizer.md`: the simulator that scores a "
            "live plan and the one that scores a replayed plan are the same "
            "function, imported, not reimplemented. A backtest number is "
            "comparable to a forecast number because of that and nothing else."
            f"\n\nImport it from {PYTHON_SITE} (Python) or {TYPESCRIPT_SITE} "
            "(TypeScript) instead. If the rule genuinely has to move, move it — "
            "do not add a third site to this test."
        )
        assert found == set(REGISTERED), (
            "a registered site stopped implementing the rule: "
            f"{sorted(str(path) for path in set(REGISTERED) - found)}"
        )

    def test_the_scan_actually_read_the_repository(self) -> None:
        """A walk that found nothing would pass every assertion above."""
        files = source_files()
        assert len(files) > 200, f"only {len(files)} source files walked."
        for relative in REGISTERED:
            assert ROOT / relative in files, f"{relative} was not walked."
