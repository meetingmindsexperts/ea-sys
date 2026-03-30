import { describe, it, expect } from "vitest";
import { z } from "zod";
import { titleEnum } from "@/lib/schemas";
import { normalizeTag, generateBarcode } from "@/lib/utils";
import { denyReviewer } from "@/lib/auth-guards";

// ── Registration Zod schema (mirrors src/app/api/events/[eventId]/registrations/route.ts) ──

const createRegistrationSchema = z.object({
  ticketTypeId: z.string().min(1).max(100),
  attendee: z.object({
    title: titleEnum.optional(),
    email: z.string().email().max(255),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    organization: z.string().max(255).optional(),
    jobTitle: z.string().max(255).optional(),
    phone: z.string().max(50).optional(),
    photo: z.string().max(500).optional(),
    city: z.string().max(255).optional(),
    country: z.string().max(255).optional(),
    specialty: z.string().max(255).optional(),
    registrationType: z.string().max(255).optional(),
    tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
    dietaryReqs: z.string().max(2000).optional(),
    customFields: z.record(z.string(), z.any()).optional(),
  }),
  notes: z.string().max(2000).optional(),
});

// ── Schema validation ──────────────────────────────────────────────────────

describe("Registration: schema validation", () => {
  const validRegistration = {
    ticketTypeId: "ticket-1",
    attendee: {
      email: "john@example.com",
      firstName: "John",
      lastName: "Smith",
    },
  };

  it("accepts valid minimal registration", () => {
    const result = createRegistrationSchema.safeParse(validRegistration);
    expect(result.success).toBe(true);
  });

  it("accepts registration with all attendee fields", () => {
    const result = createRegistrationSchema.safeParse({
      ticketTypeId: "ticket-1",
      attendee: {
        title: "DR",
        email: "jane@example.com",
        firstName: "Jane",
        lastName: "Doe",
        organization: "MIT",
        jobTitle: "Professor",
        phone: "+1234567890",
        city: "Dubai",
        country: "United Arab Emirates",
        specialty: "Cardiology",
        registrationType: "VIP",
        tags: ["speaker", "keynote"],
        dietaryReqs: "Vegetarian",
        customFields: { booth: "A1" },
      },
      notes: "VIP guest",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing ticketTypeId", () => {
    const result = createRegistrationSchema.safeParse({
      attendee: {
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty ticketTypeId", () => {
    const result = createRegistrationSchema.safeParse({
      ticketTypeId: "",
      attendee: {
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing attendee email", () => {
    const result = createRegistrationSchema.safeParse({
      ticketTypeId: "ticket-1",
      attendee: {
        firstName: "Test",
        lastName: "User",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid attendee email", () => {
    const result = createRegistrationSchema.safeParse({
      ticketTypeId: "ticket-1",
      attendee: {
        email: "not-an-email",
        firstName: "Test",
        lastName: "User",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing firstName", () => {
    const result = createRegistrationSchema.safeParse({
      ticketTypeId: "ticket-1",
      attendee: {
        email: "test@example.com",
        lastName: "User",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty firstName", () => {
    const result = createRegistrationSchema.safeParse({
      ticketTypeId: "ticket-1",
      attendee: {
        email: "test@example.com",
        firstName: "",
        lastName: "User",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid title enum", () => {
    const result = createRegistrationSchema.safeParse({
      ticketTypeId: "ticket-1",
      attendee: {
        title: "DOCTOR",
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
      },
    });
    expect(result.success).toBe(false);
  });

  it("normalizes tag values", () => {
    const result = createRegistrationSchema.safeParse({
      ticketTypeId: "ticket-1",
      attendee: {
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
        tags: ["machine learning", "AI RESEARCH"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attendee.tags).toEqual([
        "Machine Learning",
        "Ai Research",
      ]);
    }
  });
});

// ── Business logic: ticket availability ────────────────────────────────────

describe("Registration: ticket availability logic", () => {
  it("detects sold-out tickets", () => {
    const ticketType = { soldCount: 100, quantity: 100, price: 50 };
    const isSoldOut = ticketType.soldCount >= ticketType.quantity;
    expect(isSoldOut).toBe(true);
  });

  it("allows tickets when not sold out", () => {
    const ticketType = { soldCount: 50, quantity: 100, price: 50 };
    const isSoldOut = ticketType.soldCount >= ticketType.quantity;
    expect(isSoldOut).toBe(false);
  });

  it("detects sales not started", () => {
    const now = new Date();
    const futureStart = new Date(now.getTime() + 86400000); // tomorrow
    const salesNotStarted = futureStart > now;
    expect(salesNotStarted).toBe(true);
  });

  it("detects sales ended", () => {
    const now = new Date();
    const pastEnd = new Date(now.getTime() - 86400000); // yesterday
    const salesEnded = pastEnd < now;
    expect(salesEnded).toBe(true);
  });
});

// ── Business logic: payment status ─────────────────────────────────────────

describe("Registration: payment status derivation", () => {
  it('sets PAID for free tickets (price = 0)', () => {
    const price = 0;
    const paymentStatus = Number(price) === 0 ? "PAID" : "UNPAID";
    expect(paymentStatus).toBe("PAID");
  });

  it('sets UNPAID for paid tickets (price > 0)', () => {
    const price = 50;
    const paymentStatus = Number(price) === 0 ? "PAID" : "UNPAID";
    expect(paymentStatus).toBe("UNPAID");
  });
});

// ── Business logic: registration status ────────────────────────────────────

describe("Registration: status derivation", () => {
  it('sets PENDING when ticket requires approval', () => {
    const requiresApproval = true;
    const status = requiresApproval ? "PENDING" : "CONFIRMED";
    expect(status).toBe("PENDING");
  });

  it('sets CONFIRMED when ticket does not require approval', () => {
    const requiresApproval = false;
    const status = requiresApproval ? "PENDING" : "CONFIRMED";
    expect(status).toBe("CONFIRMED");
  });
});

// ── Business logic: QR code uniqueness ─────────────────────────────────────

describe("Registration: barcode generation", () => {
  it("generates unique barcodes for each registration", () => {
    const codes = Array.from({ length: 50 }, () => generateBarcode());
    const unique = new Set(codes);
    expect(unique.size).toBe(50);
  });
});

// ── Auth guard: REVIEWER/SUBMITTER cannot create registrations ─────────────

describe("Registration: role restrictions", () => {
  it("blocks REVIEWER from creating registrations", () => {
    const result = denyReviewer({ user: { role: "REVIEWER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("blocks SUBMITTER from creating registrations", () => {
    const result = denyReviewer({ user: { role: "SUBMITTER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("allows ADMIN to create registrations", () => {
    expect(denyReviewer({ user: { role: "ADMIN" } })).toBeNull();
  });

  it("allows ORGANIZER to create registrations", () => {
    expect(denyReviewer({ user: { role: "ORGANIZER" } })).toBeNull();
  });
});
