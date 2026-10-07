/**
 * Where the middleware sends each role, for every kind of dashboard path:
 * the safety net for moving confinement onto areas (custom roles Phase 3).
 * Recorded on the role-based branches (Oct 5, 2026); re-record only on an
 * intended change: `npx vitest run __tests__/lib/route-confinement.test.ts -u`,
 * then read the diff.
 */
import { describe, it, expect } from "vitest";
import { confinementRedirect } from "@/lib/route-confinement";

const ROLES = ["SUPER_ADMIN", "ADMIN", "ORGANIZER", "MEMBER", "ONSITE", "WEBINARS", "CRM_USER", "HR_USER", "REVIEWER", "SUBMITTER", "REGISTRANT", "CUSTOM", "UNKNOWN", ""];

// Every path the middleware matcher covers, by kind.
const PATHS = [
  "/dashboard",
  "/events",
  "/events/new",
  "/events/e1",
  "/events/e1/registrations",
  "/events/e1/registrations/r1",
  "/events/e1/check-in",
  "/events/e1/check-in/kiosk",
  "/events/e1/speakers",
  "/events/e1/abstracts",
  "/events/e1/abstracts/new",
  "/events/e1/session-proposals",
  "/events/e1/my-details",
  "/events/e1/settings",
  "/events/e1/webinar",
  "/settings",
  "/contacts",
  "/contacts/c1",
  "/profile",
  "/logs",
  "/agent",
  "/invoices",
  "/analytics",
  // In the matcher since Oct 7, 2026 (Phase 6 review).
  "/crm",
  "/hr",
  "/procurement",
  "/activity",
  "/media",
  "/my-registration",
  "/api/events",
];

describe("middleware confinement", () => {
  it("matches the recorded role-by-path decisions", async () => {
    const lines: string[] = [];
    for (const role of ROLES) {
      lines.push(`# ${role || "(no role)"}`);
      for (const path of PATHS) lines.push(`  ${path} -> ${confinementRedirect(role || null, path) ?? "pass"}`);
    }
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./__snapshots__/route-confinement.txt");
  });
});

// Review of 0875035c (Oct 7, 2026): /hr and /procurement entered the matcher,
// so the middleware must honour the per-person grants their APIs honour.
describe("per-person grants open their module", () => {
  it("the HR tick opens /hr for a role that works elsewhere", () => {
    expect(confinementRedirect("ONSITE", "/hr")).toBe("/events");
    expect(confinementRedirect("ONSITE", "/hr", { hrAccess: true })).toBeNull();
    expect(confinementRedirect("CRM_USER", "/hr", { hrAccess: true })).toBeNull();
  });

  it("a budget grant opens /procurement", () => {
    expect(confinementRedirect("CRM_USER", "/procurement")).toBe("/crm");
    expect(confinementRedirect("CRM_USER", "/procurement", { procurementRequest: true })).toBeNull();
    expect(confinementRedirect("HR_USER", "/procurement", { procurementApproveCeilingAed: 5000 })).toBeNull();
    expect(confinementRedirect("HR_USER", "/procurement", { procurementApproveCeilingAed: 0 })).toBe("/hr");
  });

  it("a grant opens only its own module", () => {
    expect(confinementRedirect("ONSITE", "/crm", { hrAccess: true, procurementSettle: true })).toBe("/events");
  });
});
