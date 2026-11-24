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
 *
 * HOW A COMMAND IS FOUND (review of 398ddca9). The first version peeled a short
 * list of wrappers (`sudo`, `npx`) and judged what was left, so anything it did
 * not know hid the program: `timeout 120 npx prisma migrate dev`, `yarn prisma
 * migrate dev`, `sudo -u ubuntu docker ps` all passed. Now (1) wrappers know
 * which of their flags take a value, and (2) behind any program this file does
 * not recognise as a plain text tool, the words are searched for `docker` and
 * `prisma` and judged from there. A quoted message is one word, so text that
 * names a command is still not a command.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** Words that only run another command, with the flags of theirs that take a value. */
const WRAPPERS = {
  sudo: { valueFlags: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"] },
  env: { valueFlags: ["-u", "-C", "-S", "-P"] },
  time: {},
  nohup: {},
  exec: { valueFlags: ["-a"] },
  command: {},
  nice: { valueFlags: ["-n"] },
  ionice: { valueFlags: ["-c", "-n", "-p"] },
  caffeinate: { valueFlags: ["-t", "-w"] },
  stdbuf: { valueFlags: ["-i", "-o", "-e"] },
  xargs: { valueFlags: ["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a", "-J", "-R"] },
  timeout: { valueFlags: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
  gtimeout: { valueFlags: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
  watch: { valueFlags: ["-n", "--interval"] },
  // Package runners: `npx prisma ...`, `yarn prisma ...`, `npx dotenv -e .env -- prisma ...`.
  npx: { valueFlags: ["-p", "--package"] },
  bunx: {},
  pnpx: {},
  yarn: {},
  pnpm: {},
  bun: {},
  dotenv: { valueFlags: ["-e", "-v", "-c"] },
  "dotenv-cli": { valueFlags: ["-e", "-v", "-c"] },
  "cross-env": {},
};
/** `npm exec -- prisma ...`, `pnpm dlx prisma ...`, `yarn run prisma ...`. */
const RUNNER_PAIRS = new Set(["npm exec", "npm x", "pnpm exec", "pnpm dlx", "pnpm run", "yarn dlx", "yarn exec", "yarn run", "bun x", "bun run"]);
/** Shell keywords a command can follow: `for f in x; do docker ps; done`. */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);

/**
 * Programs whose arguments are text and paths, never a command to run: behind
 * these, the word `docker` is a search pattern or a folder, not a program.
 */
const TEXT_TOOLS = new Set([
  "cd", "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "echo", "printf", "find", "fd",
  "wc", "sort", "uniq", "cut", "tr", "diff", "cmp", "file", "stat", "du", "df", "test", "[", "[[", "mkdir", "touch", "rm",
  "cp", "mv", "ln", "chmod", "chown", "which", "type", "man", "basename", "dirname", "realpath", "readlink", "tee",
  "less", "more", "jq", "yq", "open", "code", "tar", "zip", "unzip", "gzip", "gunzip", "tree", "bat", "nl", "xxd",
  "column", "paste", "comm", "shasum", "md5", "sha256sum", "date", "true", "false", "sleep", "kill", "pkill", "pgrep",
  "lsof", "ps", "curl", "wget", "gh", "psql", "export", "unset", "local", "read", "source", ".", "return", "exit", "set",
]);
/** The programs worth looking for behind a wrapper this file does not know. */
const CATASTROPHIC = new Set(["docker", "docker-compose", "podman", "prisma"]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `./node_modules/.bin/prisma` and `prisma@6` are both the program `prisma`. */
const programName = (word) => word.replace(/^.*\//, "").replace(/(?<=.)@.*$/, "");

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
    if (SHELLS.has(programName(lastCommand))) shellBodies.push(body);
    return `${restOfLine}\n`;
  });
  return { stripped, shellBodies };
}

/**
 * Index just past the `)` that closes a `$(` whose text starts at `from`.
 * Quotes are honoured inside it: an apostrophe within double quotes is only an
 * apostrophe, and a parenthesis within quotes closes nothing (`"can't"`, `":)"`).
 */
function endOfSubstitution(text, from) {
  let depth = 1;
  let inDouble = false;
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
    } else if (!inDouble && c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end < 0 ? text.length : end + 1;
    } else if (c === '"') {
      inDouble = !inDouble;
      i += 1;
    } else if (c === "$" && text[i + 1] === "(") {
      i = endOfSubstitution(text, i + 2);
    } else if (!inDouble && c === "(") {
      depth += 1;
      i += 1;
    } else if (!inDouble && c === ")") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return text.length;
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
  /** A `$(...)` starting at `at`: its text is kept for judging, `$()` stands in for it. */
  const substitution = (at) => {
    const close = endOfSubstitution(text, at + 2);
    nested.push(text.slice(at + 2, text[close - 1] === ")" ? close - 1 : close));
    return close;
  };
  const backticks = (at) => {
    const end = text.indexOf("`", at + 1);
    const close = end < 0 ? text.length : end;
    nested.push(text.slice(at + 1, close));
    return close + 1;
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
          j = substitution(j);
          word += "$()";
        } else if (text[j] === "`") {
          j = backticks(j);
          word += "$()";
        } else {
          word += text[j];
          j += 1;
        }
      }
      i = j + 1;
    } else if (c === "$" && text[i + 1] === "(") {
      i = substitution(i);
      word += "$()";
      inWord = true;
    } else if (c === "`") {
      i = backticks(i);
      word += "$()";
      inWord = true;
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

/** Past a wrapper's own flags (and the values of those that take one) and its fixed arguments. */
function afterWrapperFlags(words, spec = {}) {
  const takesValue = new Set(spec.valueFlags ?? []);
  let i = 0;
  while (i < words.length && words[i].startsWith("-") && words[i] !== "--") {
    i += takesValue.has(words[i]) ? 2 : 1;
  }
  if (words[i] === "--") i += 1;
  return words.slice(i + (spec.positionals ?? 0));
}

/**
 * Peel a simple command down to the program that really runs: env assignments,
 * shell keywords, `sudo` and friends, package runners. Returns the assignments
 * seen on the way.
 */
function unwrap(words) {
  const assignments = [];
  let rest = words;
  for (let guard = 0; guard < 16 && rest.length > 0; guard += 1) {
    const first = rest[0];
    const name = programName(first);
    const pair = `${name} ${rest[1] ?? ""}`;
    if (ENV_ASSIGNMENT.test(first)) {
      assignments.push(first);
      rest = rest.slice(1);
    } else if (name === "export" && rest[1] && ENV_ASSIGNMENT.test(rest[1])) {
      assignments.push(...rest.slice(1).filter((w) => ENV_ASSIGNMENT.test(w)));
      return { assignments, words: [] };
    } else if (KEYWORDS.has(first)) {
      rest = rest.slice(1);
    } else if (name === "command" && (rest[1] === "-v" || rest[1] === "-V")) {
      return { assignments, words: [] }; // a lookup: nothing runs
    } else if (RUNNER_PAIRS.has(pair)) {
      rest = afterWrapperFlags(rest.slice(2));
    } else if (Object.hasOwn(WRAPPERS, name)) {
      rest = afterWrapperFlags(rest.slice(1), WRAPPERS[name]);
    } else {
      break;
    }
  }
  if (rest.length > 0) rest = [programName(rest[0]), ...rest.slice(1)];
  return { assignments, words: rest };
}

const deny = (reason) => ({ decision: "deny", reason });
const ask = (reason) => ({ decision: "ask", reason });

/**
 * A subcommand's arguments, read the way git reads them: flags (short ones
 * split, `-am` is `-a` and `-m`), the values of the flags that take one left
 * out (so a commit message is never mistaken for a flag or a path), and what is
 * left as positional words. `--` ends the flags.
 */
function parseArgs(args, valueShort = "", valueLong = [], attachedShort = "") {
  const flags = new Set();
  const positionals = [];
  let sawDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (sawDoubleDash) {
      positionals.push(arg);
    } else if (arg === "--") {
      sawDoubleDash = true;
    } else if (arg.startsWith("--")) {
      const name = arg.split("=")[0];
      flags.add(name);
      if (!arg.includes("=") && valueLong.includes(name)) i += 1;
    } else if (/^-[A-Za-z]/.test(arg)) {
      for (let k = 1; k < arg.length; k += 1) {
        const letter = arg[k];
        flags.add(`-${letter}`);
        if (attachedShort.includes(letter)) break; // `-uno`: the rest is its value
        if (valueShort.includes(letter)) {
          if (k === arg.length - 1) i += 1; // `-m "msg"`: the next word is its value
          break; // `-mmsg`: the rest of this word is
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals, sawDoubleDash };
}

const WHOLE_TREE = new Set([".", "./", "./.", "..", "../", ":/", "*", "./*", "$PWD", "${PWD}", "$()", "$PWD/", "${PWD}/"]);
const isWholeTree = (p) => WHOLE_TREE.has(p);

/** A folder or a pattern: it names whatever is under it, not a file someone chose. */
function isDirectoryOrPattern(p, cwd) {
  if (p.endsWith("/") || /[*?]/.test(p)) return true;
  if (!cwd) return false;
  try {
    return fs.statSync(path.resolve(cwd, p)).isDirectory();
  } catch {
    return false;
  }
}

/** Git's own options before the subcommand: `git -C dir --no-pager push`. */
function gitInvocation(args) {
  const globals = [];
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const takesValue = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"].includes(args[i]);
    globals.push(args[i], ...(takesValue ? [args[i + 1] ?? ""] : []));
    i += takesValue ? 2 : 1;
  }
  const sub = args[i] === "stage" ? "add" : args[i];
  return { globals, sub, rest: args.slice(i + 1) };
}

const OTHERS_FILES = "Other sessions work in this checkout.";

function judgeGit(args, cwd) {
  const { globals, sub, rest } = gitInvocation(args);
  if (globals.some((g) => /^core\.hookspath=/i.test(g))) {
    return deny("An agent may not point git away from the hooks in .githooks. Only the owner may bypass them.");
  }

  if (sub === "add") {
    const { flags, positionals } = parseArgs(rest, "", ["--chmod", "--pathspec-from-file"]);
    if (flags.has("-n") || flags.has("--dry-run")) return null;
    if (flags.has("-A") || flags.has("--all") || flags.has("-u") || flags.has("--update") || positionals.some(isWholeTree)) {
      return deny(`Stage explicit paths only. ${OTHERS_FILES} \`git add -A\`, \`-u\` or \`.\` stages their files into your commit.`);
    }
    if (positionals.some((p) => isDirectoryOrPattern(p, cwd))) {
      return ask(`A folder or a pattern stages whatever is under it. ${OTHERS_FILES} Name the files you changed.`);
    }
    return null;
  }
  if (sub === "commit") {
    const { flags, positionals } = parseArgs(
      rest,
      "mFCct",
      ["--message", "--file", "--reuse-message", "--reedit-message", "--template", "--author", "--date", "--fixup", "--squash", "--cleanup", "--pathspec-from-file", "--trailer"],
      "uS",
    );
    if (flags.has("--no-verify") || flags.has("-n")) {
      return deny("An agent may not skip the commit hook. Fix what it reports; only the owner may bypass it.");
    }
    if (flags.has("-a") || flags.has("--all") || positionals.some(isWholeTree)) {
      return deny(`\`git commit -a\` (or a commit of \`.\`) takes every modified file. ${OTHERS_FILES} Stage explicit paths, then commit.`);
    }
    if (positionals.some((p) => isDirectoryOrPattern(p, cwd))) {
      return ask(`Committing a folder or a pattern takes every modified file under it. ${OTHERS_FILES} Name the files.`);
    }
    return null;
  }
  if (sub === "push") {
    const { flags, positionals } = parseArgs(rest, "o", ["--repo", "--push-option", "--receive-pack", "--exec", "--recurse-submodules"]);
    if (flags.has("--no-verify")) {
      return deny("An agent may not skip the push hook: it refuses a push into a running deploy and records a tip nobody gated. Only the owner may bypass it.");
    }
    const forced = ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror"].some((f) => flags.has(f));
    if (forced || positionals.some((p) => p.startsWith("+"))) {
      return deny("No forced push from an agent: a push to main is a production deploy, and other sessions push it too.");
    }
    return ask("A push to main deploys to production. The owner confirms every push.");
  }
  if (sub === "reset") {
    const { flags } = parseArgs(rest);
    if (flags.has("--hard") || flags.has("--merge") || flags.has("--keep")) {
      return ask(`\`git reset\` with --hard, --merge or --keep rewrites files in this checkout. ${OTHERS_FILES}`);
    }
    return null;
  }
  if (sub === "clean") {
    const { flags } = parseArgs(rest, "e");
    if (flags.has("-n") || flags.has("--dry-run")) return null;
    return ask("`git clean` deletes untracked files in this checkout, other sessions' new files included.");
  }
  if (sub === "checkout" || sub === "switch") {
    const { flags, positionals } = parseArgs(rest, "bBt", ["--orphan", "--track", "--conflict", "--pathspec-from-file"]);
    if (flags.has("-f") || flags.has("--force") || flags.has("--discard-changes")) {
      return ask(`\`git ${sub}\` with --force discards uncommitted changes in this checkout. ${OTHERS_FILES}`);
    }
    if (sub === "checkout" && positionals.some((p) => isWholeTree(p) || isDirectoryOrPattern(p, cwd))) {
      return ask(`\`git checkout\` of a folder, a pattern or \`.\` discards every uncommitted change under it. ${OTHERS_FILES} Name the file.`);
    }
    return null;
  }
  if (sub === "restore") {
    const { flags, positionals } = parseArgs(rest, "s", ["--source", "--pathspec-from-file"]);
    const indexOnly = (flags.has("--staged") || flags.has("-S")) && !flags.has("--worktree") && !flags.has("-W");
    if (positionals.some(isWholeTree) || (!indexOnly && positionals.some((p) => isDirectoryOrPattern(p, cwd)))) {
      return ask(`\`git restore\` of a folder, a pattern or \`.\` discards or unstages everything under it. ${OTHERS_FILES} Name the file.`);
    }
    return null;
  }
  if (sub === "stash") {
    const action = parseArgs(rest, "m", ["--message"]).positionals[0];
    if (action === "list" || action === "show") return null;
    return ask("The stash is shared by every session in this checkout, and stashing takes their uncommitted work with yours.");
  }
  if (sub === "config") {
    const { flags, positionals } = parseArgs(rest, "f", ["--file", "--blob", "--type", "--default"]);
    const names = positionals[0]?.toLowerCase() === "core.hookspath";
    const reads = positionals.length === 1 && !["--unset", "--unset-all", "--replace-all", "--add"].some((f) => flags.has(f));
    if (names && !reads) return deny("An agent may not repoint or remove the git hooks. Only the owner may.");
  }
  return null;
}

function judgePrisma(args) {
  if (args.some((a) => a === "--shadow-database-url" || a.startsWith("--shadow-database-url="))) {
    return deny(
      "Never pass `--shadow-database-url`: Prisma RESETS the shadow database, and locally it is the same database as the data (it emptied the local copy on 2026-08-25). Use `prisma validate` and apply the SQL with psql.",
    );
  }
  // Bare words in order, wherever the flags sit: `prisma --schema x migrate dev`, `prisma migrate --schema x dev`.
  const bare = args.filter((a) => !a.startsWith("-"));
  const afterMigrate = bare.indexOf("migrate") < 0 ? [] : bare.slice(bare.indexOf("migrate") + 1);
  const action = afterMigrate.find((w) => w === "dev" || w === "reset");
  if (action) {
    return deny(
      `\`prisma migrate ${action}\` is forbidden everywhere, \`--create-only\` included: it can reset the database it is pointed at (INC-002 wiped production with it). Write the migration SQL by hand, then \`npm run db:migrate\`.`,
    );
  }
  if (bare.indexOf("db") >= 0 && bare.slice(bare.indexOf("db") + 1).includes("push")) {
    if (args.includes("--accept-data-loss") || args.includes("--force-reset")) {
      return deny("`prisma db push` with a data-loss flag drops what it cannot convert. Use `npm run db:migrate`.");
    }
    return ask("A direct `prisma db push` skips the snapshot `npm run db:push` takes first. Use the npm script.");
  }
  return null;
}

const AWS_READ = /^(describe|get|list|filter|lookup|search|tail|ls|head|wait|help|start-query|stop-query|test-metric-filter)/;
/** The aws CLI's global options that take no value. Every other `--option` before the service takes one. */
const AWS_BOOLEAN_GLOBALS = new Set(["--debug", "--no-verify-ssl", "--no-paginate", "--no-sign-request", "--no-cli-pager", "--no-cli-auto-prompt", "--cli-auto-prompt", "--version"]);

function judgeAws(args) {
  const plain = [];
  for (let i = 0; i < args.length && plain.length < 2; i += 1) {
    if (!args[i].startsWith("-")) plain.push(args[i]);
    else if (!AWS_BOOLEAN_GLOBALS.has(args[i]) && !args[i].includes("=")) i += 1; // its value is not the service
  }
  const [service, operation] = plain;
  if (!service || service === "help" || service === "configure") return null;
  if (operation && AWS_READ.test(operation)) return null;
  return ask(
    `\`aws ${service} ${operation ?? ""}\` is not a read. AWS changes are handed to the owner to run; reads (describe, get, list, logs queries) are fine.`,
  );
}

/** ssh options that take a value: `ssh -i key -o X=y -p 22 host command`. */
const SSH_VALUE_FLAGS = new Set(["-i", "-o", "-p", "-l", "-F", "-J", "-L", "-R", "-D", "-E", "-c", "-m", "-b", "-e", "-w", "-W", "-S", "-O", "-Q", "-B", "-I"]);

/** What runs on the far side: everything after the host, `--` aside. */
function sshRemoteCommand(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += SSH_VALUE_FLAGS.has(args[i]) ? 2 : 1;
  const remote = args.slice(i + 1);
  return (remote[0] === "--" ? remote.slice(1) : remote).join(" ");
}

/** A record the gate writes: `<git dir>/gate/<sha>.ok`. An agent writing one by hand forges a pass. */
const GATE_RECORD = /(^|\/)gate\/[^/\s]*\.ok$/;
const READS_FILES = new Set(["ls", "cat", "head", "tail", "test", "[", "[[", "stat", "find", "grep", "wc", "file", "less"]);

function forgesGateRecord(name, words) {
  const targets = words.map((w) => w.replace(/^\d*>>?/, ""));
  const redirected = words.some((w, i) => (/^\d*>>?$/.test(w) && GATE_RECORD.test(words[i + 1] ?? "")) || (/^\d*>>?./.test(w) && GATE_RECORD.test(targets[i])));
  return redirected || (!READS_FILES.has(name) && targets.some((w) => GATE_RECORD.test(w)));
}

function judgeCommand(words, depth, cwd) {
  const { assignments, words: program } = unwrap(words);

  const override = assignments.find((a) => /^GATE_(OVERRIDE|NO_CI_CHECK)=/.test(a));
  if (override) {
    return deny(`An agent may not set ${override.split("=")[0]}: it switches the push hook's running-deploy check off. Only the owner may.`);
  }
  let verdict = null;
  if (assignments.some((a) => /^LOCAL_DATA_LOSS_OK=/.test(a))) {
    verdict = ask("LOCAL_DATA_LOSS_OK lets a database command drop data. The owner confirms it.");
  }
  if (program.length === 0) return verdict;
  const [name, ...args] = program;

  if (forgesGateRecord(name, program)) {
    return deny("An agent may not write the gate's records by hand. Run `npm run gate` on the commit.");
  }
  if (name === "docker" || name === "docker-compose" || name === "podman") {
    return deny(
      "Agents do not run docker here, reads included. Hand the command to the owner. (`npm run db:snapshot` and `npm run db:refresh` are the two allowed wrappers.)",
    );
  }
  if (name === "prisma") return stricter(verdict, judgePrisma(args));
  if (name === "git") return stricter(verdict, judgeGit(args, cwd));
  if (name === "aws") return stricter(verdict, judgeAws(args));
  if (depth >= 4) return verdict;

  if (name === "eval") return stricter(verdict, refusalFor(args.join(" "), { cwd }, depth + 1));
  if (SHELLS.has(name)) {
    // `bash -c "..."` and `bash -lc "..."`: the string after it is the script.
    const at = args.findIndex((a) => /^-[a-z]*c$/.test(a));
    return at >= 0 && typeof args[at + 1] === "string" ? stricter(verdict, refusalFor(args[at + 1], { cwd }, depth + 1)) : verdict;
  }
  if (name === "ssh") {
    const remote = sshRemoteCommand(args);
    return remote ? stricter(verdict, refusalFor(remote, { cwd }, depth + 1)) : verdict;
  }
  // Behind a program this file does not know (a wrapper it has never heard of),
  // the dangerous ones are still looked for and judged from where they stand.
  if (!TEXT_TOOLS.has(name)) {
    const at = args.findIndex((a) => CATASTROPHIC.has(programName(a)));
    if (at >= 0) return stricter(verdict, judgeCommand(args.slice(at), depth + 1, cwd));
  }
  return verdict;
}

/** The stricter of two answers: a refusal beats a prompt. */
function stricter(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.decision === "deny" ? a : b;
}

/**
 * THE rule. Null when the command may run; otherwise `deny` (refused) or `ask`
 * (the owner is prompted), each with the reason the agent is shown. `cwd` is
 * where the command runs, when known: it lets a path be recognised as a folder.
 */
export function refusalFor(command, { cwd } = {}, depth = 0) {
  if (typeof command !== "string" || command.trim() === "") return null;
  const { stripped, shellBodies } = withoutHeredocs(command);
  const { commands, nested } = simpleCommands(stripped);

  let verdict = null;
  for (const words of commands) {
    verdict = stricter(verdict, judgeCommand(words, depth, cwd));
    if (verdict?.decision === "deny") return verdict;
  }
  if (depth < 4) {
    for (const inner of [...nested, ...shellBodies]) {
      verdict = stricter(verdict, refusalFor(inner, { cwd }, depth + 1));
      if (verdict?.decision === "deny") return verdict;
    }
  }
  return verdict;
}

/** The hook's answer on stdout, in Claude Code's PreToolUse shape. */
export function hookAnswer(input) {
  if (input?.tool_name !== "Bash") return null;
  const verdict = refusalFor(input?.tool_input?.command, { cwd: typeof input?.cwd === "string" ? input.cwd : undefined });
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
