import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  decideInstall,
  describeInstall,
  HOOKS_PATH,
  installHooks,
} from "../scripts/install-hooks";
import {
  type BaseFacts,
  evaluateBase,
  evaluateMerge,
  explain,
  explainMerge,
  type MergeFacts,
  nameRef,
} from "../scripts/preflight-base";

/**
 * The preflight guard decides whether a worktree is a legitimate place to start
 * a ticket. Its whole value is that it refuses, so the tests that matter are
 * the ones proving it *can* refuse — a base check that always passes is worse
 * than no base check, because it converts an invisible problem into an
 * invisible problem with a green tick beside it.
 *
 * `evaluateBase` is pure over five facts precisely so that every refusal below
 * is reachable without a network, a remote or a second clone.
 *
 * The second half of this file is about the guard being *reached*. A script
 * somebody has to remember is not a guard, so `.githooks/` gates the merge and
 * `postinstall` installs it. That claim is worth exactly as much as a test that
 * watches a real merge get refused, so the last three suites build throwaway
 * repositories with a local bare remote — no network — and merge in them.
 */

const TIP = "a".repeat(40);
const OLDER = "b".repeat(40);
const AHEAD = "c".repeat(40);

/** A worktree sitting exactly on the tip: the ordinary, healthy case. */
function onTip(overrides: Partial<BaseFacts> = {}): BaseFacts {
  return {
    headSha: TIP,
    originMainSha: TIP,
    mergeBaseSha: TIP,
    behind: 0,
    fetched: true,
    ...overrides,
  };
}

describe("preflight: the base of new work contains origin/main", () => {
  it("accepts a worktree sitting on the tip", () => {
    expect(evaluateBase(onTip())).toEqual({ ok: true, reason: "contains-origin-main" });
  });

  it("accepts a ticket branch already carrying commits on top of the tip", () => {
    // The merge base is still origin/main, which is the actual property being
    // asserted — not equality with HEAD. Requiring HEAD === origin/main would
    // refuse every ticket branch after its first commit and the guard would be
    // turned off within a day.
    const verdict = evaluateBase(onTip({ headSha: AHEAD, mergeBaseSha: TIP, behind: 0 }));
    expect(verdict).toEqual({ ok: true, reason: "contains-origin-main" });
  });

  it("refuses a base behind the tip, which is the case it exists for", () => {
    // origin/main has moved on and HEAD does not contain it: the merge base is
    // the older commit, not origin/main.
    const verdict = evaluateBase(
      onTip({ headSha: OLDER, originMainSha: TIP, mergeBaseSha: OLDER, behind: 143 }),
    );
    expect(verdict).toEqual({ ok: false, reason: "base-behind-tip" });
  });
});

describe("preflight: it fails closed", () => {
  it("refuses when the remote could not be fetched", () => {
    // Otherwise the comparison silently runs against whatever origin/main was
    // last time anyone fetched, which is the stale read the guard prevents.
    // Note the facts here are *otherwise perfect* — on the tip, zero behind —
    // so this asserts the fetch flag alone is decisive.
    expect(evaluateBase(onTip({ fetched: false }))).toEqual({
      ok: false,
      reason: "fetch-failed",
    });
  });

  it("refuses when a ref could not be read, rather than comparing empty strings", () => {
    // The vacuity trap this repository keeps falling into. A failed `rev-parse`
    // yields "", and "" === "" is true, so the unguarded shape of this function
    // reports its healthiest verdict at the moment it has read nothing at all.
    const blind: BaseFacts = {
      headSha: "",
      originMainSha: "",
      mergeBaseSha: "",
      behind: -1,
      fetched: true,
    };
    expect(evaluateBase(blind)).toEqual({ ok: false, reason: "unreadable-ref" });

    // And one unreadable ref among two good ones is still a refusal.
    for (const field of ["headSha", "originMainSha", "mergeBaseSha"] as const) {
      expect({ field, verdict: evaluateBase(onTip({ [field]: "" })) }).toEqual({
        field,
        verdict: { ok: false, reason: "unreadable-ref" },
      });
    }
  });

  it("refuses an abbreviated or malformed object name", () => {
    // A seven-character sha compared against a forty-character one is never
    // equal, so accepting short names would make the guard refuse at random.
    // Rejecting them outright turns that into one legible failure.
    for (const bad of ["076e4f3", "not-a-sha", "A".repeat(40), "a".repeat(39)]) {
      expect({ bad, verdict: evaluateBase(onTip({ mergeBaseSha: bad })) }).toEqual({
        bad,
        verdict: { ok: false, reason: "unreadable-ref" },
      });
    }
  });
});

