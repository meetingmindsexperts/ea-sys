#!/usr/bin/env node
/**
 * Every API route handler must establish identity.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * The other ten gates police the SHAPE of a check that is present. None of
 * them asks whether a check is there at all, so a forgotten guard FAILS OPEN:
 * the route ships, returns 200, and nothing goes red.
 *
 * That is not hypothetical here. Both of the worst findings in this repo's
 * review history were correct code with a missing or unreachable guard, and
 * both were caught by a person reading rather than by CI:
 *
 *   - the contacts READ routes authorised on getOrgContext alone, so a
 *     per-event desk temp could export the org's entire CRM (Jul 13 2026);
 *   - sessions/speakers used `orgCtx ? … : buildEventAccessWhere(…)`, where
 *     the first branch swallowed signed-in users too, so the role rules in
 *     the second branch never ran at all (Aug 10 2026).
 *
 * Reading either file found nothing wrong, because nothing IS wrong locally —
 * the defect is an absence. An absence is exactly what a machine is good at.
 *
 * WHY NODE AND NOT BASH
 * ---------------------
 * Consistency would say bash, like the other ten. Portability says otherwise:
 * scripts/check-guard-route.sh carries a long comment about its first version
 * rolling its own comment-stripper with sed, passing on macOS and failing on
 * the first CI run, because GNU sed honours `\s` and BSD sed does not — and
 * the failure mode was a line-range delete that lost its own terminator, which
 * fails OPEN in one direction and CLOSED in the other depending on the
 * platform. This script does per-handler segmentation, which is fiddlier than
 * that was. Node is already required to build the project and behaves
 * identically on both.
 *
 * THE TWO DESIGN DECISIONS THAT DECIDE WHETHER IT WORKS
 * -----------------------------------------------------
 * 1. PER HANDLER, NOT PER FILE. A file-level "does this mention auth()?" check
 *    passes a route whose GET is guarded and whose newly-added DELETE is not —
 *    which is the likeliest real-world case. check-tenant-als.sh learned this
 *    the hard way: its first version was per-file and PASSED a deliberately
 *    injected violation, because reverting one of a route's two handlers went
 *    undetected.
 *
 * 2. THE GUARD LIST IS DERIVED, NOT TYPED. The first draft of this analysis
 *    hand-listed sixteen guard names and immediately flagged three perfectly
 *    good CRM routes, because nobody had told it about requireCrmPurge and
 *    requireCrmExport. A hand-typed list of things-that-count goes stale the
 *    day someone adds an eleventh guard, and a gate that cries wolf gets
 *    muted. So the names are read out of the guard MODULES below — a list that
 *    changes rarely — instead of the functions, which change often.
 *
 * MAINTAINING IT
 * --------------
 * When this fails, there are exactly two honest responses:
 *   (a) the route really is unguarded  -> add the guard;
 *   (b) it uses a guard we do not know -> add its MODULE to GUARD_MODULES.
 *
 * Adding a path to EXEMPT to make the build green is NOT one of them, unless
 * the route is genuinely unauthenticated by design, and then the reason string
 * is the point: it is what stops the next person exempting something that
 * merely looks similar. An exemption with a vague reason is a bug in review.
 *
 * Usage: node scripts/check-route-auth.mjs [--verbose]
 * Exit:  0 clean, 1 violation.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Shared with check-request-validation.mjs — see scripts/lib/route-scan.mjs
// for why these are not typed twice.
import { HTTP_METHODS, walkRoutes, stripComments, splitHandlers } from "./lib/route-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "src/app/api");
const VERBOSE = process.argv.includes("--verbose");

/**
 * The identity PRIMITIVES — the handful of functions that actually answer
 * "who is calling?" by reading a cookie, an API key or a bearer token.
 *
 * This list is short and stable on purpose. Everything else is DERIVED from
 * it, so adding a new wrapper needs no edit here.
 */
const SEED_PRIMITIVES = [
  "auth", // NextAuth session
  "getOrgContext", // session OR API key
  "validateApiKey",
  "validateOAuthAccessToken",
];

/**
 * Modules that may define guard WRAPPERS around those primitives. Their
 * exports are read at run time and promoted transitively: an exported function
 * whose body calls a known guard becomes a guard itself, repeated to a
 * fixpoint.
 *
 * WHY TRANSITIVE AND NOT A NAME PATTERN. The first version of this script
 * accepted any export matching /^(auth|require[A-Z]|validate[A-Z])/, which
 * looked like a derivation and was really a hand-list wearing a disguise: it
 * silently rejected `procurementGuard` — a perfectly good wrapper that calls
 * auth() on its first line — because of its lowercase 'p', and reported all 61
 * procurement handlers as unguarded. Naming conventions are not a security
 * boundary. What a function CALLS is.
 */
const GUARD_MODULES = [
  "src/lib/auth.ts",
  "src/lib/api-auth.ts",
  "src/lib/auth-guards.ts",
  "src/lib/require-org.ts",
  "src/lib/api-key.ts",
  "src/lib/mcp-oauth.ts",
  "src/lib/platform-operator.ts",
  "src/crm/lib/crm-route.ts",
  "src/hr/lib/hr-roles.ts",
  "src/procurement/lib/procurement-roles.ts",
  "src/procurement/lib/route-helpers.ts",
];

