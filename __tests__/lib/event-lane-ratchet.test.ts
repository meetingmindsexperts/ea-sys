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

/** A call that enters a tenant lane, or marks the one sanctioned read made before one. */
const LANE_CALL =
  /\b(?:runWithTenant|runWithTenantLane|tenantTransaction|inOwnLane|inHostLane|inScopeLane|inSessionLane|asEventDiscovery)\s*(?:<[^>]*>)?\(/g;
/**
 * A query on Event: a model operation through the app client or a transaction,
 * raw SQL that names the table, or the settings merge, which locks and writes
 * the Event row (review of 2db57e7f: a route whose only Event text was its
 * gated read dropped off the old list while it still wrote the settings).
 */
const EVENT_QUERY =
  /\b(?:db|tx|prisma|client)\.event\.(?:find\w*|count|aggregate|groupBy|update\w*|create\w*|delete\w*|upsert)\b|\bupdateEventSettings\(|(?:FROM|UPDATE|JOIN|INTO)\s+"Event"/g;

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
  "src/lib/event-export/bundle.ts": [1, "One caller, the export route, inside runWithTenant(event.organizationId)."],
  "src/lib/event-export/sheets.ts": [1, "Called by the export bundle only, inside the same lane."],
  "src/lib/event-settings.ts": [5, "The settings merge: a tenant transaction that enters the lane itself when handed the organisation, and otherwise rides its caller's."],
  "src/lib/media-references.ts": [2, "Two callers, the two media delete routes, both inside runWithTenant(orgGuard.orgId)."],
  "src/lib/notifications.ts": [1, "notifyEventAdmins: 42 callers traced; the three outside a lane (event status, a group refund, a refund sweep row) now enter one."],
  "src/lib/presenter-agreement.ts": [3, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/lib/registrant-details.ts": [1, "Called from the registrant portal's routes, inside the lane their host names."],
  "src/lib/registration-seat-db.ts": [4, "Runs on a `tx` that every caller takes from tenantTransaction, inside a lane."],
  "src/lib/speaker-agreement.ts": [10, "An email or document builder: every route, the bulk send and the scheduled-email worker call it inside the lane."],
  "src/lib/speaker-companion.ts": [2, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
  "src/lib/webinar-email-sequence.ts": [3, "Reached from a worker job that scans with the privileged client and enters the row's lane, and from routes inside theirs."],
  "src/lib/webinar-panelist-email.ts": [1, "Three callers, the panelist routes, all inside runWithTenant(orgGuard.orgId)."],
  "src/lib/webinar-provisioner.ts": [2, "Called inside createEvent's lane and the webinar route's; the retry in its catch rides the same lanes."],
  "src/lib/webinar/stream-watchdog.ts": [1, "Reached from a worker job that scans with the privileged client and enters the row's lane, and from routes inside theirs."],
  "src/procurement/services/budget-revenue-service.ts": [1, "Procurement routes and tools, each inside the organisation's lane."],
  "src/procurement/services/budget-service.ts": [2, "Procurement routes and tools, each inside the organisation's lane."],
  "src/services/abstract-service.ts": [5, "A service called by REST routes and agent tools, each inside the organisation's lane before the call."],
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
  "src/services/survey-service.ts": [2, "Runs on a `tx` that every caller takes from tenantTransaction, inside a lane."],
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

/** How many Event queries in this source sit outside every lane-entering call. */
function queriesOutsideALane(source: string): number {
  const lanes = [...source.matchAll(LANE_CALL)].map((m) => {
    const open = m.index + m[0].length - 1;
    return [open, closingParen(source, open)] as const;
  });
  return [...source.matchAll(EVENT_QUERY)].filter((q) => !lanes.some(([open, close]) => q.index > open && q.index < close)).length;
}

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
    ).toEqual(Object.fromEntries(Object.entries(CALLER_LANED).map(([f, [n]]) => [f, n])));
    // A reason is part of the entry: an empty one is how a list like this turns into a way to silence the check.
    expect(Object.entries(CALLER_LANED).filter(([, [, why]]) => why.trim().length < 20).map(([f]) => f)).toEqual([]);
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
