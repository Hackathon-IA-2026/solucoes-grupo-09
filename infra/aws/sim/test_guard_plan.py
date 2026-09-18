"""The plan guard must stop a delete or a replace, and nothing else.

    python3 -m unittest infra/aws/sim/test_guard_plan.py
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

GUARD = Path(__file__).resolve().parent.parent / "scripts" / "guard_plan.py"


def plan(*actions: list[str]) -> str:
    changes = [
        {"address": f"aws_thing.n{i}", "change": {"actions": a}} for i, a in enumerate(actions)
    ]
    return json.dumps({"resource_changes": changes})


def guard(plan_json: str, *flags: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(GUARD), *flags], input=plan_json, capture_output=True, text=True
    )


class GuardPlan(unittest.TestCase):
    def test_creates_and_updates_pass(self):
        self.assertEqual(guard(plan(["create"], ["update"], ["no-op"])).returncode, 0)

    def test_a_delete_stops_the_deploy(self):
        result = guard(plan(["update"], ["delete"]))
        self.assertEqual(result.returncode, 1)
        self.assertIn("delete   aws_thing.n1", result.stdout)

    def test_a_replace_stops_the_deploy(self):
        # Terraform writes a replacement as delete + create, in either order.
        for actions in (["delete", "create"], ["create", "delete"]):
            result = guard(plan(actions))
            self.assertEqual(result.returncode, 1)
            self.assertIn("replace  aws_thing.n0", result.stdout)

    def test_allow_destroy_is_the_only_way_past(self):
        self.assertEqual(guard(plan(["delete"]), "--allow-destroy").returncode, 0)


if __name__ == "__main__":
    unittest.main()
