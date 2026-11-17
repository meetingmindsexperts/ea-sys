/**
 * The gate and CI stay the same list, and the push hook does what it says
 * (Nov 17, 2026).
 *
 * `npm run gate` exists so that "the gate passed" means the same thing on a
 * laptop as on GitHub. That is only true while the two lists agree, and lists
 * kept in two files drift: AGENTS.md rule 5 named four commands while CI ran
 * twenty. So:
 *
 *  1. every command a GATING CI job runs is either run by the gate or named
 *     below as left to CI, with the reason. A new CI step fails here until
 *     someone decides which;
 *  2. every guard script on disk is run by CI (the gate finds them by name);
 *  3. the push hook is run for real, in a scratch repository: refused without
 *     a gate record, allowed with one, and the owner's override is recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

const gate = read("scripts/gate.sh");
const prePush = read(".githooks/pre-push");
const preCommit = read(".githooks/pre-commit");

const deploy = read(".github/workflows/deploy.yml");

/** The text of one job of deploy.yml: from its `  name:` line to the next job's. */
function jobBlock(name: string): string {
  const lines = deploy.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`deploy.yml has no job named ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^  [\w-]+:\s*$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** The jobs the image build waits for: a red one stops the deploy. */
const gatingJobs = (/^    needs: \[([^\]]+)\]/m.exec(jobBlock("build-push"))?.[1] ?? "").split(",").map((j) => j.trim());

/** Every command line those jobs run: the first words of each line that starts a tool. */
function ciCommands(): string[] {
  const commands = new Set<string>();
  for (const job of gatingJobs) {
    for (const raw of jobBlock(job).split("\n")) {
      const line = raw
        .trim()
        .replace(/^(?:- )?run:\s*\|?\s*/, "")
        .replace(/^[A-Z_]+=\S+\s+/, "");
      const tool = /^(npm (?:run [\w:-]+|test|ci|install)|npx [\w-]+(?: [a-z]+){0,2}|bash scripts\/[\w.-]+|node scripts\/[\w.-]+)/.exec(line);
      if (tool) commands.add(tool[1]);
    }
  }
  return [...commands].sort();
}

/** What the gate runs, as CI spells it, and the text in gate.sh that runs it. */
const GATE_RUNS: Record<string, string> = {
  "npx prisma generate": 'step "prisma generate" npx prisma generate',
  "npm run type-check": "npm run type-check",
  "npm run lint": 'step "lint" npm run lint',
  "npm test": 'step "unit tests" npm test',
  "npx next build": "npx next build",
};

/** What stays in CI only, and why. A reason, never a shrug. */
const CI_ONLY: Record<string, string> = {
  "npm ci": "the gate copies this checkout's node_modules, and installs only when the lockfile differs",
  "npm install": "the lockfile sync check rewrites package-lock.json to compare it; CI has a throwaway checkout to do that in",
  "npm run test:tenancy": "needs the tenancy Postgres and pgbouncer containers, which agents do not start",
  "npm run test:integration-db": "needs a real Postgres service container",
  "npx prisma migrate deploy": "the migration replay runs the whole chain on an empty database CI provides",
  "npx prisma migrate diff": "the second half of the migration replay",
};

const guardsOnDisk = fs
  .readdirSync(path.join(ROOT, "scripts"))
  .filter((f) => /^check-.*\.(sh|mjs)$/.test(f))
  .sort();

describe("the gate runs what CI gates on", () => {
  it("CI's gating jobs are the five this test was written against", () => {
    // A sixth gating job is a new class of check: decide whether the gate runs it.
    expect([...gatingJobs].sort()).toEqual(["build", "checks", "migration-replay", "tenancy", "tests"]);
  });

  it("every command a gating job runs is run by the gate, or named as left to CI with a reason", () => {
    const undecided = ciCommands().filter((command) => {
      if (/^(bash|node) scripts\/check-/.test(command)) return false; // the guards: next test
      return !(command in GATE_RUNS) && !(command in CI_ONLY);
    });
    expect(undecided).toEqual([]);
  });

  it("the gate really contains each command it is said to run", () => {
    for (const [command, text] of Object.entries(GATE_RUNS)) {
      expect(gate.includes(text), `${command}: gate.sh no longer contains \`${text}\``).toBe(true);
    }
  });

  it("neither list names a command CI no longer runs", () => {
    const ci = new Set(ciCommands());
    const stale = [...Object.keys(GATE_RUNS), ...Object.keys(CI_ONLY)].filter((command) => !ci.has(command));
    expect(stale).toEqual([]);
  });

  it("every guard script on disk is run by CI, and the gate finds guards by name", () => {
    const ci = new Set(ciCommands());
    const notInCi = guardsOnDisk.filter((g) => !ci.has(`${g.endsWith(".sh") ? "bash" : "node"} scripts/${g}`));
    expect(notInCi).toEqual([]);
    expect(guardsOnDisk.length).toBeGreaterThanOrEqual(15);
    expect(gate).toContain("for guard in scripts/check-*.sh; do");
    expect(gate).toContain("for guard in scripts/check-*.mjs; do");
  });

  it("the gate also runs what CI does not: the browser suite, with the route smoke test in it", () => {
    expect(gate).toContain("npx playwright test");
    expect(fs.existsSync(path.join(ROOT, "e2e/route-smoke.spec.ts"))).toBe(true);
    // The suite's own config must not exclude it.
    expect(read("playwright.config.ts")).not.toMatch(/testIgnore:[^\]]*route-smoke/);
  });

  it("a commit is recorded as passed only when nothing failed", () => {
    const failedExit = gate.indexOf('if [ -n "$FAILED" ]; then');
    const writesStamp = gate.indexOf('> "$STAMP"');
    expect(failedExit).toBeGreaterThan(0);
    expect(writesStamp).toBeGreaterThan(failedExit);
    expect(gate.slice(failedExit, writesStamp)).toContain("exit 1");
    // A record from an earlier run of the same commit must not outlive a red one.
    expect(gate).toContain('rm -f "$STAMP"');
  });

  it("the gate checks out the commit alone, and the hooks check what is staged", () => {
    expect(gate).toContain('git worktree add --detach "$WT" "$SHA"');
    expect(preCommit).toContain("git checkout-index -a --prefix=");
    expect(preCommit).toContain('export GIT_WORK_TREE="$TMP"');
  });

  it("gate, hook and installer share one definition of where a pass is recorded", () => {
    for (const script of [gate, prePush]) expect(script).toContain("scripts/gate-stamp.sh");
    expect(read("scripts/install-git-hooks.sh")).toContain("git config core.hooksPath .githooks");
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.gate).toBe("bash scripts/gate.sh");
    expect(scripts["hooks:install"]).toBe("bash scripts/install-git-hooks.sh");
  });

  it("the test server can never reach AWS: bogus keys and a dead endpoint", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain('AWS_ENDPOINT_URL: "http://127.0.0.1:9"');
    expect(config).toContain('AWS_ACCESS_KEY_ID: "not-a-real-key"');
    expect(config).toContain('AWS_PROFILE: ""');
  });
});

