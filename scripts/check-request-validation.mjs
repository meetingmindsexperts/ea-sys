#!/usr/bin/env node
/**
 * Every API route handler that reads a JSON body must validate THAT body.
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
 * A `safeParse` / `safeParseAsync` over THE VALUE THAT CAME FROM THE BODY. The
 * first version of this script accepted any safeParse anywhere in the handler,
 * and a review proved by mutation that a handler which parsed the query
 * string and read the body untyped sailed through. So the script now follows
 * the binding: it finds the identifier that received the body and requires
 * the parse to be over that identifier (or over `{ ...it }`, or a one-hop
 * alias of it, or inline over the read itself). Three binding shapes exist in
 * this tree and all three are followed:
 *
 *     const body = await req.json()
 *     const [session, body] = await Promise.all([auth(), req.json()])   (by POSITION)
 *     const t = await req.text(); … body = JSON.parse(t)
 *
 * The Promise.all form is the house convention (CLAUDE.md's route template)
 * and is how most handlers here read their body; the first version of this
 * rule did not know it and flagged 82 correct handlers. A handler that reads
 * the body and binds it to nothing followable — `const { x } = await
 * req.json()`, or `[{ x }]` at the json position — is by definition
 * destructuring raw input, and fails.
 *
 * Only `safeParse` counts. A bare `X.parse(` used to be accepted too, until
 * the review pointed out that any object with a `parse` method satisfied it;
 * no handler in the codebase relies on the throwing form, and the house
 * convention is safeParse + zodErrorResponse anyway.
 *
 * Deliberately NOT a check that the schema is TIGHT: a permissive schema is a
 * decision someone made and can be reviewed, while no schema at all is an
 * oversight nobody sees. Forcing the author to write the line is the whole
 * win; arguing about its contents is review's job, not CI's.
 *
 * SCOPE
 * -----
 * Two body shapes are in scope: `await req.json()`, and the two-step form two
 * routes use to tolerate an empty body (clone, grant-companion):
 *     const raw = await req.text();  …  body = JSON.parse(raw);
 * The second is followed as a chain: the text binding, then the identifier
 * that received JSON.parse of it, is what must be safeParsed. Out of scope on
 * purpose:
 *   - `formData()` readers (23 today): file uploads that validate by MIME +
 *     magic bytes + size cap, a different and stronger strategy than a shape
 *     parse; widening to them would need a second definition of "validated";
 *   - raw `text()` readers that never JSON-decode: the Stripe webhooks, which
 *     must see the raw body to verify the signature over it, and the OAuth
 *     endpoints, which feed it to URLSearchParams.
 * A gate that flags 25 correct handlers gets muted.
 *
 * KNOWN LIMITS
 * ------------
 * Reads are attributed per HANDLER. A read of `req.json()` that sits outside
 * every recognised handler (a module-level helper taking `req`, a handler in
 * a syntax the splitter does not know) now FAILS the gate outright rather
 * than vanishing, via the file-level count below. What is still invisible is
 * a helper whose parameter is not named `req`/`request` — `(r: Request) =>
 * r.json()` — because the read regex keys on those names. No route does that
 * today. If one appears, this script needs to learn about it, and the honest
 * fix is the same as everything else here: name the shape, do not widen the
 * regex until it matches `response.json()` in a fetch call.
 *
 * Also inherited from check-route-auth, and shared through route-scan.mjs:
 * `stripComments` treats `//` inside a string literal as a line comment and
 * drops the rest of that line. A body read or a safeParse on the SAME line as
 * a quoted URL would vanish from the scan (fails open). No route line has that
 * shape today (checked); the fix is a small string-aware stripper, deferred
 * because it is shared code with its own blast radius.
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

/**
 * A direct read of the JSON body. Keyed on `req`/`request` deliberately —
 * see KNOWN LIMITS.
 */
