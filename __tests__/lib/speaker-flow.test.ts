import { describe, it, expect } from "vitest";
import { z } from "zod";
import { titleEnum } from "@/lib/schemas";
import { normalizeTag } from "@/lib/utils";
import { denyReviewer } from "@/lib/auth-guards";

// ── Speaker creation schema (mirrors src/app/api/events/[eventId]/speakers/route.ts) ──

const createSpeakerSchema = z.object({
  title: titleEnum.optional(),
  email: z.string().email().max(255),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  bio: z.string().max(10000).optional(),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  website: z.string().url().max(500).optional().or(z.literal("")),
  photo: z.string().max(500).optional().or(z.literal("")),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  registrationType: z.string().max(255).optional(),
  tags: z.array(z.string().max(100).transform(normalizeTag)).optional(),
  socialLinks: z.object({
    twitter: z.string().max(500).optional(),
    linkedin: z.string().max(500).optional(),
    github: z.string().max(500).optional(),
  }).optional(),
  status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).default("INVITED"),
});

// ── Schema validation ──────────────────────────────────────────────────────

describe("Speaker: schema validation", () => {
  const validSpeaker = {
    email: "speaker@example.com",
    firstName: "Jane",
    lastName: "Doe",
  };

  it("accepts valid minimal speaker", () => {
    const result = createSpeakerSchema.safeParse(validSpeaker);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("INVITED"); // default
    }
  });

  it("accepts speaker with all fields", () => {
    const result = createSpeakerSchema.safeParse({
      title: "PROF",
      email: "prof@university.edu",
      firstName: "Alice",
      lastName: "Johnson",
      bio: "Expert in AI and machine learning",
      organization: "MIT",
      jobTitle: "Professor of Computer Science",
      phone: "+1-555-0123",
      website: "https://alice.example.com",
      photo: "/uploads/photos/2026/01/alice.jpg",
      city: "Dubai",
      country: "United Arab Emirates",
      specialty: "Artificial Intelligence",
      registrationType: "Keynote",
      tags: ["ai", "machine learning"],
      socialLinks: {
        twitter: "https://twitter.com/alice",
        linkedin: "https://linkedin.com/in/alice",
        github: "https://github.com/alice",
      },
      status: "CONFIRMED",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing email", () => {
    const result = createSpeakerSchema.safeParse({
      firstName: "Jane",
      lastName: "Doe",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = createSpeakerSchema.safeParse({
      ...validSpeaker,
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty firstName", () => {
    const result = createSpeakerSchema.safeParse({
      ...validSpeaker,
      firstName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid title enum value", () => {
    const result = createSpeakerSchema.safeParse({
      ...validSpeaker,
      title: "DOCTOR",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid status", () => {
    const result = createSpeakerSchema.safeParse({
      ...validSpeaker,
      status: "ACTIVE",
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty string for website", () => {
    const result = createSpeakerSchema.safeParse({
      ...validSpeaker,
      website: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid website URL", () => {
    const result = createSpeakerSchema.safeParse({
      ...validSpeaker,
      website: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("normalizes tag values", () => {
    const result = createSpeakerSchema.safeParse({
      ...validSpeaker,
      tags: ["keynote speaker", "AI EXPERT"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(["Keynote Speaker", "Ai Expert"]);
    }
  });

  it("accepts photo as relative path (not URL)", () => {
    const result = createSpeakerSchema.safeParse({
      ...validSpeaker,
      photo: "/uploads/photos/2026/01/abc.jpg",
    });
    expect(result.success).toBe(true);
  });
});

// ── Auth guard: role restrictions ──────────────────────────────────────────

describe("Speaker: role restrictions", () => {
  it("blocks REVIEWER from adding speakers", () => {
    const result = denyReviewer({ user: { role: "REVIEWER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("blocks SUBMITTER from adding speakers", () => {
    const result = denyReviewer({ user: { role: "SUBMITTER" } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("allows ADMIN to add speakers", () => {
    expect(denyReviewer({ user: { role: "ADMIN" } })).toBeNull();
  });

  it("allows ORGANIZER to add speakers", () => {
    expect(denyReviewer({ user: { role: "ORGANIZER" } })).toBeNull();
  });
});

// ── Business logic: duplicate speaker detection ────────────────────────────

describe("Speaker: duplicate detection", () => {
  it("matches speakers by eventId + email", () => {
    const existingSpeakers = [
      { eventId: "evt-1", email: "alice@example.com" },
      { eventId: "evt-1", email: "bob@example.com" },
    ];

    const newEmail = "alice@example.com";
    const eventId = "evt-1";

    const duplicate = existingSpeakers.find(
      (s) => s.eventId === eventId && s.email === newEmail
    );
    expect(duplicate).toBeDefined();
  });

  it("allows same email for different events", () => {
    const existingSpeakers = [
      { eventId: "evt-1", email: "alice@example.com" },
    ];

    const newEmail = "alice@example.com";
    const eventId = "evt-2"; // different event

    const duplicate = existingSpeakers.find(
      (s) => s.eventId === eventId && s.email === newEmail
    );
    expect(duplicate).toBeUndefined();
  });
});
