#!/usr/bin/env node
/**
 * Every API route handler must ASK A PERMISSION, not only know who is calling.
 *
 * WHY THIS GATE EXISTS (Phase 6 review, Oct 7, 2026)
 * ---------------------------------------------------
 * check-route-auth.mjs proves each handler establishes identity, and
 * check-permission-guards.sh keeps role checks out of the swept files. Neither
 * notices a handler that signs the caller in and then asks nothing, so any
 * account in the organisation passes. Two did exactly that:
 * `/api/registration-types` (every event's registration types to any account)
 * and `GET /api/organization` (the settings JSON with encrypted credentials
 * and the staff list with emails, to any account, an internal registrant
 * included). Both were found by a person reading; this makes it CI's job.
 *
 * WHAT COUNTS AS ASKING
 * ---------------------
 * A call to one of the permission primitives below, directly or through a
 * helper defined in the same file (resolved to a fixpoint, the way
 * check-route-auth derives its guards). A handler that is meant to be open to
 * every signed-in account says so in EXEMPT, with the reason; an exemption is
 * a decision, and the reason is what stops the next person copying it for a
 * route that merely looks similar.
 *
 * Usage: node scripts/check-route-permission.mjs [--verbose]
 * Exit:  0 clean, 1 violation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkRoutes, stripComments, splitHandlers } from "./lib/route-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "src/app/api");
const VERBOSE = process.argv.includes("--verbose");

/** The calls that decide access by permission (or by a module's own guard). */
const PRIMITIVES = [
  // The route guard, and the filters that confine a query to the events a
  // key covers. A bare `can()` does NOT count (review of 0875035c): a handler
  // that only uses it to choose a redaction has asked nothing that decides
  // whether it runs.
  "requirePermission",
  "eventWhereFor",
  "hubEventWhere",
  "eventListWhere",
  "isEventOrgStaff",
  "buildEventAccessWhere",
  // The module guards, by name (exported from src/crm, src/hr, src/procurement
  // and src/lib), never "anything called deny*": a local helper named
  // denyEverythingElse must earn its place by calling one of these.
  "crmCan",
  "denyCrmAccess",
  "denyCrmDelete",
  "denyCrmExport",
  "denyCrmProseRead",
  "denyCrmPurge",
  "denyCrmWrite",
  "requireCrmRead",
  "requireCrmWrite",
  "requireCrmDelete",
  "requireCrmExport",
  "requireCrmPurge",
  "denyNonHr",
  "denyNonProcurement",
  "denyNonRoleAdmin",
  "denyNonOperator",
  "denyUnlessRequestOrAdmin",
  "denyWithoutFinance",
  "procurementGuard",
  "guardedRead",
  "canViewProcurement",
  "canAuthorBudgets",
  "canAdminProcurement",
  // The Event Blueprint gate: flag, session, organisation, then requirePermission.
  "blueprintGuard",
  // The online venue gate: session, organisation, then requirePermission (events.read / events.update).
  "venueGuard",
  // The agent's handler asks agent.use and every tool's key itself.
  "executeAgentRequest",
  // The platform operator door.
  "isPlatformOperator",
];

/** Open to every signed-in account (or to its own row) by design. Path prefix + reason. */
const EXEMPT = [
  ["src/app/api/public/", "public forms: unauthenticated by design, token or slug scoped"],
  ["src/app/api/auth/", "sign-in, invitation and password flows"],
  ["src/app/api/webhooks/", "Stripe webhooks: signature verified"],
  ["src/app/api/cron/", "cron shims: CRON_SECRET bearer"],
  ["src/app/api/health/", "liveness probe"],
  ["src/app/api/openapi.json", "public API description"],
  ["src/app/api/mcp/", "MCP and its OAuth endpoints: the token or key is the credential; tools are gated per call (mcp-key-gate, tool-gate)"],
  ["src/app/api/registrant/", "a person's OWN registrations, groups and invoices: owner-scoped by userId in every query"],
  ["src/app/api/notifications/", "a person's own notification bell"],
  ["src/app/api/my-reviews/", "a reviewer's own assigned abstracts, scoped by assignment"],
  ["src/app/api/help-chat/", "the help assistant: answers from the user guide, reads no organisation data"],
  ["src/app/api/upload/photo/", "a person's own profile or form photo, size and type checked"],
  ["src/app/api/organization/branding/", "the organisation's logo and colours, shown in every account's header"],
  ["src/app/api/organization/route.ts:GET", "the organisation profile the Settings screens show (name, logo, company and invoice details, general preferences); credentials and the staff list are never selected (Oct 7, 2026)"],
  ["src/app/api/profile/", "a staff member's own email signature: staff only (isTeamRole), their own row"],
  ["src/app/api/events/[eventId]/submitter-context/", "a SUBMITTER's own speaker row on the event, role-checked and scoped by userId"],
];