const JSON_READ = /\b(?:req|request)\s*\.\s*json\s*\(/g;

/**
 * The identifier a JSON read was bound to. Handles every form in the tree:
 *   const raw = await req.json().catch(() => null)
 *   body = await req.json()                        (declared earlier, assigned in try)
 *   const json = (await req.json().catch(...)) as Record<…>
 */
const JSON_BINDING =
  /\b([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?=\s*(?:\(\s*)?await\s+(?:req|request)\s*\.\s*json\s*\(/g;

/** The identifier a raw text read was bound to: `const rawText = await req.text()`. */
const TEXT_BINDING =
  /\b([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?=\s*await\s+(?:req|request)\s*\.\s*text\s*\(/g;

/** `schema.safeParse(await req.json())` — parsed inline, nothing bound. */
const INLINE_PARSE = /\bsafeParse(?:Async)?\s*\(\s*await\s+(?:req|request)\s*\.\s*json\s*\(/;

/**
 * Identifiers that hold a JSON-decoded TEXT body: every `Y = JSON.parse(X)`
 * where `X = await req.text()`. A text read that is never JSON.parsed (a
 * webhook verifying a signature, OAuth feeding URLSearchParams) yields
 * nothing here and is out of scope, which is the point.
 */
function jsonParsedTextIdents(text) {
  const out = [];
  for (const m of text.matchAll(TEXT_BINDING)) {
    const t = escapeIdent(m[1]);
    const re = new RegExp(
      String.raw`\b([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?=\s*JSON\.parse\(\s*${t}\b`,
      "g"
    );
    for (const j of text.matchAll(re)) out.push(j[1]);
  }
  return out;
}

/** Body reads in scope: direct JSON reads plus JSON-decoded text reads. */
function countBodyReads(text) {
  return countMatches(text, JSON_READ) + jsonParsedTextIdents(text).length;
}

/** Split on commas at nesting depth 0, so `{ a, b }` and `f(x, y)` stay whole. */
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}

/** The text inside the bracket that opens at `openIdx`, balanced; null if unclosed. */
function balancedInner(code, openIdx) {
  const open = code[openIdx];
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close && --depth === 0) return code.slice(openIdx + 1, i);
  }
  return null;
}

/**
 * Body identifiers bound by POSITION through the house pattern:
 *     const [session, body] = await Promise.all([auth(), req.json()])
 * The element of the destructured array at the same index as the `req.json()`
 * element is the body. If that element is itself a pattern (`{ x }`) rather
 * than a name, the body is being destructured raw, which is reported so the
 * caller can fail it.
 */
function promiseAllBodyBindings(text) {
  const idents = [];
  let rawDestructures = 0;
  const re = /\[([^\]]*?)\]\s*=\s*await\s+Promise\.all\s*\(/g;
  for (const m of text.matchAll(re)) {
    const afterParen = m.index + m[0].length;
    const arrStart = text.indexOf("[", afterParen);
    if (arrStart === -1 || text.slice(afterParen, arrStart).trim() !== "") continue;
    const inner = balancedInner(text, arrStart);
    if (inner === null) continue;
    const lhs = splitTopLevel(m[1]);
    splitTopLevel(inner).forEach((el, i) => {
      if (!/\b(?:req|request)\s*\.\s*json\s*\(/.test(el)) return;
      const target = lhs[i] ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(target)) idents.push(target);
      else rawDestructures++;
    });
  }
  return { idents, rawDestructures };
}

/** One-hop aliases: every `y = x` / `y = x as T` for a bound body ident `x`. */
function aliasesOf(text, ident) {
  const e = escapeIdent(ident);
  const re = new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+?)?=\s*${e}\b(?!\s*\.)`, "g");
  return [...text.matchAll(re)].map((m) => m[1]).filter((a) => a !== ident);
}

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
    "single field, guarded by `typeof body?.key === 'string'` with a non-string falling back to ''; the key is then matched against ONE exact shape (mirror-archives/*.zip) before any AWS call, and malformed JSON is already a logged 400",
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

function countMatches(text, re) {
  return [...text.matchAll(re)].length;
}

function escapeIdent(id) {
  return id.replace(/\$/g, "\\$");
}

/**
 * True when every identifier the body was bound to is parsed, or the read is
 * parsed inline. A read bound to nothing we can follow is a raw destructure
 * and returns false on purpose.
 */
function handlerValidatesItsBody(body) {
  if (INLINE_PARSE.test(body)) return true;
  const positional = promiseAllBodyBindings(body);
  if (positional.rawDestructures > 0) return false;
  const idents = [
    ...new Set([
      ...[...body.matchAll(JSON_BINDING)].map((m) => m[1]),
      ...jsonParsedTextIdents(body),
      ...positional.idents,
    ]),
  ];
  if (idents.length === 0) return false;
  return idents.every((id) => {
    const names = [id, ...aliasesOf(body, id)];
    // safeParse(body …)  |  safeParse({ ...body …)   for the ident or an alias
    return names.some((n) =>
      new RegExp(String.raw`\bsafeParse(?:Async)?\s*\(\s*(?:\{\s*\.\.\.\s*)?${escapeIdent(n)}\b`).test(body)
    );
  });
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
    const handlers = splitHandlers(code);

    // Every body read in the file must land inside a recognised handler. A
    // read that does not — a module-level helper taking `req`, or a handler
    // in a syntax the splitter cannot see — is a read this gate cannot vouch
    // for, and the review showed the old version silently dropped exactly
    // that case. Fail loudly instead.
    const fileReads = countBodyReads(code);
    const handlerReads = handlers.reduce((n, h) => n + countBodyReads(h.body), 0);
    if (fileReads > handlerReads) {
      violations.push(
        `  ${rel}\n      ${fileReads - handlerReads} body read(s) sit outside any recognised HTTP handler ` +
          `(a module-level helper, or an export shape the splitter does not know).\n` +
          `      Move the read into the handler, or teach scripts/lib/route-scan.mjs the shape.`
      );
    }

    for (const handler of handlers) {
      if (countBodyReads(handler.body) === 0) continue;
      readers++;

      const key = `${rel}::${handler.method}`;
      const validated = handlerValidatesItsBody(handler.body);

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
          `  ${key}\n      reads the JSON body but never safeParses THAT value.\n` +
            `      Bind it (const raw = await req.json()) and parse it (schema.safeParse(raw)) with\n` +
            `      zodErrorResponse (src/lib/api-errors.ts), or add it to HAND_VALIDATED with a reason\n` +
            `      if it validates another way.`
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
