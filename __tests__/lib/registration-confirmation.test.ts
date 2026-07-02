/**
 * `buildEventConfirmationFields` — the shared event/org block of a registration
 * confirmation email's params, extracted from four byte-identical inline copies
 * (public register, complete-registration, registration-service, registrant
 * resend). These pin the exact transforms the callers relied on + the two
 * deliberate exclusions (eventSlug, price/billing) so the dedup can't drift.
 */
import { describe, it, expect } from "vitest";
import { buildEventConfirmationFields } from "@/lib/registration-confirmation";
import type { Prisma } from "@prisma/client";

// Prisma Decimal stand-in: a truthy object whose Number() coerces to `n`. Pins
// the important edge — a 0% tax rate is a Decimal(0), which is TRUTHY, so it
// maps to 0 (not null). A raw JS `0` would be falsy; event.taxRate is never that.
const decimal = (n: number) => ({ valueOf: () => n, toString: () => String(n) }) as unknown as Prisma.Decimal;

const org = {
  name: "Meeting Minds",
  companyName: "MM FZ LLC",
  companyAddress: "Level 5",
  companyCity: "Dubai",
  companyState: "Dubai",
  companyZipCode: "00000",
  companyCountry: "AE",
  taxId: "TRN123",
  logo: "/uploads/logo.png",
};

const event = {
  name: "IOHNC 2026",
  startDate: new Date("2026-11-01T09:00:00Z"),
  venue: "Madinat Jumeirah",
  city: "Dubai",
  id: "ev1",
  organizationId: "org1",
  taxRate: decimal(5),
  taxLabel: "VAT",
  bankDetails: "IBAN ...",
  supportEmail: "help@x.com",
  organization: org,
};

describe("buildEventConfirmationFields", () => {
  it("maps every shared field with the exact caller transforms", () => {
    expect(buildEventConfirmationFields(event)).toEqual({
      eventName: "IOHNC 2026",
      eventDate: event.startDate,
      eventVenue: "Madinat Jumeirah",
      eventCity: "Dubai",
      eventId: "ev1",
      organizationId: "org1",
      taxRate: 5,
      taxLabel: "VAT",
      bankDetails: "IBAN ...",
      supportEmail: "help@x.com",
      organizationName: "Meeting Minds",
      companyName: "MM FZ LLC",
      companyAddress: "Level 5",
      companyCity: "Dubai",
      companyState: "Dubai",
      companyZipCode: "00000",
      companyCountry: "AE",
      taxId: "TRN123",
      logoPath: "/uploads/logo.png", // logo → logoPath rename preserved
    });
  });

  it("venue/city null → empty string (matches `venue || \"\"`)", () => {
    const r = buildEventConfirmationFields({ ...event, venue: null, city: null });
    expect(r.eventVenue).toBe("");
    expect(r.eventCity).toBe("");
  });

  it("taxRate null → null; a Decimal(0) → 0 (truthy Decimal, not null)", () => {
    expect(buildEventConfirmationFields({ ...event, taxRate: null }).taxRate).toBeNull();
    expect(buildEventConfirmationFields({ ...event, taxRate: decimal(0) }).taxRate).toBe(0);
  });

  it("does NOT include eventSlug (each caller keeps its own — register uses the route param)", () => {
    expect("eventSlug" in buildEventConfirmationFields(event)).toBe(false);
  });

  it("does NOT include price/discount/billing fields (callers pass those explicitly)", () => {
    const r = buildEventConfirmationFields(event) as Record<string, unknown>;
    for (const k of ["ticketPrice", "discountAmount", "promoCode", "billingCity", "qrCode", "registrationId"]) {
      expect(k in r).toBe(false);
    }
  });
});
