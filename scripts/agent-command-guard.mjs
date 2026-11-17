#!/usr/bin/env node
/**
 * The seatbelt between a coding agent and the commands this repository forbids
 * (Nov 17, 2026).
 *
 * Until now these rules lived in prose (AGENTS.md, CLAUDE.md) and in an agent's
 * memory, while the agent permission file PRE-APPROVED several of them: `npx
 * prisma migrate dev`, `docker compose`, `git push`. One of them wiped the
 * production database on 2026-07-30 (INC-002). A rule an agent has to remember
 * is a rule that is broken the day the context that held it is gone.
 *
 * Wired as a Claude Code `PreToolUse` hook on the Bash tool (see
 * `.claude/settings.example.json`): it reads the hook's JSON on stdin and answers
 * `deny` (refused outright), `ask` (the owner is prompted) or nothing (allowed).
 * `refusalFor(command)` is the whole rule and is what the tests call.
 *
 * WHAT THIS IS NOT. It is a seatbelt, not a sandbox. It reads the command the
 * agent types: a forbidden command inside a script file the agent then runs,
 * or inside `node -e` / `python -c`, is not seen. It stops the accident, which
 * is every case that has happened so far, not a determined bypass.
 *
 * It judges COMMANDS, not text: `git commit -m "never run prisma migrate dev"`
 * and `grep docker AGENTS.md` are not refused.
 */
import { pathToFileURL } from "node:url";

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** Words that only run another command: the command that matters follows them. */
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "nice", "caffeinate", "xargs"]);
/** Package runners: `npx prisma ...`, `pnpm exec prisma ...`, `npm exec -- prisma ...`. */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const RUNNER_PAIRS = new Set(["npm exec", "npm x", "pnpm exec", "pnpm dlx", "yarn dlx", "yarn exec", "bun x"]);
/** Shell keywords a command can follow: `for f in x; do docker ps; done`. */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Take heredoc bodies out of the text, so a commit message or a document
 * written through `cat <<EOF` is never read as commands. The body of a heredoc
 * fed to a shell (`bash <<EOF`) IS commands, and is returned to be judged.
 */
