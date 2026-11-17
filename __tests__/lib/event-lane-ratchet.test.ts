/**
 * EVENT LANE RATCHET: the debt that blocks an RLS policy on Event can only go
 * down (Event RLS preparation, step 4, Nov 5 2026).
 *
 * Event has no policy yet (`DELIBERATELY_UNPOLICIED` in rls-coverage.test.ts)
 * because many reads of it run outside a tenant lane, and under a policy those
 * reads return null with nothing logged. Two shapes carry that debt, and this
 * file pins both so new code cannot add to them:
 *
 *  1. DISCOVERY WRAPS. Read the Event outside a lane, then
 *     `runWithTenant(event.organizationId, ...)`. The first read is the one that
 *     dies under a policy. Staff routes should enter the SESSION's lane first
 *     (`runWithTenantLane(session.user.organizationId, ...)`) and read inside it;
 *     public routes should discover through src/lib/tenant/event-tenant.ts.
 *  2. UNLANED FILES. A file that reads Event and never enters a lane at all.
 *     Many are libraries that inherit their caller's lane, which is fine; the
 *     list is still pinned so a NEW one is a decision, not an accident.
 *
 *  3. BARE GATED READS (Nov 16, 2026). A per-event route used to open with
 *     `db.event.findFirst({ where: gate.eventWhere, ... })` outside any lane.
 *     All 238 of them now call `findGatedEvent(gate, ...)` in
 *     src/lib/tenant/event-tenant.ts, which makes the same read inside the
 *     caller's lane (or through the sanctioned discovery for a caller whose
 *     reach is not their organisation: a reviewer, submitter or registrant, or
 *     an operator with none). This count is ZERO and stays zero. The wraps of shape 1
 *     that follow such a read are no longer a debt, but the count of shape 1
 *     cannot tell them apart, so it is unchanged by that sweep.
 *
 *  4. OTHER DIRECT USES of a gate's event filter, outside the two sound ones
 *     (a relation filter inside a lane, a gate built for the helpers). Listed
 *     per file with a reason; see GATE_FILTER_USE_LEFT.
 *
 *  5. A FILTER PARAMETER TYPED LOOSELY (`where: object`). Zero.
 *
 * ALL OF THEM ARE EXACT. Going up fails, with what to do instead. Going down fails
 * too, with the new number to write here: that is what makes it a ratchet
 * rather than a ceiling that quietly drifts back up.
 *
 * IT IS A HEURISTIC, and stable rather than exact. The comment stripper also
 * eats a `/*` inside a string literal (e.g. "image/*") up to the next `*\/`;
 * DISCOVERY_WRAP matches any name starting `ev` (an `evidence.organizationId`
 * would count); EVENT_READ sees `db` and `tx` only, not `dbOperator` (which is
 * deliberately outside a lane anyway). Every machine computes the same numbers,
 * so the ratchet holds; just do not read the counts as a precise inventory.
 *
 * The runtime counterpart is the shadow detector (src/lib/tenant/lane-shadow.ts,
 * RLS_SHADOW=1), which sees the library calls this static count cannot.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_ROOTS = ["src", "worker"];
/** The sanctioned discovery read. It IS the pre-lane read, by design. */
const SANCTIONED = "src/lib/tenant/event-tenant.ts";