/**
 * Routes that are unauthenticated BY DESIGN. Each needs a REASON, and the
 * reason is load-bearing — see "Maintaining it" above.
 */
const EXEMPT = [
  ["src/app/api/public/", "public forms: unauthenticated by design; these carry rate limits + their own token/slug scoping"],
  ["src/app/api/webhooks/", "Stripe: authenticated by signature over the RAW body, never by session"],
  ["src/app/api/cron/", "legacy cron shims: Bearer CRON_SECRET (the worker tier is the live runner)"],
  ["src/app/api/auth/", "NextAuth itself plus the mobile token doors — this IS the identity layer"],
  ["src/app/api/mcp/", "API key + OAuth 2.1 bearer; own auth layer in src/lib/mcp-oauth.ts"],
  ["src/app/api/health/", "liveness probe: must answer before anything else works"],
  ["src/app/api/openapi.json/", "the public API spec, deliberately readable without a key"],
];

function fail(msg) {
  console.error(msg);
}

/** Every exported function name in a guard module. */
function exportedNames(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) return null; // caller reports it — a moved module must not silently weaken the gate
  const code = stripComments(readFileSync(abs, "utf8"));
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=/g)) names.add(m[1]);

  // DESTRUCTURED exports — `export const { handlers, auth, signIn } = NextAuth(…)`.
  //
  // This is not an exotic case to be thorough about: it is how `auth` itself
  // is exported, i.e. the single most-used guard in the codebase. Without it
  // the derivation missed `auth` and the first run of this gate reported 275
  // false positives — a gate that noisy gets deleted, not fixed. Every
  // identifier in the block is collected; ESTABLISHES_IDENTITY does the
  // filtering, so over-collecting here is harmless.
  for (const m of code.matchAll(/export\s+const\s*\{([\s\S]*?)\}\s*=/g)) {
    for (const id of m[1].matchAll(/[A-Za-z0-9_]+/g)) names.add(id[0]);
  }
  return names;
}

/**
 * Names defined IN THIS FILE whose own body establishes identity.
 *
 * Several routes wrap their auth in a local helper and call it from each
 * handler (`gateAndScope`, `procurementGuard`-style wrappers). Without this,
 * every one of those handlers reads as unguarded — a false positive big enough
 * to get the gate switched off.
 */
