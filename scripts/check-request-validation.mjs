#!/usr/bin/env node
/**
 * Every API route handler that reads a JSON body must validate it.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * A route that reads `await req.json()` and destructures it is holding
 * attacker-shaped data typed as `any`. The failure is not dramatic — nothing
 * leaks, nothing is written wrong — but it is silent and it wastes the one
 * thing an on-call engineer has: `{ registrationIds: [1, {}] }` goes into
 * Prisma as-is and surfaces as a 500 reading "Failed to print badges", with a
 * log line that names neither the field nor the value.
 *
 * The specific reason this gate is needed, rather than another sweep:
 *
 *   In April 2026 a sweep fixed 44 silent-400 sites across the API. It found
 *   them by grepping for the string "Invalid input" — which is the symptom of
 *   validation ALREADY EXISTING. A route with no validation at all had nothing
 *   to match, so the sweep was structurally blind to exactly the routes that
 *   needed it most. Five of them survived untouched until a review read them
 *   by hand five months later (Sep 21, 2026, findings #5–#7).
 *
 * That is the same shape as this repo's other expensive lessons: the thing
 * that looked like coverage was measuring the wrong property. A grep for a
 * symptom cannot see an absence. This gate measures the absence directly.
 *
 * WHAT COUNTS AS VALIDATION
 * -------------------------
 * A `safeParse` / `safeParseAsync` call, or a bare `Schema.parse(...)`, inside
 * the same handler. Deliberately NOT a check that the schema is tight: a
 * permissive schema is a DECISION someone made and can be reviewed, while no
 * schema at all is an oversight nobody sees. Forcing the author to write the
 * line is the whole win; arguing about its contents is review's job, not CI's.
 *
 * SCOPE: JSON BODIES ONLY
 * -----------------------
 * `formData()` and `text()` readers are out of scope, on purpose. The 23
 * formData handlers are file uploads that validate by MIME + magic bytes +
 * size cap — a genuinely different and stronger strategy than a shape parse —
 * and the two `text()` readers are the Stripe webhooks, which must see the RAW
 * body to verify the signature over it. Widening this gate to them would mean
 * inventing a second definition of "validated" and would flag 25 handlers that
 * are already correct. A gate that cries wolf gets muted.
 *
 * KNOWN LIMIT
 * -----------
 * Body reads are attributed per HANDLER, so a read inside a module-level
 * helper called by a handler would be invisible here. No route does that today
 * (verified at the time of writing), and the miss direction is safe — it can
 * only under-report, never raise a false alarm — but if that pattern appears,
 * this script needs to learn about it.
 *
 * MAINTAINING IT
 * --------------
 * When this fails, the honest responses are:
 *   (a) parse the body   -> add a Zod schema + safeParse + zodErrorResponse;
 *   (b) it validates by a different strategy you can DEFEND -> add it to
 *       HAND_VALIDATED with a reason that says what the strategy is.
 *
 * The reason string is the point. "legacy" or "fine for now" is a bug in
 * review. And the list only shrinks: an entry whose handler has since gained a
 * parse FAILS the gate, so it cannot quietly rot into a list of things nobody
 * has looked at since 2026.
 *
 * Usage: node scripts/check-request-validation.mjs [--verbose]
 * Exit:  0 clean, 1 violation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkRoutes, stripComments, splitHandlers } from "./lib/route-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "src/app/api");
const VERBOSE = process.argv.includes("--verbose");

/** A handler reading the JSON body. */
const BODY_READ = /\b(?:req|request)\s*\.\s*json\s*\(/g;

/** Zod's checked entry points. */
const SAFE_PARSE = /\bsafeParse(?:Async)?\s*\(/g;

/**
 * A throwing `Schema.parse(...)`. `JSON` and `Date` are excluded because
 * `JSON.parse` and `Date.parse` are not validation and matching them would
 * make the gate pass on exactly the routes it exists to catch.
 */
const BARE_PARSE = /\b([A-Za-z0-9_$]+)\s*\.\s*parse\s*\(/g;
const NOT_A_SCHEMA = new Set(["JSON", "Date"]);

/**
 * Handlers that validate their body by a strategy other than a schema parse.
 * Keyed `path::METHOD` rather than by path prefix, so a NEW handler added to
 * one of these same files is still caught.
 */
const HAND_VALIDATED = [
  [
    "src/app/api/mcp/oauth/token/route.ts::POST",
    "RFC 6749 requires form-encoded support, so every shape is funnelled through `new URLSearchParams(...)`, which coerces each value to a string by construction; the fields are then null-checked individually",
  ],
  [
    "src/app/api/mcp/oauth/revoke/route.ts::POST",
    "RFC 7009 token revocation, same URLSearchParams coercion as the token endpoint above",
  ],
  [
    "src/app/api/events/[eventId]/agent/execute/route.ts::POST",
    "bespoke per-message validation of the chat history: `Array.isArray` plus a `typeof` check on each message's role and content, which a flat schema would not express as clearly",
  ],
  [
    "src/app/api/admin/backups/route.ts::POST",
    "single field, guarded by `typeof body?.key === 'string'` with a non-string falling back to '' — and the key is then matched against an exact allow-list of two shapes before any AWS call",
  ],
  [
    "src/app/api/auth/register-device/route.ts::DELETE",
    "single field, refused unless `typeof pushToken === 'string'`",
  ],
  [
    "src/app/api/events/[eventId]/dtcm-pool/route.ts::POST",
    "single field, `typeof body?.registrationId === 'string'` over a `.catch(() => null)` body",
  ],
  [
    "src/app/api/events/[eventId]/speakers/[speakerId]/profile-form/route.ts::PATCH",
    "single boolean flag: anything but `reopen === true` is a logged 400, over a `.catch(() => ({}))` body",
  ],
  [
    "src/app/api/events/[eventId]/registrations/[registrationId]/check-in/route.ts::POST",
    "single optional flag read as `=== true` over a `.catch(() => ({}))` body, so a malformed value is already ignored rather than trusted. Deliberately NOT upgraded to a 400: this is the desk check-in path on event morning and refusing a request over a cosmetic flag would be a downgrade",
  ],
];

function fail(msg) {
  console.error(msg);
}

function countMatches(body, re) {
  return [...body.matchAll(re)].length;
}

function hasSchemaParse(body) {
  if (countMatches(body, SAFE_PARSE) > 0) return true;
  for (const m of body.matchAll(BARE_PARSE)) {
    if (!NOT_A_SCHEMA.has(m[1])) return true;
  }
  return false;
}

function main() {
  const allowed = new Map(HAND_VALIDATED);
  const files = walkRoutes(API_DIR);

  // Self-check, the lesson from check-route-auth's first run: a script whose
  // analysis silently collapses to zero reports a clean build. If we cannot
  // see any route files or any body readers at all, something is broken here,
  // not in the codebase.
  if (files.length === 0) {
    fail("check-request-validation: found no route.ts files under src/app/api — the scan is broken, not the code.");
    process.exit(1);
  }

  const violations = [];
  const seenKeys = new Set();
  let readers = 0;

  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    const code = stripComments(readFileSync(abs, "utf8"));

    for (const handler of splitHandlers(code)) {
      if (countMatches(handler.body, BODY_READ) === 0) continue;
      readers++;

      const key = `${rel}::${handler.method}`;
      const validated = hasSchemaParse(handler.body);

      if (allowed.has(key)) {
        seenKeys.add(key);
        // The list only shrinks. A hand-validated handler that has since
        // gained a parse must lose its entry, or the list becomes a place
        // things go to be forgotten.
        if (validated) {
          violations.push(
            `  ${key}\n      now validates with a schema — remove its HAND_VALIDATED entry.`
          );
        }
        continue;
      }

      if (!validated) {
        violations.push(
          `  ${key}\n      reads req.json() but never parses it.\n` +
            `      Add a Zod schema + safeParse + zodErrorResponse (src/lib/api-errors.ts),\n` +
            `      or add it to HAND_VALIDATED with a reason if it validates another way.`
        );
      }
    }
  }

  if (readers === 0) {
    fail("check-request-validation: no handler reads a JSON body anywhere — the detection regex is broken.");
    process.exit(1);
  }

  // A moved or deleted handler must not silently leave a stale exemption
  // behind, the same rule check-route-auth applies to its EXEMPT prefixes.
  const stale = [...allowed.keys()].filter((k) => !seenKeys.has(k));
  for (const k of stale) {
    violations.push(`  ${k}\n      HAND_VALIDATED entry matches no body-reading handler — it moved or went away; remove it.`);
  }

  if (violations.length > 0) {
    fail(`\n✗ Request validation: ${violations.length} problem(s)\n`);
    for (const v of violations) fail(v + "\n");
    fail("Why this gate exists: see the header of scripts/check-request-validation.mjs\n");
    process.exit(1);
  }

  console.log(
    `✓ Request validation: ${readers} handler(s) reading a JSON body across ${files.length} route file(s) validate it ` +
      `(${allowed.size} hand-validated by another strategy)`
  );
  if (VERBOSE) {
    for (const [k, reason] of allowed) console.log(`    hand-validated  ${k}\n        ${reason}`);
  }
}

main();
