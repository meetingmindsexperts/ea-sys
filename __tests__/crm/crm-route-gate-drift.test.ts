/**
 * Route-gate drift guard.
 *
 * THE BUG THIS EXISTS TO PREVENT.
 * The contacts review's H1 was not "we had no guard". The guard existed and was
 * correct. The bug was that four READ routes simply never called it — `denyReviewer`
 * covered the writes, everyone assumed reads were covered too, and a per-event desk
 * temp could export the entire org CRM. The failure mode of a hand-applied guard is
 * that it is *usually* applied.
 *
 * So this test does not check that the gate WORKS (crm-visibility.test.ts does
 * that). It checks that every exported handler in every /api/crm/** route FILE
 * actually calls one — by reading the source. It is deliberately a static
 * source-level assertion rather than a runtime one, because the thing that goes
 * wrong is a *missing line*, and only source can see a line that isn't there.
 *
 * If you add a CRM route, this test will fail until you gate it. That is the point.
 * If you add a genuinely public CRM endpoint (there is currently no such thing, and
 * there probably shouldn't be), add it to PUBLIC_ROUTES below — deliberately.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CRM_API_ROOT = join(process.cwd(), "src/app/api/crm");

/** Handlers that intentionally need no auth. There are none — and that is correct. */
const PUBLIC_ROUTES: string[] = [];

/** Reads may use the read gate OR a stronger one (purge ⊇ delete ⊇ write ⊇ read). */
const READ_GATES = ["requireCrmRead", "requireCrmWrite", "requireCrmDelete", "requireCrmPurge"];
/**
 * Mutations must use the WRITE gate or a stronger one — requireCrmDelete wraps
 * requireCrmWrite (same rate limit, narrower RBAC), and requireCrmPurge wraps
 * requireCrmDelete (SUPER_ADMIN sessions only, API keys refused).
 */
const WRITE_GATES = ["requireCrmWrite", "requireCrmDelete", "requireCrmPurge"];

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

interface Handler {
  file: string;
  rel: string;
  method: string;
  source: string;
}

/** Every exported HTTP handler across the CRM API surface. */
function allHandlers(): Handler[] {
  const handlers: Handler[] = [];
  for (const file of routeFiles(CRM_API_ROOT)) {
    const source = readFileSync(file, "utf8");
    const rel = file.slice(file.indexOf("src/app/api/"));
    for (const m of source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)) {
      handlers.push({ file, rel, method: m[1]!, source });
    }
  }
  return handlers;
}

describe("every /api/crm/* handler is gated", () => {
  const handlers = allHandlers();

  it("finds the CRM API surface (guards against this test silently testing nothing)", () => {
    // If a refactor moves the routes, this test would otherwise pass vacuously —
    // a green test that checks zero files is worse than no test at all.
    expect(handlers.length).toBeGreaterThanOrEqual(9);
  });

  it.each(allHandlers().map((h) => [`${h.method} ${h.rel}`, h] as const))(
    "%s calls a CRM gate",
    (label, h) => {
      if (PUBLIC_ROUTES.includes(h.rel)) return;

      const gated = READ_GATES.some((g) => h.source.includes(g));
      expect(
        gated,
        `${label} does not call requireCrmRead/requireCrmWrite. An ungated CRM route exposes the ` +
          `sponsorship pipeline to ONSITE / REVIEWER / SUBMITTER / REGISTRANT — this is exactly the ` +
          `contacts-H1 bug (the guard existed; a route just didn't call it).`,
      ).toBe(true);
    },
  );

  it.each(
    allHandlers()
      .filter((h) => MUTATING.has(h.method))
      .map((h) => [`${h.method} ${h.rel}`, h] as const),
  )("%s uses the WRITE gate (which also carries the rate limit)", (label, h) => {
    if (PUBLIC_ROUTES.includes(h.rel)) return;

    const gated = WRITE_GATES.some((g) => h.source.includes(g));
    expect(
      gated,
      `${label} is a mutation but does not call requireCrmWrite. Read-gating a write would let ` +
        `MEMBER — a read-only role we hand to sponsor-side stakeholders — modify the pipeline, and ` +
        `would skip the default write rate limit that lives in requireCrmWrite.`,
    ).toBe(true);
  });
});

describe("every /api/crm/inbox/* handler ALSO gates on canViewCrmInbox", () => {
  // The base gate (requireCrmRead) admits MEMBER — the read-only account we hand
  // to sponsor-side stakeholders. The inbox is the one CRM surface MEMBER must
  // NOT reach (a sponsor must never read a rival's negotiation thread), so every
  // inbox handler layers the narrower canViewCrmInbox on top. That layer is
  // hand-applied, so this asserts it's present on every inbox route — the same
  // "a route just didn't call it" failure mode the base drift test guards.
  const inboxHandlers = allHandlers().filter((h) => h.rel.includes("/api/crm/inbox/"));

  it("finds the inbox routes (not testing nothing)", () => {
    expect(inboxHandlers.length).toBeGreaterThanOrEqual(4);
  });

  it.each(inboxHandlers.map((h) => [`${h.method} ${h.rel}`, h] as const))(
    "%s calls canViewCrmInbox",
    (label, h) => {
      expect(
        h.source.includes("canViewCrmInbox"),
        `${label} is an inbox route but does not call canViewCrmInbox. requireCrmRead alone ` +
          `admits MEMBER, so this would leak sponsor negotiation threads/attachments to a ` +
          `sponsor-side account — the review-M6 gap.`,
      ).toBe(true);
    },
  );
});

describe("the write gate carries the rate limit", () => {
  it("requireCrmWrite calls checkRateLimit, so no CRM write can be unlimited", () => {
    // The rate limit is deliberately inside the gate rather than pasted into each
    // handler: §7.4 asks for "rate limits on writes", and per-handler pasting
    // guarantees the ninth route added later won't have one. If someone moves the
    // limit back out into the routes, this fails.
    const src = readFileSync(join(process.cwd(), "src/crm/lib/crm-route.ts"), "utf8");
    const writeGate = src.slice(src.indexOf("export async function requireCrmWrite"));
    expect(writeGate).toContain("checkRateLimit");
  });
});
