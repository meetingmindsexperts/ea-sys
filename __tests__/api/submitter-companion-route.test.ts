/**
 * Fix: the public submitter self-registration route created a Speaker with a
 * raw `tx.speaker.create` and never minted the companion registration, so
 * self-registered faculty had no badge / entry barcode / check-in / survey /
 * certificate. This pins that the route now calls ensureSpeakerCompanionRegistration
 * (failure-isolated — a companion hiccup must NOT fail the account create).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, ensureCompanionSpy } = vi.hoisted(() => {
  const tx = {
    user: { create: vi.fn().mockResolvedValue({ id: "u1" }), update: vi.fn().mockResolvedValue({ id: "u1" }) },
    speaker: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "sp1" }),
      update: vi.fn().mockResolvedValue({ id: "sp1" }),
    },
  };
  return {
    mockDb: {
      event: { findFirst: vi.fn() },
      user: { findUnique: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
      speaker: { findUnique: vi.fn().mockResolvedValue({ id: "sp1", sourceRegistrationId: null }) },
      // No presenter rates on this event -> the D4 comp path, which is what
      // every assertion in this file is about. The route asks BEFORE creating
      // the account (Sep 21, 2026), so the mock has to answer.
      ticketType: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      _tx: tx,
    },
    ensureCompanionSpy: vi.fn().mockResolvedValue({ status: "created", registrationId: "reg1" }),
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/db", () => ({
  db: mockDb,
  // Speaker sweep: upsertEventSpeaker now runs through tenantTransaction (was
  // db.$transaction); delegate to the SAME passthrough so existing assertions hold.
  tenantTransaction: (cb: (tx: unknown) => unknown, opts?: unknown) =>
    (mockDb.$transaction as (c: unknown, o?: unknown) => unknown)(cb, opts),
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/security", () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("hashed") } }));
vi.mock("@/lib/contact-sync", () => ({ syncToContact: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  loadActiveEventTemplateRow: vi.fn(),
  getEventTemplate: vi.fn().mockResolvedValue(null),
  getDefaultTemplate: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  renderAndWrap: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  brandingFrom: vi.fn().mockReturnValue({ email: "f@x.com" }),
  brandingCc: vi.fn().mockReturnValue([]),
}));
// Keep the real module (so the shared `upsertEventSpeaker` runs against the tx
// mock) and override only the companion function with a spy.
vi.mock("@/lib/speaker-companion", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/speaker-companion")>()),
  ensureSpeakerCompanionRegistration: ensureCompanionSpy,
}));

import { POST } from "@/app/api/public/events/[slug]/submitter/route";

function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/public/events/ev-slug/submitter", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
const params = Promise.resolve({ slug: "ev-slug" });
const validBody = {
  title: "DR", role: "ACADEMIA", firstName: "Jane", lastName: "Doe",
  email: "Jane@Example.com", password: "secret123",
  organization: "Acme", jobTitle: "Prof", phone: "+97150", city: "Dubai",
  country: "AE", specialty: "Cardiology",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({
    id: "ev1", name: "Ev", slug: "ev-slug",
    settings: { allowAbstractSubmissions: true }, organizationId: "org1",
  });
  mockDb.user.findFirst.mockResolvedValue(null);
  mockDb.speaker.findUnique.mockResolvedValue({ id: "sp1", sourceRegistrationId: null });
  mockDb._tx.speaker.findUnique.mockResolvedValue(null);
  mockDb._tx.speaker.create.mockResolvedValue({ id: "sp1" });
  // Re-assert the DEFAULT (no presenter rates) every test. `clearAllMocks`
  // clears calls but KEEPS implementations, so a case that gives the event a
  // presenter rate would otherwise leak into every test after it — which is
  // exactly what happened the first time these were added.
  mockDb.ticketType.findMany.mockResolvedValue([]);
});

/**
 * THE BYPASS (Sep 21, 2026 security review, finding #1).
 *
 * `ticketTypeId` is optional in the schema, and when it was absent
 * `resolvePresenterRate` returned null — the SAME null it returns for "this
 * event has no presenter rates". Both fell through to the D4 comp branch, so
 * omitting one field from an unauthenticated POST bought a free COMPLIMENTARY
 * Faculty registration on an event charging presenters USD 100-125.
 *
 * The rule lived only in the browser. The client comment even asserted it was
 * "Enforced again server-side, since a form can be bypassed" — it was not.
 *
 * These cases pin the refusal at the DOOR, before any account exists, because
 * that is the only place it can be a 400: `ensureSubmitterRegistration` runs
 * post-commit and is failure-isolated by contract.
 */
