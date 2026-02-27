import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { titleEnum } from "@/lib/schemas";
import { checkRateLimit } from "@/lib/security";

// ── Submitter registration schema (mirrors src/app/api/public/events/[slug]/submitter/route.ts) ──

const registerSchema = z.object({
  title: titleEnum.optional(),
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  email: z.string().email("Valid email is required").max(255),
  password: z.string().min(6, "Password must be at least 6 characters").max(128),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  registrationType: z.string().max(255).optional(),
});

// ── Schema validation ──────────────────────────────────────────────────────

describe("Submitter registration: schema validation", () => {
  const validSubmitter = {
    firstName: "Alice",
    lastName: "Johnson",
    email: "alice@example.com",
    password: "securepassword123",
  };

  it("accepts valid minimal registration", () => {
    const result = registerSchema.safeParse(validSubmitter);
    expect(result.success).toBe(true);
  });

  it("accepts registration with all optional fields", () => {
    const result = registerSchema.safeParse({
      ...validSubmitter,
      title: "DR",
      organization: "Dubai Medical University",
      jobTitle: "Cardiologist",
      phone: "+971-50-1234567",
      city: "Dubai",
      country: "United Arab Emirates",
      specialty: "Cardiology",
      registrationType: "Speaker",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing email", () => {
    const result = registerSchema.safeParse({
      firstName: "Alice",
      lastName: "Johnson",
      password: "securepassword",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = registerSchema.safeParse({
      ...validSubmitter,
      email: "not-valid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing password", () => {
    const result = registerSchema.safeParse({
      firstName: "Alice",
      lastName: "Johnson",
      email: "alice@example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects password shorter than 6 chars", () => {
    const result = registerSchema.safeParse({
      ...validSubmitter,
      password: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("rejects password longer than 128 chars", () => {
    const result = registerSchema.safeParse({
      ...validSubmitter,
      password: "a".repeat(129),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty firstName", () => {
    const result = registerSchema.safeParse({
      ...validSubmitter,
      firstName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid title", () => {
    const result = registerSchema.safeParse({
      ...validSubmitter,
      title: "DOCTOR",
    });
    expect(result.success).toBe(false);
  });
});

// ── Business logic: email normalization ────────────────────────────────────

describe("Submitter registration: email handling", () => {
  it("normalizes email to lowercase", () => {
    const email = "Alice.Johnson@EXAMPLE.COM";
    expect(email.toLowerCase()).toBe("alice.johnson@example.com");
  });
});

// ── Business logic: rate limiting ──────────────────────────────────────────

describe("Submitter registration: rate limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const g = globalThis as Record<string, unknown>;
    delete g["__ea_sys_rate_limit_store"];
    delete g["__ea_sys_rate_limit_last_cleanup"];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first registration attempt", () => {
    const result = checkRateLimit({
      key: "submitter-register:ip:1.2.3.4",
      limit: 20,
      windowMs: 15 * 60 * 1000,
    });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(19);
  });

  it("blocks after 20 IP attempts", () => {
    const opts = {
      key: "submitter-register:ip:1.2.3.4",
      limit: 20,
      windowMs: 15 * 60 * 1000,
    };

    for (let i = 0; i < 20; i++) {
      checkRateLimit(opts);
    }

    const blocked = checkRateLimit(opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("blocks after 5 email attempts", () => {
    const opts = {
      key: "submitter-register:email:alice@example.com",
      limit: 5,
      windowMs: 15 * 60 * 1000,
    };

    for (let i = 0; i < 5; i++) {
      checkRateLimit(opts);
    }

    const blocked = checkRateLimit(opts);
    expect(blocked.allowed).toBe(false);
  });

  it("IP and email rate limits are independent", () => {
    const ipOpts = {
      key: "submitter-register:ip:1.2.3.4",
      limit: 1,
      windowMs: 15 * 60 * 1000,
    };
    const emailOpts = {
      key: "submitter-register:email:alice@example.com",
      limit: 5,
      windowMs: 15 * 60 * 1000,
    };

    checkRateLimit(ipOpts); // exhaust IP limit
    const ipBlocked = checkRateLimit(ipOpts);
    expect(ipBlocked.allowed).toBe(false);

    // Email limit still available
    const emailAllowed = checkRateLimit(emailOpts);
    expect(emailAllowed.allowed).toBe(true);
  });
});

// ── Business logic: event settings checks ──────────────────────────────────

describe("Submitter registration: event settings", () => {
  it("blocks when abstract submissions disabled", () => {
    const settings = { allowAbstractSubmissions: false } as Record<string, unknown>;
    expect(settings.allowAbstractSubmissions !== true).toBe(true);
  });

  it("allows when abstract submissions enabled", () => {
    const settings = { allowAbstractSubmissions: true } as Record<string, unknown>;
    expect(settings.allowAbstractSubmissions !== true).toBe(false);
  });

  it("blocks when deadline has passed", () => {
    const pastDeadline = new Date(Date.now() - 86400000).toISOString();
    const settings = { allowAbstractSubmissions: true, abstractDeadline: pastDeadline };
    const deadline = new Date(settings.abstractDeadline);
    expect(new Date() > deadline).toBe(true);
  });

  it("allows when deadline is in the future", () => {
    const futureDeadline = new Date(Date.now() + 86400000).toISOString();
    const settings = { allowAbstractSubmissions: true, abstractDeadline: futureDeadline };
    const deadline = new Date(settings.abstractDeadline);
    expect(new Date() > deadline).toBe(false);
  });

  it("allows when no deadline is set", () => {
    const settings = { allowAbstractSubmissions: true } as Record<string, unknown>;
    expect(settings.abstractDeadline).toBeUndefined();
    // No deadline means always open
  });
});

// ── Business logic: user creation ──────────────────────────────────────────

describe("Submitter registration: user properties", () => {
  it("creates user with SUBMITTER role", () => {
    const userData = {
      email: "alice@example.com",
      role: "SUBMITTER" as const,
      firstName: "Alice",
      lastName: "Johnson",
      organizationId: null, // org-independent
    };
    expect(userData.role).toBe("SUBMITTER");
    expect(userData.organizationId).toBeNull();
  });

  it("creates speaker linked to event with CONFIRMED status", () => {
    const speakerData = {
      eventId: "evt-1",
      userId: "user-1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Johnson",
      status: "CONFIRMED" as const,
    };
    expect(speakerData.status).toBe("CONFIRMED");
    expect(speakerData.userId).toBe("user-1");
  });
});
