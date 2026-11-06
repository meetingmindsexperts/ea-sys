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
 * BOTH ARE EXACT. Going up fails, with what to do instead. Going down fails
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
/** A query against the Event model through the app client or a transaction. */
const EVENT_READ = /\b(?:db|tx)\.event\.(?:find\w*|count|aggregate|groupBy|update\w*|create\w*|delete\w*|upsert)\b/;
/** Any sign the file runs inside, or deliberately outside, a lane. */
const LANE_MARKER = /runWithTenant|tenantTransaction|dbOperator|resolveEventTenant|resolvePublicEventOrg/;

const DISCOVERY_WRAP_BASELINE = 126;

const UNLANED_EVENT_FILES_BASELINE: string[] = [
  "src/analytics/store/site-resolver.ts",
  "src/app/(dashboard)/dashboard/page.tsx",
  "src/app/(dashboard)/events/[eventId]/page.tsx",
  "src/app/(dashboard)/events/[eventId]/setup/page.tsx",
  "src/app/(dashboard)/events/page.tsx",
  "src/app/api/analytics/traffic/route.ts",
  "src/app/api/auth/forgot-password/route.ts",
  "src/app/api/events/[eventId]/agreement-pdf-images/route.ts",
  "src/app/api/events/[eventId]/analytics/traffic/route.ts",
  "src/app/api/events/[eventId]/email-attachments/route.ts",
  "src/app/api/events/[eventId]/email-templates/[templateId]/duplicate/route.ts",
  "src/app/api/events/[eventId]/email-templates/[templateId]/route.ts",
  "src/app/api/events/[eventId]/email-templates/route.ts",
  "src/app/api/events/[eventId]/import-logs/route.ts",
  "src/app/api/events/[eventId]/onsite-staff/route.ts",
  "src/app/api/events/[eventId]/speaker-agreement-template/route.ts",
  "src/app/api/events/[eventId]/sponsors/route.ts",
  "src/app/api/events/[eventId]/zoom/settings/route.ts",
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
  "src/lib/event-settings.ts",
  "src/lib/help-chat/event-facts.ts",
  "src/lib/media-references.ts",
  "src/lib/notifications.ts",
  "src/lib/presenter-agreement.ts",
  "src/lib/registration-seat-db.ts",
  "src/lib/rsvp/server.ts",
  "src/lib/share-link-access.ts",
  "src/lib/speaker-agreement.ts",
  "src/lib/webinar-panelist-email.ts",
  "src/lib/webinar/live-polls-server.ts",
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
