#!/usr/bin/env node

/**
 * Fail fast on an incomplete checkout, before the tool does.
 *
 * Without this, a clone that has not run `npm ci` produces thousands of
 * TypeScript errors about missing modules, or silently falls back to a globally
 * installed binary of a different major version. Both send you looking at the
 * code, which is the wrong place.
 *
 * WHAT THIS DOES NOT CATCH, so it is not mistaken for a general environment
 * guard: a STALE artifact. A Prisma client generated before your last schema
 * change, or a dev server started before it, both look complete here and fail
 * at runtime with `undefined` model accessors. That class is diagnosed by
 * comparing mtimes against the process start time, not by checking a path
 * exists.
 *
 * Requirements are scoped PER COMMAND on purpose. `npm run build` runs inside
 * the production Docker image; making it assert on a test runner it never
 * invokes would couple the image build to devDependencies for no reason, and
 * break the day anyone adds `--omit=dev`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const REQUIREMENTS = {
  "type-check": { packages: ["typescript"], bins: ["tsc"] },
  lint: { packages: ["eslint"], bins: ["eslint"] },
  build: { packages: ["prisma", "@prisma", "next"], bins: ["prisma", "next"] },
};

const command = process.argv[2] ?? "check";
const required = REQUIREMENTS[command];

if (!required) {
  console.error(
    `[preflight] Unknown command "${command}". Expected one of: ${Object.keys(REQUIREMENTS).join(", ")}.`,
  );
  process.exit(2);
}

const nodeModules = join(process.cwd(), "node_modules");
const missingPackages = required.packages.filter((p) => !existsSync(join(nodeModules, p)));
const missingBins = required.bins.filter((b) => !existsSync(join(nodeModules, ".bin", b)));

if (missingPackages.length === 0 && missingBins.length === 0) process.exit(0);

console.error(`[preflight] Cannot run "npm run ${command}": dependencies are incomplete.`);
if (missingPackages.length > 0) console.error(`[preflight] Missing packages: ${missingPackages.join(", ")}.`);
if (missingBins.length > 0) console.error(`[preflight] Missing executables: ${missingBins.join(", ")}.`);
console.error("[preflight] Run `npm ci`, then retry.");
process.exit(1);
