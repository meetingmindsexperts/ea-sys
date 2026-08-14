/**
 * Route tests for the RSVP domain.
 *
 * Carried over from the Dinner RSVP review:
 *   M2 — bulk-add `created` must come from createMany's real count, not
 *        `toCreate.length` (skipDuplicates can drop a raced row).
 *   M3 — the public submit is server-authoritative REPLACE-ALL over the
 *        open items: it clears the invite's open-item responses and
 *        re-creates only the attending ones, so a partial/crafted POST
 *        can't leave ghost attendance.
 *   M1/M6/M8/M10/L7/L15 — see the individual describes.
 *
 * New for the Aug 14, 2026 generalization (docs/CUSTOMIZABLE_RSVP_PLAN.md):
 *   - the de-dup key is the CAMPAIGN, so one person can sit on the dinner list
 *     AND the workshop list (the whole reason the campaign layer exists);
 *   - SINGLE mode is enforced server-side, not just by the radio group;
 *   - allowGuests:false IGNORES a submitted guest count rather than storing it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockRateLimit, mockSendEmail, mockGetEventTemplate, mockRenderAndWrap } = vi.hoisted(() => ({
  mockDb: {
    event: { findFirst: vi.fn(), findUnique: vi.fn() },
    rsvpCampaign: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    rsvpInvite: { findUnique: vi.fn(), findMany: vi.fn(), createMany: vi.fn(), update: vi.fn(), groupBy: vi.fn() },
    rsvpItem: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    rsvpResponse: { deleteMany: vi.fn(), createMany: vi.fn(), upsert: vi.fn() },
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
// tenantTransaction passthrough (Domain #15 sweep): the public submit runs its
// replace-all through tenantTransaction — delegate to the mock's $transaction
// so the `tx` wiring (FOR UPDATE + deleteMany/createMany/update) is unchanged.
vi.mock("@/lib/db", () => ({
  db: mockDb,
  tenantTransaction: (fn: (tx: unknown) => unknown) => mockDb.$transaction(fn),
}));
vi.mock("@/lib/security", () => ({
  getClientIp: () => "127.0.0.1",
  checkRateLimit: mockRateLimit,
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "u1", organizationId: "org1", role: "ADMIN" } }) }));
vi.mock("@/lib/auth-guards", () => ({ denyReviewer: () => null }));
vi.mock("@/lib/event-access", () => ({ buildEventAccessWhere: () => ({ id: "ev1", organizationId: "org1" }) }));
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
  POST as invitesPost,
  GET as rosterGet,
} from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/route";
import { POST as publicSubmit } from "@/app/api/public/events/[slug]/rsvp/[token]/route";
import { POST as itemsPost } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/items/route";
import { POST as sendPost } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/send/route";

const FUTURE = new Date(Date.now() + 7 * 24 * 3600_000);
const PAST = new Date(Date.now() - 24 * 3600_000);

const CAMPAIGN = {
  id: "c1",
  eventId: "ev1",
  organizationId: "org1",
  name: "Gala Dinner",
  description: null,
  selectionMode: "MULTI" as "SINGLE" | "MULTI",
  allowGuests: true,
  collectDietary: true,
  isActive: true,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const campaignParams = Promise.resolve({ eventId: "ev1", campaignId: "c1" });

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
  mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
  mockDb.rsvpCampaign.findFirst.mockResolvedValue(CAMPAIGN);
  mockDb.rsvpInvite.groupBy.mockResolvedValue([]);
});

describe("GET roster — must return every item field the console edits (B2)", () => {
  it("selects location / description / rsvpDeadline, not just { id, name, startsAt }", async () => {
    mockDb.rsvpItem.findMany.mockResolvedValue([]);
    mockDb.rsvpInvite.findMany.mockResolvedValue([]);

    await rosterGet({ url: "http://x/api/events/ev1/rsvp-campaigns/c1/invites" } as unknown as Request, {
      params: campaignParams,
    });

    const select = mockDb.rsvpItem.findMany.mock.calls[0][0].select;

    // This route is the ONLY source of items for the console. When these
    // fields weren't selected they arrived as `undefined`, the edit dialog
    // showed them blank, and Save wrote them back as ""/null — which the PUT
    // reads as an explicit CLEAR. Editing an item's NAME wiped its venue,
    // its description and its RSVP DEADLINE (so RSVP never closed again).
    expect(select.location).toBe(true);
    expect(select.description).toBe(true);
    expect(select.rsvpDeadline).toBe(true);
  });
});

// ── M2 ──────────────────────────────────────────────────────────────
describe("POST invites — created count is the DB's real insert count (M2)", () => {
  it("reports createMany.count, not toCreate.length, when skipDuplicates drops a row", async () => {
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

    const res = await invitesPost(req, { params: campaignParams });
    const body = await res.json();
    expect(body.created).toBe(1); // NOT 2
    expect(body.skipped).toBe(1); // 2 deduped - 1 created
  });
});

// ── THE point of the campaign layer ─────────────────────────────────
describe("invite de-dup is scoped to the CAMPAIGN, not the event", () => {
  it("checks existing invitees by campaignId — the same person can join a second RSVP", async () => {
    // Mutation guard: point this where at { eventId } instead and the
    // assertion fails. That is exactly the pre-Aug-2026 behavior, where adding
    // someone to the workshop list collided with their dinner invite.
    mockDb.rsvpInvite.findMany.mockResolvedValue([]);
    mockDb.rsvpInvite.createMany.mockResolvedValue({ count: 1 });

    const req = {
      headers: new Headers(),
      json: async () => ({ invitees: [{ name: "Prof X", email: "x@uni.edu" }] }),
    } as unknown as Request;
    await invitesPost(req, { params: campaignParams });

    const where = mockDb.rsvpInvite.findMany.mock.calls[0][0].where;
    expect(where.campaignId).toBe("c1");
    expect(where.eventId).toBeUndefined();
  });

  it("someone already on ANOTHER campaign is still created here", async () => {
    // The existing-lookup is campaign-scoped, so a person invited to the
    // dinner returns nothing for the workshop campaign → they are created.
    mockDb.rsvpInvite.findMany.mockResolvedValue([]);
    mockDb.rsvpInvite.createMany.mockResolvedValue({ count: 1 });

    const req = {
      headers: new Headers(),
      json: async () => ({ invitees: [{ name: "Prof X", email: "x@uni.edu" }] }),
    } as unknown as Request;
    const res = await invitesPost(req, { params: campaignParams });

    expect((await res.json()).created).toBe(1);
    expect(mockDb.rsvpInvite.createMany.mock.calls[0][0].data[0]).toMatchObject({
      campaignId: "c1",
      eventId: "ev1",
      inviteeEmail: "x@uni.edu",
    });
  });

  it("a campaign from another event 404s before any invite is written", async () => {
    mockDb.rsvpCampaign.findFirst.mockResolvedValue(null);
    const req = {
      headers: new Headers(),
      json: async () => ({ invitees: [{ name: "A", email: "a@x.com" }] }),
    } as unknown as Request;
    const res = await invitesPost(req, { params: campaignParams });
    expect(res.status).toBe(404);
    expect(mockDb.rsvpInvite.createMany).not.toHaveBeenCalled();
  });
});

// ── M3 ──────────────────────────────────────────────────────────────
describe("POST public rsvp — server-authoritative replace-all over open items (M3)", () => {
  function wireInvite(campaign: Partial<typeof CAMPAIGN> = {}) {
    // resolveEventOrg (Domain #15) resolves the tenant org from the Event by
    // host+slug BEFORE the swept token lookup — give it an org.
    mockDb.event.findFirst.mockResolvedValue({ id: "ev1", organizationId: "org1" });
    mockDb.rsvpInvite.findUnique.mockResolvedValue({
      id: "inv1",
      eventId: "ev1",
      campaignId: "c1",
      inviteeName: "Jane",
      inviteeEmail: "jane@x.com",
      dietary: null,
      status: "RESPONDED",
      campaign: { ...CAMPAIGN, ...campaign },
      event: { slug: "gala", name: "Gala", bannerImage: null, bannerImageMobile: null, startDate: new Date(), endDate: new Date() },
      responses: [{ itemId: "A", attending: true, guestCount: 1 }],
    });
    // Items A and B both open (no deadline, start in the future — since
    // R2 M1 a deadline-less item closes when it starts).
    mockDb.rsvpItem.findMany.mockResolvedValue([
      { id: "A", rsvpDeadline: null, startsAt: FUTURE },
      { id: "B", rsvpDeadline: null, startsAt: FUTURE },
    ]);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "inv1" }]), // FOR UPDATE row lock
      rsvpResponse: { deleteMany: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
      rsvpInvite: { update: vi.fn().mockResolvedValue({}) },
    };
    mockDb.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<void>) => fn(tx));
    return tx;
  }
  const submit = (body: Record<string, unknown>) =>
    publicSubmit({ headers: new Headers(), json: async () => body } as unknown as Request, {
      params: Promise.resolve({ slug: "gala", token: "tok" }),
    });

  it("clears all open-item responses, then recreates only the attending ones", async () => {
    const tx = wireInvite();
    // Submit: attending B only; A omitted-as-not-attending. Previously A was attending.
    const res = await submit({
      dietary: "veg",
      items: [
        { itemId: "A", attending: false, guestCount: 0 },
        { itemId: "B", attending: true, guestCount: 3 },
      ],
    });
    expect((await res.json()).ok).toBe(true);

    // Serializes concurrent submits via a FOR UPDATE row lock on the invite.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);

    // Deletes responses for ALL open items (A + B) — clears the stale A.
    expect(tx.rsvpResponse.deleteMany).toHaveBeenCalledTimes(1);
    const delArg = tx.rsvpResponse.deleteMany.mock.calls[0][0];
    expect(delArg.where.inviteId).toBe("inv1");
    expect(delArg.where.itemId.in.sort()).toEqual(["A", "B"]);

    // Recreates ONLY the attending item (B), not the declined A.
    expect(tx.rsvpResponse.createMany).toHaveBeenCalledTimes(1);
    expect(tx.rsvpResponse.createMany.mock.calls[0][0].data).toEqual([
      { inviteId: "inv1", itemId: "B", organizationId: "org1", attending: true, guestCount: 3 },
    ]);
    expect(tx.rsvpInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RESPONDED", dietary: "veg" }) }),
    );
  });

  it("declining every item clears responses and creates none", async () => {
    const tx = wireInvite();
    const res = await submit({
      items: [
        { itemId: "A", attending: false, guestCount: 0 },
        { itemId: "B", attending: false, guestCount: 0 },
      ],
    });
    expect((await res.json()).ok).toBe(true);
    expect(tx.rsvpResponse.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.rsvpResponse.createMany).not.toHaveBeenCalled(); // nothing attending
    expect(tx.rsvpInvite.update).toHaveBeenCalled();
  });

  // ── R2 M1 — a deadline-less item closes when it starts ──────────────
  it("an item with no deadline whose start has passed is CLOSED — its answer is ignored and reported", async () => {
    const tx = wireInvite();
    // A already happened (no deadline); B still open.
    mockDb.rsvpItem.findMany.mockResolvedValue([
      { id: "A", rsvpDeadline: null, startsAt: PAST },
      { id: "B", rsvpDeadline: null, startsAt: FUTURE },
    ]);
    const res = await submit({
      items: [
        { itemId: "A", attending: true, guestCount: 2 }, // closed — must be ignored
        { itemId: "B", attending: true, guestCount: 1 },
      ],
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    // R2 M2: the dropped answer is REPORTED, not silently swallowed.
    expect(body.ignoredItemIds).toEqual(["A"]);
    // The replace-all only touches the open item.
    expect(tx.rsvpResponse.deleteMany.mock.calls[0][0].where.itemId.in).toEqual(["B"]);
    expect(tx.rsvpResponse.createMany.mock.calls[0][0].data).toEqual([
      { inviteId: "inv1", itemId: "B", organizationId: "org1", attending: true, guestCount: 1 },
    ]);
  });

  // ── R2 M3 — a stale form addressing ZERO open items is rejected ─────
  it("409 STALE_FORM when the payload addresses no open item (open items exist) — no destructive replace", async () => {
    const tx = wireInvite();
    // The form was loaded before B existed; A has since closed.
    mockDb.rsvpItem.findMany.mockResolvedValue([
      { id: "A", rsvpDeadline: PAST, startsAt: FUTURE },
      { id: "B", rsvpDeadline: null, startsAt: FUTURE },
    ]);
    const res = await submit({ items: [{ itemId: "A", attending: true, guestCount: 0 }] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STALE_FORM");
    // The concurrent tab's answers on B are untouched; the invite is not
    // stamped RESPONDED.
    expect(tx.rsvpResponse.deleteMany).not.toHaveBeenCalled();
    expect(tx.rsvpInvite.update).not.toHaveBeenCalled();
  });

  it("400 all-closed when every item is closed", async () => {
    wireInvite();
    mockDb.rsvpItem.findMany.mockResolvedValue([{ id: "A", rsvpDeadline: null, startsAt: PAST }]);
    const res = await submit({ items: [{ itemId: "A", attending: true, guestCount: 0 }] });
    expect(res.status).toBe(400);
  });

  it("only ever offers the invite's OWN campaign's items", async () => {
    // A token belongs to one campaign; surfacing another audience's items on
    // this link is precisely what the campaign layer prevents.
    wireInvite();
    await submit({ items: [{ itemId: "B", attending: true, guestCount: 0 }] });
    expect(mockDb.rsvpItem.findMany.mock.calls[0][0].where).toEqual({
      campaignId: "c1",
      isActive: true,
    });
  });

  // ── SINGLE mode ────────────────────────────────────────────────────
  describe("SINGLE selection mode is enforced server-side", () => {
    it("400s a crafted POST that picks two items — never a silent first-wins", async () => {
      const tx = wireInvite({ selectionMode: "SINGLE" });
      const res = await submit({
        items: [
          { itemId: "A", attending: true, guestCount: 0 },
          { itemId: "B", attending: true, guestCount: 0 },
        ],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("SINGLE_SELECTION_ONLY");
      // Nothing written — the previous answer survives a rejected submit.
      expect(tx.rsvpResponse.deleteMany).not.toHaveBeenCalled();
      expect(tx.rsvpInvite.update).not.toHaveBeenCalled();
    });

    it("accepts exactly one", async () => {
      const tx = wireInvite({ selectionMode: "SINGLE" });
      const res = await submit({
        items: [
          { itemId: "A", attending: false, guestCount: 0 },
          { itemId: "B", attending: true, guestCount: 0 },
        ],
      });
      expect((await res.json()).ok).toBe(true);
      expect(tx.rsvpResponse.createMany.mock.calls[0][0].data).toHaveLength(1);
    });

    it("accepts declining everything (zero picked)", async () => {
      // "I'm not coming to any of them" must stay expressible in SINGLE mode,
      // or people are forced to pick a workshop they aren't attending.
      const tx = wireInvite({ selectionMode: "SINGLE" });
      const res = await submit({
        items: [
          { itemId: "A", attending: false, guestCount: 0 },
          { itemId: "B", attending: false, guestCount: 0 },
        ],
      });
      expect((await res.json()).ok).toBe(true);
      expect(tx.rsvpResponse.createMany).not.toHaveBeenCalled();
      expect(tx.rsvpInvite.update).toHaveBeenCalled();
    });

    it("MULTI still accepts several", async () => {
      const tx = wireInvite({ selectionMode: "MULTI" });
      const res = await submit({
        items: [
          { itemId: "A", attending: true, guestCount: 0 },
          { itemId: "B", attending: true, guestCount: 0 },
        ],
      });
      expect((await res.json()).ok).toBe(true);
      expect(tx.rsvpResponse.createMany.mock.calls[0][0].data).toHaveLength(2);
    });
  });

  // ── per-campaign guests / dietary switches ──────────────────────────
  describe("allowGuests / collectDietary are per-campaign switches", () => {
    it("allowGuests:false IGNORES a submitted guest count (stores 0), never persists it", async () => {
      // A crafted POST must not inflate a catering headcount for an RSVP that
      // never asked about guests.
      const tx = wireInvite({ allowGuests: false });
      const res = await submit({ items: [{ itemId: "B", attending: true, guestCount: 9 }] });
      expect((await res.json()).ok).toBe(true);
      expect(tx.rsvpResponse.createMany.mock.calls[0][0].data[0].guestCount).toBe(0);
    });

    it("allowGuests:true stores the submitted count", async () => {
      const tx = wireInvite({ allowGuests: true });
      await submit({ items: [{ itemId: "B", attending: true, guestCount: 4 }] });
      expect(tx.rsvpResponse.createMany.mock.calls[0][0].data[0].guestCount).toBe(4);
    });

    it("collectDietary:false does not touch the dietary field", async () => {
      const tx = wireInvite({ collectDietary: false });
      await submit({ dietary: "smuggled", items: [{ itemId: "B", attending: true, guestCount: 0 }] });
      const data = tx.rsvpInvite.update.mock.calls[0][0].data;
      expect(data.status).toBe("RESPONDED");
      expect("dietary" in data).toBe(false);
    });
  });

  // ── R2 M10 — the public submit leaves an audit trail ────────────────
  it("writes a fire-and-forget AuditLog row with before→after + IP", async () => {
    wireInvite();
    const res = await submit({ items: [{ itemId: "B", attending: true, guestCount: 2 }] });
    expect((await res.json()).ok).toBe(true);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = mockDb.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("RESPOND");
    expect(audit.entityType).toBe("RSVP_INVITE");
    expect(audit.userId).toBeNull();
    expect(audit.ipAddress).toBe("127.0.0.1");
    expect(audit.changes.campaignId).toBe("c1");
    expect(audit.changes.before).toEqual([{ itemId: "A", attending: true, guestCount: 1 }]);
    expect(audit.changes.after).toEqual([{ itemId: "B", attending: true, guestCount: 2 }]);
  });
});

// ── R2 L7 — RSVP deadline cannot be after the item itself ────────────
describe("POST items — cross-field deadline validation (R2 L7)", () => {
  it("400 DEADLINE_AFTER_ITEM when rsvpDeadline > startsAt", async () => {
    const req = {
      headers: new Headers(),
      json: async () => ({
        name: "Gala",
        startsAt: FUTURE.toISOString(),
        rsvpDeadline: new Date(FUTURE.getTime() + 3600_000).toISOString(),
      }),
    } as unknown as Request;
    const res = await itemsPost(req, { params: campaignParams });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("DEADLINE_AFTER_ITEM");
  });

  it("derives the item's eventId from the CAMPAIGN, never from input", async () => {
    // The denormalized eventId must not be able to drift from its campaign.
    mockDb.rsvpItem.create.mockResolvedValue({ id: "i1", name: "Gala", startsAt: FUTURE });
    const req = {
      headers: new Headers(),
      json: async () => ({ name: "Gala", startsAt: FUTURE.toISOString() }),
    } as unknown as Request;
    await itemsPost(req, { params: campaignParams });
    expect(mockDb.rsvpItem.create.mock.calls[0][0].data).toMatchObject({
      campaignId: "c1",
      eventId: "ev1",
    });
  });
});

// ── R2 M6/M8/L15 — the send route's retry-safety + message tokens ─────
describe("POST invites/send — batch retry-safety + message tokens (R2 M6/M8/L15)", () => {
  function wireSend() {
    mockDb.event.findUnique.mockResolvedValue({
      id: "ev1",
      organizationId: "org1",
      name: "Gala",
      slug: "gala",
      organization: { name: "MMG" },
    });
    mockDb.rsvpInvite.findMany.mockResolvedValue([
      { id: "i1", inviteeName: "Alice A", inviteeEmail: "a@x.com", token: "tokA" },
      { id: "i2", inviteeName: "Bob B", inviteeEmail: "b@x.com", token: "tokB" },
    ]);
    mockDb.user.findUnique.mockResolvedValue({ firstName: "Org", lastName: "Anizer", emailSignature: null });
    mockDb.rsvpItem.count.mockResolvedValue(2);
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

  it("400 NO_ITEMS when the campaign has no active item (L15)", async () => {
    wireSend();
    mockDb.rsvpItem.count.mockResolvedValue(0);
    const res = await sendPost(sendReq({ target: "all" }), { params: campaignParams });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("NO_ITEMS");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("a batch retry skips invitees already emailed in the last 10 minutes (M6)", async () => {
    wireSend();
    // i1 was mailed successfully moments ago (a crashed/retried batch).
    mockDb.emailLog.findMany.mockResolvedValue([{ entityId: "i1" }]);
    const res = await sendPost(sendReq({ target: "all" }), { params: campaignParams });
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
    const res = await sendPost(sendReq({ inviteId: "i1" }), { params: campaignParams });
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.skippedRecentlyInvited).toBe(0);
    // The recently-sent lookup is batch-only.
    expect(mockDb.emailLog.findMany).not.toHaveBeenCalled();
  });

  it("tokens typed into the message resolve per recipient (M8) — {{firstName}} becomes the invitee's name", async () => {
    wireSend();
    await sendPost(sendReq({ target: "all", message: "Hi {{firstName}}, dress code is black tie" }), {
      params: campaignParams,
    });
    // renderAndWrap received the PRE-RENDERED personalMessage (real
    // renderMessageValue ran) — per recipient.
    const varsA = mockRenderAndWrap.mock.calls[0][1] as Record<string, string>;
    const varsB = mockRenderAndWrap.mock.calls[1][1] as Record<string, string>;
    expect(varsA.personalMessage).toBe("Hi Alice, dress code is black tie");
    expect(varsB.personalMessage).toBe("Hi Bob, dress code is black tie");
  });

  it("keeps the dinner-rsvp-invitation template slug — it is a KEY, not a label", async () => {
    // 17 events already hold a materialised EmailTemplate row on this slug.
    // Renaming it orphans every one of them, silently.
    wireSend();
    await sendPost(sendReq({ target: "all" }), { params: campaignParams });
    expect(mockGetEventTemplate).toHaveBeenCalledWith("ev1", "dinner-rsvp-invitation");
  });

  it("sends only to the CAMPAIGN's invitees", async () => {
    wireSend();
    await sendPost(sendReq({ target: "all" }), { params: campaignParams });
    const where = mockDb.rsvpInvite.findMany.mock.calls[0][0].where;
    expect(where.campaignId).toBe("c1");
    expect(where.eventId).toBeUndefined();
  });
});