describe("submitter route — presenter rate is required when the event charges", () => {
  /** The event now offers one open presenter rate. */
  function withPresenterRate() {
    mockDb.ticketType.findMany.mockResolvedValue([
      {
        id: "tt-phys",
        name: "Physician",
        isActive: true,
        pricingTiers: [
          { id: "tier-p", name: "Presenter", price: 125, currency: "USD", sortOrder: 3,
            quantity: 999999, soldCount: 0, salesStart: null, salesEnd: null },
        ],
      },
    ]);
  }

  it("400s an abstract signup that omits the rate — and creates NO account", async () => {
    withPresenterRate();
    const res = await POST(makeReq(validBody), { params });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("REGISTRATION_TYPE_REQUIRED");
    // The whole point of checking before the transaction.
    expect(mockDb._tx.user.create).not.toHaveBeenCalled();
    expect(mockDb._tx.speaker.create).not.toHaveBeenCalled();
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  it("400s a rate that is not on offer, rather than silently comping", async () => {
    withPresenterRate();
    const res = await POST(makeReq({ ...validBody, ticketTypeId: "tt-not-real" }), { params });

    expect(res.status).toBe(400);
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  it("lets a valid rate through", async () => {
    withPresenterRate();
    const res = await POST(makeReq({ ...validBody, ticketTypeId: "tt-phys" }), { params });

    expect(res.status).toBeLessThan(400);
  });

  it("does NOT ask a proposal signup for a rate — proposals create nothing", async () => {
    withPresenterRate();
    const res = await POST(makeReq({ ...validBody, source: "proposal" }), { params });

    expect(res.status).toBeLessThan(400);
  });

  it("leaves an event with no presenter rates completely alone (D4)", async () => {
    // The regression that would matter most: every live event is in this
    // state, so a wrong guard here breaks abstract signup everywhere.
    const res = await POST(makeReq(validBody), { params });

    expect(res.status).toBeLessThan(400);
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
  });
});

describe("submitter route — companion registration", () => {
  it("mints a companion registration for the new submitter-speaker", async () => {
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBeLessThan(400);
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
    expect(ensureCompanionSpy.mock.calls[0][0]).toMatchObject({
      id: "sp1",
      eventId: "ev1",
      email: "jane@example.com", // normalized lowercase
      firstName: "Jane",
      lastName: "Doe",
    });
  });

  it("does not fail the registration if the companion ensure throws (failure-isolated)", async () => {
    ensureCompanionSpy.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBeLessThan(400); // account still created
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
  });

  it("ABSTRACT signups still auto-mint (linkOnly false)", async () => {
    await POST(makeReq(validBody), { params });
    // Asserted as the DECISION, not the option object: linkOnly absent and
    // linkOnly:false mean the same thing to the helper, and the door now
    // routes through ensureSubmitterRegistration which omits it.
    expect(ensureCompanionSpy.mock.calls[0][1]?.linkOnly).not.toBe(true);
    expect(ensureCompanionSpy.mock.calls[0][1]?.expectedLink).toBeNull();
  });

  it("PROPOSAL signups are linkOnly — NO auto comp registration (owner decision Aug 5, 2026)", async () => {
    await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    expect(ensureCompanionSpy.mock.calls[0][1]?.linkOnly).toBe(true);
    expect(ensureCompanionSpy.mock.calls[0][1]?.expectedLink).toBeNull();
  });

  it("a CANCELLED linked registration counts as NO link — the door re-links a LIVE one (LOW fix Aug 5, 2026)", async () => {
    mockDb.speaker.findUnique.mockResolvedValue({
      id: "sp1",
      sourceRegistrationId: "reg-dead",
      sourceRegistration: { status: "CANCELLED" },
    });
    await POST(makeReq(validBody), { params });
    const [input, opts] = ensureCompanionSpy.mock.calls[0];
    // Effective pointer nulled so the helper links a live same-email row…
    expect(input.sourceRegistrationId).toBeNull();
    // …while the RAW pointer rides as expectedLink for the conditional claim.
    expect(opts?.linkOnly).not.toBe(true);
    expect(opts?.expectedLink).toBe("reg-dead");
  });
});

describe("submitter route — speaker status default (owner decision Aug 5, 2026)", () => {
  it("a fresh PROPOSER is created INVITED — the team confirms after reviewing the proposal", async () => {
    await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    expect(mockDb._tx.speaker.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "INVITED" }) }),
    );
  });

  it("a fresh ABSTRACT signup is ALSO created INVITED (owner follow-up, same day)", async () => {
    await POST(makeReq(validBody), { params });
    expect(mockDb._tx.speaker.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "INVITED" }) }),
    );
  });

  it("an EXISTING speaker's status is NEVER touched (invited/confirmed speakers inherit)", async () => {
    mockDb._tx.speaker.findUnique.mockResolvedValue({ id: "sp1", submitterSource: null });
    await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    const updateData = mockDb._tx.speaker.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("status");
  });

  it("an EXISTING speaker's NAME is never rewritten by the door (Aug 5 name lock); a blank name is filled", async () => {
    mockDb._tx.speaker.findUnique.mockResolvedValue({
      id: "sp1", submitterSource: null, firstName: "Farid", lastName: "InvitedFaculty",
    });
    await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    const updateData = mockDb._tx.speaker.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("firstName");
    expect(updateData).not.toHaveProperty("lastName");
    // Non-name profile fields still refresh from the signup form.
    expect(updateData).toHaveProperty("organization");

    // A blank name on file may still be filled once.
    mockDb._tx.speaker.update.mockClear();
    mockDb._tx.speaker.findUnique.mockResolvedValue({
      id: "sp1", submitterSource: null, firstName: "", lastName: "InvitedFaculty",
    });
    await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    const second = mockDb._tx.speaker.update.mock.calls[0][0].data;
    expect(second).toHaveProperty("firstName");
    expect(second).not.toHaveProperty("lastName");
  });
});

