/**
 * GET /api/events/[eventId]/email-activity — the team/user email rollup.
 *
 * Pins (denyReviewer stays REAL so we prove the route calls the real guard):
 *   - 401 with no session, 403 for restricted roles INCLUDING MEMBER/ONSITE
 *     (this surface exposes recipient+subject+sender — admin/organizer only),
 *   - 404 when the event isn't in the caller's org (no cross-org leak),
 *   - ADMIN happy path: org-scoped event lookup, per-sender summary folds
 *     SENT/FAILED and resolves names + the null-sender "System" bucket,
 *   - filter params thread into the row query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    emailLog: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    user: { findMany: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// denyReviewer stays REAL.

import { GET } from "@/app/api/events/[eventId]/email-activity/route";

const ADMIN = { id: "u-adm", role: "ADMIN", organizationId: "org1" };
const params = { params: Promise.resolve({ eventId: "ev1" }) };
const url = (qs = "") => new Request(`http://localhost/api/events/ev1/email-activity${qs}`);

function rowsFindManyWhere() {
  // The rows query is the findMany call WITHOUT `distinct` (templates uses it).
  const call = mockDb.emailLog.findMany.mock.calls.find((c) => !c[0]?.distinct);
  return call?.[0]?.where as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
  mockDb.emailLog.count.mockResolvedValue(4);
  mockDb.emailLog.findMany.mockImplementation(async (args: { distinct?: unknown }) => {
    if (args?.distinct) {
      return [{ templateSlug: "speaker-invitation" }, { templateSlug: "payment-reminder" }];
    }
    return [
      {
        id: "e1",
        to: "a@b.c",
        subject: "Hi",
        templateSlug: "speaker-invitation",
        status: "SENT",
        errorMessage: null,
        htmlBody: "<p>hi</p>",
        createdAt: new Date(),
        triggeredBy: { id: "u1", firstName: "Krishna", lastName: "P", email: "k@x.com" },
      },
      {
        id: "e2",
        to: "c@d.e",
        subject: "Bye",
        templateSlug: null,
        status: "FAILED",
        errorMessage: "bounced",
        htmlBody: null,
        createdAt: new Date(),
        triggeredBy: null,
      },
    ];
  });
  mockDb.emailLog.groupBy.mockResolvedValue([
    { triggeredByUserId: "u1", status: "SENT", _count: { _all: 3 } },
    { triggeredByUserId: "u1", status: "FAILED", _count: { _all: 1 } },
    { triggeredByUserId: null, status: "SENT", _count: { _all: 2 } },
  ]);
  mockDb.user.findMany.mockResolvedValue([
    { id: "u1", firstName: "Krishna", lastName: "P", email: "k@x.com" },
  ]);
});

describe("email-activity GET — access", () => {
  it("401 without a session", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(url(), params);
    expect(res.status).toBe(401);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("403 for a REVIEWER (denyReviewer real)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-r", role: "REVIEWER", organizationId: null } });
    const res = await GET(url(), params);
    expect(res.status).toBe(403);
    expect(mockDb.event.findFirst).not.toHaveBeenCalled();
  });

  it("403 for MEMBER — this surface is admin/organizer only", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-m", role: "MEMBER", organizationId: "org1" } });
    const res = await GET(url(), params);
    expect(res.status).toBe(403);
  });

  it("403 for ONSITE desk staff", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-o", role: "ONSITE", organizationId: "org1" } });
    const res = await GET(url(), params);
    expect(res.status).toBe(403);
  });

  it("404 when the event is not in the caller's org (no cross-org leak)", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    mockDb.event.findFirst.mockResolvedValue(null);
    const res = await GET(url(), params);
    expect(res.status).toBe(404);
    expect(mockDb.event.findFirst.mock.calls.at(-1)?.[0]?.where).toMatchObject({
      id: "ev1",
      organizationId: "org1",
    });
  });
});

describe("email-activity GET — payload", () => {
  it("ADMIN happy path: rows carry hasBody, summary folds per sender + system bucket", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    const res = await GET(url(), params);
    expect(res.status).toBe(200);
    const body = await res.json();

    // hasBody derived from htmlBody presence; raw htmlBody never leaks.
    expect(body.rows[0]).toMatchObject({ id: "e1", hasBody: true });
    expect(body.rows[1]).toMatchObject({ id: "e2", hasBody: false });
    expect(body.rows[0]).not.toHaveProperty("htmlBody");

    // Per-sender summary: u1 = 3 sent + 1 failed with a resolved name; the
    // null-sender group folds into a "System / automated" bucket.
    const krishna = body.summary.find((s: { userId: string | null }) => s.userId === "u1");
    expect(krishna).toMatchObject({ name: "Krishna P", sent: 3, failed: 1 });
    const system = body.summary.find((s: { userId: string | null }) => s.userId === null);
    expect(system).toMatchObject({ name: "System / automated", sent: 2, failed: 0 });

    // Sender dropdown options exclude the null bucket; templates surface real slugs.
    expect(body.senderOptions).toEqual([{ id: "u1", name: "Krishna P" }]);
    expect(body.templateOptions).toContain("speaker-invitation");
    expect(body.total).toBe(4);
  });

  it("threads sender/status/template/search filters into the row query", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    await GET(url("?senderId=u1&status=FAILED&templateSlug=payment-reminder&q=abbott"), params);
    const where = rowsFindManyWhere();
    expect(where).toMatchObject({
      eventId: "ev1",
      triggeredByUserId: "u1",
      status: "FAILED",
      templateSlug: "payment-reminder",
      OR: [
        { to: { contains: "abbott", mode: "insensitive" } },
        { cc: { contains: "abbott", mode: "insensitive" } },
        { bcc: { contains: "abbott", mode: "insensitive" } },
        { subject: { contains: "abbott", mode: "insensitive" } },
      ],
    });
    // The summary groupBy is intentionally NOT sender-filtered (stable board).
    expect(mockDb.emailLog.groupBy.mock.calls.at(-1)?.[0]?.where).toEqual({ eventId: "ev1" });
  });

  it("the status filter means what the badge says: Sent is 'no report yet', the rest are the mail service's reports (Nov 19, 2026)", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    const whereFor = async (status: string) => {
      mockDb.emailLog.findMany.mockClear();
      const res = await GET(url(`?status=${status}`), params);
      expect(res.status).toBe(200);
      return rowsFindManyWhere();
    };

    expect(await whereFor("SENT")).toMatchObject({ status: "SENT", deliveryStatus: null });
    expect(await whereFor("DELIVERED")).toMatchObject({ status: "SENT", deliveryStatus: "DELIVERED" });
    expect(await whereFor("BOUNCED")).toMatchObject({ status: "SENT", deliveryStatus: "BOUNCED" });
    expect(await whereFor("COMPLAINED")).toMatchObject({ status: "SENT", deliveryStatus: "COMPLAINED" });
    const failed = await whereFor("FAILED");
    expect(failed).toMatchObject({ status: "FAILED" });
    expect(failed).not.toHaveProperty("deliveryStatus");

    expect((await GET(url("?status=OPENED"), params)).status).toBe(400);
  });

  it("counts delivered, bounced and marked-as-spam beside sent, per sender, and never in place of it", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    mockDb.emailLog.groupBy.mockResolvedValue([
      { triggeredByUserId: "u1", status: "SENT", deliveryStatus: null, _count: { _all: 2 } },
      { triggeredByUserId: "u1", status: "SENT", deliveryStatus: "DELIVERED", _count: { _all: 5 } },
      { triggeredByUserId: "u1", status: "SENT", deliveryStatus: "BOUNCED", _count: { _all: 1 } },
      { triggeredByUserId: "u1", status: "FAILED", deliveryStatus: null, _count: { _all: 1 } },
      { triggeredByUserId: null, status: "SENT", deliveryStatus: "COMPLAINED", _count: { _all: 1 } },
    ]);

    const body = await (await GET(url(), params)).json();

    expect(mockDb.emailLog.groupBy.mock.calls.at(-1)?.[0]?.by).toEqual(["triggeredByUserId", "status", "deliveryStatus"]);
    const krishna = body.summary.find((s: { userId: string | null }) => s.userId === "u1");
    expect(krishna).toMatchObject({ sent: 8, failed: 1, delivered: 5, bounced: 1, complained: 0 });
    const system = body.summary.find((s: { userId: string | null }) => s.userId === null);
    expect(system).toMatchObject({ sent: 1, failed: 0, delivered: 0, bounced: 0, complained: 1 });
  });

  it("the rows query reads the mail service's report for each email", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    await GET(url(), params);
    const select = mockDb.emailLog.findMany.mock.calls.find((c) => c[0]?.skip !== undefined)?.[0]?.select ?? {};
    expect(select).toMatchObject({ deliveryStatus: true, deliveryAt: true, bounceType: true, bounceSubType: true, deliveryDetail: true });
  });

  it("the rows query reads who was copied, cc and bcc, for the line under To (Nov 12, 2026)", async () => {
    mockAuth.mockResolvedValue({ user: ADMIN });
    await GET(url(), params);
    const call = mockDb.emailLog.findMany.mock.calls.find((c) => !c[0]?.distinct);
    expect(call?.[0]?.select).toMatchObject({ to: true, cc: true, bcc: true });
  });
});
