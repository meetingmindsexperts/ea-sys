/**
 * The gate and CI stay the same list, and the gate and the hooks do what they
 * say (Nov 17, 2026).
 *
 * `npm run gate` exists so that "the gate passed" means the same thing on a
 * laptop as on GitHub. That is only true while the two lists agree, and lists
 * kept in two files drift: AGENTS.md rule 5 named four commands while CI ran
 * twenty. So:
 *
 *  1. EVERY line a check job of deploy.yml runs is classified here: run by the
 *     gate, left to CI with a reason, or plumbing. A line nobody classified
 *     fails, whatever tool it starts (the first version matched only npm, npx,
 *     bash and node, so `./scripts/x.sh` or `make check` was invisible);
 *  2. every guard script on disk is run by CI (the gate finds them by name);
 *  3. the gate, the push hook and the commit hook are each RUN, in a scratch
 *     repository with the tools stubbed: a red step leaves no record, a record
 *     passes only its own commit, a file staged mid-check is refused.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

const gate = read("scripts/gate.sh");
const prePush = read(".githooks/pre-push");
const deploy = read(".github/workflows/deploy.yml");

/** The lines of one job of deploy.yml: from its `  name:` line to the next job's. */
function jobLines(name: string): string[] {
  const lines = deploy.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`deploy.yml has no job named ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[\w-]+:\s*$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end);
}

/** The jobs a job waits for, as written in its `needs:` line (one name, or a list). */
function needsOf(job: string): string[] {
  const line = jobLines(job).find((l) => /^ {4}needs:/.test(l));
  if (!line) return [];
  return line.replace(/^ {4}needs:\s*/, "").replace(/[[\]]/g, "").split(",").map((j) => j.trim()).filter(Boolean);
}

/** Everything the deploy waits for, directly or through another job. */
function waitedForBy(job: string, seen = new Set<string>()): Set<string> {
  for (const need of needsOf(job)) {
    if (!seen.has(need)) {
      seen.add(need);
      waitedForBy(need, seen);
    }
  }
  return seen;
}

/** The two jobs that deliver (build the images, switch the box). Every other job the deploy waits for is a check. */
const DELIVERY = ["build-push", "deploy"];
const checkJobs = [...waitedForBy("deploy")].filter((j) => !DELIVERY.includes(j)).sort();

/** Every line of every `run:` of a job, and every action it `uses:`. */
function runLinesAndActions(job: string): { lines: string[]; actions: string[] } {
  const lines: string[] = [];
  const actions: string[] = [];
  let blockIndent = -1;
  for (const raw of jobLines(job)) {
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent >= 0) {
      if (raw.trim() === "") continue;
      if (indent > blockIndent) {
        lines.push(raw.trim());
        continue;
      }
      blockIndent = -1;
    }
    const uses = /^\s*(?:- )?uses:\s*(\S+)/.exec(raw);
    if (uses) actions.push(uses[1].replace(/@.*$/, ""));
    const run = /^(\s*)(- )?run:\s*(.*)$/.exec(raw);
    if (!run) continue;
    if (/^[|>][+-]?$/.test(run[3])) blockIndent = run[1].length + (run[2] ? 2 : 0);
    else lines.push(run[3]);
  }
  return { lines, actions };
}

/** A run line without what does not change which tool runs: env prefixes, `&`, a line continuation. */
const normalise = (line: string) => line.replace(/^(?:[A-Z_]+=\S+\s+)+/, "").replace(/\s*&$/, "").replace(/\s*\\$/, "").trim();

const allRunLines = [...new Set(checkJobs.flatMap((j) => runLinesAndActions(j).lines.map(normalise)))].sort();
const allActions = [...new Set(checkJobs.flatMap((j) => runLinesAndActions(j).actions))].sort();

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
  "npm install --package-lock-only --no-audit --no-fund": "the lockfile sync check rewrites package-lock.json to compare it; CI has a throwaway checkout to do that in",
  "npm run test:tenancy": "needs the tenancy Postgres and pgbouncer containers, which agents do not start",
  "npm run test:integration-db": "needs a real Postgres service container",
  "npx prisma migrate deploy": "the migration replay runs the whole chain on an empty database CI provides",
  "npx prisma migrate diff": "the second half of the migration replay",
};

/** Shell around the checks that is not itself a check. Whole lines, so a new command cannot hide in one. */
const PLUMBING = [
  /^TYPECHECK_PID=\$!$/,
  /^wait "\$TYPECHECK_PID"$/,
  /^if ! git diff --exit-code package-lock\.json; then$/,
  /^echo "::error::package-lock\.json is out of sync[^"]*"$/,
  /^exit 1$/,
  /^fi$/,
  /^--from-url "\$DATABASE_URL"$/,
  /^--to-schema-datamodel prisma$/,
  /^--exit-code$/,
];

const GUARD_LINE = /^(?:bash|node) scripts\/(check-[\w-]+\.(?:sh|mjs))$/;
const guardsInCi = allRunLines.map((l) => GUARD_LINE.exec(l)?.[1]).filter((g): g is string => Boolean(g));

const guardsOnDisk = fs
  .readdirSync(path.join(ROOT, "scripts"))
  .filter((f) => /^check-.*\.(sh|mjs)$/.test(f))
  .sort();

describe("the gate runs what CI gates on", () => {
  it("the check jobs are the five this test was written against", () => {
    // Everything the deploy waits for, through any chain of `needs`. A sixth is a new class of check.
    expect(checkJobs).toEqual(["build", "checks", "migration-replay", "tenancy", "tests"]);
    expect(allRunLines.length).toBeGreaterThan(30);
  });

  it("EVERY line a check job runs is classified: the gate runs it, CI alone runs it for a stated reason, or it is plumbing", () => {
    const unclassified = allRunLines.filter(
      (line) => !GUARD_LINE.test(line) && !(line in GATE_RUNS) && !(line in CI_ONLY) && !PLUMBING.some((p) => p.test(line)),
    );
    expect(unclassified).toEqual([]);
  });

  it("the classifier really refuses a line nobody listed, whatever tool it starts", () => {
    const known = (line: string) => GUARD_LINE.test(line) || line in GATE_RUNS || line in CI_ONLY || PLUMBING.some((p) => p.test(line));
    for (const line of ["./scripts/check-new.sh", "sh scripts/x.sh", "python3 scripts/audit.py", "make check", "npm audit --audit-level=high", "npm run lint -- --max-warnings 0", "cd worker && npm run test:worker", "if ! npm run test:contract; then"]) {
      expect(`${line}: ${known(normalise(line))}`).toBe(`${line}: false`);
    }
    expect(known(normalise("NODE_OPTIONS=--max-old-space-size=6144 npm run type-check &"))).toBe(true);
  });

  it("a check job uses only the three setup actions: an action that is itself a check must be decided here", () => {
    expect(allActions).toEqual(["actions/cache", "actions/checkout", "actions/setup-node"]);
  });

  it("the gate really contains each command it is said to run", () => {
    for (const [command, text] of Object.entries(GATE_RUNS)) {
      expect(gate.includes(text), `${command}: gate.sh no longer contains \`${text}\``).toBe(true);
    }
  });

  it("neither list names a line CI no longer runs", () => {
    const stale = [...Object.keys(GATE_RUNS), ...Object.keys(CI_ONLY)].filter((command) => !allRunLines.includes(command));
    expect(stale).toEqual([]);
  });

  it("every guard script on disk is run by CI, and the gate finds guards by name", () => {
    expect(guardsOnDisk.filter((g) => !guardsInCi.includes(g))).toEqual([]);
    expect(guardsOnDisk.length).toBeGreaterThanOrEqual(15);
    expect(gate).toContain("for guard in scripts/check-*.sh; do");
    expect(gate).toContain("for guard in scripts/check-*.mjs; do");
  });

  it("the gate also runs what CI does not: the browser suite, with the route smoke test in it", () => {
    expect(gate).toContain("npx playwright test --forbid-only");
    expect(fs.existsSync(path.join(ROOT, "e2e/route-smoke.spec.ts"))).toBe(true);
    expect(read("playwright.config.ts")).not.toMatch(/testIgnore:[^\]]*route-smoke/);
  });

  it("a committed `.only` cannot shrink a suite to one test and pass", () => {
    expect(gate).toContain("npm test -- --allowOnly=false");
    expect(gate).toContain("--forbid-only");
  });

  it("gate, hook and installer share one definition of where a pass is recorded", () => {
    for (const script of [gate, prePush]) expect(script).toContain("scripts/gate-stamp.sh");
    expect(read("scripts/install-git-hooks.sh")).toContain("git config core.hooksPath .githooks");
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.gate).toBe("bash scripts/gate.sh");
    expect(scripts["hooks:install"]).toBe("bash scripts/install-git-hooks.sh");
  });

  it("the test server can reach neither AWS nor Sentry", () => {
    const config = read("playwright.config.ts");
    expect(config).toContain('AWS_ENDPOINT_URL: "http://127.0.0.1:9"');
    expect(config).toContain('AWS_ACCESS_KEY_ID: "not-a-real-key"');
    expect(config).toContain('AWS_PROFILE: ""');
    expect(config).toContain('SENTRY_DSN: ""');
  });
});

