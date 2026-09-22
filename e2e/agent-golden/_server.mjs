#!/usr/bin/env node
/**
 * Starts the app for the golden task set as the PRODUCTION STANDALONE build
 * on its own port, not `next dev`: Next 16 refuses a second dev server in
 * the same checkout while the everyday one holds the lock on :3113, and a
 * standalone server coexists with it (the Sep 21, 2026 :3199 procedure).
 *
 * What it does, in order:
 *   1. rebuilds (`npm run build`) when .next/standalone/server.js is
 *      missing or older than the newest file under src/ or prisma/, or
 *      when AGENT_GOLDEN_BUILD=1; a stale build would grade old code
 *   2. copies .next/static and public/ into the standalone tree, which
 *      `next build` deliberately leaves out
 *   3. loads the project .env files through @next/env (never shell-sourced),
 *      then overrides the port, the auth URLs and the database (the test DB
 *      the seed just wrote) before importing server.js
 *
 * Playwright runs this as the webServer command and waits for the URL.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// @next/env is CommonJS; a named import of it fails under ESM.
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const standalone = path.join(root, ".next", "standalone");
const serverJs = path.join(standalone, "server.js");
const PORT = process.env.PORT || process.env.AGENT_GOLDEN_PORT || "3120";
const baseURL = process.env.NEXTAUTH_URL || `http://localhost:${PORT}`;

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  }
  return newest;
}

function needsBuild() {
  if (process.env.AGENT_GOLDEN_BUILD === "1") return "AGENT_GOLDEN_BUILD=1";
  if (!fs.existsSync(serverJs)) return "no standalone build";
  const built = fs.statSync(serverJs).mtimeMs;
  for (const rel of ["src", "prisma", "next.config.ts", "package.json"]) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const m = fs.statSync(p).isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs;
    if (m > built) return `${rel} is newer than the standalone build`;
  }
  return null;
}

const reason = needsBuild();
if (reason) {
  console.log(`[agent-golden:server] building the standalone (${reason})`);
  execSync("npm run build", { cwd: root, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
}

for (const [from, to] of [
  [path.join(root, ".next", "static"), path.join(standalone, ".next", "static")],
  [path.join(root, "public"), path.join(standalone, "public")],
]) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

// The project .env files, the way Next itself loads them.
loadEnvConfig(root);

const testDb = process.env.DATABASE_URL_TEST;
if (!testDb) {
  console.error("[agent-golden:server] DATABASE_URL_TEST is not set");
  process.exit(1);
}
process.env.PORT = PORT;
process.env.HOSTNAME = "127.0.0.1";
process.env.NEXTAUTH_URL = baseURL;
process.env.NEXT_PUBLIC_APP_URL = baseURL;
process.env.DATABASE_URL = testDb;
process.env.DIRECT_URL = testDb;

console.log(`[agent-golden:server] standalone on ${baseURL} against ${testDb.replace(/\/\/[^@]*@/, "//***@")}`);
await import(pathToFileURL(serverJs).href);
