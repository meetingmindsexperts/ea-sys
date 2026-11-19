/**
 * Send to all (Nov 10, 2026): the one reviewer invitation to everyone on the
 * event's pool, through the same sender as the row's Send button.
 *
 * The route sends for 30 seconds per request and answers where to carry on
 * (nginx cuts a response at 60); the page chains the requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, mockAuth, sendSpy, rateLimit, logger, resolveFiles } = vi.hoisted(() => ({
  resolveFiles: vi.fn(),
  mockDb: {
    event: { findFirst: vi.fn() },
    user: { findMany: vi.fn() },
    auditLog: { create: vi.fn().mockReturnValue({ catch: () => {} }) },
  },
  mockAuth: vi.fn(),
  sendSpy: vi.fn(),
  rateLimit: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/require-org", () => ({ requireOrgId: () => ({ orgId: "org1" }) }));
vi.mock("@/lib/permissions/require-permission", () => ({
  requirePermission: () => ({ ok: true, principal: { organizationId: "org1", baseRole: "ADMIN", fromApiKey: false }, eventWhere: { id: "ev1", organizationId: "org1" } }),
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));
vi.mock("@/lib/security", () => ({ getClientIp: () => "1.2.3.4", checkRateLimit: rateLimit }));
vi.mock("@/lib/public-brand-server", () => ({ loadPublicBrandForOrg: async () => ({ name: "Meeting Minds Experts" }) }));
vi.mock("@/lib/email-attachments", () => ({ resolveStoredAttachments: resolveFiles }));
vi.mock("@/lib/abstract-reviewer-notify", async () => {
  const actual = await vi.importActual<typeof import("@/lib/abstract-reviewer-notify")>("@/lib/abstract-reviewer-notify");
  return { sendReviewerInvitation: sendSpy, inviterNameOf: actual.inviterNameOf };
});

import { POST } from "@/app/api/events/[eventId]/reviewers/send-invitations/route";

const USERS = ["r1", "r2", "r3"].map((id) => ({ id, email: `${id}@x.com`, firstName: id, lastName: "R", emailVerified: null, role: "REVIEWER" }));
const post = (body: unknown = {}) =>
  POST(new Request("http://x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ eventId: "ev1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ORGANIZER", organizationId: "org1", firstName: "Sarah", lastName: "Ahmed", email: "Sarah@x.com" } });
  resolveFiles.mockResolvedValue({ ok: true, attachments: [] });
  rateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  // r9 was removed from the pool: on the event's list or not at all.
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "MedCon", slug: "medcon", settings: { reviewerUserIds: ["r3", "r1", "r2"] } });
  mockDb.user.findMany.mockImplementation(({ where }: { where: { id: { in: string[]; gt?: string } } }) =>
    Promise.resolve(USERS.filter((u) => where.id.in.includes(u.id) && (!where.id.gt || u.id > where.id.gt))),
  );
  sendSpy.mockResolvedValue({ ok: true, kind: "setup" });
});
afterEach(() => vi.useRealTimers());

describe("POST reviewers/send-invitations", () => {
  it("emails everyone on the pool, in id order, through the one sender", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ emailed: 3, failed: 0, remaining: 0, nextAfter: null });
    expect(mockDb.user.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["r3", "r1", "r2"] } }, orderBy: { id: "asc" } });
    expect(sendSpy.mock.calls.map(([a]) => a.reviewer.id)).toEqual(["r1", "r2", "r3"]);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      eventId: "ev1", organizationId: "org1", eventName: "MedCon", eventSlug: "medcon",
      organizationName: "Meeting Minds Experts", inviterName: "Sarah Ahmed", triggeredByUserId: "admin1",
    });
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.sendInvitations).toMatchObject({ emailed: 3, failed: 0, remaining: 0 });
  });

  it("carries on after the cursor", async () => {
    await post({ after: "r1" });
    expect(sendSpy.mock.calls.map(([a]) => a.reviewer.id)).toEqual(["r2", "r3"]);
  });

  it("one failure does not stop the rest, and its reason is answered and logged", async () => {
    sendSpy.mockResolvedValueOnce({ ok: false, code: "SEND_FAILED", message: "The template has an unknown token" });
    const body = await (await post()).json();
    expect(body).toMatchObject({ emailed: 2, failed: 1 });
    expect(body.results[0]).toEqual({ reviewerId: "r1", ok: false, message: "The template has an unknown token" });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitations-send:some-failed" }));
  });

  it("stops after its 30 seconds and says where to carry on", async () => {
    vi.useFakeTimers();
    sendSpy.mockImplementation(async () => {
      vi.advanceTimersByTime(31_000);
      return { ok: true, kind: "portal" };
    });
    const body = await (await post()).json();
    // The first is always attempted, so the cursor moves on every request.
    expect(body).toMatchObject({ emailed: 1, remaining: 2, nextAfter: "r1" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("an empty pool sends nothing", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", name: "MedCon", slug: "medcon", settings: {} });
    expect(await (await post()).json()).toMatchObject({ emailed: 0, failed: 0, remaining: 0, nextAfter: null });
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, an empty list of names or an unknown field: none is read as 'send to everyone'", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ reviewerIds: [] })).status).toBe(400);
    expect((await post({ reviewerIds: "r1" })).status).toBe(400);
    expect((await post({ userIds: ["r1"] })).status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitations-send:invalid-input" }));
  });

  // Nov 19, 2026: the row's Send invitation and a ticked selection send
  // through this route (after the email dialog's Preview), naming who.
  it("with reviewerIds, emails only those reviewers", async () => {
    const body = await (await post({ reviewerIds: ["r3", "r1"] })).json();
    expect(body).toMatchObject({ emailed: 2, failed: 0, remaining: 0, nextAfter: null });
    expect(sendSpy.mock.calls.map(([a]) => a.reviewer.id)).toEqual(["r1", "r3"]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.sendInvitations).toMatchObject({ emailed: 2, named: 2 });
  });

  it("a named id that is not on the event's pool is never emailed, and is logged", async () => {
    // r9 has an account but was removed from this event's reviewers.
    USERS.push({ id: "r9", email: "r9@x.com", firstName: "r9", lastName: "R", emailVerified: null, role: "REVIEWER" });
    try {
      const body = await (await post({ reviewerIds: ["r2", "r9"] })).json();
      expect(body).toMatchObject({ emailed: 1, failed: 0 });
      expect(sendSpy.mock.calls.map(([a]) => a.reviewer.id)).toEqual(["r2"]);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitations-send:named-not-on-pool", named: 2, onPool: 1 }));

      sendSpy.mockClear();
      expect(await (await post({ reviewerIds: ["r9"] })).json()).toMatchObject({ emailed: 0, failed: 0 });
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      USERS.pop();
    }
  });

  // Nov 19, 2026: the email dialog's CC, BCC and attachments.
  it("passes the organiser's CC, BCC (their own copy included) and files to every invitation of the request", async () => {
    const FILE = { name: "guide.pdf", content: "JVBERi0=", contentType: "application/pdf" };
    const REF = { storedPath: "/uploads/email-attachments/ev1/a.pdf", name: "guide.pdf", contentType: "application/pdf" };
    resolveFiles.mockResolvedValue({ ok: true, attachments: [FILE] });

    const body = await (await post({ reviewerIds: ["r1", "r2"], cc: ["Chair@x.com"], bcc: ["sec@x.com", "chair@x.com"], bccSelf: true, attachments: [REF] })).json();

    expect(body).toMatchObject({ emailed: 2 });
    expect(resolveFiles).toHaveBeenCalledWith([REF], "ev1");
    // Cleaned once, by the bulk sends' own rule: an address on CC is not also BCC'd.
    const extras = { manualCc: ["chair@x.com"], bcc: ["sec@x.com", "sarah@x.com"], attachments: [FILE] };
    expect(sendSpy.mock.calls.map(([a]) => a.extras)).toEqual([extras, extras]);
    expect(mockDb.auditLog.create.mock.calls[0][0].data.changes.sendInvitations).toMatchObject({ cc: 1, bcc: 2, attachments: 1 });
  });

  it("a file that is missing or belongs to another event refuses the send before anyone is emailed", async () => {
    resolveFiles.mockResolvedValue({ ok: false, code: "INVALID_ATTACHMENT", error: "The attachment \"x.pdf\" is not valid for this event. Please re-add it." });
    const res = await post({ attachments: [{ storedPath: "/uploads/email-attachments/other/x.pdf", name: "x.pdf", contentType: "application/pdf" }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_ATTACHMENT" });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitations-send:attachment-refused" }));
  });

  it("refuses an address that is not one, more than 10 CCs and more than 3 files", async () => {
    expect((await post({ cc: ["not-an-address"] })).status).toBe(400);
    expect((await post({ cc: Array.from({ length: 11 }, (_, i) => `c${i}@x.com`) })).status).toBe(400);
    const ref = { storedPath: "/uploads/email-attachments/ev1/a.pdf", name: "a.pdf", contentType: "application/pdf" };
    expect((await post({ attachments: [ref, ref, ref, ref] })).status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("names and the cursor work together: a long named send carries on where it stopped", async () => {
    await post({ reviewerIds: ["r1", "r2", "r3"], after: "r2" });
    expect(sendSpy.mock.calls.map(([a]) => a.reviewer.id)).toEqual(["r3"]);
  });

  it("401 signed out, 404 for an event the caller cannot reach, 429 over the limit: each logged, nothing sent", async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(401);

    mockDb.event.findFirst.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "reviewer-invitations-send:event-not-found" }));

    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 120 });
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("120");
    expect(await limited.json()).toMatchObject({ retryAfterSeconds: 120, limit: 60, windowSeconds: 3600 });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
