#!/usr/bin/env node

/**
 * Fail before a developer sees thousands of misleading TypeScript errors caused
 * by an incomplete checkout. CI installs dependencies before invoking these
 * commands; this protects the local path, where npm otherwise falls back to
 * globally installed binaries with incompatible versions.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2] ?? "check";
const requiredBins = {
  "type-check": ["tsc"],
  lint: ["eslint"],
  build: ["prisma", "next"],
};

if (!(command in requiredBins)) {
  console.error(`[preflight] Unknown command "${command}". Expected one of: ${Object.keys(requiredBins).join(", ")}.`);
  process.exit(2);
}

const nodeModules = join(process.cwd(), "node_modules");
const missing = ["typescript", "eslint", "prisma", "next", "@prisma", "vitest"].filter(
  (dependency) => !existsSync(join(nodeModules, dependency)),
);
const missingBins = requiredBins[command].filter(
  (bin) => !existsSync(join(nodeModules, ".bin", bin)),
);

if (missing.length === 0 && missingBins.length === 0) process.exit(0);

console.error(`[preflight] Cannot run npm run ${command}: project dependencies are incomplete.`);
if (missing.length > 0) console.error(`[preflight] Missing packages: ${missing.join(", ")}.`);
if (missingBins.length > 0) console.error(`[preflight] Missing executables: ${missingBins.join(", ")}.`);
console.error("[preflight] Run npm ci with Node and npm versions from package.json, then retry.");
process.exit(1);
