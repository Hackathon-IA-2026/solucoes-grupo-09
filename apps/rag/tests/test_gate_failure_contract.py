"""Every refusal the service can emit is one the contract admits.

`rag-evidence.schema.json` closes `trace.generation.gate_failures` to an enum,
and the codes are built by hand in `gate.py` and `evidence.py`. Nothing held
the two together: a gate added with a new code would have produced a document
that fails its own schema at the point a consumer validates it, and a code
deleted from the code would have left a member of the enum that nothing can
ever emit — a contract describing a refusal the service stopped making.

Read out of the source with `ast` rather than by grep, because several of these
are built across three lines inside a function and a regular expression over the
text found seven of the twelve. The one it missed is the family this file exists
for: `_relevance_failure`'s three, which are the gates most likely to grow a
fourth.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "wattsteer_rag"
SCHEMA = Path(__file__).resolve().parents[3] / "docs" / "rag" / "rag-evidence.schema.json"


def emitted_codes() -> set[str]:
    """The first argument of every `GateFailure(...)` the package constructs."""
    codes: set[str] = set()
    for module in SRC.rglob("*.py"):
        for node in ast.walk(ast.parse(module.read_text())):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            if node.func.id != "GateFailure" or not node.args:
                continue
            first = node.args[0]
            # A computed code would make this guard unable to see it, which is
            # worth failing on rather than skipping: the enum could not be
            # checked against it either.
            assert isinstance(first, ast.Constant) and isinstance(first.value, str), (
                f"{module.name}: GateFailure built with a computed code, which no contract can enumerate"
            )
            codes.add(first.value)
    return codes


def schema_enum() -> set[str]:
    def find(node):
        if isinstance(node, dict):
            if "gate_failures" in node:
                return node["gate_failures"]["items"]["enum"]
            for value in node.values():
                if found := find(value):
                    return found
        if isinstance(node, list):
            for value in node:
                if found := find(value):
                    return found
        return None

    found = find(json.loads(SCHEMA.read_text()))
    assert found, "the schema no longer closes gate_failures to an enum"
    return set(found)


def test_the_codes_and_the_contract_are_the_same_set():
    emitted, declared = emitted_codes(), schema_enum()
    assert emitted - declared == set(), "emitted by the service, absent from the schema"
    assert declared - emitted == set(), "in the schema, emitted by nothing"


def test_the_walk_read_something():
    """Both halves, so an empty intersection cannot mean an empty reading: an
    `ast` walk that matched nothing and a schema lookup that returned nothing
    would agree perfectly."""
    emitted = emitted_codes()
    assert len(emitted) > 8
    # The three the grep-shaped version of this guard missed, because they are
    # built across several lines inside `_relevance_failure`.
    assert {"citation_not_the_named_document", "citation_from_another_event"} <= emitted
    assert len(schema_enum()) == len(emitted)
