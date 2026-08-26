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

const {
  auth, eventFindFirst, grantFindMany, speakerFindMany, speakerFindFirst, grantCreate, grantFindUnique,
  sendEmail, warn,
} = vi.hoisted(() => ({
    auth: vi.fn(),
    eventFindFirst: vi.fn(),
    grantFindMany: vi.fn(),
    speakerFindMany: vi.fn(),
    speakerFindFirst: vi.fn(),
    grantCreate: vi.fn(),
    grantFindUnique: vi.fn(),
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
      findUnique: grantFindUnique,
      create: grantCreate,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    speaker: { findMany: speakerFindMany, findFirst: speakerFindFirst },
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
  settings: { travelGrant: { enabled: true, homeCountries: ["AE"] } },
  travelGrantMessageHtml: "<p>msg</p>",
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { id: "u1", role: "ADMIN", organizationId: "org1" } });
  eventFindFirst.mockResolvedValue(EVENT);
  grantFindMany.mockResolvedValue([]);
  speakerFindMany.mockResolvedValue([]);
  speakerFindFirst.mockResolvedValue(null);
  grantFindUnique.mockResolvedValue(null);
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

describe("single-speaker mode (the card on a speaker's profile)", () => {
  it("describes a speaker who has NO abstract and NO grant, rather than 404ing", async () => {
    // The reason this does not reuse the roster: the roster is built from
    // abstract authors, so this speaker is absent from it, and the profile card
    // still has to say "eligible, not invited" or "UAE, not eligible".
    speakerFindFirst.mockResolvedValue({
      id: "sp5",
      firstName: "Nina",
      lastName: "Adams",
      email: "nina@x.com",
      organization: "Cairo Uni",
      country: "Egypt",
      _count: { abstracts: 0 },
      travelGrant: null,
    });
    const res = await GET(
      new Request("https://x/api/events/ev1/travel-grants?speakerId=sp5"),
      { params },
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.row).toMatchObject({ speakerId: "sp5", residency: "overseas", abstractCount: 0 });
    expect(j.row.grant).toBeNull();
    expect(j.eventSlug).toBe("medcon");
  });

  it("reports a locally-based speaker as not eligible instead of hiding them", async () => {
    speakerFindFirst.mockResolvedValue({
      id: "sp6", firstName: "Omar", lastName: "Hassan", email: "o@x.com",
      organization: null, country: "United Arab Emirates",
      _count: { abstracts: 1 }, travelGrant: null,
    });
    const j = await (
      await GET(new Request("https://x/api/events/ev1/travel-grants?speakerId=sp6"), { params })
    ).json();
    expect(j.row.residency).toBe("home");
    // The card needs the NAMES to render "United Arab Emirates, not eligible";
    // without them it would fall back to the two-or-more wording on an event
    // that exempts exactly one country.
    expect(j.homeCountries).toEqual(["United Arab Emirates"]);
  });

  it("BINDS eventId in the lookup, so a foreign speakerId cannot be read", async () => {
    // The previous version of this test stubbed the row to null and asserted a
    // 404, which passes whether or not eventId is in the `where` — a mock
    // returns what it was told regardless. Dropping the bind would have let an
    // organizer of event A read another event's speaker, INCLUDING the grant
    // token that the public consent URL is built from. Pin the query shape.
    speakerFindFirst.mockResolvedValue(null);
  grantFindUnique.mockResolvedValue(null);
    const res = await GET(
      new Request("https://x/api/events/ev1/travel-grants?speakerId=nope"),
      { params },
    );
    expect(res.status).toBe(404);
    expect(speakerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "nope", eventId: "ev1" } }),
    );
  });

  it("counts only NON-DRAFT abstracts, matching the roster's contract", async () => {
    speakerFindFirst.mockResolvedValue({
      id: "sp7", firstName: "Lea", lastName: "Roy", email: "l@x.com",
      organization: null, country: "France", _count: { abstracts: 2 }, travelGrant: null,
    });
    await GET(new Request("https://x/api/events/ev1/travel-grants?speakerId=sp7"), { params });
    // The filter is what stops a draft-only author reporting "1 abstract" here
    // while being absent from the console entirely.
    expect(speakerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          _count: { select: { abstracts: { where: { status: { not: "DRAFT" } } } } },
        }),
      }),
    );
  });
});

describe("resend semantics and the mint race", () => {
  it("REFUSES to resend to an author who already consented, instead of sending an empty email", async () => {
    speakerFindMany.mockResolvedValue([
      { id: "sp1", title: null, firstName: "Ana", lastName: "Silva", email: "a@x.com", country: "Oman",
        travelGrant: { id: "g1", token: "t", status: "CONSENTED" } },
    ]);
    const j = await (await POST(req({ speakerIds: ["sp1"] }), { params })).json();
    expect(j.sent).toBe(0);
    expect(j.skippedAlreadyAnswered).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("REFUSES a declined author too", async () => {
    speakerFindMany.mockResolvedValue([
      { id: "sp1", title: null, firstName: "Ana", lastName: "Silva", email: "a@x.com", country: "Oman",
        travelGrant: { id: "g1", token: "t", status: "DECLINED" } },
    ]);
    const j = await (await POST(req({ speakerIds: ["sp1"] }), { params })).json();
    expect(j.skippedAlreadyAnswered).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("survives a lost mint race instead of 500ing the whole batch", async () => {
    // The author submits another abstract at the same moment; that path mints
    // the row first and this create loses on the unique speakerId. Previously
    // the throw escaped the per-recipient try/catch and took every OTHER named
    // speaker in the batch down with it.
    speakerFindMany.mockResolvedValue([
      { id: "sp1", title: null, firstName: "Ana", lastName: "Silva", email: "a@x.com", country: "Oman", travelGrant: null },
      { id: "sp2", title: null, firstName: "Bo", lastName: "Ling", email: "b@x.com", country: "Egypt", travelGrant: null },
    ]);
    grantCreate
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
      .mockResolvedValueOnce({ id: "g2", token: "t2", status: "PENDING" });
    grantFindUnique.mockResolvedValue({ id: "g1", token: "t1", status: "PENDING" });

    const res = await POST(req({ speakerIds: ["sp1", "sp2"] }), { params });
    expect(res.status).toBe(200);
    const j = await res.json();
    // Both still reached: the loser re-read the winner's row.
    expect(j.sent).toBe(2);
  });

  it("counts and logs pending grants whose author has no email", async () => {
    grantFindMany.mockResolvedValue([
      { id: "g1", token: "t", status: "PENDING", speakerId: "sp1",
        speaker: { title: null, firstName: "A", lastName: "B", email: null } },
      { id: "g2", token: "t2", status: "PENDING", speakerId: "sp2",
        speaker: { title: null, firstName: "C", lastName: "D", email: "c@x.com" } },
    ]);
    const j = await (await POST(req({ target: "pending" }), { params })).json();
    expect(j.sent).toBe(1);
    // Previously this was a silent filter: "Remind 2 pending" reported "Sent 1"
    // with nothing anywhere explaining the other one.
    expect(j.skippedNoEmail).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ skippedNoEmail: 1 }),
      "travel-grant-send:pending-without-email",
    );
  });
});