// ── The scripts themselves, run in scratch repositories ─────────────────────

const IDENTITY = ["-c", "user.email=t@example.invalid", "-c", "user.name=t"];

/** A scratch repository with the named files of this one copied in, and stub tools first on PATH. */
function scratchRepo(copies: string[], stubs: Record<string, string>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gate-scratch-")));
  const repo = path.join(dir, "repo");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  for (const file of copies) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(repo, file));
  }
  for (const [name, body] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  const env = (extra: Record<string, string> = {}) => {
    const clean: Record<string, string | undefined> = { ...process.env, ...extra };
    // The suite may itself be running inside a git hook or a gate: none of that may leak in.
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GATE_OVERRIDE", "GATE_WORKDIR"]) if (!(key in extra)) delete clean[key];
    return { ...clean, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir };
  };
  const git = (...args: string[]) => {
    const out = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: env() });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const run = (script: string, extra: Record<string, string> = {}, input = "") =>
    spawnSync("bash", [path.join(repo, script)], { cwd: repo, encoding: "utf8", input, env: env(extra) });
  git("init", "-q", "-b", "main");
  return { dir, repo, git, write, run, commit: (message: string) => git(...IDENTITY, "commit", "-q", "-m", message), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("THE REAL GATE, with every tool stubbed: what it records and when", () => {
  let s: ReturnType<typeof scratchRepo>;
  /** npm and npx succeed unless their arguments contain $STUB_FAIL. Nothing listens on 3199 as far as the gate can tell. */
  const tool = 'case "$*" in *"${STUB_FAIL:-no-such-step}"*) echo "stub: failing $*"; exit 1 ;; esac\nexit 0';
  const stamp = (sha: string) => path.join(s.repo, ".git/gate", `${sha}.ok`);
  const gateRun = (extra: Record<string, string> = {}) => s.run("scripts/gate.sh", { GATE_WORKDIR: path.join(s.dir, "work"), ...extra });

  beforeAll(() => {
    s = scratchRepo(["scripts/gate.sh", "scripts/gate-stamp.sh"], { npm: tool, npx: tool, lsof: "exit 1" });
    fs.mkdirSync(path.join(s.dir, "work"));
    s.write("package.json", "{}\n");
    s.write("package-lock.json", "{}\n");
    s.write("scripts/check-alpha.sh", "exit 0\n");
    s.write("scripts/check-beta.mjs", "process.exit(0);\n");
    s.write(".gitignore", "node_modules\n");
    s.write("node_modules/marker.txt", "x\n");
    s.git("add", "package.json", "package-lock.json", "scripts/check-alpha.sh", "scripts/check-beta.mjs", "scripts/gate.sh", "scripts/gate-stamp.sh", ".gitignore");
    s.commit("one");
  });
  afterAll(() => s.remove());

  it("green: every step passes, the commit is recorded, the worktree and the lock are gone", () => {
    const sha = s.git("rev-parse", "HEAD");
    const out = gateRun();
    expect(out.stdout).toContain(`GATE GREEN for ${sha.slice(0, 8)}`);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/PASS {2}guard check-alpha/);
    expect(out.stdout).toMatch(/PASS {2}guard check-beta/);
    expect(fs.readFileSync(stamp(sha), "utf8")).toContain(`commit ${sha}`);
    expect(fs.existsSync(path.join(s.repo, ".git/gate/lock"))).toBe(false);
    expect(fs.readdirSync(path.join(s.dir, "work"))).toEqual([]);
  });

  it.each([["type-check"], ["lint"], ["test"], ["next build"], ["playwright"]])("red when the %s step fails: exit 1, and the record of an earlier green run of the same commit is gone", (step) => {
    const sha = s.git("rev-parse", "HEAD");
    expect(gateRun().status).toBe(0);
    expect(fs.existsSync(stamp(sha))).toBe(true);

    const out = gateRun({ STUB_FAIL: step });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("GATE RED");
    expect(fs.existsSync(stamp(sha))).toBe(false);
  });

  it("red when a guard script fails, and the failing guard is named", () => {
    s.write("scripts/check-alpha.sh", "echo 'alpha says no'; exit 1\n");
    s.git("add", "scripts/check-alpha.sh");
    s.commit("a failing guard");
    const sha = s.git("rev-parse", "HEAD");
    const out = gateRun();
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/FAIL {2}guard check-alpha/);
    expect(out.stdout).toContain("[guard check-alpha]");
    expect(fs.existsSync(stamp(sha))).toBe(false);
  });

  it("it gates the commit named, not the working tree: an uncommitted fix does not make it green", () => {
    s.write("scripts/check-alpha.sh", "exit 0\n"); // fixed on disk only
    expect(gateRun().status).toBe(1);
    s.git("add", "scripts/check-alpha.sh");
    s.commit("the guard passes again");
    expect(gateRun().status).toBe(0);
  });

  it("refuses to start while another gate holds the lock, and leaves that lock alone", () => {
    const lock = path.join(s.repo, ".git/gate/lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid)); // a live process: this test run
    fs.writeFileSync(path.join(lock, "sha"), "abcdef12");
    const out = gateRun();
    expect(out.status).toBe(3);
    expect(out.stdout).toContain("another gate is running");
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(lock, { recursive: true });
  });

  it("takes over a lock whose holder is dead", () => {
    const lock = path.join(s.repo, ".git/gate/lock");
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "pid"), "999999");
    expect(gateRun().status).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("says so at once when port 3199 is taken, instead of failing four minutes in", () => {
    const busy = scratchRepo(["scripts/gate.sh", "scripts/gate-stamp.sh"], { npm: tool, npx: tool, lsof: "echo 4242" });
    try {
      busy.write("package.json", "{}\n");
      busy.git("add", "package.json", "scripts/gate.sh", "scripts/gate-stamp.sh");
      busy.commit("one");
      const out = busy.run("scripts/gate.sh", { GATE_WORKDIR: busy.dir });
      expect(out.status).toBe(3);
      expect(out.stdout).toContain("port 3199 is in use by pid 4242");
    } finally {
      busy.remove();
    }
  });
});

