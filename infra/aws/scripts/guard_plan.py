#!/usr/bin/env python3
"""Refuse a Terraform plan that deletes or replaces anything.

    terraform show -json plan.out | guard_plan.py [--allow-destroy]

`prevent_destroy` already stops a plan that would delete the database, the
buckets, the file system or the instance's data volume. This catches the rest:
a replaced load balancer changes the site's address, a replaced ECS service
drops its tasks, a replaced instance loses what is not on the data volume.
None of those is ever what a deploy meant to do, so the deploy stops and
lists them, and a person decides.

Exit 0 when the plan only creates or updates; 1 when it deletes or replaces
and --allow-destroy was not given.
"""

import json
import sys


def destructive(plan: dict) -> list[str]:
    found = []
    for change in plan.get("resource_changes", []):
        actions = change["change"]["actions"]
        if "delete" in actions:
            verb = "replace" if "create" in actions else "delete"
            found.append(f"{verb:8} {change['address']}")
    return found


def main() -> int:
    allow = "--allow-destroy" in sys.argv[1:]
    found = destructive(json.load(sys.stdin))
    if not found:
        print("plan check: nothing is deleted or replaced")
        return 0
    print("plan check: this plan deletes or replaces:")
    for line in found:
        print(f"  {line}")
    if allow:
        print("plan check: --allow-destroy given, continuing")
        return 0
    print("plan check: stopped. Read the list above; re-run with --allow-destroy only if it is intended.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