/** Shape 1: `runWithTenant(<...>event.organizationId`, also ev / evt / invite.event. */
const DISCOVERY_WRAP = /runWithTenant(?:Lane)?\(\s*(?:\w+\??\.)*(?:event|ev|evt)\w*\??\.organizationId/g;
/**
 * A query against the Event model through the app client or a transaction, or
 * the settings merge, which locks and writes the Event row (review of
 * 2db57e7f: a route whose only Event text was its gated read dropped off the
 * list below while it still wrote the event's settings outside a lane).
 */
const EVENT_READ = /\b(?:db|tx)\.event\.(?:find\w*|count|aggregate|groupBy|update\w*|create\w*|delete\w*|upsert)\b|\bupdateEventSettings\(/;
/** Any sign the file runs inside, or deliberately outside, a lane. */
const LANE_MARKER = /runWithTenant|tenantTransaction|dbOperator|resolveEventTenant|resolvePublicEventOrg/;

/**
 * Shape 3: an Event read whose filter is a gate's, or any variable or call
 * named like one (`gate.eventWhere`, `access.eventWhere`, a bare `eventWhere`,
 * `hubEventWhere(...)`), handed straight to the query. Widened after the review
 * of 231e5ce0: the first version matched the literal `gate.eventWhere` only,
 * so a local helper that took the filter as a parameter was invisible to it.
 */
const BARE_GATED_READ = /\b(?:db|tx)\.event\.find\w*\(\s*\{\s*where:\s*[\w.]*[eE]ventWhere\b/g;
/**
 * The files still doing it, exactly: the dashboard's event pages and the
 * traffic report, which build their filter with `hubEventWhere`. They are the
 * next sweep's (docs/SECURITY_AUDIT_ACTION_PLAN.md §3.1). Nothing else may.
 */
const BARE_GATED_READ_FILES = [
  "src/app/(dashboard)/events/[eventId]/page.tsx",
  "src/app/(dashboard)/events/[eventId]/setup/page.tsx",
  "src/app/api/analytics/traffic/route.ts",
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

const DISCOVERY_WRAP_BASELINE = 126;

const UNLANED_EVENT_FILES_BASELINE: string[] = [
  "src/analytics/store/site-resolver.ts",
  "src/app/(dashboard)/dashboard/page.tsx",
  "src/app/(dashboard)/events/[eventId]/page.tsx",
  "src/app/(dashboard)/events/[eventId]/setup/page.tsx",
  "src/app/(dashboard)/events/page.tsx",
  "src/app/api/analytics/traffic/route.ts",
  "src/app/api/auth/forgot-password/route.ts",
  "src/app/api/events/[eventId]/onsite-staff/route.ts",
  "src/app/api/events/route.ts",
  "src/app/api/import/eventsair/route.ts",
  "src/app/api/organization/catalogue/route.ts",
  "src/app/api/organization/eventsair/events/route.ts",
  "src/app/api/organization/onsite-staff/route.ts",
  "src/app/api/public/events/[slug]/supporting-document/route.ts",
  "src/app/api/upload/pdf/route.ts",
  "src/app/catalogue/[kind]/[topic]/page.tsx",
  "src/app/catalogue/page.tsx",
  "src/app/llms.txt/route.ts",
  "src/app/sitemap.ts",
  // The CRM's Events port (Nov 6, 2026): a library whose every caller (the CRM
  // routes, MCP tools and import/report/email services) already runs inside the
  // organisation's lane. It replaced the three CRM services that read Event here.
  "src/crm/integrations/events.ts",
  "src/lib/agent/event-facts-loader.ts",
  "src/lib/agent/execute-handler.ts",
  "src/lib/agent/system-prompt.ts",
  "src/lib/bulk-email.ts",
  "src/lib/catalogue-data.ts",
  "src/lib/certificates/bundle.ts",
  "src/lib/certificates/cert-context.ts",
  "src/lib/contacts-central-sync.ts",
  "src/lib/email-preview-data.ts",
  "src/lib/email.ts",
  "src/lib/event-analytics.ts",
  "src/lib/event-code.ts",
  "src/lib/event-export/bundle.ts",
  "src/lib/event-export/sheets.ts",
  "src/lib/help-chat/event-facts.ts",
  "src/lib/media-references.ts",
  "src/lib/notifications.ts",
  "src/lib/presenter-agreement.ts",
  "src/lib/registration-seat-db.ts",
  "src/lib/speaker-agreement.ts",
  "src/lib/webinar-panelist-email.ts",
  "src/lib/webinar/viewer-question-access.ts",
  "src/services/event-schedule-shift.ts",
  "src/services/evidence-request-service.ts",
  "src/services/speaker-service.ts",
];

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
  return out.filter((f) => f !== SANCTIONED);
}

/** Drop comments so prose that names a pattern does not count as code. */
function code(file: string): string {
  return fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("Event lane ratchet", () => {
  const files = sourceFiles();
  const sources = new Map(files.map((f) => [f, code(f)]));

  it("scans a plausible tree", () => {
    // A scanner that silently matched nothing would pass every check below.
    expect(files.length).toBeGreaterThan(500);
    const readers = files.filter((f) => EVENT_READ.test(sources.get(f)!));
    expect(readers.length).toBeGreaterThan(100);
  });

  it("does not add discovery wraps (read Event outside a lane, then enter its org)", () => {
    const perFile = files
      .map((f) => [f, sources.get(f)!.match(DISCOVERY_WRAP)?.length ?? 0] as const)
      .filter(([, n]) => n > 0);
    const total = perFile.reduce((sum, [, n]) => sum + n, 0);

    if (total > DISCOVERY_WRAP_BASELINE) {
      expect.fail(
        `Discovery wraps went UP: ${total} (baseline ${DISCOVERY_WRAP_BASELINE}). The Event read before ` +
          "runWithTenant(event.organizationId) returns null once Event has a policy. In a staff route, " +
          "enter runWithTenantLane(session.user.organizationId, ...) FIRST and read the event inside it; " +
          "in a public route, get the org from resolvePublicEventOrg (src/lib/tenant/event-tenant.ts). " +
          "Files: " + perFile.map(([f, n]) => `${f} (${n})`).join(", "),
      );
    }
    expect(
      total,
      `Discovery wraps went DOWN to ${total}. Good: set DISCOVERY_WRAP_BASELINE to ${total} in this file.`,
    ).toBe(DISCOVERY_WRAP_BASELINE);
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

  it("does not add files that read Event and never enter a lane", () => {
    const now = files.filter((f) => EVENT_READ.test(sources.get(f)!) && !LANE_MARKER.test(sources.get(f)!)).sort();
    const added = now.filter((f) => !UNLANED_EVENT_FILES_BASELINE.includes(f));
    const removed = UNLANED_EVENT_FILES_BASELINE.filter((f) => !now.includes(f));

    expect(
      added,
      "These files read Event and never enter a tenant lane. Wrap the handler in runWithTenantLane / " +
        "runWithTenant, or discover through src/lib/tenant/event-tenant.ts. A library that only ever runs " +
        "inside its caller's lane may be added to UNLANED_EVENT_FILES_BASELINE, with that reason in review.",
    ).toEqual([]);
    expect(
      removed,
      "These files no longer read Event outside a lane (or no longer exist). Good: remove them from " +
        "UNLANED_EVENT_FILES_BASELINE so the list stays exact.",
    ).toEqual([]);
  });
});
