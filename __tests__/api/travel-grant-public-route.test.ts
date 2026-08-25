/**
 * Public travel-grant consent route.
 *
 * THE INVARIANT THIS SUITE EXISTS FOR is the ordering one, and it is the kind
 * of bug that passes every local test and is dead in production. `TravelGrant.token`
 * is globally unique and the table is RLS-swept, so a `findUnique({ token })`
 * issued outside the owning tenant's lane returns NOTHING. The org must be
 * resolved from the un-swept Event by host+slug FIRST.
 *
 * Its testable form: **when the org cannot be resolved, the token is never
 * looked up at all.** Reverse the two calls and that test fails.
 *
 * OTHER MUTATIONS TO VERIFY AGAINST:
 *   - Drop the `status: "PENDING"` predicate from the claim -> the
 *     already-answered test fails, and two tabs would both record an answer.
 *   - Snapshot nothing on consent -> the snapshot test fails, and a later
 *     profile edit would rewrite what somebody signed.
 *   - Accept a consent without the tick or the signature -> two tests fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveOrg, loadRow, updateMany, auditCreate, notify, warn, checkRateLimit } = vi.hoisted(
  () => ({
    resolveOrg: vi.fn(),
    loadRow: vi.fn(),
    updateMany: vi.fn(),
    auditCreate: vi.fn().mockResolvedValue({}),
    notify: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn(),
    checkRateLimit: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
  }),
);

vi.mock("@/lib/travel-grant/public", () => ({
  resolveTravelGrantEventOrg: resolveOrg,
  loadTravelGrantForSlug: loadRow,
}));
vi.mock("@/lib/db", () => ({
  db: { travelGrant: { updateMany }, auditLog: { create: auditCreate } },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn() } }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: notify }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({
  checkRateLimit,
  getClientIp: () => "203.0.113.9",
}));

import { GET, POST } from "@/app/api/public/events/[slug]/travel-grant/[token]/route";

const params = Promise.resolve({ slug: "medcon", token: "tok123" });
const req = (body?: unknown) =>
  new Request("https://events.example.com/api/public/events/medcon/travel-grant/tok123", {
    method: body ? "POST" : "GET",
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });

const ROW = {
  id: "tg1",
  eventId: "ev1",
  status: "PENDING" as const,
  signedName: null,
  submittedAt: null,
  countryAtConsent: null,
  speaker: {
    id: "sp1",
    title: null,
    firstName: "Ana",
    lastName: "Silva",
    email: "ana@x.com",
    organization: "Muscat General",
    country: "Oman",
  },
  event: {
    id: "ev1",
    slug: "medcon",
    name: "MedCon",
    organizationId: "org1",
    bannerImage: null,
    bannerImageMobile: null,
    startDate: new Date("2026-10-02"),
    endDate: new Date("2026-10-03"),
    timezone: "Asia/Dubai",
    venue: "Hall A",
    city: "Dubai",
    settings: { travelGrant: { enabled: true } },
    travelGrantTermsHtml: "<p>Our terms.</p>",
    organization: { name: "MM Group" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  resolveOrg.mockResolvedValue("org1");
  loadRow.mockResolvedValue(ROW);
  updateMany.mockResolvedValue({ count: 1 });
});

describe("GET", () => {
  it("returns the terms and the author's name for a valid link", async () => {
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.recipientName).toBe("Ana Silva");
    expect(j.termsHtml).toBe("<p>Our terms.</p>");
    expect(j.event.name).toBe("MedCon");
  });

  it("falls back to the built-in terms when the organizer wrote none", async () => {
    loadRow.mockResolvedValue({ ...ROW, event: { ...ROW.event, travelGrantTermsHtml: "  " } });
    const j = await (await GET(req(), { params })).json();
    expect(j.termsHtml).toContain("not a resident of the United Arab Emirates");
  });

  it("NEVER looks the token up when the org cannot be resolved (the ordering invariant)", async () => {
    resolveOrg.mockResolvedValue(null);
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
    expect(loadRow).not.toHaveBeenCalled();
  });

  it("404s when the organizer has since switched the feature off", async () => {
    loadRow.mockResolvedValue({ ...ROW, event: { ...ROW.event, settings: {} } });
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
  });

  it("429s when rate limited, with Retry-After", async () => {
    checkRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await GET(req(), { params });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

describe("POST", () => {
  it("records a consent and SNAPSHOTS country, name, institution and terms", async () => {
    const res = await POST(
      req({ decision: "consent", confirmedNotUaeResident: true, signedName: "Ana Silva" }),
      { params },
    );
    expect(res.status).toBe(200);

    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "tg1", status: "PENDING" });
    expect(call.data).toMatchObject({
      status: "CONSENTED",
      countryAtConsent: "Oman",
      fullName: "Ana Silva",
      institution: "Muscat General",
      termsSnapshot: "<p>Our terms.</p>",
      signedName: "Ana Silva",
      submittedIp: "203.0.113.9",
    });
  });

  it("audits the consent with the IP, as an AUTHOR action with no userId", async () => {
    await POST(
      req({ decision: "consent", confirmedNotUaeResident: true, signedName: "Ana Silva" }),
      { params },
    );
    const audit = auditCreate.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      action: "TRAVEL_GRANT_CONSENTED",
      entityType: "TravelGrant",
      entityId: "tg1",
      userId: null,
      ipAddress: "203.0.113.9",
    });
    expect(audit.changes).toMatchObject({ actor: "AUTHOR", speakerId: "sp1" });
  });

  it("notifies the organizers on a consent", async () => {
    await POST(
      req({ decision: "consent", confirmedNotUaeResident: true, signedName: "Ana Silva" }),
      { params },
    );
    expect(notify).toHaveBeenCalledWith("ev1", expect.objectContaining({ title: "Travel grant request" }));
  });

  it("records a decline with NO tick and NO signature, and does not notify", async () => {
    const res = await POST(req({ decision: "decline" }), { params });
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ status: "DECLINED" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects a consent with no tick", async () => {
    const res = await POST(req({ decision: "consent", signedName: "Ana Silva" }), { params });
    expect(res.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects a consent with no signature", async () => {
    const res = await POST(
      req({ decision: "consent", confirmedNotUaeResident: true, signedName: "A" }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("409s when the form was already answered, rather than overwriting", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      req({ decision: "consent", confirmedNotUaeResident: true, signedName: "Ana Silva" }),
      { params },
    );
    expect(res.status).toBe(409);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("NEVER looks the token up when the org cannot be resolved", async () => {
    resolveOrg.mockResolvedValue(null);
    const res = await POST(
      req({ decision: "consent", confirmedNotUaeResident: true, signedName: "Ana Silva" }),
      { params },
    );
    expect(res.status).toBe(404);
    expect(loadRow).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses once the organizer switches the feature off", async () => {
    loadRow.mockResolvedValue({ ...ROW, event: { ...ROW.event, settings: {} } });
    const res = await POST(req({ decision: "decline" }), { params });
    expect(res.status).toBe(404);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
