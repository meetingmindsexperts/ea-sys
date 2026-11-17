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

/**
 * Review of 398ddca9 (0 BLOCKER, 3 HIGH, 8 MED). Every string below is one the
 * reviewer got past the first version, or one it refused that it should not.
 */
describe("review of 398ddca9: what the first version let through", () => {
  const at = (command: string) => refusalFor(command, { cwd: ROOT })?.decision ?? "allow";

  it.each([
    ["timeout 120 npx prisma migrate dev"],
    ["yarn prisma migrate dev"],
    ["yarn prisma migrate reset --force"],
    ["pnpm prisma migrate dev"],
    ["npx dotenv -e .env -- prisma migrate dev"],
    ["dotenv -e .env -- npx prisma migrate dev"],
    ["npx prisma --schema prisma/schema.prisma migrate dev"],
    ["npx prisma migrate --schema prisma dev"],
    ["/usr/local/bin/npx prisma migrate dev"],
    ["npx prisma migrate dev --create-only --name x"],
    ['timeout 120 npx prisma migrate diff --shadow-database-url "$DIRECT_URL" --from-migrations prisma/migrations'],
    ['npx dotenv -e .env.local -- prisma migrate diff --shadow-database-url "$DIRECT_URL"'],
    ["sudo -u ubuntu docker ps"],
    ["nice -n 10 docker ps"],
    ["env -u FOO docker ps"],
    ["timeout 5 docker ps"],
    ["watch -n1 docker ps"],
    ["a-wrapper-nobody-listed --flag docker compose up"],
  ])("HIGH, a wrapper or a flag's value hid the program: %s", (command) => {
    expect(at(command)).toBe("deny");
  });

  it.each([
    ['ssh -i key.pem ubuntu@host "sudo docker exec ea-sys-worker npx tsx scripts/x.ts"'],
    ["ssh -i key.pem -o StrictHostKeyChecking=no ubuntu@host docker ps"],
    ["ssh -p 22 ubuntu@host docker ps"],
    ["ssh -o ConnectTimeout=5 ubuntu@host 'npx prisma migrate reset'"],
    ["ssh host -- docker ps"],
  ])("HIGH, an ssh option with a value was read as the host: %s", (command) => {
    expect(at(command)).toBe("deny");
  });

  it("an ssh command that runs nothing forbidden on the far side is not refused", () => {
    expect(at("ssh -i key.pem ubuntu@host uptime")).toBe("allow");
  });

  it.each([
    ["git commit -m x ."],
    ["git commit . -m x"],
    ["git add .."],
    ["git add ./."],
    ["git add ./*"],
    ['git add "$PWD"'],
    ["git stage -A"],
  ])("MED, the whole tree by another spelling: %s", (command) => {
    expect(at(command)).toBe("deny");
  });

  it.each([
    ["git add src/"],
    ["git add src/lib"],
    ["git commit src -m x"],
    ["git checkout -f"],
    ["git checkout -f main"],
    ["git switch --discard-changes main"],
    ["git checkout -- src"],
    ["git checkout HEAD -- src/ __tests__/"],
    ["git checkout -- '*'"],
    ["git restore src"],
    ["git restore '*'"],
    ["git reset --merge"],
  ])("MED, a folder or a pattern, and the other ways to discard: the owner is asked: %s", (command) => {
    expect(at(command)).toBe("ask");
  });

  it.each([
    ['echo "$(grep -c "can\'t" notes.txt)"; docker ps'],
    ['echo "count: $(grep -c "don\'t" x)" && git add -A'],
    ['x=$(grep -c ":)" x.txt); docker ps'],
  ])("MED, an apostrophe or a bracket inside a quoted string inside $() swallowed the rest: %s", (command) => {
    expect(at(command)).toBe("deny");
  });

  it("MED, an aws option with no value no longer hides the service", () => {
    expect(at("aws --no-cli-pager s3 cp get-data.json s3://bucket/")).toBe("ask");
    expect(at("aws --no-cli-pager ec2 describe-instances --region ap-south-1")).toBe("allow");
  });

  it.each([
    ["git -c core.hooksPath=/dev/null commit -m x"],
    ["git config core.hooksPath /dev/null"],
    ["git config --unset core.hooksPath"],
    ["touch .git/gate/abc123.ok"],
    ["echo passed > .git/gate/abc123.ok"],
    ['cp a "$(git rev-parse --git-common-dir)/gate/abc.ok"'],
  ])("switching the hooks off, or writing a gate record by hand: %s", (command) => {
    expect(at(command)).toBe("deny");
  });

  it("a command that may drop local data is put to the owner", () => {
    expect(at("LOCAL_DATA_LOSS_OK=1 npm run db:push -- --accept-data-loss")).toBe("ask");
  });

  it.each([
    ["command -v docker"],
    ['git commit -m "-a"'],
    ["git commit -mcleanup"],
    ["git commit -uno -m x"],
    ["git add -n ."],
    ["git clean -n"],
    ["GATE_WORKDIR=/tmp/x npm run gate"],
    ["git config core.hooksPath"],
    ["git checkout main"],
    ["git checkout -b feature/x"],
    ["git checkout -- src/lib/db.ts"],
    ["git checkout HEAD -- src/lib/db.ts package.json"],
    ["git restore --staged src/lib/db.ts"],
    ["git add src/lib/db.ts AGENTS.md"],
    ['git add "src/app/(dashboard)/events/[eventId]/agenda/page.tsx"'],
    ["git commit -q -F - -- src/app/api/organization/route.ts AGENTS.md"],
    ['git commit -m "fix: prisma migrate dev is refused; docker too" -- AGENTS.md'],
    ["cd docker && ls"],
    ["cat docker/Dockerfile.dev"],
    ["ls .git/gate/"],
    ["test -f .git/gate/abc.ok && echo yes"],
    ["yarn dev"],
    ["timeout 60 npm test"],
    ["npx prisma migrate status"],
    ["git reset --soft HEAD~1"],
    ["npm run hooks:install"],
  ])("LOW, refused before and should not be, or everyday work near the new rules: %s", (command) => {
    expect(at(command)).toBe("allow");
  });

  it("the hook hands the working directory on, so a folder is recognised as one", () => {
    const answer = hookAnswer({ tool_name: "Bash", cwd: ROOT, tool_input: { command: "git add src/lib" } });
    expect(answer?.hookSpecificOutput.permissionDecision).toBe("ask");
    // With no directory to look in, only a trailing slash or a pattern says "folder".
    expect(refusalFor("git add src/lib")).toBeNull();
    expect(refusalFor("git add src/lib/")?.decision).toBe("ask");
  });
});
