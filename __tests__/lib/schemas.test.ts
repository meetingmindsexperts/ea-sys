import { describe, it, expect } from "vitest";
import { z } from "zod";
import { titleEnum } from "@/lib/schemas";

// ── titleEnum ──────────────────────────────────────────────────────────────

describe("titleEnum", () => {
  const validTitles = ["MR", "MS", "MRS", "DR", "PROF"];

  it.each(validTitles)("accepts valid title: %s", (title) => {
    const result = titleEnum.safeParse(title);
    expect(result.success).toBe(true);
  });

  it("rejects invalid title", () => {
    const result = titleEnum.safeParse("DOCTOR");
    expect(result.success).toBe(false);
  });

  it("accepts empty string and transforms it to undefined (for clearing)", () => {
    const result = titleEnum.safeParse("");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeUndefined();
    }
  });

  it("rejects number", () => {
    const result = titleEnum.safeParse(123);
    expect(result.success).toBe(false);
  });

  it("rejects lowercase", () => {
    const result = titleEnum.safeParse("mr");
    expect(result.success).toBe(false);
  });
});

// ── Event creation schema (mirroring API route validation) ─────────────────

describe("event creation schema", () => {
  // Mirrors the schema from src/app/api/events/route.ts
  const eventSchema = z.object({
    name: z.string().min(2).max(200),
    description: z.string().optional(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    venue: z.string().optional(),
    eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]).optional(),
    tag: z.string().optional(),
    specialty: z.string().optional(),
  });

  it("accepts valid minimal event", () => {
    const result = eventSchema.safeParse({
      name: "Test Event",
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-02T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid event with all fields", () => {
    const result = eventSchema.safeParse({
      name: "Full Event",
      description: "A conference about AI",
      startDate: "2026-06-15T09:00:00Z",
      endDate: "2026-06-17T18:00:00Z",
      venue: "Dubai Convention Center",
      eventType: "CONFERENCE",
      tag: "technology",
      specialty: "AI/ML",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing name", () => {
    const result = eventSchema.safeParse({
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-02T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects name too short", () => {
    const result = eventSchema.safeParse({
      name: "A",
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-02T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid datetime string", () => {
    const result = eventSchema.safeParse({
      name: "Test Event",
      startDate: "not-a-date",
      endDate: "2026-01-02T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid eventType", () => {
    const result = eventSchema.safeParse({
      name: "Test Event",
      startDate: "2026-01-01T00:00:00Z",
      endDate: "2026-01-02T00:00:00Z",
      eventType: "MEETUP",
    });
    expect(result.success).toBe(false);
  });
});
