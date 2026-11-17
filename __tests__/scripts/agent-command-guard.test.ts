/**
 * The agent command guard (Nov 17, 2026): the commands this repository forbids
 * are refused by a hook, not left to an agent's memory.
 *
 * Each "refused" case is a rule that was prose until now and that the agent
 * permission file pre-approved (`npx prisma migrate dev`, `docker compose`,
 * `git push`). Each "allowed" case is a command agents run every day, or text
 * that only MENTIONS a forbidden command: a guard that refuses a commit message
 * for naming `prisma migrate dev` gets switched off within the week.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// A plain .mjs on purpose: the hook starts it with bare node on every command.
import { refusalFor, hookAnswer } from "../../scripts/agent-command-guard.mjs";

const ROOT = path.resolve(__dirname, "../..");
const decision = (command: string) => refusalFor(command)?.decision ?? "allow";

describe("refused outright", () => {
  it.each([
    ["npx prisma migrate dev --name add_column"],
    ["npx prisma migrate reset"],
    ["prisma migrate reset --force"],
    ["./node_modules/.bin/prisma migrate dev"],
    ["npx --yes prisma@6 migrate reset"],
    ["pnpm exec prisma migrate dev"],
    ["DATABASE_URL=postgres://x npx prisma migrate dev"],
    ["cd prisma && npx prisma migrate dev"],
    ['npx prisma migrate diff --shadow-database-url "$DIRECT_URL" --from-migrations prisma/migrations'],
    ["npx prisma db push --accept-data-loss"],
  ])("the database footguns: %s", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    ["docker compose --profile tenancy up -d"],
    ["docker ps"],
    ["docker-compose up -d"],
    ["docker exec ea-sys-tenancy-db psql -U postgres -c 'select 1'"],
    ["sudo docker ps"],
    ["for c in a b; do docker rm $c; done"],
    ["echo $(docker ps -q)"],
    ['bash -lc "docker ps"'],
    ["bash <<EOF\ndocker ps\nEOF"],
    ["ssh box docker ps"],
    ["ls | xargs docker rm"],
  ])("docker, reads included: %s", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    ["git add -A"],
    ["git add --all"],
    ["git add ."],
    ["git add -u"],
    ["git add -- ."],
    ["cd src && git add ."],
    ["git commit -am wip"],
    ["git commit -a -m wip"],
    ["git commit --all -m wip"],
  ])("staging other sessions' work: %s", (command) => {
    expect(decision(command)).toBe("deny");
  });

  it.each([
    ["git commit --no-verify -m x"],
    ["git commit -n -m x"],
    ["git push --no-verify origin abc:main"],
    ["GATE_OVERRIDE=1 git push origin abc:main"],
    ["export GATE_OVERRIDE=1"],
    ["GATE_NO_CI_CHECK=1 git push origin abc:main"],
    ["git push --force origin main"],
    ["git push -f"],
    ["git push --force-with-lease"],
    ["git push origin +abc:main"],
  ])("switching the hooks off, or forcing a push: %s", (command) => {
    expect(decision(command)).toBe("deny");
  });
});

describe("the owner is asked", () => {
  it.each([
    ["git push origin abc1234:main"],
    ["git push"],
    ["git -C /somewhere push origin main"],
    ["git reset --hard HEAD~1"],
    ["git checkout -- ."],
    ["git restore ."],
    ["git clean -fd"],
    ["git stash"],
    ["git stash pop"],
    ["npx prisma db push"],
    ["aws ssm send-command --instance-ids i-0 --document-name AWS-RunShellScript"],
    ["aws s3 rm s3://bucket/key"],
    ["aws ec2 reboot-instances --instance-ids i-0"],
  ])("%s", (command) => {
    expect(decision(command)).toBe("ask");
  });
});

describe("allowed: everyday commands, and text that only mentions a forbidden one", () => {
  it.each([
    ["npm run db:migrate"],
    ["npx prisma migrate deploy"],
    ["npx prisma generate"],
    ["npx prisma validate"],
    ["npm run db:snapshot"],
    ["npm run db:refresh"],
    ["npm run gate"],
    ['git add src/lib/a.ts "src/app/(dashboard)/events/[eventId]/page.tsx"'],
    ["git add src/{a,b}.ts"],
    ["git commit -m 'fix: a thing'"],
    ['git commit -m "docs: never run prisma migrate dev, docker compose or git add -A"'],
    ["git commit -m \"$(cat <<'EOF'\nfix(db): prisma migrate reset is refused\n\ndocker compose up is handed to the owner; git push --force too.\nEOF\n)\""],
    ["cat > notes.md <<EOF\ndocker compose --profile tenancy up -d\nnpx prisma migrate dev\ngit add -A\nEOF"],
    ["grep -rn 'docker compose' AGENTS.md docs/"],
    ["grep -rn -- --shadow-database-url docs/"],
    ["echo 'run: docker compose up -d'"],
    ["git checkout -- src/lib/a.ts"],
    ["git restore --staged src/lib/a.ts"],
    ["git stash list"],
    ["git status --short && git diff --stat"],
    ["git log --oneline -5; git rev-parse HEAD"],
    ["git worktree remove --force /tmp/x"],
    ["echo ${HOME}/x 2>&1 | head -3"],
    ["gh run list --workflow deploy.yml --limit 5"],
    ["aws logs start-query --region ap-south-1 --log-group-name ea-sys/app --start-time 1 --end-time 2 --query-string 'fields @message'"],
    ["aws --region ap-south-1 ec2 describe-instances"],
    ["aws logs get-query-results --query-id abc"],
    ["aws sts get-caller-identity"],
    ["aws s3 ls s3://bucket/"],
    ["# docker ps"],
    [""],
  ])("%s", (command) => {
    expect(decision(command)).toBe("allow");
  });
});

describe("a refusal says why, and what to do instead", () => {
  it("names the incident and the sanctioned command", () => {
    expect(refusalFor("npx prisma migrate dev")?.reason).toMatch(/INC-002/);
    expect(refusalFor("npx prisma migrate dev")?.reason).toMatch(/npm run db:migrate/);
    expect(refusalFor("docker ps")?.reason).toMatch(/owner/);
    expect(refusalFor("git add -A")?.reason).toMatch(/explicit paths/);
  });

  it("a refusal beats a prompt when one line holds both", () => {
    expect(decision("git push origin a:main && git add -A")).toBe("deny");
    expect(decision("git stash; docker ps")).toBe("deny");
  });
});

describe("as a Claude Code PreToolUse hook", () => {
  it("answers in the hook's shape, and only for the Bash tool", () => {
    expect(hookAnswer({ tool_name: "Bash", tool_input: { command: "docker ps" } })).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(hookAnswer({ tool_name: "Bash", tool_input: { command: "git push" } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
    expect(hookAnswer({ tool_name: "Bash", tool_input: { command: "ls" } })).toBeNull();
    expect(hookAnswer({ tool_name: "Write", tool_input: { content: "docker ps" } })).toBeNull();
  });

  const run = (stdin: string) =>
    spawnSync("node", [path.join(ROOT, "scripts/agent-command-guard.mjs")], { input: stdin, encoding: "utf8" });

  it("THE REAL PROCESS: reads the hook's JSON on stdin and prints its decision", () => {
    const refused = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npx prisma migrate reset" } }));
    expect(refused.status).toBe(0);
    expect(JSON.parse(refused.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    const allowed = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } }));
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe("");
  });

  it("input it cannot read is put to the owner, never waved through in silence", () => {
    const broken = run("not json");
    expect(broken.status).toBe(0);
    expect(JSON.parse(broken.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("the example settings wire this script to the Bash tool and pre-approve none of what it refuses", () => {
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude/settings.example.json"), "utf8"));
    const bash = example.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === "Bash");
    expect(bash.hooks[0].command).toContain("scripts/agent-command-guard.mjs");
    for (const rule of example.permissions.allow as string[]) {
      const command = rule.replace(/^Bash\(/, "").replace(/(:\*|\s\*)?\)$/, "");
      expect(`${rule}: ${decision(command)}`).toBe(`${rule}: allow`);
    }
  });
});
