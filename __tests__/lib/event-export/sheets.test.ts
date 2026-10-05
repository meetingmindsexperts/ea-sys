/**
 * The sheets written for the bundle: money columns follow the same predicates
 * as the screens, and every cell goes through the CSV escaper.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = vi.hoisted(() => ({
  speaker: { findMany: vi.fn() },
  ticketType: { findMany: vi.fn() },
  promoCode: { findMany: vi.fn() },
  accommodation: { findMany: vi.fn() },
  hotel: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { accommodationSheets, promoCodesSheet, registrationTypesSheet, speakersSheet } from "@/lib/event-export/sheets";
import { principalFromUser } from "@/lib/permissions/can";

const dec = (v: string) => ({ toString: () => v });

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.speaker.findMany.mockResolvedValue([
    {
      id: "s1", title: "DR", firstName: "Amal", lastName: "Haddad", email: "a@x.com", additionalEmail: null, phone: null,
      organization: "=HYPERLINK(\"evil\")", jobTitle: null, city: null, state: null, country: "UAE", specialty: "Cardiology",
      customSpecialty: null, registrationType: null, status: "CONFIRMED", tags: ["committee"], website: null, bio: null,
      agreementAcceptedAt: null, presenterAgreementAcceptedAt: null, honorariumAmount: dec("1500.00"), honorariumCurrency: "USD",
      sourceRegistrationId: "r1", createdAt: new Date("2026-09-01T00:00:00Z"), sessions: [{ role: "SPEAKER", session: { name: "Opening" } }],
    },
  ]);
  mockDb.ticketType.findMany.mockResolvedValue([
    {
      id: "t1", name: "Physician", category: "Delegate", isActive: true, isFaculty: false, price: dec("950.00"), virtualPrice: null,
      currency: "AED", quantity: 100, soldCount: 3, salesStart: null, salesEnd: null, requiresApproval: false, requiresDocument: false,
      pricingTiers: [{ id: "p1", name: "Early bird", price: dec("750.00"), currency: "AED", quantity: 50, soldCount: 2, salesStart: null, salesEnd: null, isActive: true }],
    },
  ]);
  mockDb.promoCode.findMany.mockResolvedValue([
    {
      id: "pc1", code: "PFIZER", description: null, discountType: "PERCENTAGE", discountValue: dec("100"), currency: null, maxUses: null,
      maxUsesPerEmail: null, usedCount: 4, validFrom: null, validUntil: null, isActive: true, sponsorCoversFee: true,
      sponsor: { name: "Pfizer" }, ticketTypes: [{ ticketType: { name: "Physician" } }],
    },
  ]);
  mockDb.accommodation.findMany.mockResolvedValue([
    {
      id: "b1", checkIn: new Date("2026-10-01T00:00:00Z"), checkOut: new Date("2026-10-03T00:00:00Z"), guestCount: 1, status: "CONFIRMED",
      confirmationNo: "X1", specialRequests: null, totalPrice: dec("800.00"), currency: "AED", createdAt: new Date("2026-09-01T00:00:00Z"),
      roomType: { name: "King", hotel: { name: "Hilton" } }, registration: null, speaker: { title: null, firstName: "Omar", lastName: "Ali", email: "o@x.com" },
    },
  ]);
  mockDb.hotel.findMany.mockResolvedValue([]);
});

const as = (role: string) => principalFromUser({ id: "u1", role, organizationId: "org1" });

describe("money columns follow the screen predicates", () => {
  it("the honorarium shows for admins and organisers, not for a desk role", async () => {
    expect((await speakersSheet("ev1", as("ADMIN"))).csv).toContain("1500.00");
    const desk = await speakersSheet("ev1", as("MEMBER"));
    expect(desk.csv).not.toContain("Honorarium");
    expect(desk.csv).not.toContain("1500.00");
  });

  it("prices show for finance roles only", async () => {
    expect((await registrationTypesSheet("ev1", as("ORGANIZER"))).csv).toContain("950.00");
    const nonFinance = await registrationTypesSheet("ev1", as("CRM_USER"));
    expect(nonFinance.csv).not.toContain("950.00");
    expect(nonFinance.csv).not.toContain("Price");
    expect((await promoCodesSheet("ev1", as("CRM_USER"))).csv).not.toContain("Discount Value");
    const [bookings] = await accommodationSheets("ev1", as("CRM_USER"));
    expect(bookings.csv).not.toContain("800.00");
  });
});

describe("shape", () => {
  it("a type row is followed by its pricing tiers", async () => {
    const t = await registrationTypesSheet("ev1", as("ADMIN"));
    expect(t.rows).toBe(2);
    expect(t.csv.split("\n")[2]).toContain("Pricing tier");
  });

  it("formula-shaped cells are neutralised by the shared escaper", async () => {
    const csv = (await speakersSheet("ev1", as("ADMIN"))).csv;
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it("a speaker's sessions and companion registration are listed", async () => {
    const csv = (await speakersSheet("ev1", as("ADMIN"))).csv;
    expect(csv).toContain("Opening (SPEAKER)");
    expect(csv).toContain(",Yes,");
  });
});