function withoutHeredocs(text) {
  const shellBodies = [];
  const pattern = /<<-?[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  const stripped = text.replace(pattern, (match, _quote, _word, restOfLine, body, offset) => {
    const lineStart = text.lastIndexOf("\n", offset) + 1;
    const before = text.slice(lineStart, offset);
    const lastCommand = before.split(/[;&|(]/).pop().trim().split(/\s+/)[0];
    if (SHELLS.has(lastCommand.replace(/^.*\//, ""))) shellBodies.push(body);
    return `${restOfLine}\n`;
  });
  return { stripped, shellBodies };
}

/**
 * Split shell text into simple commands, each a list of words. Quotes are
 * honoured (a quoted string is one word, whatever it holds); `;`, `&`, `|`,
 * newlines, parentheses and braces end a command. The text of every `$(...)`
 * and backtick substitution is returned too, to be judged as commands itself.
 */
function simpleCommands(text) {
  const commands = [];
  const nested = [];
  let words = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  /** Index just past the `)` that closes the `$(` opened before `from`. */
  const closeOfSubstitution = (from) => {
    let depth = 1;
    let i = from;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (c === "\\") i += 1;
      else if (c === "'") i = text.indexOf("'", i + 1) < 0 ? text.length : text.indexOf("'", i + 1);
      else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }
    return i;
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      if (text[i + 1] !== "\n") {
        word += text[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const close = end < 0 ? text.length : end;
      word += text.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (c === '"') {
      let j = i + 1;
      inWord = true;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) {
          word += text[j + 1];
          j += 2;
        } else if (text[j] === "$" && text[j + 1] === "(") {
          const close = closeOfSubstitution(j + 2);
          nested.push(text.slice(j + 2, close - 1));
          j = close;
        } else if (text[j] === "`") {
          const end = text.indexOf("`", j + 1);
          const close = end < 0 ? text.length : end;
          nested.push(text.slice(j + 1, close));
          j = close + 1;
        } else {
          word += text[j];
          j += 1;
        }
      }
      i = j + 1;
    } else if (c === "$" && text[i + 1] === "(") {
      const close = closeOfSubstitution(i + 2);
      nested.push(text.slice(i + 2, close - 1));
      word += "$()";
      inWord = true;
      i = close;
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      const close = end < 0 ? text.length : end;
      nested.push(text.slice(i + 1, close));
      word += "$()";
      inWord = true;
      i = close + 1;
    } else if (c === "#" && !inWord) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if ((c === "{" || c === "}") && inWord) {
      // `${HOME}` and `src/{a,b}.ts` are part of a word, not a command group.
      word += c;
      i += 1;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "{" || c === "}") {
      endCommand();
      i += 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i += 1;
    } else {
      word += c;
      inWord = true;
      i += 1;
    }
  }
  endCommand();
  return { commands, nested };
}

/** Drop a wrapper's own flags (`sudo -u x`, `xargs -n 1`, `npx --yes`). */
function afterFlags(words) {
  let i = 0;
  while (i < words.length && words[i].startsWith("-") && words[i] !== "--") i += 1;
  if (words[i] === "--") i += 1;
  return words.slice(i);
}

/**
 * Peel a simple command down to the program that really runs: env assignments,
 * `sudo` and friends, package runners, and a `node_modules/.bin/` path prefix.
 * Returns the assignments seen on the way, for the override rule.
 */
function unwrap(words) {
  const assignments = [];
  let rest = words;
  for (let guard = 0; guard < 12 && rest.length > 0; guard += 1) {
    const first = rest[0];
    const pair = `${first} ${rest[1] ?? ""}`;
    if (ENV_ASSIGNMENT.test(first)) {
      assignments.push(first);
      rest = rest.slice(1);
    } else if (first === "export" && rest[1] && ENV_ASSIGNMENT.test(rest[1])) {
      assignments.push(...rest.slice(1).filter((w) => ENV_ASSIGNMENT.test(w)));
      return { assignments, words: [] };
    } else if (KEYWORDS.has(first)) {
      rest = rest.slice(1);
    } else if (RUNNER_PAIRS.has(pair)) {
      rest = afterFlags(rest.slice(2));
    } else if (WRAPPERS.has(first) || RUNNERS.has(first)) {
      rest = afterFlags(rest.slice(1));
    } else {
      break;
    }
  }
  // `./node_modules/.bin/prisma` and `prisma@6` are both the program `prisma`.
  if (rest.length > 0) rest = [rest[0].replace(/^.*\//, "").replace(/(?<=.)@.*$/, ""), ...rest.slice(1)];
  return { assignments, words: rest };
}

const deny = (reason) => ({ decision: "deny", reason });
const ask = (reason) => ({ decision: "ask", reason });

/** Flags of a git subcommand, short ones split (`-am` is `-a` and `-m`). Stops at `--`. */
function gitFlags(args) {
  const flags = new Set();
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("--")) flags.add(arg.split("=")[0]);
    else if (/^-[A-Za-z]+$/.test(arg)) for (const letter of arg.slice(1)) flags.add(`-${letter}`);
  }
  return flags;
}

/** Git's own options before the subcommand: `git -C dir --no-pager push`. */
function gitSubcommand(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += args[i] === "-C" || args[i] === "-c" || args[i] === "--git-dir" || args[i] === "--work-tree" ? 2 : 1;
  }
  return { sub: args[i], rest: args.slice(i + 1) };
}

function judgeGit(args) {
  const { sub, rest } = gitSubcommand(args);
  const flags = gitFlags(rest);
  const paths = rest.filter((a) => !a.startsWith("-"));

  if (sub === "add") {
    const everything = flags.has("-A") || flags.has("--all") || flags.has("-u") || flags.has("--update");
    const wholeTree = paths.some((p) => p === "." || p === ":/" || p === "*" || p === "./");
    if (everything || wholeTree) {
      return deny(
        "Stage explicit paths only. Other sessions work in this checkout, and `git add -A`, `-u` or `.` stages their files into your commit.",
      );
    }
  }
  if (sub === "commit") {
    if (flags.has("--no-verify") || flags.has("-n")) {
      return deny("An agent may not skip the commit hook. Fix what it reports; only the owner may bypass it.");
    }
    if (flags.has("-a") || flags.has("--all")) {
      return deny("`git commit -a` commits every modified file, other sessions' included. Stage explicit paths, then commit.");
    }
  }
  if (sub === "push") {
    if (flags.has("--no-verify")) {
      return deny("An agent may not skip the push gate. Run `npm run gate` on the commit; only the owner may bypass it.");
    }
    if (flags.has("--force") || flags.has("-f") || flags.has("--force-with-lease") || paths.some((p) => p.startsWith("+"))) {
      return deny("No forced push from an agent: a push to main is a production deploy, and other sessions push it too.");
    }
    return ask("A push to main deploys to production. The owner confirms every push.");
  }
  if (sub === "reset" && flags.has("--hard")) {
    return ask("`git reset --hard` discards every uncommitted change in this checkout, other sessions' work included.");
  }
  if (sub === "clean") {
    return ask("`git clean` deletes untracked files in this checkout, other sessions' new files included.");
  }
  if ((sub === "checkout" || sub === "restore") && paths.some((p) => p === "." || p === ":/")) {
    return ask(`\`git ${sub} .\` discards every uncommitted change in this checkout, other sessions' work included.`);
  }
  if (sub === "stash") {
    const action = paths[0];
    const readOnly = action === "list" || action === "show";
    if (!readOnly) return ask("The stash is shared by every session in this checkout, and stashing takes their uncommitted work with yours.");
  }
  return null;
}

function judgePrisma(args) {
  if (args.some((a) => a === "--shadow-database-url" || a.startsWith("--shadow-database-url="))) {
    return deny(
      "Never pass `--shadow-database-url`: Prisma RESETS the shadow database, and locally it is the same database as the data (it emptied the local copy on 2026-08-25). Use `prisma validate` and apply the SQL with psql.",
    );
  }
  const [area, action] = args.filter((a) => !a.startsWith("-"));
  if (area === "migrate" && (action === "dev" || action === "reset")) {
    return deny(
      `\`prisma migrate ${action}\` is forbidden everywhere: it resets the database it is pointed at (INC-002 wiped production with it). Write the migration SQL by hand, then \`npm run db:migrate\`.`,
    );
  }
  if (area === "db" && action === "push") {
    if (args.includes("--accept-data-loss") || args.includes("--force-reset")) {
      return deny("`prisma db push` with a data-loss flag drops what it cannot convert. Use `npm run db:migrate`.");
    }
    return ask("A direct `prisma db push` skips the snapshot `npm run db:push` takes first. Use the npm script.");
  }
  return null;
}

const AWS_READ = /^(describe|get|list|filter|lookup|search|tail|ls|head|wait|help|start-query|stop-query|test-metric-filter|get-caller-identity)/;

function judgeAws(args) {
  const plain = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      // A global option and its value (`--region ap-south-1`) are not the operation.
      if (i + 1 < args.length && !args[i + 1].startsWith("-") && plain.length < 2) i += 1;
    } else {
      plain.push(args[i]);
    }
  }
  const [service, operation] = plain;
  if (!service || service === "help" || service === "configure" || service === "--version") return null;
  if (operation && AWS_READ.test(operation)) return null;
  return ask(
    `\`aws ${service} ${operation ?? ""}\` is not a read. AWS changes are handed to the owner to run; reads (describe, get, list, logs queries) are fine.`,
  );
}

function judgeCommand(words, depth) {
  const { assignments, words: program } = unwrap(words);

  const override = assignments.find((a) => /^GATE_[A-Z_]*=/.test(a));
  if (override) {
    return deny(`An agent may not set ${override.split("=")[0]}: it switches the push gate off. Only the owner may.`);
  }
  if (program.length === 0) return null;
  const [name, ...args] = program;

  if (name === "docker" || name === "docker-compose" || name === "podman") {
    return deny(
      "Agents do not run docker here, reads included. Hand the command to the owner. (`npm run db:snapshot` and `npm run db:refresh` are the two allowed wrappers.)",
    );
  }
  if (name === "prisma") return judgePrisma(args);
  if (name === "git") return judgeGit(args);
  if (name === "aws") return judgeAws(args);

  if (depth >= 4) return null;
  if (name === "eval") return refusalFor(args.join(" "), depth + 1);
  if (SHELLS.has(name)) {
    // `bash -c "..."` and `bash -lc "..."`: the string after it is the script.
    const at = args.findIndex((a) => /^-[a-z]*c$/.test(a));
    return at >= 0 && typeof args[at + 1] === "string" ? refusalFor(args[at + 1], depth + 1) : null;
  }
  if (name === "ssh") {
    // `ssh host docker ps`: what follows the host runs on the far side.
    const remote = afterFlags(args).slice(1).join(" ");
    return remote ? refusalFor(remote, depth + 1) : null;
  }
  return null;
}

/** The stricter of two answers: a refusal beats a prompt. */
function stricter(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.decision === "deny" ? a : b;
}

/**
 * THE rule. Null when the command may run; otherwise `deny` (refused) or `ask`
 * (the owner is prompted), each with the reason the agent is shown.
 */
export function refusalFor(command, depth = 0) {
  if (typeof command !== "string" || command.trim() === "") return null;
  const { stripped, shellBodies } = withoutHeredocs(command);
  const { commands, nested } = simpleCommands(stripped);

  let verdict = null;
  for (const words of commands) {
    verdict = stricter(verdict, judgeCommand(words, depth));
    if (verdict?.decision === "deny") return verdict;
  }
  if (depth < 4) {
    for (const inner of [...nested, ...shellBodies]) {
      verdict = stricter(verdict, refusalFor(inner, depth + 1));
      if (verdict?.decision === "deny") return verdict;
    }
  }
  return verdict;
}

/** The hook's answer on stdout, in Claude Code's PreToolUse shape. */
export function hookAnswer(input) {
  if (input?.tool_name !== "Bash") return null;
  const verdict = refusalFor(input?.tool_input?.command);
  if (!verdict) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: verdict.decision,
      permissionDecisionReason: `[agent-command-guard] ${verdict.reason}`,
    },
  };
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let answer;
  try {
    answer = hookAnswer(JSON.parse(raw));
  } catch (error) {
    // A guard that cannot read its input must not fail silently open: the owner decides.
    answer = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `[agent-command-guard] could not read the command (${error instanceof Error ? error.message : "unknown"}). The owner decides.`,
      },
    };
  }
  if (answer) process.stdout.write(JSON.stringify(answer));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
