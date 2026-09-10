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
 *
 * It reads a *ref*, defaulting to `HEAD`, because the guard is now run from two
 * places. `bun run preflight` asks about the worktree you are standing in.
 * `.githooks/base-gate.sh` asks about the branch about to be merged, which is
 * the ref that actually decides whether the resulting merge commit contains
 * `origin/main`. `HEAD` is the wrong ref to read at merge time: merging a
 * current branch into a stale local `main` yields a commit that does contain
 * the tip, and refusing that would be a false alarm the gate would be switched
 * off for.
 */

import { execFileSync } from "node:child_process";

/** A full object name. Nothing shorter is accepted; see `evaluateBase`. */
const OBJECT_NAME = /^[0-9a-f]{40}$/;

export interface BaseFacts {
  /** `git rev-parse <ref>` */
  headSha: string;
  /** `git rev-parse origin/main` */
  originMainSha: string;
  /** `git merge-base <ref> origin/main` */
  mergeBaseSha: string;
  /** `git rev-list --count <ref>..origin/main` */
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

/**
 * A ref as it should be named in a message.
 *
 * The merge gate passes an object name rather than `MERGE_HEAD`, because git
 * has not written `MERGE_HEAD` yet at the point the hook runs — see
 * `.githooks/base-gate.sh`. A forty-character sha in the middle of a sentence
 * is unreadable, so shorten one; leave any other ref name exactly as given.
 */
export function nameRef(ref: string): string {
  return OBJECT_NAME.test(ref) ? ref.slice(0, 7) : ref;
}

/**
 * How a verdict is explained to whoever is about to start a ticket or merge one.
 *
 * `ref` is presentational only — the decision above is still a pure function of
 * the five facts, and this only names which ref they were read from, so that a
 * refusal fired from the merge hook does not leave the reader to guess that the
 * guard did not mean the branch they are standing on.
 */
export function explain(facts: BaseFacts, verdict: Verdict, ref = "HEAD"): string {
  const name = nameRef(ref);
  // In prose the ref is named; in the table it gets a heading, because when the
  // ref *is* an object name the row would otherwise read `5b57236  5b57236`.
  const heading = OBJECT_NAME.test(ref) ? "merging" : name;
  // Width from the labels actually printed, so an arbitrary ref name cannot
  // knock the columns out of line.
  const width = Math.max(heading.length, "origin/main".length);
  const row = (label: string, value: string) => `  ${label.padEnd(width)}  ${value}`;
  switch (verdict.reason) {
    case "contains-origin-main":
      return `${name} contains origin/main (${facts.originMainSha.slice(0, 7)}) — ok`;
    case "fetch-failed":
      return [
        "REFUSED: could not fetch origin, so origin/main could not be trusted.",
        "Fix the remote and re-run. The guard does not compare against a stale ref.",
      ].join("\n");
    case "unreadable-ref":
      return [
        `REFUSED: could not read ${name}, origin/main or their merge base.`,
        row(heading, facts.headSha || "(unreadable)"),
        row("origin/main", facts.originMainSha || "(unreadable)"),
        row("merge-base", facts.mergeBaseSha || "(unreadable)"),
      ].join("\n");
    case "base-behind-tip":
      return [
        `REFUSED: ${name} is ${facts.behind} commit(s) behind origin/main.`,
        row(heading, facts.headSha.slice(0, 7)),
        row("origin/main", facts.originMainSha.slice(0, 7)),
        "",
        "Do not start a ticket here, and do not merge it. Rebase onto the tip:",
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

/**
 * How long the fetch is allowed to take before it counts as unreachable.
 *
 * "Unreachable" has two shapes and only one of them is an error exit. A dead
 * host answers immediately; a *silently* dead one — a dropped VPN, a hostname
 * that resolves nowhere, an ssh server that accepts the connection and then
 * says nothing — leaves `git fetch` blocked for the TCP timeout. Without a
 * bound the guard hangs instead of refusing, and a guard that hangs inside a
 * merge hook is a guard that gets removed by whoever it hangs on. The refusal
 * path already exists; this only makes sure it is reached.
 */
const FETCH_TIMEOUT_MS = 20_000;

/** Reads the five facts about `ref` from the repository this script runs in. */
export function readBaseFacts(ref = "HEAD"): BaseFacts {
  let fetched = true;
  try {
    execFileSync("git", ["fetch", "origin", "main", "--quiet"], {
      stdio: "ignore",
      timeout: FETCH_TIMEOUT_MS,
      // And never stop to ask. A credential or host-key prompt on a
      // non-interactive stdin is the same hang by another route, and a prompt
      // fired from a git hook has no terminal to appear on.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    });
  } catch {
    fetched = false;
  }

  const behind = Number.parseInt(git(["rev-list", "--count", `${ref}..origin/main`]), 10);

  return {
    headSha: git(["rev-parse", ref]),
    originMainSha: git(["rev-parse", "origin/main"]),
    mergeBaseSha: git(["merge-base", ref, "origin/main"]),
    behind: Number.isNaN(behind) ? -1 : behind,
    fetched,
  };
}

if (import.meta.main) {
  // Argument, not an env var, so the merge hook's call reads as the question it
  // is asking. Defaults to HEAD: `bun run preflight` is unchanged.
  const ref = process.argv[2] ?? "HEAD";
  const facts = readBaseFacts(ref);
  const verdict = evaluateBase(facts);
  console.log(explain(facts, verdict, ref));
  process.exit(verdict.ok ? 0 : 1);
}
