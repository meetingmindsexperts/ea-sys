/**
 * Route tests for the Dinner RSVP fixes from the code review:
 *   M2 — bulk-add `created` must come from createMany's real count, not
 *        `toCreate.length` (skipDuplicates can drop a raced row).
 *   M3 — the public submit is server-authoritative REPLACE-ALL over the
 *        open dinners: it clears the invite's open-dinner responses and
 *        re-creates only the attending ones, so a partial/crafted POST
 *        can't leave ghost attendance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockRateLimit, mockSendEmail, mockGetEventTemplate, mockRenderAndWrap } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    rsvpInvite: { findUnique: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    rsvpDinner: { findMany: vi.fn(), count: vi.fn() },
    rsvpDinnerResponse: { deleteMany: vi.fn(), createMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    user: { findUnique: vi.fn() },
    emailLog: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
  mockSendEmail: vi.fn(),
  mockGetEventTemplate: vi.fn(),
  mockRenderAndWrap: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "127.0.0.1",
  checkRateLimit: mockRateLimit,
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "u1", organizationId: "org1", role: "ADMIN" } }) }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
// Partial mock: sendEmail/getEventTemplate/renderAndWrap/branding stubbed;
// renderMessageValue and friends stay REAL so the M8 token-substitution
// assertion exercises the actual renderer.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendEmail: (...a: unknown[]) => mockSendEmail(...a),
    getEventTemplate: (...a: unknown[]) => mockGetEventTemplate(...a),
    renderAndWrap: (...a: unknown[]) => mockRenderAndWrap(...a),
    brandingFrom: () => ({ email: "from@x.com", name: "From" }),
    brandingCc: () => [],
  };
});

import {
  POST as sendlessInvitesPost,
  GET as rosterGet,
} from "@/app/api/events/[eventId]/rsvp-invites/route";
import { POST as publicSubmit } from "@/app/api/public/events/[slug]/rsvp/[token]/route";
import { POST as dinnersPost } from "@/app/api/events/[eventId]/dinners/route";
import { POST as sendPost } from "@/app/api/events/[eventId]/rsvp-invites/send/route";

const FUTURE = new Date(Date.now() + 7 * 24 * 3600_000);
const PAST = new Date(Date.now() - 24 * 3600_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("GET /rsvp-invites — the roster must return every dinner field the console edits (B2)", () => {
  it("selects location / description / rsvpDeadline, not just { id, name, dinnerAt }", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
    mockDb.rsvpDinner.findMany.mockResolvedValue([]);
    mockDb.rsvpInvite.findMany.mockResolvedValue([]);

    await rosterGet({ url: "http://x/api/events/ev1/rsvp-invites" } as unknown as Request, {
      params: Promise.resolve({ eventId: "ev1" }),
    });

    const select = mockDb.rsvpDinner.findMany.mock.calls[0][0].select;

    // This route is the ONLY source of dinners for the console. When these
    // fields weren't selected they arrived as `undefined`, the edit dialog
    // showed them blank, and Save wrote them back as ""/null — which the PUT
    // reads as an explicit CLEAR. Editing a dinner's NAME wiped its venue,
    // its description and its RSVP DEADLINE (so RSVP never closed again).
    expect(select.location).toBe(true);
    expect(select.description).toBe(true);
    expect(select.rsvpDeadline).toBe(true);
  });
});

// ── M2 ──────────────────────────────────────────────────────────────
describe("POST /rsvp-invites — created count is the DB's real insert count (M2)", () => {
  it("reports createMany.count, not toCreate.length, when skipDuplicates drops a row", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
    mockDb.rsvpInvite.findMany.mockResolvedValue([]); // none already invited
    // Two new invitees pass the pre-check but the DB only inserts one (a raced dup).
    mockDb.rsvpInvite.createMany.mockResolvedValue({ count: 1 });

    const req = {
      headers: new Headers(),
      json: async () => ({
        invitees: [
          { name: "A", email: "a@x.com" },
          { name: "B", email: "b@x.com" },
        ],
      }),
    } as unknown as Request;

    const res = await sendlessInvitesPost(req, { params: Promise.resolve({ eventId: "ev1" }) });
    const body = await res.json();
    expect(body.created).toBe(1); // NOT 2
    expect(body.skipped).toBe(1); // 2 deduped - 1 created
  });
});

// ── M3 ──────────────────────────────────────────────────────────────
describe("POST public rsvp — server-authoritative replace-all over open dinners (M3)", () => {
  function wireInvite() {
    mockDb.rsvpInvite.findUnique.mockResolvedValue({
      id: "inv1",
      eventId: "ev1",
      inviteeName: "Jane",
      inviteeEmail: "jane@x.com",
      dietary: null,
      status: "RESPONDED",
      event: { slug: "gala", name: "Gala", bannerImage: null, bannerImageMobile: null, startDate: new Date(), endDate: new Date() },
      responses: [{ dinnerId: "A", attending: true, guestCount: 1 }],
    });
    // Dinners A and B both open (no deadline, dinner in the future — since
    // R2 M1 a deadline-less dinner closes when the dinner starts).
    mockDb.rsvpDinner.findMany.mockResolvedValue([
      { id: "A", rsvpDeadline: null, dinnerAt: FUTURE },
      { id: "B", rsvpDeadline: null, dinnerAt: FUTURE },
    ]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "inv1" }]), // FOR UPDATE row lock
      rsvpDinnerResponse: { deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
      rsvpInvite: { update: vi.fn().mockResolvedValue({}) },
    };
    mockDb.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
    return tx;
  }

  it("clears all open-dinner responses, then recreates only the attending ones", async () => {
    const tx = wireInvite();
    // Submit: attending B only; A omitted-as-not-attending. Previously A was attending.
    const req = {
      headers: new Headers(),
      json: async () => ({
        dietary: "veg",
        dinners: [
          { dinnerId: "A", attending: false, guestCount: 0 },
          { dinnerId: "B", attending: true, guestCount: 3 },
        ],
      }),
    } as unknown as Request;

    const res = await publicSubmit(req, { params: Promise.resolve({ slug: "gala", token: "tok" }) });
    expect((await res.json()).ok).toBe(true);

    // Serializes concurrent submits via a FOR UPDATE row lock on the invite.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);

    // Deletes responses for ALL open dinners (A + B) — clears the stale A.
    expect(tx.rsvpDinnerResponse.deleteMany).toHaveBeenCalledTimes(1);
    const delArg = tx.rsvpDinnerResponse.deleteMany.mock.calls[0][0];
    expect(delArg.where.inviteId).toBe("inv1");
    expect(delArg.where.dinnerId.in.sort()).toEqual(["A", "B"]);

    // Recreates ONLY the attending dinner (B), not the declined A.
    expect(tx.rsvpDinnerResponse.createMany).toHaveBeenCalledTimes(1);
    expect(tx.rsvpDinnerResponse.createMany.mock.calls[0][0].data).toEqual([
      { inviteId: "inv1", dinnerId: "B", attending: true, guestCount: 3 },
    ]);
    expect(tx.rsvpInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RESPONDED", dietary: "veg" }) }),
    );
  });

  it("declining every dinner clears responses and creates none", async () => {
    const tx = wireInvite();
    const req = {
      headers: new Headers(),
      json: async () => ({
        dinners: [
          { dinnerId: "A", attending: false, guestCount: 0 },
          { dinnerId: "B", attending: false, guestCount: 0 },
        ],
      }),
    } as unknown as Request;

    const res = await publicSubmit(req, { params: Promise.resolve({ slug: "gala", token: "tok" }) });
    expect((await res.json()).ok).toBe(true);
    expect(tx.rsvpDinnerResponse.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.rsvpDinnerResponse.createMany).not.toHaveBeenCalled(); // nothing attending
    expect(tx.rsvpInvite.update).toHaveBeenCalled();
  });

  // ── R2 M1 — a deadline-less dinner closes when the dinner starts ────
  it("a dinner with no deadline whose start has passed is CLOSED — its answer is ignored and reported", async () => {
    const tx = wireInvite();
    // A already happened (no deadline); B still open.
    mockDb.rsvpDinner.findMany.mockResolvedValue([
      { id: "A", rsvpDeadline: null, dinnerAt: PAST },
      { id: "B", rsvpDeadline: null, dinnerAt: FUTURE },
    ]);
    const req = {
      headers: new Headers(),
      json: async () => ({
        dinners: [
          { dinnerId: "A", attending: true, guestCount: 2 }, // closed — must be ignored
          { dinnerId: "B", attending: true, guestCount: 1 },
        ],
      }),
    } as unknown as Request;

    const res = await publicSubmit(req, { params: Promise.resolve({ slug: "gala", token: "tok" }) });
    const body = await res.json();
    expect(body.ok).toBe(true);
    // R2 M2: the dropped answer is REPORTED, not silently swallowed.
    expect(body.ignoredDinnerIds).toEqual(["A"]);
    // The replace-all only touches the open dinner.
    expect(tx.rsvpDinnerResponse.deleteMany.mock.calls[0][0].where.dinnerId.in).toEqual(["B"]);
    expect(tx.rsvpDinnerResponse.createMany.mock.calls[0][0].data).toEqual([
      { inviteId: "inv1", dinnerId: "B", attending: true, guestCount: 1 },
    ]);
  });

  // ── R2 M3 — a stale form addressing ZERO open dinners is rejected ───
  it("409 STALE_FORM when the payload addresses no open dinner (open dinners exist) — no destructive replace", async () => {
    const tx = wireInvite();
    // The form was loaded before B existed; A has since closed.
    mockDb.rsvpDinner.findMany.mockResolvedValue([
      { id: "A", rsvpDeadline: PAST, dinnerAt: FUTURE },
      { id: "B", rsvpDeadline: null, dinnerAt: FUTURE },
    ]);
    const req = {
      headers: new Headers(),
      json: async () => ({
        dinners: [{ dinnerId: "A", attending: true, guestCount: 0 }],
      }),
    } as unknown as Request;

    const res = await publicSubmit(req, { params: Promise.resolve({ slug: "gala", token: "tok" }) });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STALE_FORM");
    // The concurrent tab's answers on B are untouched; the invite is not
    // stamped RESPONDED.
    expect(tx.rsvpDinnerResponse.deleteMany).not.toHaveBeenCalled();
    expect(tx.rsvpInvite.update).not.toHaveBeenCalled();
  });

  it("400 all-closed when every dinner is closed", async () => {
    wireInvite();
    mockDb.rsvpDinner.findMany.mockResolvedValue([
      { id: "A", rsvpDeadline: null, dinnerAt: PAST },
    ]);
    const req = {
      headers: new Headers(),
      json: async () => ({ dinners: [{ dinnerId: "A", attending: true, guestCount: 0 }] }),
    } as unknown as Request;
    const res = await publicSubmit(req, { params: Promise.resolve({ slug: "gala", token: "tok" }) });
    expect(res.status).toBe(400);
  });

  // ── R2 M10 — the public submit leaves an audit trail ────────────────
  it("writes a fire-and-forget AuditLog row with before→after + IP", async () => {
    wireInvite();
    const req = {
      headers: new Headers(),
      json: async () => ({
        dinners: [{ dinnerId: "B", attending: true, guestCount: 2 }],
      }),
    } as unknown as Request;

    const res = await publicSubmit(req, { params: Promise.resolve({ slug: "gala", token: "tok" }) });
    expect((await res.json()).ok).toBe(true);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("RESPOND");
    expect(audit.entityType).toBe("RSVP_INVITE");
    expect(audit.userId).toBeNull();
    expect(audit.ipAddress).toBe("127.0.0.1");
    expect(audit.changes.before).toEqual([{ dinnerId: "A", attending: true, guestCount: 1 }]);
    expect(audit.changes.after).toEqual([{ dinnerId: "B", attending: true, guestCount: 2 }]);
  });
});

// ── R2 L7 — RSVP deadline cannot be after the dinner itself ──────────
describe("POST /dinners — cross-field deadline validation (R2 L7)", () => {
  it("400 DEADLINE_AFTER_DINNER when rsvpDeadline > dinnerAt", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
    const req = {
      headers: new Headers(),
      json: async () => ({
        name: "Gala",
        dinnerAt: FUTURE.toISOString(),
        rsvpDeadline: new Date(FUTURE.getTime() + 3600_000).toISOString(),
      }),
    } as unknown as Request;
    const res = await dinnersPost(req, { params: Promise.resolve({ eventId: "ev1" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("DEADLINE_AFTER_DINNER");
  });
});

// ── R2 M6/M8/L15 — the send route's retry-safety + message tokens ─────
describe("POST /rsvp-invites/send — batch retry-safety + message tokens (R2 M6/M8/L15)", () => {
  function wireSend() {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1",
      name: "Gala",
      slug: "gala",
      organization: { name: "MMG" },
    });
    mockDb.rsvpInvite.findMany.mockResolvedValue([
      { id: "i1", inviteeName: "Alice A", inviteeEmail: "a@x.com", token: "tokA" },
      { id: "i2", inviteeName: "Bob B", inviteeEmail: "b@x.com", token: "tokB" },
    ]);
    mockDb.user.findUnique.mockResolvedValue({ firstName: "Org", lastName: "Anizer", emailSignature: null });
    mockDb.rsvpDinner.count.mockResolvedValue(2);
    mockDb.emailLog.findMany.mockResolvedValue([]);
    mockGetEventTemplate.mockResolvedValue({
      subject: "You're invited",
      htmlContent: "<p>{{personalMessage}}</p>",
      textContent: "{{personalMessage}}",
      branding: {},
    });
    mockRenderAndWrap.mockReturnValue({ subject: "S", htmlContent: "<p>H</p>", textContent: "T" });
    mockSendEmail.mockResolvedValue({ success: true });
  }
  const sendReq = (body: Record<string, unknown>) =>
    ({ json: async () => body }) as unknown as Request;

  it("400 NO_DINNERS when the event has no active dinner (L15)", async () => {
    wireSend();
    mockDb.rsvpDinner.count.mockResolvedValue(0);
    const res = await sendPost(sendReq({ target: "all" }), { params: Promise.resolve({ eventId: "ev1" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_DINNERS");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("a batch retry skips invitees already emailed in the last 10 minutes (M6)", async () => {
    wireSend();
    // i1 was mailed successfully moments ago (a crashed/retried batch).
    mockDb.emailLog.findMany.mockResolvedValue([{ entityId: "i1" }]);
    const res = await sendPost(sendReq({ target: "all" }), { params: Promise.resolve({ eventId: "ev1" }) });
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.skippedRecentlyInvited).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sentTo = (mockSendEmail.mock.calls[0][0] as { to: { email: string }[] }).to[0].email;
    expect(sentTo).toBe("b@x.com");
  });

  it("a single-invitee send is an intentional resend — never skipped (M6)", async () => {
    wireSend();
    mockDb.rsvpInvite.findMany.mockResolvedValue([
      { id: "i1", inviteeName: "Alice A", inviteeEmail: "a@x.com", token: "tokA" },
    ]);
    const res = await sendPost(sendReq({ inviteId: "i1" }), { params: Promise.resolve({ eventId: "ev1" }) });
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.skippedRecentlyInvited).toBe(0);
    // The recently-sent lookup is batch-only.
    expect(mockDb.emailLog.findMany).not.toHaveBeenCalled();
  });

  it("tokens typed into the message resolve per recipient (M8) — {{firstName}} becomes the invitee's name", async () => {
    wireSend();
    await sendPost(sendReq({ target: "all", message: "Hi {{firstName}}, dress code is black tie" }), {
      params: Promise.resolve({ eventId: "ev1" }),
    });
    // renderAndWrap received the PRE-RENDERED personalMessage (real
    // renderMessageValue ran) — per recipient.
    const varsA = mockRenderAndWrap.mock.calls[0][1] as Record<string, string>;
    const varsB = mockRenderAndWrap.mock.calls[1][1] as Record<string, string>;
    expect(varsA.personalMessage).toBe("Hi Alice, dress code is black tie");
    expect(varsB.personalMessage).toBe("Hi Bob, dress code is black tie");
  });
});
