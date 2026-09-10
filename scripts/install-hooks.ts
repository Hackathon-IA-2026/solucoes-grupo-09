/**
 * Points this clone's git hooks at the committed `.githooks/` directory.
 *
 * This is the part that makes the base guard un-skippable rather than merely
 * available. `.git/hooks` is not committed, so a hook written there enforces
 * nothing for anyone else and nothing for the next clone; `core.hooksPath` moves
 * the search into a directory that *is* committed, and this script is wired to
 * `postinstall`, so the one command nobody can skip in a bun monorepo installs
 * it. There is no separate step to remember.
 *
 * What that does and does not guarantee is written down in `README.md` under
 * "The base guard". In short: it holds for anyone who ran `bun install`, and
 * `git merge --no-verify` remains a deliberate bypass by design.
 *
 * `core.hooksPath` is repo-level configuration in `.git/config` — never the
 * user's global config — and in a worktree layout it lands in the shared config,
 * so installing once covers every existing and future worktree of this clone.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The committed directory. Also asserted by `test/preflight-base.test.ts`. */
export const HOOKS_PATH = ".githooks";

/**
 * Hook files must be executable or git skips them *silently* — no warning, no
 * non-zero exit, just an ungated merge. The mode bits are committed, so this is
 * belt and braces for a checkout on a filesystem or a `core.fileMode=false`
 * setting that lost them.
 */
const HOOK_MODE = 0o755;

export type InstallDecision =
  | { action: "configure"; from: string | null }
  | { action: "already-configured" }
  | { action: "skip"; reason: "not-a-git-repo" };

/**
 * The decision, pure over the two facts it depends on, for the same reason
 * `evaluateBase` is: every branch has to be reachable from a test that does not
 * mutate the git config of the repository the test is running in.
 */
export function decideInstall(
  inGitRepo: boolean,
  current: string | null,
): InstallDecision {
  if (!inGitRepo) {
    // A tarball or a vendored copy. Not a failure: refusing to install would
    // fail `bun install` somewhere the hooks could never have run anyway.
    return { action: "skip", reason: "not-a-git-repo" };
  }
  if (current === HOOKS_PATH) {
    return { action: "already-configured" };
  }
  // Any other value is replaced, and `from` carries the old one so the
  // replacement shows up in the install output rather than being silent. This
  // repository owns its hooks path; a value pointing elsewhere means the gate
  // is not installed, which is the thing being fixed.
  return { action: "configure", from: current };
}

/** What the install prints. Separated so the wording is testable. */
export function describeInstall(decision: InstallDecision): string {
  switch (decision.action) {
    case "already-configured":
      return `hooks: core.hooksPath already ${HOOKS_PATH}`;
    case "configure":
      return decision.from === null
        ? `hooks: core.hooksPath set to ${HOOKS_PATH} (base guard armed on merges)`
        : `hooks: core.hooksPath moved from ${decision.from} to ${HOOKS_PATH}`;
    case "skip":
      return "hooks: not a git checkout, nothing to install";
    default:
      return "hooks: unrecognised decision";
  }
}

function gitConfigValue(cwd: string): string | null {
  try {
    return execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Exit 1 with no output is how `--get` reports "unset".
    return null;
  }
}

function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Installs the hooks path in `cwd`, returning what it did. */
export function installHooks(cwd: string): InstallDecision {
  const decision = decideInstall(isGitRepo(cwd), gitConfigValue(cwd) || null);

  if (decision.action === "configure") {
    execFileSync("git", ["config", "core.hooksPath", HOOKS_PATH], {
      cwd,
      stdio: "ignore",
    });
  }

  if (decision.action !== "skip") {
    const dir = join(cwd, HOOKS_PATH);
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) {
        chmodSync(join(dir, entry), HOOK_MODE);
      }
    }
  }

  return decision;
}

if (import.meta.main) {
  // Never fails the install. The gate's job is to refuse merges, and a
  // postinstall that can break `bun install` would be removed long before it
  // ever refused one.
  try {
    console.log(describeInstall(installHooks(process.cwd())));
  } catch (error) {
    console.log(`hooks: could not install (${String(error)})`);
  }
}