describe("THE REAL HOOK: pre-push in a scratch repository", () => {
  let s: ReturnType<typeof scratchRepo>;
  let sha: string;
  const ZERO = "0".repeat(40);
  /** Run the hook as git does: the ref lines on stdin. No GitHub question from a unit test. */
  const push = (line: string, extra: Record<string, string> = {}) => s.run(".githooks/pre-push", { GATE_NO_CI_CHECK: "1", ...extra }, `${line}\n`);
  const stampDir = () => path.join(s.repo, ".git/gate");

  beforeAll(() => {
    s = scratchRepo([".githooks/pre-push", "scripts/gate-stamp.sh"], {});
    s.git(...IDENTITY, "commit", "-q", "--allow-empty", "-m", "one");
    sha = s.git("rev-parse", "HEAD");
  });
  afterAll(() => s.remove());

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

    s.git(...IDENTITY, "commit", "-q", "--allow-empty", "-m", "two");
    const next = s.git("rev-parse", "HEAD");
    // A commit on top of a gated one is a different tip: it needs its own run.
    expect(push(`refs/heads/main ${next} refs/heads/main ${sha}`).status).toBe(1);
  });

  it("a deploy already running refuses the push; a gh that cannot answer does not", () => {
    const withGh = (body: string) => {
      const r = scratchRepo([".githooks/pre-push", "scripts/gate-stamp.sh"], { gh: body });
      r.git(...IDENTITY, "commit", "-q", "--allow-empty", "-m", "one");
      const tip = r.git("rev-parse", "HEAD");
      fs.mkdirSync(path.join(r.repo, ".git/gate"), { recursive: true });
      fs.writeFileSync(path.join(r.repo, ".git/gate", `${tip}.ok`), "passed\n");
      const out = r.run(".githooks/pre-push", {}, `refs/heads/main ${tip} refs/heads/main ${ZERO}\n`);
      r.remove();
      return out;
    };
    const running = withGh("echo 1");
    expect(running.status).toBe(1);
    expect(running.stdout).toContain("a deploy of main is running or queued");
    expect(withGh("echo 0").status).toBe(0);
    expect(withGh("exit 1").status).toBe(0); // not signed in, no network: fails open
  });
});