const PRIMITIVE_RE = new RegExp(String.raw`\b(?:${PRIMITIVES.join("|")})\s*\(`);

/**
 * `can()` counts only beside a refusal: a handler (or helper) that calls it
 * AND can answer 403 is deciding whether to run; one that calls it to pick a
 * redaction is not. Inline gates like `if (!managesUsers) return 403` are the
 * users routes' shape, which a pattern on the call alone cannot see.
 */
const CAN_RE = /\bcan(?:Everywhere)?\s*\(/;
const REFUSES_RE = /status:\s*403|\bforbidden\s*\(/;
const asksPermission = (body) => PRIMITIVE_RE.test(body) || (CAN_RE.test(body) && REFUSES_RE.test(body));

/** Top-level helpers in a file: name -> body (function declarations and arrow consts). */
function localFunctions(code) {
  const out = new Map();
  const START = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)|^(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*(?::[^=]+)?=>/gm;
  const NEXT = /^(?:export\s|async\s+function\s|function\s|const\s|let\s|var\s|interface\s|type\s|class\s|enum\s)/gm;
  for (const m of code.matchAll(START)) {
    const name = m[1] ?? m[2];
    const lineEnd = code.indexOf("\n", m.index);
    NEXT.lastIndex = lineEnd === -1 ? code.length : lineEnd + 1;
    const next = NEXT.exec(code);
    out.set(name, code.slice(m.index, next ? next.index : code.length));
  }
  return out;
}

/** The file's own helpers that ask a permission, to a fixpoint. */
function guardingHelpers(fns) {
  const guards = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of fns) {
      if (guards.has(name)) continue;
      const callsGuard = asksPermission(body) || [...guards].some((g) => new RegExp(String.raw`\b${g}\s*\(`).test(body));
      if (callsGuard) {
        guards.add(name);
        grew = true;
      }
    }
  }
  return guards;
}

function exemption(rel, method) {
  return EXEMPT.find(([prefix]) => (prefix.includes(":") ? `${rel}:${method}` === prefix : rel.startsWith(prefix)));
}

const violations = [];
let checked = 0;
for (const file of walkRoutes(API_DIR)) {
  const rel = path.relative(ROOT, file);
  const code = stripComments(readFileSync(file, "utf8"));
  const guards = guardingHelpers(localFunctions(code));
  for (const { method, body } of splitHandlers(code)) {
    if (method === "OPTIONS" || method === "HEAD") continue;
    checked++;
    const asks = asksPermission(body) || [...guards].some((g) => new RegExp(String.raw`\b${g}\s*\(`).test(body));
    if (asks) continue;
    const ex = exemption(rel, method);
    if (ex) {
      if (VERBOSE) console.log(`exempt  ${rel}:${method}  (${ex[1]})`);
      continue;
    }
    violations.push(`${rel}:${method}`);
  }
}

if (violations.length > 0) {
  console.error(`check-route-permission: ${violations.length} handler(s) ask no permission:\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nAdd requirePermission(...) for the operation's key. If the handler really is open to every signed-in account, add it to EXEMPT with the reason.",
  );
  process.exit(1);
}
console.log(`check-route-permission: ${checked} handlers, every one asks a permission or is exempt with a reason.`);
