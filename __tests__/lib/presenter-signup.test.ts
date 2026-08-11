/**
 * What an abstract signup does about the submitter's registration
 * (Aug 11, 2026). See docs/PRESENTER_REGISTRATION_PLAN.md.
 *
 * The branch that matters most is D4: an event with NO presenter rates keeps
 * today's complimentary Faculty companion. Every existing event is in that
 * state, so if this branch were wrong the change would alter behaviour on
 * every live event the moment it deployed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/** Typed so `mock.calls[n][m]` is not `never` when asserting on arguments. */
type CompanionOpts = { linkOnly?: boolean; expectedLink?: string | null };
type PayableInput = {
  ticketTypeId: string;
  pricingTierId: string | null;
  overrideSalesWindow?: boolean;
  suppressPayNow?: boolean;
  createdSource?: string;
};

const { ensureCompanionSpy, createAndLinkSpy, findManySpy, findUniqueSpy, quotePdfSpy } = vi.hoisted(() => ({
  findUniqueSpy: vi.fn(),
  quotePdfSpy: vi.fn(),
  ensureCompanionSpy:
    vi.fn<(speaker: unknown, opts?: CompanionOpts) => Promise<Record<string, unknown>>>(),
  createAndLinkSpy:
    vi.fn<(input: PayableInput) => Promise<Record<string, unknown>>>(),
  findManySpy: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/quote-pdf", () => ({ buildQuotePDFFromRegistration: quotePdfSpy }));
vi.mock("@/lib/db", () => ({
  db: {
    ticketType: { findMany: findManySpy },
    registration: { findUnique: findUniqueSpy },
  },
  dbOperator: {},
  tenantTransaction: vi.fn(),
}));
vi.mock("@/lib/speaker-companion", () => ({
  ensureSpeakerCompanionRegistration: ensureCompanionSpy,
}));
vi.mock("@/lib/presenter-registration", () => ({
  createAndLinkPayableRegistration: createAndLinkSpy,
}));

import {
  ensureSubmitterRegistration,
  resolvePresenterRate,
  buildPresenterFeeEmailExtras,
} from "@/lib/presenter-signup";

const SPEAKER = {
  id: "spk1",
  eventId: "ev1",
  email: "jane@hospital.org",
  firstName: "Jane",
  lastName: "Doe",
  title: "DR" as const,
  role: "PHYSICIAN" as const,
  additionalEmail: null,
  organization: "Hosp",
  jobTitle: "Consultant",
  phone: "+971500000000",
  city: "Dubai",
  state: null,
  zipCode: null,
  country: "United Arab Emirates",
  specialty: "Cardiology",
  registrationType: null,
  sourceRegistrationId: null,
};

/** One registration type carrying an open presenter tier. */
function typeWithPresenterRate() {
  return [
    {
      id: "tt-phys",
      name: "Physician",
      isActive: true,
      pricingTiers: [
        {
          id: "tier-peb",
          name: "Presenter Early Bird",
          price: 400,
          currency: "USD",
          sortOrder: 3,
          quantity: 999999,
          soldCount: 0,
          salesStart: null,
          salesEnd: null,
        },
      ],
    },
  ];
}

const BASE = {
  speaker: SPEAKER,
  organizationId: "org1",
  eventSettings: {},
  source: "abstract",
  expectedLink: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  findManySpy.mockResolvedValue(typeWithPresenterRate());
  ensureCompanionSpy.mockResolvedValue({ status: "created", registrationId: "r1" });
  createAndLinkSpy.mockResolvedValue({
    status: "created",
    registrationId: "r-paid",
    registrationStatus: "CONFIRMED",
    paymentStatus: "UNASSIGNED",
  });
});

describe("D4: an event with no presenter rates keeps today's behaviour", () => {
  it("mints the complimentary companion when no type was chosen", async () => {
    await ensureSubmitterRegistration({ ...BASE, ticketTypeId: null });
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
    expect(createAndLinkSpy).not.toHaveBeenCalled();
    // Not linkOnly: it must actually create, exactly as before.
    expect(ensureCompanionSpy.mock.calls[0][1]?.linkOnly).not.toBe(true);
  });

  it("does not even query ticket types when no type was chosen", async () => {
    await ensureSubmitterRegistration({ ...BASE, ticketTypeId: null });
    expect(findManySpy).not.toHaveBeenCalled();
  });

  it("falls back when the chosen type has no presenter tier", async () => {
    findManySpy.mockResolvedValue([
      { id: "tt-phys", name: "Physician", isActive: true, pricingTiers: [
        { id: "t1", name: "Early Bird", price: 400, currency: "USD", sortOrder: 0,
          quantity: 999999, soldCount: 0, salesStart: null, salesEnd: null },
      ] },
    ]);
    await ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" });
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
    expect(createAndLinkSpy).not.toHaveBeenCalled();
  });

  /** A stale form must not be able to buy a rate that closed since page load. */
  it("falls back when the presenter tier sold out or closed since page load", async () => {
    const closed = typeWithPresenterRate();
    closed[0].pricingTiers[0].salesEnd = new Date(Date.now() - 86_400_000) as unknown as null;
    findManySpy.mockResolvedValue(closed);
    await ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" });
    expect(createAndLinkSpy).not.toHaveBeenCalled();
    expect(ensureCompanionSpy).toHaveBeenCalledTimes(1);
  });
});

describe("with presenter rates configured", () => {
  it("creates a real payable registration on the resolved tier", async () => {
    await ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" });
    expect(ensureCompanionSpy).not.toHaveBeenCalled();
    expect(createAndLinkSpy).toHaveBeenCalledTimes(1);
    const arg = createAndLinkSpy.mock.calls[0][0];
    expect(arg.ticketTypeId).toBe("tt-phys");
    expect(arg.pricingTierId).toBe("tier-peb");
  });

  /**
   * A public door, so the type's sales window applies. Only an ORGANIZER grant
   * overrides it (the Aug 5 M5 decision), and confusing the two would let a
   * submitter buy a closed rate.
   */
  it("does NOT override the sales window", async () => {
    await ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" });
    expect(createAndLinkSpy.mock.calls[0][0].overrideSalesWindow).toBe(false);
  });

  /**
   * REGRESSION (found by running the flow locally, Aug 11). The row was landing
   * as ADMIN_DASHBOARD, because the service derives that from `source: "api"`.
   *
   * It reads cosmetic and is not: `seatCounter()` routes a tier-priced row to
   * the TIER's counter only for TIER_CONSUMING_SOURCES. Mis-stamped, the
   * presenter tier's soldCount stayed 0 and its seat limit could never fill,
   * silently exempting presenters from the Aug 6 rule that a tier-priced public
   * registration burns that tier's inventory.
   */
  it("stamps PUBLIC_SUBMITTER so the presenter TIER's seat is the one burned", async () => {
    await ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" });
    expect(createAndLinkSpy.mock.calls[0][0].createdSource).toBe("PUBLIC_SUBMITTER");
  });

  it("suppresses Pay Now by default (D3)", async () => {
    await ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" });
    expect(createAndLinkSpy.mock.calls[0][0].suppressPayNow).toBe(true);
  });

  it("shows Pay Now when the organizer turned it on", async () => {
    await ensureSubmitterRegistration({
      ...BASE,
      eventSettings: { presenterRegistration: { payNowEnabled: true } },
      ticketTypeId: "tt-phys",
    });
    expect(createAndLinkSpy.mock.calls[0][0].suppressPayNow).toBe(false);
  });
});

describe("session proposals are untouched", () => {
  it("links only, and never creates, even when rates exist", async () => {
    await ensureSubmitterRegistration({
      ...BASE,
      source: "proposal",
      ticketTypeId: "tt-phys",
    });
    expect(createAndLinkSpy).not.toHaveBeenCalled();
    expect(ensureCompanionSpy.mock.calls[0][1]?.linkOnly).toBe(true);
  });
});

describe("failure isolation", () => {
  /**
   * The account and the speaker row are already committed when this runs. A
   * throw here would leave someone unable to sign in with no way to retry, so
   * every failure is swallowed and the organizer fixes it with Grant.
   */
  it("never throws when the registration create blows up", async () => {
    createAndLinkSpy.mockRejectedValueOnce(new Error("boom"));
    await expect(
      ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" }),
    ).resolves.toBeNull();
  });

  it("never throws when the tier lookup blows up", async () => {
    findManySpy.mockRejectedValueOnce(new Error("db down"));
    await expect(
      ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" }),
    ).resolves.toBeNull();
  });

  it("does not throw when the service refuses (sold out, faculty type, ...)", async () => {
    createAndLinkSpy.mockResolvedValueOnce({
      status: "rejected",
      code: "SOLD_OUT",
      message: "Sold out",
    });
    await expect(
      ensureSubmitterRegistration({ ...BASE, ticketTypeId: "tt-phys" }),
    ).resolves.toBeNull();
  });
});

describe("resolvePresenterRate", () => {
  it("returns null for an unknown type rather than guessing another", async () => {
    expect(await resolvePresenterRate("ev1", "tt-nope")).toBeNull();
  });

  it("returns null when nothing was chosen", async () => {
    expect(await resolvePresenterRate("ev1", null)).toBeNull();
  });
});


/**
 * The fee block is the ONLY thing that tells an abstract submitter what they
 * owe, now that the delegate confirmation is suppressed on that door. Its
 * closing sentence and its button are decided from ONE flag, because
 * "payment is not required" printed above a Pay Now button is the kind of
 * contradiction nobody reads twice.
 */
describe("presenter fee block copy follows the Pay Now toggle", () => {
  beforeEach(() => {
    findUniqueSpy.mockResolvedValue({
      id: "reg-1",
      originalPrice: 450,
      attendee: { firstName: "Hana" },
      ticketType: { name: "Physician", price: 100, currency: "USD" },
      pricingTier: { name: "Presenter Early Bird", price: 450, currency: "USD" },
      event: { slug: "MEHF2027", name: "MEHF", organization: {} },
    });
    quotePdfSpy.mockResolvedValue({ buffer: Buffer.from("pdf"), filename: "quote-1.pdf" });
  });

  it("says payment is NOT required, and shows no button, when Pay Now is off", async () => {
    const r = await buildPresenterFeeEmailExtras("reg-1", { payNowEnabled: false });
    expect(r?.text).toContain("Payment is not required");
    expect(r?.html).not.toContain(">Pay Now<");
  });

  it("offers to pay, with a button, when the organizer turned Pay Now on", async () => {
    const r = await buildPresenterFeeEmailExtras("reg-1", { payNowEnabled: true });
    expect(r?.text).toContain("You can pay online now");
    expect(r?.text).not.toContain("Payment is not required");
    expect(r?.html).toContain(">Pay Now<");
  });

  it("attaches the quote", async () => {
    const r = await buildPresenterFeeEmailExtras("reg-1", { payNowEnabled: false });
    expect(r?.attachment?.name).toBe("quote-1.pdf");
  });

  /** A broken PDF must not cost someone the fee message, or their account. */
  it("still returns the fee block when the quote PDF blows up", async () => {
    quotePdfSpy.mockRejectedValueOnce(new Error("pdfkit exploded"));
    const r = await buildPresenterFeeEmailExtras("reg-1", { payNowEnabled: false });
    expect(r?.attachment).toBeNull();
    expect(r?.text).toContain("USD 450.00");
  });
});
