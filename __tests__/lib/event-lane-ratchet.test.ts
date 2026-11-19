/**
 * EVENT LANE RULES: every query on Event runs inside a tenant lane (Event RLS
 * step 4, Nov 5 2026; rewritten Nov 17 2026 when the sweep finished).
 *
 * Event carries a row policy (prisma/rls/event.sql): a query made outside a
 * lane sees no row, so a read answers "not found" and a write changes nothing,
 * with nothing logged. Until Nov 17 this file COUNTED the reads that would do
 * that (126 discovery wraps, 46 files that never entered a lane) so the debt
 * could only shrink. The debt is paid, so the count is gone and the rule is
 * stated outright:
 *
 *  1. EVERY EVENT QUERY IS INSIDE A LANE. A model operation on Event, raw SQL
 *     that names the table, or the settings merge, must sit lexically inside
 *     a call that enters a lane (`runWithTenant`, `tenantTransaction`,
 *     `inOwnLane`, ...), in its own file. The exceptions are LIBRARIES whose
 *     callers enter the lane: each is listed in CALLER_LANED with how many
 *     such queries it holds and why that is sound. Every one was traced to
 *     every caller on Nov 17, 2026 (three read-only audits, about 110 call
 *     sites; ten were found outside a lane and fixed). A new query outside a
 *     lane fails here, in a listed file as much as in a new one.
 *
 *  2. A PER-EVENT ROUTE reads its event through `findGatedEvent`, never the
 *     bare `db.event.findFirst({ where: gate.eventWhere })`.
 *
 *  3. OTHER DIRECT USES of a gate's event filter, outside the two sound ones
 *     (a relation filter inside a lane, a gate built for the helpers). Listed
 *     per file with a reason; see GATE_FILTER_USE_LEFT.
 *
 *  4. A FILTER PARAMETER TYPED LOOSELY (`where: object`). Zero.
 *
 * ALL OF THEM ARE EXACT. More than listed fails with what to do instead; fewer
 * fails too, with the number to write here, so a list never drifts.
 *
 * IT IS LEXICAL, and that is its limit. It cannot follow a call: a library on
 * the list is sound only while its callers stay inside a lane, which is what
 * the runtime detector is for (src/lib/tenant/lane-shadow.ts, RLS_SHADOW=1:
 * it names every Event query made with no lane, and the route or job that
 * made it). It sees `db`, `tx`, `prisma` and `client`, not `dbOperator`, which
 * is outside every lane on purpose. And `scripts/` is not scanned: a script run
 * by hand on a deployment with row security must enter a lane itself.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_ROOTS = ["src", "worker"];
/** The helpers themselves: they are what enters the lane. */
const LANE_HOMES = ["src/lib/tenant/event-tenant.ts", "src/lib/tenant-context.ts", "src/lib/db.ts"];

/**
 * A call that ENTERS a tenant lane. `tenantTransaction` is not one: it applies
 * the lane that is already there and enters none, so a query inside it and
 * nothing else is exactly as exposed as a bare one (review of c6a7318c: the
 * first version counted it, and three files passed on that alone).
 */
