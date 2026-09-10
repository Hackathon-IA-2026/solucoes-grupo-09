/**
 * Refuses to start ticket work on a base that does not already contain
 * `origin/main`.
 *
 * This exists because a stale base is invisible. Every other check in this
 * repository reads the tree in front of it; this one reads where that tree came
 * from, which is the one property a passing test suite cannot tell you about.
 * A ticket branched from an eleven-day-old `main` typechecks, lints and passes
 * its own tests — and then merges a regression back over work it never saw.
 *
 * The guard is deliberately about the *base of new work* rather than about the
 * local `main` ref. `main` drifting is cosmetic: this workflow never builds on
 * it. A worktree branched behind the tip is not cosmetic.
 *
 * It fails closed. If `git fetch` cannot reach the remote, the comparison would
 * run against whatever `origin/main` happened to be last time anyone fetched —
 * which is exactly the stale read the guard exists to prevent — so an
 * unreachable remote is a refusal, not a pass.
 */

import { execFileSync } from "node:child_process";

/** A full object name. Nothing shorter is accepted; see `evaluateBase`. */
const OBJECT_NAME = /^[0-9a-f]{40}$/;

export interface BaseFacts {
  /** `git rev-parse HEAD` */
  headSha: string;
  /** `git rev-parse origin/main` */
  originMainSha: string;
  /** `git merge-base HEAD origin/main` */
  mergeBaseSha: string;
  /** `git rev-list --count HEAD..origin/main` */
  behind: number;
  /** Whether `git fetch origin main` actually succeeded. */
  fetched: boolean;
}

export type Verdict =
  | { ok: true; reason: "contains-origin-main" }
  | { ok: false; reason: "fetch-failed" | "unreadable-ref" | "base-behind-tip" };

/**
 * The whole decision, as a pure function of five facts, so that every branch
 * below is reachable from a test without a network or a second clone.
 */
export function evaluateBase(facts: BaseFacts): Verdict {
  // Fail closed: an unfetched `origin/main` is a stale read, not a pass.
  if (!facts.fetched) {
    return { ok: false, reason: "fetch-failed" };
  }

  // Non-vacuity. A failed `rev-parse` prints nothing and exits non-zero, and an
  // empty string compared against another empty string is equal — so the naive
  // shape of this function passes hardest at the moment it has read nothing at
  // all. This repository has shipped that bug four times; it is guarded here
  // rather than commented about.
  for (const sha of [facts.headSha, facts.originMainSha, facts.mergeBaseSha]) {
    if (!OBJECT_NAME.test(sha)) {
      return { ok: false, reason: "unreadable-ref" };
    }
  }

  // `origin/main` is an ancestor of HEAD exactly when it *is* the merge base.
  // This accepts both a worktree sitting on the tip and a ticket branch already
  // carrying commits on top of it.
  if (facts.mergeBaseSha === facts.originMainSha) {
    return { ok: true, reason: "contains-origin-main" };
  }

  return { ok: false, reason: "base-behind-tip" };
}

/** How a refusal is explained to whoever is about to start a ticket. */
export function explain(facts: BaseFacts, verdict: Verdict): string {
  switch (verdict.reason) {
    case "contains-origin-main":
      return `base contains origin/main (${facts.originMainSha.slice(0, 7)}) — ok to start`;
    case "fetch-failed":
      return [
        "REFUSED: could not fetch origin, so origin/main could not be trusted.",
        "Fix the remote and re-run. The guard does not compare against a stale ref.",
      ].join("\n");
    case "unreadable-ref":
      return [
        "REFUSED: could not read HEAD, origin/main or their merge base.",
        `  HEAD        ${facts.headSha || "(unreadable)"}`,
        `  origin/main ${facts.originMainSha || "(unreadable)"}`,
        `  merge-base  ${facts.mergeBaseSha || "(unreadable)"}`,
      ].join("\n");
    case "base-behind-tip":
      return [
        `REFUSED: this base is ${facts.behind} commit(s) behind origin/main.`,
        `  HEAD        ${facts.headSha.slice(0, 7)}`,
        `  origin/main ${facts.originMainSha.slice(0, 7)}`,
        "",
        "Do not start a ticket here. Rebase onto the tip first:",
        "  git rebase origin/main",
        "or create the worktree from origin/main rather than from a local branch.",
      ].join("\n");
    default:
      return "REFUSED: unrecognised verdict";
  }
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/** Reads the five facts from the repository this script is run inside. */
export function readBaseFacts(): BaseFacts {
  let fetched = true;
  try {
    execFileSync("git", ["fetch", "origin", "main", "--quiet"], { stdio: "ignore" });
  } catch {
    fetched = false;
  }

  const behind = Number.parseInt(git(["rev-list", "--count", "HEAD..origin/main"]), 10);

  return {
    headSha: git(["rev-parse", "HEAD"]),
    originMainSha: git(["rev-parse", "origin/main"]),
    mergeBaseSha: git(["merge-base", "HEAD", "origin/main"]),
    behind: Number.isNaN(behind) ? -1 : behind,
    fetched,
  };
}

if (import.meta.main) {
  const facts = readBaseFacts();
  const verdict = evaluateBase(facts);
  console.log(explain(facts, verdict));
  process.exit(verdict.ok ? 0 : 1);
}
