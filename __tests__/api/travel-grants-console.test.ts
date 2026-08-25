/**
 * Travel Grants console.
 *
 * THE GUARD THIS SUITE EXISTS FOR. The roster deliberately lists people who
 * must NOT be emailed -- UAE-based authors and authors with no country recorded
 * both appear so a mis-classified person is recoverable (D7) -- directly above
 * a bulk send button (D9).
 *
 * So the reminder must resolve recipients from the GRANT table, never from the
 * rows the console is rendering. A UAE author has no grant row, so a correct
 * implementation cannot reach them; one written against the roster would email
 * every one of them.
 *
 * MUTATIONS TO VERIFY AGAINST:
 *   - Source the reminder from the roster -> the "never emails the ineligible"
 *     test fails.
 *   - Drop the eligibility re-check on a named send -> the refusal test fails,
 *     and passing a UAE speaker's id by hand would email them.
 *   - Drop denyReviewer -> the MEMBER test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { auth, eventFindFirst, grantFindMany, speakerFindMany, grantCreate, sendEmail, warn } =
  vi.hoisted(() => ({
    auth: vi.fn(),
    eventFindFirst: vi.fn(),
    grantFindMany: vi.fn(),
    speakerFindMany: vi.fn(),
    grantCreate: vi.fn(),
    sendEmail: vi.fn().mockResolvedValue({ success: true }),
    warn: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({
  db: {
    event: { findFirst: eventFindFirst },
    abstract: { findMany: vi.fn().mockResolvedValue([]) },
    travelGrant: {
      findMany: grantFindMany,
      create: grantCreate,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    speaker: { findMany: speakerFindMany },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn, error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/email", () => ({
  sendEmail,
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({
    slug: "travel-grant-invitation",
    subject: "s",
    htmlContent: "h",
    textContent: "t",
  }),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  brandingFrom: vi.fn().mockReturnValue({ email: "from@x.com" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/audit-data-transfer", () => ({ recordExport: vi.fn() }));

import { POST, GET } from "@/app/api/events/[eventId]/travel-grants/route";

const params = Promise.resolve({ eventId: "ev1" });
const req = (body?: unknown) =>
  new Request("https://events.example.com/api/events/ev1/travel-grants", {
    method: body ? "POST" : "GET",
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });

const EVENT = {
  id: "ev1",
  slug: "medcon",
  name: "MedCon",
  organizationId: "org1",
  settings: { travelGrant: { enabled: true } },
  travelGrantMessageHtml: "<p>msg</p>",
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  eventFindFirst.mockResolvedValue(EVENT);
  grantFindMany.mockResolvedValue([]);
  speakerFindMany.mockResolvedValue([]);
  sendEmail.mockResolvedValue({ success: true });
});

describe("access", () => {
  it("401s without a session", async () => {
    auth.mockResolvedValue(null);
    expect((await GET(req(), { params })).status).toBe(401);
  });

  it("refuses MEMBER, who may read the org but not this list", async () => {
    auth.mockResolvedValue({ user: { id: "u2", role: "MEMBER", organizationId: "org1" } });
    const res = await GET(req(), { params });
    expect(res.status).toBe(403);
  });

  it("404s on an event the caller cannot reach", async () => {
    eventFindFirst.mockResolvedValue(null);
    expect((await GET(req(), { params })).status).toBe(404);
  });
});

describe("remind everyone pending (D9)", () => {
  it("resolves recipients from the GRANT table, so it can never email an ineligible author", async () => {
    grantFindMany.mockResolvedValue([
      {
        id: "g1",
        token: "tok1",
        status: "PENDING",
        speakerId: "sp1",
        speaker: { title: null, firstName: "Ana", lastName: "Silva", email: "ana@x.com" },
      },
    ]);

    const res = await POST(req({ target: "pending" }), { params });
    expect(res.status).toBe(200);

    // The query is the guard: PENDING grants on this event, nothing else.
    expect(grantFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { eventId: "ev1", status: "PENDING" } }),
    );
    // The roster query is never used to pick recipients.
    expect(speakerFindMany).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to[0].email).toBe("ana@x.com");
  });

  it("sends to nobody when nothing is pending", async () => {
    grantFindMany.mockResolvedValue([]);
    const res = await POST(req({ target: "pending" }), { params });
    expect((await res.json()).sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a pending grant whose author has no email, rather than throwing", async () => {
    grantFindMany.mockResolvedValue([
      { id: "g1", token: "t", status: "PENDING", speakerId: "sp1", speaker: { title: null, firstName: "A", lastName: "B", email: null } },
    ]);
    const res = await POST(req({ target: "pending" }), { params });
    expect((await res.json()).sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("per-row send", () => {
  it("REFUSES a named speaker who is not eligible, even though the console lists them", async () => {
    speakerFindMany.mockResolvedValue([
      {
        id: "sp9",
        title: null,
        firstName: "Omar",
        lastName: "Hassan",
        email: "omar@x.com",
        country: "United Arab Emirates",
        travelGrant: null,
      },
    ]);
    const res = await POST(req({ speakerIds: ["sp9"] }), { params });
    const j = await res.json();
    expect(j.sent).toBe(0);
    expect(j.skippedNotEligible).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(grantCreate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ speakerId: "sp9" }),
      "travel-grant-send:refused-not-eligible",
    );
  });

  it("refuses an author with no country recorded", async () => {
    speakerFindMany.mockResolvedValue([
      { id: "sp8", title: null, firstName: "A", lastName: "B", email: "a@x.com", country: null, travelGrant: null },
    ]);
    const j = await (await POST(req({ speakerIds: ["sp8"] }), { params })).json();
    expect(j.skippedNotEligible).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("MINTS a grant for an eligible author who never had one (the corrected-country path)", async () => {
    speakerFindMany.mockResolvedValue([
      { id: "sp1", title: null, firstName: "Ana", lastName: "Silva", email: "ana@x.com", country: "Oman", travelGrant: null },
    ]);
    grantCreate.mockResolvedValue({ id: "g9", token: "tok9", status: "PENDING" });

    const j = await (await POST(req({ speakerIds: ["sp1"] }), { params })).json();
    expect(grantCreate).toHaveBeenCalledTimes(1);
    expect(j.sent).toBe(1);
  });

  it("reuses an existing grant rather than minting a second (D2)", async () => {
    speakerFindMany.mockResolvedValue([
      {
        id: "sp1", title: null, firstName: "Ana", lastName: "Silva", email: "ana@x.com", country: "Oman",
        travelGrant: { id: "g1", token: "tok1", status: "PENDING" },
      },
    ]);
    const j = await (await POST(req({ speakerIds: ["sp1"] }), { params })).json();
    expect(grantCreate).not.toHaveBeenCalled();
    expect(j.sent).toBe(1);
  });

  it("counts a send failure rather than aborting the batch", async () => {
    speakerFindMany.mockResolvedValue([
      { id: "sp1", title: null, firstName: "A", lastName: "B", email: "a@x.com", country: "Oman", travelGrant: { id: "g1", token: "t", status: "PENDING" } },
      { id: "sp2", title: null, firstName: "C", lastName: "D", email: "c@x.com", country: "Egypt", travelGrant: { id: "g2", token: "t2", status: "PENDING" } },
    ]);
    sendEmail.mockResolvedValueOnce({ success: false, error: "bounced" }).mockResolvedValueOnce({ success: true });
    const j = await (await POST(req({ speakerIds: ["sp1", "sp2"] }), { params })).json();
    expect(j.failed).toBe(1);
    expect(j.sent).toBe(1);
  });

  it("refuses to send at all when the feature is switched off", async () => {
    eventFindFirst.mockResolvedValue({ ...EVENT, settings: {} });
    const res = await POST(req({ speakerIds: ["sp1"] }), { params });
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects a body asking for both named speakers and everyone pending", async () => {
    const res = await POST(req({ speakerIds: ["sp1"], target: "pending" }), { params });
    expect(res.status).toBe(400);
  });
});