function localGateNames(code, guardNames) {
  const names = new Set();
  const decl = /(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\([\s\S]*?\{/g;
  for (const m of code.matchAll(decl)) {
    const name = m[1];
    if (HTTP_METHODS.includes(name)) continue;
    // Body from here to the next declaration, which is enough to see the call.
    const after = code.slice(m.index, m.index + 4000);
    if ([...guardNames].some((g) => new RegExp(String.raw`\b${g}\s*\(`).test(after))) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Every exported function in a module, paired with its body, so we can ask
 * what it calls rather than what it is named.
 */
function exportedFunctionBodies(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) return null;
  const code = stripComments(readFileSync(abs, "utf8"));
  const out = [];
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
  const starts = [...code.matchAll(re)].map((m) => ({ name: m[1], index: m.index }));
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].index : code.length;
    out.push({ name: starts[i].name, body: code.slice(starts[i].index, end) });
  }
  return out;
}

// ── Derive what counts, transitively ──────────────────────────────────────
const guardNames = new Set(SEED_PRIMITIVES);
const missingModules = [];
const moduleFns = [];

for (const mod of GUARD_MODULES) {
  const names = exportedNames(mod);
  if (names === null) {
    missingModules.push(mod);
    continue;
  }
  // A primitive re-exported from a module still counts under its own name.
  for (const n of names) if (SEED_PRIMITIVES.includes(n)) guardNames.add(n);
  const fns = exportedFunctionBodies(mod);
  if (fns) moduleFns.push(...fns);
}

// Fixpoint: promote any exported guard-module function that calls a known
// guard. Bounded by the number of functions, so it always terminates.
for (let pass = 0; pass < moduleFns.length + 1; pass += 1) {
  let grew = false;
  for (const fn of moduleFns) {
    if (guardNames.has(fn.name)) continue;
    const calls = [...guardNames].some((g) =>
      new RegExp(String.raw`\b${g}\s*\(`).test(fn.body)
    );
    if (calls) {
      guardNames.add(fn.name);
      grew = true;
    }
  }
  if (!grew) break;
}

if (missingModules.length) {
  fail("");
  fail("✋ check-route-auth: a guard module in GUARD_MODULES no longer exists:");
  for (const m of missingModules) fail(`     ${m}`);
  fail("");
  fail("  A moved or renamed guard module must not silently shrink the set of");
  fail("  things that count as authenticated — that would turn this gate green");
  fail("  by making it blind. Update GUARD_MODULES to the new path.");
  fail("");
  process.exit(1);
}

if (guardNames.size === 0) {
  fail("✋ check-route-auth: derived ZERO guard names — the gate would pass everything. Refusing to run.");
  process.exit(1);
}

/**
 * The derivation checks ITSELF.
 *
 * Deriving the guard list is what keeps this gate from going stale, but it
 * also means a parsing gap makes the gate quietly WRONG rather than loudly
 * broken — and in the noisy direction it gets muted, while in the quiet
 * direction it passes everything. The first run proved the point: `auth` is
 * exported by destructuring, the extractor did not parse that form, and the
 * gate reported 275 false positives.
 *
 * These are the names whose absence means the extractor is broken, not that
 * the codebase changed. If one genuinely goes away, delete it here — but
 * deliberately, with the rest of its sweep.
 *
 * `requireOrgId` is deliberately NOT a canary, and the reason is the same
 * distinction the whole gate rests on. It takes an already-obtained session
 * and checks a field on it, so it never answers "who is calling?" — a route
 * can only reach it by having called `auth()` first. It is authorisation on
 * top of identity, not identity. (This was a canary in the first draft, and
 * the transitive derivation correctly refused to promote it, which is how the
 * distinction got noticed.)
 */
const CANARIES = ["auth", "getOrgContext"];
const missingCanaries = CANARIES.filter((c) => !guardNames.has(c));
if (missingCanaries.length) {
  fail("");
  fail(`✋ check-route-auth: the derivation did not find ${missingCanaries.join(", ")}.`);
  fail("");
  fail("  These are the most-used guards in the codebase, so their absence means");
  fail("  THIS SCRIPT's export parsing is broken — not that the routes changed.");
  fail("  Fix exportedNames() before trusting any result it produces.");
  fail("");
  process.exit(1);
}

if (VERBOSE) {
  console.log(`Derived ${guardNames.size} identity functions:`);
  console.log("   " + [...guardNames].sort().join(", "));
  console.log("");
}

// ── Check every route ─────────────────────────────────────────────────────
const violations = [];
const exemptUsed = new Set();
let checkedFiles = 0;
let checkedHandlers = 0;

for (const abs of walkRoutes(API_DIR)) {
  const rel = path.relative(ROOT, abs);

  const exemption = EXEMPT.find(([prefix]) => rel.startsWith(prefix));
  if (exemption) {
    exemptUsed.add(exemption[0]);
    continue;
  }

  const code = stripComments(readFileSync(abs, "utf8"));

  // A re-export shim (`export { POST } from "../other/route"`) has no body of
  // its own; the module it delegates to is checked on its own account.
  const delegated = /export\s*\{[^}]*\}\s*from\s*['"]/.test(code);

  const handlers = splitHandlers(code);
  if (handlers.length === 0) {
    if (!delegated && /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)/.test(code)) {
      violations.push({ rel, method: "(unparsed)", why: "handlers found but could not be segmented" });
    }
    continue;
  }

  checkedFiles += 1;
  const localGates = localGateNames(code, guardNames);
  const acceptable = new Set([...guardNames, ...localGates]);

  for (const h of handlers) {
    checkedHandlers += 1;
    const ok = [...acceptable].some((n) => new RegExp(String.raw`\b${n}\s*\(`).test(h.body));
    if (!ok) violations.push({ rel, method: h.method, why: "no identity check in this handler" });
  }
}

// A stale exemption is a slow leak: the directory is gone, the entry stays,
// and the next directory to match that prefix is exempt by accident.
const staleExemptions = EXEMPT.filter(([p]) => !exemptUsed.has(p)).map(([p]) => p);

if (staleExemptions.length) {
  fail("");
  fail("✋ check-route-auth: EXEMPT lists a path that matched no route:");
  for (const p of staleExemptions) fail(`     ${p}`);
  fail("");
  fail("  Remove it. A stale prefix silently exempts whatever is created there next.");
  fail("");
  process.exit(1);
}

if (violations.length) {
  fail("");
  fail(`✋ check-route-auth: ${violations.length} handler(s) establish no identity`);
  fail("");
  for (const v of violations) fail(`     ${v.rel}  →  ${v.method}()   ${v.why}`);
  fail("");
  fail("  A handler that never asks who is calling serves everyone. That is how");
  fail("  the contacts export leaked to desk temps and how the speakers roster");
  fail("  leaked across events — correct-looking code with the check absent.");
  fail("");
  fail("  Fix it one of two ways:");
  fail("");
  fail("    1. It really is unguarded — add the guard. Most event routes want:");
  fail("         const session = await auth();");
  fail("         if (!session?.user) return 401;");
  fail("         const denied = denyReviewer(session, { route: '...' });");
  fail("");
  fail("    2. It uses a guard this gate does not know about — add that guard's");
  fail("       MODULE to GUARD_MODULES in this script (not the function name).");
  fail("");
  fail("  Adding the path to EXEMPT is NOT a fix unless the route is genuinely");
  fail("  unauthenticated by design, and then it needs a reason saying why.");
  fail("");
  process.exit(1);
}

console.log(
  `✓ Route auth: ${checkedHandlers} handler(s) across ${checkedFiles} route file(s) establish identity ` +
    `(${EXEMPT.length} exempt prefixes, ${guardNames.size} guards derived)`
);
