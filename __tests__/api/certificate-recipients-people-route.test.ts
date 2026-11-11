/**
 * GET /api/events/[eventId]/certificates/recipients?view=people: the
 * Recipients tab's one request (everyone at the event, a cell per
 * certificate). Same guard as the report it sits beside; the loader is faked
 * here and proven on Postgres in tests/integration-db.
 *
 * What the route itself decides, with the REAL permission tables: whether
 * this caller is shown everyone, or only the people already on a list.
 * certificates.read is its own key, and it must not hand out the event's
 * attendee list (review of a5134945).
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
import { getTenantOrgId } from "@/lib/tenant-context";

const session = (role: string, organizationId: string | null = "org-1", grants: string[] = []) => ({
  // A custom role's keys ride the session as `procurementPermissions` (session-permissions.ts).
  user: { id: "user-1", role, organizationId, procurementPermissions: grants },
});
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
const get = (query: string) => GET(new Request(`http://localhost/api/events/evt-1/certificates/recipients${query}`), params);

const EVENT = {
  id: "evt-1",
  slug: "evt",
  timezone: "Asia/Dubai",
  cmeHours: null,
  organizationId: "org-1",
  eventType: "CONFERENCE",
  staffAssignments: [],
};
const PEOPLE = {
  timezone: "Asia/Dubai",
  templates: [],
  registrations: [{ id: "r1", cells: {} }],
  speakers: [],
  everyone: { registrations: true, speakers: true },
};
const ALL_ACCESS = { registrations: true, speakers: true, submissions: { abstracts: true, proposals: true } };

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  h.auth.mockResolvedValue(session("ADMIN"));
  h.eventFindFirst.mockResolvedValue(EVENT);
  h.people.mockResolvedValue(PEOPLE);
  h.report.mockResolvedValue({ timezone: "Asia/Dubai", templates: [], rows: [], answeredNotAssigned: [] });
});

describe("GET recipients?view=people", () => {
  it("an admin is shown everyone, from the people loader and nothing else", async () => {
    const res = await get("?view=people");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PEOPLE);
    expect(h.people).toHaveBeenCalledWith(EVENT, ALL_ACCESS);
    expect(h.report).not.toHaveBeenCalled();
    // Looking at the screen is not an export.
    expect(h.recordExport).not.toHaveBeenCalled();
  });

  it("an organiser too, and the loader runs inside the organisation's tenant lane", async () => {
    h.auth.mockResolvedValue(session("ORGANIZER"));
    let lane: string | null | undefined;
    h.people.mockImplementation(async () => {
      lane = getTenantOrgId();
      return PEOPLE;
    });
    expect((await get("?view=people")).status).toBe(200);
    expect(h.people.mock.calls[0][1]).toEqual(ALL_ACCESS);
    expect(lane).toBe("org-1");
  });

  it("certificates.read ALONE does not open the attendee or the speaker list", async () => {
    // A custom role on the empty base role: it may open Certificates, and nothing else.
    h.auth.mockResolvedValue(session("BASE", "org-1", ["certificates.read@ALL"]));
    const res = await get("?view=people");
    expect(res.status).toBe(200);
    expect(h.people.mock.calls[0][1]).toEqual({
      registrations: false,
      speakers: false,
      submissions: { abstracts: false, proposals: false },
    });
  });

  it("each list is opened by its own key, and the abstract and proposal keys decide what a speaker's group may say", async () => {
    h.auth.mockResolvedValue(session("BASE", "org-1", ["certificates.read@ALL", "registrations.read@ALL"]));
    await get("?view=people");
    expect(h.people.mock.calls[0][1]).toMatchObject({ registrations: true, speakers: false });

    h.people.mockClear();
    h.auth.mockResolvedValue(session("BASE", "org-1", ["certificates.read@ALL", "speakers.read@ALL", "abstracts.read@ALL"]));
    await get("?view=people");
    expect(h.people.mock.calls[0][1]).toEqual({
      registrations: false,
      speakers: true,
      submissions: { abstracts: true, proposals: false },
    });
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

  it.each(["ONSITE", "CRM_USER", "HR_USER"])("403 for %s: an organisation role without certificates.read", async (role) => {
    h.auth.mockResolvedValue(session(role));
    expect((await get("?view=people")).status).toBe(403);
    expect(h.people).not.toHaveBeenCalled();
  });

  it("a key scoped to assigned events does not open the list on an event the person is not assigned", async () => {
    h.auth.mockResolvedValue(session("BASE", "org-1", ["certificates.read@ALL", "registrations.read@ASSIGNED"]));
    await get("?view=people");
    expect(h.people.mock.calls[0][1]).toMatchObject({ registrations: false });

    h.people.mockClear();
    h.eventFindFirst.mockResolvedValue({ ...EVENT, staffAssignments: [{ userId: "user-1" }] });
    await get("?view=people");
    expect(h.people.mock.calls[0][1]).toMatchObject({ registrations: true });
  });

  it("403 for a custom role that holds the registrations key but not the certificates one", async () => {
    h.auth.mockResolvedValue(session("BASE", "org-1", ["registrations.read@ALL", "speakers.read@ALL"]));
    expect((await get("?view=people")).status).toBe(403);
    expect(h.people).not.toHaveBeenCalled();
  });

  it.each(["REVIEWER", "SUBMITTER", "REGISTRANT"])("403 for %s: no organisation at all", async (role) => {
    h.auth.mockResolvedValue(session(role, null));
    expect((await get("?view=people")).status).toBe(403);
    expect(h.people).not.toHaveBeenCalled();
  });

  it("404 for an event the caller cannot reach, looked up through their own access", async () => {
    h.eventFindFirst.mockResolvedValue(null);
    expect((await get("?view=people")).status).toBe(404);
    expect(h.eventFindFirst.mock.calls[0][0].where).toMatchObject({ id: "evt-1", organizationId: "org-1" });
    expect(h.people).not.toHaveBeenCalled();
  });
});