describe("THE REAL HOOK: pre-push in a scratch repository", () => {
  let repo: string;
  let sha: string;
  const ZERO = "0".repeat(40);

  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  /** Run the hook as git does: the ref lines on stdin. */
  const push = (line: string, env: Record<string, string> = {}) =>
    spawnSync("bash", [path.join(repo, ".githooks/pre-push"), "origin", "git@example.invalid:x/y.git"], {
      cwd: repo,
      input: `${line}\n`,
      encoding: "utf8",
      // No GitHub question from a unit test: that check fails open and is not what is under test.
      env: { ...process.env, GATE_NO_CI_CHECK: "1", GATE_OVERRIDE: "", ...env },
    });
  const stampDir = () => path.join(repo, ".git/gate");

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "gate-hook-"));
    fs.mkdirSync(path.join(repo, ".githooks"));
    fs.mkdirSync(path.join(repo, "scripts"));
    fs.copyFileSync(path.join(ROOT, ".githooks/pre-push"), path.join(repo, ".githooks/pre-push"));
    fs.copyFileSync(path.join(ROOT, "scripts/gate-stamp.sh"), path.join(repo, "scripts/gate-stamp.sh"));
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
    sha = git("rev-parse", "HEAD");
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it("refuses a push to main whose tip has no gate record, and says what to run", () => {
    const out = push(`refs/heads/main ${sha} refs/heads/main ${ZERO}`);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("PUSH REFUSED");
    expect(out.stdout).toContain(`npm run gate -- ${sha.slice(0, 8)}`);
  });

  it("the refusal is about the commit being pushed, whatever the local ref is called (a push by SHA)", () => {
    expect(push(`${sha} ${sha} refs/heads/main ${ZERO}`).status).toBe(1);
  });

  it("does not gate a push to another branch, or a delete", () => {
    expect(push(`refs/heads/x ${sha} refs/heads/feature ${ZERO}`).status).toBe(0);
    expect(push(`(delete) ${ZERO} refs/heads/main ${sha}`).status).toBe(0);
  });

  it("the owner's override pushes without a record, and is written down", () => {
    const out = push(`refs/heads/main ${sha} refs/heads/main ${ZERO}`, { GATE_OVERRIDE: "1" });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("Recorded");
    expect(fs.readFileSync(path.join(stampDir(), "overrides.log"), "utf8")).toContain(`override ${sha} the gate`);
  });

  it("allows the push once the gate has recorded that exact commit, and only that commit", () => {
    fs.mkdirSync(stampDir(), { recursive: true });
    fs.writeFileSync(path.join(stampDir(), `${sha}.ok`), "passed\n");
    expect(push(`refs/heads/main ${sha} refs/heads/main ${ZERO}`).status).toBe(0);

    git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
    const next = git("rev-parse", "HEAD");
    // A commit on top of a gated one is a different tip: it needs its own run.
    expect(push(`refs/heads/main ${next} refs/heads/main ${sha}`).status).toBe(1);
  });
});