describe("submitter route — submitterSource stamping (a door WIDENS, never narrows — Aug 4 2026)", () => {
  it("stamps the source on speaker CREATE", async () => {
    await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    expect(mockDb._tx.speaker.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ submitterSource: "proposal" }) }),
    );
  });

  it("defaults an abstract signup to source 'abstract'", async () => {
    await POST(makeReq(validBody), { params });
    expect(mockDb._tx.speaker.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ submitterSource: "abstract" }) }),
    );
  });

  it("stamps an EXISTING speaker whose source is null", async () => {
    mockDb._tx.speaker.findUnique.mockResolvedValue({ id: "sp1", submitterSource: null });
    await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    expect(mockDb._tx.speaker.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ submitterSource: "proposal" }) }),
    );
  });

  it("using the OTHER door widens to 'both' (surfaces are independent — MEHF2026 abstract-link bounce)", async () => {
    // A proposal person using /abstract/register gains the Abstracts surface
    // AND keeps Session Proposals — the registers are two separate flows.
    mockDb._tx.speaker.findUnique.mockResolvedValue({ id: "sp1", submitterSource: "proposal" });
    await POST(makeReq({ ...validBody, source: "abstract" }), { params });
    expect(mockDb._tx.speaker.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ submitterSource: "both" }) }),
    );
  });

  it("re-using the SAME door keeps the source unchanged (no spurious widen)", async () => {
    mockDb._tx.speaker.findUnique.mockResolvedValue({ id: "sp1", submitterSource: "proposal" });
    await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    expect(mockDb._tx.speaker.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ submitterSource: "proposal" }) }),
    );
  });

  it("'both' stays 'both' whichever door is used next", async () => {
    mockDb._tx.speaker.findUnique.mockResolvedValue({ id: "sp1", submitterSource: "both" });
    await POST(makeReq({ ...validBody, source: "abstract" }), { params });
    expect(mockDb._tx.speaker.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ submitterSource: "both" }) }),
    );
  });
});

describe("submitter route — abstract gate vs proposal source (July 30, 2026)", () => {
  it("403s an ABSTRACT signup when abstract submissions are closed", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1", name: "Ev", slug: "ev-slug",
      settings: { allowAbstractSubmissions: false }, organizationId: "org1",
    });
    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(403);
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
  });

  it("lets a PROPOSAL signup through when abstract submissions are closed (source: proposal skips the abstract gate)", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1", name: "Ev", slug: "ev-slug",
      settings: { allowAbstractSubmissions: false }, organizationId: "org1",
    });
    const res = await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    expect(res.status).toBeLessThan(400);
    // Auto-comp applies to proposers exactly like abstract submitters.
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
  });

  it("403s a PROPOSAL signup past the session-proposal deadline (auto-end, Aug 6 2026)", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1", name: "Ev", slug: "ev-slug",
      settings: { allowAbstractSubmissions: true, sessionProposalDeadline: "2020-01-01T00:00:00.000Z" },
      organizationId: "org1",
    });
    const res = await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    expect(res.status).toBe(403);
    expect(ensureCompanionSpy).not.toHaveBeenCalled();

    // The proposal deadline never blocks an ABSTRACT signup (separate windows).
    const abstractRes = await POST(makeReq(validBody), { params });
    expect(abstractRes.status).toBeLessThan(400);
  });

  it("403s an ABSTRACT signup past the deadline, but not a PROPOSAL signup", async () => {
    mockDb.event.findFirst.mockResolvedValue({
      id: "ev1", name: "Ev", slug: "ev-slug",
      settings: { allowAbstractSubmissions: true, abstractDeadline: "2000-01-01T00:00:00Z" },
      organizationId: "org1",
    });
    const abstractRes = await POST(makeReq(validBody), { params });
    expect(abstractRes.status).toBe(403);
    const proposalRes = await POST(makeReq({ ...validBody, source: "proposal" }), { params });
    expect(proposalRes.status).toBeLessThan(400);
  });
});
