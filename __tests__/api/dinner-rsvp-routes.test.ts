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

const { mockDb, mockRateLimit } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn() },
    rsvpInvite: { findUnique: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
    rsvpDinner: { findMany: vi.fn() },
    rsvpDinnerResponse: { deleteMany: vi.fn(), createMany: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  },
  mockRateLimit: vi.fn(() => ({ allowed: true, retryAfterSeconds: 0 })),
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
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "u1", organizationId: "org1" } }) }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));

import { POST as sendlessInvitesPost } from "@/app/api/events/[eventId]/rsvp-invites/route";
import { POST as publicSubmit } from "@/app/api/public/events/[slug]/rsvp/[token]/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
});

// ── M2 ──────────────────────────────────────────────────────────────
describe("POST /rsvp-invites — created count is the DB's real insert count (M2)", () => {
  it("reports createMany.count, not toCreate.length, when skipDuplicates drops a row", async () => {
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1" });
    mockDb.rsvpInvite.findMany.mockResolvedValue([]); // none already invited
    // Two new invitees pass the pre-check but the DB only inserts one (a raced dup).
    mockDb.rsvpInvite.createMany.mockResolvedValue({ count: 1 });

    const req = {
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
    // Dinners A and B both open (no deadline).
    mockDb.rsvpDinner.findMany.mockResolvedValue([
      { id: "A", rsvpDeadline: null },
      { id: "B", rsvpDeadline: null },
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
});