describe("preflight: every verdict explains itself", () => {
  it("names a remedy for each refusal and never returns an empty message", () => {
    // A refusal nobody can act on gets bypassed. Each message must say what to
    // do next, so the guard is cheaper to satisfy than to disable.
    const cases: BaseFacts[] = [
      onTip(),
      onTip({ fetched: false }),
      onTip({ mergeBaseSha: "" }),
      onTip({ headSha: OLDER, mergeBaseSha: OLDER, behind: 143 }),
    ];
    const reasons = new Set<string>();
    for (const facts of cases) {
      const verdict = evaluateBase(facts);
      const message = explain(facts, verdict);
      reasons.add(verdict.reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("unrecognised verdict");
    }
    // All four verdicts were actually exercised — otherwise the loop above
    // could pass having explained one case four times.
    expect([...reasons].sort()).toEqual([
      "base-behind-tip",
      "contains-origin-main",
      "fetch-failed",
      "unreadable-ref",
    ]);
  });

  it("tells a stale base how far behind it is and how to fix it", () => {
    const facts = onTip({ headSha: OLDER, mergeBaseSha: OLDER, behind: 143 });
    const message = explain(facts, evaluateBase(facts));
    expect(message).toContain("143");
    expect(message).toContain("git rebase origin/main");
  });

  it("names the ref it read, so a refusal points at the right branch", () => {
    // `evaluateBase` is asked about refs other than HEAD — `bun run preflight
    // <ref>` does it — and a refusal that always said "HEAD" would send the
    // reader to rebase the wrong branch. The ref is presentational only: it is
    // not one of the five facts and does not reach `evaluateBase`.
    const facts = onTip({ headSha: OLDER, mergeBaseSha: OLDER, behind: 7 });
    const verdict = evaluateBase(facts);
    expect(explain(facts, verdict, "MERGE_HEAD")).toContain("MERGE_HEAD is 7 commit(s)");
    expect(explain(facts, verdict)).toContain("HEAD is 7 commit(s)");
    // And on the unreadable path, where the label is a column heading.
    const blind = onTip({ headSha: "" });
    expect(explain(blind, evaluateBase(blind), "MERGE_HEAD")).toContain("MERGE_HEAD");
  });

  it("shortens an object name in prose, since the gate passes one", () => {
    // The gate has to pass a sha rather than `MERGE_HEAD` — git has not written
    // `MERGE_HEAD` yet when `pre-merge-commit` runs. A forty-character sha in
    // the middle of a sentence is a message people stop reading.
    expect(nameRef(OLDER)).toBe("bbbbbbb");
    // Anything that is not an object name is left exactly as given, so the
    // shortening cannot quietly mangle a branch name.
    for (const ref of ["HEAD", "MERGE_HEAD", "origin/main", "feature/a-long-branch"]) {
      expect({ ref, named: nameRef(ref) }).toEqual({ ref, named: ref });
    }
    const facts = onTip({ headSha: OLDER, mergeBaseSha: OLDER, behind: 7 });
    const message = explain(facts, evaluateBase(facts), OLDER);
    expect(message).toContain("bbbbbbb is 7 commit(s)");
    expect(message).not.toContain(OLDER);
    // And the table gets a heading rather than repeating the sha as its own
    // label: `bbbbbbb  bbbbbbb` is not a row anyone reads twice.
    expect(message).toContain("merging      bbbbbbb");
    expect(explain(facts, evaluateBase(facts))).toContain("HEAD         bbbbbbb");
  });
});

/* ------------------------------------------------------------------------- *
 * Being reached: the merge gate.
 * ------------------------------------------------------------------------- */

const REPO = join(import.meta.dir, "..");

/** The hooks git will actually look for, and what each is for. */
const HOOKS = ["pre-merge-commit", "pre-commit", "base-gate.sh"] as const;

describe("preflight: the merge result, which is what the gate decides", () => {
  const head = (sha: string, mergeBaseSha: string, behind = 0) => ({
    sha,
    mergeBaseSha,
    behind,
  });
  const merging = (overrides: Partial<MergeFacts> = {}): MergeFacts => ({
    fetched: true,
    originMainSha: TIP,
    destinationSha: TIP,
    destinationMergeBaseSha: TIP,
    heads: [head(AHEAD, TIP)],
    ...overrides,
  });

  it("allows a stale incoming head when the destination carries the tip", () => {
    // The correction. The result contains origin/main because the destination
    // does, and git keeps both sides — so this is allowed and merely noted.
    const facts = merging({ heads: [head(OLDER, OLDER, 2)] });
    expect(evaluateMerge(facts)).toEqual({
      ok: true,
      reason: "result-contains-origin-main",
      staleHeads: [OLDER],
    });
    expect(explainMerge(facts, evaluateMerge(facts))).toContain(
      "was cut 2 commit(s) behind",
    );
  });

  it("allows a stale destination when an incoming head carries the tip", () => {
    // The mirror image, and the case the old contract got right by accident:
    // merging a current branch into a drifted local main is fine.
    const facts = merging({ destinationSha: OLDER, destinationMergeBaseSha: OLDER });
    expect(evaluateMerge(facts)).toEqual({
      ok: true,
      reason: "result-contains-origin-main",
      staleHeads: [],
    });
  });

  it("refuses only when no side carries the tip", () => {
    const facts = merging({
      destinationSha: OLDER,
      destinationMergeBaseSha: OLDER,
      heads: [head(OLDER, OLDER, 2)],
    });
    expect(evaluateMerge(facts)).toEqual({ ok: false, reason: "result-behind-tip" });
    expect(explainMerge(facts, evaluateMerge(facts))).toContain(
      "this merge would not contain origin/main",
    );
  });

  it("decides an octopus merge whole: one current head is enough, and the rest are noted", () => {
    const facts = merging({
      destinationSha: OLDER,
      destinationMergeBaseSha: OLDER,
      heads: [head(OLDER, OLDER, 2), head(AHEAD, TIP)],
    });
    expect(evaluateMerge(facts)).toEqual({
      ok: true,
      reason: "result-contains-origin-main",
      staleHeads: [OLDER],
    });
  });

  it("can fail: it is not satisfied by having read nothing", () => {
    // The vacuity trap, in its sharpest form for this function. With no heads,
    // "every incoming head carries the tip" is vacuously true and a naive
    // implementation returns its healthiest verdict having learned nothing.
    expect(evaluateMerge(merging({ heads: [] }))).toEqual({
      ok: false,
      reason: "unreadable-ref",
    });
    // An unreadable sha anywhere in the merge is a refusal, not a comparison
    // of empty strings.
    expect(evaluateMerge(merging({ heads: [head("", "")] }))).toEqual({
      ok: false,
      reason: "unreadable-ref",
    });
    expect(evaluateMerge(merging({ destinationSha: "" }))).toEqual({
      ok: false,
      reason: "unreadable-ref",
    });
    expect(evaluateMerge(merging({ originMainSha: "" }))).toEqual({
      ok: false,
      reason: "unreadable-ref",
    });
    // And an unreachable remote stays a refusal even when everything else is
    // perfect, because origin/main could not be trusted.
    expect(evaluateMerge(merging({ fetched: false }))).toEqual({
      ok: false,
      reason: "fetch-failed",
    });
  });
});

describe("preflight: the gate's wiring is committed, not per-machine", () => {
  it("ships the hooks in a tracked directory rather than in .git/hooks", () => {
    // `.git/hooks` is not committed, so a hook installed there enforces nothing
    // for the next clone and nothing for anyone else. This is the whole reason
    // the mechanism is `core.hooksPath` pointed at a tracked directory.
    expect(HOOKS_PATH).toBe(".githooks");
    const tracked = execFileSync("git", ["ls-files", HOOKS_PATH], {
      cwd: REPO,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .sort();
    expect(tracked).toEqual(HOOKS.map((h) => `${HOOKS_PATH}/${h}`).sort());
  });

  it("keeps every hook executable, since git skips a non-executable hook silently", () => {
    // The failure this guards is the worst shape available: no warning, no
    // non-zero exit, just an ungated merge. Assert the committed mode bit.
    for (const hook of HOOKS) {
      const mode = statSync(join(REPO, HOOKS_PATH, hook)).mode & 0o111;
      expect({ hook, executable: mode !== 0 }).toEqual({ hook, executable: true });
    }
  });

  it("has each hook reach the one guard, and reach it with MERGE_HEAD", () => {
    // Two hooks, one gate. `pre-merge-commit` covers the clean merge;
    // `pre-commit` covers the conflicted merge, which git finishes through
    // `git commit` and which would otherwise be the one path with no gate.
    const gate = readFileSync(join(REPO, HOOKS_PATH, "base-gate.sh"), "utf8");
    expect(gate).toContain("scripts/preflight-base.ts");
    // Both ways of finding the incoming head. `MERGE_HEAD` covers the
    // conflicted path; `GITHEAD_*` covers the clean one, where git has not
    // written `MERGE_HEAD` yet. Dropping the second would make the gate refuse
    // every merge — measured, see the integration suites below.
    expect(gate).toContain("MERGE_HEAD");
    expect(gate).toContain("GITHEAD_");

    for (const hook of ["pre-merge-commit", "pre-commit"]) {
      const body = readFileSync(join(REPO, HOOKS_PATH, hook), "utf8");
      expect({ hook, sources: body.includes("base-gate.sh") }).toEqual({
        hook,
        sources: true,
      });
    }

    // And `pre-commit` must be inert on an ordinary commit, or every commit in
    // every ticket would fetch and `bun run check` would stop working offline.
    const preCommit = readFileSync(join(REPO, HOOKS_PATH, "pre-commit"), "utf8");
    expect(preCommit).toContain("git rev-parse --verify --quiet MERGE_HEAD");
  });

  it("installs itself from postinstall, the one step nobody can skip", () => {
    const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.postinstall).toContain("scripts/install-hooks.ts");
    // The guard is still runnable by hand, and still defaults to HEAD.
    expect(manifest.scripts.preflight).toBe("bun run scripts/preflight-base.ts");
  });

  it("can fail: the wiring assertions are not satisfied by an empty directory", () => {
    // Every assertion above is a `toContain` or a mode bit, and those read
    // green against an absent file only if the read throws — so prove the read
    // throws rather than trusting that it does, and prove the content checks
    // reject a hook that has stopped calling the guard.
    expect(() => statSync(join(REPO, HOOKS_PATH, "no-such-hook"))).toThrow();
    const disarmed = "#!/bin/sh\nexit 0\n";
    expect(disarmed.includes("base-gate.sh")).toBe(false);
    expect(disarmed.includes("scripts/preflight-base.ts")).toBe(false);
  });

  it("decides the install over its two facts, and says what it did", () => {
    // Pure, for the same reason `evaluateBase` is: no branch below is allowed
    // to require mutating the git config of the clone running the tests.
    expect(decideInstall(true, null)).toEqual({ action: "configure", from: null });
    expect(decideInstall(true, ".githooks")).toEqual({ action: "already-configured" });
    expect(decideInstall(true, "hooks/other")).toEqual({
      action: "configure",
      from: "hooks/other",
    });
    expect(decideInstall(false, null)).toEqual({
      action: "skip",
      reason: "not-a-git-repo",
    });

    // A replacement of somebody else's value must be visible in the output
    // rather than silent, and no decision may print the fallback wording.
    expect(describeInstall(decideInstall(true, "hooks/other"))).toContain("hooks/other");
    for (const decision of [
      decideInstall(true, null),
      decideInstall(true, ".githooks"),
      decideInstall(true, "hooks/other"),
      decideInstall(false, null),
    ]) {
      expect(describeInstall(decision)).not.toContain("unrecognised");
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Being reached, for real: throwaway repositories with a local bare remote.
 * ------------------------------------------------------------------------- */

/**
 * A git environment isolated from the machine running the tests, so a
 * developer's global config cannot change a verdict, and with `bun` on PATH
 * because that is what the hook shells out to.
 */
function isolatedEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Preflight Test",
    GIT_AUTHOR_EMAIL: "preflight@example.invalid",
    GIT_COMMITTER_NAME: "Preflight Test",
    GIT_COMMITTER_EMAIL: "preflight@example.invalid",
  };
}

interface Run {
  status: number;
  output: string;
}

function run(cwd: string, command: string, args: string[]): Run {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: isolatedEnv() });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** For the steps that are setup rather than assertion: a failure is a broken test. */
function git(cwd: string, args: string[]): string {
  const result = run(cwd, "git", args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${result.output}`);
  }
  return result.output.trim();
}

function commit(cwd: string, file: string, body: string, message: string): string {
  writeFileSync(join(cwd, file), body);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "--no-verify", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

interface World {
  root: string;
  /** A working clone whose `origin` is a bare repository on disk. */
  work: string;
  /** The commit `origin/main` used to be at. */
  base: string;
  /** The commit `origin/main` is at now. */
  tip: string;
  /** The tip of the `stale` branch — the sha the merge gate reports on. */
  staleTip: string;
}

/**
 * Builds the exact situation the guard exists for: a remote whose `main` has
 * moved on, and a local repository that still has a branch cut from where it
 * used to be.
 *
 * The remote is a bare repository in a temp directory, so every `git fetch` in
 * these tests is a real fetch that touches no network. `bun run check` stays
 * offline, which is the property the whole design turns on.
 */
function buildWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "preflight-gate-"));
  const upstream = join(root, "upstream.git");
  const work = join(root, "work");

  git(root, ["init", "--bare", "--initial-branch=main", upstream]);
  git(root, ["init", "--initial-branch=main", work]);
  const base = commit(work, "README.md", "one\n", "base");
  git(work, ["remote", "add", "origin", upstream]);
  git(work, ["push", "-u", "origin", "main"]);

  // `origin/main` moves on — this is the work a stale branch never sees.
  commit(work, "landed-a.txt", "a\n", "landed a");
  const tip = commit(work, "landed-b.txt", "b\n", "landed b");
  git(work, ["push", "origin", "main"]);

  // A ticket cut from the old tip, and one cut from the current tip. Each
  // touches a file of its own so neither merge conflicts: the refusal under
  // test has to be the gate's, not git's.
  git(work, ["checkout", "-q", "-b", "stale", base]);
  const staleTip = commit(work, "ticket-stale.txt", "stale\n", "stale ticket work");
  git(work, ["checkout", "-q", "-b", "current", tip]);
  commit(work, "ticket-current.txt", "current\n", "current ticket work");
  git(work, ["checkout", "-q", "main"]);

  return { root, work, base, tip, staleTip };
}

/**
 * Runs the guard the way `bun run preflight` does, from `cwd`.
 *
 * The script is read from `world.work` rather than from `cwd`, because a
 * detached worktree is checked out at an old commit whose tree does not contain
 * the script. That is not a contrivance: the guard reads the repository it is
 * run *in*, not the repository the file happens to live in, which is exactly
 * why it can be run from a worktree that predates it.
 */
function preflight(scriptRepo: string, cwd: string, ref?: string): Run {
  const script = join(scriptRepo, "scripts", "preflight-base.ts");
  return run(cwd, process.execPath, ["run", script, ...(ref ? [ref] : [])]);
}

/** Copies the guard and the hooks into a throwaway clone. */
function installGuard(work: string): void {
  mkdirSync(join(work, "scripts"), { recursive: true });
  cpSync(
    join(REPO, "scripts", "preflight-base.ts"),
    join(work, "scripts", "preflight-base.ts"),
  );
  cpSync(join(REPO, HOOKS_PATH), join(work, HOOKS_PATH), { recursive: true });
}

describe("preflight: run against a real repository", () => {
  let world: World;

  beforeAll(() => {
    world = buildWorld();
    installGuard(world.work);
  });

  afterAll(() => {
    rmSync(world.root, { recursive: true, force: true });
  });

  it("passes on a branch that contains the tip", () => {
    git(world.work, ["checkout", "-q", "current"]);
    const result = preflight(world.work, world.work);
    expect({ status: result.status, refused: result.output.includes("REFUSED") }).toEqual(
      {
        status: 0,
        refused: false,
      },
    );
  });

  it("refuses a branch cut behind the tip, and says how far and what to do", () => {
    git(world.work, ["checkout", "-q", "stale"]);
    const result = preflight(world.work, world.work);
    expect(result.status).toBe(1);
    expect(result.output).toContain("REFUSED");
    expect(result.output).toContain("2 commit(s) behind origin/main");
    expect(result.output).toContain("git rebase origin/main");
  });

  it("works in a detached worktree, which is how tickets are actually checked out", () => {
    // Detached is the routine state here, not an edge case, and it must not be
    // a verdict of its own: detached *at the tip* is fine and detached *behind*
    // it is the refusal. A guard that refused every detached worktree would be
    // disabled on its first day.
    const atTip = join(world.root, "wt-tip");
    const behind = join(world.root, "wt-behind");
    git(world.work, ["worktree", "add", "--detach", "-q", atTip, world.tip]);
    git(world.work, ["worktree", "add", "--detach", "-q", behind, world.base]);
    // Actually detached, or the two cases below prove nothing about detachment.
    for (const dir of [atTip, behind]) {
      const branch = run(dir, "git", ["symbolic-ref", "--short", "HEAD"]);
      expect({ dir, onABranch: branch.status === 0 }).toEqual({ dir, onABranch: false });
    }

    const tipResult = preflight(world.work, atTip);
    expect({ where: "at tip", status: tipResult.status }).toEqual({
      where: "at tip",
      status: 0,
    });

    const behindResult = preflight(world.work, behind);
    expect({ where: "behind", status: behindResult.status }).toEqual({
      where: "behind",
      status: 1,
    });
    expect(behindResult.output).toContain("2 commit(s) behind origin/main");
  });

  it("reads the ref it is given, which is how the gate asks about the incoming head", () => {
    // The merge hook's whole question. Standing on a current `main`, ask about
    // the stale branch and get the refusal that HEAD would not have produced.
    git(world.work, ["checkout", "-q", "main"]);
    expect(preflight(world.work, world.work).status).toBe(0);
    const asked = preflight(world.work, world.work, "stale");
    expect(asked.status).toBe(1);
    expect(asked.output).toContain("stale is 2 commit(s) behind origin/main");
  });
});

describe("preflight: an unreachable origin is a refusal, not a stale comparison", () => {
  let world: World;

  beforeAll(() => {
    world = buildWorld();
    installGuard(world.work);
    // Everything about this repository is healthy except that the remote is
    // gone: on the tip, nothing behind, `origin/main` still present in the
    // ref store from the last successful fetch. That is precisely the state in
    // which comparing against the cached ref would report a pass.
    git(world.work, ["remote", "set-url", "origin", join(world.root, "vanished.git")]);
  });

  afterAll(() => {
    rmSync(world.root, { recursive: true, force: true });
  });

  it("refuses although the cached origin/main would have said everything is fine", () => {
    expect(git(world.work, ["rev-parse", "HEAD"])).toBe(world.tip);
    expect(git(world.work, ["rev-parse", "origin/main"])).toBe(world.tip);

    const result = preflight(world.work, world.work);
    expect(result.status).toBe(1);
    expect(result.output).toContain("could not fetch origin");
  });

  it("refuses promptly rather than hanging, which is how a gate gets deleted", () => {
    // Not a performance assertion: the fetch is bounded so an unreachable
    // remote reaches the refusal at all. The bound is 20s; a local path that
    // does not exist fails at once, and this only catches a regression that
    // removes the bound and lets a fetch block indefinitely.
    const started = Date.now();
    expect(preflight(world.work, world.work).status).toBe(1);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe("preflight: the merge gate keeps the merge result current", () => {
  let world: World;

  beforeAll(() => {
    world = buildWorld();
    installGuard(world.work);
  });

  afterAll(() => {
    rmSync(world.root, { recursive: true, force: true });
  });

  it("is armed by the installer, not by a step anyone has to remember", () => {
    expect(installHooks(world.work)).toEqual({ action: "configure", from: null });
    expect(git(world.work, ["config", "--get", "core.hooksPath"])).toBe(HOOKS_PATH);
    // Idempotent: `bun install` runs on every dependency change.
    expect(installHooks(world.work)).toEqual({ action: "already-configured" });
  });

  it("allows a stale branch into a current destination, and says it was stale", () => {
    // The case the first contract got wrong. Merging a ticket cut behind the
    // tip into an up-to-date branch yields a commit that contains the tip, and
    // git's three-way merge keeps the work the ticket never saw. Refusing this
    // rejected two of the first three merges in this repository's own history.
    git(world.work, ["checkout", "-q", "main"]);
    const before = git(world.work, ["rev-parse", "HEAD"]);

    const merge = run(world.work, "git", ["merge", "--no-ff", "--no-edit", "stale"]);
    expect({ status: merge.status, refused: merge.output.includes("REFUSED") }).toEqual({
      status: 0,
      refused: false,
    });
    // Allowed, but not silently: a branch developed against an older tree can
    // still be semantically stale, and that is worth printing.
    expect(merge.output).toContain(
      `note: ${world.staleTip.slice(0, 7)} was cut 2 commit(s) behind`,
    );
    expect(git(world.work, ["rev-parse", "HEAD"])).not.toBe(before);

    git(world.work, ["reset", "--hard", "-q", before]);
  });

  it("allows a merge from a branch that contains the tip, with no note", () => {
    git(world.work, ["checkout", "-q", "main"]);
    const before = git(world.work, ["rev-parse", "HEAD"]);

    const merge = run(world.work, "git", ["merge", "--no-ff", "--no-edit", "current"]);
    expect({ status: merge.status, refused: merge.output.includes("REFUSED") }).toEqual({
      status: 0,
      refused: false,
    });
    expect(merge.output).not.toContain("note:");

    const after = git(world.work, ["rev-parse", "HEAD"]);
    expect(after).not.toBe(before);
    // A real merge commit: two parents, so the gate let the actual operation
    // through rather than quietly degrading it to something else.
    expect(
      git(world.work, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" "),
    ).toHaveLength(3);
    git(world.work, ["reset", "--hard", "-q", before]);
  });

  it("refuses when neither side carries the tip, which is the real hazard", () => {
    // The destination is behind and so is the incoming branch, so the commit
    // this merge would write does not contain `origin/main` at all. That is
    // the case worth refusing: the result itself is stale, not merely its
    // ingredients.
    git(world.work, ["checkout", "-q", "-B", "behind-dest", world.base]);
    const before = git(world.work, ["rev-parse", "HEAD"]);

    const merge = run(world.work, "git", ["merge", "--no-ff", "--no-edit", "stale"]);
    expect(merge.status).not.toBe(0);
    expect(merge.output).toContain("REFUSED");
    expect(merge.output).toContain("this merge would not contain origin/main");
    expect(merge.output).toContain("git pull --ff-only");
    expect(git(world.work, ["rev-parse", "HEAD"])).toBe(before);

    run(world.work, "git", ["merge", "--abort"]);
    git(world.work, ["checkout", "-q", "main"]);
  });

  it("gates the conflicted merge too, which git finishes through git commit", () => {
    // `pre-merge-commit` never runs when the merge stops on a conflict. Without
    // the `pre-commit` half, the ungated path would be the merges most likely
    // to be carrying a surprise, since a base far enough behind to matter is a
    // base likely to conflict. Both sides here are behind the tip, so the
    // result would be stale and the gate must refuse.
    git(world.work, ["checkout", "-q", "-B", "behind-a", world.base]);
    commit(world.work, "README.md", "a's idea of one\n", "behind-a edits README");
    git(world.work, ["checkout", "-q", "-B", "behind-b", world.base]);
    commit(world.work, "README.md", "b's idea of one\n", "behind-b edits README");
    git(world.work, ["checkout", "-q", "behind-a"]);

    const merge = run(world.work, "git", ["merge", "--no-ff", "--no-edit", "behind-b"]);
    expect(merge.status).not.toBe(0);
    expect(merge.output).toContain("CONFLICT");

    // Resolve it the way a person would, then try to land it.
    const before = git(world.work, ["rev-parse", "HEAD"]);
    writeFileSync(join(world.work, "README.md"), "resolved\n");
    git(world.work, ["add", "README.md"]);
    const landed = run(world.work, "git", ["commit", "--no-edit"]);
    expect(landed.status).not.toBe(0);
    expect(landed.output).toContain("REFUSED");
    expect(git(world.work, ["rev-parse", "HEAD"])).toBe(before);

    run(world.work, "git", ["merge", "--abort"]);
    git(world.work, ["checkout", "-q", "main"]);
  });

  it("can fail: without the gate installed, the stale-result merge lands", () => {
    // The non-vacuity proof for this whole suite. Every refusal above is a
    // non-zero exit from `git merge`, and git has plenty of reasons of its own
    // to exit non-zero — so show the identical merge succeeding with
    // `core.hooksPath` unset. If this test ever fails, the refusals above were
    // measuring something other than the gate.
    git(world.work, ["config", "--unset", "core.hooksPath"]);
    git(world.work, ["checkout", "-q", "-B", "behind-dest-2", world.base]);
    const before = git(world.work, ["rev-parse", "HEAD"]);

    const merge = run(world.work, "git", ["merge", "--no-ff", "--no-edit", "stale"]);
    expect({ status: merge.status, refused: merge.output.includes("REFUSED") }).toEqual({
      status: 0,
      refused: false,
    });
    expect(git(world.work, ["rev-parse", "HEAD"])).not.toBe(before);
  });
});