const LANE_CALL = /\b(?:runWithTenant|runWithTenantLane|inOwnLane|inHostLane|inScopeLane|inSessionLane)\s*(?:<[^>]*>)?\(/g;
/**
 * A query on Event: a model operation through the app client or a transaction,
 * raw SQL that names the table, or the settings merge, which locks and writes
 * the Event row (review of 2db57e7f: a route whose only Event text was its
 * gated read dropped off the old list while it still wrote the settings).
 */
const QUERY_METHOD = "(?:find\\w*|count|aggregate|groupBy|update\\w*|create\\w*|delete\\w*|upsert)\\b";
/**
 * Through ANY client name but the privileged one (`db`, `tx`, an alias like
 * `c`), and written on one line or across several: `db.event` then
 * `.findFirst(` on the next line is the same query, and three such were missed
 * by every one-line search until the browser suite ran under row security.
 */
const EVENT_QUERY = new RegExp(
  `\\b(?!dbOperator\\b)\\w+\\s*\\.\\s*event\\s*\\.\\s*${QUERY_METHOD}|\\bupdateEventSettings\\(|(?:FROM|UPDATE|JOIN|INTO)\\s+"Event"`,
  "g",
);
/**
 * The same rule for the six tables that carry a row policy since step 5 (Nov
 * 17, 2026): until then each had an event and no organisation, so no earlier
 * sweep had put their queries inside a lane.
 */
const SIX_TABLES = ["emailTemplate", "notification", "eventStats", "importLog", "invoiceCounter", "eventBillingAccount"];
const SIX_TABLES_SQL = ["EmailTemplate", "Notification", "EventStats", "ImportLog", "InvoiceCounter", "EventBillingAccount"];
const SIX_QUERY = new RegExp(
  `\\b(?!dbOperator\\b)\\w+\\s*\\.\\s*(?:${SIX_TABLES.join("|")})\\s*\\.\\s*${QUERY_METHOD}|(?:FROM|UPDATE|JOIN|INTO)\\s+"(?:${SIX_TABLES_SQL.join("|")})"`,
  "g",
);
/**
 * A read of Event THROUGH Organization, the one model that relates to Event
 * and carries no policy: `_count: { events }` or `events: {...}` under an
 * organisation query. The detector cannot see a nested read, and outside a
 * lane it answers 0 with the organisation itself found (review of 9c0a24c5:
 * Settings showed "0 events").
 */
const ORGANISATION_QUERY = /\b(?!dbOperator\b)\w+\s*\.\s*organization\s*\.\s*find\w*\(/g;

/**
 * Libraries whose Event queries rely on the CALLER's lane: the file, how many
 * such queries it holds, and why that is sound. Traced caller by caller on
 * Nov 17, 2026. Adding to this list is a decision: name every caller and where
 * each enters its lane in the review, or enter the lane in the function.
 */
const CALLER_LANED: Record<string, [count: number, why: string]> = {
  "src/app/api/events/[eventId]/billing-accounts/[billingAccountId]/route.ts": [1, "A helper in a route file, called only from handlers that are already inside runWithTenant."],
  "src/app/api/events/[eventId]/route.ts": [1, "Not a query: a type (`ReturnType<typeof db.event.update>`). The updates themselves are inside lanes."],
  "src/app/api/events/[eventId]/webinar/chat/route.ts": [1, "A helper in a route file, called only from handlers that are already inside runWithTenant. It also names the organisation, so the merge enters the lane itself."],
  "src/app/api/events/[eventId]/webinar/livestream/route.ts": [1, "A helper in a route file, called only from handlers that are already inside runWithTenant."],
  "src/app/api/organization/catalogue/route.ts": [1, "The settings merge is handed the organisation, and enters that lane itself (event-settings.ts)."],
  "src/app/e/[slug]/page.tsx": [1, "`loadEvent`, called only inside runWithTenant(scope.organizationId) once findPublicEvent has found the event."],
  "src/crm/integrations/events.ts": [5, "The CRM's Events port: every CRM route, tool and service calls it inside the organisation's lane."],
  "src/lib/agenda-data.ts": [1, "Two callers, the public agenda route and the staff preview, both inside runWithTenant."],
  "src/lib/agent/register-mcp-tools.ts": [5, "An agent / MCP tool: every tool and resource runs inside safeTool / safeResource's lane (register-mcp-tools.ts)."],
  "src/lib/agent/tools/certificates.ts": [6, "An agent / MCP tool: every tool and resource runs inside safeTool / safeResource's lane (register-mcp-tools.ts)."],
  "src/lib/agent/tools/dashboard.ts": [1, "An agent / MCP tool: every tool and resource runs inside safeTool / safeResource's lane (register-mcp-tools.ts)."],
  "src/lib/agent/tools/engagement.ts": [1, "An agent / MCP tool: every tool and resource runs inside safeTool / safeResource's lane (register-mcp-tools.ts)."],
  "src/lib/agent/tools/webinar.ts": [2, "An agent / MCP tool: every tool and resource runs inside safeTool / safeResource's lane (register-mcp-tools.ts)."],
  "src/lib/bulk-email.ts": [1, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/lib/certificates/bundle.ts": [1, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/lib/certificates/cert-context.ts": [2, "Reached from a worker job that scans with the privileged client and enters the row's lane, and from routes inside theirs."],
  "src/lib/certificates/issue-worker.ts": [2, "Reached from a worker job that scans with the privileged client and enters the row's lane, and from routes inside theirs. A run with no organisation gets an empty lane and logs `cert-issue:run-invisible-to-tenant-read`."],
  "src/lib/contacts-central-sync.ts": [1, "MASTER ONLY and outside a lane on purpose: it mirrors every contact to one marketing table, and refuses to run on a multi-tenant deployment."],
  "src/lib/email-log.ts": [1, "Reached only for a send that names an event and no organisation; every such sender is inside a lane, and a miss never fails the send."],
  "src/lib/email-preview-data.ts": [1, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/lib/email.ts": [1, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/lib/event-analytics.ts": [1, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/lib/event-code.ts": [1, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/lib/event-stats.ts": [1, "The stats refresh reads its event's organisation; 39 callers, each inside the event's lane, and it writes nothing when it cannot see the event."],
  "src/lib/event-export/bundle.ts": [1, "One caller, the export route, inside runWithTenant(event.organizationId)."],
  "src/lib/event-export/sheets.ts": [1, "Called by the export bundle only, inside the same lane."],
  "src/lib/event-settings.ts": [6, "The settings merge: a tenant transaction that enters the lane itself when handed the organisation outside one, and otherwise rides its caller's."],
  "src/lib/infra/aws-ops.ts": [2, "The infra heartbeat's scoped client: the privileged one for the platform view, the organisation's lane (inScope) for an organisation's."],
  "src/lib/invoice-service.ts": [1, "The event-code backfill inside invoice creation; every invoice flow runs inside the organisation's lane."],
  "src/lib/media-references.ts": [2, "Two callers, the two media delete routes, both inside runWithTenant(orgGuard.orgId)."],
  "src/lib/notifications.ts": [1, "notifyEventAdmins: 42 callers traced; the three outside a lane (event status, a group refund, a refund sweep row) now enter one."],
  "src/lib/presenter-agreement.ts": [3, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/lib/registrant-details.ts": [1, "Called from the registrant portal's routes, inside the lane their host names."],
  "src/lib/registration-seat-db.ts": [4, "Runs on a `tx` that every caller takes from tenantTransaction, inside a lane."],
  "src/lib/session-proposal-notify.ts": [1, "Called by the two session proposal routes, both inside their lane (the same function's template read is audited with email.ts)."],
  "src/lib/speaker-agreement.ts": [10, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/lib/speaker-companion.ts": [2, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/lib/webinar-email-sequence.ts": [3, "Reached from a worker job that scans with the privileged client and enters the row's lane, and from routes inside theirs."],
  "src/lib/webinar-panelist-email.ts": [1, "Three callers, the panelist routes, all inside runWithTenant(orgGuard.orgId)."],
  "src/lib/webinar-provisioner.ts": [2, "Called inside createEvent's lane and the webinar route's; the retry in its catch rides the same lanes."],
  "src/lib/webinar/handouts-store.ts": [2, "Raw SQL on a tenant transaction; every caller (the handout routes) is inside the organisation's lane."],
  "src/lib/webinar/stream-watchdog.ts": [1, "Reached from a worker job that scans with the privileged client and enters the row's lane, and from routes inside theirs."],
  "src/procurement/services/budget-revenue-service.ts": [1, "Procurement routes and tools, each inside the organisation's lane."],
  "src/procurement/services/budget-service.ts": [2, "Procurement routes and tools, each inside the organisation's lane."],
  "src/services/abstract-service.ts": [6, "A service called by REST routes and agent tools, each inside the organisation's lane before the call (the sixth is bulkUpdateAbstracts, whose one caller, abstracts/bulk-update, enters it first)."],
  "src/services/accommodation-service.ts": [1, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/services/dtcm-eticket-service.ts": [1, "Reached from a worker job that scans with the privileged client and enters the row's lane, and from routes inside theirs."],
  "src/services/event-schedule-shift.ts": [2, "Runs on a `tx` that every caller takes from tenantTransaction, inside a lane."],
  "src/services/event-service.ts": [2, "Inside createEvent's own runWithTenant(input.organizationId), one function up."],
  "src/services/evidence-request-service.ts": [1, "One caller, the evidence request route, inside its lane."],
  "src/services/group-registration-service.ts": [2, "The public group register route and the coordinator's members route, each inside its lane."],
  "src/services/person-field-service.ts": [1, "Runs on a `tx` that every caller takes from tenantTransaction, inside a lane. The plain read is made from the same route, inside its lane."],
  "src/services/promo-code-service.ts": [1, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/services/registration-form-service.ts": [1, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/services/registration-service.ts": [2, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/services/session-service.ts": [3, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/services/speaker-service.ts": [1, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/services/sponsor-service.ts": [1, "The sponsors route (inside its lane since Nov 17, 2026), the agent tool and the Blueprint seed."],
  "src/services/survey-service.ts": [3, "Runs on a `tx` that every caller takes from tenantTransaction, inside a lane."],
};

/** The same list for the six tables of step 5 (Event RLS, Nov 17 2026). */
const SIX_CALLER_LANED: Record<string, [count: number, why: string]> = {
  "src/lib/agent/tools/communications.ts": [4, "An agent / MCP tool: every tool runs inside safeTool's lane (register-mcp-tools.ts)."],
  "src/lib/email-template-create.ts": [4, "Called by the email template routes and the agent tools, each inside the organisation's lane."],
  "src/lib/email-template-reset.ts": [2, "Called by the email template route and the agent tool, each inside the organisation's lane."],
  "src/lib/email.ts": [1, "getEventTemplate: 25 callers traced on Nov 17, 2026, each inside the event's organisation's lane."],
  "src/lib/event-stats.ts": [2, "The stats refresh and its read: 39 callers, each inside the event's lane (its counts are of policied tables)."],
  "src/lib/invoice-numbering.ts": [1, "Runs on a `tx` that every caller takes from tenantTransaction, inside a lane."],
  "src/lib/media-references.ts": [1, "Two callers, the two media delete routes, both inside runWithTenant(orgGuard.orgId)."],
  "src/lib/notifications.ts": [2, "createNotification and notifyEventAdmins: every caller is inside the organisation's lane (42 traced on Nov 17, 2026)."],
  "src/services/billing-account-service.ts": [4, "The billing account merge, on a tenant transaction inside the organisation's lane."],
  "src/services/event-service.ts": [1, "The template seed, inside createEvent's own runWithTenant(input.organizationId)."],
  "src/services/group-registration-service.ts": [1, "The public group register route and the coordinator's members route, each inside its lane."],
};

/**
 * Shape 3: an Event read whose filter is a gate's, or any variable or call
 * named like one (`gate.eventWhere`, `access.eventWhere`, a bare `eventWhere`,
 * `hubEventWhere(...)`), handed straight to the query. Widened after the review
 * of 231e5ce0: the first version matched the literal `gate.eventWhere` only,
 * so a local helper that took the filter as a parameter was invisible to it.
 */
const BARE_GATED_READ = /\b(?:db|tx)\.event\.find\w*\(\s*\{\s*where:\s*[\w.]*[eE]ventWhere\b/g;
/**
 * The files that may, exactly: the two dashboard pages of one event, which
 * build their filter with `hubEventWhere` and read it inside the page's lane
 * (`inSessionLane`, src/lib/tenant/page-lane.ts). Nothing else may.
 */
const BARE_GATED_READ_FILES = [
  "src/app/(dashboard)/events/[eventId]/page.tsx",
  "src/app/(dashboard)/events/[eventId]/setup/page.tsx",
];
/**
 * A function that takes a filter typed `object`, `unknown` or `any`. The type
 * checker cannot tell a filter from a whole gate there: that is how every
 * walk-in QR came to answer 500 in 231e5ce0, caught in review before a push.
 */
const LOOSELY_TYPED_FILTER = /function\s+\w+\(\s*(?:\w+\??:\s*[^,)]*,\s*)*\w*[wW]here\w*\??:\s*(?:object|unknown|any)\b/g;

/**
 * Shape 4: a gate's filter used some other way than through `findGatedEvent`.
 * Shape 3 catches one spelling only; this counts the LINES that still name a
 * gate's filter and are not one of the two uses known to be sound:
 *
 *   - a relation filter on another table (`event: gate.eventWhere`): that
 *     query is on a policied table and every one of them runs inside a lane
 *     (checked by hand on Nov 17, 2026; the swept directories are also held to
 *     a wrap per handler by scripts/check-tenant-als.sh);
 *   - a gate being built for the helpers in src/lib/tenant/event-tenant.ts
 *     (`principal:`, `organisationGate(`, `inOwnLane(`, `findGatedEvent(`).
 *
 * What is left is a short list to read, not a list of bugs: a filter derived
 * from two gates and kept in a variable, a list of scopes, the events list.
 * Exact, so the remaining sweep can only shrink and a new route cannot
 * quietly add a differently spelled bare read (review of 2db57e7f).
 */
const GATE_FILTER_USE = /\.eventWhere\b/;
/**
 * The two sound uses, matched by their SHAPE and not by a word on the line
 * (review of 231e5ce0: `event: ` alone also matched a typed variable named
 * event): a relation filter whose value is the gate's filter, and a gate
 * being built for or handed to the helpers.
 */
const SOUND_GATE_FILTER_USE =
  /\bevent:\s*(?:[\w.]*[eE]ventWhere\b|\{\s*AND:\s*\[[^\]]*[eE]ventWhere)|principal:\s*[\w.]+\s*,\s*eventWhere\b|organisationGate\(|findGatedEvent\(/;
/** Where the filter is built and described, not used. */
const GATE_FILTER_HOME = /^src\/lib\/permissions\//;
/**
 * The lines left, per file, each read on Nov 17, 2026 and found sound. A file
 * not listed here may hold none; a listed file may hold no more than its count.
 */
const GATE_FILTER_USE_LEFT: Record<string, number> = {
  // A relation filter's value, kept in a variable; both queries run inside the lane.
  "src/app/api/email-logs/route.ts": 1,
  // A helper that uses the filter as a relation filter, called inside the lane.
  "src/app/api/events/[eventId]/abstract-themes/[themeId]/sub-themes/[subThemeId]/route.ts": 2,
  // Two gates combined into one filter, then used as a relation filter inside the lane.
  "src/app/api/events/[eventId]/emails/schedule/[id]/retry/route.ts": 1,
  "src/app/api/events/[eventId]/emails/schedule/[id]/route.ts": 1,
  // Two gates combined, then handed to findGatedEvent with the gate's principal.
  "src/app/api/events/[eventId]/registrations/import-contacts/route.ts": 1,
  // The scopes of up to three gates, combined and handed to findGatedEvent.
  "src/app/api/events/[eventId]/registrations/walk-in/route.ts": 2,
  // The two event LISTS, inside inOwnLane; their filter sits on its own line.
  "src/app/api/events/route.ts": 2,
  // The public catalogue's own filter, which only shares the name.
  "src/lib/catalogue-data.ts": 1,
};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(path.join(ROOT, root));
  return out.filter((f) => !LANE_HOMES.includes(f));
}

/** Drop comments so prose that names a pattern does not count as code. */
function code(file: string): string {
  return fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The index of the `)` that closes the `(` at `open`, skipping strings and template literals. */
function closingParen(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return source.length;
}

/** How many matches of `query` in this source sit outside every lane-entering call. */
function queriesOutsideALane(source: string, query: RegExp = EVENT_QUERY): number {
  const lanes = [...source.matchAll(LANE_CALL)].map((m) => {
    const open = m.index + m[0].length - 1;
    return [open, closingParen(source, open)] as const;
  });
  return [...source.matchAll(query)].filter((q) => !lanes.some(([open, close]) => q.index > open && q.index < close)).length;
}

/** How many organisation queries name `events` inside their own arguments, outside every lane. */
function organisationEventReadsOutsideALane(source: string): number {
  const lanes = [...source.matchAll(LANE_CALL)].map((m) => {
    const open = m.index + m[0].length - 1;
    return [open, closingParen(source, open)] as const;
  });
  return [...source.matchAll(ORGANISATION_QUERY)].filter((q) => {
    const open = q.index + q[0].length - 1;
    const args = source.slice(open, closingParen(source, open));
    return /\bevents\b\s*:/.test(args) && !lanes.some(([from, to]) => q.index > from && q.index < to);
  }).length;
}

const counts = (list: Record<string, [count: number, why: string]>) => Object.fromEntries(Object.entries(list).map(([f, [n]]) => [f, n]));
const withoutAReason = (list: Record<string, [count: number, why: string]>) =>
  Object.entries(list).filter(([, [, why]]) => why.trim().length < 20).map(([f]) => f);

describe("Event lane rules", () => {
  const files = sourceFiles();
  const sources = new Map(files.map((f) => [f, code(f)]));

  it("scans a plausible tree", () => {
    // A scanner that silently matched nothing would pass every check below.
    expect(files.length).toBeGreaterThan(500);
    const readers = files.filter((f) => new RegExp(EVENT_QUERY.source).test(sources.get(f)!));
    expect(readers.length).toBeGreaterThan(100);
  });

  it("makes every Event query inside a tenant lane, or in a library whose callers enter one", () => {
    const now = Object.fromEntries(
      files
        .map((f) => [f, queriesOutsideALane(sources.get(f)!)] as const)
        .filter(([, n]) => n > 0),
    );
    expect(
      now,
      "The Event queries that are not lexically inside a lane changed. MORE in a file, or a new file: with " +
        "row security on, that query sees no row, and the route answers 404 (or a write changes nothing) with " +
        "nothing logged. Enter the lane first: a staff route reads its event with findGatedEvent(gate, ...) and " +
        "wraps the rest in runWithTenant(<its organisation>); a public route uses findPublicEvent; a list uses " +
        "inOwnLane / inHostLane; a transaction is tenantTransaction. Only a library whose EVERY caller is " +
        "already inside a lane belongs in CALLER_LANED, with its count and that reason. FEWER: good, lower or " +
        "remove the file's entry.",
    ).toEqual(counts(CALLER_LANED));
    // A reason is part of the entry: an empty one is how a list like this turns into a way to silence the check.
    expect(withoutAReason(CALLER_LANED)).toEqual([]);
  });

  it("holds the six tables of step 5 to the same rule", () => {
    const now = Object.fromEntries(
      files.map((f) => [f, queriesOutsideALane(sources.get(f)!, SIX_QUERY)] as const).filter(([, n]) => n > 0),
    );
    expect(
      now,
      "The queries on EmailTemplate, Notification, EventStats, ImportLog, InvoiceCounter or EventBillingAccount " +
        "that are not lexically inside a lane changed. Each carries a row policy: outside a lane a read finds " +
        "nothing and a write is refused. Enter the organisation's lane first, and STAMP organizationId on a " +
        "create (the policy refuses a row without it; tests/tenancy/eventonly-rls.test.ts). Only a library " +
        "whose every caller is already inside a lane belongs in SIX_CALLER_LANED.",
    ).toEqual(counts(SIX_CALLER_LANED));
    expect(withoutAReason(SIX_CALLER_LANED)).toEqual([]);
  });

  it("stamps the organisation on every create of the six tables", () => {
    // The column is optional to Prisma, so a create without it compiles, passes every mocked test and
    // is invisible on master. On the platform the row policy refuses it, and from a fire-and-forget
    // path the caller still answers 200: that is how the template seed on event creation shipped
    // unstamped until the browser suite ran under row security (review of 4054ed0e).
    const WRITE = new RegExp(`\\b(?!dbOperator\\b)\\w+\\s*\\.\\s*(?:${SIX_TABLES.join("|")})\\s*\\.\\s*(?:create|createMany|upsert)\\s*\\(`, "g");
    let writes = 0;
    const unstamped: string[] = [];
    for (const f of files) {
      const source = sources.get(f)!;
      for (const w of source.matchAll(WRITE)) {
        writes++;
        const open = w.index + w[0].length - 1;
        if (!/\borganizationId\b/.test(source.slice(open, closingParen(source, open)))) unstamped.push(`${f}: ${w[0].replace(/\s+/g, "")}`);
      }
    }
    expect(writes).toBeGreaterThanOrEqual(13);
    expect(
      unstamped,
      "A create, createMany or upsert on one of the six tables does not name organizationId in its arguments. " +
        "Stamp the EVENT's organisation (the row policy refuses a row without it). The one entry allowed is " +
        "createNotification, whose whole `data` is a typed parameter that requires it.",
    ).toEqual(["src/lib/notifications.ts: db.notification.create("]);
    expect(code("src/lib/notifications.ts")).toMatch(/organizationId: string;/);
  });

  it("never reads Event through Organization outside a lane", () => {
    const outside = files.filter((f) => organisationEventReadsOutsideALane(sources.get(f)!) > 0).sort();
    // The rule sees the shape at all: the organisation's own route reads its event count, inside its lane.
    expect(code("src/app/api/organization/route.ts")).toMatch(/_count:\s*\{\s*select:\s*\{\s*events:/);
    expect(
      outside,
      "An organisation query reaches into its events (`_count: { select: { events } }`, `events: {...}`) " +
        "outside a lane. Organization has no policy, so the organisation comes back, and its events come back " +
        "as none: a count of 0 with nothing logged. Wrap the query in runWithTenant(<that organisation>); a " +
        "list across tenants for the operator reads through the privileged client.",
    ).toEqual([]);
  });

  it("lists every file that calls the privileged discovery read", () => {
    // `resolveEventTenant` sees every tenant's events. The allow-list in check-tenant-als.sh covers who
    // imports the privileged CLIENT, not who calls this function, which any file may import. So the
    // callers are named here: a new one is a decision (review of 9c0a24c5). Each binds the filter to the
    // caller's own link to the event, or (the submissions POST) is recorded in docs/ROADMAP.md.
    const callers = files.filter((f) => /\bresolveEventTenant\s*\(/.test(sources.get(f)!)).sort();
    expect(callers).toEqual([
      "src/app/api/events/[eventId]/abstracts/[abstractId]/submissions/route.ts",
      "src/app/api/events/[eventId]/submitter-context/route.ts",
      "src/app/api/my-reviews/[eventId]/[abstractId]/route.ts",
    ]);
  });

  it("runs every agent and MCP tool through the wrapper that enters the lane", () => {
    // The agent files are on the lists above BECAUSE safeTool / safeResource enter the organisation's
    // lane around every executor. A tool registered without the wrapper would be outside one.
    const core = code("src/lib/agent/register-mcp-tools.ts");
    const tools = core.match(/\bserver\.tool\(/g)?.length ?? 0;
    const wrapped = (core.match(/\bsafeTool\(/g)?.length ?? 0) - (core.match(/function\s+safeTool\(/g)?.length ?? 0);
    expect(tools).toBeGreaterThan(0);
    expect(wrapped, "a tool is registered without safeTool").toBe(tools);
    const resources = core.match(/\bserver\.resource\(/g)?.length ?? 0;
    const wrappedResources = (core.match(/\bsafeResource\(/g)?.length ?? 0) - (core.match(/function\s+safeResource\(/g)?.length ?? 0);
    expect(resources).toBeGreaterThan(0);
    expect(wrappedResources, "a resource is registered without safeResource").toBe(resources);
    // The CRM's and Budgets' tools have a wrapper of their own, which enters the lane too.
    for (const file of ["src/crm/agent-tools.ts", "src/procurement/agent-tools.ts"]) {
      expect(code(file), file).toMatch(/runWithTenant\(organizationId,/);
    }
    expect(core).toMatch(/const text = await runWithTenant\(organizationId, run\)/);
    expect(core).toMatch(/return await runWithTenant\(organizationId, run\)/);
  });

  it("reads the event behind a permission gate through findGatedEvent, never bare", () => {
    const bare = files.filter((f) => (sources.get(f)!.match(BARE_GATED_READ)?.length ?? 0) > 0).sort();
    expect(
      bare,
      "A file reads Event with a gate's filter handed straight to the query (`db.event.find*({ where: " +
        "<...>eventWhere })`). Outside a lane that read returns null once Event has a policy, and the route " +
        "answers 404 with nothing logged. Call `findGatedEvent(gate, { select: ... })` from " +
        "src/lib/tenant/event-tenant.ts. If a listed file was converted, remove it from BARE_GATED_READ_FILES.",
    ).toEqual(BARE_GATED_READ_FILES);
  });

  it("types a filter parameter as what it is, never object, unknown or any", () => {
    const loose = files
      .filter((f) => f.startsWith("src/app/"))
      .flatMap((f) => (sources.get(f)!.match(LOOSELY_TYPED_FILTER) ?? []).map((found) => `${f}: ${found}`));
    expect(
      loose,
      "A function takes a filter typed object / unknown / any. Type it `Prisma.EventWhereInput`, or take the " +
        "gate as `EventGate` and read through findGatedEvent: with a loose type, a whole gate passed where a " +
        "filter was meant compiles and fails only when the query runs.",
    ).toEqual([]);
  });

  it("does not add direct uses of a gate's event filter (use findGatedEvent)", () => {
    const left = Object.fromEntries(
      files
        .filter((f) => !GATE_FILTER_HOME.test(f))
        .map((f) => [f, sources.get(f)!.split("\n").filter((line) => GATE_FILTER_USE.test(line) && !SOUND_GATE_FILTER_USE.test(line)).length] as const)
        .filter(([, n]) => n > 0),
    );
    expect(
      left,
      "The lines that name a gate's event filter outside the two sound shapes (a relation filter, a gate " +
        "handed to the helpers) changed. More than listed: read the event with findGatedEvent(gate, { select }) " +
        "and pass the EVENT on, not the filter. Fewer: good, lower or remove the file's count in " +
        "GATE_FILTER_USE_LEFT. A new sound line needs its file, its count and a reason there.",
    ).toEqual(GATE_FILTER_USE_LEFT);
  });
});
