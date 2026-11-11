/**
 * GET /api/events/[eventId]/certificates/recipients?view=people: the
 * Recipients tab's one request (everyone at the event, a cell per
 * certificate). Same guard as the report it sits beside; the loader is faked
 * here and proven on Postgres in tests/integration-db.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  eventFindFirst: vi.fn(),
  people: vi.fn(),
  report: vi.fn(),
  recordExport: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: h.warn, debug: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: () => h.auth() }));
vi.mock("@/lib/db", () => ({ db: { event: { findFirst: (...a: unknown[]) => h.eventFindFirst(...a) } } }));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: (...a: unknown[]) => h.recordExport(...a) }));
vi.mock("@/lib/certificates/recipients-report", () => ({
  loadCertificatePeople: (...a: unknown[]) => h.people(...a),
  loadRecipientReport: (...a: unknown[]) => h.report(...a),
  recipientReportCsv: () => [["Certificate"]],
}));

import { GET } from "@/app/api/events/[eventId]/certificates/recipients/route";

const session = (role: string, organizationId: string | null = "org-1") => ({ user: { id: "user-1", role, organizationId } });
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const get = (query: string) => GET(new Request(`http://localhost/api/events/evt-1/certificates/recipients${query}`), params);

const EVENT = { id: "evt-1", slug: "evt", timezone: "Asia/Dubai", cmeHours: null };
const PEOPLE = { timezone: "Asia/Dubai", templates: [], registrations: [{ id: "r1", cells: {} }], speakers: [] };

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  h.auth.mockResolvedValue(session("ADMIN"));
  h.eventFindFirst.mockResolvedValue(EVENT);
  h.people.mockResolvedValue(PEOPLE);
  h.report.mockResolvedValue({ timezone: "Asia/Dubai", templates: [], rows: [], answeredNotAssigned: [] });
});

describe("GET recipients?view=people", () => {
  it("returns everyone at the event, from the people loader and nothing else", async () => {
    const res = await get("?view=people");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PEOPLE);
    expect(h.people).toHaveBeenCalledWith(EVENT);
    expect(h.report).not.toHaveBeenCalled();
    // Looking at the screen is not an export.
    expect(h.recordExport).not.toHaveBeenCalled();
  });

  it("without the view it is still the per-assignment report", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.people).not.toHaveBeenCalled();
  });

  it("401 without a session", async () => {
    h.auth.mockResolvedValue(null);
    expect((await get("?view=people")).status).toBe(401);
    expect(h.people).not.toHaveBeenCalled();
  });

  it.each(["ONSITE", "REVIEWER", "SUBMITTER", "REGISTRANT", "CRM_USER", "HR_USER"])(
    "403 for %s: reading needs certificates.read",
    async (role) => {
      h.auth.mockResolvedValue(session(role, ["REVIEWER", "SUBMITTER", "REGISTRANT"].includes(role) ? null : "org-1"));
      expect((await get("?view=people")).status).toBe(403);
      expect(h.people).not.toHaveBeenCalled();
    },
  );

  it("404 for an event the caller cannot reach, looked up through their own access", async () => {
    h.eventFindFirst.mockResolvedValue(null);
    expect((await get("?view=people")).status).toBe(404);
    expect(h.eventFindFirst.mock.calls[0][0].where).toMatchObject({ id: "evt-1", organizationId: "org-1" });
    expect(h.people).not.toHaveBeenCalled();
  });
});