describe("THE REAL HOOK: pre-commit in a scratch repository", () => {
  let s: ReturnType<typeof scratchRepo>;
  // The guard fails when the staged tree holds `forbidden.txt`. With RACE_REPO set it first
  // stages a file in the real checkout, as another session would in the middle of the check.
  const guard = [
    'if [ -n "${RACE_REPO:-}" ]; then env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C "$RACE_REPO" add late.txt; fi',
    'if [ -f forbidden.txt ]; then echo "forbidden.txt is in the tree"; exit 1; fi',
    "exit 0",
  ].join("\n");
  /** eslint's stand-in: refuses a file whose text holds LINT_ERROR. */
  const npx = 'shift; shift\nfor f in "$@"; do if grep -q LINT_ERROR "$f"; then echo "$f: error"; exit 1; fi; done\nexit 0';
  const hook = (extra: Record<string, string> = {}) => s.run(".githooks/pre-commit", extra);

  beforeEach(() => {
    s = scratchRepo([".githooks/pre-commit"], { npx });
    s.write("scripts/check-tree.sh", `${guard}\n`);
    s.write(".gitignore", "node_modules\n");
    s.write("node_modules/marker.txt", "x\n");
    s.write("src/a.ts", "export const a = 1;\n");
    s.git("add", "scripts/check-tree.sh", ".gitignore", "src/a.ts", ".githooks/pre-commit");
    s.commit("one");
  });
  afterAll(() => s?.remove());

  it("passes clean staged files, and says what it ran", () => {
    s.write("src/b.ts", "export const b = 2;\n");
    s.git("add", "src/b.ts");
    const out = hook();
    expect(out.stdout).toContain("lint and 1 guards passed on the staged files");
    expect(out.status).toBe(0);
    s.remove();
  });

  it("refuses a staged file a guard objects to, and a staged lint error, naming each", () => {
    s.write("forbidden.txt", "x\n");
    s.git("add", "forbidden.txt");
    const guarded = hook();
    expect(guarded.status).toBe(1);
    expect(guarded.stdout).toContain("COMMIT REFUSED by guard scripts/check-tree.sh");

    s.git("rm", "-q", "--cached", "forbidden.txt");
    fs.rmSync(path.join(s.repo, "forbidden.txt"));
    s.write("src/with space.ts", "LINT_ERROR\n");
    s.git("add", "src/with space.ts");
    const linted = hook();
    expect(linted.status).toBe(1);
    expect(linted.stdout).toContain("COMMIT REFUSED by lint");
    expect(linted.stdout).toContain("src/with space.ts");
    s.remove();
  });

  it("checks what is STAGED: another session's unfinished files in the working tree neither fail nor pass it", () => {
    s.write("src/b.ts", "export const b = 2;\n");
    s.git("add", "src/b.ts");
    s.write("forbidden.txt", "someone else's, not staged\n");
    s.write("src/b.ts", "LINT_ERROR, typed after staging\n");
    expect(hook().status).toBe(0);
    s.remove();
  });

  it("refuses when a file is staged WHILE it checks: that file would be committed unchecked", () => {
    s.write("src/b.ts", "export const b = 2;\n");
    s.git("add", "src/b.ts");
    s.write("late.txt", "another session's\n");
    const out = hook({ RACE_REPO: s.repo });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("what is staged changed while it was being checked");
    expect(out.stdout).toContain("git commit -m");
    s.remove();
  });

  it("leaves the real index and the checkout exactly as they were", () => {
    s.write("src/b.ts", "export const b = 2;\n");
    s.git("add", "src/b.ts");
    s.write("untracked.txt", "x\n");
    const before = s.git("status", "--porcelain=v2");
    const index = fs.readFileSync(path.join(s.repo, ".git/index"));
    expect(hook().status).toBe(0);
    // Byte for byte, read before anything else touches it: the hook works on copies.
    expect(fs.readFileSync(path.join(s.repo, ".git/index")).equals(index)).toBe(true);
    expect(s.git("status", "--porcelain=v2")).toBe(before);
    s.remove();
  });
});
